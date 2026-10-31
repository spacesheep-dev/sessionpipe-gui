// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. One session's files: every file its tools named, with each
// touch in order, built from the index's slim records alone (the path sits in the first
// 2 KB of an input, which the index keeps), so a long session answers in one small
// response and no event file is read. The pairing of starts to ends is shared/files.ts
// `indexTouches`, the same the mock runs; registered by registerUi with its guard.
import { ROUTES, type SessionFiles, sessionKey } from "../../shared/api.js";
import { indexTouches } from "../../shared/files.js";
import type { Handler, Reply, Router } from "../http/router.js";
import type { Store } from "../store/store.js";

export function registerSessionFiles(router: Router, store: Store, guard: (h: Handler) => Handler): void {
  router.get(
    `${ROUTES.ui.session}/:harness/:id/files`,
    guard((ctx): Reply => {
      const key = sessionKey(ctx.params.harness!, ctx.params.id!);
      const events = store.slimEvents(key);
      if (!events) return { status: 404, json: { reason: "not_found" } };
      // The session's cwd as its newest event says it (every event carries it).
      const cwd = events[events.length - 1]?.session.cwd;
      const body: SessionFiles = {
        files: indexTouches(events, cwd),
        lastSeq: events.length ? events[events.length - 1]!.session.seq : -1,
      };
      return { status: 200, json: body, headers: { "cache-control": "no-store" } };
    }),
  );
}
