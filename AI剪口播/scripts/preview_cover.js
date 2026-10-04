'use strict';

// Cover uses the underlying A-roll timeline, never the composited Preview pixels.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID, createHash } = require('node:crypto');
const execute = promisify(execFile);
const COVER_FILE = 'preview_cover.json';
const COVER_DESIGN_FILE = 'preview_cover_design.json';
const COVER_RENDERER_VERSION = 5;
const DEFAULT_COVER_STYLE = 'translucent-title-panel';
const COVER_STYLES = Object.freeze([
  Object.freeze({ id: DEFAULT_COVER_STYLE, label: '半透明标题底板' }),
  Object.freeze({ id: 'smiley-bold', label: '得意黑大字' }),
]);
const STYLE_IDS = new Set(COVER_STYLES.map(style => style.id));

function finiteNumber(value) { return typeof value === 'number' && Number.isFinite(value); }

function resolveCoverSource(config, previewTime, root, previewVideo) {
  if (!finiteNumber(previewTime) || previewTime < 0) throw new Error('previewTime 必须是非负有限数值');
  const segments = config.timelineMap;
  if (!Array.isArray(segments) || !segments.length) throw new Error('缺少原片时间映射，请先配置 A-roll 原片与时间线');
  const segmentIndex = segments.findIndex(seg => finiteNumber(seg.previewStart) && finiteNumber(seg.previewEnd) && previewTime >= seg.previewStart && previewTime < seg.previewEnd);
  if (segmentIndex < 0) throw new Error('此位置没有 A-roll 原片映射，请在口播画面内选择');
  const segment = segments[segmentIndex];
  const source = segment.sourcePath || segment.sourceVideo || config.sourceVideo;
  if (typeof source !== 'string' || !source || !/\.(mp4|mov|m4v|mkv|avi|webm|mts|m2ts)$/i.test(source)) throw new Error('缺少此片段的 A-roll 原片路径');
  const sourceVideo = path.resolve(root, source);
  if (!fs.existsSync(sourceVideo) || !fs.statSync(sourceVideo).isFile()) throw new Error('A-roll 原片文件不存在');
  const original = fs.realpathSync(sourceVideo);
  for (const preview of [previewVideo, config.previewVideo].filter(Boolean)) {
    const target = path.resolve(root, preview);
    if (fs.existsSync(target) && fs.realpathSync(target) === original) throw new Error('封面必须取自独立 A-roll 原片，不使用 Preview 截图');
  }
  const start = segment.originalStart ?? segment.sourceStart;
  const end = segment.originalEnd ?? (segment.originalStart == null ? segment.sourceEnd : undefined);
  const speed = segment.speed ?? config.speed ?? 1;
  if (!finiteNumber(start) || start < 0 || !finiteNumber(speed) || speed <= 0 || (end != null && (!finiteNumber(end) || end <= start))) throw new Error('A-roll 原片时间映射无效');
  // originalStart is local to a physical file; sourceStart may be a virtual multi-file offset.
  const sourceTime = start + (previewTime - segment.previewStart) * speed;
  if (!finiteNumber(sourceTime) || (end != null && sourceTime >= end)) throw new Error('此帧超出 A-roll 原片片段范围');
  return { sourceVideo, sourceTime, previewTime, segmentIndex };
}

function readCover(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, COVER_FILE), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function cleanText(value, max = 120) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function defaultCoverDesign() {
  return {
    version: 1,
    title: '',
    subtitle: '',
    style: DEFAULT_COVER_STYLE,
    selectedCandidateId: null,
    sourceImageUrl: null,
    candidates: [],
    updatedAt: null,
  };
}

function validateCoverDesign(payload = {}, current = defaultCoverDesign()) {
  const style = payload.style == null ? current.style : String(payload.style);
  if (!STYLE_IDS.has(style)) throw new Error('封面样式无效');
  return {
    ...defaultCoverDesign(),
    ...current,
    title: payload.title == null ? cleanText(current.title) : cleanText(payload.title),
    subtitle: payload.subtitle == null ? cleanText(current.subtitle) : cleanText(payload.subtitle),
    style,
  };
}

