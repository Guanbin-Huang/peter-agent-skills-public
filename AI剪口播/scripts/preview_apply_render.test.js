'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { renderAppliedPreview } = require('./preview_apply_render');

const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,40,&H0000FFFF,&H0000FFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,5,10,10,10,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.20,0:00:01.80,Default,,0,0,0,,APPROVED EDIT
Dialogue: 1,0:00:00.20,0:00:01.80,Default,,0,0,0,,{\\an7\\pos(80,280)\\bord0\\shad0\\1c&H0000FF&\\p1}m 0 0 l 80 0 80 40 0 40
`;

async function fixture(t, { offset = false, black = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "apply-render-中文 ' 空格-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const baseVideo = path.join(root, "原片 ' base.mp4");
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', black
      ? 'color=c=black:size=640x360:rate=30:duration=2' : 'testsrc2=size=640x360:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-video_track_timescale', '15360',
    '-c:a', 'aac', ...(offset ? ['-output_ts_offset', '0.5'] : []), baseVideo,
  ]);
  const assFile = path.join(root, "批注 ' overlay.ass");
  await fs.writeFile(assFile, ass);
  const fontsDir = path.join(root, "字体 ' fonts");
  await fs.mkdir(fontsDir);
  return { root, baseVideo, assFiles: [assFile], fontsDir, outputDir: path.join(root, "新版 ' output") };
}

test('overlay renders full video; every source frame PTS and audio packet remain exact', { timeout: 30000 }, async t => {
  const f = await fixture(t, { black: true }), updates = [];
  const result = await renderAppliedPreview({ ...f, onProgress: event => updates.push(event) });
  assert.equal(result.frameCount, 60);
  assert.equal(result.identityTimeline, true);
  assert.equal(result.duration, 2);
  const v = JSON.parse(await fs.readFile(result.verificationFile, 'utf8'));
  assert.equal(v.passed, true);
  assert.equal(v.fullDecode.exitStatus, 0);
  assert.equal(v.video.maxDeltaSeconds, 0);
  assert.equal(v.video.inputSequenceSha256, v.video.outputSequenceSha256);
  assert.equal(v.audio.maxDeltaSeconds, 0);
  assert(v.audio.packetCount > 80);
  assert.equal(v.audio.streams[0].inputSequenceSha256, v.audio.streams[0].outputSequenceSha256);
  assert.equal(v.output.width, 540);
  assert.equal(v.output.height, 304);
  assert(updates.some(event => event.stage === 'rendering' && event.progressFrames > 0));
  assert.equal(updates.at(-1).stage, 'completed');
  const render = v.commands.find(item => item.args.includes('libx264'));
  assert(render.args.includes('-copyts'));
  assert.equal(render.args[render.args.indexOf('-c:a') + 1], 'copy');
  assert(!render.args.includes('-t') && !render.args.includes('-ss'));
  assert.match(render.args[render.args.indexOf('-vf') + 1], /^scale=.*:flags=lanczos,ass=/);
  const { stdout: rgb } = await exec('ffmpeg', [
    '-v', 'error', '-ss', '1', '-i', result.videoFile, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { encoding: 'buffer' });
  let yellowPixels = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    if (rgb[i] > 150 && rgb[i + 1] > 150 && rgb[i + 2] < 100) yellowPixels++;
  }
  assert(yellowPixels > 100, `Overlay must be visible, found ${yellowPixels} yellow pixels on black source`);
  // Compare font/vector placement with the old ASS-then-scale pipeline, not
  // merely the presence of an ASS argument. Antialiasing may differ by 2 px.
  await fs.copyFile(f.assFiles[0], path.join(f.root, 'reference.ass'));
  const { stdout: reference } = await exec('ffmpeg', [
    '-v', 'error', '-i', f.baseVideo, '-vf', 'ass=filename=reference.ass,scale=540:-2:flags=lanczos',
    '-ss', '1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { cwd: f.root, encoding: 'buffer' });
  const bounds = (pixels, predicate) => {
    const result = [Infinity, Infinity, -1, -1];
    for (let i = 0; i < pixels.length; i += 3) {
      if (!predicate(pixels[i], pixels[i + 1], pixels[i + 2])) continue;
      const x = (i / 3) % 540, y = Math.floor(i / 3 / 540);
      result[0] = Math.min(result[0], x); result[1] = Math.min(result[1], y);
      result[2] = Math.max(result[2], x); result[3] = Math.max(result[3], y);
    }
    assert(result.every(Number.isFinite) && result[2] >= 0);
    return result;
  };
  for (const [name, predicate] of [
    ['text', (r, g, b) => r > 150 && g > 150 && b < 100],
    ['vector', (r, g, b) => r > 150 && g < 100 && b < 100],
  ]) {
    const actual = bounds(rgb, predicate), expected = bounds(reference, predicate);
    assert(actual.every((value, index) => Math.abs(value - expected[index]) <= 2),
      `${name} placement changed: ${actual} vs ${expected}`);
  }
});

test('non-zero source PTS survives without a timestamp reset', { timeout: 30000 }, async t => {
  const f = await fixture(t, { offset: true });
  const result = await renderAppliedPreview(f);
  const v = JSON.parse(await fs.readFile(result.verificationFile, 'utf8'));
  assert.equal(v.video.frameCount, 60);
  assert.equal(v.video.maxDeltaSeconds, 0);
  assert.equal(v.audio.maxDeltaSeconds, 0);
});

test('no overlays copies the base byte for byte and refuses to overwrite a published version', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const result = await renderAppliedPreview({ ...f, assFiles: [] });
  const expected = await fs.readFile(f.baseVideo);
  assert.deepEqual(await fs.readFile(result.videoFile), expected);
  await assert.rejects(renderAppliedPreview(f), /Refusing to overwrite/);
  assert.deepEqual(await fs.readFile(result.videoFile), expected);
});

test('bad ASS never publishes full.mp4 and records the failed command', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.assFiles[0], 'not valid ASS');
  await assert.rejects(renderAppliedPreview(f), /ffmpeg exited/);
  await assert.rejects(fs.stat(path.join(f.outputDir, 'full.mp4')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(f.outputDir, 'verification.json')), { code: 'ENOENT' });
  const failed = JSON.parse(await fs.readFile(path.join(f.outputDir, 'render-failure.json'), 'utf8'));
  assert.equal(failed.passed, false);
  assert(failed.commands.some(item => item.exitStatus !== 0));
});
