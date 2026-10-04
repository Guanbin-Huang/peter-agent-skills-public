#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

let source = null;
let comments = null;
let decisions = null;
let targetDir = null;
let clipsDir = null;
let speed = 1;
let sourceDuration = Infinity;

function mergeRanges(ranges, duration = sourceDuration) {
  const sorted = ranges.map(item => ({ start: Math.max(0, Number(item.start)), end: Math.min(duration, Number(item.end)), reason: item.reason || '' }))
    .filter(item => item.end > item.start).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const item of sorted) {
    const last = merged[merged.length - 1];
    if (last && item.start <= last.end + .0001) { last.end = Math.max(last.end, item.end); last.reason = [last.reason, item.reason].filter(Boolean).join('；'); }
    else merged.push({ ...item });
  }
  return merged;
}

function complement(ranges, duration = sourceDuration) {
  const keeps = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) keeps.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < duration) keeps.push({ start: cursor, end: duration });
  return keeps;
}

function outputTimeAtSource(keeps, sourceTime, playbackSpeed = speed, duration = sourceDuration) {
  const time = Math.max(0, Math.min(duration, Number(sourceTime) || 0));
  let output = 0;
  for (const keep of keeps) {
    if (time <= keep.start) break;
    output += Math.max(0, Math.min(time, keep.end) - keep.start) / playbackSpeed;
    if (time <= keep.end) break;
  }
  return output;
}

function sliceOutputWindow(keeps, outputStart, outputEnd, playbackSpeed = speed) {
  const segments = [];
  let cursor = 0;
  for (const keep of keeps) {
    const outputLength = (keep.end - keep.start) / playbackSpeed;
    const keepOutputStart = cursor, keepOutputEnd = cursor + outputLength;
    const overlapStart = Math.max(outputStart, keepOutputStart), overlapEnd = Math.min(outputEnd, keepOutputEnd);
    if (overlapEnd > overlapStart + .0001) {
      segments.push({
        sourceStart: keep.start + (overlapStart - keepOutputStart) * playbackSpeed,
        sourceEnd: keep.start + (overlapEnd - keepOutputStart) * playbackSpeed,
      });
    }
    cursor = keepOutputEnd;
    if (cursor >= outputEnd) break;
  }
  return segments;
}

