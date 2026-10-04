(function attachPreviewTimeline(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PreviewTimeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPreviewTimeline() {
  'use strict';

  const MIN_CLIP_DURATION = 0.05;
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const cloneClips = clips => clips.map(clip => ({ ...clip }));
  const idFactory = () => `clip-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function normalizeClips(clips, sourceDuration = Infinity) {
    const duration = finite(sourceDuration, Infinity);
    const max = duration > 0 ? duration : Infinity;
    return (Array.isArray(clips) ? clips : []).slice(0, 2000).map((clip, index) => {
      const sourceStart = Math.max(0, Math.min(max, finite(clip.sourceStart, finite(clip.start, 0))));
      const sourceEnd = Math.max(sourceStart, Math.min(max, finite(clip.sourceEnd, finite(clip.end, sourceStart))));
      return { id: String(clip.id || `clip-${index}`).slice(0, 120), sourceStart, sourceEnd };
    }).filter(clip => clip.sourceEnd - clip.sourceStart >= MIN_CLIP_DURATION)
      .sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd);
  }

  function initialTimeline(sourceDuration, video = '') {
    const duration = Math.max(0, finite(sourceDuration, 0));
    return {
      version: 1,
      video: String(video || ''),
      sourceDuration: duration,
      clips: duration >= MIN_CLIP_DURATION ? [{ id: 'clip-0', sourceStart: 0, sourceEnd: duration }] : [],
    };
  }

  function keptDuration(clips) {
    return normalizeClips(clips).reduce((sum, clip) => sum + clip.sourceEnd - clip.sourceStart, 0);
  }

  function findClipIndex(clips, sourceTime, preferredId = null) {
    const time = finite(sourceTime, 0);
    if (preferredId) {
      const preferred = clips.findIndex(clip => clip.id === preferredId && time >= clip.sourceStart - .001 && time <= clip.sourceEnd + .001);
      if (preferred >= 0) return preferred;
    }
    let index = clips.findIndex(clip => time > clip.sourceStart + .001 && time < clip.sourceEnd - .001);
    if (index >= 0) return index;
    index = clips.findIndex(clip => time >= clip.sourceStart - .001 && time <= clip.sourceEnd + .001);
    return index;
  }

  function splitAt(clips, sourceTime, preferredId = null, makeId = idFactory) {
    const next = cloneClips(clips);
    const index = findClipIndex(next, sourceTime, preferredId);
    if (index < 0) return { changed: false, clips: next, selectedId: preferredId };
    const clip = next[index], time = finite(sourceTime, clip.sourceStart);
    if (time - clip.sourceStart < MIN_CLIP_DURATION || clip.sourceEnd - time < MIN_CLIP_DURATION) {
      return { changed: false, clips: next, selectedId: clip.id };
    }
    const left = { ...clip, id: makeId(), sourceEnd: time };
    const right = { ...clip, id: makeId(), sourceStart: time };
    next.splice(index, 1, left, right);
    return { changed: true, clips: next, selectedId: right.id };
  }

  function trimLeftAt(clips, sourceTime, preferredId = null) {
    const next = cloneClips(clips);
    const index = findClipIndex(next, sourceTime, preferredId);
    if (index < 0) return { changed: false, clips: next, selectedId: preferredId };
    const clip = next[index], time = finite(sourceTime, clip.sourceStart);
    if (time - clip.sourceStart < MIN_CLIP_DURATION || clip.sourceEnd - time < MIN_CLIP_DURATION) {
      return { changed: false, clips: next, selectedId: clip.id };
    }
    clip.sourceStart = time;
    return { changed: true, clips: next, selectedId: clip.id };
  }

  function trimRightAt(clips, sourceTime, preferredId = null) {
    const next = cloneClips(clips);
    const index = findClipIndex(next, sourceTime, preferredId);
    if (index < 0) return { changed: false, clips: next, selectedId: preferredId };
    const clip = next[index], time = finite(sourceTime, clip.sourceEnd);
    if (time - clip.sourceStart < MIN_CLIP_DURATION || clip.sourceEnd - time < MIN_CLIP_DURATION) {
      return { changed: false, clips: next, selectedId: clip.id };
    }
    clip.sourceEnd = time;
    return { changed: true, clips: next, selectedId: clip.id };
  }

  function deleteClip(clips, preferredId, sourceTime = 0) {
    const next = cloneClips(clips);
    const index = preferredId ? next.findIndex(clip => clip.id === preferredId) : findClipIndex(next, sourceTime);
    if (index < 0 || next.length <= 1) return { changed: false, clips: next, selectedId: preferredId, deletedIndex: -1 };
    next.splice(index, 1);
    const selected = next[Math.min(index, next.length - 1)];
    return { changed: true, clips: next, selectedId: selected?.id || null, deletedIndex: index };
  }

  function sourceToOutput(clips, sourceTime) {
    const normalized = normalizeClips(clips);
    const time = finite(sourceTime, 0);
    let cursor = 0;
    for (const clip of normalized) {
      const length = clip.sourceEnd - clip.sourceStart;
      if (time >= clip.sourceStart && time <= clip.sourceEnd) return cursor + Math.min(length, Math.max(0, time - clip.sourceStart));
      if (time < clip.sourceStart) return cursor;
      cursor += length;
    }
    return cursor;
  }

  function outputToSource(clips, outputTime) {
    const normalized = normalizeClips(clips);
    let time = Math.max(0, finite(outputTime, 0));
    for (const clip of normalized) {
      const length = clip.sourceEnd - clip.sourceStart;
      if (time <= length) return clip.sourceStart + time;
      time -= length;
    }
    return normalized.length ? normalized[normalized.length - 1].sourceEnd : 0;
  }

  function nextClipAfter(clips, sourceTime) {
    const time = finite(sourceTime, 0);
    return normalizeClips(clips).find(clip => clip.sourceStart > time + .001) || null;
  }

  function clipAt(clips, sourceTime, preferredId = null) {
    const index = findClipIndex(clips, sourceTime, preferredId);
    return index >= 0 ? clips[index] : null;
  }

  return {
    MIN_CLIP_DURATION,
    normalizeClips,
    initialTimeline,
    keptDuration,
    findClipIndex,
    clipAt,
    splitAt,
    trimLeftAt,
    trimRightAt,
    deleteClip,
    sourceToOutput,
    outputToSource,
    nextClipAfter,
  };
});
