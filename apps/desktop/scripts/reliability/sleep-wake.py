#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Sleep, then wake, without sleeping the Mac (--debug-simulate through a second launch;
# the running app has SP_TEST_HOOKS=1): the native streams close on sleep and reopen on
# wake, and the page resyncs (its stream to the receiver comes back).
import json
import urllib.request

from common import App, Receiver, args, finish, log, now_ms, receiver_id, shell_log, wait_for, Results

a = args(__doc__).parse_args()
r = Results("sleep-wake")
rx = Receiver(7827, f"{a.home}/state-7827", a.cli).start()
app = App(a.app, f"{a.home}/shell", "sleepwake").launch(rx.url)
rid = receiver_id(rx.url)


def viewers():
    """The ids of the page streams the receiver sees (the menu bar's is not a viewer)."""
    try:
        with urllib.request.urlopen(f"{rx.url}/api/ui/viewers", timeout=2) as res:
            return {v["id"] for v in json.loads(res.read()).get("viewers") or []}
    except Exception:
        return None


try:
    r.check(wait_for(lambda: app.connected(rid), 15) is not None, "connected")
    wait_for(lambda: app.marks().get("fcp"), 10)
    before = wait_for(viewers, 10) or set()
    log(f"page streams before: {before}")
    app.second(["--debug-simulate", "sleep"], rx.url)
    t = now_ms()
    r.check(wait_for(lambda: not app.connected(rid), 5) is not None, "sleep closes the native stream", f"{round(now_ms() - t)} ms")
    v_sleep = viewers()
    import time

    time.sleep(2)
    r.check(not app.connected(rid), "it stays closed while asleep (no reconnect)")
    app.second(["--debug-simulate", "wake"], rx.url)
    t = now_ms()
    r.check(wait_for(lambda: app.connected(rid), 5) is not None, "wake reopens it", f"{round(now_ms() - t)} ms")
    v_wake = wait_for(lambda: (v := viewers()) and (v - before) and v, 10)
    log(f"page streams asleep {v_sleep}, after wake {v_wake}")
    r.check(bool(v_wake), "the page resyncs on wake: its stream reconnects (a new viewer id at the receiver)", f"{v_wake}")
    lg = shell_log(app)
    r.check("will sleep" in lg and "did wake" in lg, "shell.log records sleep and wake")
finally:
    rx.stop()
    finish(app, r)
