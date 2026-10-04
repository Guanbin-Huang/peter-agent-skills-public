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
const selectedCover = (previewTime = 12.345) => ({
  imageUrl: `/cover/cover-${previewTime}.png`, previewTime,
  sourceTime: 40 + previewTime * 1.3, sourceVideo: 'a-roll.mp4', kind: 'a-roll', updatedAt: '2026-08-29T00:00:00Z',
});
const coverCandidates = (selectedId = null) => [
  { id: 'panel-1', style: 'translucent-title-panel', label: '半透明标题底板', imageUrl: '/cover/panel.png', selected: selectedId === 'panel-1' },
  { id: 'smiley-1', style: 'smiley-bold', label: '得意黑大字', imageUrl: '/cover/smiley.png', selected: selectedId === 'smiley-1' },
];

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
  dispatch(name, event = {}) { for (const handler of this.handlers[name] || []) handler({ target: this, ...event }); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; delete this[name]; }
  matches(selector) { return selector.split(',').includes(this.tagName.toLowerCase()); }
  contains(element) { return element === this; }
  focus() {}
  closest() { return null; }
  getBoundingClientRect() { return { left: 0, width: 400 }; }
  click() { if (!this.disabled) return this.onclick?.({ target: this }); }
}

async function browser({ cover = null, getCover, postCover, postDesign, postCandidates, postSelect } = {}) {
  const elements = new Map();
  for (const match of template.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1], match[3]);
    element.hidden = /\bhidden\b/.test(match[2]);
    element.disabled = /\bdisabled\b/.test(match[2]);
    elements.set(element.id, element);
  }
  const $ = id => elements.get(id);
  const video = $('video');
  Object.assign(video, { duration: 90, currentTime: 12.345, readyState: 2, seeking: false, paused: false, pauseCount: 0 });
  video.pause = () => { video.paused = true; video.pauseCount++; video.dispatch('pause'); };
  video.play = async () => { video.paused = false; video.dispatch('play'); };
  const document = new Element();
  document.querySelector = selector => elements.get(selector.slice(1)) || null;
  document.querySelectorAll = () => [];
  document.createElement = tag => { if (tag === 'canvas') throw new Error('Cover must not use canvas'); return new Element(tag); };
  document.body = new Element('body');
  const window = new Element();
  window.PreviewTimeline = require('./preview_timeline');
  const posts = [], designPosts = [], candidatePosts = [], selectPosts = [], requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (url === '/api/cover') {
      if (options.method === 'POST') {
        assert.equal(video.paused, true, 'video must pause before network request');
        const body = JSON.parse(options.body); posts.push(body);
        return postCover ? postCover(body) : response({ success: true, cover: selectedCover(body.previewTime) });
      }
      return getCover ? getCover() : response({ cover });
    }
    if (url === '/api/cover/design' && options.method === 'POST') {
      const body = JSON.parse(options.body); designPosts.push(body);
      return postDesign ? postDesign(body) : response({ success: true, design: body });
    }
    if (url === '/api/cover/candidates' && options.method === 'POST') {
      const body = JSON.parse(options.body); candidatePosts.push(body);
      return postCandidates ? postCandidates(body) : response({ success: true, design: body, candidates: coverCandidates() });
    }
    if (url === '/api/cover/select-candidate' && options.method === 'POST') {
      const body = JSON.parse(options.body); selectPosts.push(body);
      return postSelect ? postSelect(body) : response({ success: true, design: { title: '测试标题', subtitle: '', style: 'translucent-title-panel' }, candidates: coverCandidates(body.id) });
    }
    if (url === '/api/config') return response({ title: 'test', videoUrl: '/video.mp4', timelineMap: [] });
    if (url === '/api/comments') return response({ markers: [] });
    if (url === '/api/timeline') return response({ clips: [] });
    if (url === '/api/codex-status') return response({ state: 'idle' });
    throw new Error(`Unexpected request: ${url}`);
  };
  vm.runInNewContext(script, { document, window, fetch, console, setTimeout: () => 0, clearTimeout() {}, navigator: {}, URL, Blob, confirm: () => false }, { filename: 'preview_review.html' });
  await tick();
  video.dispatch('loadeddata');
  const key = (overrides = {}) => {
    const event = { target: video, code: 'KeyC', key: 'c', repeat: false, isComposing: false,
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides };
    for (const handler of window.handlers.keydown || []) handler(event);
    return event;
  };
  return { $, video, key, posts, designPosts, candidatePosts, selectPosts, requests, document, activate: () => $('viewer').dispatch('pointerdown'), flush: tick };
}

