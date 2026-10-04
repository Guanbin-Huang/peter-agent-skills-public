#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const timelineLogic = require('./preview_timeline');
const codexCallback = require('./codex_callback');
const previewCover = require('./preview_cover');
const previewApply = require('./preview_apply');

const PORT = Number(process.argv[2] || 8910);
const VIDEO_FILE = process.argv[3] ? path.resolve(process.argv[3]) : null;
const ROOT = process.cwd();
const COMMENTS_FILE = path.join(ROOT, 'preview_comments.json');
const CONFIG_FILE = path.join(ROOT, 'preview_review_config.json');
const TIMELINE_FILE = path.join(ROOT, 'preview_timeline.json');
const REVIEW_BLOCKS_FILE = path.join(ROOT, 'review_blocks.json');
const CODEX_CALLBACK_CONFIG_FILE = path.join(ROOT, codexCallback.FILES.config);
const MAX_BODY = 2 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function validatePayload(payload) {
  if (!payload || !Array.isArray(payload.markers)) throw new Error('markers 必须是数组');
  if (payload.markers.length > 2000) throw new Error('批注数量超过 2000 条');
  const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  return {
    version: 1,
    video: String(payload.video || '').slice(0, 300),
    updatedAt: new Date().toISOString(),
    markers: payload.markers.map((marker, index) => {
      const previewTime = Math.max(0, numberOr(marker.previewTime, 0));
      const reviewBefore = clamp(numberOr(marker.reviewBefore, 6), 0, 20);
      const reviewAfter = clamp(numberOr(marker.reviewAfter, 4), 0, 20);
      const actionBefore = clamp(numberOr(marker.actionBefore, numberOr(marker.scopeBefore, 3)), 0, 20);
      const actionAfter = clamp(numberOr(marker.actionAfter, numberOr(marker.scopeAfter, 3)), 0, 20);
      const reviewPreviewStart = Math.max(0, numberOr(marker.reviewPreviewStart, previewTime - reviewBefore));
      const reviewPreviewEnd = Math.max(reviewPreviewStart, numberOr(marker.reviewPreviewEnd, previewTime + reviewAfter));
      const actionPreviewStart = Math.max(0, numberOr(marker.actionPreviewStart, numberOr(marker.scopePreviewStart, previewTime - actionBefore)));
      const actionPreviewEnd = Math.max(actionPreviewStart, numberOr(marker.actionPreviewEnd, numberOr(marker.scopePreviewEnd, previewTime + actionAfter)));
      const cleanRanges = ranges => Array.isArray(ranges) ? ranges.slice(0, 100).map(range => ({
        previewStart: Math.max(0, numberOr(range.previewStart, 0)),
        previewEnd: Math.max(0, numberOr(range.previewEnd, 0)),
        sourceStart: Math.max(0, numberOr(range.sourceStart, 0)),
        sourceEnd: Math.max(0, numberOr(range.sourceEnd, 0)),
      })).filter(range => range.previewEnd >= range.previewStart && range.sourceEnd >= range.sourceStart) : [];
      const reviewSourceRanges = cleanRanges(marker.reviewSourceRanges);
      const actionSourceRanges = cleanRanges(marker.actionSourceRanges || marker.sourceRanges);
      const scopeMode = marker.scopeMode === 'global' || marker.global === true ? 'global' : 'local';
      return {
        id: String(marker.id || `marker-${index}`).slice(0, 120),
        previewTime,
        sourceTime: Number.isFinite(Number(marker.sourceTime)) ? Math.max(0, Number(marker.sourceTime)) : null,
        category: String(marker.category || '其他').slice(0, 40),
        comment: String(marker.comment || '').slice(0, 4000),
        scopeMode,
        global: scopeMode === 'global',
        reviewBefore, reviewAfter, reviewPreviewStart, reviewPreviewEnd, reviewSourceRanges,
        actionBefore, actionAfter, actionPreviewStart, actionPreviewEnd, actionSourceRanges,
        // 兼容旧消费者：scope/sourceRanges 表示处理窗口；window 表示回顾循环窗口。
        scopeBefore: actionBefore, scopeAfter: actionAfter,
        scopePreviewStart: actionPreviewStart, scopePreviewEnd: actionPreviewEnd,
        sourceRanges: actionSourceRanges,
        windowBefore: reviewBefore, windowAfter: reviewAfter,
        resolved: Boolean(marker.resolved),
        createdAt: marker.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }),
  };
}

function validateTimelinePayload(payload) {
  if (!payload || !Array.isArray(payload.clips)) throw new Error('clips 必须是数组');
  if (payload.clips.length > 2000) throw new Error('片段数量超过 2000 条');
  const sourceDuration = Number(payload.sourceDuration);
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || sourceDuration > 24 * 60 * 60) throw new Error('sourceDuration 无效');
  const clips = timelineLogic.normalizeClips(payload.clips, sourceDuration);
  if (!clips.length) throw new Error('时间线至少保留一个片段');
  if (clips.length !== payload.clips.length) throw new Error('存在无效或过短片段');
  for (let i = 1; i < clips.length; i += 1) {
    if (clips[i].sourceStart < clips[i - 1].sourceEnd - .001) throw new Error('片段不得重叠');
  }
  return {
    version: 1,
    video: String(payload.video || '').slice(0, 300),
    sourceDuration,
    updatedAt: new Date().toISOString(),
    clips,
  };
}

