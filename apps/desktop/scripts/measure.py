#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Owned by: packaging. NATIVE-SPEC §8's budgets, measured on a built app (the measurement
# variant: build-mac.sh --measure) against a demo receiver. See measure.sh for the flags.
import argparse
import json
import platform
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from harness import App, Receiver, keep_awake, log, median, now_ms, wait_for, write_json  # noqa: E402

BUDGETS = {
    # key: (target, hard limit, unit, lower is better)
    "dmg_arm64_mb": (6, 10, "MB"),
    "app_arm64_mb": (20, 30, "MB"),
    "launch_fcp_ms": (250, 400, "ms"),
    "launch_live_ms": (400, 600, "ms"),
    "reopen_fcp_ms": (250, 400, "ms"),
    "ram_closed_mb": (30, 40, "MB"),
    "ram_open_20_mb": (120, 150, "MB"),
    "ram_open_200_mb": (180, 220, "MB"),
    "cpu_closed_pct": (0.1, 0.3, "%"),
    "wakeups_closed_per_s": (1, None, "/s"),
    "cpu_open_pct": (0.5, 1.0, "%"),
}


def verdict(key, v):
    if v is None:
        return "not measured"
    target, hard, _ = BUDGETS[key]
    if v <= target:
        return "within target"
    if hard is None or v <= hard:
        return "MISS target (within hard limit)"
    return "MISS hard limit"


def sizes(app, dmg):
    out = {}
    if app:
        kb = int(subprocess.run(["du", "-sk", app], capture_output=True, text=True).stdout.split()[0])
        out["app_arm64_mb"] = round(kb / 1024, 2)
    if dmg:
        out["dmg_arm64_mb"] = round(Path(dmg).stat().st_size / 1048576, 2)
    return out


def page_stream_ms(app, rx, timeout=15):
    """From the launch until the receiver sees the page's live stream (/api/ui/viewers; the
    menu bar's stream is not a viewer): the board has its snapshot and is live. Polled
    every 10 ms, so it reads up to ~15 ms late."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{rx.url}/api/ui/viewers", timeout=1) as res:
                if json.loads(res.read()).get("viewers"):
                    return round(now_ms() - app.t0)
        except Exception:
            pass
        time.sleep(0.01)
    return None


def one_launch(app, rx, i, settle):
    """One launch: main() → window built → page load → first contentful paint; the time
    until the page's live stream is open at the receiver; and the menu bar stream's first
    frame (status file lastFrameAt)."""
    app.launch(rx.url)
    stream = page_stream_ms(app, rx)
    m = wait_for(lambda: (app.marks() if app.marks().get("fcp") else None), 15)
    live = wait_for(lambda: next((r.get("lastFrameAt") for r in (app.status() or {}).get("receivers", []) if r.get("lastFrameAt")), None), 15)
    marks = m or app.marks()
    # The page reports first contentful paint as its startTime from navigation start
    # ("navigation +N ms") and the wall time its observer ran ("t+M"), which can be
    # 100–250 ms later than the paint. The paint itself: the webview's creation plus N.
    created = (marks.get("created") or [(None, None)])[0][1]
    nav = (marks.get("fcp_nav") or [None])[0]
    row = {
        "run": i,
        "window_ms": marks.get("window"),
        "load_ms": (marks.get("load") or [None])[0],
        "fcp_ms": created + nav if created is not None and nav is not None else (marks.get("fcp") or [None])[0],
        "fcp_observed_ms": (marks.get("fcp") or [None])[0],
        "live_mark_ms": (marks.get("live") or [None])[0],
        "page_stream_ms": stream,
        "first_frame_ms": None,
    }
    if live:
        from harness import iso_ms

        row["first_frame_ms"] = round(iso_ms(live) - app.t0)
    time.sleep(settle)
    return row


def live_from(res):
    lives = [r["live_mark_ms"] for r in res["runs"] if r.get("live_mark_ms") is not None]
    streams = [r.get("page_stream_ms") for r in res["runs"] if r.get("page_stream_ms") is not None]
    if lives:
        res["measured"]["launch_live_ms"], res["launch_live_source"] = median(lives), "the page's 'live' mark"
    elif streams:
        res["measured"]["launch_live_ms"] = median(streams)
        res["launch_live_source"] = "the page's live stream open at the receiver (/api/ui/viewers, 10 ms polling); the page has no 'live' mark yet"
    else:
        res["measured"]["launch_live_ms"] = median(r.get("first_frame_ms") for r in res["runs"])
        res["launch_live_source"] = "the menu bar stream's first frame (status file): a proxy, not the board"


def live_pass(a, app, home, res):
    """Only the launches' live time (merged into an earlier --out)."""
    rx = Receiver(a.port, home / f"state-{a.port}").start()
    try:
        one_launch(app, rx, 0, 0.5)
        app.quit()
        time.sleep(1)
        rows = []
        for i in range(1, a.runs + 1):
            row = one_launch(app, rx, i, 0.5)
            log(f"live {i}: {row}")
            rows.append(row)
            app.quit()
            time.sleep(1)
        by_run = {r["run"]: r for r in res.get("runs", [])}
        for row in rows:
            by_run.setdefault(row["run"], {}).update({"page_stream_ms": row["page_stream_ms"], "live_mark_ms": row["live_mark_ms"]})
        res["runs"] = [by_run[k] for k in sorted(by_run)]
        live_from(res)
        res.setdefault("medians", {})["page_stream_ms"] = median(r["page_stream_ms"] for r in rows)
    finally:
        app.quit()
        rx.stop()


