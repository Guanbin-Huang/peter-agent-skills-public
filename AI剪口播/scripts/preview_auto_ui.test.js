'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const template = fs.readFileSync(path.join(__dirname, 'templates', 'preview_review.html'), 'utf8');
const script = [...template.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
class Element {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase(); this.id = id; this.handlers = {}; this.attributes = {};
    this.style = {}; this.dataset = {}; this.textContent = ''; this.innerHTML = ''; this.hidden = false;
    this.disabled = false; this.isContentEditable = false; this.parentElement = this; this.value = '';
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name), remove: name => this.classes.delete(name),
      toggle: (name, force) => { const add = force === undefined ? !this.classes.has(name) : force; add ? this.classes.add(name) : this.classes.delete(name); return add; },
      contains: name => this.classes.has(name),
    };
  }
  addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
  removeEventListener(name, handler) { this.handlers[name] = (this.handlers[name] || []).filter(item => item !== handler); }
  dispatch(name, event = {}) { for (const handler of [...this.handlers[name] || []]) handler({ target: this, type: name, ...event }); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
  matches(selector) { return selector.split(',').includes(this.tagName.toLowerCase()); }
  contains(element) { return element === this; }
  focus() {}
  appendChild() {}
  closest() { return null; }
  getBoundingClientRect() { return { left: 0, width: 400 }; }
  click() { if (!this.disabled) return this.onclick?.({ target: this }); }
}

async function browser({ enabled = true, postComments, postTimeline, getStatus, pauseRequest, reviewFinished, initialMarkers = [], initialTimeline = { clips: [] }, getApplication, acceptRequest, retryRequest, loadMedia } = {}) {
  const elements = new Map();
  for (const match of template.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1], match[3]);
    element.hidden = /\bhidden\b/.test(match[2]);
    element.disabled = /\bdisabled\b/.test(match[2]);
    elements.set(element.id, element);
  }
  const $ = id => elements.get(id), video = $('video');
  for (const media of [...elements.values()].filter(element => element.tagName === 'VIDEO')) {
    Object.assign(media, { duration: 90, currentTime: 12.345, playbackRate: 1, readyState: 2, seeking: false, paused: false, pauseCount: 0 });
    media.pause = () => { media.paused = true; media.pauseCount++; media.dispatch('pause'); };
    media.play = async () => { media.paused = false; media.dispatch('play'); };
    media.load = () => { media.readyState = 0; media.currentTime = 0; setImmediate(() => {
      if (loadMedia) return loadMedia(media);
      media.readyState = 2; media.dispatch('loadedmetadata'); media.dispatch('loadeddata'); media.dispatch('seeked');
    }); };
  }
  const document = new Element();
  document.querySelector = selector => elements.get(selector.slice(1)) || null;
  document.querySelectorAll = () => [];
  document.createElement = tag => Object.assign(new Element(tag), { readyState: 0 });
  document.body = new Element('body');
  const window = new Element(); window.PreviewTimeline = require('./preview_timeline');
  const requests = [], timers = new Map(); let timerId = 0, status = { state: 'idle', incremental: { paused: false, batches: [], pendingMarkerIds: [] } }, application = null;
  const fetch = async (url, options = {}) => {
    const request = { url, ...options }; requests.push(request);
    if (url === '/api/config') return response({ title: 'test', videoUrl: '/video.mp4', timelineMap: [], codexCallbackEnabled: enabled, codexCallbackToken: 'test-only-token' });
    if (url === '/api/cover') return response({ cover: null });
    if (url === '/api/comments') {
      if (options.method === 'POST') {
        const payload = JSON.parse(options.body);
        if (postComments) return postComments(payload, requests);
        status = { ...status, incremental: { ...status.incremental, pendingMarkerIds: payload.markers.length % 2 ? [payload.markers.at(-1).id] : [] } };
        return response({ success: true, updatedAt: 'saved', incremental: status.incremental });
      }
      return response({ markers: initialMarkers });
    }
    if (url === '/api/timeline') {
      if (options.method === 'POST') return postTimeline ? postTimeline(JSON.parse(options.body), requests) : response({ success: true, updatedAt: 'timeline-saved' });
      return response(initialTimeline);
    }
    if (url === '/api/edit-application') return getApplication ? getApplication() : application ? response(application) : response({}, 404);
    if (url === '/api/edit-accept') return acceptRequest ? acceptRequest(JSON.parse(options.body), requests) : response({ error: 'not configured' }, 500);
    if (url === '/api/edit-retry') return retryRequest ? retryRequest(JSON.parse(options.body), requests) : response({ error: 'not configured' }, 500);
    if (url === '/api/review-finished') return reviewFinished ? reviewFinished(JSON.parse(options.body), requests) : response({ success: true });
    if (url === '/api/codex-status') return getStatus ? getStatus() : response(status);
    if (url === '/api/codex-pause') {
      const paused = JSON.parse(options.body).paused;
      if (pauseRequest) await pauseRequest(paused);
      status = { ...status, incremental: { ...status.incremental, paused } };
      return response({ success: true, incremental: status.incremental });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  vm.runInNewContext(script, { document, window, fetch, console, setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id), navigator: {}, URL, Blob, confirm: () => false }, { filename: 'preview_review.html' });
  await tick(); video.dispatch('loadeddata');
  return {
    $, video, requests, timers, setStatus: next => { status = next; }, setApplication: next => { application = next; },
    async poll() { const entry = [...timers].find(([, value]) => value.delay === 2200); assert.ok(entry, 'automatic status polling stays scheduled'); timers.delete(entry[0]); await entry[1].fn(); await tick(); },
    async pollApplication() { const entry = [...timers].find(([, value]) => value.delay === 2600); assert.ok(entry, 'application polling stays scheduled'); timers.delete(entry[0]); await entry[1].fn(); await tick(); },
    markerAction(id, action) { const card = { dataset: { id } }, button = { dataset: { action } }; return $('markers').onclick({ target: { closest: selector => selector === '.card' ? card : selector === '[data-action]' ? button : null } }); },
    suggest(text, time = video.currentTime) { video.currentTime = time; $('markBtn').click(); $('comment').value = text; return $('saveBtn').click(); },
    key(code) { for (const handler of window.handlers.keydown || []) handler({ target: video, code, preventDefault() {}, stopPropagation() {} }); },
  };
}

