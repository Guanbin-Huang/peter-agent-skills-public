'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildRetrospective } = require('./build_preview_retrospective');

test('collects immutable legacy annotations and current callback evidence', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-retro-'));
  const review = path.join(project, '4_Preview批注_V9');
  fs.mkdirSync(review);
  fs.writeFileSync(path.join(review, 'preview_review_config.json'), '{}');
  fs.writeFileSync(path.join(review, 'preview_comments.json'), JSON.stringify({ markers: [{ id: 'active', comment: '当前批注' }] }));
  fs.writeFileSync(path.join(review, 'codex_callback_comments_codex-123-abcd.json'), JSON.stringify({ markers: [{ id: 'm1', comment: 'B-roll 停久一点', scopeMode: 'global' }] }));
  fs.writeFileSync(path.join(review, 'codex_callback_timeline_codex-123-abcd.json'), JSON.stringify({ clips: [] }));
  fs.writeFileSync(path.join(review, 'codex_callback_status.json'), JSON.stringify({ submissionId: 'codex-123-abcd', state: 'completed' }));
  fs.writeFileSync(path.join(review, 'codex_callback.log'), '{}\n');
  fs.writeFileSync(path.join(review, 'codex_callback_prompt.md'), '# prompt\n');
  fs.writeFileSync(path.join(review, 'codex_callback_last_message.md'), 'done\n');

  const result = buildRetrospective(project);
  assert.equal(result.reviewDirs.length, 1);
  assert.equal(result.reviewDirs[0].activeComments.markerCount, 1);
  assert.equal(result.reviewDirs[0].submissions.length, 1);
  const run = result.reviewDirs[0].submissions[0];
  assert.equal(run.submissionId, 'codex-123-abcd');
  assert.equal(run.state, 'completed');
  assert.equal(run.markers[0].scopeMode, 'global');
  assert.match(run.artifacts.comments.sha256, /^[a-f0-9]{64}$/);
});

test('collects new run directories without exposing callback config tokens', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-retro-run-'));
  const review = path.join(project, '4_Preview批注');
  const run = path.join(review, 'codex_runs', 'codex-456-efgh');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(review, 'preview_review_config.json'), '{}');
  fs.writeFileSync(path.join(review, 'codex_callback_config.json'), JSON.stringify({ token: 'secret' }));
  fs.writeFileSync(path.join(run, 'comments.json'), JSON.stringify({ markers: [{ id: 'm2', comment: '字幕大一点' }] }));
  fs.writeFileSync(path.join(run, 'timeline.json'), '{}');
  fs.writeFileSync(path.join(run, 'status.json'), JSON.stringify({ submissionId: 'codex-456-efgh', state: 'completed' }));
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ items: [] }));

  const result = buildRetrospective(project);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret/);
  assert.equal(result.reviewDirs[0].submissions[0].resultRecorded, true);
  assert.ok(result.reviewDirs[0].submissions[0].artifacts.result);
});

test('accepts a direct review directory regardless of its folder name', () => {
  const review = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogue-review-'));
  fs.writeFileSync(path.join(review, 'preview_review_config.json'), '{}');
  fs.writeFileSync(path.join(review, 'preview_comments.json'), JSON.stringify({ markers: [{ id: 'direct', comment: '直接复盘' }] }));
  const result = buildRetrospective(review);
  assert.equal(result.reviewDirs.length, 1);
  assert.equal(result.reviewDirs[0].reviewDir, review);
  assert.equal(result.reviewDirs[0].activeComments.markerCount, 1);
});
