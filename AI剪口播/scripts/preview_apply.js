'use strict';

// Acceptance is a recorded user action, not a synonym for worker completion.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { markerFingerprint } = require('./codex_callback');
const STATE = 'preview_apply_state.json';
const INDEX = 'preview_apply_specs.json';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const hash = value => sha(JSON.stringify(value));
const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
const atomic = (file, data) => { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(data, null, 2)); fs.renameSync(temp, file); };
const fingerprint = marker => markerFingerprint({ ...marker, resolved: false });
const fileIdentity = file => { const s = fs.statSync(file); return { path: fs.realpathSync(file), size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }; };
const digestCache = new Map();
function fileDigest(file) {
  const stat = fs.statSync(file), key = JSON.stringify([fs.realpathSync(file), stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]);
  if (!digestCache.has(key)) { if (digestCache.size > 32) digestCache.clear(); digestCache.set(key, sha(fs.readFileSync(file))); }
  return digestCache.get(key);
}
function inside(root, file) {
  const real = fs.realpathSync(path.resolve(root, file));
  const relative = path.relative(fs.realpathSync(root), real);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('合入文件必须位于当前项目审核目录');
  return real;
}
function urlOf(root, file) { return '/' + path.relative(fs.realpathSync(root), file).split(path.sep).map(encodeURIComponent).join('/'); }
function semanticTimeline(value) { return hash({ sourceDuration: value?.sourceDuration, clips: value?.clips || [] }); }

function catalogue(root, baseVideo) {
  const active = read(path.join(root, 'preview_comments.json'), { markers: [] }).markers;
  const current = new Map(active.map(marker => [marker.id, marker]));
  const specs = read(path.join(root, INDEX), { items: [] }).items;
  const runs = path.join(root, 'codex_runs');
  const candidates = new Map();
  const base = fileIdentity(baseVideo);
  const timeline = semanticTimeline(read(path.join(root, 'preview_timeline.json'), {}));
  for (const name of (fs.existsSync(runs) ? fs.readdirSync(runs).sort() : [])) {
    const runDir = path.join(runs, name);
    const resultFile = path.join(runDir, 'result.json');
    if (!fs.existsSync(resultFile)) continue;
    let status, result, snapshot, oldTimeline;
    try { status = read(path.join(runDir, 'status.json'), {}); } catch (_) { continue; }
    if (status.state !== 'completed') continue;
    try {
      result = read(resultFile, {});
      snapshot = read(path.join(runDir, 'comments.json'), { markers: [] });
      oldTimeline = semanticTimeline(read(path.join(runDir, 'timeline.json'), {}));
    } catch (_) { continue; } // An unfinished/invalid result cannot break other completed edits.
    const batch = /^[a-zA-Z0-9_-]+$/.test(result.batchId || '') ? read(path.join(root, 'codex_batches', result.batchId, 'batch.json'), {}) : {};
    for (const item of result.items || []) {
      const marker = current.get(item.markerId);
      if (!marker) continue;
      const original = snapshot.markers.find(m => m.id === item.markerId);
      const spec = item.apply || specs.find(s => s.markerId === item.markerId && s.submissionId === name);
      const candidate = { markerId: marker.id, submissionId: name, summary: item.action || '', originalComment: original?.comment || '',
        previewTime: original?.previewTime, sourceTime: original?.sourceTime, contentHash: original ? fingerprint(original) : null,
        group: spec?.group || marker.id, canAccept: false, staleContent: false, reason: '', clipUrl: null, spec, resultFile };
      try {
        if (item.outputFile && /\.(mp4|mov|webm)$/i.test(item.outputFile)) {
          candidate.clipFile = inside(root, item.outputFile); candidate.clipUrl = urlOf(root, candidate.clipFile);
        }
        if (!original || fingerprint(marker) !== fingerprint(original)) { candidate.staleContent = true; throw new Error('批注已修改，请等待新的修改结果'); }
        if (timeline !== oldTimeline) { candidate.staleContent = true; throw new Error('试剪时间线已改变，请重新生成修改结果'); }
        if (fs.realpathSync(result.inputPreview) !== base.path) throw new Error('此修改对应另一个原版视频');
        const expectedBaseHash = result.basePreviewSha256 || batch.basePreviewSha256;
        if (!expectedBaseHash || expectedBaseHash !== fileDigest(baseVideo)) {
          candidate.staleContent = true; throw new Error('原版视频指纹不同或缺失，请重新生成修改结果');
        }
        if (item.status !== 'implemented' || !candidate.clipUrl) throw new Error('还没有可验收的改后片段');
        if (!spec || spec.mode !== 'ass_overlay' || spec.audio !== 'unchanged') throw new Error('此修改还缺少可验证的全片合入方案');
        candidate.assFile = inside(root, spec.assFile);
        if (!/\.ass$/i.test(candidate.assFile)) throw new Error('合入方案需要 ASS 动效文件');
        const text = fs.readFileSync(candidate.assFile, 'utf8');
        if (!text.includes('[Events]') || !/^Dialogue:/m.test(text)) throw new Error('合入动效为空');
        // An ASS file contains only newly added effects on the original Preview axis.
        candidate.revisionId = hash({ marker: candidate.contentHash, base, timeline, clip: fileIdentity(candidate.clipFile),
          ass: sha(text), spec, submissionId: name, action: item.action });
        candidate.canAccept = true;
      } catch (error) { candidate.reason = error.message; }
      // Updating a Map entry does not change its position; explicitly move the
      // newer submission to the end before choosing each mutually exclusive group.
      candidates.delete(marker.id); candidates.set(marker.id, candidate);
    }
  }
  const latestGroup = new Map();
  for (const candidate of candidates.values()) if (candidate.canAccept) latestGroup.set(candidate.group, candidate);
  for (const candidate of candidates.values()) {
    const latest = latestGroup.get(candidate.group);
    if (latest && latest !== candidate && candidate.canAccept) {
      candidate.canAccept = false; candidate.supersededBy = latest.markerId;
      candidate.reason = '此处已有更新修改，请验收新版本';
    }
  }
  return [...candidates.values()];
}