test('one comment saves immediately but waits for its pair without claiming work started', async () => {
  const b = await browser();
  assert.equal(b.$('codexSubmitBtn'), undefined); assert.equal(b.$('reviewedHereBtn'), undefined);
  b.requests.length = 0;
  await b.suggest('这里重复，删掉后一次'); await tick();
  assert.deepEqual(b.requests.map(r => [r.url, r.method || 'GET']), [['/api/comments', 'POST'], ['/api/codex-status', 'GET']]);
  const saved = JSON.parse(b.requests[0].body); assert.equal(saved.markers.length, 1); assert.equal(saved.markers[0].comment, '这里重复，删掉后一次');
  assert.match(b.$('saveState').textContent, /已自动保存/);
  assert.match(b.$('toast').textContent, /已保存1条，再记1条就自动修改/);
  assert.match(b.$('codexStatus').textContent, /已保存1条，再记1条就自动修改/);
  assert.equal(b.video.src, '/video.mp4'); assert.equal(b.video.currentTime, 12.345);
});

test('a failed comment save is not announced saved or followed by a false status refresh', async () => {
  const b = await browser({ postComments: () => response({ error: 'disk full' }, 500) }); b.requests.length = 0;
  assert.equal(await b.suggest('save me'), false);
  assert.deepEqual(b.requests.map(r => r.url), ['/api/comments']);
  assert.match(b.$('saveState').textContent, /保存失败/); assert.match(b.$('toast').textContent, /disk full/);
});

test('status polling continues through idle, completion, failure and network recovery', async () => {
  let failure = false;
  const b = await browser({ getStatus: () => failure ? Promise.reject(new Error('offline')) : response({ state: 'idle' }) });
  await b.poll(); failure = true; await b.poll(); assert.match(b.$('codexStatus').textContent, /自动重连/);
  failure = false; await b.poll(); assert.match(b.$('codexStatus').textContent, /两条自动修改/);
  const c = await browser();
  for (const state of ['completed', 'failed', 'idle']) { c.setStatus({ state, incremental: { batches: [] } }); await c.poll(); }
  assert.ok([...c.timers.values()].some(value => value.delay === 2200));
  const disabled = await browser({ enabled: false });
  assert.equal([...disabled.timers.values()].some(value => value.delay === 2200), false);
});