test('GET restores selected clean A-roll thumbnail, download and both times', async () => {
  const cover = selectedCover();
  const b = await browser({ cover });
  assert.equal(b.$('coverImage').src, cover.imageUrl);
  assert.equal(b.$('coverPreview').href, cover.imageUrl);
  assert.equal(b.$('coverPreview').hidden, false);
  assert.equal(b.$('coverDownload').href, cover.imageUrl);
  assert.equal(b.$('coverDownload').hidden, false);
  assert.match(b.$('coverTime').textContent, /Preview 00:12\.3 · 原片 00:56\.0/);
  assert.match(b.$('coverStatus').textContent, /纯 A-roll，无字幕和 B-roll/);
});

test('selected frame reveals title fields and defaults to 半透明标题底板', async () => {
  const b = await browser({ cover: selectedCover() });
  assert.equal(b.$('coverDesigner').hidden, false);
  assert.equal(b.$('coverTitleInput').value, '');
  assert.equal(b.$('coverSubtitleInput').value, '');
  assert.equal(b.$('coverStylePanel').classList.contains('active'), true);
  assert.equal(b.$('coverStylePanel').attributes['aria-checked'], 'true');
  assert.equal(b.$('coverStyleSmiley').attributes['aria-checked'], 'false');
  assert.match(b.$('coverStylePanel').textContent + template, /半透明标题底板/);
});

test('GET restores saved title, subtitle and 得意黑大字 style', async () => {
  const design = { title: '想科技创业的', subtitle: '第2天', style: 'smiley-bold' };
  const b = await browser({ getCover: () => response({ cover: selectedCover(), design }) });
  assert.equal(b.$('coverTitleInput').value, design.title);
  assert.equal(b.$('coverSubtitleInput').value, design.subtitle);
  assert.equal(b.$('coverStylePanel').attributes['aria-checked'], 'false');
  assert.equal(b.$('coverStyleSmiley').classList.contains('active'), true);
  assert.equal(b.$('coverStyleSmiley').attributes['aria-checked'], 'true');
});

test('style choice persists current fields and editable inputs never trigger viewer hotkeys', async () => {
  const b = await browser({ cover: selectedCover() }); b.activate();
  b.$('coverTitleInput').value = '拿 offer 简单';
  b.$('coverSubtitleInput').value = '成为拿 offer 的人，很难';
  await b.$('coverStyleSmiley').click();
  assert.deepEqual(b.designPosts, [{ title: '拿 offer 简单', subtitle: '成为拿 offer 的人，很难', style: 'smiley-bold' }]);
  for (const target of [b.$('coverTitleInput'), b.$('coverSubtitleInput')]) assert.equal(b.key({ target, code: 'Space', key: ' ' }).prevented, false);
  assert.equal(b.video.pauseCount, 0);
});

test('generate sends title design and renders two understandable candidates', async () => {
  const b = await browser({ cover: selectedCover() });
  b.$('coverTitleInput').value = '想科技创业的';
  b.$('coverSubtitleInput').value = '第2天';
  await b.$('coverGenerateBtn').click();
  assert.deepEqual(b.candidatePosts, [{ title: '想科技创业的', subtitle: '第2天', style: 'translucent-title-panel' }]);
  assert.equal(b.$('coverCandidates').hidden, false);
  assert.match(b.$('coverCandidates').innerHTML, /半透明标题底板/);
  assert.match(b.$('coverCandidates').innerHTML, /得意黑大字/);
  assert.match(b.$('coverCandidates').innerHTML, /采用此封面/);
  assert.match(b.$('coverCandidates').innerHTML, /下载 PNG/);
  assert.match(b.$('coverDesignStatus').textContent, /已生成 2 张候选/);
});

test('adopting a candidate posts its id and marks it selected without reloading', async () => {
  const b = await browser({
    cover: selectedCover(),
    getCover: () => response({ cover: selectedCover(), design: { title: '测试标题', subtitle: '', style: 'translucent-title-panel' }, candidates: coverCandidates() }),
  });
  const control = { dataset: { candidateId: 'smiley-1' }, closest: () => control };
  await b.$('coverCandidates').onclick({ target: control }); await b.flush();
  assert.deepEqual(b.selectPosts, [{ id: 'smiley-1' }]);
  assert.match(b.$('coverCandidates').innerHTML, /cover-candidate selected[^]*得意黑大字|得意黑大字[^]*已采用/);
  assert.match(b.$('coverDesignStatus').textContent, /已采用/);
});

