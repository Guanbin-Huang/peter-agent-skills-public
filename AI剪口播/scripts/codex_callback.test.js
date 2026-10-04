'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createCallbackConfig, buildPrompt, extractProgress, startCodexJob, refreshIncrementalQueue, scheduleIncrementalBatch, startNextIncrementalBatch, recoverIncrementalState } = require('./codex_callback');

test('callback config only requires a Codex binary; origin thread is optional metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-callback-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  const enabled = createCallbackConfig({ threadId: 'thread-1', codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  const disabled = createCallbackConfig({ threadId: '', codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  assert.equal(enabled.enabled, true);
  assert.equal(disabled.enabled, true);
  assert.equal(disabled.threadId, null);
  assert.equal(Object.hasOwn(enabled, 'model'), false);
  assert.equal(Object.hasOwn(enabled, 'reasoningEffort'), false);
  const configured = createCallbackConfig({ codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root,
    previous: { token: 'retained', model: 'gpt-6-astra', reasoningEffort: 'medium' } });
  assert.equal(configured.token, 'retained');
  assert.equal(configured.model, 'gpt-6-astra');
  assert.equal(configured.reasoningEffort, 'medium');
  const previousGeneration = createCallbackConfig({ codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root,
    previous: { model: 'gpt-6-sol', reasoningEffort: 'high' } });
  assert.equal(previousGeneration.model, 'gpt-6-sol');
  assert.equal(previousGeneration.reasoningEffort, 'high');
});

test('callback prompt sends Codex to saved JSON and requires global context', () => {
  const prompt = buildPrompt({ projectDir: '/p', reviewDir: '/p/review' }, 2);
  assert.match(prompt, /preview_comments\.json/);
  assert.match(prompt, /全局批注必须感知完整逐字稿/);
  assert.match(prompt, /不要要求用户复制清单/);
  assert.match(prompt, /2 条/);
  assert.match(prompt, /进度 X\/4/);
  assert.match(prompt, /不要启动或重启本地服务/);
  assert.match(prompt, /只在本批目录输出局部结果/);
  assert.match(prompt, /不得替换当前播放器媒体/);
  assert.match(prompt, /退出码 0 但没有有效结构化结果仍视为失败/);
  assert.match(prompt, /禁止覆盖或清空活动 preview_comments\.json/);
  assert.match(prompt, /本次结构化结果/);
  assert.match(prompt, /preferenceCandidates/);
});

test('extractProgress turns JSONL events into safe human-readable live feedback', () => {
  const jsonl = [
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '进度 2/4：已确定全局衔接方案。' } },
    { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ffmpeg -i source.mp4 output.mp4' } },
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ffmpeg -i source.mp4 output.mp4', exit_code: 0 } },
    { type: 'item.started', item: { id: 'c2', type: 'command_execution', command: 'ffprobe -show_streams output.mp4' } },
  ].map(event => JSON.stringify(event)).join('\n');
  const progress = extractProgress(jsonl, { startedAt: new Date(Date.now() - 65000).toISOString() });
  assert.equal(progress.step, 3);
  assert.equal(progress.totalSteps, 4);
  assert.equal(progress.current, '正在核对视频规格与音画同步');
  assert.match(progress.latestMessage, /已确定全局衔接方案/);
  assert.ok(progress.elapsedSeconds >= 64);
  assert.ok(progress.activity.length >= 2);
  assert.doesNotMatch(JSON.stringify(progress), /source\.mp4/);
});

test('extractProgress advances from observed work when the worker omits a stage message', () => {
  const jsonl = [
    { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: '进度 1/4：已读取文件。' } },
    { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ffmpeg -i source.mov rendered_preview.mp4' } },
  ].map(event => JSON.stringify(event)).join('\n');
  const progress = extractProgress(jsonl, { state: 'running', startedAt: new Date().toISOString() });
  assert.equal(progress.step, 3);
  assert.equal(progress.totalSteps, 4);
});