function validateReviewBlocksPayload(payload) {
  if (!payload || !Array.isArray(payload.blocks)) throw new Error('blocks 必须是数组');
  if (payload.blocks.length > 200) throw new Error('审核板块数量超过 200 条');
  const allowedStatus = new Set(['pending', 'approved', 'changes_requested']);
  return {
    version: 1,
    video: String(payload.video || '').slice(0, 300),
    updatedAt: new Date().toISOString(),
    blocks: payload.blocks.map((block, index) => ({
      id: String(block.id || `review-${index + 1}`).slice(0, 120),
      order: Math.max(1, Number(block.order) || index + 1),
      markerId: String(block.markerId || '').slice(0, 120),
      previewTime: Number.isFinite(Number(block.previewTime)) ? Math.max(0, Number(block.previewTime)) : null,
      sourceTime: Number.isFinite(Number(block.sourceTime)) ? Math.max(0, Number(block.sourceTime)) : null,
      originalComment: String(block.originalComment || '').slice(0, 4000),
      editSummary: String(block.editSummary || '').slice(0, 4000),
      clipUrl: String(block.clipUrl || '').slice(0, 500),
      clipDuration: Number.isFinite(Number(block.clipDuration)) ? Math.max(0, Number(block.clipDuration)) : null,
      status: allowedStatus.has(block.status) ? block.status : 'pending',
      reviewerComment: String(block.reviewerComment || '').slice(0, 4000),
      reviewerCommentTime: Number.isFinite(Number(block.reviewerCommentTime)) ? Math.max(0, Number(block.reviewerCommentTime)) : null,
      reviewedAt: block.reviewedAt ? String(block.reviewedAt).slice(0, 80) : null,
    })),
  };
}

function writeJsonAtomic(file, data) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}

function serveVideo(req, res, videoFile = VIDEO_FILE) {
  if (!videoFile || !fs.existsSync(videoFile)) {
    res.writeHead(404); res.end('Video not found'); return;
  }
  const stat = fs.statSync(videoFile);
  const type = MIME_TYPES[path.extname(videoFile).toLowerCase()] || 'video/mp4';
  const rangeHeader = req.headers.range;
  if (!rangeHeader) {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(videoFile).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return;
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= stat.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return;
  }
  res.writeHead(206, {
    'Content-Type': type,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(videoFile, { start, end }).pipe(res);
}


function readJsonBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        const error = new Error('请求体过大');
        error.code = 'TOO_LARGE';
        reject(error);
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function readCallbackOrSend(res) {
  const callback = readJson(CODEX_CALLBACK_CONFIG_FILE, null);
  if (!callback?.enabled) {
    sendJson(res, 503, { success: false, error: callback?.disabledReason || 'Codex 回调未配置' });
    return null;
  }
  return callback;
}

function validateCallbackToken(req, res, callback) {
  if (req.headers['x-codex-callback-token'] !== callback.token) {
    sendJson(res, 403, { success: false, error: 'Codex 回调令牌无效' });
    return false;
  }
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    sendJson(res, 415, { success: false, error: '只接受 JSON 请求' });
    return false;
  }
  return true;
}

function requireJson(req, res) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    sendJson(res, 415, { success: false, error: '只接受 JSON 请求' });
    return false;
  }
  return true;
}