test('human counts measure comments, not batches; completed results survive the next running job', async () => {
  const b = await browser({ initialMarkers: [{ id: 'done', previewTime: 8, comment: '<done>', resolved: false }] });
  b.setStatus({ state: 'running', incremental: { pendingMarkerIds: ['wait'], batches: [
    { state: 'failed', markers: [{ id: 'done' }] },
    { state: 'completed', outputUrls: ['/result/one.mp4', '//evil.test/a', 'javascript:alert(1)', '/\\evil.test'], markers: [{ id: 'done', previewTime: 8, comment: '<done>' }] },
    { state: 'running', markers: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] },
    { state: 'failed', markers: [{ id: 'bad' }] },
  ] } });
  await b.poll();
  assert.match(b.$('codexStatus').innerHTML, /正在修改 3 条 · 已保存1条，再记1条就自动修改 · 已改好 1 条 · 需检查 1 条/);
  assert.doesNotMatch(b.$('codexStatus').innerHTML, /queued|running|批次|已审到/);
  assert.match(b.$('markers').innerHTML, /<details class="completed-group" id="completedGroup">/);
  assert.match(b.$('markers').innerHTML, /已改好 · 待验收/);
  assert.match(b.$('markers').innerHTML, /&lt;done&gt;/);
  assert.match(b.$('markers').innerHTML, /href="\/result\/one.mp4"/);
  assert.doesNotMatch(b.$('markers').innerHTML, /evil|javascript:/);
  assert.equal(b.$('codexResults').hidden, true, 'do not duplicate completed cards above the archive');
  assert.equal(b.video.src, '/video.mp4'); assert.equal(b.video.currentTime, 12.345);
});

test('completed and pending cards are separated without resolving or saving comments', async () => {
  const markers=[{id:'done',previewTime:8,comment:'done comment',resolved:false},{id:'todo',previewTime:20,comment:'todo comment',resolved:false}];
  const b=await browser({initialMarkers:markers}); b.requests.length=0;
  b.setStatus({state:'completed',incremental:{batches:[{state:'completed',outputUrls:['/result/done.mp4'],markers:[markers[0]]}]}});
  await b.poll();
  const html=b.$('markers').innerHTML, start=html.indexOf('<details');
  assert.ok(start>0); assert.match(html.slice(0,start),/todo comment/); assert.doesNotMatch(html.slice(0,start),/done comment/);
  assert.match(html.slice(start),/done comment/); assert.doesNotMatch(html.slice(start),/todo comment/);
  assert.equal(b.$('count').textContent,'1 待处理 · 1 已改好');
  assert.equal(markers[0].resolved,false); assert.equal(markers[1].resolved,false);
  assert.equal(b.requests.some(r=>r.method==='POST'),false);
});

test('editing a completed comment or stale result returns it to the pending list', async () => {
  const marker={id:'done',previewTime:8,comment:'new text',resolved:false};
  const b=await browser({initialMarkers:[marker]});
  b.setStatus({state:'completed',incremental:{batches:[{state:'completed',outputUrls:['/result/old.mp4'],markers:[{...marker,comment:'old text'}]}]}});
  await b.poll(); assert.doesNotMatch(b.$('markers').innerHTML,/<details/); assert.match(b.$('markers').innerHTML,/待重新处理/);
  b.setStatus({state:'idle',incremental:{batches:[{state:'stale',outputUrls:['/result/old.mp4'],markers:[marker]}]}});
  await b.poll(); assert.doesNotMatch(b.$('markers').innerHTML,/<details/); assert.match(b.$('markers').innerHTML,/需要重新处理/);
});

test('completed status without playable artifacts does not archive a comment', async () => {
  const marker={id:'done',previewTime:8,comment:'test',resolved:false};
  const b=await browser({initialMarkers:[marker]});
  b.setStatus({state:'completed',incremental:{batches:[{state:'completed',outputUrls:[],markers:[marker]}]}});
  await b.poll(); assert.doesNotMatch(b.$('markers').innerHTML,/<details/); assert.equal(b.$('count').textContent,'1 待处理 · 0 已改好');
});

test('user-expanded completed archive stays expanded after a subsequent status update', async () => {
  const marker={id:'done',previewTime:8,comment:'test',resolved:false};
  const b=await browser({initialMarkers:[marker]});
  const batch={state:'completed',outputUrls:['/result/one.mp4'],markers:[marker]};
  b.setStatus({state:'completed',incremental:{batches:[batch]}}); await b.poll();
  b.$('markers').dispatch('toggle',{target:{id:'completedGroup',open:true}});
  b.setStatus({state:'running',incremental:{batches:[batch,{state:'running',markers:[{id:'other'}]}]}}); await b.poll();
  assert.match(b.$('markers').innerHTML,/<details class="completed-group" id="completedGroup" open>/);
});

test('pause toggles explicit server state, ignores label text and prevents double clicks', async () => {
  let release, pausedRequests = [];
  const b = await browser({ pauseRequest: paused => { pausedRequests.push(paused); return new Promise(resolve => { release = resolve; }); } });
  b.$('codexPauseBtn').textContent = '继续 is not state';
  const first = b.$('codexPauseBtn').click(); b.$('codexPauseBtn').click();
  await tick(); assert.deepEqual(pausedRequests, [true]); release(); await first; await tick();
  assert.equal(b.$('codexPauseBtn').textContent, '继续自动修改');
  b.$('codexPauseBtn').textContent = '暂停 is not state';
  const second = b.$('codexPauseBtn').click(); await tick(); assert.deepEqual(pausedRequests, [true, false]); release(); await second; await tick();
  assert.equal(b.$('codexPauseBtn').textContent, '暂停自动修改');
});

