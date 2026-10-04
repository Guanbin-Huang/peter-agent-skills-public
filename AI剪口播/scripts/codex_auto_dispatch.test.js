'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCallbackConfig, scheduleIncrementalBatch, readIncrementalState, setIncrementalPaused, refreshIncrementalQueue } = require('./codex_callback');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-auto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, 'fixture');
  const config = createCallbackConfig({ codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  const write = markers => fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers }));
  const children = [], snapshots = [];
  const spawnImpl = () => {
    const child = new EventEmitter(); Object.assign(child, { pid: process.pid, stdin: new PassThrough(), stdout: new EventEmitter(), stderr: new EventEmitter(), unref() {} });
    let prompt = ''; child.stdin.on('data', chunk => { prompt += chunk; });
    // stdin.end() writes synchronously before returning from startCodexJob.
    child.complete = (code = 0) => {
      const status = JSON.parse(fs.readFileSync(path.join(root, 'codex_callback_status.json')));
      const snap = JSON.parse(fs.readFileSync(status.commentsSnapshotFile));
      snapshots.push(snap.markers.map(m => m.id));
      const output = path.join(status.runDir, 'clip.mp4'); fs.writeFileSync(output, 'dispatch-only test output');
      fs.writeFileSync(status.resultFile, JSON.stringify({ batchId: status.batchId, outputPreview: output, items: snap.markers.map(m => ({ markerId: m.id, outputFile: output })) }));
      child.emit('close', code, null);
    };
    children.push(child); return child;
  };
  return { root, config, write, children, snapshots, spawnImpl };
}
const markers = n => Array.from({ length: n }, (_, i) => ({ id: 'm' + (i + 1), previewTime: i + 1, comment: '修改 ' + (i + 1) }));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('first comment waits; second saved comment starts immediately without timer, click or poll', async t => {
  const f = fixture(t); f.write(markers(1));
  let state = scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  assert.equal(f.children.length, 0); assert.deepEqual(state.pendingMarkerIds, ['m1']);
  f.write(markers(2)); state = scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  assert.equal(f.children.length, 1); assert.equal(state.batches[0].state, 'running');
  assert.deepEqual(state.batches[0].markers.map(m => m.id), ['m1','m2']);
  scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  assert.equal(f.children.length, 1);
  f.children[0].complete(); await nextTurn(); assert.equal(f.children.length, 1);
});

test('busy worker drains pairs automatically; final singleton waits until end signal', async t => {
  const f = fixture(t); f.write(markers(2)); scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  f.write(markers(7)); let state = scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  assert.equal(f.children.length, 1); assert.deepEqual(state.pendingMarkerIds, ['m3','m4','m5','m6','m7']);
  for (let i = 0; i < 3; i++) { f.children[i].complete(); await nextTurn(); }
  assert.deepEqual(f.snapshots, [['m1','m2'],['m3','m4'],['m5','m6']]);
  assert.equal(f.children.length, 3);
  scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl, flushOne: true });
  assert.equal(f.children.length, 4); f.children[3].complete(); await nextTurn();
  assert.deepEqual(f.snapshots[3], ['m7']); state = readIncrementalState(f.root);
  assert.ok(state.batches.every(b => b.state === 'completed')); assert.deepEqual(state.pendingMarkerIds, []);
});

test('end signal while worker busy persists and automatically starts final singleton later', async t => {
  const f = fixture(t); f.write(markers(2)); scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  f.write(markers(3)); scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl, flushOne: true });
  assert.equal(readIncrementalState(f.root).flushPending, true); assert.equal(f.children.length, 1);
  f.children[0].complete(); await nextTurn(); assert.equal(f.children.length, 2);
  f.children[1].complete(); await nextTurn();
  assert.deepEqual(f.snapshots, [['m1','m2'],['m3']]);
  assert.equal(readIncrementalState(f.root).flushPending, false);
  f.write(markers(4)); scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  assert.equal(f.children.length, 2, 'old end signal must not make all future single comments auto-start');
});

test('editing a running comment discards old result and processes fresh revision automatically', async t => {
  const f = fixture(t); const list = markers(2); f.write(list); scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  list[0].comment = '新版修改'; f.write(list); scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  f.children[0].complete(); await nextTurn();
  assert.equal(f.children.length, 2); let state = readIncrementalState(f.root);
  assert.equal(state.batches[0].state, 'stale'); assert.equal(state.batches[1].markers[0].comment, '新版修改');
  f.children[1].complete(); await nextTurn();
  state = readIncrementalState(f.root); assert.equal(state.batches[1].state, 'completed');
});

test('failed pair does not block later comments or retry itself in a loop', async t => {
  const f = fixture(t); f.write(markers(2)); scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  f.write(markers(4)); scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  f.children[0].complete(1); await nextTurn(); assert.equal(f.children.length, 2);
  f.children[1].complete(); await nextTurn(); assert.equal(f.children.length, 2);
  const state = refreshIncrementalQueue(f.config); assert.deepEqual(state.batches.map(b => b.state), ['failed','completed']);
});

test('pause preserves a pair; resume starts it with automatic scheduler', async t => {
  const f = fixture(t); f.write(markers(2)); setIncrementalPaused(f.root, true);
  scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl }); assert.equal(f.children.length, 0);
  setIncrementalPaused(f.root, false); scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  assert.equal(f.children.length, 1); f.children[0].complete(); await nextTurn();
});

test('completed revisions are not reprocessed on restart or autosave', async t => {
  const f = fixture(t); f.write(markers(2)); scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  f.children[0].complete(); await nextTurn();
  for (let i = 0; i < 3; i++) scheduleIncrementalBatch(f.config, { spawnImpl: f.spawnImpl });
  assert.equal(f.children.length, 1); assert.equal(readIncrementalState(f.root).batches.length, 1);
});

test('real resultPage files satisfy the documented worker output contract', t => {
  const f = fixture(t); const page = path.join(f.root, 'review.html'); fs.writeFileSync(page, '<h1>result</h1>');
  const result = path.join(f.root, 'result.json'); const batch = { markers: [{ id: 'm1' }] };
  const { validateBatchResult } = require('./codex_callback');
  for (const payload of [{ resultPage: page, items: [{ markerId:'m1' }] }, { items: [{ markerId:'m1', resultPage:page }] }]) {
    fs.writeFileSync(result, JSON.stringify(payload)); const check = validateBatchResult(result, batch);
    assert.equal(check.ok, true); assert.deepEqual(check.realOutputs, [page]);
  }
});