function publicIncremental(state) {
  return { ...state, batches: (state.batches || []).map(batch => ({
    ...batch,
    outputUrls: ['completed', 'ready_for_review'].includes(batch.state) ? [...new Set((batch.outputPaths || []).flatMap(file => {
      try {
        // macOS /var and /private/var can name the same review directory.
        // Derive both containment and the served URL from canonical paths.
        const real = fs.realpathSync(path.resolve(file));
        const relative = path.relative(fs.realpathSync(ROOT), real);
        if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
          || !fs.statSync(real).isFile() || !/\.(mp4|mov|webm|html|png|jpg)$/i.test(real)) return [];
        return ['/' + relative.split(path.sep).map(encodeURIComponent).join('/')];
      } catch (_) { return []; }
    }))] : [],
  })) };
}

function createServer() {
  let coverBusy = false;
  const application = VIDEO_FILE && fs.existsSync(VIDEO_FILE) ? previewApply.createApplication({ root: ROOT, baseVideo: VIDEO_FILE }) : null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'GET' && url.pathname === '/video') return serveVideo(req, res);
    if (req.method === 'GET' && url.pathname.startsWith('/applied-video/')) {
      try { return serveVideo(req, res, application?.mediaFile(url.pathname.slice('/applied-video/'.length)) || ''); }
      catch (error) { return sendJson(res, 404, { error: error.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/edit-application') {
      try { return sendJson(res, 200, application ? application.status() : { state: 'idle', candidates: [], acceptedMarkerIds: [], job: null, activeVersion: null }); }
      catch (error) { return sendJson(res, 500, { error: error.message }); }
    }
    if (req.method === 'POST' && ['/api/edit-accept', '/api/edit-retry'].includes(url.pathname)) {
      const callback = readCallbackOrSend(res);
      if (!callback || !validateCallbackToken(req, res, callback)) return;
      if (!application) return sendJson(res, 503, { error: '原版视频尚未加载' });
      readJsonBody(req, 4096).then(payload => {
        const state = url.pathname === '/api/edit-accept' ? application.accept(payload) : application.retry();
        sendJson(res, 202, { success: true, ...state });
      }).catch(error => { if (!res.headersSent) sendJson(res, error.status || 400, { success: false, error: error.message }); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const config = readJson(CONFIG_FILE, {});
      const callback = readJson(CODEX_CALLBACK_CONFIG_FILE, { enabled: false, disabledReason: 'Codex 回调未配置' });
      return sendJson(res, 200, {
        ...config, videoUrl: '/video',
        codexCallbackEnabled: Boolean(callback.enabled),
        codexCallbackReason: callback.disabledReason || null,
        codexCallbackToken: callback.enabled ? callback.token : null,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/cover') {
      try { return sendJson(res, 200, { cover: previewCover.readCover(ROOT), design: previewCover.readCoverDesign(ROOT) }); }
      catch (error) { return sendJson(res, 500, { success: false, error: error.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/cover') {
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return sendJson(res, 415, { success: false, error: '只接受 JSON 请求' });
      if (coverBusy) return sendJson(res, 409, { success: false, error: '封面正在提取，请稍候' });
      coverBusy = true;
      readJsonBody(req, 4096).then(payload => previewCover.selectCover({
        root: ROOT, config: readJson(CONFIG_FILE, {}),
        previewTime: payload.previewTime, previewVideo: VIDEO_FILE,
      })).then(cover => sendJson(res, 200, { success: true, cover }))
        .catch(error => { if (!res.headersSent) sendJson(res, error.code === 'TOO_LARGE' ? 413 : 400, { success: false, error: error.message }); })
        .finally(() => { coverBusy = false; });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/cover/design') {
      if (!requireJson(req, res)) return;
      readJsonBody(req, 4096)
        .then(payload => previewCover.saveCoverDesign(ROOT, payload))
        .then(design => sendJson(res, 200, { success: true, design }))
        .catch(error => { if (!res.headersSent) sendJson(res, error.code === 'TOO_LARGE' ? 413 : 400, { success: false, error: error.message }); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/cover/candidates') {
      if (!requireJson(req, res)) return;
      if (coverBusy) return sendJson(res, 409, { success: false, error: '封面正在生成，请稍候' });
      coverBusy = true;
      readJsonBody(req, 4096)
        .then(payload => previewCover.generateCoverCandidates(ROOT, payload))
        .then(design => sendJson(res, 200, { success: true, design, candidates: design.candidates }))
        .catch(error => { if (!res.headersSent) sendJson(res, error.code === 'TOO_LARGE' ? 413 : 400, { success: false, error: error.message }); })
        .finally(() => { coverBusy = false; });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/cover/select-candidate') {
      if (!requireJson(req, res)) return;
      readJsonBody(req, 4096)
        .then(payload => previewCover.selectCoverCandidate(ROOT, payload.id))
        .then(design => sendJson(res, 200, { success: true, design, candidates: design.candidates }))
        .catch(error => { if (!res.headersSent) sendJson(res, error.code === 'TOO_LARGE' ? 413 : 400, { success: false, error: error.message }); });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/comments') {
      return sendJson(res, 200, readJson(COMMENTS_FILE, { version: 1, markers: [] }));
    }
    if (req.method === 'GET' && url.pathname === '/api/timeline') {
      return sendJson(res, 200, readJson(TIMELINE_FILE, { version: 1, sourceDuration: null, clips: [] }));
    }
    if (req.method === 'GET' && url.pathname === '/api/review-blocks') {
      return sendJson(res, 200, readJson(REVIEW_BLOCKS_FILE, { version: 1, blocks: [] }));
    }
    if (req.method === 'GET' && url.pathname === '/api/codex-status') {
      const callback = readJson(CODEX_CALLBACK_CONFIG_FILE, { enabled: false, disabledReason: 'Codex 回调未配置' });
      let status = codexCallback.publicStatus(ROOT);
      let incremental = codexCallback.readIncrementalState(ROOT);
      if (callback.enabled && !incremental.paused) {
        try {
          incremental = codexCallback.refreshIncrementalQueue(callback);
          status = codexCallback.startNextIncrementalBatch(callback);
          incremental = status.incremental || codexCallback.readIncrementalState(ROOT);
        } catch (error) {
          status = { ...status, error: error.message };
          incremental = codexCallback.readIncrementalState(ROOT);
        }
      }
      return sendJson(res, 200, {
        enabled: Boolean(callback.enabled),
        disabledReason: callback.disabledReason || null,
        ...status,
        incremental: publicIncremental(incremental),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/codex-submit') {
      const callback = readCallbackOrSend(res);
      if (!callback || !validateCallbackToken(req, res, callback)) return;
      readJsonBody(req, 4096).then(payload => {
        if (payload.confirmed !== true) throw new Error('必须由页面明确确认提交');
        const incremental = codexCallback.refreshIncrementalQueue(callback, { flushOne: true });
        const status = codexCallback.startNextIncrementalBatch(callback);
        sendJson(res, 202, { success: true, ...status, incremental });
      }).catch(error => {
        if (!res.headersSent) sendJson(res, error.code === 'JOB_RUNNING' ? 409 : error.code === 'TOO_LARGE' ? 413 : 400, { success: false, error: error.message });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/codex-pause') {
      const callback = readCallbackOrSend(res);
      if (!callback || !validateCallbackToken(req, res, callback)) return;
      readJsonBody(req, 4096).then(payload => {
        let state = codexCallback.setIncrementalPaused(ROOT, payload.paused !== false);
        if (!state.paused) state = codexCallback.scheduleIncrementalBatch(callback);
        sendJson(res, 200, { success: true, incremental: state });
      }).catch(error => { if (!res.headersSent) sendJson(res, error.code === 'TOO_LARGE' ? 413 : 400, { success: false, error: error.message }); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/review-finished') {
      const callback = readCallbackOrSend(res);
      if (!callback || !validateCallbackToken(req, res, callback)) return;
      readJsonBody(req, 4096).then(payload => {
        if (typeof payload.previewTime !== 'number' || !Number.isFinite(payload.previewTime) || payload.previewTime < 0) throw new Error('previewTime 无效');
        // End-of-playback is only a queue flush, never a whole-video approval.
        const incremental = codexCallback.scheduleIncrementalBatch(callback, { flushOne: true });
        sendJson(res, 200, { success: true, incremental: publicIncremental(incremental) });
      }).catch(error => { if (!res.headersSent) sendJson(res, 400, { success: false, error: error.message }); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/reviewed-to-here') {
      const callback = readCallbackOrSend(res);
      if (!callback || !validateCallbackToken(req, res, callback)) return;
      readJsonBody(req, 4096).then(payload => {
        const reviewedToHere = Number(payload.reviewedToHere);
        if (!Number.isFinite(reviewedToHere) || reviewedToHere < 0) throw new Error('reviewedToHere 无效');
        const incremental = codexCallback.refreshIncrementalQueue(callback, { reviewedToHere, flushOne: true });
        const status = codexCallback.startNextIncrementalBatch(callback);
        sendJson(res, 202, { success: true, ...status, incremental });
      }).catch(error => {
        if (!res.headersSent) sendJson(res, error.code === 'JOB_RUNNING' ? 409 : error.code === 'TOO_LARGE' ? 413 : 400, { success: false, error: error.message });
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/comments') {
      let body = '';
      let tooLarge = false;
      req.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_BODY) { tooLarge = true; req.destroy(); }
      });
      req.on('end', () => {
        if (tooLarge) return;
        try {
          const clean = validatePayload(JSON.parse(body));
          writeJsonAtomic(COMMENTS_FILE, clean);
          application?.refresh();
          const callback = readJson(CODEX_CALLBACK_CONFIG_FILE, null);
          let incremental = null;
          if (callback?.enabled) incremental = codexCallback.scheduleIncrementalBatch(callback);
          sendJson(res, 200, { success: true, updatedAt: clean.updatedAt, count: clean.markers.length, incremental });
        } catch (error) {
          sendJson(res, 400, { success: false, error: error.message });
        }
      });
      req.on('error', () => { if (!res.headersSent) sendJson(res, 413, { success: false, error: '请求体过大' }); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/timeline') {
      let body = '';
      let tooLarge = false;
      req.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_BODY) { tooLarge = true; req.destroy(); }
      });
      req.on('end', () => {
        if (tooLarge) return;
        try {
          const clean = validateTimelinePayload(JSON.parse(body));
          writeJsonAtomic(TIMELINE_FILE, clean);
          application?.refresh();
          sendJson(res, 200, { success: true, updatedAt: clean.updatedAt, count: clean.clips.length });
        } catch (error) {
          sendJson(res, 400, { success: false, error: error.message });
        }
      });
      req.on('error', () => { if (!res.headersSent) sendJson(res, 413, { success: false, error: '请求体过大' }); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/review-blocks') {
      let body = '';
      let tooLarge = false;
      req.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_BODY) { tooLarge = true; req.destroy(); }
      });
      req.on('end', () => {
        if (tooLarge) return;
        try {
          const clean = validateReviewBlocksPayload(JSON.parse(body));
          writeJsonAtomic(REVIEW_BLOCKS_FILE, clean);
          sendJson(res, 200, { success: true, updatedAt: clean.updatedAt, count: clean.blocks.length });
        } catch (error) {
          sendJson(res, 400, { success: false, error: error.message });
        }
      });
      req.on('error', () => { if (!res.headersSent) sendJson(res, 413, { success: false, error: '请求体过大' }); });
      return;
    }

    const requested = url.pathname === '/' ? 'preview_review.html' : decodeURIComponent(url.pathname.slice(1));
    if (Object.values(codexCallback.FILES).includes(requested)) { res.writeHead(404); res.end('Not Found'); return; }
    const filePath = path.resolve(ROOT, requested);
    if (!filePath.startsWith(ROOT + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    const stat = fs.statSync(filePath);
    if (/\.(mp4|mov|webm)$/i.test(filePath)) return serveVideo(req, res, filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': path.extname(filePath) === '.html' ? 'no-store' : 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
  let schedulerTimer;
  const recoverQueue = () => {
    application?.refresh();
    const callback = readJson(CODEX_CALLBACK_CONFIG_FILE, null);
    if (callback?.enabled) {
      try { codexCallback.startNextIncrementalBatch(callback); }
      catch (error) { console.error(`自动修改恢复失败：${error.message}`); }
    }
  };
  server.once('listening', () => {
    recoverQueue();
    // A worker inherited across server restart has no local child.close listener.
    // This watchdog notices its exit and keeps the queue moving without any browser.
    schedulerTimer = setInterval(recoverQueue, 2000);
    schedulerTimer.unref?.();
  });
  server.once('close', () => clearInterval(schedulerTimer));
  return server;
}

if (require.main === module) {
  if (!VIDEO_FILE || !fs.existsSync(VIDEO_FILE)) {
    console.error(`❌ Preview 视频不存在: ${VIDEO_FILE || '(未指定)'}`);
    process.exit(1);
  }
  const server = createServer();
  server.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}`;
    fs.writeFileSync(path.join(ROOT, 'preview_review_url.txt'), `${url}\n`);
    fs.writeFileSync(path.join(ROOT, '.preview_review_server.pid'), `${process.pid}\n`);
    console.log(`READY_PORT=${PORT}`);
    console.log(`🎬 Preview 批注网址: ${url}`);
    console.log('快捷键: Space 播放/暂停 · M 打点 · C 设置本帧为封面 · E 分割 · A/S 左右裁剪 · D 删除片段');
  });
}

module.exports = { createServer, validatePayload, validateTimelinePayload, validateReviewBlocksPayload };