test('two rapid saves are serialized so the old snapshot never overwrites the new one', async () => {
  let firstRelease; const payloads = [];
  const b = await browser({ postComments: payload => { payloads.push(payload); return payloads.length === 1 ? new Promise(resolve => { firstRelease = resolve; }) : response({ success: true }); } });
  const first = b.suggest('first', 10); await tick();
  const second = b.suggest('second', 20); await tick();
  assert.equal(payloads.length, 1); assert.equal(payloads[0].markers.length, 1);
  firstRelease(response({ success: true })); await first; await second;
  assert.equal(payloads.length, 2); assert.deepEqual(payloads[1].markers.map(m => m.comment), ['first', 'second']);
  assert.match(b.$('saveState').textContent, /2 条/);
});

test('pending trial timeline saves before comment dispatch and is not overwritten by its old timer', async () => {
  const b = await browser(); b.video.dispatch('loadedmetadata');
  b.$('viewer').dispatch('pointerdown'); b.key('KeyE'); b.requests.length = 0;
  await b.suggest('keep these cuts'); await tick();
  assert.deepEqual(b.requests.map(r => [r.url, r.method || 'GET']), [['/api/timeline', 'POST'], ['/api/comments', 'POST'], ['/api/codex-status', 'GET']]);
  assert.equal(JSON.parse(b.requests[0].body).clips.length, 2);
  assert.equal([...b.timers.values()].some(value => value.delay === 180), false);
});

test('timeline save failure prevents comments from starting a worker with stale cuts', async () => {
  const b = await browser({ postTimeline: () => response({ error: 'timeline failed' }, 500) }); b.video.dispatch('loadedmetadata'); b.requests.length = 0;
  assert.equal(await b.suggest('requires my cuts'), false);
  assert.deepEqual(b.requests.map(r => r.url), ['/api/timeline']);
  assert.match(b.$('saveState').textContent, /保存失败/);
});


test('a slow old status response cannot replace a newer running state', async () => {
  let oldRelease, statusReads = 0;
  const b = await browser({ getStatus: () => {
    statusReads++;
    if (statusReads === 2) return new Promise(resolve => { oldRelease = resolve; });
    return response(statusReads === 1 ? { state: 'idle' } : { state: 'running', incremental: { batches: [{ state: 'running', markers: [{ id: 'new' }] }] } });
  } });
  const old = b.poll(); await tick();
  await b.suggest('new suggestion'); await tick();
  assert.match(b.$('codexStatus').innerHTML, /正在修改 1 条/);
  oldRelease(response({ state: 'idle' })); await old;
  assert.match(b.$('codexStatus').innerHTML, /正在修改 1 条/);
});


test('native ended automatically flushes final remainder once with the callback token', async () => {
  const b = await browser(); await b.suggest('tail'); b.requests.length = 0;
  b.video.currentTime = 90; b.video.dispatch('ended'); b.video.dispatch('ended'); await tick();
  const finishes = b.requests.filter(r => r.url === '/api/review-finished');
  assert.equal(finishes.length, 1); assert.deepEqual(JSON.parse(finishes[0].body), { previewTime: 90 });
  assert.equal(finishes[0].headers['X-Codex-Callback-Token'], 'test-only-token');
  assert.equal(b.requests.some(r => /review-blocks|reviewed-to-here/.test(r.url)), false);
});

test('ended waits for the last comment persistence before flushing', async () => {
  let release;
  const b = await browser({ postComments: () => new Promise(resolve => { release = resolve; }) });
  const save = b.suggest('final delayed comment'); await tick();
  b.video.currentTime = 90; b.video.dispatch('ended'); await tick();
  assert.equal(b.requests.filter(r => r.url === '/api/review-finished').length, 0);
  release(response({ success: true })); await save; await tick();
  const relevant = b.requests.filter(r => r.method === 'POST').map(r => r.url);
  assert.deepEqual(relevant, ['/api/comments', '/api/review-finished']);
});

test('a failed last comment save prevents final remainder from flushing stale data', async () => {
  let release;
  const b = await browser({ postComments: () => new Promise(resolve => { release = resolve; }) });
  const save = b.suggest('unsaved final comment'); await tick();
  b.video.currentTime = 90; b.video.dispatch('ended');
  release(response({ error: 'disk full' }, 500)); await save; await tick();
  assert.equal(b.requests.filter(r => r.url === '/api/review-finished').length, 0);
});

