// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. How the person arranged the session tree, as this receiver keeps
// it: the document (arrangementCore.ts) in <stateDir>/arrangement.json, and its two routes.
import path from "node:path";
import { type ArrangementPatch, ROUTES, type SessionKey } from "../../shared/api.js";
import type { Handler, Reply, Router } from "../http/router.js";
import { ARRANGEMENT_FILE_MAX, ArrangementCore, ArrangementError } from "./arrangementCore.js";
import { docFile } from "./docFile.js";

export * from "./arrangementCore.js";

/** A change as large as the file may be (every placement at once). */
const PATCH_MAX = ARRANGEMENT_FILE_MAX;

export class ArrangementStore extends ArrangementCore {
  /** `stateDir`: the GUI's state dir. `known`: whether the store has a session. */
  constructor(stateDir: string, known: (key: SessionKey) => boolean) {
    super(docFile(path.join(stateDir, "arrangement.json")), known);
  }
}

/** GET and PATCH ROUTES.ui.arrangement, behind the UI guard (ui/index.ts uiGuard: this
 *  computer, or the UI key). PATCH takes JSON only, as labels and marks do: the content
 *  type forces a CORS preflight this server never answers, so a page on another origin
 *  cannot change it through the loopback-is-trusted rule. */
export function registerArrangement(
  router: Router,
  arrangement: ArrangementCore,
  guard: (h: Handler) => Handler,
): void {
  router.get(
    ROUTES.ui.arrangement,
    guard(() => ({ status: 200, json: arrangement.get(), headers: { "cache-control": "no-store" } })),
  );
  router.add(
    "PATCH",
    ROUTES.ui.arrangement,
    guard(async (ctx): Promise<Reply> => {
      const type = String(ctx.req.headers["content-type"] ?? "");
      if (!/^application\/json\b/i.test(type)) return { status: 415, json: { reason: "json_only" } };
      const announced = Number(ctx.req.headers["content-length"]);
      if (Number.isFinite(announced) && announced > PATCH_MAX) return { status: 413, json: { reason: "too_large" } };
      let body: ArrangementPatch;
      try {
        body = await ctx.json<ArrangementPatch>(PATCH_MAX);
      } catch {
        return { status: 400, json: { reason: "malformed" } };
      }
      try {
        return { status: 200, json: arrangement.patch(body) };
      } catch (e) {
        if (e instanceof ArrangementError) return { status: e.status, json: { reason: e.reason } };
        throw e;
      }
    }),
  );
}
