// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. Each account's usage limits as this receiver keeps them: the
// entries (limitsCore.ts) in <stateDir>/limits.json, and their two routes.
import path from "node:path";
import { ROUTES } from "../../shared/api.js";
import type { Handler, Reply, Router } from "../http/router.js";
import { docFile } from "./docFile.js";
import { LimitsCore, str } from "./limitsCore.js";

export * from "./limitsCore.js";

const FORGET_MAX = 4096;

export class LimitsStore extends LimitsCore {
  constructor(stateDir: string) {
    super(docFile(path.join(stateDir, "limits.json")));
  }
}

/** GET ROUTES.ui.limits and POST ROUTES.ui.limitsForget, behind the UI guard. The POST
 *  takes JSON only, like the labels PATCH: the content type forces a CORS preflight this
 *  server never answers, so a page on another origin cannot forget numbers through the
 *  loopback-is-trusted rule. */
export function registerLimits(router: Router, limits: LimitsCore, guard: (h: Handler) => Handler): void {
  router.get(
    ROUTES.ui.limits,
    guard(() => ({ status: 200, json: { limits: limits.list() }, headers: { "cache-control": "no-store" } })),
  );
  router.post(
    ROUTES.ui.limitsForget,
    guard(async (ctx): Promise<Reply> => {
      const type = String(ctx.req.headers["content-type"] ?? "");
      if (!/^application\/json\b/i.test(type)) return { status: 415, json: { reason: "json_only" } };
      let body: { key?: unknown };
      try {
        body = await ctx.json<{ key?: unknown }>(FORGET_MAX);
      } catch {
        return { status: 400, json: { reason: "malformed" } };
      }
      const key = body && typeof body === "object" ? str(body.key) : undefined;
      if (!key) return { status: 400, json: { reason: "malformed" } };
      if (!limits.forget(key)) return { status: 404, json: { reason: "not_found" } };
      return { status: 204, text: "" };
    }),
  );
}
