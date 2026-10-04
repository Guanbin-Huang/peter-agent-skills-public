#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const FPS = 30;
const TIMING_GUARD = path.resolve(__dirname, '../../clip-fine-cut-rhythm/scripts/verify_source_timing.py');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} 退出 ${code}`)));
  });
}

function freezeTimeline(source, keeps, speed) {
  if (!Number.isFinite(speed) || speed <= 0 || !Array.isArray(keeps) || !keeps.length) {
    throw new Error('源视频或剪辑计划无效');
  }
  let frame = 0;
  const segments = keeps.map((keep, index) => {
    const start = Number(keep.start);
    const end = Number(keep.end);
    const count = Math.round((end - start) / speed * FPS);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || count < 1) {
      throw new Error(`剪辑片段 ${index} 无效或不足一帧`);
    }
    const segment = {
      index, source_id: '01', start, end,
      output_start_frame: frame, output_frame_count: count,
      preview_start: frame / FPS, preview_end: (frame + count) / FPS,
    };
    frame += count;
    return segment;
  });
  return { fps: FPS, speed, sources: { '01': { path: path.resolve(source) } }, segments, total_frames: frame };
}

function tempoFilter(speed) {
  // Keep each atempo stage in its high-quality 0.5–2 range.
  const factors = [];
  while (speed > 2) { factors.push(2); speed /= 2; }
  while (speed < 0.5) { factors.push(0.5); speed *= 2; }
  factors.push(speed);
  return factors.map(factor => `atempo=${factor}`).join(',');
}

function buildFilter(keeps, speed) {
  const { segments } = freezeTimeline('.', keeps, speed);
  const filters = [];
  segments.forEach((segment, index) => {
    const start = segment.start.toFixed(9);
    const end = segment.end.toFixed(9);
    const outputLength = segment.output_frame_count / FPS;
    const fade = Math.min(0.005, outputLength / 4);
    // Resample AFTER speed changes. Resetting frame-number PTS before this
    // resampling would undo speed while an apparently correct duration survives.
    filters.push(`[0:v]trim=start=${start}:end=${end},settb=AVTB,setpts=(PTS-STARTPTS)/${speed},scale=270:480:flags=bicubic,fps=30:start_time=0:round=near,tpad=stop_mode=clone:stop_duration=${(2 / FPS).toFixed(9)},trim=end_frame=${segment.output_frame_count},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`);
    filters.push(`[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${tempoFilter(speed)},apad=pad_dur=${(2 / FPS).toFixed(9)},atrim=duration=${outputLength.toFixed(9)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fade.toFixed(6)},afade=t=out:st=${Math.max(0, outputLength - fade).toFixed(6)}:d=${fade.toFixed(6)}[a${index}]`);
  });
  const inputs = keeps.map((_, index) => `[v${index}][a${index}]`).join('');
  filters.push(`${inputs}concat=n=${keeps.length}:v=1:a=1[vcat][aout]`);
  filters.push('[vcat]settb=1/30[vout]');
  return filters.join(';');
}

function assertAllApproved(review) {
  const blocks = Array.isArray(review) ? review : review?.blocks;
  const unapproved = (blocks || []).filter(block => block.status !== 'approved');
  if (!blocks?.length || unapproved.length) {
    throw new Error(`流程一尚未全部通过：${blocks?.length - unapproved.length || 0}/${blocks?.length || 0}`);
  }
  return blocks;
}

function assertOutputPathsAbsent(paths) {
  for (const target of paths) {
    try {
      fs.lstatSync(target); // Include dangling symlinks: they are existing targets.
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(`输出已存在，请使用新的版本化文件名: ${target}`);
  }
}

function publishNoClobber(pairs, link = fs.linkSync) {
  const created = [];
  try {
    // The MP4 is last and acts as the commit point. linkSync is atomic and
    // refuses EEXIST even if another process creates a target after preflight.
    for (const [temporary, target] of pairs) {
      const identity = fs.lstatSync(temporary);
      link(temporary, target);
      created.push({ target, dev: identity.dev, ino: identity.ino });
    }
  } catch (error) {
    for (const item of created.reverse()) {
      try {
        const current = fs.lstatSync(item.target);
        // Remove only this transaction's links, never a replacement/old file.
        if (current.dev === item.dev && current.ino === item.ino) fs.unlinkSync(item.target);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          error.message += `; 发布回撤保留待检查文件 ${item.target}: ${cleanupError.message}`;
        }
      }
    }
    throw error;
  }
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  // Dependency injection is for tests; the CLI has no skip-verification switch.
  const runCommand = dependencies.run || run;
  const link = dependencies.link || fs.linkSync;
  const log = dependencies.log || console.log;
  const [sourceArg, planArg, reviewArg, outputArg] = args;
  if (!sourceArg || !planArg || !reviewArg || !outputArg) {
    throw new Error('用法: node render_approved_full_preview.js <source> <review_edit_plan.json> <review_blocks.json> <output.mp4>');
  }
  const source = path.resolve(sourceArg);
  const plan = JSON.parse(fs.readFileSync(path.resolve(planArg), 'utf8'));
  const review = JSON.parse(fs.readFileSync(path.resolve(reviewArg), 'utf8'));
  const output = path.resolve(outputArg);
  assertAllApproved(review);
  const finalTimeline = `${output}.timeline.json`;
  const finalReport = `${output}.timing-report.json`;
  assertOutputPathsAbsent([output, finalTimeline, finalReport]);
  if (!fs.existsSync(source)) throw new Error('源视频或剪辑计划无效');
  const keeps = plan.keeps || [];
  const speed = Number(plan.speed);
  const timeline = freezeTimeline(source, keeps, speed);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp.mp4`;
  const temporaryTimeline = `${temporary}.timeline.json`;
  const temporaryReport = `${temporary}.timing-report.json`;
  await runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'warning', '-stats', '-y', '-i', source,
    '-filter_complex', buildFilter(keeps, speed), '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
    '-r', '30', '-fps_mode', 'cfr', '-profile:v', 'high', '-level:v', '4.0',
    '-pix_fmt', 'yuv420p', '-video_track_timescale', '15360',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '44100',
    '-movflags', '+faststart', temporary,
  ]);
  fs.writeFileSync(temporaryTimeline, `${JSON.stringify(timeline, null, 2)}\n`);
  // A failed guard leaves the previous published video untouched. Keep failed
  // temporary artifacts for diagnosis rather than advertising a successful render.
  await runCommand('python3', [TIMING_GUARD, '--timeline', temporaryTimeline, '--video', temporary, '--report', temporaryReport]);
  publishNoClobber([[temporaryTimeline, finalTimeline], [temporaryReport, finalReport], [temporary, output]], link);
  log(`✅ 流程二完整 Preview（源时间映射已通过）: ${output}`);
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exit(1); });

module.exports = { buildFilter, freezeTimeline, assertAllApproved, main };
