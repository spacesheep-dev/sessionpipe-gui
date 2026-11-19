// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The person's colour labels as this receiver keeps them: the
// document (labelsCore.ts) in <stateDir>/labels.json, and its two routes.
import path from "node:path";
import { type LabelsPatch, ROUTES, type SessionKey } from "../../shared/api.js";
import type { Handler, Reply, Router } from "../http/router.js";
import { docFile } from "./docFile.js";
import { LabelsCore, LabelsError } from "./labelsCore.js";

export * from "./labelsCore.js";

const PATCH_MAX = 64 * 1024;

export class LabelStore extends LabelsCore {
  /** `stateDir`: the GUI's state dir. `known`: whether the store has a session. */
  constructor(stateDir: string, known: (key: SessionKey) => boolean) {
    super(docFile(path.join(stateDir, "labels.json")), known);
  }
}

/** GET and PATCH ROUTES.ui.labels, behind the UI guard. PATCH takes JSON only: the
 *  content type forces a CORS preflight this server never answers, so a page on another
 *  origin cannot write labels through the loopback-is-trusted rule. */
export function registerLabels(router: Router, labels: LabelsCore, guard: (h: Handler) => Handler): void {
  router.get(
    ROUTES.ui.labels,
    guard(() => ({ status: 200, json: labels.get(), headers: { "cache-control": "no-store" } })),
  );
  router.add(
    "PATCH",
    ROUTES.ui.labels,
    guard(async (ctx): Promise<Reply> => {
      const type = String(ctx.req.headers["content-type"] ?? "");
      if (!/^application\/json\b/i.test(type)) return { status: 415, json: { reason: "json_only" } };
      const announced = Number(ctx.req.headers["content-length"]);
      if (Number.isFinite(announced) && announced > PATCH_MAX) return { status: 413, json: { reason: "too_large" } };
      let body: LabelsPatch;
      try {
        body = await ctx.json<LabelsPatch>(PATCH_MAX);
      } catch {
        return { status: 400, json: { reason: "malformed" } };
      }
      try {
        return { status: 200, json: labels.patch(body) };
      } catch (e) {
        if (e instanceof LabelsError) return { status: e.status, json: { reason: e.reason } };
        throw e;
      }
    }),
  );
}
