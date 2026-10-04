#!/usr/bin/env node
'use strict';

/**
 * Reuse source word timestamps after cuts and speed changes.
 *
 * Usage:
 *   node map_subtitles_to_edit.js <source_words.json> <edit_map.json> <output_words.json>
 *
 * edit_map.json:
 *   { "speed": 1.3, "keeps": [{ "start": 0, "end": 3.38 }, ...] }
 */

const fs = require('fs');
const path = require('path');

const [sourcePath, editMapPath, outputPath] = process.argv.slice(2);
if (!sourcePath || !editMapPath || !outputPath) {
  console.error('Usage: node map_subtitles_to_edit.js <source_words.json> <edit_map.json> <output_words.json>');
  process.exit(1);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

const sourceWords = readJson(sourcePath);
const editMap = readJson(editMapPath);
const speed = Number(editMap.speed);
const keeps = editMap.keeps;

if (!Array.isArray(sourceWords)) throw new Error('source_words.json must be an array');
if (!Number.isFinite(speed) || speed <= 0) throw new Error('edit_map.speed must be a positive number');
if (!Array.isArray(keeps) || keeps.length === 0) throw new Error('edit_map.keeps must be a non-empty array');

let previousEnd = -Infinity;
let outputBase = 0;
const mapped = [];

for (const [index, keep] of keeps.entries()) {
  const start = Number(keep.start);
  const end = Number(keep.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error(`Invalid keep segment at index ${index}`);
  }
  if (start < previousEnd) throw new Error(`Overlapping or unsorted keep segment at index ${index}`);

  for (const word of sourceWords) {
    if (word.isGap || !word.text || !word.text.trim()) continue;
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end)) continue;

    const clippedStart = Math.max(word.start, start);
    const clippedEnd = Math.min(word.end, end);
    if (clippedEnd <= clippedStart) continue;

    mapped.push({
      text: word.text,
      start: round(outputBase + (clippedStart - start) / speed),
      end: round(outputBase + (clippedEnd - start) / speed),
      isGap: false,
    });
  }

  outputBase += (end - start) / speed;
  previousEnd = end;
}

const deduped = [];
for (const word of mapped) {
  const previous = deduped[deduped.length - 1];
  if (previous && previous.text === word.text && previous.start === word.start && previous.end === word.end) continue;
  deduped.push(word);
}

const output = [];
let lastEnd = 0;
for (const word of deduped) {
  if (word.start - lastEnd >= 0.2) {
    output.push({ text: '', start: round(lastEnd), end: word.start, isGap: true });
  }
  output.push(word);
  lastEnd = Math.max(lastEnd, word.end);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);

const spoken = output.filter((word) => !word.isGap);
const summary = {
  sourceWords: sourceWords.filter((word) => !word.isGap && word.text && word.text.trim()).length,
  mappedWords: spoken.length,
  keepSegments: keeps.length,
  speed,
  expectedTimelineDuration: round(outputBase),
  lastWordEnd: spoken.length ? spoken[spoken.length - 1].end : 0,
  output: outputPath,
};
console.log(JSON.stringify(summary, null, 2));