test('a new saved comment at the reached end flushes again without a manual control', async () => {
  const b = await browser(); b.video.currentTime = 90; b.video.dispatch('ended'); await tick(); b.requests.length = 0;
  await b.suggest('add a final note', 90); await tick();
  assert.deepEqual(b.requests.filter(r => r.method === 'POST').map(r => r.url), ['/api/comments', '/api/review-finished']);
});

test('seeking back clears the end state so a new single comment waits for its pair', async () => {
  const b = await browser(); b.video.currentTime = 90; b.video.dispatch('ended'); await tick();
  b.video.currentTime = 20; b.video.dispatch('seeking'); b.requests.length = 0;
  await b.suggest('new pass', 20); await tick();
  assert.deepEqual(b.requests.filter(r => r.method === 'POST').map(r => r.url), ['/api/comments']);
  assert.match(b.$('toast').textContent, /已保存1条，再记1条就自动修改/);
  b.video.currentTime = 90; b.video.dispatch('ended'); await tick();
  assert.equal(b.requests.filter(r => r.url === '/api/review-finished').length, 1);
});

test('trial-cut final clip flushes even though playback pauses before native ended', async () => {
  const b = await browser(); b.video.dispatch('loadedmetadata');
  b.video.currentTime = 40; b.$('viewer').dispatch('pointerdown'); b.key('KeyS');
  await b.suggest('comment in final cut', 35); await tick(); b.requests.length = 0;
  b.video.paused = false; b.video.currentTime = 39.98; b.video.dispatch('timeupdate'); await tick();
  assert.equal(b.video.paused, true);
  const finishes = b.requests.filter(r => r.url === '/api/review-finished');
  assert.equal(finishes.length, 1); assert.equal(JSON.parse(finishes[0].body).previewTime, 39.98);
  b.video.dispatch('timeupdate'); await tick();
  assert.equal(b.requests.filter(r => r.url === '/api/review-finished').length, 1);
});


test('ending with unsaved trial cuts flushes the timeline before final remainder', async () => {
  const b = await browser(); b.video.dispatch('loadedmetadata');
  b.$('viewer').dispatch('pointerdown'); b.key('KeyE'); b.requests.length = 0;
  b.video.currentTime = 90; b.video.dispatch('ended'); await tick();
  assert.deepEqual(b.requests.filter(r => r.method === 'POST').map(r => r.url), ['/api/timeline', '/api/review-finished']);
  assert.equal(JSON.parse(b.requests.find(r => r.url === '/api/timeline').body).clips.length, 2);
});

const applicationMarker = (id = 'edit-1', time = 12) => ({ id, previewTime: time, comment: `修改 ${id}`, resolved: false });
const applicationCandidate = (marker, extra = {}) => ({ markerId: marker.id, revisionId: `revision-${marker.id}`, clipUrl: `/clips/${marker.id}.mp4`, summary: `改好了 ${marker.id}`, status: 'ready', canAccept: true, ...extra });
const applicationState = (candidates, extra = {}) => ({ state: 'idle', candidates, acceptedMarkerIds: [], job: null, activeVersion: null, ...extra });

test('each edit opens its own inline clip; old revisions remain records but cannot be accepted', async () => {
  const markers = [applicationMarker('old-1'), applicationMarker('old-2', 24), applicationMarker('new-1'), applicationMarker('new-2', 24)];
  const candidates = markers.map((marker, index) => applicationCandidate(marker, index < 2 ? { status: 'stale', canAccept: false, reason: '此处已有更新修改，请验收新版本' } : {}));
  const b = await browser({ initialMarkers: markers, getApplication: () => response(applicationState(candidates)) });
  assert.equal(b.$('count').textContent, '0 待处理 · 4 已改好');
  assert.match(b.$('markers').innerHTML, /通过并应用/);
  assert.doesNotMatch(b.$('markers').innerHTML, /查看修改 1|查看修改 2|data-action="resolve"/);
  b.requests.length = 0;
  await b.markerAction('new-1', 'watch');
  assert.equal(b.$('editReviewVideo').src, '/clips/new-1.mp4');
  assert.equal(b.$('editReview').hidden, false); assert.equal(b.video.paused, true);
  assert.equal(b.video.src, '/video.mp4'); assert.equal(b.video.currentTime, 12.345);
  await b.markerAction('new-2', 'watch'); assert.equal(b.$('editReviewVideo').src, '/clips/new-2.mp4');
  await b.markerAction('old-1', 'watch'); assert.equal(b.$('editReviewVideo').src, '/clips/old-1.mp4');
  assert.equal(b.$('reviewAcceptBtn').disabled, true); assert.match(b.$('editReviewNote').textContent, /已有更新/);
  assert.equal(await b.markerAction('old-1', 'accept'), false);
  assert.equal(b.requests.some(request => request.method === 'POST'), false);
  b.$('closeEditReviewBtn').click(); assert.equal(b.$('editReview').hidden, true); assert.equal(b.$('editReviewVideo').paused, true);
});

