#!/usr/bin/env python3
"""Explicit task registration, deterministic acceptance, and bounded supervision."""
import argparse
import contextlib
import fnmatch
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

CODES = {'done': 0, 'blocked': 3, 'need_auth': 4, 'needs_diagnosis': 5,
         'violation': 6, 'nested': 6, 'paused': 0, 'cancelled': 0}
TERMINAL = set(CODES) - {'needs_diagnosis'}


def home():
    return Path(os.environ.get('CODEX_WHIP_HOME', str(Path.home() / '.codex/whip'))).resolve()


def safe(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', value):
        raise ValueError('invalid task or session ID')
    return value


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.write-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read(path):
    value = json.loads(path.read_text())
    if path.name == 'state.json':
        for key, default in dict(window_batches=value['batches'], diagnoses=[], trigger=None,
                                 extra_rounds=0, hook_epoch=None, unanswered_blocks=0).items():
            value.setdefault(key, default)
    return value


@contextlib.contextmanager
def lock(path, nonblocking=False):
    with path.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def running(directory):
    try:
        with lock(directory / 'run.lock', True):
            return False
    except BlockingIOError:
        return True


def load_task(task_id):
    directory = home() / 'tasks' / safe(task_id)
    return directory, read(directory / 'task.json')


def update(directory, **values):
    with lock(directory / 'state.lock'):
        state = read(directory / 'state.json')
        state.update(values)
        atomic(directory / 'state.json', state)
        return state


def fingerprint(result):
    # Direct comparison preserves the actual cause without a snapshot/hash layer.
    output = re.sub(r'0x[0-9a-fA-F]+', '<address>', result['output'])
    output = re.sub(r'\b\d+(?:\.\d+)?\s*(?:ms|seconds?|s)\b', '<duration>', output)
    return [result['exit'], output]


def run_process(argv, *, timeout, input=None, **kwargs):
    """Synchronously wait for a child group in the current session."""
    with subprocess.Popen(argv, process_group=0, **kwargs) as proc:
        try:
            stdout, stderr = proc.communicate(input=input, timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass  # The entire child group has already exited.
            stdout, stderr = proc.communicate()
            raise subprocess.TimeoutExpired(argv, timeout, output=stdout, stderr=stderr)
        return subprocess.CompletedProcess(argv, proc.returncode, stdout, stderr)


def accept(task):
    for name, original in task.get('protected', {}).items():
        path = Path(name)
        current = [path.stat().st_size, path.stat().st_mtime_ns] if path.is_file() else None
        if current != original:
            return dict(exit=None, output='protected acceptance file changed: ' + name,
                        timeout=False, ok=False, tampered=True)
    argv = [a.replace('{workdir}', task['workdir']) for a in task['acceptance']]
    try:
        proc = run_process(argv, cwd=task['workdir'], stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, timeout=task['accept_timeout'])
        result = {'exit': proc.returncode, 'output': proc.stdout.decode(errors='replace')[-12000:],
                  'timeout': False}
    except subprocess.TimeoutExpired as error:
        result = {'exit': None, 'output': (error.stdout or b'').decode(errors='replace')[-12000:],
                  'timeout': True, 'error': 'acceptance timed out'}
    except OSError as error:
        result = {'exit': None, 'output': str(error), 'timeout': False, 'error': str(error)}
    result['ok'] = result['exit'] == 0 and not result['timeout']
    return result


def snapshot(task):
    root = Path(task['workdir'])
    files = {}
    for directory, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in {'.git', 'node_modules', '__pycache__',
                                               '.pytest_cache', '.mypy_cache', '.ruff_cache'}]
        for name in names:
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            if allowed(relative, task):
                files[relative] = path.read_bytes()
            else:
                stat = path.stat()
                files[relative] = (stat.st_size, stat.st_mtime_ns)
    return files


def allowed(name, task):
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in task['allow'])


