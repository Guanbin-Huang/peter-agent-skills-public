'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createApplication, catalogue, STATE } = require('./preview_apply');
const delay = ms => new Promise(r => setTimeout(r, ms));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-accept-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const baseVideo = write('base.mp4', 'immutable base');
  const markers = [{ id: 'a', previewTime: 1, comment: 'effect A', resolved: false }, { id: 'b', previewTime: 3, comment: 'effect B', resolved: false }];
  const timeline = { clips: [{ sourceStart: 0, sourceEnd: 5 }], sourceDuration: 5, updatedAt: 'live' };
  write('preview_comments.json', { markers }); write('preview_timeline.json', timeline);
  const add = (marker, submission = 'run-1', group = marker.id) => {
    const clip = write(`${submission}/${marker.id}.mp4`, 'clip-' + marker.id);
    const ass = write(`${submission}/${marker.id}.ass`, '[Events]\nDialogue: ' + marker.comment);
    const resultFile = path.join(root, 'codex_runs', submission, 'result.json');
    const prior = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile)) : { inputPreview: baseVideo, basePreviewSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(baseVideo)).digest('hex'), items: [] };
    prior.items.push({ markerId: marker.id, status: 'implemented', action: marker.comment, outputFile: clip,
      apply: { mode: 'ass_overlay', audio: 'unchanged', assFile: ass, group, fontsDir: root } });
    write(`codex_runs/${submission}/status.json`, { state: 'completed' });
    write(`codex_runs/${submission}/timeline.json`, { ...timeline, updatedAt: 'snapshot' });
    write(`codex_runs/${submission}/comments.json`, { markers }); write(`codex_runs/${submission}/result.json`, prior);
  };
  markers.forEach(m => add(m));
  return { root, baseVideo, write, markers, add };
}
function fakeRender(calls, failure = false) {
  return async options => {
    calls.push(options.assFiles.map(f => fs.readFileSync(f, 'utf8')));
    options.onProgress({ progressFrames: 1, totalFrames: 5 }); await delay(35);
    if (failure) throw new Error('render fixture failed');
    const videoFile = path.join(options.outputDir, 'full.mp4'), verificationFile = path.join(options.outputDir, 'verification.json');
    fs.writeFileSync(videoFile, 'verified fixture'); fs.writeFileSync(verificationFile, '{"passed":true}');
    return { videoFile, verificationFile, duration: 5, frameCount: 150, identityTimeline: true };
  };
}
test('catalogue maps each marker to its own result; timestamp-only timeline changes are harmless', t => {
  const f = fixture(t), items = catalogue(f.root, f.baseVideo);
  assert.equal(items.length, 2); assert.ok(items.every(c => c.canAccept));
  assert.match(items[0].clipUrl, /a.mp4$/); assert.match(items[1].clipUrl, /b.mp4$/);
});
test('accept is explicit, idempotent and does not mutate comments or resolved', async t => {
  const f = fixture(t), calls = [], app = createApplication({ ...f, render: fakeRender(calls) });
  const original = fs.readFileSync(path.join(f.root, 'preview_comments.json'));
  assert.equal(app.status().acceptedMarkerIds.length, 0);
  const candidate = app.status().candidates[0];
  app.accept(candidate); app.accept(candidate); await app.idle();
  assert.equal(calls.length, 1); assert.equal(app.status().state, 'ready');
  assert.deepEqual(app.status().acceptedMarkerIds, ['a']);
  assert.equal(app.status().candidates[0].status, 'applied');
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'preview_comments.json')), original);
  const events = fs.readFileSync(path.join(f.root, 'preview_apply/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.type === 'accepted').length, 1);
  assert.equal(events[0].record.originalComment, 'effect A');
});
test('an approval arriving during render is queued and only complete latest version is exposed', async t => {
  const f = fixture(t), calls = [], app = createApplication({ ...f, render: fakeRender(calls) });
  const candidates = app.status().candidates;
  app.accept(candidates[0]); await delay(10); app.accept(candidates[1]);
  assert.equal(app.status().activeVersion, null); await app.idle();
  assert.deepEqual(calls.map(x => x.length), [1, 2]);
  assert.equal(app.status().state, 'ready'); assert.equal(app.status().acceptedMarkerIds.length, 2);
  assert.ok(app.mediaFile(app.status().activeVersion.id));
});
test('edited comment or changed result rejects stale acceptance and invalidates prior approval', async t => {
  const f = fixture(t), calls = [], app = createApplication({ ...f, render: fakeRender(calls) });
  const candidate = app.status().candidates[0]; app.accept(candidate); await app.idle();
  f.markers[0].comment = 'different instruction'; f.write('preview_comments.json', { markers: f.markers });
  assert.throws(() => app.accept(candidate), /批注已修改/);
  assert.equal(app.status().activeVersion, null); app.refresh(); await app.idle();
  assert.equal(app.status().acceptedMarkerIds.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, STATE))).accepted.a, undefined);
});
test('same-location newer revision supersedes old choice, never doubles overlays', async t => {
  const f = fixture(t), calls = [], app = createApplication({ ...f, render: fakeRender(calls) });
  const old = app.status().candidates[0]; app.accept(old); await app.idle();
  const newer = { id: 'c', previewTime: 1.1, comment: 'new effect A' }; f.markers.push(newer);
  f.write('preview_comments.json', { markers: f.markers }); f.add(newer, 'run-2', 'a');
  assert.equal(app.status().candidates.find(c => c.markerId === 'a').canAccept, false);
  app.accept(app.status().candidates.find(c => c.markerId === 'c')); await app.idle();
  assert.deepEqual(app.status().acceptedMarkerIds, ['c']); assert.equal(calls[1].length, 1);
});
test('failed render retains evidence and retry can publish without another approval', async t => {
  const f = fixture(t), calls = []; let fail = true;
  const app = createApplication({ ...f, render: options => fakeRender(calls, fail)(options) });
  app.accept(app.status().candidates[0]); await app.idle(); assert.equal(app.status().state, 'failed');
  assert.equal(app.status().activeVersion, null); fail = false; app.retry(); await app.idle();
  assert.equal(app.status().state, 'ready'); assert.equal(app.status().acceptedMarkerIds.length, 1);
});
test('restart preserves completed acceptance and interrupted render becomes retryable', async t => {
  const f = fixture(t), calls = [], app = createApplication({ ...f, render: fakeRender(calls) });
  app.accept(app.status().candidates[0]); await app.idle();
  const loaded = createApplication({ ...f, render: fakeRender(calls) }); assert.equal(loaded.status().state, 'ready');
  const state = JSON.parse(fs.readFileSync(path.join(f.root, STATE))); state.job.state = 'rendering'; f.write(STATE, state);
  const interrupted = createApplication({ ...f, render: fakeRender(calls) });
  assert.equal(interrupted.status().state, 'failed'); assert.equal(interrupted.status().acceptedMarkerIds.length, 1);
});
test('invalid paths and missing full-application plans cannot be accepted', t => {
  const f = fixture(t), file = path.join(f.root, 'codex_runs/run-1/result.json'), result = JSON.parse(fs.readFileSync(file));
  result.items[0].apply.assFile = __filename; delete result.items[1].apply; fs.writeFileSync(file, JSON.stringify(result));
  assert.ok(catalogue(f.root, f.baseVideo).every(c => !c.canAccept));
});
test('a different video at the same path never makes old edits newly acceptable', t => {
  const f = fixture(t); assert.ok(catalogue(f.root, f.baseVideo)[0].canAccept);
  fs.writeFileSync(f.baseVideo, 'replacement media at same path');
  const candidates = catalogue(f.root, f.baseVideo);
  assert.ok(candidates.every(c => !c.canAccept && c.staleContent));
});
test('revising an older marker makes its newest submission win the same group', t => {
  const f=fixture(t), b={id:'c',previewTime:1,comment:'second choice'};f.markers.push(b);f.add(b,'run-2','a');
  f.markers[0].comment='latest third choice';f.add(f.markers[0],'run-3','a');f.write('preview_comments.json',{markers:f.markers});
  const rows=catalogue(f.root,f.baseVideo);assert.equal(rows.find(c=>c.markerId==='a').canAccept,true);assert.equal(rows.find(c=>c.markerId==='c').canAccept,false);
});
test('a running worker with partial JSON cannot disrupt completed results', t => {
  const f=fixture(t);f.write('codex_runs/run-2/status.json',{state:'running'});f.write('codex_runs/run-2/result.json','{partial');
  assert.equal(catalogue(f.root,f.baseVideo).length,2);
});
test('missing published media is not ready and retry produces a new valid version', async t => {
  const f=fixture(t),calls=[],app=createApplication({...f,render:fakeRender(calls)});app.accept(app.status().candidates[0]);await app.idle();
  const old=app.status().activeVersion;fs.unlinkSync(app.mediaFile(old.id));assert.equal(app.status().state,'failed');assert.equal(app.status().activeVersion,null);
  app.retry();await app.idle();assert.equal(app.status().state,'ready');assert.notEqual(app.status().activeVersion.id,old.id);assert.equal(calls.length,2);
});
test('preparation failure remains retryable instead of permanently locking the queue', async t => {
  const f=fixture(t),calls=[],app=createApplication({...f,render:fakeRender(calls)});f.write('preview_apply/versions','collision');
  app.accept(app.status().candidates[0]);await app.idle();assert.equal(app.status().state,'failed');fs.unlinkSync(path.join(f.root,'preview_apply/versions'));
  app.retry();await app.idle();assert.equal(app.status().state,'ready');
});