test('acceptance is one authenticated request and never resolves comments or switches the main video', async () => {
  const marker = applicationMarker(), candidate = applicationCandidate(marker);
  let release, payload;
  const ready = applicationState([candidate]);
  const b = await browser({ initialMarkers: [marker], getApplication: () => response(ready), acceptRequest: input => {
    payload = input; return new Promise(resolve => { release = () => resolve(response({ success: true, ...applicationState([{ ...candidate, status: 'accepted', canAccept: false }], { state: 'rendering', acceptedMarkerIds: [marker.id], job: { id: 'job-1', state: 'rendering', progressFrames: 10, totalFrames: 100 } }) }, 202)); });
  } });
  b.requests.length = 0;
  const accept = b.markerAction(marker.id, 'accept'); const duplicate = b.markerAction(marker.id, 'accept');
  await tick(); assert.equal(await duplicate, false); assert.deepEqual(payload, { markerId: marker.id, revisionId: candidate.revisionId });
  assert.equal(b.requests.filter(request => request.url === '/api/edit-accept').length, 1);
  assert.equal(b.requests[0].headers['X-Codex-Callback-Token'], 'test-only-token');
  release(); assert.equal(await accept, true);
  assert.equal(marker.resolved, false); assert.equal(b.requests.some(request => request.url === '/api/comments'), false);
  assert.match(b.$('markers').innerHTML, /已通过 · 合成中/); assert.match(b.$('editApplicationStatus').textContent, /10\/100 帧/);
  assert.equal(b.video.src, '/video.mp4'); assert.equal(b.video.currentTime, 12.345); assert.equal(b.video.paused, false);
  assert.equal(b.$('playAppliedBtn').hidden, true);
});

test('application polling never changes the main video, an open draft or expanded archive', async () => {
  const marker = applicationMarker(); let application = applicationState([applicationCandidate(marker)]);
  const b = await browser({ initialMarkers: [marker], getApplication: () => response(application) });
  b.$('markers').dispatch('toggle', { target: { id: 'completedGroup', open: true } });
  b.markerAction(marker.id, 'edit'); b.$('comment').value = '正在口述的新意见';
  application = applicationState([{ ...applicationCandidate(marker), status: 'applied', canAccept: false }], { state: 'ready', acceptedMarkerIds: [marker.id], activeVersion: { id: 'v1', videoUrl: '/versions/v1.mp4', duration: 90, identityTimeline: true } });
  await b.pollApplication();
  assert.equal(b.video.src, '/video.mp4'); assert.equal(b.video.currentTime, 12.345);
  assert.equal(b.$('comment').value, '正在口述的新意见'); assert.equal(b.$('editor').classList.contains('active'), true);
  assert.match(b.$('markers').innerHTML, /id="completedGroup" open/);
  assert.equal(b.$('playAppliedBtn').hidden, false);
  assert.equal(await b.$('playAppliedBtn').click(), false);
  assert.equal(b.video.src, '/video.mp4'); assert.match(b.$('toast').textContent, /先保存或取消/);
});

test('explicit full-version switch preserves playhead, playback rate, playing state and trial-cut timeline', async () => {
  const marker = applicationMarker(), application = applicationState([applicationCandidate(marker, { status: 'applied', canAccept: false })], { state: 'ready', acceptedMarkerIds: [marker.id], activeVersion: { id: 'v1', videoUrl: '/versions/v1.mp4', duration: 90, identityTimeline: true } });
  const b = await browser({ initialMarkers: [marker], initialTimeline: { video: 'test', sourceDuration: 90, clips: [{ id: 'keep-original-id', sourceStart: 2, sourceEnd: 88 }] }, getApplication: () => response(application) });
  b.video.dispatch('loadedmetadata'); b.video.playbackRate = 1.25;
  const timeline = b.$('timelineClips').innerHTML, stats = b.$('timelineStats').textContent;
  b.requests.length = 0;
  assert.equal(await b.$('playAppliedBtn').click(), true);
  assert.equal(b.video.src, '/versions/v1.mp4'); assert.equal(b.video.currentTime, 12.345);
  assert.equal(b.video.playbackRate, 1.25); assert.equal(b.video.paused, false);
  assert.equal(b.$('timelineClips').innerHTML, timeline); assert.equal(b.$('timelineStats').textContent, stats);
  assert.equal(b.requests.some(request => request.method === 'POST'), false);
  assert.equal(b.$('editPlaying').textContent, '正在看：完整新版'); assert.equal(b.$('playAppliedBtn').hidden, true);
  b.video.pause(); b.video.currentTime = 28;
  assert.equal(await b.$('playOriginalBtn').click(), true);
  assert.equal(b.video.src, '/video.mp4'); assert.equal(b.video.currentTime, 28); assert.equal(b.video.paused, true);
  assert.equal(b.$('editPlaying').textContent, '正在看：原版全片');
});