function createApplication({ root, baseVideo, render, fontsDir }) {
  root = fs.realpathSync(root);
  const stateFile = path.join(root, STATE), work = path.join(root, 'preview_apply');
  let state = read(stateFile, { version: 1, accepted: {}, versions: [], job: null, activeVersion: null });
  let running = false, scheduled = false;
  const renderer = render || (options => require('./preview_apply_render').renderAppliedPreview(options));
  function usable(version) {
    try { return Boolean(version && fs.statSync(version.videoFile).size > 0 && read(version.verificationFile, null)?.passed === true); }
    catch (_) { return false; }
  }
  function save() { atomic(stateFile, state); }
  function event(type, data) {
    fs.mkdirSync(work, { recursive: true });
    fs.appendFileSync(path.join(work, 'events.jsonl'), JSON.stringify({ type, at: new Date().toISOString(), ...data }) + '\n');
  }
  if (state.job?.state === 'rendering') { state.job.state = 'failed'; state.job.error = '上次合成中断，原视频和验收记录仍在，可重试'; save(); }
  function validAccepted(candidates) {
    const byId = new Map(candidates.map(c => [c.markerId, c]));
    return Object.values(state.accepted).filter(a => {
      const candidate = byId.get(a.markerId);
      return candidate && !candidate.staleContent && candidate.revisionId === a.revisionId;
    });
  }
  const signature = accepted => hash(accepted.map(a => a.revisionId).sort());
  function publicState() {
    const candidates = catalogue(root, baseVideo), accepted = validAccepted(candidates);
    const acceptedMap = new Map(accepted.map(a => [a.markerId, a]));
    const desired = signature(accepted);
    const ready = state.activeVersion && state.activeVersion.signature === desired && usable(state.activeVersion);
    const missing = state.activeVersion?.signature === desired && !usable(state.activeVersion);
    return {
      state: state.job?.state === 'rendering' ? 'rendering' : state.job?.state === 'failed' || missing ? 'failed' : ready ? 'ready' : 'idle',
      candidates: candidates.map(c => ({ markerId: c.markerId, revisionId: c.revisionId || '', clipUrl: c.clipUrl,
        summary: c.summary, canAccept: c.canAccept, reason: c.reason,
        status: acceptedMap.has(c.markerId) ? (ready ? 'applied' : 'accepted') : c.canAccept ? 'ready' : 'stale' })),
      acceptedMarkerIds: accepted.map(a => a.markerId),
      job: state.job ? { id: state.job.id, state: missing ? 'failed' : state.job.state, progressFrames: state.job.progressFrames || 0, totalFrames: state.job.totalFrames || 0, error: missing ? '完整新版或验证记录缺失，请重试合成' : state.job.error || null } : null,
      activeVersion: ready ? { id: state.activeVersion.id, videoUrl: `/applied-video/${state.activeVersion.id}`, duration: state.activeVersion.duration, identityTimeline: true } : null,
    };
  }
  function schedule() {
    if (running || scheduled) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; pump().catch(error => { state.job = { ...state.job, state: 'failed', error: error.message }; save(); }); });
  }
  async function pump(force = false) {
    if (running) return;
    const candidates = catalogue(root, baseVideo), accepted = validAccepted(candidates), wanted = signature(accepted);
    const stale = Object.values(state.accepted).filter(a => !accepted.includes(a));
    for (const record of stale) { delete state.accepted[record.markerId]; event('invalidated', { record, reason: '原批注、时间线或修改产物已改变' }); }
    if (!accepted.length) { if (state.activeVersion || stale.length) { state.activeVersion = null; state.job = null; save(); } return; }
    if (!force && state.activeVersion?.signature === wanted && usable(state.activeVersion)) return;
    if (!force && state.job?.state === 'failed' && state.job.signature === wanted) return;
    const cached = state.versions.find(v => v.signature === wanted && usable(v));
    if (cached) { state.activeVersion = cached; state.job = { id: cached.id, state: 'ready', signature: wanted }; save(); return; }
    const id = crypto.randomUUID(), dir = path.join(work, 'versions', id);
    fs.mkdirSync(dir, { recursive: true });
    const selected = accepted.map(a => candidates.find(c => c.markerId === a.markerId));
    const assFiles = selected.map((c, i) => { const target = path.join(dir, `effect-${i}.ass`); fs.copyFileSync(c.assFile, target); return target; });
    const snapshot = { id, signature: wanted, base: fileIdentity(baseVideo), accepted, assFiles, createdAt: new Date().toISOString() };
    atomic(path.join(dir, 'manifest.json'), snapshot);
    state.job = { id, signature: wanted, state: 'rendering', progressFrames: 0, totalFrames: 0 }; save();
    event('render_started', { id, accepted });
    let lastSave = 0;
    running = true;
    try {
      const result = await renderer({ baseVideo, assFiles, fontsDir: fontsDir || selected[0]?.spec?.fontsDir, outputDir: dir,
        onProgress: progress => { Object.assign(state.job, progress); if (Date.now() - lastSave > 700) { save(); lastSave = Date.now(); } } });
      if (!usable(result)) throw new Error('合成未返回视频与通过的验证记录');
      const version = { id, signature: wanted, videoFile: result.videoFile, verificationFile: result.verificationFile,
        duration: result.duration, frameCount: result.frameCount, accepted, createdAt: new Date().toISOString() };
      state.versions.push(version);
      if (signature(validAccepted(catalogue(root, baseVideo))) === wanted) state.activeVersion = version;
      state.job = { id, signature: wanted, state: 'ready', progressFrames: result.frameCount, totalFrames: result.frameCount }; save();
      event('render_verified', { version });
    } catch (error) {
      state.job = { ...state.job, state: 'failed', error: error.message }; save(); event('render_failed', { id, error: error.message });
    } finally { running = false; }
    // A second approval received during rendering is serialized, never lost.
    if (signature(validAccepted(catalogue(root, baseVideo))) !== wanted) schedule();
  }
  function accept({ markerId, revisionId }) {
    const candidates = catalogue(root, baseVideo), candidate = candidates.find(c => c.markerId === markerId);
    if (!candidate?.canAccept || candidate.revisionId !== revisionId) {
      const error = new Error(candidate?.reason || '修改版本已改变，请刷新修改结果后再验收'); error.status = 409; throw error;
    }
    if (state.accepted[markerId]?.revisionId !== revisionId) {
      for (const old of Object.values(state.accepted)) if (old.group === candidate.group) {
        delete state.accepted[old.markerId]; event('superseded', { record: old, replacement: revisionId });
      }
      const record = { markerId, revisionId, group: candidate.group, submissionId: candidate.submissionId,
        approvedAt: new Date().toISOString(), originalComment: candidate.originalComment, previewTime: candidate.previewTime,
        sourceTime: candidate.sourceTime, summary: candidate.summary, clipFile: candidate.clipFile, resultFile: candidate.resultFile, contentHash: candidate.contentHash };
      state.accepted[markerId] = record; event('accepted', { record }); save();
    }
    schedule();
    return publicState();
  }
  function retry() { if (!running) { if (state.job?.state === 'failed') { state.job = null; save(); } schedule(); } return publicState(); }
  function mediaFile(id) {
    const version = state.versions.find(v => v.id === id);
    return usable(version) ? inside(root, version.videoFile) : null;
  }
  return { status: publicState, accept, retry, refresh: schedule, mediaFile, idle: async () => { while (running || scheduled) await new Promise(r => setTimeout(r, 20)); } };
}

module.exports = { createApplication, catalogue, fingerprint, semanticTimeline, STATE, INDEX };