test('button click pauses and sends only exact original Preview time', async () => {
  const b = await browser();
  await b.$('coverBtn').click();
  assert.equal(b.video.pauseCount, 1);
  assert.deepEqual(b.posts, [{ previewTime: 12.345 }]);
  assert.equal(b.$('coverImage').src, selectedCover().imageUrl);
  assert.equal(b.$('coverBtn').disabled, false);
  assert.equal(b.$('coverPanel').attributes['aria-busy'], 'false');
});

test('C selects the same cover only after viewer activation, also accepts Shift+C', async () => {
  const b = await browser();
  assert.equal(b.key().prevented, false);
  assert.equal(b.posts.length, 0);
  b.activate();
  const event = b.key(); await b.flush();
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.deepEqual(b.posts, [{ previewTime: 12.345 }]);
  b.video.currentTime = 24.567;
  b.key({ shiftKey: true, key: 'C' }); await b.flush();
  assert.deepEqual(b.posts[1], { previewTime: 24.567 });
});

test('copy shortcuts, composition, repeat and editable fields never select cover', async () => {
  const b = await browser(); b.activate();
  const editable = new Element(); editable.isContentEditable = true;
  for (const overrides of [
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { repeat: true },
    { isComposing: true }, { keyCode: 229 },
    { target: new Element('input') }, { target: b.$('comment') },
    { target: new Element('select') }, { target: editable },
  ]) assert.equal(b.key(overrides).prevented, false);
  await b.flush();
  assert.equal(b.posts.length, 0); assert.equal(b.video.pauseCount, 0);
});

test('busy lock blocks duplicate clicks and C; failure keeps previous image and download', async () => {
  let finish;
  const oldCover = selectedCover(2);
  const b = await browser({ cover: oldCover, postCover: () => new Promise(resolve => { finish = resolve; }) });
  b.activate();
  const pending = b.$('coverBtn').click();
  assert.equal(b.$('coverBtn').disabled, true);
  assert.equal(b.$('coverPanel').attributes['aria-busy'], 'true');
  assert.match(b.$('coverStatus').textContent, /正在提取/);
  b.$('coverBtn').click(); b.key();
  assert.equal(b.posts.length, 1);
  finish(response({ success: false, error: '原片映射缺失' }, 422)); await pending;
  assert.equal(b.$('coverBtn').disabled, false);
  assert.equal(b.$('coverImage').src, oldCover.imageUrl);
  assert.equal(b.$('coverDownload').href, oldCover.imageUrl);
  assert.match(b.$('coverStatus').textContent, /原片映射缺失.*已保留上次封面/);
  assert.equal(b.$('coverStatus').classList.contains('failed'), true);
});

test('slow initial GET cannot overwrite a newer POST selection', async () => {
  let finish;
  const b = await browser({ getCover: () => new Promise(resolve => { finish = resolve; }) });
  await b.$('coverBtn').click();
  finish(response({ cover: selectedCover(1) })); await b.flush();
  assert.equal(b.$('coverImage').src, selectedCover().imageUrl);
});

test('video must have a loaded and settled frame before capture', async () => {
  const b = await browser(); b.activate();
  for (const state of [{ readyState: 1, seeking: false, duration: 90 }, { readyState: 2, seeking: true, duration: 90 }, { readyState: 2, seeking: false, duration: NaN }]) {
    Object.assign(b.video, state); b.video.dispatch('seeking'); b.key();
    assert.equal(b.$('coverBtn').disabled, true);
  }
  assert.equal(b.posts.length, 0);
  Object.assign(b.video, { readyState: 2, seeking: false, duration: 90 }); b.video.dispatch('seeked');
  assert.equal(b.$('coverBtn').disabled, false);
  b.key(); await b.flush(); assert.equal(b.posts.length, 1);
});

test('GET failure stays local to cover panel; ordinary review page still loads', async () => {
  const b = await browser({ getCover: () => response({ error: 'read error' }, 500) });
  assert.match(b.$('coverStatus').textContent, /封面读取失败：read error/);
  assert.equal(b.$('title').textContent, 'test');
  assert.match(b.$('saveState').textContent, /已加载/);
});