test('startCodexJob uses an isolated ephemeral worker instead of double-writing the desktop thread', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-job-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [{ id: 'm1' }, { id: 'm2' }] }));
  let invocation;
  const fakeSpawn = (command, args, options) => {
    const child = new EventEmitter(); child.pid = process.pid; child.stdin = new PassThrough(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {};
    let stdin = ''; child.stdin.on('data', chunk => { stdin += chunk; }); child.stdin.on('finish', () => {
      invocation = { command, args, options, stdin };
      const resultMatch = stdin.match(/本次结构化结果：([^\n]+)/);
      if (resultMatch && /形成增量批次/.test(stdin)) {
        const output = path.join(root, 'batch-output.mp4'); fs.writeFileSync(output, 'video');
        fs.writeFileSync(resultMatch[1].trim(), JSON.stringify({ version: 1, batchId: (stdin.match(/形成增量批次 (batch-[^。]+)/)||[])[1], outputPreview: output, items: [{ markerId: 'm1', outputFile: output }, { markerId: 'm2', outputFile: output }] }));
      }
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir);
  const config = createCallbackConfig({ threadId: 'thread-abc', codexBin: bin, workspaceDir: root, projectDir, reviewDir: root });
  const running = startCodexJob(config, { spawnImpl: fakeSpawn });
  assert.equal(running.state, 'running');
  await new Promise(resolve => setTimeout(resolve, 20));
  const status = JSON.parse(fs.readFileSync(path.join(root, 'codex_callback_status.json'), 'utf8'));
  assert.equal(status.state, 'completed');
  assert.deepEqual(invocation.args.slice(0, 3), ['exec', '--ephemeral', '--skip-git-repo-check']);
  assert.ok(!invocation.args.includes('resume'));
  assert.ok(!invocation.args.includes('thread-abc'));
  assert.deepEqual(invocation.args.slice(3, 5), ['-C', projectDir]);
  assert.ok(invocation.args.includes('--add-dir'));
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--model'), invocation.args.indexOf('--model') + 4),
    ['--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"']);
  assert.match(invocation.stdin, /preview_comments\.json/);
  assert.match(invocation.stdin, /codex_runs\/codex-.*\/comments\.json/);
  assert.equal(invocation.options.cwd, projectDir);
  assert.ok(fs.existsSync(status.commentsSnapshotFile));
  assert.ok(fs.existsSync(status.timelineSnapshotFile));
  assert.ok(fs.existsSync(status.runStatusFile));
  assert.ok(fs.existsSync(status.promptFile));
  assert.ok(fs.existsSync(status.logFile));
  assert.ok(fs.existsSync(status.lastMessageFile));
  assert.match(status.runDir, /codex_runs\/codex-/);
  assert.equal(status.resultRecorded, false);
  assert.equal(status.requestedModel, 'gpt-6.1-sol');
  assert.equal(status.requestedReasoningEffort, 'high');
  const submission = JSON.parse(fs.readFileSync(status.runStatusFile, 'utf8'));
  assert.equal(submission.requestedModel, 'gpt-6.1-sol');
  assert.equal(submission.requestedReasoningEffort, 'high');
});

test('callback job honors explicit model and effort without changing the existing execution wrapper', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-model-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [{ id: 'm1' }] }));
  let invocation;
  const fakeSpawn = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter(); child.pid = process.pid; child.stdin = new PassThrough(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {};
    child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0, null)));
    return child;
  };
  const config = createCallbackConfig({ codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root,
    previous: { model: 'gpt-6-astra', reasoningEffort: 'medium' }, model: 'gpt-6-luna', reasoningEffort: 'low' });
  startCodexJob(config, { spawnImpl: fakeSpawn });
  await new Promise(resolve => setTimeout(resolve, 20));
  const status = JSON.parse(fs.readFileSync(path.join(root, 'codex_callback_status.json'), 'utf8'));
  assert.equal(invocation.command, bin);
  assert.deepEqual(invocation.args.slice(0, 5), ['exec', '--ephemeral', '--skip-git-repo-check', '-C', root]);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--model'), invocation.args.indexOf('--model') + 4),
    ['--model', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"']);
  assert.deepEqual(invocation.args.slice(-6), ['--sandbox', 'workspace-write', '--json', '-o', status.lastMessageFile, '-']);
  assert.equal(invocation.options.cwd, root);
  assert.equal(status.requestedModel, 'gpt-6-luna');
  assert.equal(status.requestedReasoningEffort, 'low');
});

test('startCodexJob refuses an empty annotation set', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-empty-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [] }));
  const config = createCallbackConfig({ threadId: 'thread-abc', codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  assert.throws(() => startCodexJob(config), /还没有已保存的批注/);
});

