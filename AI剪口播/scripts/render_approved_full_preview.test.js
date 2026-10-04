'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFilter, assertAllApproved } = require('./render_approved_full_preview');

test('full preview gate rejects any unresolved review block', () => {
  assert.throws(
    () => assertAllApproved({ blocks: [{ status: 'approved' }, { status: 'pending' }] }),
    /1\/2/,
  );
  assert.throws(
    () => assertAllApproved({ blocks: [{ status: 'approved' }, { status: 'changes_requested' }] }),
    /1\/2/,
  );
});

test('full preview gate accepts only an all-approved review set', () => {
  assert.equal(assertAllApproved({ blocks: [{ status: 'approved' }, { status: 'approved' }] }).length, 2);
});

test('full preview filter applies the same speed to video and audio', () => {
  const filter = buildFilter([{ start: 10, end: 20 }], 1.15);
  assert.match(filter, /setpts=\(PTS-STARTPTS\)\/1\.15/);
  assert.match(filter, /atempo=1\.15/);
  assert.match(filter, /fps=30/);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { freezeTimeline, main } = require('./render_approved_full_preview');

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
  return result.stdout;
}

function fixtureDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-source-timing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('timeline freezes integer frame boundaries per segment', () => {
  const timeline = freezeTimeline('/tmp/source.mov', [{ start: 0.123456, end: 3.78901 }, { start: 8, end: 9 }], 1.3);
  assert.equal(timeline.segments[0].output_frame_count, 85);
  assert.equal(timeline.segments[1].output_start_frame, 85);
  assert.equal(timeline.total_frames, 108);
  assert.equal(timeline.segments[1].preview_end, 108 / 30);
  assert.throws(() => freezeTimeline('/tmp/source.mov', [{ start: 1, end: 1 }], 1.3), /不足一帧/);
});

test('real numbered-frame fixture preserves 1.3x video speed and detects the legacy bad chain', t => {
  const directory = fixtureDirectory(t);
  const raw = path.join(directory, 'numbered.gray');
  const source = path.join(directory, 'numbered.mkv');
  const frames = Buffer.alloc(200 * 32 * 32);
  for (let n = 0; n < 200; n++) frames.fill(n, n * 32 * 32, (n + 1) * 32 * 32);
  fs.writeFileSync(raw, frames);
  ffmpeg(['-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', '32x32', '-framerate', '30', '-i', raw,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6.666666667',
    '-c:v', 'ffv1', '-c:a', 'pcm_s16le', source]);
  function outputSamples(filter, name) {
    const output = path.join(directory, name);
    ffmpeg(['-i', source, '-filter_complex', filter, '-map', '[vout]', '-map', '[aout]', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', output]);
    return ffmpeg(['-i', output, '-map', '0:v:0', '-vf', 'scale=1:1:flags=area,format=gray', '-f', 'rawvideo', 'pipe:1']);
  }
  const correct = outputSamples(buildFilter([{ start: 0, end: 200 / 30 }], 1.3), 'correct.mkv');
  const legacy = outputSamples('[0:v]fps=30,setpts=(PTS-STARTPTS)/1.3,trim=end_frame=154,setpts=N/(30*TB)[vout];[0:a]asetpts=PTS-STARTPTS,atempo=1.3,apad,atrim=duration=5.133333333[aout]', 'legacy.mkv');
  // Decode a same-colour-pipeline source reference: gray/YUV range conversion
  // can change the byte value, so compare frame identities, not raw luminance.
  const reference = ffmpeg(['-i', source, '-map', '0:v:0', '-vf', 'scale=270:480:flags=bicubic,format=yuv420p,scale=1:1:flags=area,format=gray', '-f', 'rawvideo', 'pipe:1']);
  const sourceIndex = sample => [...reference].reduce((best, value, index) => Math.abs(value - sample) < Math.abs(reference[best] - sample) ? index : best, 0);
  const correctIndex = sourceIndex(correct[100]);
  const legacyIndex = sourceIndex(legacy[100]);
  assert.equal(correct.length, 154);
  assert.equal(legacy.length, 154, 'duration alone must not distinguish the broken chain');
  assert.ok(Math.abs(correctIndex - 130) <= 2, `correct frame 100 maps to source ${correctIndex}, expected 130`);
  assert.ok(Math.abs(legacyIndex - 130) >= 25, `legacy should fail source-time mapping, got ${legacyIndex}`);
});

function renderFixture(t) {
  const directory = fixtureDirectory(t);
  const source = path.join(directory, 'source.mov');
  const plan = path.join(directory, 'plan.json');
  const review = path.join(directory, 'review.json');
  const output = path.join(directory, 'preview.mp4');
  fs.writeFileSync(source, 'source');
  fs.writeFileSync(plan, JSON.stringify({ keeps: [{ start: 0, end: 3 }], speed: 1.3 }));
  fs.writeFileSync(review, JSON.stringify({ blocks: [{ status: 'approved' }] }));
  return { args: [source, plan, review, output], output };
}

test('failed timing guard creates no published artifacts and emits no success', async t => {
  const { args, output } = renderFixture(t);
  const links = [];
  const logs = [];
  await assert.rejects(main(args, {
    async run(command, commandArgs) {
      if (command === 'ffmpeg') fs.writeFileSync(commandArgs.at(-1), 'bad-new-video');
      else {
        assert.equal(command, 'python3');
        assert.match(commandArgs[0], /clip-fine-cut-rhythm\/scripts\/verify_source_timing\.py$/);
        const timeline = JSON.parse(fs.readFileSync(commandArgs[commandArgs.indexOf('--timeline') + 1]));
        assert.equal(timeline.total_frames, 69);
        throw new Error('SOURCE_TIMING=FAIL');
      }
    },
    link: (...values) => links.push(values), log: value => logs.push(value),
  }), /SOURCE_TIMING=FAIL/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.timeline.json`), false);
  assert.equal(fs.existsSync(`${output}.timing-report.json`), false);
  assert.deepEqual(links, []);
  assert.deepEqual(logs, []);
});

test('successful timing guard runs before publishing video and frozen sidecars', async t => {
  const { args, output } = renderFixture(t);
  const events = [];
  await main(args, {
    async run(command, commandArgs) {
      events.push(command);
      if (command === 'ffmpeg') fs.writeFileSync(commandArgs.at(-1), 'verified-new-video');
      else fs.writeFileSync(commandArgs[commandArgs.indexOf('--report') + 1], JSON.stringify({ status: 'PASS' }));
    },
    link: (from, to) => { events.push('publish'); fs.linkSync(from, to); },
    log: () => events.push('success'),
  });
  assert.deepEqual(events, ['ffmpeg', 'python3', 'publish', 'publish', 'publish', 'success']);
  assert.equal(fs.readFileSync(output, 'utf8'), 'verified-new-video');
  assert.equal(JSON.parse(fs.readFileSync(`${output}.timeline.json`)).total_frames, 69);
});


async function fakeSuccessfulRender(command, args) {
  if (command === 'ffmpeg') fs.writeFileSync(args.at(-1), 'verified-new-video');
  else fs.writeFileSync(args[args.indexOf('--report') + 1], JSON.stringify({ status: 'PASS' }));
}

test('any existing output or sidecar requires a new version and stays untouched', async t => {
  for (const suffix of ['', '.timeline.json', '.timing-report.json']) {
    const { args, output } = renderFixture(t);
    const target = `${output}${suffix}`;
    fs.writeFileSync(target, 'existing-approved-artifact');
    let calls = 0;
    await assert.rejects(main(args, { run: async () => { calls++; } }), /新的版本化文件名/);
    assert.equal(calls, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), 'existing-approved-artifact');
  }
});

test('final MP4 publish failure rolls back only this transaction sidecars and retains temporaries', async t => {
  const { args, output } = renderFixture(t);
  const temporaries = [];
  const logs = [];
  await assert.rejects(main(args, {
    run: fakeSuccessfulRender,
    link: (from, to) => {
      temporaries.push(from);
      if (to === output) throw new Error('SIMULATED_FINAL_LINK_FAILURE');
      fs.linkSync(from, to);
    },
    log: value => logs.push(value),
  }), /SIMULATED_FINAL_LINK_FAILURE/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(`${output}.timeline.json`), false);
  assert.equal(fs.existsSync(`${output}.timing-report.json`), false);
  assert.ok(temporaries.every(file => fs.existsSync(file)));
  assert.deepEqual(logs, []);
});

test('a concurrently created MP4 is never overwritten and new sidecars are withdrawn', async t => {
  const { args, output } = renderFixture(t);
  await assert.rejects(main(args, {
    run: fakeSuccessfulRender,
    link: (from, to) => {
      if (to === output) fs.writeFileSync(output, 'concurrent-owner-video');
      fs.linkSync(from, to);
    },
    log: () => assert.fail('failed publish must not report success'),
  }), error => error.code === 'EEXIST');
  assert.equal(fs.readFileSync(output, 'utf8'), 'concurrent-owner-video');
  assert.equal(fs.existsSync(`${output}.timeline.json`), false);
  assert.equal(fs.existsSync(`${output}.timing-report.json`), false);
});

test('rollback preserves a sidecar replaced by another process', async t => {
  const { args, output } = renderFixture(t);
  const replacement = `${output}.replacement`;
  fs.writeFileSync(replacement, 'concurrent-owner-timeline');
  await assert.rejects(main(args, {
    run: fakeSuccessfulRender,
    link: (from, to) => {
      if (to === output) {
        fs.renameSync(replacement, `${output}.timeline.json`);
        throw new Error('SIMULATED_FINAL_LINK_FAILURE');
      }
      fs.linkSync(from, to);
    },
    log: () => assert.fail('failed publish must not report success'),
  }), /SIMULATED_FINAL_LINK_FAILURE/);
  assert.equal(fs.readFileSync(`${output}.timeline.json`, 'utf8'), 'concurrent-owner-timeline');
  assert.equal(fs.existsSync(`${output}.timing-report.json`), false);
  assert.equal(fs.existsSync(output), false);
});