test('changed-duration full video fails the identity check and restores the previous source and playhead', async () => {
  const marker = applicationMarker(), application = applicationState([applicationCandidate(marker)], { state: 'ready', activeVersion: { id: 'bad', videoUrl: '/versions/bad.mp4', duration: 90, identityTimeline: true } });
  const b = await browser({ initialMarkers: [marker], getApplication: () => response(application), loadMedia: media => {
    media.duration = media.src === '/versions/bad.mp4' ? 91 : 90;
    media.readyState = 2; media.dispatch('loadedmetadata'); media.dispatch('loadeddata'); media.dispatch('seeked');
  } });
  b.video.paused = true; b.video.currentTime = 27; b.video.playbackRate = 1.5;
  assert.equal(await b.$('playAppliedBtn').click(), false);
  assert.equal(b.video.src, '/video.mp4'); assert.equal(b.video.currentTime, 27); assert.equal(b.video.playbackRate, 1.5); assert.equal(b.video.paused, true);
  assert.match(b.$('editApplicationStatus').textContent, /时长与基准时间线不一致/);
  assert.equal(b.$('editPlaying').textContent, '正在看：原版全片');
});

test('stale acceptance returns an error and never infers approval or changes the playing version', async () => {
  const marker = applicationMarker(), candidate = applicationCandidate(marker); let stale = false;
  const b = await browser({ initialMarkers: [marker], getApplication: () => response(applicationState([stale ? { ...candidate, status: 'stale', canAccept: false } : candidate])), acceptRequest: () => {
    stale = true; return response({ error: '这条结果已过期，请验收最新版本' }, 409);
  } });
  b.requests.length = 0;
  assert.equal(await b.markerAction(marker.id, 'accept'), false); await tick();
  assert.match(b.$('editApplicationStatus').textContent, /验收未成功/);
  assert.equal(marker.resolved, false); assert.equal(b.video.src, '/video.mp4');
  assert.equal(b.requests.filter(request => request.url === '/api/edit-accept').length, 1);
  assert.equal(b.requests.some(request => request.url === '/api/comments'), false);
  assert.match(b.$('markers').innerHTML, /旧修改/);
});

test('failed acceptance remains retryable and a failed composition has an explicit authenticated retry', async () => {
  const marker = applicationMarker(), candidate = applicationCandidate(marker); let application = applicationState([candidate]);
  const b = await browser({ initialMarkers: [marker], getApplication: () => response(application), acceptRequest: () => response({ error: 'disk full' }, 500), retryRequest: payload => {
    assert.deepEqual(payload, {}); return response({ success: true, ...applicationState([{ ...candidate, status: 'accepted', canAccept: false }], { state: 'rendering', acceptedMarkerIds: [marker.id] }) }, 202);
  } });
  assert.equal(await b.markerAction(marker.id, 'accept'), false);
  assert.match(b.$('editApplicationStatus').textContent, /disk full/); assert.match(b.$('markers').innerHTML, /data-action="accept">通过并应用/);
  application = applicationState([{ ...candidate, status: 'accepted', canAccept: false }], { state: 'failed', acceptedMarkerIds: [marker.id], job: { error: 'render failed' } });
  await b.pollApplication(); assert.equal(b.$('retryApplyBtn').hidden, false);
  assert.equal(await b.$('retryApplyBtn').click(), true);
  const request = b.requests.find(item => item.url === '/api/edit-retry');
  assert.equal(request.headers['X-Codex-Callback-Token'], 'test-only-token');
  assert.match(b.$('editApplicationStatus').textContent, /正在合成完整新版/); assert.equal(b.video.src, '/video.mp4');
});

test('acceptance waits for persistence and a failed save prevents stale-result approval', async () => {
  const marker = applicationMarker();
  const b = await browser({ initialMarkers: [marker], getApplication: () => response(applicationState([applicationCandidate(marker)])), postComments: () => response({ error: 'save failed' }, 500) });
  b.$('markBtn').click(); b.$('comment').value = '还没有保存的另一条';
  assert.equal(await b.markerAction(marker.id, 'accept'), false);
  assert.equal(await b.$('saveBtn').click(), false);
  b.requests.length = 0;
  assert.equal(await b.markerAction(marker.id, 'accept'), false);
  assert.equal(b.requests.length, 0); assert.match(b.$('toast').textContent, /保存成功/);
});