def command_kind(command):
    """Inspect executable positions, never document text or echoed arguments."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=';&|')
    lexer.whitespace_split = True
    lexer.commenters = ''
    try:
        tokens = list(lexer)
    except ValueError:
        return 'needs_review'
    chunks, chunk = [], []
    for token in tokens:
        if token and all(c in ';&|' for c in token):
            chunks.append(chunk)
            chunk = []
        else:
            chunk.append(token)
    chunks.append(chunk)
    result = None
    for argv in chunks:
        while argv and (re.match(r'^[A-Za-z_]\w*=', argv[0]) or
                        argv[0] in ('exec', 'command', '--') or Path(argv[0]).name == 'env'):
            argv = argv[1:]
        if not argv:
            continue
        executable = Path(argv[0]).name
        if '$' in argv[0] or '`' in argv[0]:
            result = 'needs_review'
        elif executable == 'codex':
            return 'nested'
        elif executable in ('sh', 'bash', 'zsh'):
            for i, arg in enumerate(argv[1:], 1):
                if arg.startswith('-') and 'c' in arg and i + 1 < len(argv):
                    nested = command_kind(argv[i + 1])
                    if nested == 'nested':
                        return nested
                    result = nested or result
                    break
        elif executable == 'whip.py' and 'run' in argv[1:]:
            return 'nested'
        elif executable.startswith('python') and len(argv) > 1:
            script = next((a for a in argv[1:] if not a.startswith('-')), '')
            if Path(script).name == 'whip.py' and 'run' in argv[1:]:
                return 'nested'
    return result


def events(path):
    ids, commands, seen = set(), [], set()
    for line in path.read_text().splitlines():
        event = json.loads(line)
        if event.get('type') == 'thread.started' and event.get('thread_id'):
            ids.add(event['thread_id'])
        if event.get('type') in ('item.started', 'item.completed'):
            item = event.get('item', {})
            if item.get('type') == 'command_execution' and isinstance(item.get('command'), str):
                key = (item.get('id'), item['command'])
                if key not in seen:
                    commands.append(item['command'])
                    seen.add(key)
    return ids, commands


def verdict(report):
    lines = [line.strip() for line in report.splitlines() if line.strip()]
    markers = set()
    for line in lines[:1] + lines[-1:]:
        line = re.sub(r'^[\s#>*`_~+\-\d.)\[\]]+', '', line)
        match = re.match(r'^(NEED_AUTH|BLOCKED)[*`_~]*(?=$|[\s:：|｜])', line)
        if match:
            markers.add(match[1])
    return 'need_auth' if 'NEED_AUTH' in markers else 'blocked' if 'BLOCKED' in markers else None


def handoff(task, result, previous, state):
    return ('[codex-whip worker]\n目标：' + task['goal'] + '\nworkdir: ' + task['workdir'] +
            '\n允许写入（仅限已登记范围）：' + json.dumps(task['allow'], ensure_ascii=False) +
            '\n验收 argv: ' + json.dumps(task['acceptance'], ensure_ascii=False) +
            '\n当前失败：\n' + result['output'][-6000:] + '\n上一批报告：\n' + previous +
            '\n当前诊断：' + json.dumps(state['diagnoses'][-1:], ensure_ascii=False) +
            '\n已尝试方案：' + json.dumps([x['plan'] for x in state['diagnoses']], ensure_ascii=False) +
            '\n不调用 codex、Claude 或其他 Agent；不在允许范围外写入；不改全局配置、账号或权限；'
            '不外发，不新增测试、检查、脚手架、回滚或审计文件。完成一个有界批次即停。'
            '\n报告首行 DONE|BLOCKED|NEED_AUTH，随后列改动文件、命令结果和未完成项。\n')


def refuse_worker():
    if os.environ.get('CODEX_WHIP_WORKER') == '1':
        raise ValueError('worker cannot invoke this runtime')


def init(args):
    refuse_worker()
    args.id = args.id or time.strftime('t-%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:4]
    safe(args.id)
    workdir = Path(args.workdir)
    if not workdir.is_absolute() or not workdir.is_dir():
        raise ValueError('workdir must be an existing absolute directory')
    acceptance = json.loads(args.acceptance_json)
    if not isinstance(acceptance, list) or not acceptance or not all(isinstance(a, str) and a for a in acceptance):
        raise ValueError('acceptance must be a nonempty string argv list')
    for pattern in args.allow:
        if Path(pattern).is_absolute() or '..' in Path(pattern).parts:
            raise ValueError('allow must stay within workdir')
    workdir = workdir.resolve()
    protected = {}
    explicit = [Path(p).expanduser() for p in args.protect]
    expanded = [a.replace('{workdir}', str(workdir)) for a in acceptance]
    executable = Path(expanded[0]).name
    interpreter = executable.startswith('python') or executable in ('node', 'ruby', 'perl', 'bash', 'sh', 'zsh')
    script = next((a for a in expanded[1:] if not a.startswith('-')), None) if interpreter else expanded[0]
    script_path = (workdir / script).resolve() if script else None
    candidates = explicit + [Path(a) for a in expanded]
    for index, path in enumerate(candidates):
        path = (workdir / path).resolve() if not path.is_absolute() else path.resolve()
        # Target outputs are editable; explicit --protect disambiguates argv data paths.
        if index >= len(explicit) and (not path.is_file() or
                (path != script_path and path.is_relative_to(workdir) and any(fnmatch.fnmatchcase(path.relative_to(workdir).as_posix(), p) for p in args.allow))):
            continue
        if not path.is_file():
            raise ValueError('protected path must be an existing file: ' + str(path))
        if path.is_relative_to(workdir) and any(fnmatch.fnmatchcase(path.relative_to(workdir).as_posix(), p) for p in args.allow):
            raise ValueError('protected acceptance file overlaps allow: ' + str(path))
        stat = path.stat()
        protected[str(path)] = [stat.st_size, stat.st_mtime_ns]
    if args.bind_session is not None:
        safe(args.bind_session)
        binding = home() / 'bindings' / (args.bind_session + '.json')
        if binding.exists():
            old_directory, _ = load_task(read(binding)['task'])
            if read(old_directory / 'state.json')['status'] not in TERMINAL:
                raise ValueError('session is already bound to an active task')
    directory = home() / 'tasks' / args.id
    directory.mkdir(parents=True, exist_ok=False)
    task = {'id': args.id, 'workdir': str(workdir.resolve()), 'goal': args.goal,
            'acceptance': acceptance, 'allow': args.allow, 'effort': args.effort,
            'max_batches': args.max_batches, 'max_rounds': args.max_rounds,
            'protected': protected, 'accept_timeout': 60, 'worker_timeout': 1800,
            'created': time.time(), 'bound_session': args.bind_session}
    task['run_dir'] = str(Path(tempfile.mkdtemp(prefix=args.id + '-', dir=run_root())))
    for name, content in snapshot(task).items():
        if allowed(name, task):
            target = Path(task['run_dir']) / 'orig' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
    baseline = accept(task)
    state = {'status': 'blocked' if baseline['timeout'] or baseline.get('error') else 'active',
             'session_id': None, 'worker_sessions': [], 'batches': 0, 'last_fp': None,
             'same_cause': 0, 'no_progress': 0, 'hook_fp': None, 'hook_batches': None,
             'hook_blocks': 0, 'last_accept': baseline, 'reason': baseline.get('error', '')}
    state.update(window_batches=0, diagnoses=[], trigger=None, extra_rounds=0,
                 hook_epoch=None, unanswered_blocks=0)
    atomic(directory / 'task.json', task)
    atomic(directory / 'state.json', state)
    if args.bind_session is not None:
        atomic(binding, {'task': args.id})
    print('export CODEX_WHIP_TASK=' + shlex.quote(str(directory / 'task.json')))
    return 0


def run_root():
    root = Path(tempfile.gettempdir()) / 'codex-whip'
    root.mkdir(parents=True, exist_ok=True)
    return root


def finish(directory, status, reason='', **extra):
    state = update(directory, status=status, reason=reason, **extra)
    print(json.dumps(state, ensure_ascii=False))
    return CODES[status]


def diagnosis_state(task, state, trigger):
    if len(state['diagnoses']) >= task.get('max_rounds', 3) + state['extra_rounds']:
        return dict(status='need_auth', reason='diagnosis budget exhausted', trigger=trigger, auth_kind='budget')
    return dict(status='needs_diagnosis', reason=trigger, trigger=trigger)


def to_diagnosis(directory, task, trigger):
    values = diagnosis_state(task, read(directory / 'state.json'), trigger)
    return finish(directory, **values)


def diagnose(args):
    refuse_worker()
    directory, task = load_task(args.task)
    with lock(directory / 'state.lock'):
        state = read(directory / 'state.json')
        cause, plan = args.cause.strip(), ' '.join(args.plan.split())
        approval = args.budget_approval.strip()
        budget = state['status'] == 'need_auth' and state.get('auth_kind') == 'budget'
        if not (state['status'] == 'needs_diagnosis' or (budget and approval)):
            raise ValueError('diagnose requires needs_diagnosis or approved budget')
        if not cause or not plan or plan in [x['plan'] for x in state['diagnoses']]:
            raise ValueError('nonempty cause and a different plan required')
        if approval and not budget:
            raise ValueError('budget approval requires exhausted budget')
        entry = dict(round=len(state['diagnoses']) + 1, trigger=state['trigger'], batches=state['batches'],
                     last_fail=state['last_accept']['output'][-2000:], cause=cause, plan=plan,
                     at=time.time(), approval=approval or None)
        state.update(status='active', diagnoses=state['diagnoses'] + [entry], window_batches=0,
                     same_cause=0, no_progress=0, last_fp=None, hook_blocks=0,
                     hook_fp=None, hook_epoch=None, unanswered_blocks=0, auth_kind=None, trigger=None,
                     extra_rounds=state['extra_rounds'] + bool(approval))
        atomic(directory / 'state.json', state)
    print(json.dumps(state, ensure_ascii=False))
    return 0


def run(args):
    refuse_worker()
    directory, task = load_task(args.task)
    try:
        with lock(directory / 'run.lock', True):
            return supervise(directory, task)
    except BlockingIOError:
        return 75


def supervise(directory, task):
    state = read(directory / 'state.json')
    if state['status'] != 'active':
        print(json.dumps(state, ensure_ascii=False))
        return CODES[state['status']]
    previous = ''
    while True:
        state = read(directory / 'state.json')
        if state['status'] != 'active':
            return CODES[state['status']]
        result = accept(task)
        update(directory, last_accept=result)
        if result.get('tampered'):
            return finish(directory, 'violation', result['output'])
        if result['ok']:
            return finish(directory, 'done')
        if result['timeout'] or result.get('error'):
            return finish(directory, 'blocked', result.get('error', 'acceptance failed'))
        if state['window_batches'] >= task['max_batches']:
            return to_diagnosis(directory, task, 'batch_window')
        n = state['batches'] + 1
        before = snapshot(task)
        artifacts = Path(task['run_dir'])
        prompt = handoff(task, result, previous, state)
        (artifacts / f'handoff-{n}.md').write_text(prompt)
        last = artifacts / f'last-{n}.md'
        event_path = artifacts / f'events-{n}.jsonl'
        stderr_path = artifacts / f'stderr-{n}.log'
        executable = os.environ.get('CODEX_WHIP_CODEX_BIN') or shutil.which('codex')
        if not executable:
            return finish(directory, 'blocked', 'codex executable not found')
        argv = [executable, 'exec']
        if state['session_id']:
            argv += ['resume']
        else:
            argv += ['--sandbox', 'workspace-write', '--cd', task['workdir']]
        argv += ['--skip-git-repo-check', '--json', '-o', str(last)]
        if task['effort'] is not None:
            argv += ['-c', 'model_reasoning_effort=' + json.dumps(task['effort'])]
        argv += [state['session_id'], '-'] if state['session_id'] else ['-']
        env = dict(os.environ, CODEX_WHIP_WORKER='1')
        env.pop('CODEX_WHIP_TASK', None)
        timed_out = False
        try:
            with event_path.open('w') as stdout, stderr_path.open('w') as stderr:
                proc = run_process(argv, input=prompt, stdin=subprocess.PIPE, text=True, cwd=task['workdir'], env=env,
                                      stdout=stdout, stderr=stderr, timeout=task['worker_timeout'])
            rc = proc.returncode
        except subprocess.TimeoutExpired:
            timed_out = True
            rc = None
        except OSError as error:
            return finish(directory, 'blocked', str(error), batches=n)
        (artifacts / f'exit-{n}').write_text(str(rc) + '\n')
        try:
            ids, commands = events(event_path)
        except (ValueError, TypeError) as error:
            return finish(directory, 'blocked', 'invalid worker event JSON: ' + str(error), batches=n)
        worker_sessions = sorted(set(state['worker_sessions']) | ids)
        update(directory, batches=n, window_batches=state['window_batches'] + 1, worker_sessions=worker_sessions)
        # Changes are checked even when the worker exits unsuccessfully or times out.
        after = snapshot(task)
        changed = sorted(name for name in before.keys() | after.keys() if before.get(name) != after.get(name))
        outside = [name for name in changed if not allowed(name, task)]
        if outside:
            return finish(directory, 'violation', 'outside allow: ' + ', '.join(outside))
        for command in commands:
            kind = command_kind(command)
            if kind:
                return finish(directory, 'nested', kind + ': ' + command)
        if timed_out:
            return finish(directory, 'blocked', 'worker timed out')
        if len(ids) != 1 or (state['session_id'] and ids != {state['session_id']}):
            return finish(directory, 'blocked', 'missing or inconsistent thread.started session ID')
        sid = next(iter(ids))
        update(directory, session_id=sid)
        post = accept(task)
        update(directory, last_accept=post)
        if post.get('tampered'):
            return finish(directory, 'violation', post['output'])
        if post['timeout'] or post.get('error'):
            return finish(directory, 'blocked', post.get('error', 'acceptance failed'))
        if post['ok']:
            return finish(directory, 'done')
        previous = last.read_text() if last.exists() else ''
        report_status = verdict(previous)
        if report_status:
            return finish(directory, report_status, previous)
        fp = fingerprint(post) if rc == 0 else ['worker', rc, stderr_path.read_text()[-12000:]]
        same = state['same_cause'] + 1 if fp == state['last_fp'] else 1
        allowed_changed = any(allowed(name, task) for name in changed)
        no_progress = state['no_progress'] + 1 if not allowed_changed and fingerprint(post) == fingerprint(result) else 0
        update(directory, last_fp=fp, same_cause=same, no_progress=no_progress)
        if same >= 2 or no_progress >= 2:
            return to_diagnosis(directory, task, 'same_cause' if same >= 2 else 'no_progress')


def check(args):
    directory, task = load_task(args.task)
    result = accept(task)
    extra = {'status': 'blocked', 'reason': result.get('error', '')} if result['timeout'] or result.get('error') else {}
    if result.get('tampered'):
        extra = {'status': 'violation', 'reason': result['output']}
    update(directory, last_accept=result, **extra)
    print(json.dumps(result, ensure_ascii=False))
    return 6 if result.get('tampered') else 0 if result['ok'] else 3


def locate(event):
    explicit = os.environ.get('CODEX_WHIP_TASK')
    if explicit:
        path = Path(explicit)
        if not path.is_absolute():
            raise ValueError('CODEX_WHIP_TASK must be absolute')
        path = path.resolve()
        if path.parent.parent != home() / 'tasks' or path.name != 'task.json':
            raise ValueError('CODEX_WHIP_TASK must point to HOME/tasks/ID/task.json')
        return path.parent, read(path)
    sid = event.get('session_id')
    if sid:
        binding = home() / 'bindings' / (safe(sid) + '.json')
        if binding.exists():
            return load_task(read(binding)['task'])
    return None


def gate_reason(task, state, result):
    command = shlex.join(['python3', '-I', str(Path(__file__).resolve())])
    reason = (f"codex-whip task {task['id']}: acceptance exit {result['exit']}\n验收命令：cd " +
              shlex.quote(task['workdir']) + ' && ' +
              shlex.join([a.replace('{workdir}', task['workdir']) for a in task['acceptance']]) + '\n' +
              '\n'.join(result['output'].splitlines()[-20:]))
    if state['status'] == 'needs_diagnosis':
        reason += (f"\n触发：{state['trigger']}；总批次 {state['batches']}；诊断 "
                   f"{len(state['diagnoses'])}/{task.get('max_rounds', 3) + state['extra_rounds']}。"
                   '\n读取失败证据，找出根因并换方案；不得修改验收或保护文件。运行 ' + command +
                   ' diagnose --task ' + task['id'] + " --cause '<根因>' --plan '<与以往不同的新方案>'，再运行 ")
    else:
        reason += '\n在本会话直接修复，或运行 '
    return (reason + command + ' run --task ' + task['id'] +
            '。真实阻塞、需要授权或用户暂停时先 mark --task ' + task['id'] +
            ' --status blocked|need_auth|paused --reason 原因，再结束。')


def stop_hook():
    response = {}
    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict):
            raise ValueError('Stop event must be a JSON object')
        if os.environ.get('CODEX_WHIP_WORKER') == '1':
            print('{}')
            return 0
        located = locate(event)
        if located:
            directory, task = located
            if not running(directory):
                with lock(directory / 'state.lock'):
                    state = read(directory / 'state.json')
                    sid = event.get('session_id')
                    if (state['status'] in ('active', 'needs_diagnosis') and sid and sid not in state['worker_sessions'] and
                            (not task['bound_session'] or sid == task['bound_session'])):
                        prev = state['status']
                        result = accept(task)
                        state['last_accept'] = result
                        if result.get('tampered'):
                            state.update(status='violation', reason=result['output'])
                        elif result['ok']:
                            state['status'] = 'done'
                        elif result['timeout'] or result.get('error'):
                            state.update(status='blocked', reason=result.get('error', 'acceptance failed'))
                        else:
                            epoch = state['batches'] + len(state['diagnoses'])
                            if state['status'] == 'active':
                                if ((event.get('stop_hook_active') and state['hook_fp'] == fingerprint(result)
                                     and state['hook_epoch'] == epoch) or state['hook_blocks'] >= task['max_batches'] + 2):
                                    state.update(diagnosis_state(task, state, 'stop_repeat'))
                                else:
                                    state['hook_blocks'] += 1
                            state['hook_fp'] = fingerprint(result)
                            state['hook_epoch'] = epoch
                            if state['status'] != 'need_auth':
                                state['unanswered_blocks'] += 1
                                response = {'decision': 'block', 'reason': gate_reason(task, state, result)}
                        if prev in ('active', 'needs_diagnosis') and state['status'] in TERMINAL - {'done'}:
                            reason = (f"任务 {task['id']} 已转为 {state['status']}：{state['reason']}。"
                                      '停止修改，向用户报告原因。')
                            if state['status'] == 'need_auth' and state.get('auth_kind') == 'budget':
                                reason += '向用户请求追加诊断授权；获批后使用 diagnose --budget-approval 写入用户原话。'
                            response = {'decision': 'block', 'reason': reason + '报告后结束。'}
                            state['unanswered_blocks'] += 1
                        atomic(directory / 'state.json', state)
                        with (directory / 'hook.log.jsonl').open('a') as log:
                            log.write(json.dumps({'session_id': sid, 'turn_id': event.get('turn_id'),
                                                  'status': state['status'], 'response': response,
                                                  'unanswered_blocks': state['unanswered_blocks'],
                                                  'acceptance': result}, ensure_ascii=False) + '\n')
    except (OSError, ValueError, TypeError, KeyError) as error:
        print('codex-whip stop-hook: ' + str(error), file=sys.stderr)
    print(json.dumps(response, ensure_ascii=False))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('init')
    for name in ('goal', 'acceptance-json'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--id')
    p.add_argument('--workdir', default=str(Path.cwd()))
    p.add_argument('--protect', action='append', default=[])
    p.add_argument('--max-batches', type=int, choices=range(1, 5), default=4)
    p.add_argument('--max-rounds', type=int, default=3)
    p.add_argument('--allow', action='append', required=True)
    p.add_argument('--effort', choices=['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    binding = p.add_mutually_exclusive_group()
    binding.add_argument('--bind-session', nargs='?', const=os.environ.get('CODEX_THREAD_ID', ''), default=os.environ.get('CODEX_THREAD_ID'))
    binding.add_argument('--no-bind', action='store_const', const=None, dest='bind_session')
    p = sub.add_parser('diagnose')
    for name in ('task', 'cause', 'plan'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--budget-approval', default='')
    for command in ('run', 'check', 'status', 'mark'):
        p = sub.add_parser(command)
        p.add_argument('--task', required=True)
        if command == 'mark':
            p.add_argument('--status', required=True, choices=['paused', 'blocked', 'need_auth', 'cancelled', 'active'])
            p.add_argument('--reason', required=True)
    sub.add_parser('stop-hook')
    try:
        args = parser.parse_args()
    except SystemExit as error:
        return 64 if error.code == 2 else error.code
    if args.command == 'stop-hook':
        return stop_hook()
    try:
        if args.command == 'init':
            if args.max_rounds < 1:
                raise ValueError('max-rounds must be positive')
            return init(args)
        if args.command == 'diagnose':
            return diagnose(args)
        if args.command == 'run':
            return run(args)
        if args.command == 'check':
            return check(args)
        directory, _ = load_task(args.task)
        state = read(directory / 'state.json')
        if args.command == 'mark':
            refuse_worker()
            if args.status == 'active' and state['status'] not in ('paused', 'blocked', 'need_auth'):
                raise ValueError('mark active requires paused, blocked or need_auth; use diagnose for needs_diagnosis')
            if args.status == 'active' and state.get('auth_kind') == 'budget':
                raise ValueError('budget exhausted; use diagnose with budget approval')
            status, reason = args.status, args.reason
            if status == 'active' and state['trigger']:
                status, reason = 'needs_diagnosis', 'unfinished diagnosis; run diagnose with a new plan'
            state = update(directory, status=status, reason=reason, unanswered_blocks=0)
        print(json.dumps(state, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError) as error:
        print('codex-whip: ' + str(error), file=sys.stderr)
        return 64


if __name__ == '__main__':
    sys.exit(main())
