'use strict';
// Exercise the actual serveVideo implementation over loopback HTTP, without starting the review UI.
const fs = require('fs');
const http = require('http');
const vm = require('vm');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const { test } = require('node:test');
const target = process.argv[2] || path.join(__dirname, 'preview_review_server.js');
const source = fs.readFileSync(target, 'utf8');
const body = source.slice(source.indexOf('function serveVideo('), source.indexOf('\n\nfunction readJsonBody'));
const data = Buffer.from(Array.from({ length: 4096 }, (_, i) => Math.floor(i / 256)));
const cases = [
  [undefined, 200, 0, 4095], ['bytes=0-1023', 206, 0, 1023],
  ['bytes=3072-', 206, 3072, 4095], ['bytes=-1024', 206, 3072, 4095],
  ['bytes=-1', 206, 4095, 4095], ['bytes=-8192', 206, 0, 4095],
  ['bytes=4090-8192', 206, 4090, 4095], ['bytes=-0', 416],
  ['bytes=-', 416], ['bytes=4096-', 416], ['bytes=8-2', 416],
  ['bytes=0-1,4-5', 416], ['bytes=abc', 416],
];
test('video Range status, exact Content-Range and actual bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-range-'));
  const fixture = path.join(root, 'video.mp4');
  fs.writeFileSync(fixture, data);
  const sandbox = { fs, path, VIDEO_FILE: fixture, MIME_TYPES: { '.mp4': 'video/mp4' } };
  vm.createContext(sandbox); vm.runInContext(body, sandbox);
  const server = http.createServer((req, res) => sandbox.serveVideo(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [range, status, start, end] of cases) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, { headers: range ? { Range: range } : {} });
      const actual = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, status, range);
      if (status === 416) {
        assert.equal(response.headers.get('content-range'), 'bytes */4096', range);
        assert.equal(actual.length, 0, range);
      } else {
        assert.ok(actual.equals(data.subarray(start, end + 1)), `${range}: actual bytes differ (length=${actual.length})`);
        assert.equal(Number(response.headers.get('content-length')), end - start + 1, range);
        assert.equal(response.headers.get('content-range'), status === 206 ? `bytes ${start}-${end}/4096` : null, range);
      }
    }
    fs.writeFileSync(fixture, Buffer.alloc(0));
    const empty = await fetch(`http://127.0.0.1:${server.address().port}`, { headers: { Range: 'bytes=-1' } });
    await empty.arrayBuffer(); assert.equal(empty.status, 416); assert.equal(empty.headers.get('content-range'), 'bytes */0');
    console.log('RANGE_OK 14 cases; exact status/header/body; empty media rejected');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true });
  }
});
