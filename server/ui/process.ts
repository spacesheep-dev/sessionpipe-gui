// SPDX-License-Identifier: Apache-2.0
// GET /api/ui/stats/process, loopback only: what this process weighs right now
// (process.memoryUsage, uptime, the store's counts), for a `watch curl` while the GUI
// runs on a machine someone cares about. A POST runs a full GC first, so heapUsed is
// live data and not garbage waiting its turn: a GET only ever reads. Not part of the
// UI's wire contract.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { Handler, Reply, Router } from "../http/router.js";
import type { Store } from "../store/store.js";

export const PROCESS_STATS_ROUTE = "/api/ui/stats/process";

export function registerProcessStats(router: Router, store: Store, guard: (h: Handler) => Handler): void {
  const stats =
    (collect: boolean): Handler =>
    (ctx): Reply => {
      if (!ctx.remote.loopback) return { status: 403, json: { reason: "loopback_only" } };
      if (collect) fullGc();
      const m = process.memoryUsage();
      const s = store.stats();
      return {
        status: 200,
        json: {
          pid: process.pid,
          uptimeS: Math.round(process.uptime()),
          rss: m.rss,
          heapUsed: m.heapUsed,
          heapTotal: m.heapTotal,
          external: m.external,
          arrayBuffers: m.arrayBuffers,
          events: s.events,
          sessions: s.sessions,
          storageBytes: s.storageBytes,
        },
        headers: { "cache-control": "no-store" },
      };
    };
  router.get(PROCESS_STATS_ROUTE, guard(stats(false)));
  router.post(PROCESS_STATS_ROUTE, guard(stats(true)));
}

/** A full GC without --expose-gc on the command line. */
function fullGc(): void {
  setFlagsFromString("--expose-gc");
  (runInNewContext("gc") as () => void)();
  setFlagsFromString("--no-expose-gc");
}
