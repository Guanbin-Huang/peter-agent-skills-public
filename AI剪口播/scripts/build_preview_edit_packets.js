#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REVIEW_BEFORE = 6;
const REVIEW_AFTER = 4;
const ACTION_BEFORE = 3;
const ACTION_AFTER = 3;

function mapPreviewRange(timelineMap, start, end) {
  return (timelineMap || []).flatMap(segment => {
    const previewStart = Math.max(start, Number(segment.previewStart));
    const previewEnd = Math.min(end, Number(segment.previewEnd));
    if (previewEnd <= previewStart) return [];
    const speed = Number(segment.speed) || 1;
    return [{
      previewStart,
      previewEnd,
      sourceStart: Number(segment.sourceStart) + (previewStart - Number(segment.previewStart)) * speed,
      sourceEnd: Number(segment.sourceStart) + (previewEnd - Number(segment.previewStart)) * speed,
    }];
  });
}

function transcriptForRanges(words, ranges) {
  return ranges.map(range => {
    const hits = words.filter(word => !word.isGap && String(word.text || '') && Number(word.end) >= range.sourceStart && Number(word.start) <= range.sourceEnd);
    return {
      sourceStart: range.sourceStart,
      sourceEnd: range.sourceEnd,
      text: hits.map(word => word.text).join(''),
      words: hits.map(word => ({ text: word.text, start: Number(word.start), end: Number(word.end) })),
    };
  });
}

function buildManualTimeline(timeline, timelineMap) {
  if (!timeline || !Array.isArray(timeline.clips) || !timeline.clips.length) return null;
  const clips = timeline.clips.map((clip, index) => {
    const previewStart = Number(clip.sourceStart);
    const previewEnd = Number(clip.sourceEnd);
    return {
      id: clip.id || `clip-${index}`,
      previewStart,
      previewEnd,
      sourceRanges: mapPreviewRange(timelineMap, previewStart, previewEnd),
    };
  });
  return {
    instruction: '这是用户用 E/A/S/D 明确试剪后保留的 Preview 片段，优先级高于自动剪辑建议；正式输出时按 sourceRanges 回到原片重建。',
    previewDuration: Number(timeline.sourceDuration) || null,
    outputDuration: clips.reduce((sum, clip) => sum + Math.max(0, clip.previewEnd - clip.previewStart), 0),
    clips,
    sourceKeeps: clips.flatMap(clip => clip.sourceRanges.map(range => ({ sourceStart: range.sourceStart, sourceEnd: range.sourceEnd, previewClipId: clip.id }))),
  };
}

function buildPackets(comments, config, rawWords, manualTimeline = null) {
  const words = Array.isArray(rawWords) ? rawWords : Object.values(rawWords || {});
  const timelineMap = config.timelineMap || [];
  const duration = timelineMap.length ? Math.max(...timelineMap.map(segment => Number(segment.previewEnd))) : Infinity;
  const fullSourceRanges = timelineMap.length && Number.isFinite(duration) ? mapPreviewRange(timelineMap, 0, duration) : [];
  const fullTranscript = {
    text: words.filter(word => !word.isGap && String(word.text || '')).map(word => word.text).join(''),
    words: words.filter(word => !word.isGap && String(word.text || '')).map(word => ({ text: word.text, start: Number(word.start), end: Number(word.end) })),
  };
  return {
    version: 1,
    video: comments.video || config.title || '',
    sourceVideo: config.sourceVideo || null,
    rule: {
      reviewWindow: 'M-6s to M+4s',
      actionWindow: 'M-3s to M+3s',
      instruction: '先听回顾窗口并读逐字稿，再结合评论在处理窗口内确定精确切点；不得机械删除窗口。',
      globalMarker: 'scopeMode=global 时，M 点和局部窗口只作定位锚点；必须检查完整逐字稿与全片结构，可决定删除、修改或调整到其他位置。',
    },
    manualTimeline: buildManualTimeline(manualTimeline, timelineMap),
    packets: (comments.markers || []).map(marker => {
      const m = Math.max(0, Number(marker.previewTime) || 0);
      const reviewStart = Math.max(0, m - REVIEW_BEFORE);
      const reviewEnd = Math.min(duration, m + REVIEW_AFTER);
      const actionStart = Math.max(0, m - ACTION_BEFORE);
      const actionEnd = Math.min(duration, m + ACTION_AFTER);
      const reviewSourceRanges = mapPreviewRange(timelineMap, reviewStart, reviewEnd);
      const actionSourceRanges = mapPreviewRange(timelineMap, actionStart, actionEnd);
      const scopeMode = marker.scopeMode === 'global' || marker.global === true ? 'global' : 'local';
      return {
        id: marker.id,
        previewTime: m,
        sourceTime: marker.sourceTime ?? null,
        category: marker.category || '其他',
        comment: marker.comment || '',
        scopeMode,
        global: scopeMode === 'global',
        reviewWindow: {
          previewStart: reviewStart,
          previewEnd: reviewEnd,
          sourceRanges: reviewSourceRanges,
          transcriptSegments: transcriptForRanges(words, reviewSourceRanges),
        },
        actionWindow: {
          previewStart: actionStart,
          previewEnd: actionEnd,
          sourceRanges: actionSourceRanges,
          transcriptSegments: transcriptForRanges(words, actionSourceRanges),
        },
        globalContext: scopeMode === 'global' ? {
          required: true,
          instruction: '先感知整条视频：通读完整逐字稿并检查前后重复、论证顺序和可移动位置，再决定删、改或调整位置。M 点仅是问题锚点。',
          sourceRanges: fullSourceRanges,
          transcript: fullTranscript,
        } : null,
      };
    }),
  };
}

if (require.main === module) {
  const [commentsFile, configFile, wordsFile, outputFile] = process.argv.slice(2);
  if (!commentsFile || !configFile || !wordsFile) {
    console.error('用法: node build_preview_edit_packets.js <preview_comments.json> <preview_review_config.json> <subtitles_words.json> [output.json]');
    process.exit(1);
  }
  const comments = JSON.parse(fs.readFileSync(path.resolve(commentsFile), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.resolve(configFile), 'utf8'));
  const words = JSON.parse(fs.readFileSync(path.resolve(wordsFile), 'utf8'));
  const timelineFile = path.join(path.dirname(path.resolve(commentsFile)), 'preview_timeline.json');
  const manualTimeline = fs.existsSync(timelineFile) ? JSON.parse(fs.readFileSync(timelineFile, 'utf8')) : null;
  const packets = buildPackets(comments, config, words, manualTimeline);
  const target = path.resolve(outputFile || path.join(path.dirname(commentsFile), 'preview_edit_packets.json'));
  fs.writeFileSync(target, JSON.stringify(packets, null, 2));
  console.log(`✅ 批注处理包已生成: ${target}`);
  console.log(`   批注: ${packets.packets.length} 条 · 回顾 M-6~M+4 · 处理 M-3~M+3`);
  if (packets.manualTimeline) console.log(`   手动时间线: ${packets.manualTimeline.clips.length} 个片段 · ${packets.manualTimeline.outputDuration.toFixed(2)} 秒`);
}

module.exports = { buildPackets, buildManualTimeline, mapPreviewRange, transcriptForRanges };
