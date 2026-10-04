'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const {
  resolveCoverSource, selectCover, readCover,
  DEFAULT_COVER_STYLE, COVER_STYLES, readCoverDesign, saveCoverDesign,
  generateCoverCandidates, selectCoverCandidate,
} = require('./preview_cover');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-cover-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, `ffmpeg failed: ${result.error || result.stderr.toString()}`);
  return result.stdout;
}

function colorVideo(root, filename, color, duration = 4) {
  const file = path.join(root, filename);
  runFfmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=96x160:r=10:d=${duration}`, '-an', '-c:v', 'ffv1', file]);
  return file;
}

function assertColor(file, expected) {
  const pixels = runFfmpeg(['-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  assert.equal(pixels.length, 96 * 160 * 3, 'cover keeps the complete A-roll frame dimensions');
  for (let i = 0; i < pixels.length; i += 3) {
    const [r, g, b] = pixels.subarray(i, i + 3);
    if (expected === 'red') assert.ok(r > 220 && g < 25 && b < 25, `pixel ${i / 3} is not clean red: ${r},${g},${b}`);
    else assert.ok(b > 220 && r < 25 && g < 25, `pixel ${i / 3} is not clean blue: ${r},${g},${b}`);
  }
}

function coverPath(root, cover) {
  assert.match(cover.imageUrl, /^\/cover_frames\/[A-Za-z0-9_.-]+\.png(?:\?.*)?$/);
  return path.join(root, new URL(cover.imageUrl, 'http://localhost').pathname.slice(1));
}

function map(sourceVideo, segments) {
  return { sourceVideo, timelineMap: segments };
}

function segment(extra = {}) {
  return { previewStart: 0, previewEnd: 2, sourceStart: 1, sourceEnd: 3.6, speed: 1.3, ...extra };
}

function untouchedFiles(root) {
  const names = ['preview_comments.json', 'preview_timeline.json'];
  for (const name of names) fs.writeFileSync(path.join(root, name), ` { "fixture": "${name}", "keepBytes": true }\n`);
  const snapshots = names.map(name => [name, fs.readFileSync(path.join(root, name))]);
  return () => { for (const [name, before] of snapshots) assert.deepEqual(fs.readFileSync(path.join(root, name)), before, `${name} was changed by cover selection`); };
}

test('single-source cover mapping applies 1.3x speed without changing config', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'raw.mkv'), 'mapping fixture');
  const config = map('raw.mkv', [segment()]);
  const before = JSON.stringify(config);
  const selected = resolveCoverSource(config, 0.5, root, path.join(root, 'preview.mkv'));
  assert.equal(selected.sourceVideo, path.join(root, 'raw.mkv'));
  assert.ok(Math.abs(selected.sourceTime - 1.65) < 1e-9);
  assert.equal(selected.previewTime, 0.5);
  assert.equal(selected.segmentIndex, 0);
  assert.equal(JSON.stringify(config), before);
});

test('multi-source cut uses originalStart and half-open intervals instead of virtual sourceStart', t => {
  const root = fixture(t);
  for (const name of ['raw-a.mkv', 'raw-b.mkv']) fs.writeFileSync(path.join(root, name), 'mapping fixture');
  const config = map('virtual_source_map.json', [
    segment({ sourcePath: 'raw-a.mkv', originalStart: 0.2, originalEnd: 2.8, sourceStart: 100, sourceEnd: 102.6 }),
    segment({ previewStart: 2, previewEnd: 3, sourcePath: 'raw-b.mkv', originalStart: 0.7, originalEnd: 2, sourceStart: 500, sourceEnd: 501.3 }),
  ]);
  const beforeCut = resolveCoverSource(config, 1.999, root, 'preview.mkv');
  assert.equal(beforeCut.sourceVideo, path.join(root, 'raw-a.mkv'));
  assert.ok(Math.abs(beforeCut.sourceTime - 2.7987) < 1e-9);
  const atCut = resolveCoverSource(config, 2, root, 'preview.mkv');
  assert.equal(atCut.sourceVideo, path.join(root, 'raw-b.mkv'));
  assert.equal(atCut.sourceTime, 0.7);
  assert.equal(atCut.segmentIndex, 1);
  assert.throws(() => resolveCoverSource(config, 3, root, 'preview.mkv'));
});

test('cover mapping rejects gaps, end cards, absent mappings and invalid timestamps', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'raw.mkv'), 'mapping fixture');
  const config = map('raw.mkv', [segment(), segment({ previewStart: 3, previewEnd: 4, sourceStart: 0, sourceEnd: 1.3 })]);
  for (const value of [-1, NaN, Infinity, -Infinity, null, undefined, '0.5', '', false, [], {}]) {
    assert.throws(() => resolveCoverSource(config, value, root, 'preview.mkv'), `accepted invalid previewTime ${String(value)}`);
  }
  for (const value of [2, 2.5, 4, 5]) assert.throws(() => resolveCoverSource(config, value, root, 'preview.mkv'));
  assert.throws(() => resolveCoverSource({ sourceVideo: 'raw.mkv' }, 0, root, 'preview.mkv'));
  assert.throws(() => resolveCoverSource(map(null, [segment()]), 0, root, 'preview.mkv'));
});

test('cover mapping never falls back to Preview, including an explicit alias', t => {
  const root = fixture(t);
  const previewVideo = path.join(root, 'preview.mkv');
  fs.writeFileSync(previewVideo, 'mapping fixture');
  assert.throws(() => resolveCoverSource(map(null, [segment()]), 0, root, previewVideo));
  assert.throws(() => resolveCoverSource(map(previewVideo, [segment()]), 0, root, previewVideo));
  fs.symlinkSync(previewVideo, path.join(root, 'alias.mkv'));
  assert.throws(() => resolveCoverSource(map('alias.mkv', [segment()]), 0, root, previewVideo));
});

test('real extraction selects unadorned red/blue A-roll, not the green Preview, and persists selection', async t => {
  const root = fixture(t);
  const red = colorVideo(root, 'raw-red.mkv', 'red');
  const blue = colorVideo(root, 'raw-blue.mkv', 'blue');
  const previewVideo = colorVideo(root, 'preview-green.mkv', 'green');
  const unchanged = untouchedFiles(root);
  const config = map('virtual_source_map.json', [
    segment({ sourcePath: red, originalStart: 0.1, originalEnd: 2.7, sourceStart: 100, sourceEnd: 102.6 }),
    segment({ previewStart: 2, previewEnd: 3, sourcePath: blue, originalStart: 0.2, originalEnd: 1.5, sourceStart: 500, sourceEnd: 501.3 }),
  ]);
  assert.equal(readCover(root), null);
  for (const [previewTime, color, sourceTime, sourceVideo] of [[0.5, 'red', 0.75, red], [2, 'blue', 0.2, blue]]) {
    const cover = await selectCover({ root, config, previewTime, previewVideo });
    assert.equal(cover.kind, 'a-roll');
    assert.equal(cover.previewTime, previewTime);
    assert.ok(Math.abs(cover.sourceTime - sourceTime) < 1e-9);
    assert.equal(cover.sourceVideo, sourceVideo);
    assert.ok(Number.isFinite(Date.parse(cover.updatedAt)));
    assertColor(coverPath(root, cover), color);
    assert.deepEqual(readCover(root), cover);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'preview_cover.json'), 'utf8')), cover);
    unchanged();
  }
});

test('cover design defaults to translucent title panel and persists either supported style', t => {
  const root = fixture(t);
  const initial = readCoverDesign(root);
  assert.equal(initial.style, 'translucent-title-panel');
  assert.equal(DEFAULT_COVER_STYLE, 'translucent-title-panel');
  assert.deepEqual(COVER_STYLES.map(item => item.label), ['半透明标题底板', '得意黑大字']);
  const panel = saveCoverDesign(root, { title: '想科技创业第2天', subtitle: '带你成为具身智能行业的酥神' });
  assert.equal(panel.style, 'translucent-title-panel');
  const smiley = saveCoverDesign(root, { style: 'smiley-bold' });
  assert.equal(smiley.style, 'smiley-bold');
  assert.equal(smiley.title, panel.title);
  assert.equal(smiley.subtitle, panel.subtitle);
  assert.throws(() => saveCoverDesign(root, { style: 'not-a-style' }), /样式无效/);
});

test('candidate renderer creates both full-size PNG styles and remembers the adopted one', async t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'fonts'));
  fs.symlinkSync('/System/Library/Fonts/Supplemental/Arial Unicode.ttf', path.join(root, 'fonts', 'SmileySans-Oblique.ttf'));
  const raw = colorVideo(root, 'raw.mkv', 'red');
  await selectCover({ root, config: map(raw, [segment()]), previewTime: 0.5, previewVideo: path.join(root, 'preview.mkv') });
  const design = await generateCoverCandidates(root, { title: 'AI创业第2天', subtitle: '成为酥神' });
  assert.equal(design.style, 'translucent-title-panel');
  assert.equal(design.candidates.length, 2);
  assert.equal(design.candidates.filter(candidate => candidate.selected).length, 1);
  const buffers = design.candidates.map(candidate => fs.readFileSync(path.join(root, candidate.imageUrl.slice(1))));
  for (const bytes of buffers) {
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    assert.equal(bytes.readUInt32BE(16), 96);
    assert.equal(bytes.readUInt32BE(20), 160);
  }
  assert.notDeepEqual(buffers[0], buffers[1]);
  const smiley = design.candidates.find(candidate => candidate.style === 'smiley-bold');
  const selected = selectCoverCandidate(root, smiley.id);
  assert.equal(selected.style, 'smiley-bold');
  assert.equal(selected.selectedCandidateId, smiley.id);
  assert.equal(readCoverDesign(root).candidates.find(candidate => candidate.id === smiley.id).selected, true);
});

test('real extraction follows intra-source 1.3x timing through a color change', async t => {
  const root = fixture(t);
  const raw = path.join(root, 'changing.mkv');
  runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=96x160:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=96x160:r=10:d=3', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[out]', '-map', '[out]', '-c:v', 'ffv1', raw]);
  const config = map(raw, [segment({ sourceStart: 0.3, sourceEnd: 2.9 })]);
  const cover = await selectCover({ root, config, previewTime: 0.6, previewVideo: path.join(root, 'unused-preview.mkv') });
  assert.ok(Math.abs(cover.sourceTime - 1.08) < 1e-9);
  assertColor(coverPath(root, cover), 'blue');
});

for (const [previewTime, sourceFrameTime, color] of [[0.99, 0.9, 'red'], [1.99, 1.9, 'blue']]) {
  test(`cover uses displayed source frame at ${previewTime}s (PTS ${sourceFrameTime}), including final frame`, async t => {
    const root = fixture(t);
    const raw = path.join(root, 'frame-boundary.mkv');
    runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=96x160:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=96x160:r=10:d=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[out]', '-map', '[out]', '-c:v', 'ffv1', raw]);
    const config = map(raw, [segment({ sourceStart: 0, sourceEnd: 2, speed: 1 })]);
    const cover = await selectCover({ root, config, previewTime, previewVideo: path.join(root, 'unused-preview.mkv') });
    assert.equal(cover.sourceTime, previewTime, 'retain the requested mapped time');
    assert.ok(Math.abs(cover.sourceFrameTime - sourceFrameTime) < 1e-9, 'record the actual displayed source frame PTS');
    assertColor(coverPath(root, cover), color);
    assert.deepEqual(readCover(root), cover);
  });
}

test('source frame selection uses container start when video begins later than audio', async t => {
  const root = fixture(t);
  const raw = path.join(root, 'offset-source.mkv');
  runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=96x160:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=96x160:r=10:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=3', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,settb=1/1000,setpts=PTS+250[out]', '-map', '[out]', '-map', '2:a', '-vsync', '0', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', raw]);
  const config = map(raw, [segment({ previewEnd: 2.25, sourceStart: 0, sourceEnd: 2.25, speed: 1 })]);
  const cover = await selectCover({ root, config, previewTime: 1.24, previewVideo: path.join(root, 'unused-preview.mkv') });
  assert.equal(cover.sourceTime, 1.24);
  assert.ok(Math.abs(cover.sourceFrameTime - 1.15) < 1e-9, 'actual PTS follows the container playback clock, not video stream start');
  assertColor(coverPath(root, cover), 'red');
  assert.deepEqual(readCover(root), cover);
});

test('failed extraction preserves prior cover metadata/image and all comments/timeline bytes', async t => {
  const root = fixture(t);
  const red = colorVideo(root, 'raw-red.mkv', 'red');
  const previewVideo = colorVideo(root, 'preview-green.mkv', 'green');
  const config = map(red, [segment()]);
  const unchanged = untouchedFiles(root);
  const cover = await selectCover({ root, config, previewTime: 0.2, previewVideo });
  const image = coverPath(root, cover);
  const imageBefore = fs.readFileSync(image);
  const metadataBefore = fs.readFileSync(path.join(root, 'preview_cover.json'));
  const corrupt = path.join(root, 'corrupt.mkv');
  fs.writeFileSync(corrupt, 'not a video');
  for (const args of [
    { config, previewTime: 2 },
    { config: map(path.join(root, 'missing.mkv'), [segment()]), previewTime: 0.2 },
    { config: map(corrupt, [segment()]), previewTime: 0.2 },
  ]) {
    await assert.rejects(() => selectCover({ root, previewVideo, ...args }));
    assert.deepEqual(fs.readFileSync(image), imageBefore);
    assert.deepEqual(fs.readFileSync(path.join(root, 'preview_cover.json')), metadataBefore);
    assert.deepEqual(readCover(root), cover);
    unchanged();
  }
});

async function startServer(root, previewVideo, t) {
  const serverModule = path.join(__dirname, 'preview_review_server.js');
  const code = `const server = require(${JSON.stringify(serverModule)}).createServer();server.listen(0,'127.0.0.1',()=>console.log('TEST_PORT='+server.address().port));`;
  const child = spawn(process.execPath, ['-e', code, 'cover-test-server', '0', previewVideo], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  });
  return await new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error(`test server did not start: ${stderr}`)), 5000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`test server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const matched = stdout.match(/TEST_PORT=(\d+)/);
      if (matched) { clearTimeout(timeout); resolve(`http://127.0.0.1:${matched[1]}`); }
    });
  });
}

