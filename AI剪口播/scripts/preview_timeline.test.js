'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const timeline = require('./preview_timeline');

const base = [{ id: 'whole', sourceStart: 0, sourceEnd: 10 }];
let id = 0;
const makeId = () => `new-${++id}`;

test('E splits the playhead clip without changing preview duration', () => {
  const result = timeline.splitAt(base, 4, null, makeId);
  assert.equal(result.changed, true);
  assert.deepEqual(result.clips.map(c => [c.sourceStart, c.sourceEnd]), [[0, 4], [4, 10]]);
  assert.equal(timeline.keptDuration(result.clips), 10);
});

test('A trims from the left edge to the playhead', () => {
  const result = timeline.trimLeftAt(base, 4);
  assert.deepEqual(result.clips.map(c => [c.sourceStart, c.sourceEnd]), [[4, 10]]);
  assert.equal(timeline.keptDuration(result.clips), 6);
});

test('S trims from the playhead to the right edge', () => {
  const result = timeline.trimRightAt(base, 4);
  assert.deepEqual(result.clips.map(c => [c.sourceStart, c.sourceEnd]), [[0, 4]]);
  assert.equal(timeline.keptDuration(result.clips), 4);
});

test('D deletes the selected block and leaves adjacent blocks magnetically packed', () => {
  const clips = [
    { id: 'a', sourceStart: 0, sourceEnd: 2 },
    { id: 'b', sourceStart: 2, sourceEnd: 5 },
    { id: 'c', sourceStart: 5, sourceEnd: 10 },
  ];
  const result = timeline.deleteClip(clips, 'b');
  assert.equal(result.changed, true);
  assert.deepEqual(result.clips.map(c => c.id), ['a', 'c']);
  assert.equal(timeline.sourceToOutput(result.clips, 5), 2);
  assert.equal(timeline.outputToSource(result.clips, 2), 2);
});

test('the final remaining block cannot be deleted', () => {
  assert.equal(timeline.deleteClip(base, 'whole').changed, false);
});