def quiet_pass(a, app, home, res):
    # Idle means idle: the demo receiver changes something every second or two, so the
    # board and the menu bar stream are never quiet against it.
    rx3 = Receiver(a.port, home / f"state-{a.port}-quiet", extra=["--replay", a.quiet_replay, "--speed", "0"], demo=False)
    rx3.start(timeout=60)
    try:
        app.launch(rx3.url)
        wait_for(lambda: app.marks().get("fcp"), 15)
        # Let the first board render and the receiver's replay settle before "idle".
        time.sleep(a.quiet_settle)
        res["quiet_ram_open"] = app.memory()
        res["quiet_cpu_open"] = app.cpu_samples(a.idle_open)
        res["measured"]["cpu_open_pct"] = res["quiet_cpu_open"]["mean_pct"]
        log(f"quiet open: {res['quiet_ram_open']} cpu {res['quiet_cpu_open']}")
        app.second(["--debug-close-window"], rx3.url)
        wait_for(lambda: (app.status() or {}).get("window") == "closed", 5)
        time.sleep(5)
        res["quiet_ram_closed"] = app.memory()
        res["quiet_cpu_closed"] = app.cpu_samples(a.idle_closed)
        res["quiet_wakeups_closed_per_s"] = app.wakeups(30)
        res["measured"]["cpu_closed_pct"] = res["quiet_cpu_closed"]["mean_pct"]
        res["measured"]["wakeups_closed_per_s"] = res["quiet_wakeups_closed_per_s"]
        res["measured"]["ram_closed_mb"] = res["quiet_ram_closed"]["total"]
        res["idle_source"] = "quiet receiver (replay, no --demo); the live-demo numbers are under cpu_open / cpu_closed"
        log(f"quiet closed: {res['quiet_ram_closed']} cpu {res['quiet_cpu_closed']} wakeups {res['quiet_wakeups_closed_per_s']}/s")
    finally:
        app.quit()
        rx3.stop()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--app", required=True)
    ap.add_argument("--dmg")
    ap.add_argument("--home", required=True, help="SP_SHELL_HOME and scratch for this run")
    ap.add_argument("--port", type=int, default=7827)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--idle-closed", type=int, default=300, help="seconds of idle CPU with the window closed")
    ap.add_argument("--idle-open", type=int, default=60)
    ap.add_argument("--replay-200", help="a JSONL replay with ~200 sessions for the large-board memory")
    ap.add_argument("--quiet-replay", help="a JSONL replay (~20 sessions) served without --demo: idle CPU and RAM on a board where nothing happens")
    ap.add_argument("--out", required=True)
    ap.add_argument("--shots", help="a folder for window screenshots (needs SP_WINID)")
    ap.add_argument("--quiet-settle", type=int, default=20, help="seconds after first paint before the quiet board counts as idle")
    ap.add_argument("--only", choices=["quiet", "live"], help="one pass only, merged into an earlier --out: the quiet receiver's idle numbers, or the launches' live time")
    a = ap.parse_args()

    home = Path(a.home)
    keep_awake()
    if a.only:
        res = json.loads(Path(a.out).read_text())
        app = App(a.app, home / "shell", "measure")
        (quiet_pass if a.only == "quiet" else live_pass)(a, app, home, res)
        res["lsregister_left"] = app.unregister()
        res["verdicts"] = {k: {"value": res["measured"].get(k), "target": BUDGETS[k][0], "hard": BUDGETS[k][1], "unit": BUDGETS[k][2], "verdict": verdict(k, res["measured"].get(k))} for k in BUDGETS}
        write_json(a.out, res)
        log(json.dumps(res["verdicts"], indent=1))
        return 0
    res = {"machine": f"{platform.machine()} macOS {platform.mac_ver()[0]}", "when": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "measured": {}, "runs": []}
    res["measured"].update(sizes(a.app, a.dmg))
    app = App(a.app, home / "shell", "measure")
    res["app"] = {"path": str(app.app), "identifier": app.identifier, "version": app.version}
    if "dev.spacesheep.sessionpipe.dev-" not in app.identifier:
        log(f"refusing: {app.identifier} is not the measurement variant (build-mac.sh --measure)")
        return 2

    rx = Receiver(a.port, home / f"state-{a.port}").start()
    try:
        # Warm the disk cache once (not counted), then the measured runs.
        log("launch: warm-up")
        one_launch(app, rx, 0, 0.5)
        app.quit()
        time.sleep(1)
        for i in range(1, a.runs + 1):
            row = one_launch(app, rx, i, 0.5)
            log(f"launch {i}: {row}")
            res["runs"].append(row)
            if i < a.runs:
                app.quit()
                time.sleep(1)
        res["measured"]["launch_fcp_ms"] = median(r["fcp_ms"] for r in res["runs"])
        live_from(res)
        res["medians"] = {k: median(r.get(k) for r in res["runs"]) for k in ("window_ms", "load_ms", "fcp_ms", "fcp_observed_ms", "page_stream_ms", "first_frame_ms")}
        res["fcp_note"] = "fcp_ms = webview created (t+) + the page's FCP startTime; fcp_observed_ms = when the page's PerformanceObserver reported it"

        # The last run stays up: memory with the window open (the demo's sessions).
        time.sleep(3)
        info = json.loads(subprocess.run(["curl", "-s", f"{rx.url}/api/ui/snapshot"], capture_output=True, text=True).stdout or "{}")
        res["sessions_open"] = len(info.get("sessions", [])) if isinstance(info, dict) else None
        if a.shots:
            res["shot_open"] = app.screenshot(Path(a.shots) / "measure-board.png")
        res["ram_open"] = app.memory()
        res["measured"]["ram_open_20_mb"] = res["ram_open"]["total"]
        log(f"ram open: {res['ram_open']} ({res['sessions_open']} sessions)")
        cpu = app.cpu_samples(a.idle_open)
        res["cpu_open"] = cpu
        res["measured"]["cpu_open_pct"] = cpu["mean_pct"]
        log(f"cpu open: {cpu}")

        # Reopen: ⌘W (the test hook closes the main window), then a second launch opens it.
        loads_before = len(app.marks().get("fcp", []))
        app.second(["--debug-close-window"], rx.url)
        closed = wait_for(lambda: (app.status() or {}).get("window") == "closed", 5)
        time.sleep(2)
        res["ram_closed_after_close"] = app.memory()
        reopen, reopen_paint = [], []
        for _ in range(3):
            t = now_ms()
            app.second([], rx.url)
            ok = wait_for(lambda: len(app.marks().get("fcp", [])) > loads_before, 10)
            if ok:
                reopen.append(round(now_ms() - t))
                mk = app.marks()
                # In the running app, from "open the window" (what a Dock click's Reopen
                # does) to the new page's first paint: the window's build time plus the
                # page's FCP into its navigation. One process's clock, so no sleep or
                # launch skew; `observed` adds the second launch's handover and polling.
                built_in, nav = mk["created"][-1][0], mk["fcp_nav"][-1]
                reopen_paint.append(built_in + nav)
                loads_before = len(mk.get("fcp", []))
            app.second(["--debug-close-window"], rx.url)
            wait_for(lambda: (app.status() or {}).get("window") == "closed", 5)
            time.sleep(1)
        res["reopen_runs_ms"] = reopen_paint
        res["reopen_observed_ms"] = reopen
        res["measured"]["reopen_fcp_ms"] = median(reopen_paint)
        res["reopen_note"] = "in the running app: the new window's build time + its page's FCP (what a Dock click costs); observed = from a second launch (its own process, then the handover) until the script saw the mark"
        log(f"reopen: {reopen} (window closed seen: {bool(closed)})")

        # Window closed: memory and idle CPU, wakeups.
        time.sleep(5)
        res["ram_closed"] = app.memory()
        res["measured"]["ram_closed_mb"] = res["ram_closed"]["total"]
        log(f"ram closed: {res['ram_closed']}")
        cpu = app.cpu_samples(a.idle_closed)
        res["cpu_closed"] = cpu
        res["measured"]["cpu_closed_pct"] = cpu["mean_pct"]
        res["measured"]["wakeups_closed_per_s"] = app.wakeups(30)
        log(f"cpu closed: {cpu}, wakeups {res['measured']['wakeups_closed_per_s']}/s")
        app.quit()
    finally:
        app.quit()
        rx.stop()

    if a.replay_200:
        rx2 = Receiver(a.port, home / f"state-{a.port}-200", extra=["--replay", a.replay_200, "--speed", "0"])
        rx2.start(timeout=60)
        try:
            app.launch(rx2.url)
            wait_for(lambda: app.marks().get("fcp"), 15)
            time.sleep(8)
            info = json.loads(subprocess.run(["curl", "-s", f"{rx2.url}/api/ui/snapshot"], capture_output=True, text=True).stdout or "{}")
            res["sessions_200"] = len(info.get("sessions", [])) if isinstance(info, dict) else None
            res["ram_open_200"] = app.memory()
            res["measured"]["ram_open_200_mb"] = res["ram_open_200"]["total"]
            log(f"ram 200: {res['ram_open_200']} ({res['sessions_200']} sessions)")
        finally:
            app.quit()
            rx2.stop()

    if a.quiet_replay:
        quiet_pass(a, app, home, res)

    left = app.unregister()
    res["lsregister_left"] = left
    res["verdicts"] = {k: {"value": res["measured"].get(k), "target": BUDGETS[k][0], "hard": BUDGETS[k][1], "unit": BUDGETS[k][2], "verdict": verdict(k, res["measured"].get(k))} for k in BUDGETS}
    write_json(a.out, res)
    log(json.dumps(res["verdicts"], indent=1))
    log(f"lsregister -u {app.app}: {left} records left")
    return 0


if __name__ == "__main__":
    sys.exit(main())