test('incremental queue batches every two fresh saved comments and snapshots only that batch', async () => {
  const { refreshIncrementalQueue, startNextIncrementalBatch } = require('./codex_callback');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-inc-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [
    { id: 'm1', previewTime: 1, comment: 'one' },
    { id: 'm2', previewTime: 2, comment: 'two' },
    { id: 'm3', previewTime: 3, comment: 'three' },
  ] }));
  fs.writeFileSync(path.join(root, 'preview_timeline.json'), JSON.stringify({ version: 1, clips: [{ id: 'c1', sourceStart: 0, sourceEnd: 10 }] }));
  const config = createCallbackConfig({ threadId: '', codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  let state = refreshIncrementalQueue(config);
  assert.equal(state.batches.length, 1);
  assert.deepEqual(state.batches[0].markers.map(m => m.id), ['m1', 'm2']);
  assert.deepEqual(state.pendingMarkerIds, ['m3']);
  let invocation;
  const fakeSpawn = (command, args, options) => {
    const child = new EventEmitter(); child.pid = process.pid; child.stdin = new PassThrough(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {};
    let stdin = ''; child.stdin.on('data', chunk => { stdin += chunk; }); child.stdin.on('finish', () => {
      invocation = { command, args, options, stdin };
      const resultMatch = stdin.match(/本次结构化结果：([^\n]+)/);
      if (resultMatch) {
        const output = path.join(root, 'batch-output.mp4'); fs.writeFileSync(output, 'video');
        fs.writeFileSync(resultMatch[1].trim(), JSON.stringify({ version: 1, batchId: (stdin.match(/形成增量批次 (batch-[^。]+)/)||[])[1], outputPreview: output, items: [{ markerId: 'm1', outputFile: output }, { markerId: 'm2', outputFile: output }] }));
      }
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
  const running = startNextIncrementalBatch(config, { spawnImpl: fakeSpawn });
  assert.equal(running.state, 'running');
  await new Promise(resolve => setTimeout(resolve, 20));
  const status = JSON.parse(fs.readFileSync(path.join(root, 'codex_callback_status.json'), 'utf8'));
  const snap = JSON.parse(fs.readFileSync(status.commentsSnapshotFile, 'utf8'));
  assert.deepEqual(snap.markers.map(m => m.id), ['m1', 'm2']);
  assert.doesNotMatch(invocation.stdin, /m3/);
});

test('incremental queue marks an unprocessed batch stale when marker content changes', () => {
  const { refreshIncrementalQueue } = require('./codex_callback');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-stale-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  const config = createCallbackConfig({ threadId: '', codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [
    { id: 'm1', previewTime: 1, comment: 'old one' },
    { id: 'm2', previewTime: 2, comment: 'two' },
  ] }));
  let state = refreshIncrementalQueue(config);
  assert.equal(state.batches[0].state, 'queued');
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [
    { id: 'm1', previewTime: 1, comment: 'new one' },
    { id: 'm2', previewTime: 2, comment: 'two' },
  ] }));
  state = refreshIncrementalQueue(config);
  assert.equal(state.batches[0].state, 'stale');
  assert.equal(state.batches[1].state, 'queued');
  assert.deepEqual(state.batches[1].markers.map(m => m.comment), ['new one', 'two']);
});

test('reviewed-to-here and manual submit can flush one saved comment', () => {
  const { refreshIncrementalQueue, setIncrementalPaused } = require('./codex_callback');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-flush-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  const config = createCallbackConfig({ threadId: '', codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [{ id: 'm1', previewTime: 12, comment: 'single' }] }));
  let state = refreshIncrementalQueue(config);
  assert.equal(state.batches.length, 0);
  assert.deepEqual(state.pendingMarkerIds, ['m1']);
  state = refreshIncrementalQueue(config, { reviewedToHere: 12, flushOne: true });
  assert.equal(state.reviewedToHere, 12);
  assert.equal(state.batches.length, 1);
  assert.deepEqual(state.batches[0].markers.map(m => m.id), ['m1']);
  state = setIncrementalPaused(root, true);
  assert.equal(state.paused, true);
});

test('debounce persists a deadline and does not queue a pair before the deadline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-debounce-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [
    { id: 'm1', previewTime: 1, comment: 'one' },
    { id: 'm2', previewTime: 2, comment: 'two' },
  ] }));
  const config = createCallbackConfig({ threadId: '', codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  let state = scheduleIncrementalBatch(config, { debounceMs: 60_000 });
  assert.equal(state.batches.length, 0);
  assert.deepEqual(state.pendingMarkerIds, ['m1', 'm2']);
  state = refreshIncrementalQueue(config);
  assert.equal(state.batches.length, 0);
  state.debounceUntil = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(path.join(root, 'incremental_review_state.json'), JSON.stringify(state));
  state = refreshIncrementalQueue(config);
  assert.equal(state.batches.length, 1);
});

test('failed unchanged batches are held and not retried on every status poll', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-failed-hold-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [
    { id: 'm1', previewTime: 1, comment: 'one' },
    { id: 'm2', previewTime: 2, comment: 'two' },
  ] }));
  const config = createCallbackConfig({ threadId: '', codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  let state = refreshIncrementalQueue(config);
  state.batches[0].state = 'failed';
  fs.writeFileSync(path.join(root, 'incremental_review_state.json'), JSON.stringify(state));
  state = refreshIncrementalQueue(config);
  assert.equal(state.batches.length, 1);
  assert.equal(state.batches[0].state, 'failed');
  assert.deepEqual(state.pendingMarkerIds, []);
});

