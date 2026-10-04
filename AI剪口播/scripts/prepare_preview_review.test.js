'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('prepare_preview_review packages Smiley Sans for cover candidates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-preview-review-'));
  const video = path.join(root, 'preview.mp4');
  const review = path.join(root, 'review');
  fs.writeFileSync(video, 'fixture');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'prepare_preview_review.js'), video, review], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const font = path.join(review, 'fonts', 'SmileySans-Oblique.ttf');
  assert.equal(fs.existsSync(font), true);
  assert.ok(fs.statSync(font).size > 1000000);
});
