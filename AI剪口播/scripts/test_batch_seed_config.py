#!/usr/bin/env python3
"""Offline configuration regression: all ASR/curl calls are local stubs."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(os.environ.get('ASR_TEST_SCRIPTS_DIR', Path(__file__).resolve().parent))


class BatchSeedConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.scripts = self.root / 'scripts'
        self.scripts.mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.env = {'PATH': str(self.bin) + ':/usr/bin:/bin', 'HOME': str(self.root),
                    'TMPDIR': str(self.root), 'STUB_LOG': str(self.root / 'calls.jsonl')}
        for name in ('batch_transcribe.sh', 'volcengine_v3_transcribe.sh'):
            shutil.copy2(SCRIPTS / name, self.scripts / name)
        self.videos = []
        for i in range(4):
            video = self.root / f'video {i}.mp4'
            video.write_bytes(b'local fixture')
            self.videos.append(str(video))
        self.write('scripts/run_transcribe.sh', '''#!/bin/bash
exec "$STUB_PYTHON" "$STUB_RUNNER" "$@"
''')
        self.write('runner.py', '''import json, os, sys
with open(os.environ['STUB_LOG'], 'a') as f:
    f.write(json.dumps({'args':sys.argv[1:], 'resource':os.environ.get('VOLCENGINE_ASR_RESOURCE_ID')})+'\\n')
if os.environ.get('FAIL_FLASH') == '1' and sys.argv[-1] == '--flash':
    sys.exit(1)
''')
        self.env.update(STUB_PYTHON=sys.executable, STUB_RUNNER=str(self.root / 'runner.py'))

    def write(self, name, text, executable=False):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        if executable:
            path.chmod(0o755)

    def calls(self):
        log = Path(self.env['STUB_LOG'])
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def batch(self, **env):
        return subprocess.run(['/bin/bash', str(self.scripts / 'batch_transcribe.sh'),
                               str(self.root / 'output'), *self.videos],
                              env=self.env | env, capture_output=True, text=True, timeout=10)

    def test_four_jobs_default_to_seed_standard(self):
        proc = self.batch(BATCH_JOBS='4')
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(len(self.calls()), 4)
        self.assertTrue(all(c['args'][-1] == '--v3-standard' and c['resource'] == 'volc.seedasr.auc'
                            for c in self.calls()))

    def test_default_jobs_and_engine(self):
        self.assertEqual(self.batch().returncode, 0)
        self.assertEqual(len(self.calls()), 4)
        self.assertTrue(all(c['args'][-1] == '--v3-standard' for c in self.calls()))

    def test_custom_standard_resource_is_preserved(self):
        self.assertEqual(self.batch(ASR_ENGINE='v3-standard', VOLCENGINE_ASR_RESOURCE_ID='custom.fixture').returncode, 0)
        self.assertTrue(all(c['resource'] == 'custom.fixture' for c in self.calls()))

    def test_resource_passes_env_file_dispatch_branch(self):
        fixture_env = self.root / 'empty-env.fixture'
        fixture_env.write_text('# empty fixture; no credentials\n')
        self.assertEqual(self.batch(VOLCENGINE_ENV_FILE=str(fixture_env)).returncode, 0)
        self.assertTrue(all(c['resource'] == 'volc.seedasr.auc' for c in self.calls()))

    def test_explicit_flash_unchanged(self):
        self.assertEqual(self.batch(ASR_ENGINE='flash').returncode, 0)
        self.assertTrue(all(c['args'][-1] == '--flash' and c['resource'] is None for c in self.calls()))

    def test_explicit_auto_unchanged(self):
        self.assertEqual(self.batch(ASR_ENGINE='auto').returncode, 0)
        self.assertTrue(all(c['args'][-1] == '--auto' and c['resource'] is None for c in self.calls()))

    def test_flash_retry_uses_seed_standard(self):
        self.assertEqual(self.batch(ASR_ENGINE='flash', FAIL_FLASH='1').returncode, 0)
        standards = [c for c in self.calls() if c['args'][-1] == '--v3-standard']
        self.assertEqual(len(standards), 4)
        self.assertTrue(all(c['resource'] == 'volc.seedasr.auc' for c in standards))

    def test_invalid_concurrency_rejected_before_dispatch(self):
        for jobs in ('0', '5', '-1', 'foo'):
            with self.subTest(jobs=jobs):
                self.assertNotEqual(self.batch(BATCH_JOBS=jobs).returncode, 0)
        self.assertEqual(self.calls(), [])

    def lower(self, resource=None):
        self.write('scripts/lib/load_api_key.sh', 'API_KEY=local-fixture-only\n')
        self.write('scripts/lib/volc_common.sh', '''volc_gen_request_id() { echo fixture-request; }
volc_build_request() { printf '{}' > "$2"; }
volc_status() { echo 20000000; }
volc_header() { echo fixture; }
volc_word_count() { echo 1; }
''')
        self.write('bin/sleep', '#!/bin/sh\nexit 0\n', executable=True)
        self.write('bin/curl', f'#!{sys.executable}\n' + '''import json, os, sys
a=sys.argv[1:]
headers=[a[i+1] for i,v in enumerate(a[:-1]) if v=='-H']
resource=[v.split(':',1)[1].strip() for v in headers if v.lower().startswith('x-api-resource-id:')]
with open(os.environ['STUB_LOG'],'a') as f:
    f.write(json.dumps({'resource':resource})+'\\n')
for option, data in [('-D','HTTP/1.1 200 OK\\r\\n'),('-o','{"result":{"text":"fixture"}}')]:
    if option in a:
        with open(a[a.index(option)+1],'w') as f: f.write(data)
if '-w' in a: print('200',end='')
''', executable=True)
        env = self.env.copy()
        if resource is not None:
            env['VOLCENGINE_ASR_RESOURCE_ID'] = resource
        proc = subprocess.run(['/bin/bash', str(self.scripts / 'volcengine_v3_transcribe.sh'),
                               self.videos[0], str(self.root / 'lower-output')],
                              env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(len(self.calls()), 2)
        return self.calls()

    def test_lower_default_keeps_legacy_resource(self):
        self.assertTrue(all(c['resource'] == ['volc.bigasr.auc'] for c in self.lower()))

    def test_lower_custom_resource_reaches_submit_and_query(self):
        self.assertTrue(all(c['resource'] == ['volc.seedasr.auc'] for c in self.lower('volc.seedasr.auc')))


if __name__ == '__main__':
    unittest.main()
