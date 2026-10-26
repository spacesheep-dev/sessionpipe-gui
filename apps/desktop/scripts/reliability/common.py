# SPDX-License-Identifier: Apache-2.0
# Owned by: packaging. The reliability scripts' shared arguments: the measurement app
# (build-mac.sh --measure), a scratch home, and the ports (NATIVE-SPEC §10: 7827–7830).
import argparse
import base64
import hashlib
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import harness  # noqa: E402,F401
from harness import App, Receiver, Results, keep_awake, log, now_ms, wait_for  # noqa: E402,F401

keep_awake()


def args(desc):
    ap = argparse.ArgumentParser(description=desc)
    ap.add_argument("--app", required=True, help="the measurement .app")
    ap.add_argument("--home", required=True, help="scratch dir: SP_SHELL_HOME, receivers' state")
    ap.add_argument("--cli", help="the receiver CLI (default dist/cli.js; run.json needs this branch's)")
    return ap


def receiver_id(origin):
    """sp-receivers' id: lowercase base32 of SHA-256(canonical origin), first 10 chars."""
    return base64.b32encode(hashlib.sha256(origin.encode()).digest()).decode().lower().rstrip("=")[:10]


def badge(app):
    """The Dock badge as LaunchServices reports it (StatusLabel), or "" when none."""
    # `lsappinfo info -app pid=N` answers without the label; the app's ASN carries it.
    asn = subprocess.run(["lsappinfo", "find", f"pid={app.pid}"], capture_output=True, text=True).stdout.strip()
    if not asn:
        return ""
    out = subprocess.run(["lsappinfo", "info", "-only", "StatusLabel", asn], capture_output=True, text=True).stdout
    import re

    m = re.search(r'"label"="([^"]*)"', out)
    return m.group(1) if m else ""


def shell_log(app):
    """shell.log, plus stderr (the log lines go there too with RUST_LOG=info)."""
    p = app.home / "logs" / "shell.log"
    return (p.read_text(errors="replace") if p.exists() else "") + app.stderr()


def finish(app, r):
    app.quit()
    left = app.unregister()
    r.check(left == 0, "the bundle is unregistered from LaunchServices", f"{left} records left")
    r.done()
