#!/usr/bin/env python3
"""Create a separate macOS Baidu Netdisk launcher; never launch or quit apps."""

import argparse
from pathlib import Path
import plistlib
import shlex


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=("dark", "light"), default="dark")
    args = parser.parse_args()

    app = args.app.expanduser().resolve()
    source_info = app / "Contents/Info.plist"
    if app.suffix != ".app" or not source_info.is_file():
        parser.error("--app must be an existing macOS .app with Contents/Info.plist")
    info = plistlib.loads(source_info.read_bytes())
    if info.get("CFBundleIdentifier") != "com.baidu.netdisk":
        parser.error("--app must identify the official Baidu Netdisk client (com.baidu.netdisk)")

    requested_output = args.output.expanduser()
    if requested_output.exists() or requested_output.is_symlink():
        parser.error("--output already exists; use a new path instead of overwriting it")
    output = requested_output.resolve()
    if output.suffix != ".app":
        parser.error("--output must end with .app")
    if output.is_relative_to(app):
        parser.error("--output must be outside the official application bundle")

    argv = ["/usr/bin/open", "-a", str(app)]
    if args.mode == "dark":
        argv += ["--args", "--force-dark-mode", "--blink-settings=forceDarkModeEnabled=true"]
    launcher = "#!/bin/sh\nset -eu\nexec " + shlex.join(argv) + "\n"
    bundle_info = {
        "CFBundleName": output.stem,
        "CFBundleDisplayName": output.stem,
        "CFBundleIdentifier": "local.baidunetdisk.launcher." + args.mode,
        "CFBundleExecutable": "launch",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "1.0",
        "CFBundleVersion": "1",
        "LSUIElement": True,
    }
    output.mkdir(parents=True, exist_ok=False)
    macos = output / "Contents/MacOS"
    macos.mkdir(parents=True)
    executable = macos / "launch"
    executable.write_text(launcher, encoding="utf-8")
    executable.chmod(0o755)
    (output / "Contents/Info.plist").write_bytes(plistlib.dumps(bundle_info))
    print(f"CREATED {args.mode} {output}")


if __name__ == "__main__":
    main()
