#!/usr/bin/env python3
"""Offline regression tests for the actual served-video identity gate."""
import contextlib
import io
import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import verify_served_media as gate


CONTENT = bytes(range(256)) * 11


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path.startswith('/redirect'):
            self.send_response(302)
            self.send_header('Location', 'https://example.invalid/token-secret')
            self.end_headers()
            return
        if self.path.startswith('/error'):
            self.send_error(503)
            return
        if self.path.startswith('/slow'):
            time.sleep(0.15)
        body = CONTENT
        if self.path.startswith('/old'):
            body = bytes([CONTENT[0] ^ 1]) + CONTENT[1:]
        if self.path.startswith('/short'):
            body = CONTENT[:-1]
        range_header = self.headers.get('Range')
        if range_header and not self.path.startswith('/no-range'):
            offset = int(range_header.split('=')[1].split('-')[0])
            self.send_response(206)
            declared_offset = 0 if self.path.startswith('/bad-range-header') else offset
            self.send_header('Content-Range', f'bytes {declared_offset}-{offset}/{len(body)}')
            body = body[offset:offset + 1]
            if self.path.startswith('/bad-range-byte'):
                body = bytes([body[0] ^ 1])
        else:
            self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


class ServedMediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.video = Path(self.temp.name) / 'accepted.mp4'
        self.video.write_bytes(CONTENT)

    def verify(self, route, timeout=2):
        return gate.verify(self.video, self.origin + route, timeout)

    def test_correct_video_and_range_pass(self):
        result = self.verify('/video')
        self.assertEqual(result['status'], 'PASS', result)
        self.assertEqual(result['local']['sha256'], result['served']['sha256'])
        self.assertEqual(result['local']['bytes'], result['served']['bytes'])
        self.assertEqual(result['range']['http_status'], 206)

    def test_same_size_old_video_fails(self):
        result = self.verify('/old')
        self.assertEqual(result['status'], 'FAIL')
        self.assertIn('CONTENT_MISMATCH', result['errors'])
        self.assertEqual(result['local']['bytes'], result['served']['bytes'])

    def test_short_video_fails(self):
        self.assertIn('LENGTH_MISMATCH', self.verify('/short')['errors'])

    def test_missing_range_fails(self):
        self.assertIn('RANGE_STATUS_NOT_206', self.verify('/no-range')['errors'])

    def test_wrong_range_byte_fails(self):
        self.assertIn('RANGE_BYTE_MISMATCH', self.verify('/bad-range-byte')['errors'])

    def test_wrong_content_range_fails(self):
        self.assertIn('RANGE_CONTENT_RANGE_INVALID', self.verify('/bad-range-header')['errors'])

    def test_invalid_url_rejected(self):
        for url in ['file:///etc/passwd', 'http://127.0.0.1:bad/video', 'http://127.0.0.1.example.invalid/video']:
            with self.subTest(url=url):
                self.assertEqual(gate.verify(self.video, url)['status'], 'FAIL')

    def test_timeout_fails(self):
        self.assertIn('TIMEOUT', self.verify('/slow', timeout=0.03)['errors'])

    def test_http_error_fails(self):
        self.assertIn('HTTP_ERROR_503', self.verify('/error')['errors'])

    def test_external_url_rejected_without_network(self):
        result = gate.verify(self.video, 'https://example.invalid/?token=secret')
        self.assertIn('URL_NOT_LOOPBACK', result['errors'])
        self.assertNotIn('secret', json.dumps(result))

    def test_external_redirect_rejected_without_network(self):
        result = self.verify('/redirect')
        self.assertIn('URL_NOT_LOOPBACK', result['errors'])
        self.assertNotIn('token-secret', json.dumps(result))

    def test_url_credentials_rejected(self):
        result = gate.verify(self.video, 'http://user:secret@127.0.0.1/video')
        self.assertIn('URL_CREDENTIALS_FORBIDDEN', result['errors'])
        self.assertNotIn('secret', json.dumps(result))

    def test_cli_report_and_exit_status(self):
        report = Path(self.temp.name) / 'report.json'
        for route, expected_code, expected_status in [('/video', 0, 'PASS'), ('/old', 1, 'FAIL')]:
            with contextlib.redirect_stdout(io.StringIO()) as output:
                code = gate.main(['--video', str(self.video), '--url', self.origin + route,
                                  '--report', str(report)])
            self.assertEqual(code, expected_code)
            self.assertEqual(output.getvalue().strip(), f'VERIFIED_MEDIA={expected_status}')
            self.assertEqual(json.loads(report.read_text())['status'], expected_status)


if __name__ == '__main__':
    unittest.main()
