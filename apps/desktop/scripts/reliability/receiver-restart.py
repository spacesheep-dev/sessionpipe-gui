#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Kill the receiver on 7827 and start it again: the app is connected again ≤ 5 s after the
# receiver is back; with the receiver down, the Dock badge is clear by 60 s. The receiver
# replays fixtures/needs-you.jsonl (one session waiting on a permission) beside the demo,
# so there is always a badge to clear.
from pathlib import Path

from common import App, Receiver, args, badge, finish, log, now_ms, receiver_id, wait_for, Results

a = args(__doc__).parse_args()
r = Results("receiver-restart")
fixture = Path(__file__).resolve().parent / "fixtures" / "needs-you.jsonl"
state = f"{a.home}/state-7827"
rx = Receiver(7827, state, a.cli, ["--replay", str(fixture), "--speed", "0"]).start()
# SP_LOCAL_STATE: the receiver's state dir is where its run.json says it is back (a person's
# local service writes it in the default state dir, which a test run never reads).
app = App(a.app, f"{a.home}/shell", "restart").launch(rx.url, {"SP_LOCAL_STATE": state})
rid = receiver_id(rx.url)
try:
    r.check(wait_for(lambda: app.connected(rid), 15) is not None, "connected at launch")
    n = wait_for(lambda: (app.status() or {}).get("needsYou"), 20)
    b = wait_for(lambda: badge(app), 5) or ""
    r.check(bool(n) and b == str(n), "the Dock badge shows the needs-you count", f"needsYou {n}, badge {b!r}")
    rx.stop()
    down = now_ms()
    r.check(wait_for(lambda: not app.connected(rid), 10) is not None, "sees the receiver go", f"{round(now_ms() - down)} ms")
    early = wait_for(lambda: badge(app) == "" or None, 55, 0.5)
    r.check(early is None, "the badge keeps the count for the first minute (NATIVE-SPEC §3.3)", f"badge {badge(app)!r} at 55 s")
    cleared = wait_for(lambda: badge(app) == "" or None, 20, 0.5)
    secs = round((now_ms() - down) / 1000, 1)
    # 60 s, then tray.rs looks at the rule only after 5 s without a hub event, and the
    # reconnect attempts are hub events: in practice 61–69 s.
    r.check(cleared is not None and secs <= 70, "the Dock badge clears ~60 s after the receiver goes (≤ 70 s)", f"{secs} s (badge was {b!r})")
    rx.start()
    back = now_ms()
    ok = wait_for(lambda: app.connected(rid), 35)
    took = round(now_ms() - back)
    r.check(ok is not None and took <= 5000, "connected again ≤ 5 s after the receiver is back (down > 60 s)", f"{took} ms")
    r.check(wait_for(lambda: badge(app), 10) == b, "the badge comes back with the count", f"{badge(app)!r}")
    # Down only briefly this time (backoff still short).
    rx.stop()
    wait_for(lambda: not app.connected(rid), 10)
    rx.start()
    back = now_ms()
    ok = wait_for(lambda: app.connected(rid), 35)
    took = round(now_ms() - back)
    r.check(ok is not None and took <= 5000, "after a short outage too", f"{took} ms")
finally:
    rx.stop()
    finish(app, r)
