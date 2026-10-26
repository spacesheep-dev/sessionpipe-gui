# SPDX-License-Identifier: Apache-2.0
# Owned by: packaging. What measure.py and the reliability scripts share: demo receivers,
# the built app launched by its binary with a status file (NATIVE-SPEC §11.2), its stderr
# marks, the memory of all its processes, and the cleanup rule-24 asks for (every launched
# bundle unregistered from LaunchServices).
#
# Nothing here touches :7373 or ~/.local/state: every launch sets SP_RECEIVER_URL (which
# turns default discovery off) and SP_SHELL_HOME, and receivers run with --demo
# --no-outbox on loopback with a scratch --state.
import json
import os
import re
import signal
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]  # repo root (apps/desktop/scripts/lib → …)


def log(*a):
    print(*a, flush=True)


def now_ms():
    return time.time() * 1000.0


_awake = None


def keep_awake():
    """Hold off idle sleep while this script runs (`caffeinate -i -w <our pid>`, gone with
    us). A Mac that sleeps mid-run stretches a 60 s CPU sample to minutes and stops the
    shell's monotonic clock, so its marks no longer line up with ours."""
    global _awake
    if _awake is None and sys.platform == "darwin":
        _awake = subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_for(pred, timeout, every=0.05):
    """pred() until truthy or the timeout; returns its value or None."""
    end = time.time() + timeout
    while True:
        v = pred()
        if v:
            return v
        if time.time() >= end:
            return None
        time.sleep(every)


def http_json(url, timeout=1.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None


def iso_ms(s):
    """'2026-10-25T03:00:00.123Z' → epoch ms."""
    from datetime import datetime, timezone

    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc).timestamp() * 1000.0


# ---- receivers ----


class Receiver:
    """A demo receiver on loopback: node <cli> --demo --test-door --no-outbox."""

    def __init__(self, port, state, cli=None, extra=(), demo=True):
        assert port != 7373, "never :7373"
        self.port = port
        self.state = Path(state)
        self.cli = Path(cli or os.environ.get("SP_RX_CLI") or ROOT / "dist" / "cli.js")
        self.extra = list(extra)
        self.demo = demo
        self.proc = None

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def answering(self):
        j = http_json(f"{self.url}/api/ui/info", 0.5)
        return bool(j and j.get("name") == "sessionpipe-gui")

    def start(self, timeout=15):
        if self.answering():
            raise RuntimeError(f":{self.port} already answers; stop it first")
        self.state.mkdir(parents=True, exist_ok=True)
        args = ["node", str(self.cli), *(["--demo"] if self.demo else []), "--test-door", "--no-outbox", "--host", "127.0.0.1", "--quiet",
                "--port", str(self.port), "--state", str(self.state), *self.extra]
        self.proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=open(self.state / "receiver.err", "a"))
        if not wait_for(self.answering, timeout, 0.1):
            self.stop()
            raise RuntimeError(f"receiver on :{self.port} didn't answer in {timeout} s (see {self.state}/receiver.err)")
        return self

    def stop(self, sig=signal.SIGTERM):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(sig)
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc = None
        wait_for(lambda: not self.answering(), 5)


# ---- the app ----

MARK = re.compile(r"\[shell\] (?:page (\w[\w-]*) at t\+(\d+) ms(?: \(navigation \+(\d+) ms\))?|window built at (\d+) ms|app built at (\d+) ms|"
                  r"page load finished at t\+(\d+) ms|main window created in (\d+) ms \(t\+(\d+) ms\))")


