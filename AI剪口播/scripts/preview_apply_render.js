'use strict';

/**
 * INPUT: immutable full preview, per-edit ASS overlays, explicit fonts directory.
 * OUTPUT: renderAppliedPreview(), verified full.mp4 and verification.json.
 * POS: deterministic apply renderer; the caller owns approval/version state.
 * No clip concatenation, trimming, speed change, timestamp reset or audio encode.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const TOLERANCE_SECONDS = 1e-6;

function command(binary, args, { cwd, onLine, record } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', failed = false;
    const entry = { binary, args, cwd: cwd || null, exitStatus: null };
    if (record) record.push(entry);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 128 * 1024 * 1024) {
        failed = true; child.kill();
      }
      if (onLine) {
        pending += chunk;
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) onLine(line);
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-128 * 1024); });
    child.on('error', error => { entry.error = error.message; reject(error); });
    child.on('close', (code, signal) => {
      entry.exitStatus = code; entry.signal = signal; entry.stderr = stderr;
      if (failed) return reject(new Error(`${binary} output exceeded 128 MiB`));
      if (code !== 0) return reject(new Error(`${binary} exited ${code}: ${stderr.slice(-6000)}`));
      resolve(stdout);
    });
  });
}

async function probe(file, commands) {
  return JSON.parse(await command('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ], { record: commands }));
}

async function framePts(file, commands) {
  const result = JSON.parse(await command('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=pts,pkt_pts', '-of', 'json', file,
  ], { record: commands }));
  if (!result.frames?.length) throw new Error('Video has no decoded frames');
  return result.frames.map((frame, index) => {
    // ffprobe 4 names this pkt_pts; newer versions expose the same value as pts.
    const pts = frame.pts ?? frame.pkt_pts;
    if (!Number.isSafeInteger(pts)) throw new Error(`Missing/invalid video PTS at frame ${index}`);
    return pts;
  });
}

async function audioPackets(file, commands) {
  const result = JSON.parse(await command('ffprobe', [
    '-v', 'error', '-select_streams', 'a', '-show_packets', '-show_data_hash', 'sha256',
    '-show_entries', 'packet=stream_index,pts,dts,duration,data_hash', '-of', 'json', file,
  ], { record: commands }));
  return result.packets || [];
}

function timeBase(value) {
  const parts = String(value).split('/').map(Number);
  if (parts.length !== 2 || !parts.every(Number.isSafeInteger) || parts.some(n => n <= 0)) {
    throw new Error(`Invalid time base: ${value}`);
  }
  return { numerator: parts[0], denominator: parts[1], seconds: parts[0] / parts[1] };
}

function compareFrames(inputPts, outputPts, inputStream, outputStream) {
  if (inputPts.length !== outputPts.length) {
    throw new Error(`Video frame count changed: ${inputPts.length} -> ${outputPts.length}`);
  }
  const inputTb = timeBase(inputStream.time_base), outputTb = timeBase(outputStream.time_base);
  let maxDeltaSeconds = 0;
  for (let i = 0; i < inputPts.length; i++) {
    const delta = Math.abs(inputPts[i] * inputTb.seconds - outputPts[i] * outputTb.seconds);
    maxDeltaSeconds = Math.max(maxDeltaSeconds, delta);
    if (delta > TOLERANCE_SECONDS) throw new Error(`Video PTS changed at frame ${i}: ${delta}s`);
  }
  return {
    passed: true, frameCount: inputPts.length, toleranceSeconds: TOLERANCE_SECONDS,
    maxDeltaSeconds, inputTimeBase: inputStream.time_base, outputTimeBase: outputStream.time_base,
    inputSequenceSha256: hash(inputPts), outputSequenceSha256: hash(outputPts),
  };
}

function compareAudio(inputPackets, outputPackets, inputStreams, outputStreams) {
  if (inputStreams.length !== outputStreams.length) throw new Error('Audio stream count changed');
  if (inputPackets.length !== outputPackets.length) {
    throw new Error(`Audio packet count changed: ${inputPackets.length} -> ${outputPackets.length}`);
  }
  let maxDeltaSeconds = 0;
  const streams = inputStreams.map((source, index) => {
    const output = outputStreams[index];
    if (source.codec_name !== output.codec_name || source.sample_rate !== output.sample_rate || source.channels !== output.channels) {
      throw new Error(`Audio codec parameters changed at stream ${index}`);
    }
    const before = inputPackets.filter(packet => packet.stream_index === source.index);
    const after = outputPackets.filter(packet => packet.stream_index === output.index);
    if (before.length !== after.length) throw new Error(`Audio stream ${index} packet count changed`);
    const sourceTb = timeBase(source.time_base), outputTb = timeBase(output.time_base);
    for (let i = 0; i < before.length; i++) {
      if (!before[i].data_hash || before[i].data_hash !== after[i].data_hash) {
        throw new Error(`Audio content changed at stream ${index}, packet ${i}`);
      }
      for (const field of ['pts', 'dts', 'duration']) {
        if (!Number.isSafeInteger(before[i][field]) || !Number.isSafeInteger(after[i][field])) {
          throw new Error(`Missing audio ${field} at stream ${index}, packet ${i}`);
        }
        const delta = Math.abs(before[i][field] * sourceTb.seconds - after[i][field] * outputTb.seconds);
        maxDeltaSeconds = Math.max(maxDeltaSeconds, delta);
        if (delta > TOLERANCE_SECONDS) throw new Error(`Audio ${field} changed at stream ${index}, packet ${i}`);
      }
    }
    return {
      stream: index, codec: source.codec_name, packetCount: before.length,
      inputTimeBase: source.time_base, outputTimeBase: output.time_base,
      inputSequenceSha256: hash(before.map(({ stream_index, ...packet }) => packet)),
      outputSequenceSha256: hash(after.map(({ stream_index, ...packet }) => packet)),
    };
  });
  return { passed: true, packetCount: inputPackets.length, maxDeltaSeconds, streams };
}

async function regularFile(file, description) {
  if (!file || !(await fsp.stat(file)).isFile()) throw new Error(`${description} must be a file`);
  return path.resolve(file);
}

/** Publishes only after full decode, every frame PTS and every audio packet match. */
async function renderAppliedPreview({ baseVideo, assFiles = [], fontsDir, outputDir, onProgress } = {}) {
  baseVideo = await regularFile(baseVideo, 'baseVideo');
  if (!Array.isArray(assFiles)) throw new Error('assFiles must be an array');
  assFiles = await Promise.all(assFiles.map(file => regularFile(file, 'ASS overlay')));
  if (assFiles.length && (!fontsDir || !(await fsp.stat(fontsDir)).isDirectory())) {
    throw new Error('fontsDir must be an explicit directory');
  }
  if (typeof outputDir !== 'string' || !outputDir) throw new Error('outputDir is required');
  outputDir = path.resolve(outputDir);
  await fsp.mkdir(outputDir, { recursive: true });
  const videoFile = path.join(outputDir, 'full.mp4');
  const verificationFile = path.join(outputDir, 'verification.json');
  for (const file of [videoFile, verificationFile]) {
    if (fs.existsSync(file)) throw new Error(`Refusing to overwrite existing output: ${file}`);
  }
  const lockFile = path.join(outputDir, '.render.lock');
  const lock = await fsp.open(lockFile, 'wx');
  const commands = [], startedAt = new Date().toISOString();
  const progress = (stage, progressFrames, totalFrames) => {
    try { onProgress?.({ progressFrames, totalFrames, stage }); } catch (_) { /* UI listeners cannot invalidate rendering. */ }
  };
  let workDir, published = false;
  try {
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'preview-apply-'));
    const temporaryFile = path.join(outputDir, '.full-rendering.mp4');
    progress('probing', 0, 0);
    const input = await probe(baseVideo, commands);
    const inputVideo = input.streams.find(stream => stream.codec_type === 'video');
    if (!inputVideo) throw new Error('baseVideo has no video stream');
    const inputPts = await framePts(baseVideo, commands);
    const inputAudio = await audioPackets(baseVideo, commands);
    const totalFrames = inputPts.length;
    if (assFiles.length) {
      await fsp.symlink(path.resolve(fontsDir), path.join(workDir, 'fonts'), 'dir');
      // ASS PlayRes coordinates scale to the target frame. Resize before libass
      // so full-resolution overlays do not double the preview rendering work.
      // No setsar override: the scale filter preserves the source display ratio.
      const filters = ["scale=w='trunc(min(540,iw)/2)*2':h=-2:flags=lanczos"];
      for (let i = 0; i < assFiles.length; i++) {
        const name = `overlay-${i}.ass`;
        await fsp.copyFile(assFiles[i], path.join(workDir, name));
        filters.push(`ass=filename=${name}:fontsdir=fonts`);
      }
      const tb = timeBase(inputVideo.time_base);
      if (tb.denominator % tb.numerator !== 0) throw new Error(`Unsupported MP4 video time base: ${inputVideo.time_base}`);
      progress('rendering', 0, totalFrames);
      await command('ffmpeg', [
        '-hide_banner', '-v', 'warning', '-nostdin', '-n', '-copyts', '-i', baseVideo,
        '-map', '0:v:0', '-map', '0:a?', '-vf', filters.join(','),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-fps_mode:v', 'passthrough', '-enc_time_base:v', inputVideo.time_base,
        '-video_track_timescale', String(tb.denominator / tb.numerator),
        '-c:a', 'copy', '-avoid_negative_ts', 'disabled', '-movflags', '+faststart',
        '-progress', 'pipe:1', '-nostats', temporaryFile,
      ], {
        cwd: workDir, record: commands,
        onLine: line => { const match = /^frame=(\d+)/.exec(line); if (match) progress('rendering', Number(match[1]), totalFrames); },
      });
    } else {
      progress('copying', 0, totalFrames);
      await fsp.copyFile(baseVideo, temporaryFile, fs.constants.COPYFILE_EXCL);
    }
    progress('verifying', totalFrames, totalFrames);
    await command('ffmpeg', [
      '-hide_banner', '-v', 'error', '-nostdin', '-xerror', '-err_detect', 'explode',
      '-i', temporaryFile, '-map', '0:v:0', '-map', '0:a?', '-f', 'null', '-',
    ], { record: commands });
    const output = await probe(temporaryFile, commands);
    const outputVideo = output.streams.find(stream => stream.codec_type === 'video');
    const outputPts = await framePts(temporaryFile, commands);
    const outputAudio = await audioPackets(temporaryFile, commands);
    const video = compareFrames(inputPts, outputPts, inputVideo, outputVideo);
    const audio = compareAudio(inputAudio, outputAudio,
      input.streams.filter(stream => stream.codec_type === 'audio'),
      output.streams.filter(stream => stream.codec_type === 'audio'));
    const duration = Number(outputVideo.duration ?? output.format.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Output duration is invalid');
    const verification = {
      schemaVersion: 1, passed: true, identityTimeline: true, startedAt, completedAt: new Date().toISOString(),
      baseVideo, assFiles, fontsDir: fontsDir ? path.resolve(fontsDir) : null, videoFile,
      fullDecode: { passed: true, exitStatus: 0 }, video, audio,
      output: { width: outputVideo.width, height: outputVideo.height, sampleAspectRatio: outputVideo.sample_aspect_ratio,
        duration, frameCount: outputPts.length },
      commands,
    };
    // Hard-link publication is an atomic no-overwrite move on the same filesystem.
    // This also prevents a concurrent/external writer being replaced by rename().
    const verificationTemp = path.join(outputDir, '.verification-rendering.json');
    await fsp.writeFile(verificationTemp, JSON.stringify(verification, null, 2) + '\n', { flag: 'wx' });
    await fsp.link(verificationTemp, verificationFile);
    try { await fsp.link(temporaryFile, videoFile); } catch (error) {
      await fsp.unlink(verificationFile); throw error;
    }
    published = true;
    await fsp.unlink(temporaryFile);
    await fsp.unlink(verificationTemp);
    progress('completed', totalFrames, totalFrames);
    return { videoFile, duration, frameCount: outputPts.length, identityTimeline: true, verificationFile };
  } catch (error) {
    if (!published) {
      const failure = { schemaVersion: 1, passed: false, startedAt, failedAt: new Date().toISOString(), error: error.message, commands };
      await fsp.writeFile(path.join(outputDir, 'render-failure.json'), JSON.stringify(failure, null, 2) + '\n').catch(() => {});
    }
    throw error;
  } finally {
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true });
    await lock.close();
    await fsp.unlink(lockFile).catch(() => {});
  }
}

module.exports = { renderAppliedPreview };
