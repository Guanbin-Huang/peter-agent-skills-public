#!/usr/bin/env python3
"""Launcher guards tested only in temporary directories, without Terminal."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(os.environ.get('PREVIEW_LAUNCHER_SCRIPT',
                            Path(__file__).with_name('serve_preview_review.sh')))


class PreviewLauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.review = self.root / 'review with spaces'
        self.review.mkdir()
        self.video = self.root / 'accepted.mp4'
        self.video.write_bytes(b'fixture')
        self.server = self.root / 'server.js'
        self.server.write_text('// stub')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.stub('node', 'echo invoked >> "$STUB_NODE_LOG"\nexit 0')
        self.stub('python3', f'exec "{sys.executable}" "$@"')
        self.stub('lsof', '[ "$STUB_BUSY_PORT" = 1 ]')
        self.stub('uname', 'echo Darwin')
        self.stub('open', 'echo UNEXPECTED_TERMINAL_SPAWN >&2\nexit 99')
        self.env = {'PATH': f'{self.bin}:/usr/bin:/bin',
                    'HOME': str(self.root), 'SERVE_PREVIEW_REVIEW_NO_SPAWN': '1',
                    'STUB_NODE_LOG': str(self.root / 'node.log')}
        self.launcher = self.review / '启动Preview批注.command'
        self.launcher.write_text('previous launcher must survive\n')
        for name in ('preview_comments.json', 'preview_review_config.json', 'preview_timeline.json'):
            (self.review / name).write_text('{"existing":true}\n')

    def stub(self, name, text):
        path = self.bin / name
        path.write_text('#!/bin/bash\n' + text + '\n')
        path.chmod(0o755)

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.review.iterdir() if p.is_file()}

    def run_launcher(self, port='auto', **extra_env):
        return subprocess.run(['/bin/bash', str(SCRIPT), str(self.review), str(self.video),
                               str(self.server), port], env=self.env | extra_env,
                              capture_output=True, text=True, timeout=10)

    def assert_rejected_without_changes(self, **kwargs):
        before = self.snapshot()
        proc = self.run_launcher(**kwargs)
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.root / 'node.log').exists())
        return proc

    def test_alive_or_reused_pid_rejects_same_root(self):
        (self.review / '.preview_review_server.pid').write_text(str(os.getpid()))
        self.assert_rejected_without_changes()

    def test_queued_and_running_callback_reject_without_pid(self):
        for state in ('queued', 'running'):
            with self.subTest(state=state):
                (self.review / 'codex_callback_status.json').write_text('{"state":"' + state + '"}')
                self.assert_rejected_without_changes()

    def test_stale_pid_does_not_block_or_get_deleted(self):
        child = subprocess.Popen([sys.executable, '-c', 'pass'])
        child.wait()
        pid_path = self.review / '.preview_review_server.pid'
        pid_path.write_text(str(child.pid))
        proc = self.run_launcher()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(pid_path.read_text(), str(child.pid))

    def test_idle_no_spawn_can_generate_launcher(self):
        (self.review / 'codex_callback_status.json').write_text('{"state":"completed"}')
        proc = self.run_launcher()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertTrue(self.launcher.read_text().startswith('#!/bin/bash'))
        self.assertFalse((self.root / 'node.log').exists())

    def test_explicit_busy_port_rejects_without_changes(self):
        self.assert_rejected_without_changes(port='8910', STUB_BUSY_PORT='1')

    def test_malformed_pid_or_status_fails_closed(self):
        for filename, value in [('.preview_review_server.pid', 'not-a-pid'),
                                ('codex_callback_status.json', '{broken')]:
            with self.subTest(filename=filename):
                file = self.review / filename
                file.write_text(value)
                self.assert_rejected_without_changes()
                file.unlink()

    def test_generated_launcher_rechecks_before_actual_start(self):
        self.assertEqual(self.run_launcher().returncode, 0)
        (self.review / '.preview_review_server.pid').write_text(str(os.getpid()))
        before = self.snapshot()
        proc = subprocess.run(['/bin/bash', str(self.launcher)], env=self.env,
                              capture_output=True, text=True, timeout=10)
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertFalse((self.root / 'node.log').exists())
        self.assertEqual(self.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