function blockFingerprint(block) {
  const payload = {
    editSummary: block.editSummary || '',
    sourceRanges: (block.sourceRanges || []).map(range => ({
      sourceStart: Number(Number(range.sourceStart).toFixed(3)),
      sourceEnd: Number(Number(range.sourceEnd).toFixed(3)),
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function reconcileReviewState(old = {}, next) {
  const fingerprint = blockFingerprint(next);
  const oldFingerprint = old.fingerprint || (old.sourceRanges?.length ? blockFingerprint(old) : null);
  const contentChanged = Boolean(old.id && oldFingerprint && oldFingerprint !== fingerprint);
  return {
    fingerprint,
    revision: contentChanged ? Number(old.revision || 1) + 1 : Number(old.revision || 1),
    status: contentChanged ? 'pending' : (old.status || 'pending'),
    reviewerComment: old.reviewerComment || '',
    reviewerCommentTime: old.reviewerCommentTime ?? null,
    reviewedAt: contentChanged ? null : (old.reviewedAt || null),
    revisionReason: contentChanged ? '审核片段内容已变化，旧通过状态自动失效' : (old.revisionReason || ''),
  };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} 退出 ${code}\n${stderr}`)));
  });
}

function filterForSegments(segments) {
  const parts = [];
  segments.forEach((segment, index) => {
    const sourceLength = segment.sourceEnd - segment.sourceStart;
    const outputLength = sourceLength / speed;
    const fade = Math.min(.005, outputLength / 4);
    parts.push(`[0:v]trim=start=${segment.sourceStart.toFixed(3)}:end=${segment.sourceEnd.toFixed(3)},setpts=(PTS-STARTPTS)/${speed},scale=270:480:flags=bicubic,format=yuv420p[v${index}]`);
    parts.push(`[0:a]atrim=start=${segment.sourceStart.toFixed(3)}:end=${segment.sourceEnd.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${speed},afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${Math.max(0, outputLength - fade).toFixed(3)}:d=${fade.toFixed(3)}[a${index}]`);
  });
  const inputs = segments.map((_, index) => `[v${index}][a${index}]`).join('');
  parts.push(`${inputs}concat=n=${segments.length}:v=1:a=1[vcat][a]`);
  parts.push('[vcat]fps=30[v]');
  return parts.join(';');
}

async function renderClip(block) {
  const output = path.join(targetDir, block.clipUrl);
  const temp = `${output}.tmp.mp4`;
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-filter_complex', filterForSegments(block.sourceRanges), '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', temp]);
  fs.renameSync(temp, output);
}

async function pool(items, limit, worker) {
  let cursor = 0;
  async function next() { while (cursor < items.length) { const item = items[cursor++]; await worker(item); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

async function build(args = process.argv.slice(2)) {
  const [sourceFile, commentsFile, decisionsFile, outputDir, onlyOrdersArg] = args;
  if (!sourceFile || !commentsFile || !decisionsFile || !outputDir) throw new Error('用法: node build_annotation_block_review.js <source_video> <preview_comments.json> <edit_decisions.json> <review_dir> [仅渲染序号，逗号分隔]');
  source = path.resolve(sourceFile);
  comments = JSON.parse(fs.readFileSync(path.resolve(commentsFile), 'utf8'));
  decisions = JSON.parse(fs.readFileSync(path.resolve(decisionsFile), 'utf8'));
  targetDir = path.resolve(outputDir);
  clipsDir = path.join(targetDir, 'review_clips');
  speed = Number(decisions.speed) > 0 ? Number(decisions.speed) : 1;
  sourceDuration = Number(decisions.sourceDuration);
  if (!fs.existsSync(source) || !Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error('输入视频或 sourceDuration 无效');
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'templates', 'annotation_block_review.html'), path.join(targetDir, 'annotation_block_review.html'));
  const cuts = mergeRanges(decisions.cuts || []);
  const keeps = complement(cuts);
  const fullOutputDuration = keeps.reduce((sum, keep) => sum + (keep.end - keep.start) / speed, 0);
  const decisionByMarker = new Map((decisions.reviews || []).map(item => [item.markerId, item]));
  const existingPath = path.join(targetDir, 'review_blocks.json');
  const existing = fs.existsSync(existingPath) ? JSON.parse(fs.readFileSync(existingPath, 'utf8')) : { blocks: [] };
  const existingById = new Map((existing.blocks || []).map(block => [block.id, block]));
  const blocks = (comments.markers || []).map((marker, index) => {
    const decision = decisionByMarker.get(marker.id) || decisions.reviews?.[index];
    if (!decision) throw new Error(`缺少第 ${index + 1} 条批注的 edit decision`);
    const anchorOutput = outputTimeAtSource(keeps, decision.anchorSourceTime ?? marker.sourceTime);
    let reviewStart = Math.max(0, anchorOutput - 5), reviewEnd = Math.min(fullOutputDuration, anchorOutput + 5);
    if (reviewEnd - reviewStart < 10) {
      if (reviewStart === 0) reviewEnd = Math.min(fullOutputDuration, 10);
      else if (reviewEnd === fullOutputDuration) reviewStart = Math.max(0, fullOutputDuration - 10);
    }
    const sourceRanges = sliceOutputWindow(keeps, reviewStart, reviewEnd);
    if (!sourceRanges.length) throw new Error(`第 ${index + 1} 条批注无法生成 review 范围`);
    const id = `review-${String(index + 1).padStart(2, '0')}-${marker.id}`;
    const old = existingById.get(id) || {};
    const next = {
      id, order: index + 1, markerId: marker.id, previewTime: marker.previewTime, sourceTime: marker.sourceTime,
      originalComment: marker.comment || '', editSummary: decision.editSummary || '已按批注修改',
      clipUrl: `review_clips/${String(index + 1).padStart(2, '0')}.mp4`, clipDuration: reviewEnd - reviewStart,
      anchorOutputTime: anchorOutput, reviewOutputStart: reviewStart, reviewOutputEnd: reviewEnd, sourceRanges,
    };
    return {
      ...next,
      ...reconcileReviewState(old, next),
    };
  });
  fs.writeFileSync(existingPath, JSON.stringify({ version: 1, video: decisions.video || path.basename(source), updatedAt: new Date().toISOString(), blocks }, null, 2));
  fs.writeFileSync(path.join(targetDir, 'review_edit_plan.json'), JSON.stringify({ version: 1, source, speed, sourceDuration, outputDuration: fullOutputDuration, cuts, keeps, blocks }, null, 2));
  const onlyOrders = new Set(String(onlyOrdersArg || '').split(',').map(Number).filter(Number.isInteger));
  const renderBlocks = onlyOrders.size ? blocks.filter(block => onlyOrders.has(block.order)) : blocks;
  if (!renderBlocks.length) throw new Error(`没有匹配需要渲染的板块: ${onlyOrdersArg}`);
  await pool(renderBlocks, 3, async block => { process.stdout.write(`渲染 ${block.order}/${blocks.length}... `); await renderClip(block); console.log('完成'); });
  console.log(`✅ 流程一审核包已生成: ${path.join(targetDir, 'annotation_block_review.html')}`);
  console.log(`   已渲染 ${renderBlocks.length}/${blocks.length} 个独立板块 · 完整版本预计 ${fullOutputDuration.toFixed(2)} 秒（尚未输出）`);
}

if (require.main === module) build().catch(error => { console.error(error.stack || error.message); process.exit(1); });

module.exports = { build, mergeRanges, complement, outputTimeAtSource, sliceOutputWindow, blockFingerprint, reconcileReviewState };
