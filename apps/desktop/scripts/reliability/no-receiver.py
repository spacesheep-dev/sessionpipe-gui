#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# No receiver at launch: the bundled UI paints anyway, within the first-paint budget
# (250 ms target, 400 ms hard), median of 3.
import statistics
import time

from common import App, args, finish, log, wait_for, Results

a = args(__doc__).parse_args()
r = Results("no-receiver")
app = App(a.app, f"{a.home}/shell", "norx")
dead = "http://127.0.0.1:7830"  # nothing listens here during this test
fcps, observed = [], []
try:
    for i in range(4):
        app.launch(dead)
        m = wait_for(lambda: app.marks().get("fcp") and app.marks(), 10)
        if i and m:  # the first one warms the cache
            # The paint: the webview's creation (t+) plus the page's FCP startTime.
            fcps.append(m["created"][0][1] + m["fcp_nav"][0])
            observed.append(m["fcp"][0])
        app.quit()
        time.sleep(1)
    got = [x for x in fcps if x is not None]
    med = statistics.median(got) if got else None
    log(f"fcp runs: {fcps} (observer reported at {observed})")
    r.check(med is not None and med <= 400, "the welcome paints within the hard limit (400 ms)", f"median {med} ms")
    r.check(med is not None and med <= 250, "and within the target (250 ms)", f"median {med} ms")
finally:
    finish(app, r)
