#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { FILES: CALLBACK_FILES, createCallbackConfig } = require('./codex_callback');

const [previewVideo, reviewDir, editSummaryFile] = process.argv.slice(2);

if (!previewVideo || !reviewDir) {
  console.error('用法: node prepare_preview_review.js <preview_video> <review_dir> [edit_summary.json]');
  process.exit(1);
}

const videoPath = path.resolve(previewVideo);
const outputDir = path.resolve(reviewDir);
if (!fs.existsSync(videoPath)) {
  console.error(`❌ Preview 视频不存在: ${videoPath}`);
  process.exit(1);
}

let timelineMap = [];
let sourceVideo = null;
let speed = 1;
if (editSummaryFile) {
  const summaryPath = path.resolve(editSummaryFile);
  if (!fs.existsSync(summaryPath)) {
    console.error(`❌ 剪辑摘要不存在: ${summaryPath}`);
    process.exit(1);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  speed = Number(summary.speed) > 0 ? Number(summary.speed) : 1;
  const resolveSource = value => typeof value === 'string' && value ? path.resolve(path.dirname(summaryPath), value) : null;
  sourceVideo = resolveSource(summary.sourceVideo || summary.source);
  const sourceFor = keep => {
    const id = keep.sourceId ?? keep.source_id;
    const entry = summary.sources?.[id];
    return resolveSource(keep.sourcePath || keep.sourceVideo || (typeof entry === 'string' ? entry : entry?.path));
  };
  let previewCursor = 0;
  timelineMap = (summary.timelineMap || summary.keeps || summary.segments || []).map((keep, index) => {
    const sourceStart = Number(keep.sourceStart ?? keep.start);
    const sourceEnd = Number(keep.sourceEnd ?? keep.end);
    const segmentSpeed = Number(keep.speed) > 0 ? Number(keep.speed) : speed;
    const previewStart = Number(keep.previewStart ?? keep.preview_start ?? previewCursor);
    const previewEnd = Number(keep.previewEnd ?? keep.preview_end ?? (previewStart + (sourceEnd - sourceStart) / segmentSpeed));
    previewCursor = previewEnd;
    const sourcePath = sourceFor(keep);
    return { ...keep, index, previewStart, previewEnd, sourceStart, sourceEnd, speed: segmentSpeed,
      ...(sourcePath ? { sourcePath } : {}) };
  });
}

fs.mkdirSync(outputDir, { recursive: true });
const template = path.join(__dirname, 'templates', 'preview_review.html');
fs.copyFileSync(template, path.join(outputDir, 'preview_review.html'));
fs.copyFileSync(path.join(__dirname, 'preview_timeline.js'), path.join(outputDir, 'preview_timeline.js'));

const captionFontCandidates = [
  process.env.DOUYIN_CAPTIONS_FONT,
  path.resolve(__dirname, '..', '..', 'douyin-captions', 'assets', 'fonts', 'SmileySans-Oblique.ttf'),
  path.join(os.homedir(), '.codex', 'skills', 'douyin-captions', 'assets', 'fonts', 'SmileySans-Oblique.ttf'),
].filter(Boolean);
const captionFont = captionFontCandidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
if (!captionFont) {
  console.error('❌ Preview 封面生成需要得意黑字体 SmileySans-Oblique.ttf');
  process.exit(1);
}
const reviewFontsDir = path.join(outputDir, 'fonts');
fs.mkdirSync(reviewFontsDir, { recursive: true });
fs.copyFileSync(captionFont, path.join(reviewFontsDir, 'SmileySans-Oblique.ttf'));

const config = {
  version: 1,
  title: path.basename(videoPath, path.extname(videoPath)),
  previewVideo: videoPath,
  sourceVideo,
  speed,
  timelineMap,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(outputDir, 'preview_review_config.json'), JSON.stringify(config, null, 2));

function findCodexBin() {
  const candidates = [process.env.CODEX_BIN, '/Applications/ChatGPT.app/Contents/Resources/codex'].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return path.resolve(candidate);
  const found = spawnSync('sh', ['-lc', 'command -v codex'], { encoding: 'utf8' });
  return found.status === 0 && found.stdout.trim() ? path.resolve(found.stdout.trim()) : null;
}

const callbackConfigPath = path.join(outputDir, CALLBACK_FILES.config);
let previousCallback = null;
try { previousCallback = JSON.parse(fs.readFileSync(callbackConfigPath, 'utf8')); } catch (_) {}
const callbackConfig = createCallbackConfig({
  threadId: process.env.CODEX_THREAD_ID || '',
  codexBin: findCodexBin(),
  workspaceDir: process.env.CODEX_CALLBACK_WORKSPACE || process.cwd(),
  projectDir: path.dirname(outputDir),
  reviewDir: outputDir,
  previous: previousCallback,
});
fs.writeFileSync(callbackConfigPath, JSON.stringify(callbackConfig, null, 2));

const commentsPath = path.join(outputDir, 'preview_comments.json');
if (!fs.existsSync(commentsPath)) {
  fs.writeFileSync(commentsPath, JSON.stringify({
    version: 1,
    video: config.title,
    updatedAt: null,
    markers: [],
  }, null, 2));
}

const timelinePath = path.join(outputDir, 'preview_timeline.json');
if (!fs.existsSync(timelinePath)) {
  fs.writeFileSync(timelinePath, JSON.stringify({
    version: 1,
    video: config.title,
    sourceDuration: null,
    updatedAt: null,
    clips: [],
  }, null, 2));
}

console.log('✅ Preview 批注页已生成');
console.log(`   页面: ${path.join(outputDir, 'preview_review.html')}`);
console.log(`   批注: ${commentsPath}`);
console.log(`   试剪时间线: ${timelinePath}`);
console.log(`   时间映射: ${timelineMap.length ? `${timelineMap.length} 段` : '未提供（仅记录 Preview 时间）'}`);
console.log(`   Codex 回调: ${callbackConfig.enabled ? '独立精剪执行器已就绪' : `未启用（${callbackConfig.disabledReason}）`}`);
