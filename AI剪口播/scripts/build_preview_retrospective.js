#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function fileEvidence(file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const body = fs.readFileSync(file);
  return {
    path: path.resolve(file),
    bytes: body.length,
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    modifiedAt: fs.statSync(file).mtime.toISOString(),
  };
}

function markerSummary(comments) {
  const markers = Array.isArray(comments?.markers) ? comments.markers : [];
  return markers.map(marker => ({
    id: marker.id || null,
    previewTime: Number.isFinite(Number(marker.previewTime)) ? Number(marker.previewTime) : null,
    sourceTime: Number.isFinite(Number(marker.sourceTime)) ? Number(marker.sourceTime) : null,
    category: marker.category || '其他',
    comment: marker.comment || '',
    scopeMode: marker.scopeMode || (marker.global ? 'global' : 'local'),
    resolved: Boolean(marker.resolved),
  }));
}

function isReviewDir(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
  return fs.existsSync(path.join(dir, 'preview_review_config.json'))
    || fs.existsSync(path.join(dir, 'preview_comments.json'))
    || fs.existsSync(path.join(dir, 'codex_runs'));
}

function findReviewDirs(target) {
  const resolved = path.resolve(target);
  if (isReviewDir(resolved)) return [resolved];
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return [];
  return fs.readdirSync(resolved, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('4_Preview'))
    .map(entry => path.join(resolved, entry.name))
    .filter(isReviewDir)
    .sort();
}

function collectNewRuns(reviewDir) {
  const root = path.join(reviewDir, 'codex_runs');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const runDir = path.join(root, entry.name);
      const statusFile = path.join(runDir, 'status.json');
      const commentsFile = path.join(runDir, 'comments.json');
      const resultFile = path.join(runDir, 'result.json');
      const status = readJson(statusFile, {});
      const comments = readJson(commentsFile, { markers: [] });
      return {
        submissionId: status.submissionId || entry.name,
        format: 'run-directory-v1',
        state: status.state || 'unknown',
        startedAt: status.startedAt || status.queuedAt || null,
        finishedAt: status.finishedAt || null,
        markerCount: markerSummary(comments).length,
        resultRecorded: fs.existsSync(resultFile),
        artifacts: {
          status: fileEvidence(statusFile),
          comments: fileEvidence(commentsFile),
          timeline: fileEvidence(path.join(runDir, 'timeline.json')),
          prompt: fileEvidence(path.join(runDir, 'prompt.md')),
          log: fileEvidence(path.join(runDir, 'events.jsonl')),
          finalMessage: fileEvidence(path.join(runDir, 'final.md')),
          result: fileEvidence(resultFile),
        },
        markers: markerSummary(comments),
      };
    });
}

function collectLegacyRuns(reviewDir) {
  const latestStatusFile = path.join(reviewDir, 'codex_callback_status.json');
  const latestStatus = readJson(latestStatusFile, {});
  return fs.readdirSync(reviewDir)
    .map(name => ({ name, match: /^codex_callback_comments_(codex-[^.]+)\.json$/.exec(name) }))
    .filter(entry => entry.match)
    .map(({ name, match }) => {
      const submissionId = match[1];
      const isLatest = latestStatus.submissionId === submissionId;
      const commentsFile = path.join(reviewDir, name);
      const comments = readJson(commentsFile, { markers: [] });
      return {
        submissionId,
        format: 'legacy-root-v1',
        state: isLatest ? (latestStatus.state || 'unknown') : 'unknown',
        startedAt: isLatest ? (latestStatus.startedAt || latestStatus.queuedAt || null) : null,
        finishedAt: isLatest ? (latestStatus.finishedAt || null) : null,
        markerCount: markerSummary(comments).length,
        resultRecorded: false,
        artifacts: {
          status: isLatest ? fileEvidence(latestStatusFile) : null,
          comments: fileEvidence(commentsFile),
          timeline: fileEvidence(path.join(reviewDir, `codex_callback_timeline_${submissionId}.json`)),
          prompt: isLatest ? fileEvidence(path.join(reviewDir, 'codex_callback_prompt.md')) : null,
          log: isLatest ? fileEvidence(path.join(reviewDir, 'codex_callback.log')) : null,
          finalMessage: isLatest ? fileEvidence(path.join(reviewDir, 'codex_callback_last_message.md')) : null,
          result: null,
        },
        markers: markerSummary(comments),
      };
    });
}

function collectReviewDir(reviewDir) {
  const activeCommentsFile = path.join(reviewDir, 'preview_comments.json');
  const activeComments = readJson(activeCommentsFile, { markers: [] });
  const submissions = [...collectLegacyRuns(reviewDir), ...collectNewRuns(reviewDir)]
    .sort((a, b) => String(a.startedAt || a.submissionId).localeCompare(String(b.startedAt || b.submissionId)));
  return {
    reviewDir,
    activeComments: {
      evidence: fileEvidence(activeCommentsFile),
      markerCount: markerSummary(activeComments).length,
      markers: markerSummary(activeComments),
    },
    submissions,
    editAcceptance: {
      state: fileEvidence(path.join(reviewDir, 'preview_apply_state.json')),
      events: fileEvidence(path.join(reviewDir, 'preview_apply', 'events.jsonl')),
      records: Object.values(readJson(path.join(reviewDir, 'preview_apply_state.json'), {})?.accepted || {}),
    },
  };
}

function buildRetrospective(target) {
  const reviewDirs = findReviewDirs(target);
  if (!reviewDirs.length) throw new Error(`未找到 Preview 批注目录：${path.resolve(target)}`);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    target: path.resolve(target),
    reviewDirs: reviewDirs.map(collectReviewDir),
  };
}

function main() {
  const [target, output] = process.argv.slice(2);
  if (!target) {
    console.error('用法: node build_preview_retrospective.js <项目目录或批注目录> [输出JSON]');
    process.exit(2);
  }
  try {
    const retrospective = buildRetrospective(target);
    const body = `${JSON.stringify(retrospective, null, 2)}\n`;
    if (output) fs.writeFileSync(path.resolve(output), body);
    else process.stdout.write(body);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { buildRetrospective, collectReviewDir, findReviewDirs, markerSummary };
