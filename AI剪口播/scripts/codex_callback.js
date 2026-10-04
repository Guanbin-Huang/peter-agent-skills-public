#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const MAX_BATCH_SIZE = 2;

const FILES = {
  config: 'codex_callback_config.json',
  status: 'codex_callback_status.json',
  prompt: 'codex_callback_prompt.md',
  log: 'codex_callback.log',
  lastMessage: 'codex_callback_last_message.md',
  incrementalState: 'incremental_review_state.json',
};

function writeJsonAtomic(file, data) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function markerFingerprint(marker) {
  const stable = {
    id: String(marker?.id || ''),
    previewTime: Number(marker?.previewTime || 0),
    sourceTime: marker?.sourceTime == null ? null : Number(marker.sourceTime),
    category: String(marker?.category || ''),
    comment: String(marker?.comment || ''),
    scopeMode: marker?.scopeMode === 'global' || marker?.global === true ? 'global' : 'local',
    resolved: Boolean(marker?.resolved),
    reviewPreviewStart: marker?.reviewPreviewStart == null ? null : Number(marker.reviewPreviewStart),
    reviewPreviewEnd: marker?.reviewPreviewEnd == null ? null : Number(marker.reviewPreviewEnd),
    actionPreviewStart: marker?.actionPreviewStart == null ? null : Number(marker.actionPreviewStart),
    actionPreviewEnd: marker?.actionPreviewEnd == null ? null : Number(marker.actionPreviewEnd),
    actionSourceRanges: marker?.actionSourceRanges || marker?.sourceRanges || [],
    reviewSourceRanges: marker?.reviewSourceRanges || [],
  };
  return hashJson(stable);
}

function fileSha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch (_) { return null; }
}

function readReviewConfig(reviewDir) {
  return readJson(path.join(reviewDir, 'preview_review_config.json'), {});
}

function previewVideoPath(config) {
  const reviewConfig = readReviewConfig(config.reviewDir);
  const candidate = config.previewVideo || reviewConfig.previewVideo || reviewConfig.video || null;
  return candidate ? path.resolve(candidate) : null;
}

function readIncrementalState(reviewDir) {
  const file = path.join(reviewDir, FILES.incrementalState);
  const state = readJson(file, null) || {};
  return {
    version: 1,
    paused: Boolean(state.paused),
    flushPending: Boolean(state.flushPending),
    reviewedToHere: Number.isFinite(Number(state.reviewedToHere)) ? Number(state.reviewedToHere) : null,
    debounceUntil: state.debounceUntil || null,
    pendingMarkerIds: Array.isArray(state.pendingMarkerIds) ? state.pendingMarkerIds : [],
    batches: Array.isArray(state.batches) ? state.batches : [],
    activeBatchId: state.activeBatchId || null,
    lastError: state.lastError || null,
    updatedAt: state.updatedAt || null,
  };
}

function writeIncrementalState(reviewDir, state) {
  const clean = { version: 1, ...state, updatedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(reviewDir, FILES.incrementalState), clean);
  return clean;
}

function batchIsTerminalHold(batch) {
  return ['completed', 'failed', 'ready_for_review'].includes(batch?.state);
}

function batchMarkerFresh(batch, markerById) {
  if (!Array.isArray(batch?.markers)) return false;
  return batch.markers.every(item => {
    const marker = markerById.get(item.id);
    return marker && marker.contentHash === item.contentHash;
  });
}

