#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Launch the binary twice: one process stays, the second exits at once, and its deep link
# (argv) reaches the first.
import subprocess
import time

from common import App, Receiver, args, finish, log, now_ms, shell_log, wait_for, Results

a = args(__doc__).parse_args()
r = Results("single-instance")
rx = Receiver(7827, f"{a.home}/state-7827", a.cli).start()
app = App(a.app, f"{a.home}/shell", "single").launch(rx.url)
try:
    r.check(wait_for(lambda: app.marks().get("fcp"), 15) is not None, "the first launch paints")
    t = now_ms()
    code = app.second(["--deep-link", "sessionpipe://inbox"], rx.url)
    r.check(code == 0, "the second launch exits 0", f"in {round(now_ms() - t)} ms")
    time.sleep(1)
    n = len([l for l in subprocess.run(["pgrep", "-f", str(app.exe)], capture_output=True, text=True).stdout.split() if l])
    r.check(n == 1 and app.alive(), "one process", f"{n} running")
    r.check(wait_for(lambda: "forwarding a deep link" in shell_log(app), 5) is not None, "the link reached the running app (shell.log)")
    code = app.second([], rx.url)
    r.check(code == 0 and app.alive(), "a bare second launch only brings the window forward")
finally:
    rx.stop()
    finish(app, r)
