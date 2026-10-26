#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# The local receiver restarts on another port (7829 → 7828, same state dir): the app finds
# it again through <state>/run.json (SP_LOCAL_STATE names the dir; release builds read the
# default one) and the window follows it.
from common import App, Receiver, args, finish, log, now_ms, receiver_id, wait_for, Results

a = args(__doc__).parse_args()
r = Results("run-json-port")
state = f"{a.home}/state-local"
first = Receiver(7829, state, a.cli).start()
app = App(a.app, f"{a.home}/shell", "runjson").launch(first.url, {"SP_LOCAL_STATE": state})
second = Receiver(7828, state, a.cli)
try:
    r.check(wait_for(lambda: app.connected(receiver_id(first.url)), 15) is not None, "connected to :7829")
    loads = len(app.marks().get("load", []))
    first.stop()
    second.start()
    back = now_ms()
    import json, pathlib

    rj = json.loads(pathlib.Path(state, "run.json").read_text())
    r.check(rj["port"] == 7828, "run.json names the new port", str(rj))
    ok = wait_for(lambda: app.connected(receiver_id(second.url)), 40)
    r.check(ok is not None, "connected to :7828 through run.json", f"{round(now_ms() - back)} ms after it was back")
    r.check(wait_for(lambda: len(app.marks().get("load", [])) > loads, 10) is not None, "the window reloaded on the new receiver")
finally:
    first.stop()
    second.stop()
    finish(app, r)
