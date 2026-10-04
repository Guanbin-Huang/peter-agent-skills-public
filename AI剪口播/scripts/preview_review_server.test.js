'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validatePayload, validateTimelinePayload, validateReviewBlocksPayload } = require('./preview_review_server');

test('new preview annotations default to the neutral category', () => {
  const template = fs.readFileSync(path.join(__dirname, 'templates', 'preview_review.html'), 'utf8');
  assert.match(template, /const DEFAULT_CATEGORY='其他'/);
  assert.match(template, /category:DEFAULT_CATEGORY/);
  const out = validatePayload({ markers: [{ previewTime: 1, comment: '仅描述问题' }] });
  assert.equal(out.markers[0].category, '其他');
});

test('validatePayload normalizes a marker without losing edit intent', () => {
  const out = validatePayload({ video: 'demo', markers: [{
    id: 'm1', previewTime: 12.34, sourceTime: 15.67,
    category: '这里短一点', comment: '简历和包装之间短一点',
    reviewBefore: 6, reviewAfter: 4, reviewPreviewStart: 6.34, reviewPreviewEnd: 16.34,
    actionBefore: 3, actionAfter: 3, actionPreviewStart: 9.34, actionPreviewEnd: 15.34,
    reviewSourceRanges: [{ previewStart: 6.34, previewEnd: 16.34, sourceStart: 8, sourceEnd: 19.5 }],
    actionSourceRanges: [{ previewStart: 9.34, previewEnd: 15.34, sourceStart: 11.45, sourceEnd: 18.35 }],
  }] });
  assert.equal(out.markers.length, 1);
  assert.equal(out.markers[0].previewTime, 12.34);
  assert.equal(out.markers[0].sourceTime, 15.67);
  assert.equal(out.markers[0].comment, '简历和包装之间短一点');
  assert.equal(out.markers[0].reviewPreviewStart, 6.34);
  assert.equal(out.markers[0].reviewPreviewEnd, 16.34);
  assert.equal(out.markers[0].actionPreviewStart, 9.34);
  assert.equal(out.markers[0].actionPreviewEnd, 15.34);
  assert.deepEqual(out.markers[0].sourceRanges, out.markers[0].actionSourceRanges);
  assert.equal(out.markers[0].scopeMode, 'local');
  assert.equal(out.markers[0].global, false);
});

test('G global mode is visible in the UI and persists on markers', () => {
  const template = fs.readFileSync(path.join(__dirname, 'templates', 'preview_review.html'), 'utf8');
  assert.match(template, /id="globalToggle"/);
  assert.match(template, /KeyG/);
  assert.match(template, /toggleScopeMode/);
  const out = validatePayload({ markers: [{ previewTime: 4, scopeMode: 'global', global: true }] });
  assert.equal(out.markers[0].scopeMode, 'global');
  assert.equal(out.markers[0].global, true);
});

test('Preview UI automatically submits pairs and final remainder with only pause control', () => {
  const template = fs.readFileSync(path.join(__dirname, 'templates', 'preview_review.html'), 'utf8');
  assert.doesNotMatch(template, /codexSubmitBtn|reviewedHereBtn|\/api\/codex-submit|\/api\/reviewed-to-here/);
  assert.match(template, /id="codexPauseBtn"/);
  assert.match(template, /\/api\/codex-status/);
  assert.match(template, /\/api\/codex-pause/);
  assert.match(template, /\/api\/review-finished/);
  assert.match(template, /x-codex-callback-token/i);
  assert.match(template, /真实进度/);
  assert.match(template, /已运行/);
  assert.match(template, /codex-activity/);
  assert.match(template, /两条自动修改，结尾剩一条也处理/);
  assert.doesNotMatch(template, /每两条自动提交|5 秒稳定防抖|立即处理当前批次|已审到这里/);
});

test('legacy global boolean migrates to global scope mode', () => {
  const out = validatePayload({ markers: [{ previewTime: 4, global: true }] });
  assert.equal(out.markers[0].scopeMode, 'global');
});

test('validatePayload rejects malformed markers', () => {
  assert.throws(() => validatePayload({ markers: 'nope' }), /markers/);
});

test('validatePayload clamps unsafe numeric values', () => {
  const out = validatePayload({ markers: [{ previewTime: -1, reviewBefore: 99, reviewAfter: -2 }] });
  assert.equal(out.markers[0].previewTime, 0);
  assert.equal(out.markers[0].windowBefore, 20);
  assert.equal(out.markers[0].windowAfter, 0);
});

test('validatePayload migrates legacy loop window into an explicit action scope', () => {
  const out = validatePayload({ markers: [{ previewTime: 8, windowBefore: 1.5, windowAfter: 2.5 }] });
  assert.equal(out.markers[0].reviewBefore, 6);
  assert.equal(out.markers[0].reviewAfter, 4);
  assert.equal(out.markers[0].actionBefore, 3);
  assert.equal(out.markers[0].actionAfter, 3);
  assert.equal(out.markers[0].actionPreviewStart, 5);
  assert.equal(out.markers[0].actionPreviewEnd, 11);
});

test('validateTimelinePayload stores ordered non-destructive preview clips', () => {
  const out = validateTimelinePayload({ video: 'demo', sourceDuration: 10, clips: [
    { id: 'left', sourceStart: 0, sourceEnd: 4 },
    { id: 'right', sourceStart: 6, sourceEnd: 10 },
  ] });
  assert.equal(out.clips.length, 2);
  assert.deepEqual(out.clips.map(c => [c.sourceStart, c.sourceEnd]), [[0, 4], [6, 10]]);
});

test('validateTimelinePayload rejects overlapping or empty timelines', () => {
  assert.throws(() => validateTimelinePayload({ sourceDuration: 10, clips: [] }), /至少保留/);
  assert.throws(() => validateTimelinePayload({ sourceDuration: 10, clips: [
    { sourceStart: 0, sourceEnd: 6 },
    { sourceStart: 5, sourceEnd: 8 },
  ] }), /重叠/);
});

test('validateReviewBlocksPayload preserves per-block approval and timed comments', () => {
  const out = validateReviewBlocksPayload({ video: 'demo', blocks: [{
    id: 'b1', order: 1, markerId: 'm1', previewTime: 12, sourceTime: 18,
    originalComment: '这里再短一点', editSummary: '已删除重复句', clipUrl: 'review_clips/01.mp4',
    clipDuration: 10, status: 'changes_requested', reviewerComment: '还有爆音', reviewerCommentTime: 5.2,
  }] });
  assert.equal(out.blocks[0].status, 'changes_requested');
  assert.equal(out.blocks[0].reviewerCommentTime, 5.2);
  assert.equal(out.blocks[0].clipUrl, 'review_clips/01.mp4');
});
