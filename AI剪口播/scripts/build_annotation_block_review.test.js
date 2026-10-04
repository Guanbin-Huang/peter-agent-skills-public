'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeRanges, complement, outputTimeAtSource, sliceOutputWindow, blockFingerprint, reconcileReviewState } = require('./build_annotation_block_review');

test('review windows are calculated on the edited output timeline', () => {
  const keeps = complement([{ start: 4, end: 6 }], 10);
  assert.deepEqual(keeps, [{ start: 0, end: 4 }, { start: 6, end: 10 }]);
  assert.equal(outputTimeAtSource(keeps, 8, 1, 10), 6);
  assert.deepEqual(sliceOutputWindow(keeps, 1, 7, 1), [
    { sourceStart: 1, sourceEnd: 4 },
    { sourceStart: 6, sourceEnd: 9 },
  ]);
});

test('overlapping edit cuts are merged before rebuilding', () => {
  assert.deepEqual(mergeRanges([
    { start: 5, end: 8, reason: 'a' },
    { start: 7, end: 10, reason: 'b' },
  ], 20), [{ start: 5, end: 10, reason: 'a；b' }]);
});

test('review block fingerprint changes when the rendered content changes', () => {
  const before = { editSummary: '缩短气口', sourceRanges: [{ sourceStart: 10, sourceEnd: 20 }] };
  const same = { editSummary: '缩短气口', sourceRanges: [{ sourceStart: 10.0004, sourceEnd: 20.0004 }] };
  const revised = { editSummary: '重组完整句子', sourceRanges: [{ sourceStart: 10, sourceEnd: 13 }, { sourceStart: 17, sourceEnd: 20 }] };
  assert.equal(blockFingerprint(before), blockFingerprint(same));
  assert.notEqual(blockFingerprint(before), blockFingerprint(revised));
});

test('revised review content invalidates old approval but preserves its comment', () => {
  const old = {
    id: 'review-04',
    status: 'approved',
    revision: 1,
    reviewedAt: '2026-08-13T00:00:00Z',
    reviewerComment: '这里听不清楚',
    editSummary: '旧剪法',
    sourceRanges: [{ sourceStart: 10, sourceEnd: 20 }],
  };
  const next = {
    id: 'review-04',
    editSummary: '重组完整句子',
    sourceRanges: [{ sourceStart: 10, sourceEnd: 13 }, { sourceStart: 17, sourceEnd: 20 }],
  };
  assert.deepEqual(reconcileReviewState(old, next), {
    fingerprint: blockFingerprint(next),
    revision: 2,
    status: 'pending',
    reviewerComment: '这里听不清楚',
    reviewerCommentTime: null,
    reviewedAt: null,
    revisionReason: '审核片段内容已变化，旧通过状态自动失效',
  });
});

test('unchanged review content preserves approval', () => {
  const old = {
    id: 'review-04', status: 'approved', revision: 2, reviewedAt: '2026-08-13T00:00:00Z',
    editSummary: '已重组', sourceRanges: [{ sourceStart: 10, sourceEnd: 20 }],
  };
  const next = { id: 'review-04', editSummary: '已重组', sourceRanges: [{ sourceStart: 10, sourceEnd: 20 }] };
  const state = reconcileReviewState(old, next);
  assert.equal(state.status, 'approved');
  assert.equal(state.revision, 2);
  assert.equal(state.reviewedAt, '2026-08-13T00:00:00Z');
});
