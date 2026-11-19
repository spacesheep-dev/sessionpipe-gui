// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. What the person has seen as this receiver keeps it: the document
// (marksCore.ts) in <stateDir>/marks.json, and its two routes.
import path from "node:path";
import { type MarksPatch, ROUTES, type SessionKey } from "../../shared/api.js";
import type { Handler, Reply, Router } from "../http/router.js";
import { docFile } from "./docFile.js";
import { MARKS_FILE_MAX, MarksCore, MarksError } from "./marksCore.js";

export * from "./marksCore.js";

/** "Mark all as read" on a full board is one patch: as large as the file may be. */
const PATCH_MAX = MARKS_FILE_MAX;

export class MarkStore extends MarksCore {
  /** `stateDir`: the GUI's state dir. `known`: whether the store has a session. `now` for tests. */
  constructor(stateDir: string, known: (key: SessionKey) => boolean, now: () => number = Date.now) {
    super(docFile(path.join(stateDir, "marks.json")), known, now);
  }
}

/** GET and PATCH ROUTES.ui.marks, behind the UI guard. PATCH takes JSON only, as labels
 *  does: the content type forces a CORS preflight this server never answers. */
export function registerMarks(router: Router, marks: MarksCore, guard: (h: Handler) => Handler): void {
  router.get(
    ROUTES.ui.marks,
    guard(() => ({ status: 200, json: marks.get(), headers: { "cache-control": "no-store" } })),
  );
  router.add(
    "PATCH",
    ROUTES.ui.marks,
    guard(async (ctx): Promise<Reply> => {
      const type = String(ctx.req.headers["content-type"] ?? "");
      if (!/^application\/json\b/i.test(type)) return { status: 415, json: { reason: "json_only" } };
      const announced = Number(ctx.req.headers["content-length"]);
      if (Number.isFinite(announced) && announced > PATCH_MAX) return { status: 413, json: { reason: "too_large" } };
      let body: MarksPatch;
      try {
        body = await ctx.json<MarksPatch>(PATCH_MAX);
      } catch {
        return { status: 400, json: { reason: "malformed" } };
      }
      try {
        return { status: 200, json: marks.patch(body) };
      } catch (e) {
        if (e instanceof MarksError) return { status: e.status, json: { reason: e.reason } };
        throw e;
      }
    }),
  );
}
