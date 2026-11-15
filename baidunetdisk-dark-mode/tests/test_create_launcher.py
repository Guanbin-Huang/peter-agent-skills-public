import hashlib
from pathlib import Path
import plistlib
import shlex
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/create_launcher.py"
FLAGS = ["--args", "--force-dark-mode", "--blink-settings=forceDarkModeEnabled=true"]


class LauncherTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.app = self.root / "原版 空格'与$符号.app"
        (self.app / "Contents/MacOS").mkdir(parents=True)
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "com.baidu.netdisk", "CFBundleExecutable": "BaiduNetdisk"
        }))
        (self.app / "Contents/MacOS/BaiduNetdisk").write_bytes(b"fixture only\n")
        self.output = self.root / "夜间 空格'与$符号.app"

    def run_script(self, mode="dark", output=None, app=None):
        return subprocess.run([
            sys.executable, str(SCRIPT), "--app", str(app or self.app),
            "--output", str(output or self.output), "--mode", mode,
        ], text=True, capture_output=True)

    def command(self, output):
        executable = output / "Contents/MacOS/launch"
        self.assertEqual(subprocess.run(["/bin/sh", "-n", str(executable)], capture_output=True).returncode, 0)
        self.assertEqual(executable.stat().st_mode & 0o777, 0o755)
        return shlex.split(executable.read_text().splitlines()[-1])

    def test_dark_exact_arguments_and_bundle(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.command(self.output), ["exec", "/usr/bin/open", "-a", str(self.app)] + FLAGS)
        info = plistlib.loads((self.output / "Contents/Info.plist").read_bytes())
        self.assertEqual(info["CFBundleExecutable"], "launch")
        self.assertEqual(info["CFBundleDisplayName"], self.output.stem)
        self.assertEqual(info["CFBundlePackageType"], "APPL")
        self.assertTrue(info["LSUIElement"])

    def test_light_is_independent_and_preserves_dark(self):
        self.assertEqual(self.run_script().returncode, 0)
        dark = (self.output / "Contents/MacOS/launch").read_bytes()
        light = self.root / "普通 启动.app"
        self.assertEqual(self.run_script("light", output=light).returncode, 0)
        self.assertEqual(self.command(light), ["exec", "/usr/bin/open", "-a", str(self.app)])
        self.assertEqual((self.output / "Contents/MacOS/launch").read_bytes(), dark)

    def test_repeat_output_is_unchanged(self):
        self.assertEqual(self.run_script().returncode, 0)
        before = (self.output / "Contents/MacOS/launch").read_bytes()
        self.assertEqual(self.run_script("light").returncode, 2)
        self.assertEqual((self.output / "Contents/MacOS/launch").read_bytes(), before)

    def test_existing_file_directory_and_symlink_are_preserved(self):
        for kind in ("file", "directory", "dangling-symlink"):
            with self.subTest(kind=kind):
                target = self.root / (kind + ".app")
                if kind == "file":
                    target.write_text("preserve me")
                elif kind == "directory":
                    target.mkdir()
                    (target / "marker").write_text("preserve me")
                else:
                    target.symlink_to(self.root / "not-created.app")
                self.assertEqual(self.run_script(output=target).returncode, 2)
                if kind == "dangling-symlink":
                    self.assertTrue(target.is_symlink())
                    self.assertFalse((self.root / "not-created.app").exists())
                else:
                    self.assertEqual((target if kind == "file" else target / "marker").read_text(), "preserve me")

    def test_missing_source(self):
        self.assertEqual(self.run_script(app=self.root / "missing.app").returncode, 2)
        self.assertFalse(self.output.exists())

    def test_other_application(self):
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "example.other"}))
        self.assertEqual(self.run_script().returncode, 2)
        self.assertFalse(self.output.exists())

    def test_invalid_mode(self):
        self.assertEqual(self.run_script("invalid").returncode, 2)
        self.assertFalse(self.output.exists())

    def test_nested_output(self):
        nested = self.app / "Contents/Nested.app"
        self.assertEqual(self.run_script(output=nested).returncode, 2)
        self.assertFalse(nested.exists())

    def test_output_extension(self):
        target = self.root / "not-an-app"
        self.assertEqual(self.run_script(output=target).returncode, 2)
        self.assertFalse(target.exists())

    def test_official_source_is_unchanged(self):
        before = {str(p.relative_to(self.app)): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in self.app.rglob("*") if p.is_file()}
        self.assertEqual(self.run_script().returncode, 0)
        after = {str(p.relative_to(self.app)): hashlib.sha256(p.read_bytes()).hexdigest()
                 for p in self.app.rglob("*") if p.is_file()}
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