test('editing a comment immediately invalidates its old revision until a new candidate arrives', async () => {
  const marker = applicationMarker(), candidate = applicationCandidate(marker); let application = applicationState([candidate]);
  const b = await browser({ initialMarkers: [marker], getApplication: () => response(application) });
  b.markerAction(marker.id, 'edit'); b.$('comment').value = '新的修改要求'; await b.$('saveBtn').click();
  b.requests.length = 0;
  assert.equal(await b.markerAction(marker.id, 'accept'), false); assert.equal(b.requests.some(request => request.url === '/api/edit-accept'), false);
  assert.match(b.$('markers').innerHTML, /批注已更新/);
  application = applicationState([{ ...candidate, revisionId: 'new-revision', clipUrl: '/clips/new-revision.mp4' }]); await b.pollApplication();
  assert.match(b.$('markers').innerHTML, /data-action="accept">通过并应用/);
  await b.markerAction(marker.id, 'watch'); assert.equal(b.$('editReviewVideo').src, '/clips/new-revision.mp4');
});

test('external media URLs and non-identity versions cannot enter inline playback or the main video', async () => {
  const marker = applicationMarker();
  const b = await browser({ initialMarkers: [marker], getApplication: () => response(applicationState([applicationCandidate(marker, { clipUrl: '//external.test/clip.mp4' })], { state: 'ready', activeVersion: { id: 'x', videoUrl: '/versions/x.mp4', duration: 90, identityTimeline: false } })) });
  b.requests.length = 0;
  assert.equal(b.$('playAppliedBtn').hidden, true);
  await b.markerAction(marker.id, 'watch'); assert.equal(b.$('editReview').hidden, true);
  assert.equal(await b.markerAction(marker.id, 'accept'), false);
  assert.equal(b.requests.length, 0); assert.equal(b.video.src, '/video.mp4');
});

test('an application poll started before acceptance cannot overwrite the accepted response', async () => {
  const marker = applicationMarker(), candidate = applicationCandidate(marker); let release, slow = false;
  const b = await browser({ initialMarkers: [marker], getApplication: () => slow ? new Promise(resolve => { release = () => resolve(response(applicationState([candidate]))); }) : response(applicationState([candidate])), acceptRequest: () => response({ success: true, ...applicationState([{ ...candidate, status: 'accepted', canAccept: false }], { state: 'rendering', acceptedMarkerIds: [marker.id] }) }, 202) });
  slow = true; const poll = b.pollApplication(); await tick();
  assert.equal(await b.markerAction(marker.id, 'accept'), true);
  release(); await poll;
  assert.match(b.$('markers').innerHTML, /已通过 · 合成中/); assert.match(b.$('editApplicationStatus').textContent, /正在合成/);
  assert.equal(b.video.src, '/video.mp4');
});

test('two immediate complete-version clicks load one source only', async () => {
  const marker = applicationMarker(); let loads = 0;
  const b = await browser({ initialMarkers: [marker], getApplication: () => response(applicationState([applicationCandidate(marker)], { state: 'ready', activeVersion: { id: 'v1', videoUrl: '/versions/v1.mp4', identityTimeline: true, duration: 90 } })), loadMedia: media => {
    loads++; media.readyState = 2; media.dispatch('loadedmetadata'); media.dispatch('loadeddata'); media.dispatch('seeked');
  } });
  const first = b.$('playAppliedBtn').click(), second = b.$('playAppliedBtn').click();
  assert.equal(await first, true); assert.equal(await second, false); assert.equal(loads, 1);
});

test('server readback clears an uncertain acceptance error once the same revision is confirmed accepted', async () => {
  const marker = applicationMarker(), candidate = applicationCandidate(marker); let accepted = false;
  const b = await browser({ initialMarkers: [marker], getApplication: () => response(applicationState([accepted ? { ...candidate, status: 'accepted', canAccept: false } : candidate], accepted ? { state: 'rendering', acceptedMarkerIds: [marker.id] } : {})), acceptRequest: () => {
    accepted = true; throw new Error('connection reset');
  } });
  assert.equal(await b.markerAction(marker.id, 'accept'), false);
  assert.match(b.$('editApplicationStatus').textContent, /connection reset/);
  await b.pollApplication();
  assert.doesNotMatch(b.$('editApplicationStatus').textContent, /connection reset/);
  assert.match(b.$('markers').innerHTML, /已通过 · 合成中/);
});
