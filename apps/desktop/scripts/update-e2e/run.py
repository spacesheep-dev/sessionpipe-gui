#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Owned by: packaging. The updater end to end, on this Mac and nowhere near /Applications:
#
#   run.py --key <minisign private key> --out <scratch dir> [--skip-build]
#
# 1. Builds the measurement variant twice, 0.0.1-test and 0.0.2-test, signed with the
#    given (throwaway) key: <out>/v1/sessionpipe.app and <out>/v2/sessionpipe.app.tar.gz+.sig.
# 2. Serves latest.json and the archive from 127.0.0.1:7830 (the measurement config's
#    endpoint; dangerousInsecureTransportProtocol is set there only).
# 3. Runs 0.0.1-test against a demo receiver on 7827 and waits for the updater's state to
#    be "ready" (checked 10 s after launch), then does what "Restart to Update" does
#    (--debug-update restart, a test hook) and checks the app that comes back is 0.0.2-test
#    (the status file's version, and the bundle on disk).
import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
from harness import App, Receiver, Results, keep_awake, log, wait_for  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--key", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--skip-build", action="store_true")
ap.add_argument("--cli")
a = ap.parse_args()
keep_awake()
out = Path(a.out).resolve()
r = Results("update-e2e")


def build(version, dest):
    env = dict(os.environ)
    env["TAURI_SIGNING_PRIVATE_KEY"] = Path(a.key).read_text().strip()
    env.setdefault("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "")
    cmd = [str(HERE.parent / "build-mac.sh"), "--measure", "--sign", "--version", version, "--out", str(dest)]
    log("$", " ".join(cmd))
    with open(out / f"build-{version}.log", "w") as f:
        p = subprocess.run(cmd, env=env, stdout=f, stderr=subprocess.STDOUT)
    if p.returncode:
        raise SystemExit(f"build {version} failed: see {out}/build-{version}.log")


out.mkdir(parents=True, exist_ok=True)
if not a.skip_build:
    for v, d in (("0.0.1-test", "v1"), ("0.0.2-test", "v2")):
        build(v, out / d)

v1_app = next((out / "v1").glob("*.app"))
tarball = next((out / "v2").glob("*.app.tar.gz"))
sig = Path(f"{tarball}.sig").read_text().strip()
serve = out / "serve"
serve.mkdir(exist_ok=True)
(serve / tarball.name).write_bytes(tarball.read_bytes())
latest = {
    "version": "0.0.2-test",
    "notes": "The updater end-to-end test.",
    "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {"darwin-aarch64": {"signature": sig, "url": f"http://127.0.0.1:7830/{tarball.name}"}},
}
(serve / "latest.json").write_text(json.dumps(latest, indent=2))

server = subprocess.Popen([sys.executable, "-m", "http.server", "7830", "--bind", "127.0.0.1", "--directory", str(serve)],
                          stdout=subprocess.DEVNULL, stderr=open(out / "http.log", "w"))
rx = Receiver(7827, out / "state-7827", a.cli)
app = App(v1_app, out / "shell", "update")
try:
    time.sleep(0.5)
    rx.start()
    r.check(app.version == "0.0.1-test", "the installed app is 0.0.1-test", app.version)
    app.launch(rx.url, {"SP_UPDATE_URL": "http://127.0.0.1:7830/latest.json"})
    first_pid = app.pid
    r.check(wait_for(lambda: (app.status() or {}).get("version") == "0.0.1-test", 15) is not None, "0.0.1-test is running")

    def state():
        app.second(["--debug-update", "status"], rx.url)
        time.sleep(0.3)
        lines = [l for l in app.stderr().splitlines() if "test hook: update state" in l]
        return json.loads(lines[-1].split("update state ", 1)[1]) if lines else {}

    ready = wait_for(lambda: state().get("state") == "ready" and state(), 60, 2)
    r.check(bool(ready), "the update is downloaded and verified: state ready", json.dumps(ready or state()))
    served = (out / "http.log").read_text()
    r.check("GET /latest.json" in served and f"GET /{tarball.name}" in served, "it fetched latest.json and the archive from :7830")
    # The restart leg only when the app relaunches through lifecycle::relaunch, which keeps
    # SP_RECEIVER_URL and friends: tauri's own restart() reopens the bundle through
    # LaunchServices with a clean environment, i.e. as a release app that probes :7373.
    carried = b"opening the bundle again with the dev environment" in app.exe.read_bytes()
    if not r.check(carried, "Restart to Update keeps the test environment (lifecycle::relaunch is linked)",
                   "" if carried else "updater::restart still calls app.restart(): restart leg skipped"):
        raise SystemExit(0)
    app.second(["--debug-update", "restart"], rx.url)
    # The old process exits and the new one comes up with the same env (status file).
    gone = wait_for(lambda: app.proc.poll() is not None, 20)
    r.check(gone is not None, "0.0.1-test exits to install")
    new = wait_for(lambda: (app.status() or {}).get("version") == "0.0.2-test", 30)
    r.check(new is not None, "the app that comes back reports 0.0.2-test (status file)", json.dumps(app.status()))
    r.check(App(v1_app, out / "shell", "check").version == "0.0.2-test", "the bundle on disk is 0.0.2-test", str(v1_app))
    r.check("/Applications" not in str(v1_app), "nothing in /Applications", str(v1_app))
except SystemExit:
    pass
finally:
    # The restarted app is not our child: find it by its executable path.
    subprocess.run(["pkill", "-TERM", "-f", str(app.exe)], capture_output=True)
    time.sleep(1)
    app.quit()
    rx.stop()
    server.terminate()
    server.wait()
    left = app.unregister()
    for d in ("v2",):
        for b in (out / d).glob("*.app"):
            subprocess.run(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-u", str(b)], capture_output=True)
    r.check(left == 0, "the bundle is unregistered from LaunchServices", f"{left} records left")
r.done()
