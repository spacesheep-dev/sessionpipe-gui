// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The receiver side of HTTP.md §1–2: the well-known file and
// the events endpoint. Control (§3) is registered by server/control; the native lane
// (§4) is not served.
import { ROUTES } from "../../shared/api.js";
import type { Control } from "../control/index.js";
import { type Ctx, HttpError, type Reply, type Router } from "../http/router.js";
import type { Store } from "../store/store.js";
import { aboveMaxTier, eventProblem, MAX_TIER } from "./validate.js";

export const MAX_EVENTS = 50;
export const MAX_BYTES = 262_144;

export interface ReceiverDeps {
  store: Store;
  /** The current sink token (it can be rotated while running). */
  sinkToken: () => string;
  control: Control;
}

/** HTTP.md §1. */
export function wellKnown(control: Control): Record<string, unknown> {
  return {
    protocol: [1],
    max_tier: MAX_TIER,
    capabilities: ["events", "backfill", "forget", "control"],
    auth: ["bearer"],
    endpoints: { events: ROUTES.events, control: ROUTES.control },
    batch: { max_events: MAX_EVENTS, max_bytes: MAX_BYTES },
    control: control.wellKnown(),
  };
}

export function registerReceiver(to: Router, deps: ReceiverDeps): void {
  // Both are a sink's (guard.ts `wire`): the well-known file is public and the events
  // endpoint takes the sink token, so neither leans on where the request came from.
  const router = to.wire;
  router.get(ROUTES.wellKnown, () => ({
    status: 200,
    json: wellKnown(deps.control),
    headers: { "cache-control": "public, max-age=3600" },
  }));

  router.post(ROUTES.events, async (ctx: Ctx): Promise<Reply> => {
    if (ctx.bearer() !== deps.sinkToken()) {
      return { status: 401, json: { reason: "unauthorized" }, headers: { "www-authenticate": "Bearer" } };
    }
    const proto = ctx.req.headers["sessionpipe-protocol"];
    if (proto !== undefined && String(proto).trim() !== "1") {
      return { status: 400, json: { reason: "unsupported_protocol", supported: [1] } };
    }
    const declared = Number(ctx.req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BYTES) return tooLarge();
    let body: unknown;
    try {
      body = await ctx.json(MAX_BYTES);
    } catch (e) {
      if (e instanceof HttpError && e.status === 413) return tooLarge();
      return { status: 400, json: { reason: "malformed" } };
    }
    const list =
      body && typeof body === "object" && !Array.isArray(body) ? (body as { events?: unknown }).events : undefined;
    if (!Array.isArray(list) || list.length === 0) return { status: 400, json: { reason: "malformed" } };
    if (list.length > MAX_EVENTS) {
      return { status: 413, json: { reason: "too_many_events", max_events: MAX_EVENTS } };
    }
    if (list.some(aboveMaxTier)) return { status: 403, json: { reason: "tier_above_max", max_tier: MAX_TIER } };

    const rejected: { id: string; reason: string }[] = [];
    const valid: Parameters<Store["ingest"]>[0] = [];
    for (const e of list) {
      const reason = eventProblem(e);
      if (reason) rejected.push({ id: idOf(e), reason });
      else valid.push(e as (typeof valid)[number]);
    }
    const r = deps.store.ingest(valid, "http");
    return {
      status: 202,
      json: {
        accepted: r.accepted,
        duplicates: r.duplicates,
        rejected: [...rejected, ...r.rejected],
        max_tier: MAX_TIER,
      },
    };
  });
}

const tooLarge = (): Reply => ({ status: 413, json: { reason: "batch_too_large", max_bytes: MAX_BYTES } });

const idOf = (e: unknown): string =>
  e && typeof e === "object" && typeof (e as { id?: unknown }).id === "string" ? (e as { id: string }).id : "";