class App:
    """The built .app, launched by its binary (so the test owns the process and its env)."""

    def __init__(self, app_path, home, tag="run"):
        self.app = Path(app_path).resolve()
        macos = self.app / "Contents" / "MacOS"
        exes = [p for p in macos.iterdir() if p.is_file() and os.access(p, os.X_OK)]
        if len(exes) != 1:
            raise RuntimeError(f"expected one executable in {macos}, found {exes}")
        self.exe = exes[0]
        info = self.plist()
        self.product = info.get("CFBundleName") or self.app.stem
        self.identifier = info.get("CFBundleIdentifier", "")
        self.version = info.get("CFBundleShortVersionString", "")
        self.home = Path(home)
        self.home.mkdir(parents=True, exist_ok=True)
        self.status_path = self.home / f"status-{tag}.json"
        self.err_path = self.home / f"stderr-{tag}.log"
        self.proc = None
        self.t0 = None

    def plist(self):
        out = subprocess.run(["plutil", "-convert", "json", "-o", "-", str(self.app / "Contents" / "Info.plist")],
                             capture_output=True, text=True)
        return json.loads(out.stdout or "{}")

    def env(self, receiver_url, extra=None):
        # No receiver named: the app discovers one, and SP_LOCAL_STATE must say where (the
        # scratch receiver's run.json; with it set the default port is never probed).
        local_state = (extra or {}).get("SP_LOCAL_STATE")
        assert receiver_url or local_state, "every launch names its receiver or its run.json, never :7373"
        assert ":7373" not in (receiver_url or ""), "never :7373"
        e = dict(os.environ)
        e.pop("SP_RECEIVER_URL", None)
        e.update({
            "SP_SHELL_HOME": str(self.home),
            "SP_SHELL_STATUS": str(self.status_path),
            "SP_TEST_HOOKS": "1",
        })
        if receiver_url:
            e["SP_RECEIVER_URL"] = receiver_url
        # Our log lines on stderr too (until the shell's own logger is lifecycle's, shell.log
        # alone would do).
        e["RUST_LOG"] = "info"
        e.update(extra or {})
        return e

    def launch(self, receiver_url, extra_env=None, args=()):
        for p in (self.status_path, self.err_path):
            p.unlink(missing_ok=True)
        self.t0 = now_ms()
        self.proc = subprocess.Popen([str(self.exe), *args], env=self.env(receiver_url, extra_env),
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=open(self.err_path, "w"))
        return self

    def second(self, args, receiver_url, timeout=10, extra_env=None):
        """A second launch (single-instance hands argv to the running app and exits)."""
        p = subprocess.run([str(self.exe), *args], env=self.env(receiver_url, extra_env), stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, timeout=timeout)
        return p.returncode

    @property
    def pid(self):
        return self.proc.pid if self.proc else None

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def status(self):
        try:
            return json.loads(self.status_path.read_text())
        except Exception:
            return None

    def stderr(self):
        try:
            return self.err_path.read_text(errors="replace")
        except FileNotFoundError:
            return ""

    def marks(self):
        """{'app': ms, 'window': ms, 'load': [ms…], 'created': [(in, at)…], 'fcp': [ms…], <name>: [ms…]}"""
        m = {"load": [], "created": []}
        for g in MARK.finditer(self.stderr()):
            if g.group(1):
                m.setdefault(g.group(1), []).append(int(g.group(2)))
                if g.group(3):
                    m.setdefault(f"{g.group(1)}_nav", []).append(int(g.group(3)))
            elif g.group(4):
                m["window"] = int(g.group(4))
            elif g.group(5):
                m["app"] = int(g.group(5))
            elif g.group(6):
                m["load"].append(int(g.group(6)))
            elif g.group(7):
                m["created"].append((int(g.group(7)), int(g.group(8))))
        return m

    def screenshot(self, path):
        """screencapture -l of the app's main window (needs SP_WINID, a tool printing a pid's
        windows as "<id> x y w h"); returns the path or None."""
        tool = os.environ.get("SP_WINID")
        if not tool or not self.alive():
            return None
        rows = subprocess.run([tool, str(self.pid)], capture_output=True, text=True).stdout.split("\n")
        rows = [r.split() for r in rows if r.strip()]
        rows = [r for r in rows if int(r[3]) > 300 and int(r[4]) > 200]
        if not rows:
            return None
        # The main window is the biggest; AppKit keeps a 500×500 helper window around too.
        rows.sort(key=lambda r: int(r[3]) * int(r[4]), reverse=True)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["screencapture", "-x", "-o", "-l", rows[0][0], str(path)], capture_output=True)
        return path if Path(path).exists() else None

    def connected(self, receiver_id=None):
        s = self.status() or {}
        rs = s.get("receivers") or []
        return any(r.get("connected") and (receiver_id is None or r.get("id") == receiver_id) for r in rs)

    def quit(self, timeout=8):
        if self.alive():
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc = None

    # -- the processes and their memory --

    def helper_pids(self):
        """The app's WebKit helpers, by the names macOS gives them ("<product> Web Content",
        "… Graphics and Media", "… Networking"): XPC services are not our children."""
        out = subprocess.run(["lsappinfo", "list"], capture_output=True, text=True).stdout
        pids, current = {}, None
        for line in out.splitlines():
            h = re.match(r'\s*\d+\) "(.*)" ASN:', line)
            if h:
                current = h.group(1)
                continue
            p = re.match(r"\s*pid = (\d+)", line)
            if p and current:
                for kind in ("Web Content", "Graphics and Media", "Networking"):
                    if current == f"{self.product} {kind}":
                        pids.setdefault(kind, []).append(int(p.group(1)))
                current = None
        return pids

    def memory(self):
        """Phys footprint in MB: the app, each WebKit helper, and the sum."""
        pids = {"app": [self.pid]} if self.alive() else {}
        pids.update(self.helper_pids())
        flat = [p for v in pids.values() for p in v]
        if not flat:
            return {"total": 0.0}
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            path = f.name
        args = ["footprint", "-f", "bytes", "-j", path]
        for p in flat:
            args += ["-p", str(p)]
        subprocess.run(args, capture_output=True)
        try:
            data = json.loads(Path(path).read_text())
        finally:
            os.unlink(path)
        by_pid = {pr["pid"]: pr.get("footprint", 0) for pr in data.get("processes", [])}
        res = {k: round(sum(by_pid.get(p, 0) for p in v) / 1048576, 1) for k, v in pids.items()}
        res["total"] = round(sum(res.values()), 1)
        return res

    def cpu_samples(self, seconds, every=1.0):
        """%CPU of the app and its helpers, sampled with ps (ps's %cpu is a decaying average,
        so we also take cumulative CPU time at both ends for an exact mean)."""
        def kinds():
            k = {"app": [self.pid]} if self.alive() else {}
            k.update(self.helper_pids())
            return k

        def cputime(ps):
            """Cumulative CPU seconds by pid, for the pids still alive."""
            if not ps:
                return {}
            out = subprocess.run(["ps", "-o", "pid=,time=", "-p", ",".join(map(str, ps))], capture_output=True, text=True).stdout
            res = {}
            for line in out.splitlines():
                f = line.split()
                if len(f) != 2:
                    continue
                parts = f[1].split(":")
                sec = float(parts[-1]) + (int(parts[-2]) * 60 if len(parts) > 1 else 0)
                if len(parts) > 2:
                    sec += int(parts[-3].split("-")[-1]) * 3600
                res[int(f[0])] = sec
            return res

        k0 = kinds()
        ps0 = [p for v in k0.values() for p in v]
        t0, w0 = cputime(ps0), time.time()
        time.sleep(seconds)
        t1, w1 = cputime(ps0), time.time()
        span = w1 - w0
        # A helper that exits meanwhile (WebKit ends Web Content with the window) drops out.
        both = [p for p in ps0 if p in t0 and p in t1]
        delta = {p: t1[p] - t0[p] for p in both}
        by = {k: round(sum(delta.get(p, 0.0) for p in v) / span * 100, 3) for k, v in k0.items()}
        return {"mean_pct": round(sum(delta.values()) / span * 100, 3), "seconds": round(span, 1), "pids": len(both),
                "exited": len(ps0) - len(both), "by_process_pct": by}

    def wakeups(self, seconds):
        """Idle wakeups per second of the app process (top's IDLEW over the window)."""
        if not self.alive():
            return None
        n = max(2, int(seconds))
        out = subprocess.run(["top", "-l", str(n), "-s", "1", "-pid", str(self.pid), "-stats", "pid,idlew"],
                             capture_output=True, text=True).stdout
        vals = [int(m.group(1)) for m in re.finditer(rf"^\s*{self.pid}\s+(\d+)", out, re.M)]
        # The first sample is the total since start; the rest are per interval.
        vals = vals[1:]
        return round(statistics.mean(vals), 2) if vals else None

    def unregister(self):
        subprocess.run([LSREGISTER, "-u", str(self.app)], capture_output=True)
        left = subprocess.run([LSREGISTER, "-dump"], capture_output=True, text=True).stdout.count(str(self.app))
        return left


def median(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def write_json(path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj, indent=2, default=str) + "\n")


class Results:
    """PASS/FAIL lines and an exit code."""

    def __init__(self, name):
        self.name, self.fails, self.lines = name, 0, []

    def check(self, ok, what, detail=""):
        line = f"{'PASS' if ok else 'FAIL'}  {what}{('  ' + detail) if detail else ''}"
        self.lines.append(line)
        log(line)
        if not ok:
            self.fails += 1
        return ok

    def done(self):
        log(f"{self.name}: {'ok' if not self.fails else f'{self.fails} failed'}")
        sys.exit(1 if self.fails else 0)
