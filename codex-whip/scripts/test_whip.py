#!/usr/bin/env python3
"""Deterministic runtime tests; no real Codex process is invoked."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import signal
import unittest
from unittest import mock

SCRIPT = Path(__file__).with_name('whip.py').resolve()
spec = importlib.util.spec_from_file_location('whip', SCRIPT)
whip = importlib.util.module_from_spec(spec)
spec.loader.exec_module(whip)

FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
root = pathlib.Path(os.environ['FAKE_ROOT'])
mode = os.environ['FAKE_MODE']
prompt = sys.stdin.read()
assert os.environ.get('CODEX_WHIP_WORKER') == '1'
assert 'CODEX_WHIP_TASK' not in os.environ
log = root / 'calls.jsonl'
calls = log.read_text().splitlines() if log.exists() else []
n = len(calls) + 1
with log.open('a') as stream:
    stream.write(json.dumps({'args': args, 'prompt': prompt}) + '\n')
sid = 'real-worker-session'
if mode == 'wrong_session' and 'resume' in args:
    sid = 'other-session'
if mode != 'missing_session':
    print(json.dumps({'type': 'thread.started', 'thread_id': sid}), flush=True)
last = pathlib.Path(args[args.index('-o') + 1])
last.write_text(os.environ.get('FAKE_REPORT', mode if mode in ('BLOCKED', 'NEED_AUTH') else 'DONE\nfiles: value.txt'))
if mode in ('nested', 'indirect'):
    cmd = "/bin/zsh -lc 'env KEY=x /tmp/codex exec task'" if mode == 'nested' else '/bin/zsh -lc \'RUNNER=/tmp/codex; "$RUNNER" exec task\''
    print(json.dumps({'type': 'item.started', 'item': {'type': 'command_execution', 'id': 'command-1', 'command': cmd}}))
if mode == 'report':
    pathlib.Path('report.md').write_text('Total: ' + str(json.loads(pathlib.Path('data.json').read_text())['total']))
elif mode == 'violation':
    pathlib.Path('outside.txt').write_text('unexpected')
elif mode == 'resume_fix':
    # Resolve the actual failure disclosed by the supervisor, rather than a batch number.
    if 'phase two' in prompt:
        pathlib.Path('value.txt').write_text('ready')
    elif 'phase one' in prompt:
        pathlib.Path('value.txt').write_text('intermediate')
    else:
        raise RuntimeError('missing real acceptance evidence')
elif mode in ('changing', 'same_cause'):
    pathlib.Path('value.txt').write_text(str(n))
elif mode in ('no_progress', 'cache_no_progress'):
    if mode == 'cache_no_progress':
        for directory in ('.git', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache'):
            path = pathlib.Path(directory) / 'nested' / 'data'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(str(n))
    print('worker failure ' + str(n), file=sys.stderr)
    sys.exit(n)
elif mode == 'worker_timeout':
    import subprocess, time
    child = subprocess.Popen([sys.executable, '-c', 'import pathlib,sys,time\np=pathlib.Path(sys.argv[1])\nwhile True:\n p.write_text(str(time.time_ns()))\n time.sleep(0.02)', str(root / 'timeout-child')])
    (root / 'worker-pids.json').write_text(json.dumps({'parent': os.getpid(), 'child': child.pid,
                                                     'sid': os.getsid(0), 'pgid': os.getpgrp()}))
    time.sleep(30)
'''


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / 'work'
        self.work.mkdir()
        self.fixture = self.root / 'accept.py'
        self.fixture.write_text("import pathlib,sys\np=pathlib.Path(sys.argv[1])/'value.txt'\nv=p.read_text() if p.exists() else ''\nprint('phase one' if not v else 'phase two')\nsys.exit(0 if v=='ready' else 1)\n")
        self.fake = self.root / 'fake-codex'
        self.fake.write_text(FAKE)
        self.fake.chmod(0o755)
        self.env = dict(os.environ, CODEX_WHIP_HOME=str(self.root / 'home'),
                        CODEX_WHIP_CODEX_BIN=str(self.fake), FAKE_ROOT=str(self.root), FAKE_MODE='resume_fix')
        self.env.pop('CODEX_WHIP_WORKER', None)
        self.env.pop('CODEX_WHIP_TASK', None)
        self.env.pop('CODEX_THREAD_ID', None)
        self.addCleanup(self.clean_artifacts)

    def clean_artifacts(self):
        import shutil
        if hasattr(self, 'task'):
            shutil.rmtree(self.task['run_dir'])

    def cli(self, *args, input=None, env=None):
        return subprocess.run([sys.executable, '-B', str(SCRIPT), *args], input=input,
                              text=True, capture_output=True, env=env or self.env, timeout=20)

    def init(self, bind=None, effort=None, extra=()):
        args = ['init', '--id', 'test', '--workdir', str(self.work), '--goal', 'repair value',
                '--acceptance-json', json.dumps([sys.executable, '-B', str(self.fixture), '{workdir}']),
                '--allow', 'value.txt']
        if bind:
            args += ['--bind-session', bind]
        if effort:
            args += ['--effort', effort]
        args += list(extra)
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.directory = self.root / 'home/tasks/test'
        self.task = json.loads((self.directory / 'task.json').read_text())
        return result

    def state(self):
        return json.loads((self.directory / 'state.json').read_text())

    def change_task(self, **values):
        # Test-only fault/timeout injection; runtime registration stays immutable.
        for name in self.task['protected']:
            stat = Path(name).stat()
            self.task['protected'][name] = [stat.st_size, stat.st_mtime_ns]
        self.task.update(values)
        (self.directory / 'task.json').write_text(json.dumps(self.task))

    def calls(self):
        path = self.root / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def run_task(self, mode='resume_fix'):
        self.env['FAKE_MODE'] = mode
        return self.cli('run', '--task', 'test')

    def hook(self, **values):
        event = dict(session_id='parent', turn_id='turn', **values)
        result = self.cli('stop-hook', input=json.dumps(event))
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_success_zero_workers(self):
        (self.work / 'value.txt').write_text('ready')
        self.init()
        self.assertEqual(self.run_task().returncode, 0)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.state()['status'], 'done')
        original = Path(self.task['run_dir']) / 'orig/value.txt'
        self.assertEqual(original.read_bytes(), b'ready')

    def test_same_session_done_allows_next_task_binding(self):
        (self.work / 'value.txt').write_text('ready')
        self.init(bind='parent')
        original = (self.directory / 'task.json').read_bytes()
        self.assertEqual(self.run_task().returncode, 0)
        result = self.cli('init', '--id', 'next', '--workdir', str(self.work),
                          '--goal', 'next task', '--acceptance-json', json.dumps([sys.executable, '-B', str(self.fixture), '{workdir}']),
                          '--allow', 'value.txt', '--bind-session', 'parent')
        self.assertEqual(result.returncode, 0, result.stderr)
        binding = self.root / 'home/bindings/parent.json'
        self.assertEqual(json.loads(binding.read_text()), {'task': 'next'})
        self.assertEqual((self.directory / 'task.json').read_bytes(), original)
        next_task = json.loads((self.root / 'home/tasks/next/task.json').read_text())
        import shutil
        self.addCleanup(shutil.rmtree, next_task['run_dir'])

    def test_same_session_active_rejects_next_task_binding(self):
        self.init(bind='parent')
        original = (self.directory / 'task.json').read_bytes()
        result = self.cli('init', '--id', 'next', '--workdir', str(self.work),
                          '--goal', 'next task', '--acceptance-json', json.dumps([sys.executable, '-B', str(self.fixture), '{workdir}']),
                          '--allow', 'value.txt', '--bind-session', 'parent')
        self.assertEqual(result.returncode, 64)
        self.assertIn('active task', result.stderr)
        binding = self.root / 'home/bindings/parent.json'
        self.assertEqual(json.loads(binding.read_text()), {'task': 'test'})
        self.assertEqual((self.directory / 'task.json').read_bytes(), original)
        self.assertFalse((self.root / 'home/tasks/next').exists())

    def test_exec_resume_real_evidence_and_flags(self):
        self.init(effort='medium')
        self.env['CODEX_WHIP_TASK'] = str(self.directory / 'task.json')
        result = self.run_task()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 2)
        first, second = (call['args'] for call in calls)
        self.assertEqual(first[-1], '-')
        self.assertEqual(second[-1], '-')
        self.assertNotIn('--stdin', first)
        self.assertIn('--sandbox', first)
        self.assertEqual(second[:2], ['exec', 'resume'])
        self.assertEqual(second[-2:], ['real-worker-session', '-'])
        self.assertNotIn('--cd', second)
        self.assertNotIn('--sandbox', second)
        self.assertNotIn('-m', first + second)
        self.assertIn('model_reasoning_effort="medium"', second)
        self.assertEqual(self.state()['session_id'], 'real-worker-session')
        self.assertIn('phase two', calls[1]['prompt'])

    def test_done_report_is_not_acceptance(self):
        self.init()
        result = self.run_task('DONE')
        self.assertEqual(result.returncode, 5)
        self.assertEqual(self.state()['status'], 'needs_diagnosis')
        self.assertEqual(len(self.calls()), 2)
        self.assertNotIn('-c', self.calls()[0]['args'])

    def test_real_blocked_and_auth(self):
        self.init()
        for mode, code, status in [('BLOCKED', 3, 'blocked'), ('NEED_AUTH', 4, 'need_auth')]:
            with self.subTest(mode=mode):
                self.cli('mark', '--task', 'test', '--status', 'active', '--reason', 'test')
                result = self.run_task(mode)
                self.assertEqual(result.returncode, code)
                self.assertEqual(self.state()['status'], status)

    def test_report_edge_markers_stop_without_dispatching_again(self):
        self.init()
        cases = [('当前：尚缺外部输入\n\nNEED_AUTH：需要授权', 4, 'need_auth'),
                 ('**BLOCKED** | reason\n当前：等待输入', 3, 'blocked'),
                 ('- BLOCKED | reason\n**NEED_AUTH**：需要授权', 4, 'need_auth')]
        for report, code, status in cases:
            with self.subTest(report=report):
                self.cli('mark', '--task', 'test', '--status', 'active', '--reason', 'test')
                self.env['FAKE_REPORT'] = report
                before = len(self.calls())
                self.assertEqual(self.run_task('report').returncode, code)
                self.assertEqual(self.state()['status'], status)
                self.assertEqual(len(self.calls()), before + 1)

    def test_cache_and_git_writes_are_not_violations_or_progress(self):
        self.init()
        self.assertEqual(self.run_task('cache_no_progress').returncode, 5)
        self.assertEqual(self.state()['status'], 'needs_diagnosis')
        self.assertEqual(self.state()['no_progress'], 2)
        self.assertEqual(len(self.calls()), 2)

    def test_four_batch_limit(self):
        self.fixture.write_text("import pathlib,sys\np=pathlib.Path(sys.argv[1])/'value.txt'\nprint(p.read_text() if p.exists() else 'initial')\nsys.exit(1)\n")
        self.init()
        self.assertEqual(self.run_task('changing').returncode, 5)
        self.assertEqual(self.state()['status'], 'needs_diagnosis')
        self.assertEqual(self.state()['trigger'], 'batch_window')
        self.assertEqual(len(self.calls()), 4)

    def test_same_cause_twice_even_with_changes(self):
        self.fixture.write_text("import sys\nprint('fixed failure')\nsys.exit(1)\n")
        self.init()
        self.assertEqual(self.run_task('same_cause').returncode, 5)
        self.assertEqual(self.state()['same_cause'], 2)
        self.assertEqual(self.state()['no_progress'], 0)
        self.assertEqual(self.state()['trigger'], 'same_cause')
        self.assertEqual(self.state()['status'], 'needs_diagnosis')

    def test_no_progress_twice_different_worker_failures(self):
        self.init()
        self.assertEqual(self.run_task('no_progress').returncode, 5)
        self.assertEqual(self.state()['no_progress'], 2)
        self.assertEqual(self.state()['same_cause'], 1)
        self.assertEqual(self.state()['trigger'], 'no_progress')
        self.assertEqual(self.state()['status'], 'needs_diagnosis')

    def test_inflight_75_and_hook_pass(self):
        self.init(bind='parent')
        with (self.directory / 'run.lock').open('a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.run_task().returncode, 75)
            self.assertEqual(self.hook(), {})
        self.assertEqual(self.calls(), [])

    def test_worker_entry_64_and_hook_pass(self):
        self.init(bind='parent')
        self.env['CODEX_WHIP_WORKER'] = '1'
        self.assertEqual(self.run_task().returncode, 64)
        self.assertEqual(self.hook(), {})

    def test_missing_and_wrong_worker_session(self):
        self.init()
        self.assertEqual(self.run_task('missing_session').returncode, 3)
        self.assertIn('thread.started', self.state()['reason'])
        self.cli('mark', '--task', 'test', '--status', 'active', '--reason', 'retry')
        self.assertEqual(self.run_task('wrong_session').returncode, 3)
        self.assertIn('inconsistent', self.state()['reason'])

    def test_started_nested_and_indirect(self):
        self.init()
        self.assertEqual(self.run_task('nested').returncode, 6)
        self.assertEqual(self.state()['status'], 'nested')
        self.cli('mark', '--task', 'test', '--status', 'blocked', '--reason', 'review')
        self.cli('mark', '--task', 'test', '--status', 'active', '--reason', 'review')
        self.assertEqual(self.run_task('indirect').returncode, 6)
        self.assertIn('needs_review', self.state()['reason'])

    def test_outside_allow(self):
        self.init()
        self.assertEqual(self.run_task('violation').returncode, 6)
        self.assertEqual(self.state()['status'], 'violation')
        self.assertIn('outside.txt', self.state()['reason'])

    def test_acceptance_timeout_check_and_run(self):
        self.init()
        self.fixture.write_text('import time\ntime.sleep(5)\n')
        self.change_task(accept_timeout=0.05)
        result = self.cli('check', '--task', 'test')
        self.assertEqual(result.returncode, 3)
        self.assertEqual(self.state()['status'], 'blocked')
        self.cli('mark', '--task', 'test', '--status', 'active', '--reason', 'test')
        self.assertEqual(self.run_task().returncode, 3)
        self.assertEqual(self.calls(), [])

    def assert_processes_stopped(self, pid_file):
        pids = json.loads(pid_file.read_text())
        self.assertEqual(pids['sid'], os.getsid(0))
        self.assertEqual(pids['pgid'], pids['parent'])
        with self.assertRaises(ProcessLookupError):
            os.kill(pids['parent'], 0)
        heartbeat = self.root / 'timeout-child'
        self.assertTrue(heartbeat.exists(), 'child must run before timeout')
        before = heartbeat.read_text()
        time.sleep(0.15)
        self.assertEqual(heartbeat.read_text(), before, 'timeout left child executing')

    def cleanup_timeout_child(self, pid_file):
        if pid_file.exists():
            pid = json.loads(pid_file.read_text())['child']
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def test_worker_timeout_cleans_descendants(self):
        self.init()
        self.change_task(worker_timeout=1)
        pid_file = self.root / 'worker-pids.json'
        self.addCleanup(self.cleanup_timeout_child, pid_file)
        start = time.monotonic()
        self.assertEqual(self.run_task('worker_timeout').returncode, 3)
        self.assertLess(time.monotonic() - start, 4)
        self.assertEqual(self.state()['reason'], 'worker timed out')
        self.assert_processes_stopped(pid_file)

    def test_acceptance_timeout_cleans_child_holding_stdout(self):
        self.init()
        pid_file = self.root / 'accept-pids.json'
        self.addCleanup(self.cleanup_timeout_child, pid_file)
        self.fixture.write_text(
            'import json,os,pathlib,subprocess,sys\n'
            'child=subprocess.Popen([sys.executable,"-c",' + repr('import pathlib,sys,time\np=pathlib.Path(sys.argv[1])\nwhile True:\n p.write_text(str(time.time_ns()))\n time.sleep(0.02)') + ',' +
            repr(str(self.root / 'timeout-child')) + '])\n'
            'pathlib.Path(' + repr(str(pid_file)) + ').write_text(json.dumps({'
            '"parent":os.getpid(),"child":child.pid,"sid":os.getsid(0),"pgid":os.getpgrp()}))\n')
        self.change_task(accept_timeout=1)
        start = time.monotonic()
        result = self.cli('check', '--task', 'test')
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertLess(time.monotonic() - start, 4)
        self.assertEqual(self.state()['status'], 'blocked')
        self.assertTrue(self.state()['last_accept']['timeout'])
        self.assert_processes_stopped(pid_file)

    def test_stop_unregistered(self):
        self.assertEqual(self.hook(), {})
        result = self.cli('stop-hook', input='[]')
        self.assertEqual(json.loads(result.stdout), {})
        self.assertIn('JSON object', result.stderr)

    def test_stop_failure_then_success(self):
        self.init(bind='parent')
        response = self.hook()
        self.assertEqual(response['decision'], 'block')
        import shlex
        self.assertIn('cd ' + shlex.quote(self.task['workdir']) + ' && ' +
                      shlex.join([sys.executable, '-B', str(self.fixture), self.task['workdir']]), response['reason'])
        (self.work / 'value.txt').write_text('ready')
        self.assertEqual(self.hook(), {})
        self.assertEqual(self.state()['status'], 'done')
        logs = [json.loads(line) for line in (self.directory / 'hook.log.jsonl').read_text().splitlines()]
        self.assertEqual(logs[0]['turn_id'], 'turn')

    def test_stop_active_without_new_batch_stalls(self):
        self.init(bind='parent')
        self.assertIn('decision', self.hook())
        self.assertIn('diagnose --task test', self.hook(stop_hook_active=True)['reason'])
        self.assertEqual(self.state()['status'], 'needs_diagnosis')

    def test_stop_new_batch_may_block_and_finite_blocks(self):
        self.init(bind='parent')
        self.assertIn('decision', self.hook())
        state = self.state()
        state['batches'] = 1
        (self.directory / 'state.json').write_text(json.dumps(state))
        self.assertIn('decision', self.hook(stop_hook_active=True))
        for _ in range(5):
            response = self.hook()
        self.assertEqual(response['decision'], 'block')
        self.assertEqual(self.state()['status'], 'needs_diagnosis')
        self.assertEqual(self.state()['hook_blocks'], 6)

    def test_stop_paused_and_worker_session(self):
        self.init(bind='parent')
        state = self.state()
        state['worker_sessions'] = ['parent']
        (self.directory / 'state.json').write_text(json.dumps(state))
        self.assertEqual(self.hook(), {})
        self.cli('mark', '--task', 'test', '--status', 'paused', '--reason', 'user paused')
        self.assertEqual(self.hook(), {})
        self.assertEqual(self.run_task().returncode, 0)
        self.assertEqual(self.state()['status'], 'paused')

    def test_stop_missing_or_wrong_parent_session(self):
        self.init(bind='parent')
        self.env['CODEX_WHIP_TASK'] = str(self.directory / 'task.json')
        for event in ({}, {'session_id': 'wrong'}):
            result = self.cli('stop-hook', input=json.dumps(event))
            self.assertEqual(json.loads(result.stdout), {})
        self.assertEqual(self.state()['hook_blocks'], 0)

    def test_stop_timeout_records_blocked(self):
        self.init(bind='parent')
        self.fixture.write_text('import time\ntime.sleep(5)\n')
        self.change_task(accept_timeout=0.05)
        response = self.hook()
        self.assertEqual(response['decision'], 'block')
        self.assertIn('停止修改', response['reason'])
        self.assertIn('blocked', response['reason'])
        self.assertEqual(self.hook(), {})
        self.assertEqual(self.state()['status'], 'blocked')
        self.assertTrue(self.state()['last_accept']['timeout'])

    def test_explicit_pointer_and_invalid_pointer(self):
        self.init()
        self.env['CODEX_WHIP_TASK'] = str(self.directory / 'task.json')
        self.assertIn('decision', self.hook())
        self.env['CODEX_WHIP_TASK'] = str(self.root / 'somewhere.json')
        result = self.cli('stop-hook', input='{}')
        self.assertEqual(json.loads(result.stdout), {})
        self.assertIn('HOME/tasks', result.stderr)

    def test_snapshot_prunes_trees_and_reads_only_allowed_bytes(self):
        self.init()
        skipped = ('.git', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache')
        for name in skipped:
            path = self.work / name / 'nested' / 'data'
            path.parent.mkdir(parents=True)
            path.write_bytes(b'ignored')
        (self.work / 'outside.txt').write_bytes(b'outside')
        (self.work / 'value.txt').write_bytes(b'allowed')
        walk = os.walk
        visited = []
        def trace_walk(root):
            for row in walk(root):
                visited.append(Path(row[0]))
                yield row
        read_bytes = Path.read_bytes
        reads = []
        def trace_read(path):
            reads.append(path)
            return read_bytes(path)
        with mock.patch.object(whip.os, 'walk', trace_walk), mock.patch.object(Path, 'read_bytes', trace_read):
            before = whip.snapshot(self.task)
        self.assertEqual(visited, [self.work.resolve()])
        self.assertEqual(reads, [self.work.resolve() / 'value.txt'])
        self.assertEqual(before['value.txt'], b'allowed')
        stat = (self.work / 'outside.txt').stat()
        self.assertEqual(before['outside.txt'], (stat.st_size, stat.st_mtime_ns))
        (self.work / 'value.txt').write_bytes(b'new')
        self.assertNotEqual(before['value.txt'], whip.snapshot(self.task)['value.txt'])

    def test_command_parser_and_event_dedup(self):
        for command in ['echo codex exec', 'cat references/runtime.md',
                        "printf '%s' 'codex exec'", "python3 -c 'print(\"codex\")'"]:
            with self.subTest(command=command):
                self.assertIsNone(whip.command_kind(command))
        for command in ['/path/codex exec x', 'env VAR=x /path/codex exec x', 'env VAR=x exec /path/codex exec x',
                        "/bin/zsh -lc 'echo ready; /path/codex exec x'", 'python3 -I /path/whip.py run --task x']:
            with self.subTest(command=command):
                self.assertEqual(whip.command_kind(command), 'nested')
        self.assertEqual(whip.command_kind("/bin/zsh -lc 'unterminated"), 'needs_review')
        self.assertEqual(whip.command_kind('RUNNER=codex; "$RUNNER" exec x'), 'needs_review')
        path = self.root / 'events.jsonl'
        item = {'id': 'one', 'type': 'command_execution', 'command': 'echo codex'}
        path.write_text('\n'.join(json.dumps({'type': kind, 'item': item}) for kind in ('item.started', 'item.completed')))
        self.assertEqual(whip.events(path), (set(), ['echo codex']))

    def test_auto_id_cwd_and_default_binding(self):
        self.env['CODEX_THREAD_ID'] = 'parent'
        args = ['init', '--goal', 'automatic', '--acceptance-json',
                json.dumps([sys.executable, '-B', str(self.fixture), '{workdir}']), '--allow', 'value.txt']
        result = subprocess.run([sys.executable, '-B', str(SCRIPT), *args], cwd=self.work,
                                env=self.env, text=True, capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        binding = json.loads((self.root / 'home/bindings/parent.json').read_text())
        self.assertRegex(binding['task'], r'^t-\d{8}-\d{6}-[a-f0-9]{4}$')
        task = json.loads((self.root / 'home/tasks' / binding['task'] / 'task.json').read_text())
        self.assertEqual(task['workdir'], str(self.work.resolve()))
        self.assertEqual(task['bound_session'], 'parent')
        import shutil
        self.addCleanup(shutil.rmtree, task['run_dir'])
        self.env.pop('CODEX_THREAD_ID')
        self.init()
        self.assertIsNone(self.task['bound_session'])
        self.assertTrue(result.stdout.startswith('export CODEX_WHIP_TASK='))

    def test_acceptance_script_overlap_rejected_and_output_allowed(self):
        script = self.work / 'check.py'
        script.write_text('raise SystemExit(1)\n')
        args = ['init', '--id', 'bad', '--workdir', str(self.work), '--goal', 'test',
                '--acceptance-json', json.dumps([sys.executable, '-B', str(script)]), '--allow', '*.py']
        self.assertEqual(self.cli(*args).returncode, 64)
        args[args.index('--acceptance-json') + 1] = json.dumps([sys.executable, '-B', '{workdir}/check.py'])
        self.assertEqual(self.cli(*args).returncode, 64)
        self.assertFalse((self.root / 'home/tasks/bad').exists())
        (self.work / 'value.txt').write_text('pending')
        self.fixture.write_text('import pathlib,sys\nsys.exit(pathlib.Path(sys.argv[1]).read_text() != "ready")\n')
        args[2] = 'test'
        args[-1] = 'value.txt'
        args[args.index('--acceptance-json') + 1] = json.dumps([sys.executable, '-B', str(self.fixture), str(self.work / 'value.txt')])
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.directory = self.root / 'home/tasks/test'
        self.task = json.loads((self.directory / 'task.json').read_text())
        self.assertNotIn(str(self.work / 'value.txt'), self.task['protected'])
        (self.work / 'value.txt').write_text('ready')
        self.assertEqual(self.run_task().returncode, 0)

    def test_explicit_protect_overlap_and_no_bind(self):
        output = self.work / 'value.txt'
        output.write_text('pending')
        args = ['init', '--id', 'bad', '--workdir', str(self.work), '--goal', 'test',
                '--acceptance-json', json.dumps([sys.executable, '-B', str(self.fixture), '{workdir}']),
                '--allow', 'value.txt', '--protect', str(output)]
        self.assertEqual(self.cli(*args).returncode, 64)
        self.env['CODEX_THREAD_ID'] = 'parent'
        self.init(extra=['--no-bind'])
        self.assertIsNone(self.task['bound_session'])
        self.assertFalse((self.root / 'home/bindings/parent.json').exists())

    def test_needs_diagnosis_prevents_rebinding(self):
        self.init(bind='parent', extra=['--max-batches', '1'])
        self.assertEqual(self.run_task('DONE').returncode, 5)
        result = self.cli('init', '--id', 'next', '--workdir', str(self.work), '--goal', 'next',
                          '--acceptance-json', json.dumps([sys.executable, '-B', str(self.fixture), '{workdir}']),
                          '--allow', 'value.txt', '--bind-session', 'parent')
        self.assertEqual(result.returncode, 64)
        self.assertEqual(json.loads((self.root / 'home/bindings/parent.json').read_text()), {'task': 'test'})

    def test_protected_acceptance_run_and_hook(self):
        dependency = self.root / 'helper.py'
        dependency.write_text('constant = 1\n')
        self.init(bind='parent', extra=['--protect', str(dependency)])
        self.fixture.write_text('raise SystemExit(0)\n')
        self.assertEqual(self.run_task().returncode, 6)
        self.assertEqual(self.state()['status'], 'violation')
        self.assertEqual(self.calls(), [])
        # Independent protected helper exercises the hook boundary.
        self.change_task()
        state = self.state()
        state['status'] = 'active'
        (self.directory / 'state.json').write_text(json.dumps(state))
        dependency.write_text('constant = 100\n')
        self.assertEqual(self.hook()['decision'], 'block')
        self.assertEqual(self.hook(), {})
        self.assertEqual(self.state()['status'], 'violation')

    def test_tampering_each_boundary_in_run_and_hook(self):
        dependency = self.root / 'dependency.py'
        dependency.write_text('value = 1\n')
        self.init(bind='parent', extra=['--protect', str(dependency)])
        for path in (self.fixture, dependency):
            for entry in ('run', 'hook'):
                with self.subTest(path=path, entry=entry):
                    self.change_task()
                    state = self.state()
                    state['status'] = 'active'
                    (self.directory / 'state.json').write_text(json.dumps(state))
                    path.write_text(path.read_text() + '\n# changed\n')
                    if entry == 'run':
                        self.assertEqual(self.run_task().returncode, 6)
                    else:
                        response = self.hook()
                        self.assertEqual(response['decision'], 'block')
                        self.assertIn('violation', response['reason'])
                        self.assertIn('向用户报告', response['reason'])
                        self.assertEqual(self.hook(), {})
                    self.assertEqual(self.state()['status'], 'violation')
                    self.assertTrue(self.state()['last_accept']['tampered'])
        self.assertEqual(self.calls(), [])

    def test_diagnose_preserves_sid_total_and_resumes_new_plan(self):
        self.init(bind='parent', extra=['--max-batches', '1'])
        self.assertEqual(self.run_task().returncode, 5)
        self.assertEqual(self.state()['trigger'], 'batch_window')
        self.assertEqual(self.state()['batches'], 1)
        self.assertEqual(self.run_task().returncode, 5)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.hook()['decision'], 'block')
        result = self.cli('diagnose', '--task', 'test', '--cause', 'phase one only', '--plan', 'complete phase two')
        self.assertEqual(result.returncode, 0, result.stderr)
        state = self.state()
        self.assertEqual(state['window_batches'], 0)
        self.assertIsNone(state['trigger'])
        self.assertEqual(state['batches'], 1)
        self.assertEqual(state['session_id'], 'real-worker-session')
        self.assertEqual(state['unanswered_blocks'], 0)
        self.assertEqual(self.run_task().returncode, 0)
        self.assertEqual(self.state()['batches'], 2)
        self.assertEqual(self.state()['worker_sessions'], ['real-worker-session'])
        self.assertEqual(len(self.state()['diagnoses']), 1)
        self.assertIn('resume', self.calls()[1]['args'])
        self.assertIn('complete phase two', self.calls()[1]['prompt'])
        self.assertEqual(self.hook(), {})

    def test_diagnose_invalid_and_mark_restrictions(self):
        self.init(extra=['--max-batches', '1'])
        base = ['diagnose', '--task', 'test']
        self.assertEqual(self.cli(*base, '--cause', 'cause', '--plan', 'plan').returncode, 64)
        self.assertEqual(self.run_task('DONE').returncode, 5)
        for cause, plan in [('', 'plan'), ('cause', '   ')]:
            self.assertEqual(self.cli(*base, '--cause', cause, '--plan', plan).returncode, 64)
        self.assertEqual(self.cli('mark', '--task', 'test', '--status', 'active', '--reason', 'skip').returncode, 64)
        self.assertEqual(self.cli(*base, '--cause', 'cause', '--plan', 'new   plan').returncode, 0)
        self.assertEqual(self.run_task('DONE').returncode, 5)
        self.assertEqual(self.cli(*base, '--cause', 'cause', '--plan', ' new plan ').returncode, 64)

    def test_diagnosis_budget_requires_user_approval(self):
        self.init(bind='parent', extra=['--max-batches', '1', '--max-rounds', '1'])
        self.assertEqual(self.run_task('DONE').returncode, 5)
        base = ['diagnose', '--task', 'test', '--cause', 'no change', '--plan']
        self.assertEqual(self.cli(*base, 'first plan').returncode, 0)
        self.assertEqual(self.run_task('DONE').returncode, 4)
        self.assertEqual(self.state()['status'], 'need_auth')
        self.assertEqual(self.state()['auth_kind'], 'budget')
        self.assertEqual(self.hook(), {})
        self.assertEqual(self.cli(*base, 'second plan').returncode, 64)
        self.assertEqual(self.cli('mark', '--task', 'test', '--status', 'active', '--reason', 'skip').returncode, 64)
        result = self.cli(*base, 'second plan', '--budget-approval', '允许追加一轮')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state()['extra_rounds'], 1)
        self.assertEqual(self.state()['batches'], 2)
        self.assertEqual(self.state()['diagnoses'][-1]['approval'], '允许追加一轮')
        self.assertEqual(self.run_task('DONE').returncode, 4)
        self.assertEqual(self.state()['batches'], 3)

    def test_diagnosis_stop_always_blocks_until_pass(self):
        self.init(bind='parent')
        self.hook()
        self.assertEqual(self.hook(stop_hook_active=True)['decision'], 'block')
        for index in range(3):
            response = self.hook(stop_hook_active=True)
            self.assertEqual(response['decision'], 'block')
            self.assertIn('diagnose --task test', response['reason'])
            self.assertEqual(self.state()['status'], 'needs_diagnosis')
            self.assertEqual(self.state()['unanswered_blocks'], index + 3)
            self.assertEqual(self.state()['diagnoses'], [])
        self.assertEqual(self.calls(), [])
        (self.work / 'value.txt').write_text('ready')
        self.assertEqual(self.hook(stop_hook_active=True), {})
        self.assertEqual(self.state()['status'], 'done')

    def test_stop_budget_exhaustion_does_not_add_diagnosis(self):
        self.init(bind='parent', extra=['--max-batches', '1', '--max-rounds', '1'])
        self.assertEqual(self.run_task('DONE').returncode, 5)
        self.assertEqual(self.cli('diagnose', '--task', 'test', '--cause', 'root cause', '--plan', 'new plan').returncode, 0)
        self.assertEqual(self.hook()['decision'], 'block')
        response = self.hook(stop_hook_active=True)
        self.assertEqual(response['decision'], 'block')
        self.assertIn('请求追加诊断授权', response['reason'])
        self.assertIn('停止修改', response['reason'])
        self.assertEqual(self.hook(stop_hook_active=True), {})
        self.assertEqual(self.state()['status'], 'need_auth')
        self.assertEqual(self.state()['auth_kind'], 'budget')
        self.assertEqual(len(self.state()['diagnoses']), 1)
        self.assertEqual(len(self.calls()), 1)

    def test_mark_intermediate_preserves_unfinished_diagnosis(self):
        self.init(extra=['--max-batches', '1'])
        self.assertEqual(self.run_task('DONE').returncode, 5)
        for status in ('paused', 'blocked', 'need_auth'):
            with self.subTest(status=status):
                self.assertEqual(self.cli('mark', '--task', 'test', '--status', status, '--reason', 'wait').returncode, 0)
                result = self.cli('mark', '--task', 'test', '--status', 'active', '--reason', 'resume')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.state()['status'], 'needs_diagnosis')
                self.assertIn('diagnose', self.state()['reason'])
                self.assertEqual(self.state()['trigger'], 'batch_window')
                self.assertEqual(self.run_task('DONE').returncode, 5)
                self.assertEqual(len(self.calls()), 1)
        result = self.cli('diagnose', '--task', 'test', '--cause', 'cause', '--plan', 'new plan')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.state()['trigger'])
        for status in ('paused', 'blocked', 'need_auth'):
            with self.subTest(diagnosed_status=status):
                self.assertEqual(self.cli('mark', '--task', 'test', '--status', status, '--reason', 'wait').returncode, 0)
                self.assertEqual(self.cli('mark', '--task', 'test', '--status', 'active', '--reason', 'resume').returncode, 0)
                self.assertEqual(self.state()['status'], 'active')
                self.assertIsNone(self.state()['trigger'])

    def test_diagnosis_terminal_transition_notifies_once(self):
        self.init(bind='parent', extra=['--max-batches', '1'])
        self.assertEqual(self.run_task('DONE').returncode, 5)
        for failure in ('tampered', 'unexecutable'):
            with self.subTest(failure=failure):
                self.change_task()
                state = self.state()
                state['status'] = 'needs_diagnosis'
                (self.directory / 'state.json').write_text(json.dumps(state))
                if failure == 'tampered':
                    self.fixture.write_text(self.fixture.read_text() + '\n# altered\n')
                else:
                    self.change_task(acceptance=[str(self.root / 'missing-executable')])
                before = self.state()['unanswered_blocks']
                response = self.hook()
                self.assertEqual(response['decision'], 'block')
                self.assertIn('停止修改', response['reason'])
                self.assertIn('向用户报告', response['reason'])
                self.assertEqual(self.state()['status'], 'violation' if failure == 'tampered' else 'blocked')
                self.assertEqual(self.state()['unanswered_blocks'], before + 1)
                self.assertEqual(self.hook(stop_hook_active=True), {})
                self.assertEqual(self.state()['diagnoses'], [])
                self.assertEqual(len(self.calls()), 1)
                logs = [json.loads(line) for line in (self.directory / 'hook.log.jsonl').read_text().splitlines()]
                self.assertEqual(logs[-1]['response'], response)

    def test_mark_paused_and_auth_clear_unanswered(self):
        self.init(bind='parent')
        for status in ('paused', 'need_auth', 'blocked', 'cancelled'):
            self.hook()
            self.assertEqual(self.cli('mark', '--task', 'test', '--status', status, '--reason', 'explicit').returncode, 0)
            self.assertEqual(self.state()['unanswered_blocks'], 0)
            self.assertEqual(self.hook(stop_hook_active=True), {})
            if status != 'cancelled':
                self.assertEqual(self.cli('mark', '--task', 'test', '--status', 'active', '--reason', 'resume').returncode, 0)

    def test_legacy_state_defaults(self):
        self.init(bind='parent')
        state = self.state()
        for key in ('window_batches', 'diagnoses', 'trigger', 'extra_rounds', 'hook_epoch', 'unanswered_blocks'):
            state.pop(key)
        state['batches'] = 1
        (self.directory / 'state.json').write_text(json.dumps(state))
        self.assertEqual(self.hook()['decision'], 'block')
        self.assertEqual(self.state()['window_batches'], 1)
        self.assertEqual(self.state()['diagnoses'], [])
        self.assertEqual(self.run_task().returncode, 0)

    def test_noncode_readback_fake_cli(self):
        (self.work / 'data.json').write_text('{"total": 42}')
        self.fixture.write_text('import json,pathlib,sys\nr=pathlib.Path(sys.argv[1])\n'
                                'p=r/"report.md"\nexpected=str(json.loads((r/"data.json").read_text())["total"])\n'
                                'sys.exit(0 if p.exists() and expected in p.read_text() else 1)\n')
        result = self.cli('init', '--id', 'test', '--workdir', str(self.work), '--goal', 'write report',
                          '--acceptance-json', json.dumps([sys.executable, '-B', str(self.fixture), '{workdir}']),
                          '--allow', 'report.md')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.directory = self.root / 'home/tasks/test'
        self.task = json.loads((self.directory / 'task.json').read_text())
        before = whip.snapshot(self.task)
        self.assertEqual(self.run_task('report').returncode, 0)
        after = whip.snapshot(self.task)
        self.assertEqual([name for name in before.keys() | after.keys() if before.get(name) != after.get(name)], ['report.md'])
        self.assertEqual((self.work / 'report.md').read_text(), 'Total: 42')


if __name__ == '__main__':
    unittest.main()
