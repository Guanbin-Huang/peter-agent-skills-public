'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPackets } = require('./build_preview_edit_packets');

test('buildPackets includes review and action transcripts using different windows', () => {
  const comments = { video: 'demo', markers: [{ id: 'm1', previewTime: 8, comment: '气口短一点' }] };
  const config = { sourceVideo: '/demo.mp4', timelineMap: [{ previewStart: 0, previewEnd: 20, sourceStart: 10, sourceEnd: 30, speed: 1 }] };
  const words = [
    { text: '前', start: 12, end: 12.2 },
    { text: '文', start: 14, end: 14.2 },
    { text: '问', start: 15, end: 15.2 },
    { text: '题', start: 18, end: 18.2 },
    { text: '后', start: 21, end: 21.2 },
    { text: '外', start: 23, end: 23.2 },
  ];
  const packet = buildPackets(comments, config, words).packets[0];
  assert.equal(packet.reviewWindow.previewStart, 2);
  assert.equal(packet.reviewWindow.previewEnd, 12);
  assert.equal(packet.actionWindow.previewStart, 5);
  assert.equal(packet.actionWindow.previewEnd, 11);
  assert.equal(packet.reviewWindow.transcriptSegments[0].text, '前文问题后');
  assert.equal(packet.actionWindow.transcriptSegments[0].text, '问题后');
});

test('buildPackets preserves multiple source ranges across preview joins', () => {
  const comments = { markers: [{ id: 'm2', previewTime: 5 }] };
  const config = { timelineMap: [
    { previewStart: 0, previewEnd: 5, sourceStart: 0, sourceEnd: 5, speed: 1 },
    { previewStart: 5, previewEnd: 10, sourceStart: 20, sourceEnd: 25, speed: 1 },
  ] };
  const packet = buildPackets(comments, config, []).packets[0];
  assert.equal(packet.reviewWindow.sourceRanges.length, 2);
  assert.equal(packet.actionWindow.sourceRanges.length, 2);
  assert.deepEqual(packet.actionWindow.sourceRanges.map(range => [range.sourceStart, range.sourceEnd]), [[2, 5], [20, 23]]);
});

test('buildPackets maps E/A/S/D preview clips back to original source ranges', () => {
  const comments = { markers: [] };
  const config = { timelineMap: [
    { previewStart: 0, previewEnd: 5, sourceStart: 10, sourceEnd: 15, speed: 1 },
    { previewStart: 5, previewEnd: 10, sourceStart: 30, sourceEnd: 35, speed: 1 },
  ] };
  const manualTimeline = { sourceDuration: 10, clips: [{ id: 'kept', sourceStart: 3, sourceEnd: 7 }] };
  const out = buildPackets(comments, config, [], manualTimeline).manualTimeline;
  assert.equal(out.outputDuration, 4);
  assert.deepEqual(out.sourceKeeps.map(r => [r.sourceStart, r.sourceEnd]), [[13, 15], [30, 32]]);
});

test('global markers require full-video context while keeping M as an anchor', () => {
  const comments = { markers: [{ id: 'g1', previewTime: 5, scopeMode: 'global', comment: '检查是否和前面重复' }] };
  const config = { timelineMap: [{ previewStart: 0, previewEnd: 10, sourceStart: 20, sourceEnd: 30, speed: 1 }] };
  const words = [{ text: '全', start: 20, end: 20.2 }, { text: '片', start: 29, end: 29.2 }];
  const packet = buildPackets(comments, config, words).packets[0];
  assert.equal(packet.scopeMode, 'global');
  assert.equal(packet.global, true);
  assert.equal(packet.globalContext.required, true);
  assert.equal(packet.globalContext.transcript.text, '全片');
  assert.deepEqual(packet.globalContext.sourceRanges.map(r => [r.sourceStart, r.sourceEnd]), [[20, 30]]);
  assert.equal(packet.actionWindow.previewStart, 2);
});

test('local markers do not request global context', () => {
  const packet = buildPackets({ markers: [{ previewTime: 2 }] }, { timelineMap: [] }, []).packets[0];
  assert.equal(packet.scopeMode, 'local');
  assert.equal(packet.globalContext, null);
});