function writeJsonAtomic(file, data) {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function readCoverDesign(root) {
  let stored;
  try { stored = JSON.parse(fs.readFileSync(path.join(root, COVER_DESIGN_FILE), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const design = validateCoverDesign(stored || {});
  const cover = readCover(root);
  const candidates = Array.isArray(stored?.candidates) ? stored.candidates.filter(candidate => {
    if (!candidate || !STYLE_IDS.has(candidate.style) || typeof candidate.imageUrl !== 'string') return false;
    const relative = candidate.imageUrl.replace(/^\//, '');
    const file = path.resolve(root, relative);
    return file.startsWith(path.resolve(root) + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile();
  }).map(candidate => ({
    id: String(candidate.id), style: candidate.style,
    label: COVER_STYLES.find(item => item.id === candidate.style).label,
    imageUrl: candidate.imageUrl,
    selected: String(candidate.id) === String(stored?.selectedCandidateId || ''),
  })) : [];
  if (!cover || stored?.sourceImageUrl !== cover.imageUrl) {
    return { ...design, selectedCandidateId: null, sourceImageUrl: cover?.imageUrl || null, candidates: [] };
  }
  const selectedCandidateId = candidates.some(candidate => candidate.selected) ? String(stored.selectedCandidateId) : null;
  return { ...design, sourceImageUrl: cover.imageUrl, selectedCandidateId, candidates };
}

function saveCoverDesign(root, payload = {}) {
  const current = readCoverDesign(root);
  const next = validateCoverDesign(payload, current);
  const titleChanged = next.title !== current.title || next.subtitle !== current.subtitle;
  const design = {
    ...next,
    selectedCandidateId: titleChanged ? null : current.selectedCandidateId,
    candidates: titleChanged ? [] : current.candidates,
    sourceImageUrl: readCover(root)?.imageUrl || null,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(root, COVER_DESIGN_FILE), design);
  return design;
}

function findSmileyFont(root) {
  let cursor = path.resolve(root);
  for (let level = 0; level < 7; level += 1) {
    for (const relative of ['fonts/SmileySans-Oblique.ttf', 'fonts/SmileySans.ttf']) {
      const candidate = path.join(cursor, relative);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error('缺少得意黑字体 SmileySans-Oblique.ttf');
}

function candidateId(cover, design, style) {
  return createHash('sha256').update(JSON.stringify({
    source: cover.imageUrl, title: design.title, subtitle: design.subtitle, style,
    rendererVersion: COVER_RENDERER_VERSION,
  })).digest('hex').slice(0, 20);
}

async function renderCandidate({ root, cover, design, style }) {
  const id = `${style}-${candidateId(cover, design, style)}`;
  const directory = path.join(root, 'cover_candidates');
  const target = path.join(directory, `${id}.png`);
  const temporary = path.join(directory, `.${id}.${randomUUID()}.tmp.png`);
  fs.mkdirSync(directory, { recursive: true });
  const source = path.resolve(root, String(cover.imageUrl).replace(/^\//, ''));
  if (!source.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(source)) throw new Error('选中的 A-roll 封面帧不存在');
  try {
    await execute('python3', [
      path.join(__dirname, 'render_cover_candidate.py'),
      '--input', source, '--output', temporary, '--font', findSmileyFont(root),
      '--style', style, '--title', design.title, '--subtitle', design.subtitle,
    ], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    const bytes = fs.readFileSync(temporary);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('候选图生成结果不是有效 PNG');
    fs.renameSync(temporary, target);
    return {
      id, style, label: COVER_STYLES.find(item => item.id === style).label,
      imageUrl: `/cover_candidates/${id}.png`, selected: false,
    };
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw new Error(`封面候选生成失败：${error.message}`);
  }
}

async function generateCoverCandidates(root, payload = {}) {
  const cover = readCover(root);
  if (!cover) throw new Error('请先选择封面帧');
  const current = readCoverDesign(root);
  const design = validateCoverDesign(payload, current);
  if (!design.title) throw new Error('请先填写封面标题');
  const candidates = [];
  for (const { id: style } of COVER_STYLES) candidates.push(await renderCandidate({ root, cover, design, style }));
  const selected = candidates.find(candidate => candidate.style === design.style) || candidates[0];
  const next = {
    ...design,
    sourceImageUrl: cover.imageUrl,
    selectedCandidateId: selected.id,
    candidates: candidates.map(candidate => ({ ...candidate, selected: candidate.id === selected.id })),
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(root, COVER_DESIGN_FILE), next);
  return next;
}

function selectCoverCandidate(root, id) {
  const design = readCoverDesign(root);
  const candidate = design.candidates.find(item => item.id === String(id || ''));
  if (!candidate) throw new Error('封面候选不存在或已经过期');
  const next = {
    ...design, style: candidate.style, selectedCandidateId: candidate.id,
    candidates: design.candidates.map(item => ({ ...item, selected: item.id === candidate.id })),
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(root, COVER_DESIGN_FILE), next);
  return next;
}

async function displayedSourceFrame(sourceVideo, sourceTime) {
  const { stdout: streamJson } = await execute('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=start_time:stream=start_time,duration',
    '-of', 'json', sourceVideo,
  ], { timeout: 30000, maxBuffer: 1024 * 1024 });
  const metadata = JSON.parse(streamJson);
  // ffmpeg input -ss is relative to container start, not a possibly delayed video stream.
  const formatStart = Number(metadata.format?.start_time);
  const start = Number.isFinite(formatStart) ? formatStart : Number(metadata.streams?.[0]?.start_time) || 0;
  const target = start + sourceTime;
  const { stdout } = await execute('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-read_intervals', `${Math.max(start, target - 2).toFixed(9)}%${(target + 0.5).toFixed(9)}`,
    '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,duration_time,pkt_duration_time',
    '-of', 'json', sourceVideo,
  ], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const frames = (JSON.parse(stdout).frames || []).map(frame => ({
    time: Number(frame.best_effort_timestamp_time),
    duration: Number(frame.duration_time ?? frame.pkt_duration_time),
  })).filter(frame => Number.isFinite(frame.time)).sort((a, b) => a.time - b.time);
  const frame = frames.filter(frame => frame.time <= target + 1e-7).at(-1);
  if (!frame) throw new Error('此时间没有对应的 A-roll 原片显示帧');
  const next = frames.find(item => item.time > frame.time);
  const stream = metadata.streams?.[0];
  const streamEnd = Number(stream?.start_time) + Number(stream?.duration);
  const frameEnd = next?.time ?? (frame.duration > 0 ? frame.time + frame.duration : streamEnd);
  if (Number.isFinite(frameEnd) && target >= frameEnd - 1e-7) throw new Error('此时间超出 A-roll 原片视频帧范围');
  return Math.max(0, frame.time - start);
}

async function selectCover({ root, config, previewTime, previewVideo }) {
  const selection = resolveCoverSource(config, previewTime, root, previewVideo);
  const id = randomUUID();
  const directory = path.join(root, 'cover_frames');
  const file = path.join(directory, `${id}.png`);
  const temporary = path.join(root, `${COVER_FILE}.${id}.tmp`);
  fs.mkdirSync(directory, { recursive: true });
  try {
    // -ss alone rounds forward; floor by real PTS first (also handles VFR/last frame).
    const sourceFrameTime = await displayedSourceFrame(selection.sourceVideo, selection.sourceTime);
    await execute('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-ss', Math.max(0, sourceFrameTime - 0.000001).toFixed(9), '-i', selection.sourceVideo,
      '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn',
      '-c:v', 'png', '-threads', '1', '-update', '1', file,
    ], { timeout: 60000, maxBuffer: 1024 * 1024 });
    const bytes = fs.readFileSync(file);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('原片此位置没有可用视频帧');
    const cover = {
      version: 1, kind: 'a-roll', ...selection, sourceFrameTime,
      previewVideo: previewVideo || config.previewVideo || null,
      imageUrl: `/cover_frames/${id}.png`,
      width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(temporary, `${JSON.stringify(cover, null, 2)}\n`);
    fs.renameSync(temporary, path.join(root, COVER_FILE));
    const design = readCoverDesign(root);
    writeJsonAtomic(path.join(root, COVER_DESIGN_FILE), {
      ...design, sourceImageUrl: cover.imageUrl, selectedCandidateId: null, candidates: [],
      updatedAt: new Date().toISOString(),
    });
    return cover;
  } catch (error) {
    for (const target of [temporary, file]) { try { fs.unlinkSync(target); } catch (_) {} }
    throw new Error(`封面提取失败：${error.message}`);
  }
}

module.exports = {
  COVER_STYLES, DEFAULT_COVER_STYLE,
  resolveCoverSource, selectCover, readCover,
  defaultCoverDesign, validateCoverDesign, readCoverDesign, saveCoverDesign,
  generateCoverCandidates, selectCoverCandidate,
};
