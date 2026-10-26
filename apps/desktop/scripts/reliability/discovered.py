#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# The first launch on a Mac whose receiver is already running (0.3.1 stayed on its first
# frame here): no receiver named, the page finds this Mac's (its run.json, SP_LOCAL_STATE),
# the shell builds the window again on it, and the board fills, from a snapshot the size of
# a busy Mac's (≥ 300 KB, one SSE line). The same window then rides out a receiver restart
# and a sleep and wake, each ending with a fresh snapshot on the page.
import json
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from common import App, Receiver, args, finish, log, receiver_id, shell_log, wait_for, Results

a = args(__doc__).parse_args()
r = Results("discovered")
state = Path(a.home) / "state-7828-big"
SESSIONS = 700


def big_state(dirpath):
    """SESSIONS finished Claude Code sessions in the store's own format (made up)."""
    events = dirpath / "events" / "claude-code"
    if events.exists() and len(list(events.iterdir())) >= SESSIONS:
        return
    events.mkdir(parents=True, exist_ok=True)
    t0 = datetime(2026, 9, 1, tzinfo=timezone.utc)
    for i in range(SESSIONS):
        sid = str(uuid.UUID(int=i + 1))
        at = t0 + timedelta(minutes=37 * i)
        base = {"protocol": 1, "tier": 2, "harness": {"name": "claude-code", "version": "2.1.0", "event": "Hook"},
                "privacy": {"rulesets": ["secrets@1"], "pii": False}, "source": "http"}
        sess = {"id": sid, "machine": f"machine-{i % 5}", "cwd": f"/home/dev/src/project-{i % 40}",
                "repo": f"acme/project-{i % 40}", "branch": f"feature/reliability-{i}"}
        rows = []
        for seq, (kind, data) in enumerate([
            ("session.started", {"model": "claude-opus-4-5"}),
            ("turn.started", {"turn": 1}),
            ("turn.progress", {"turn": 1, "user": f"Make the board load on first launch, case {i}",
                               "assistant": "Reading the shell's select path and the page's boot."}),
            ("turn.ended", {"turn": 1}),
            ("session.ended", {"reason": "exit"}),
        ]):
            t = (at + timedelta(seconds=20 * seq)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            rows.append({**base, "id": f"{i:013d}{seq:013d}", "type": kind, "time": t, "arrivedAt": t,
                         "session": {**sess, "seq": seq}, "data": data})
        (events / f"{sid}.jsonl").write_text("".join(json.dumps(x) + "\n" for x in rows))


def snapshots(rid):
    """The KB of each snapshot the shell handed the page (shell.log's first-frame lines)."""
    import re

    return [int(k) for k in re.findall(rf"page stream {rid}: snapshot, (\d+) KB", shell_log(app))]


big_state(state)
(state / "no-history").mkdir(exist_ok=True)
rx = Receiver(7828, state, a.cli, ["--search-home", str(state / "no-history")], demo=False).start()
rid = receiver_id(rx.url)
app = App(a.app, f"{a.home}/shell-discovered", "discovered")
for f in ("receivers.json", "keys.json"):  # a first launch: nothing chosen yet
    (app.home / f).unlink(missing_ok=True)
env = {"SP_LOCAL_STATE": str(state)}
app.launch(None, env)
try:
    r.check(wait_for(lambda: f"switching to receiver {rid}" in shell_log(app), 15) is not None,
            "the found receiver gets a window of its own")
    m = wait_for(lambda: app.marks().get("snapshot"), 20)
    r.check(m is not None, "the board has its first snapshot", f"t+{m[0]} ms" if m else "never")
    kb = snapshots(rid)
    r.check(bool(kb) and kb[0] >= 300, "and it was a big one (≥ 300 KB)", f"{kb[:1]} KB")

    rx.stop()
    rx.start()
    again = wait_for(lambda: len(snapshots(rid)) >= 2 or None, 30)
    r.check(again is not None, "a receiver restart: the page reconnects with a fresh snapshot")
    r.check(f"page stream {rid}:" in shell_log(app) and "the page retries" in shell_log(app),
            "the dropped stream is in shell.log")

    n = len(snapshots(rid))
    app.second(["--debug-simulate", "sleep"], None, extra_env=env)
    time.sleep(1)
    app.second(["--debug-simulate", "wake"], None, extra_env=env)
    r.check(wait_for(lambda: len(snapshots(rid)) > n or None, 20) is not None,
            "wake: the page resyncs with a fresh snapshot")
    log_text = shell_log(app)
    r.check("spgui=" not in log_text and "?k=" not in log_text, "no key in the log")
finally:
    rx.stop()
    finish(app, r)