test('HTTP cover API returns clean PNG, remembers selection and rejects bad times without side effects', async t => {
  const root = fixture(t);
  const raw = colorVideo(root, 'raw.mkv', 'red');
  const previewVideo = colorVideo(root, 'preview.mkv', 'green');
  fs.writeFileSync(path.join(root, 'preview_review_config.json'), JSON.stringify(map(raw, [segment()])));
  const unchanged = untouchedFiles(root);
  const base = await startServer(root, previewVideo, t);
  const get = await fetch(`${base}/api/cover`);
  assert.equal(get.status, 200);
  const initial = await get.json();
  assert.equal(initial.cover, null);
  assert.equal(initial.design.style, 'translucent-title-panel');
  assert.deepEqual(initial.design.candidates, []);
  const selected = await fetch(`${base}/api/cover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ previewTime: 0.5 }) });
  assert.equal(selected.status, 200);
  const body = await selected.json();
  assert.equal(body.success, true);
  assert.equal(body.cover.kind, 'a-roll');
  const served = await fetch(`${base}${body.cover.imageUrl}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type'), /^image\/png/);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), fs.readFileSync(coverPath(root, body.cover)));
  assertColor(coverPath(root, body.cover), 'red');
  assert.deepEqual((await (await fetch(`${base}/api/cover`)).json()).cover, body.cover);
  for (const bad of [{}, { previewTime: null }, { previewTime: '0.5' }, { previewTime: -1 }, { previewTime: 2 }]) {
    const response = await fetch(`${base}/api/cover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
    assert.deepEqual(readCover(root), body.cover);
    unchanged();
  }
});

test('stale mapping beyond actual video duration does not reuse the final frame', async t => {
  const root = fixture(t);
  const raw = colorVideo(root, 'raw-short.mkv', 'red', 2);
  const config = map(raw, [segment({ sourceStart: 0, sourceEnd: 3, previewEnd: 3, speed: 1 })]);
  const args = { root, config, previewVideo: path.join(root, 'preview.mkv') };
  const old = await selectCover({ ...args, previewTime: 1.99 });
  await assert.rejects(() => selectCover({ ...args, previewTime: 2.2 }), /范围|显示帧/);
  assert.deepEqual(readCover(root), old);
});