function createBatchSnapshot(config, batchId, batchMarkers, now) {
  const reviewDir = config.reviewDir;
  const batchDir = path.join(reviewDir, 'codex_batches', batchId);
  fs.mkdirSync(batchDir, { recursive: true });
  const commentsSnapshotFile = path.join(batchDir, 'comments.json');
  const timelineSnapshotFile = path.join(batchDir, 'timeline.json');
  const reviewConfigSnapshotFile = path.join(batchDir, 'preview_review_config.json');
  const batchManifestFile = path.join(batchDir, 'batch.json');
  const activeComments = readJson(path.join(reviewDir, 'preview_comments.json'), { version: 1, markers: [] });
  const wanted = new Set(batchMarkers.map(marker => marker.id));
  const commentsSnapshot = { ...activeComments, markers: (activeComments.markers || []).filter(marker => wanted.has(marker.id)) };
  const timelineSnapshot = readJson(path.join(reviewDir, 'preview_timeline.json'), { version: 1, clips: [] });
  const reviewConfig = readReviewConfig(reviewDir);
  writeJsonAtomic(commentsSnapshotFile, commentsSnapshot);
  writeJsonAtomic(timelineSnapshotFile, timelineSnapshot);
  writeJsonAtomic(reviewConfigSnapshotFile, reviewConfig);
  const previewPath = previewVideoPath(config);
  const manifest = {
    version: 1,
    batchId,
    state: 'queued',
    queuedAt: now,
    reviewDir,
    batchDir,
    commentsSnapshotFile,
    timelineSnapshotFile,
    reviewConfigSnapshotFile,
    batchManifestFile,
    outputDir: path.join(batchDir, 'output'),
    markers: batchMarkers.map(marker => ({ id: marker.id, contentHash: marker.contentHash, previewTime: marker.previewTime, comment: marker.comment })),
    markerRevisions: batchMarkers.map(marker => ({ id: marker.id, contentHash: marker.contentHash })),
    basePreviewPath: previewPath,
    basePreviewSha256: previewPath ? fileSha256(previewPath) : null,
    baseEdlHash: fileSha256(path.join(reviewDir, 'review_edit_plan.json')) || hashJson(timelineSnapshot),
    timelineHash: hashJson(timelineSnapshot),
    reviewConfigHash: hashJson(reviewConfig),
  };
  writeJsonAtomic(batchManifestFile, manifest);
  return manifest;
}