test('deleted resolved and edited completed marker revisions invalidate old batch state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-invalidate-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  const config = createCallbackConfig({ threadId: '', codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [
    { id: 'm1', previewTime: 1, comment: 'one' },
    { id: 'm2', previewTime: 2, comment: 'two' },
  ] }));
  let state = refreshIncrementalQueue(config);
  state.batches[0].state = 'completed';
  fs.writeFileSync(path.join(root, 'incremental_review_state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [
    { id: 'm1', previewTime: 1, comment: 'one', resolved: true },
    { id: 'm2', previewTime: 2, comment: 'two' },
  ] }));
  state = refreshIncrementalQueue(config);
  assert.equal(state.batches[0].state, 'stale');
});

test('batch creation freezes timeline and preview config snapshots before worker start', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-freeze-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [
    { id: 'm1', previewTime: 1, comment: 'one' },
    { id: 'm2', previewTime: 2, comment: 'two' },
  ] }));
  fs.writeFileSync(path.join(root, 'preview_timeline.json'), JSON.stringify({ version: 1, clips: [{ id: 'old', sourceStart: 0, sourceEnd: 5 }] }));
  fs.writeFileSync(path.join(root, 'preview_review_config.json'), JSON.stringify({ previewVideo: path.join(root, 'actual.mp4') }));
  fs.writeFileSync(path.join(root, 'actual.mp4'), 'video-bytes');
  const config = createCallbackConfig({ threadId: '', codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  const state = refreshIncrementalQueue(config);
  assert.equal(state.batches[0].basePreviewSha256, require('node:crypto').createHash('sha256').update('video-bytes').digest('hex'));
  fs.writeFileSync(path.join(root, 'preview_timeline.json'), JSON.stringify({ version: 1, clips: [{ id: 'new', sourceStart: 5, sourceEnd: 10 }] }));
  let statusPath;
  const fakeSpawn = (command, args, options) => {
    const child = new EventEmitter(); child.pid = process.pid; child.stdin = new PassThrough(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {};
    let stdin = ''; child.stdin.on('data', chunk => { stdin += chunk; }); child.stdin.on('finish', () => {
      const resultMatch = stdin.match(/本次结构化结果：([^\n]+)/); statusPath = resultMatch?.[1].trim();
      if (statusPath) { const output = path.join(root, 'clip.mp4'); fs.writeFileSync(output, 'clip'); fs.writeFileSync(statusPath, JSON.stringify({ version: 1, batchId: state.batches[0].batchId, outputPreview: output, items: [{ markerId: 'm1', outputFile: output }, { markerId: 'm2', outputFile: output }] })); }
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
  startNextIncrementalBatch(config, { spawnImpl: fakeSpawn });
  await new Promise(resolve => setTimeout(resolve, 20));
  const status = JSON.parse(fs.readFileSync(path.join(root, 'codex_callback_status.json'), 'utf8'));
  const timeline = JSON.parse(fs.readFileSync(status.timelineSnapshotFile, 'utf8'));
  assert.equal(timeline.clips[0].id, 'old');
});

test('worker exit 0 without a structured per-marker result fails the batch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-result-required-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  fs.writeFileSync(path.join(root, 'preview_comments.json'), JSON.stringify({ markers: [
    { id: 'm1', previewTime: 1, comment: 'one' },
    { id: 'm2', previewTime: 2, comment: 'two' },
  ] }));
  const config = createCallbackConfig({ threadId: '', codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  refreshIncrementalQueue(config);
  const fakeSpawn = () => {
    const child = new EventEmitter(); child.pid = process.pid; child.stdin = new PassThrough(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.unref = () => {};
    child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0, null)));
    return child;
  };
  startNextIncrementalBatch(config, { spawnImpl: fakeSpawn });
  await new Promise(resolve => setTimeout(resolve, 20));
  const state = JSON.parse(fs.readFileSync(path.join(root, 'incremental_review_state.json'), 'utf8'));
  assert.equal(state.batches[0].state, 'failed');
  assert.equal(state.batches[0].error, 'worker_exit_0_without_structured_result');
});

test('recover marks an orphan running batch failed instead of blocking forever', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koubo-recover-'));
  const bin = path.join(root, 'codex'); fs.writeFileSync(bin, '');
  const config = createCallbackConfig({ threadId: '', codexBin: bin, workspaceDir: root, projectDir: root, reviewDir: root });
  fs.writeFileSync(path.join(root, 'codex_callback_status.json'), JSON.stringify({ state: 'running', pid: 99999999 }));
  fs.writeFileSync(path.join(root, 'incremental_review_state.json'), JSON.stringify({ batches: [{ batchId: 'b1', state: 'running', markers: [] }], activeBatchId: 'b1' }));
  const state = recoverIncrementalState(config);
  assert.equal(state.batches[0].state, 'failed');
  assert.equal(state.activeBatchId, null);
});