function refreshIncrementalQueue(config, options = {}) {
  const reviewDir = config.reviewDir;
  const comments = readJson(path.join(reviewDir, 'preview_comments.json'), { markers: [] });
  const activeMarkers = (Array.isArray(comments?.markers) ? comments.markers : [])
    .filter(marker => marker && marker.id)
    .map(marker => ({ ...marker, contentHash: markerFingerprint(marker) }));
  const eligibleMarkers = activeMarkers.filter(marker => String(marker.comment || '').trim() && !marker.resolved);
  let state = readIncrementalState(reviewDir);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const markerById = new Map(eligibleMarkers.map(marker => [marker.id, marker]));
  const heldFresh = new Set();
  state.batches = state.batches.map(batch => {
    if (!Array.isArray(batch.markers)) return batch;
    const fresh = batchMarkerFresh(batch, markerById);
    if (!fresh && !['stale', 'superseded', 'cancelled'].includes(batch.state)) {
      return { ...batch, state: 'stale', staleAt: now, reason: 'marker_deleted_resolved_or_edited_after_batch_snapshot' };
    }
    if (fresh && !['stale', 'superseded', 'cancelled'].includes(batch.state)) {
      // completed/ready_for_review/queued/running/failed all hold their exact marker revision;
      // failed batches stay held until an explicit retry path is added or the marker changes.
      for (const item of batch.markers) heldFresh.add(`${item.id}:${item.contentHash}`);
    }
    return batch;
  });
  const queuedFreshIds = new Set(state.pendingMarkerIds.filter(id => markerById.has(id)));
  const eligible = eligibleMarkers
    .filter(marker => options.reviewedToHere == null || Number(marker.previewTime || 0) <= Number(options.reviewedToHere) + 0.001)
    .filter(marker => !heldFresh.has(`${marker.id}:${marker.contentHash}`));
  for (const marker of eligible) queuedFreshIds.add(marker.id);
  let pending = [...queuedFreshIds].filter(id => markerById.has(id) && !heldFresh.has(`${id}:${markerById.get(id).contentHash}`));
  pending.sort((a, b) => Number(markerById.get(a).previewTime || 0) - Number(markerById.get(b).previewTime || 0));
  // Legacy reviewedToHere/flushOne requests remain compatible, but are never required.
  if (options.flushOne || options.reviewedToHere != null) state.flushPending = true;
  const shouldFlushOne = state.flushPending;
  const deadline = Date.parse(state.debounceUntil || '');
  const debounceActive = Number.isFinite(deadline) && deadline > nowDate.getTime();
  const current = readJson(path.join(reviewDir, FILES.status), {});
  const workerBusy = ['queued', 'running'].includes(current.state) && isAlive(current.pid);
  const mayBatch = !workerBusy && (!debounceActive || options.debounceDue === true || shouldFlushOne);
  // Pairs start as soon as saved. Only an end-of-review signal flushes a singleton.
  // Persist the flush request when a worker is busy so the last comment is not stranded.
  while (mayBatch && (pending.length >= MAX_BATCH_SIZE || (shouldFlushOne && pending.length))) {
    const ids = pending.splice(0, MAX_BATCH_SIZE);
    const batchMarkers = ids.map(id => markerById.get(id));
    const batchId = `batch-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    state.batches.push(createBatchSnapshot(config, batchId, batchMarkers, now));
  }
  state.pendingMarkerIds = pending;
  if (!pending.length) state.flushPending = false;
  if (!pending.length && !debounceActive) state.debounceUntil = null;
  if (options.reviewedToHere != null) state.reviewedToHere = Number(options.reviewedToHere);
  return writeIncrementalState(reviewDir, state);
}

const debounceTimers = new Map();
function scheduleIncrementalBatch(config, options = {}) {
  const key = path.resolve(config.reviewDir);
  if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key));
  const debounceMs = Number.isFinite(Number(options.debounceMs)) ? Math.max(0, Number(options.debounceMs)) : 0;
  const deadline = new Date(Date.now() + debounceMs).toISOString();
  let state = readIncrementalState(config.reviewDir);
  state.debounceUntil = deadline;
  writeIncrementalState(config.reviewDir, state);
  state = refreshIncrementalQueue(config, options);
  if (debounceMs === 0) {
    debounceTimers.delete(key);
    try { return startNextIncrementalBatch(config, { spawnImpl: options.spawnImpl }).incremental; }
    catch (error) { return writeIncrementalState(config.reviewDir, { ...readIncrementalState(config.reviewDir), lastError: error.message }); }
  }
  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    try { refreshIncrementalQueue(config, { ...options, debounceDue: true }); startNextIncrementalBatch(config, { spawnImpl: options.spawnImpl }); }
    catch (error) { writeIncrementalState(config.reviewDir, { ...readIncrementalState(config.reviewDir), lastError: error.message }); }
  }, debounceMs);
  timer.unref?.();
  debounceTimers.set(key, timer);
  return state;
}

function setIncrementalPaused(reviewDir, paused) {
  const state = readIncrementalState(reviewDir);
  state.paused = Boolean(paused);
  return writeIncrementalState(reviewDir, state);
}

function recoverIncrementalState(config) {
  const status = publicStatus(config.reviewDir);
  let state = readIncrementalState(config.reviewDir);
  const runningAlive = status.state === 'running' && isAlive(status.pid);
  if (!runningAlive) {
    state.batches = state.batches.map(batch => batch.state === 'running' ? { ...batch, state: 'failed', failedAt: new Date().toISOString(), error: 'coordinator_recovered_dead_process' } : batch);
    state.activeBatchId = null;
    state = writeIncrementalState(config.reviewDir, state);
  }
  return state;
}

function validateBatchResult(resultFile, batch) {
  const result = readJson(resultFile, null);
  if (!result || typeof result !== 'object') return { ok: false, error: 'worker_exit_0_without_structured_result' };
  if (batch?.batchId && result.batchId && result.batchId !== batch.batchId) return { ok: false, error: 'structured_result_batch_id_mismatch' };
  const items = Array.isArray(result.items) ? result.items : [];
  const itemIds = new Set(items.map(item => item.markerId).filter(Boolean));
  for (const marker of batch.markers || []) {
    if (!itemIds.has(marker.id)) return { ok: false, error: `structured_result_missing_marker_${marker.id}` };
  }
  const outputPaths = [];
  if (typeof result.outputPreview === 'string') outputPaths.push(result.outputPreview);
  if (typeof result.resultPage === 'string') outputPaths.push(result.resultPage);
  for (const item of items) {
    if (typeof item.outputFile === 'string') outputPaths.push(item.outputFile);
    if (typeof item.outputPreview === 'string') outputPaths.push(item.outputPreview);
    if (typeof item.resultPage === 'string') outputPaths.push(item.resultPage);
  }
  const realOutputs = outputPaths.map(file => path.resolve(file)).filter(file => fs.existsSync(file));
  if (!realOutputs.length) return { ok: false, error: 'structured_result_has_no_existing_output_path' };
  return { ok: true, result, realOutputs };
}

function createCallbackConfig({ threadId, codexBin, workspaceDir, projectDir, reviewDir, previous = null, model, reasoningEffort }) {
  const enabled = Boolean(codexBin && fs.existsSync(codexBin));
  const configuredModel = model ?? previous?.model;
  const configuredReasoningEffort = reasoningEffort ?? previous?.reasoningEffort;
  return {
    version: 2,
    enabled,
    disabledReason: enabled ? null : '未找到 Codex CLI',
    token: previous?.token || makeToken(),
    threadId: threadId || null,
    codexBin: codexBin || null,
    workspaceDir: path.resolve(workspaceDir),
    projectDir: path.resolve(projectDir),
    reviewDir: path.resolve(reviewDir),
    ...(configuredModel ? { model: configuredModel } : {}),
    ...(configuredReasoningEffort ? { reasoningEffort: configuredReasoningEffort } : {}),
    preparedAt: new Date().toISOString(),
  };
}

function buildPrompt(config, markerCount, inputs = {}) {
  const comments = inputs.comments || path.join(config.reviewDir, 'preview_comments.json');
  const timeline = inputs.timeline || path.join(config.reviewDir, 'preview_timeline.json');
  const result = inputs.result || path.join(config.reviewDir, 'codex_callback_result.json');
  const submissionId = inputs.submissionId || 'unknown';
  const batchId = inputs.batchId || null;
  const reviewConfig = path.join(config.reviewDir, 'preview_review_config.json');
  const packets = path.join(config.reviewDir, 'preview_edit_packets.json');
  return `# Preview 批注网页回调：执行精剪

用户已在 Preview 批注网页${batchId ? `保存建议，系统自动形成增量批次 ${batchId}` : '保存修改建议，系统自动启动处理'}。你是本次局部精剪的独立执行器；不要要求用户复制清单或重新描述问题。

## 必须读取的真实文件

- 项目目录：${config.projectDir}
- 批注目录：${config.reviewDir}
- 本批不可变批注 JSON（${markerCount} 条，只包含本批）：${comments}
- 本批冻结的非破坏试剪时间线：${timeline}
- 本批目录：${batchId ? path.join(config.reviewDir, 'codex_batches', batchId) : path.join(config.reviewDir, 'codex_runs', submissionId)}
- Preview→原片映射：${reviewConfig}
- 处理包输出位置：${packets}
- 本次结构化结果：${result}

## 执行要求

1. 完整读取“AI剪口播” skill 及 Preview 双窗口规范，再读取上述 JSON；不要把窗口机械当作删除范围。
2. 先生成或更新 preview_edit_packets.json。全局批注必须感知完整逐字稿、全片重复和结构关系，再决定删除、修改建议或移动位置。
   本次只处理上面列出的不可变批注/时间线快照；活动文件可能正在接收下一批批注，禁止覆盖或清空活动 preview_comments.json。批次不足全片批准时，只生成局部 edit proposal/逐块审核对象，不得从局部批准直接完整重渲染全片。
3. 只在本批目录输出局部结果：短局部 review clips、edit proposal、结构化验收和可打开的本地结果链接；禁止改活动 review HTML/config/comments/video、共享 EDL、播放器媒体或全片发布文件。回到原始素材和冻结 EDL/PTS 重建局部片段，不要在低清 Preview 上二次碎切。保护字头字尾，避免长气口、吞字、爆音和不自然跳接。
4. 用户明确指出录制过程废话（例如“OK”“开始”“可以了”等拍摄 cue）时，本轮删除；后续 Preview 初剪也要在明确属于拍摄指令时提前清理。
5. 输出本批局部低清 review clips（每条约 10 秒，覆盖修改点和邻接语境）和本批结果页/清单，默认复用源 PTS 与未改动音频；有字幕/贴纸/B-roll 时只作用于本批输出。不得替换当前播放器媒体，不得生成流程二完整视频，不得把局部通过冒充全片通过。完成局部完整解码与关键接缝复核；不要启动或重启本地服务。
6. 完成前必须写入“本次结构化结果”JSON，把每条 marker 关联到实际处理、输出文件和验收证据。至少包含：
   version、submissionId（固定为 ${submissionId}）、batchId（${batchId || 'manual'}）、completedAt、inputPreview、outputPreview 或 resultPage,
   items[{markerId,comment,status,action,outputFile,evidence}]、filesChanged[]、qa[]、preferenceCandidates[]。
   每个 marker 必须有对应 item 和真实存在的 outputFile/outputPreview/resultPage；退出码 0 但没有有效结构化结果仍视为失败。status 只能是 implemented、not_changed 或 blocked；不确定时写明证据不足，禁止伪造已修改。
   对不改时长、不改音轨的字幕/贴纸/B-roll 新增效果，同时在 item.apply 返回 {mode:"ass_overlay",audio:"unchanged",assFile:"本批仅含新增效果的绝对ASS路径",group:"同一位置的替代版本共用稳定组名",fontsDir:"字体目录"}。ASS 使用原始完整 Preview 时间轴，仅含 header/styles 和本条新增 Dialogue，不重复烧基准字幕；以基准视频验证同样效果。所有素材位于本批目录。网页收到用户“通过并应用”后由确定性合成器从原基准全片烧已通过效果、原音轨copy；本worker仍只做局部产物，不操作验收状态。改时长/替换基准内容的修改不得伪装为该类型。
7. 完成后在最终回复中报告结果、视频路径和新版批注网址；网页会自动显示这条最终回复。若确实无法安全决定某个全局移动位置，保守处理并在回复中说明，不要伪造内容。

## 网页实时进度

执行过程中必须主动输出简短进度消息，让网页能持续反馈。进入每个阶段时各输出一次，格式固定为“进度 X/4：一句人话说明”，每条不超过 80 字：

- 进度 1/4：读取批注、逐字稿和现有时间线
- 进度 2/4：完成全局理解并确定精剪方案
- 进度 3/4：从原片重建和渲染新版 Preview
- 进度 4/4：完整解码、音画与接缝验收，生成新版批注页
`;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function isAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (_) { return false; }
}

function commandLabel(command = '') {
  const text = String(command).toLowerCase();
  if (/prepare_preview_review|serve_preview_review|preview_review_server|curl .*api\/config|\bopen\b/.test(text)) return '正在生成或检查新版批注网页';
  if (/run_transcribe|volcengine|subtitles_words|独立asr/.test(text)) return '正在用独立转录复核剪辑结果';
  if (/build_preview_edit_packets/.test(text)) return '正在生成批注处理包';
  if (/ffprobe|show_entries|show_streams/.test(text)) return '正在核对视频规格与音画同步';
  if (/ffmpeg|render_.*revision|render_approved/.test(text)) return '正在从原片渲染或检查新版视频';
  if (/build_.*revision|comment-edl|edit-summary|timeline/.test(text)) return '正在生成精剪时间线';
  if (/\b(jq|rg|sed|find|cat)\b/.test(text)) return '正在读取逐字稿、素材和剪辑数据';
  return '正在执行精剪步骤';
}

function commandStage(command = '') {
  const text = String(command).toLowerCase();
  if (/freezedetect|framemd5|astats|contact[_-]?sheet|tail[_-]contact|prepare_preview_review|serve_preview_review|preview_review_server/.test(text)) return 4;
  if (/(ffmpeg|render_[^\s]*)/.test(text) && /preview|render|output|最终成片|成片/.test(text)) return 3;
  if (/build_preview_edit_packets|preview_edit_packets|build_broll|edit[_-]?plan|精剪方案/.test(text)) return 2;
  return null;
}

function safeMessage(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

function extractProgress(logText, status = {}, now = Date.now()) {
  const running = new Map();
  const activity = [];
  const messages = [];
  let inferredStep = null;
  for (const line of String(logText || '').split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); }
    catch (_) { continue; }
    const item = event?.item || {};
    if (event.type === 'item.started' && item.type === 'command_execution') {
      const label = commandLabel(item.command);
      const observedStage = commandStage(item.command);
      if (observedStage) inferredStep = Math.max(inferredStep || 0, observedStage);
      running.set(item.id || `command-${running.size}`, label);
      activity.push({ kind: 'work', text: label, state: 'running' });
    }
    if (event.type === 'item.completed' && item.type === 'command_execution') {
      const observedStage = commandStage(item.command);
      if (observedStage) inferredStep = Math.max(inferredStep || 0, observedStage);
      running.delete(item.id);
      const label = commandLabel(item.command);
      activity.push({ kind: 'work', text: `${item.exit_code === 0 ? '已完成' : '步骤返回异常'}：${label.replace(/^正在/, '')}`, state: item.exit_code === 0 ? 'done' : 'warning' });
    }
    if (event.type === 'item.completed' && item.type === 'agent_message') {
      const text = safeMessage(item.text);
      if (text) { messages.push(text); activity.push({ kind: 'message', text, state: 'info' }); }
    }
  }
  const latestMessage = messages.at(-1) || '';
  let step = null, totalSteps = null;
  for (const message of [...messages].reverse()) {
    const match = message.match(/进度\s*(\d+)\s*\/\s*(\d+)/);
    if (match) { step = Number(match[1]); totalSteps = Number(match[2]); break; }
  }
  if (inferredStep) {
    step = Math.max(step || 0, inferredStep);
    totalSteps = Math.max(totalSteps || 0, 4);
  }
  const started = Date.parse(status.startedAt || status.queuedAt || '');
  const elapsedSeconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  const current = [...running.values()].at(-1)
    || (status.state === 'completed' ? '精剪已经完成' : status.state === 'failed' ? '精剪执行失败' : latestMessage || '正在启动并读取批注');
  const compact = [];
  for (const entry of activity.slice().reverse()) {
    if (!compact.some(existing => existing.text === entry.text)) compact.push(entry);
    if (compact.length >= 6) break;
  }
  compact.reverse();
  return { step, totalSteps, current, latestMessage, elapsedSeconds, activity: compact };
}

function publicStatus(reviewDir) {
  const file = path.join(reviewDir, FILES.status);
  const status = readJson(file, { state: 'idle', updatedAt: null });
  if (status.state === 'running' && !isAlive(status.pid)) {
    status.state = 'failed';
    status.error = status.error || 'Codex 进程已结束，但没有写入完成状态';
    status.finishedAt = status.finishedAt || new Date().toISOString();
    status.updatedAt = status.finishedAt;
    writeJsonAtomic(file, status);
    if (status.runStatusFile) writeJsonAtomic(status.runStatusFile, status);
  }
  const lastFile = status.lastMessageFile || path.join(reviewDir, FILES.lastMessage);
  const lastMessage = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8').slice(0, 12000) : '';
  const logFile = status.logFile || path.join(reviewDir, FILES.log);
  let progress = extractProgress('', status);
  if (fs.existsSync(logFile)) {
    const log = fs.readFileSync(logFile, 'utf8');
    const latestActivityAt = fs.statSync(logFile).mtime.toISOString();
    progress = { ...extractProgress(log, status), latestActivityAt };
  }
  return { ...status, lastMessage, progress };
}

function startCodexJob(config, { spawnImpl = spawn, batch = null } = {}) {
  if (!config?.enabled) throw new Error(config?.disabledReason || 'Codex 回调未启用');
  const requestedModel = config.model || 'gpt-6.1-sol';
  const requestedReasoningEffort = config.reasoningEffort || 'high';
  const current = publicStatus(config.reviewDir);
  if ((current.state === 'queued' || current.state === 'running') && isAlive(current.pid)) {
    const error = new Error('已有 Codex 精剪任务正在执行');
    error.code = 'JOB_RUNNING';
    throw error;
  }

  const commentsFile = path.join(config.reviewDir, 'preview_comments.json');
  const activeComments = readJson(commentsFile, { markers: [] });
  let comments = activeComments;
  let timelineSnapshotSource = readJson(path.join(config.reviewDir, 'preview_timeline.json'), { version: 1, clips: [] });
  let reviewConfigSnapshotSource = readReviewConfig(config.reviewDir);
  if (batch && Array.isArray(batch.markers)) {
    comments = readJson(batch.commentsSnapshotFile, null);
    timelineSnapshotSource = readJson(batch.timelineSnapshotFile, timelineSnapshotSource);
    reviewConfigSnapshotSource = readJson(batch.reviewConfigSnapshotFile, reviewConfigSnapshotSource);
    if (!comments) {
      const wanted = new Map(batch.markers.map(item => [item.id, item.contentHash]));
      comments = { ...activeComments, markers: (activeComments.markers || []).filter(marker => wanted.get(marker.id) === markerFingerprint(marker)) };
    }
    const wanted = new Map(batch.markers.map(item => [item.id, item.contentHash]));
    const currentMarkerById = new Map((activeComments.markers || []).map(marker => [marker.id, { ...marker, contentHash: markerFingerprint(marker) }]));
    if ([...wanted].some(([id, hash]) => currentMarkerById.get(id)?.contentHash !== hash || currentMarkerById.get(id)?.resolved)) {
      const error = new Error('批注已被删除、解决或编辑，旧批次已过期');
      error.code = 'BATCH_STALE';
      throw error;
    }
  }
  const markerCount = Array.isArray(comments?.markers) ? comments.markers.length : 0;
  if (!markerCount) throw new Error('还没有已保存的批注，不能提交精剪');

  const submissionId = `codex-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const statusFile = path.join(config.reviewDir, FILES.status);
  const latestPromptFile = path.join(config.reviewDir, FILES.prompt);
  const latestLogFile = path.join(config.reviewDir, FILES.log);
  const latestMessageFile = path.join(config.reviewDir, FILES.lastMessage);
  const runDir = path.join(config.reviewDir, 'codex_runs', submissionId);
  fs.mkdirSync(runDir, { recursive: true });
  const promptFile = path.join(runDir, 'prompt.md');
  const logFile = path.join(runDir, 'events.jsonl');
  const lastMessageFile = path.join(runDir, 'final.md');
  const resultFile = path.join(runDir, 'result.json');
  const runStatusFile = path.join(runDir, 'status.json');
  const commentsSnapshotFile = path.join(runDir, 'comments.json');
  const timelineSnapshotFile = path.join(runDir, 'timeline.json');
  writeJsonAtomic(commentsSnapshotFile, comments);
  writeJsonAtomic(timelineSnapshotFile, timelineSnapshotSource);
  writeJsonAtomic(path.join(runDir, 'preview_review_config.json'), reviewConfigSnapshotSource);
  const prompt = buildPrompt(config, markerCount, {
    comments: commentsSnapshotFile,
    timeline: timelineSnapshotFile,
    result: resultFile,
    submissionId,
    batchId: batch?.batchId || null,
  });
  fs.writeFileSync(promptFile, prompt);
  fs.writeFileSync(latestPromptFile, prompt);
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(latestLogFile, '');
  fs.writeFileSync(lastMessageFile, '');
  fs.writeFileSync(latestMessageFile, '');

  const writeStatus = status => {
    writeJsonAtomic(statusFile, status);
    writeJsonAtomic(runStatusFile, status);
  };

  const queuedAt = new Date().toISOString();
  writeStatus({
    version: 1, submissionId, batchId: batch?.batchId || null, state: 'queued', markerCount, queuedAt, updatedAt: queuedAt,
    requestedModel, requestedReasoningEffort,
    runDir, runStatusFile, promptFile, logFile, lastMessageFile, resultFile,
    commentsSnapshotFile, timelineSnapshotFile,
  });

  // Codex desktop owns an active writer for the originating thread. A second
  // `exec resume <thread>` is rejected by the thread store, so callbacks run in
  // an isolated ephemeral worker and stream the final result back to this page.
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-C', config.projectDir];
  if (path.resolve(config.workspaceDir) !== path.resolve(config.projectDir)) args.push('--add-dir', config.workspaceDir);
  args.push('--model', requestedModel, '-c', `model_reasoning_effort=${JSON.stringify(requestedReasoningEffort)}`,
    '--sandbox', 'workspace-write', '--json', '-o', lastMessageFile, '-');
  const child = spawnImpl(config.codexBin, args, {
    cwd: config.projectDir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const append = chunk => {
    fs.appendFileSync(logFile, chunk);
    fs.appendFileSync(latestLogFile, chunk);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.stdin?.end(prompt);

  const startedAt = new Date().toISOString();
  writeStatus({
    version: 1, submissionId, batchId: batch?.batchId || null, state: 'running', markerCount, pid: child.pid || null,
    requestedModel, requestedReasoningEffort,
    queuedAt, startedAt, updatedAt: startedAt, runDir, runStatusFile,
    promptFile, logFile, lastMessageFile, resultFile, commentsSnapshotFile, timelineSnapshotFile,
  });

  let finished = false;
  const finish = (state, details = {}) => {
    if (finished) return;
    finished = true;
    const finishedAt = new Date().toISOString();
    const latest = readJson(statusFile, {});
    const complete = { ...latest, ...details, state, finishedAt, updatedAt: finishedAt };
    writeStatus(complete);
  };
  child.on('error', error => finish('failed', { error: error.message }));
  child.on('close', (code, signal) => {
    if (fs.existsSync(lastMessageFile)) fs.copyFileSync(lastMessageFile, latestMessageFile);
    let error = null;
    if (code !== 0) {
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      const activeWriter = log.match(/already has an active writer/i);
      const detail = log.split(/\r?\n/).map(line => line.trim()).filter(Boolean).findLast(line => /^Error:/.test(line));
      error = activeWriter
        ? '当前 Codex 任务正被桌面版占用，不能同时续写；请刷新页面后重试，系统将改用独立精剪执行器'
        : detail || `Codex 退出码 ${code ?? 'unknown'}`;
    }
    let finalState = code === 0 ? 'completed' : 'failed';
    let resultCheck = null;
    if (batch?.batchId) {
      const activeComments = readJson(commentsFile, { markers: [] });
      const currentMarkerById = new Map((activeComments.markers || []).filter(marker => marker && marker.id && String(marker.comment || '').trim() && !marker.resolved).map(marker => [marker.id, { ...marker, contentHash: markerFingerprint(marker) }]));
      const stillFresh = batchMarkerFresh(batch, currentMarkerById);
      resultCheck = code === 0 ? validateBatchResult(resultFile, batch) : null;
      if (!stillFresh) {
        finalState = 'stale';
        error = error || 'batch_input_changed_before_worker_finished';
      } else if (code === 0 && !resultCheck.ok) {
        finalState = 'failed';
        error = resultCheck.error;
      }
      const inc = readIncrementalState(config.reviewDir);
      inc.batches = inc.batches.map(item => {
        if (item.batchId !== batch.batchId) return item;
        if (item.state === 'stale' && finalState === 'completed') return { ...item, submissionId, finishedAt: new Date().toISOString(), resultFile, runDir, preservedWorkerState: 'completed_after_stale' };
        return { ...item, state: finalState, submissionId, finishedAt: new Date().toISOString(), resultFile, runDir, error, outputPaths: resultCheck?.realOutputs || [] };
      });
      inc.activeBatchId = inc.activeBatchId === batch.batchId ? null : inc.activeBatchId;
      writeIncrementalState(config.reviewDir, inc);
    }
    finish(finalState === 'completed' ? 'completed' : 'failed', {
      exitCode: Number.isInteger(code) ? code : null,
      signal: signal || null,
      error,
      resultRecorded: fs.existsSync(resultFile),
    });
    // A failed/stale revision stays recorded; it must not strand unrelated comments.
    if (batch?.batchId) setImmediate(() => {
      try { startNextIncrementalBatch(config, { spawnImpl }); }
      catch (error) { writeIncrementalState(config.reviewDir, { ...readIncrementalState(config.reviewDir), lastError: error.message }); }
    });
  });
  child.unref?.();
  return publicStatus(config.reviewDir);
}


function startNextIncrementalBatch(config, { spawnImpl = spawn } = {}) {
  recoverIncrementalState(config);
  let state = refreshIncrementalQueue(config);
  if (state.paused) return { ...publicStatus(config.reviewDir), incremental: state };
  const current = publicStatus(config.reviewDir);
  if ((current.state === 'queued' || current.state === 'running') && isAlive(current.pid)) return { ...current, incremental: state };
  const batch = state.batches.find(item => item.state === 'queued');
  if (!batch) return { ...current, incremental: state };
  state.activeBatchId = batch.batchId;
  state.batches = state.batches.map(item => item.batchId === batch.batchId ? { ...item, state: 'running', startedAt: new Date().toISOString() } : item);
  writeIncrementalState(config.reviewDir, state);
  try {
    const status = startCodexJob(config, { spawnImpl, batch });
    return { ...status, incremental: readIncrementalState(config.reviewDir) };
  } catch (error) {
    state = readIncrementalState(config.reviewDir);
    state.activeBatchId = null;
    state.batches = state.batches.map(item => item.batchId === batch.batchId ? { ...item, state: error.code === 'BATCH_STALE' ? 'stale' : 'failed', error: error.message, finishedAt: new Date().toISOString() } : item);
    writeIncrementalState(config.reviewDir, state);
    throw error;
  }
}

module.exports = { FILES, makeToken, createCallbackConfig, buildPrompt, commandLabel, extractProgress, publicStatus, startCodexJob, isAlive, markerFingerprint, readIncrementalState, refreshIncrementalQueue, scheduleIncrementalBatch, setIncrementalPaused, startNextIncrementalBatch, recoverIncrementalState, validateBatchResult, previewVideoPath };
