// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service. /api/ui/search/* (SEARCH-SPEC §3.4): every route behind the UI
// guard; the three POSTs only from this machine and only as JSON (the content type forces
// a CORS preflight this server never answers, so a page on another origin cannot reveal a
// folder or drop the history index through the loopback-is-trusted rule). Every answer
// carries `cache-control: no-store`.
import { ROUTES, type SearchRevealRequest, type SessionSearchQuery } from "../../shared/api.js";
import type { Ctx, Handler, Reply, Router } from "../http/router.js";
import { decodeCursor, LIMIT_MAX, Q_MAX, TRANSCRIPT_LIMIT_DEFAULT, TRANSCRIPT_LIMIT_MAX } from "./service.js";
import type { SearchService, Viewer } from "./types.js";

const NO_STORE = { "cache-control": "no-store" } as const;
const BODY_MAX = 4096;
/** A hit ref or a transcript cursor: opaque, URL-safe (types.ts EngineHit.ref). */
const REF = /^[A-Za-z0-9_-]{1,256}$/;
/** getTimezoneOffset() spans −14 h … +12 h; anything past ±16 h is not a timezone. */
const TZ_MAX = 16 * 60;

const reply = (status: number, json?: unknown): Reply =>
  json === undefined ? { status, text: "", headers: { ...NO_STORE } } : { status, json, headers: { ...NO_STORE } };
const reason = (status: number, r: string, extra?: Record<string, unknown>): Reply =>
  reply(status, { reason: r, ...(extra ?? {}) });

/** A whole number param: undefined when absent, NaN when present and not one. */
function intParam(ctx: Ctx, name: string): number | undefined {
  const v = ctx.url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : Number.NaN;
}

const isJson = (ctx: Ctx): boolean => /^application\/json\b/i.test(String(ctx.req.headers["content-type"] ?? ""));

async function readJson(ctx: Ctx): Promise<unknown> {
  const raw = await ctx.body(BODY_MAX);
  if (raw.length === 0) return {};
  return JSON.parse(raw.toString("utf8"));
}

/** Reads the query of GET /sessions; a string is the error reason. */
export function readSessionQuery(ctx: Ctx): SessionSearchQuery | string {
  const p = ctx.url.searchParams;
  const q: SessionSearchQuery = { q: (p.get("q") ?? "").slice(0, Q_MAX) };
  const limit = intParam(ctx, "limit");
  if (limit !== undefined) {
    if (!(limit >= 1 && limit <= LIMIT_MAX)) return "bad_limit";
    q.limit = limit;
  }
  const cursor = p.get("cursor");
  if (cursor) {
    if (decodeCursor(cursor) === undefined) return "bad_cursor";
    q.cursor = cursor;
  }
  const tz = intParam(ctx, "tz");
  if (tz !== undefined) {
    if (!(Math.abs(tz) <= TZ_MAX)) return "bad_tz";
    q.tz = tz;
  }
  const hits = intParam(ctx, "hits");
  if (hits !== undefined && Number.isFinite(hits)) q.hits = Math.min(3, Math.max(0, hits));
  const sort = p.get("sort");
  if (sort === "newest" || sort === "best") q.sort = sort;
  const live = p.get("live");
  if (live === "1" || live === "true") q.live = true;
  return q;
}

export function registerSearch(
  router: Router,
  svc: SearchService,
  guard: (h: Handler) => Handler,
  isLocal: (ctx: Ctx) => boolean,
): void {
  const viewer = (ctx: Ctx): Viewer => ({ local: isLocal(ctx) });

  router.get(
    ROUTES.ui.searchSessions,
    guard((ctx): Reply => {
      const q = readSessionQuery(ctx);
      if (typeof q === "string") return reason(400, q);
      try {
        return reply(200, svc.search(q, viewer(ctx)));
      } catch (e) {
        if (e instanceof RangeError && e.message === "bad_cursor") return reason(400, "bad_cursor");
        throw e;
      }
    }),
  );

  router.get(
    `${ROUTES.ui.searchTranscript}/:harness/:id`,
    guard((ctx): Reply => {
      const p = ctx.url.searchParams;
      const ref = (k: string): string | undefined => {
        const v = p.get(k);
        return v && REF.test(v) ? v : undefined;
      };
      const limit = intParam(ctx, "limit");
      const t = svc.transcript(
        ctx.params.harness!,
        ctx.params.id!,
        {
          q: p.get("q") ?? undefined,
          around: ref("around"),
          before: ref("before"),
          after: ref("after"),
          limit:
            limit === undefined || !Number.isFinite(limit)
              ? TRANSCRIPT_LIMIT_DEFAULT
              : Math.min(TRANSCRIPT_LIMIT_MAX, Math.max(1, limit)),
        },
        viewer(ctx),
      );
      return t ? reply(200, t) : reason(404, "not_found");
    }),
  );

  router.get(
    ROUTES.ui.searchFacets,
    guard(() => reply(200, svc.facets())),
  );

  router.get(
    ROUTES.ui.searchStatus,
    guard((ctx) => reply(200, svc.status(viewer(ctx)))),
  );

  /** This machine only, JSON only, then `h` with the parsed body. */
  const localPost =
    (h: (ctx: Ctx, body: unknown) => Promise<Reply> | Reply): Handler =>
    async (ctx) => {
      if (!isLocal(ctx)) return reason(403, "local_only");
      if (!isJson(ctx)) return reason(415, "json_only");
      let body: unknown;
      try {
        body = await readJson(ctx);
      } catch (e) {
        if (e && typeof e === "object" && (e as { status?: number }).status === 413) return reason(413, "too_large");
        return reason(400, "malformed");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) return reason(400, "malformed");
      return h(ctx, body);
    };

  router.post(
    ROUTES.ui.searchReindex,
    guard(
      localPost((ctx, body) => {
        const rebuild = (body as { rebuild?: unknown }).rebuild;
        if (rebuild !== undefined && typeof rebuild !== "boolean") return reason(400, "malformed");
        const s = svc.reindex(rebuild === true);
        return reply(202, { ...s, local: isLocal(ctx) });
      }),
    ),
  );

  router.post(
    ROUTES.ui.searchSettings,
    guard(
      localPost(async (ctx, body) => {
        const history = (body as { history?: unknown }).history;
        if (typeof history !== "boolean") return reason(400, "malformed");
        const s = await svc.setHistory(history);
        return reply(200, { ...s, local: isLocal(ctx) });
      }),
    ),
  );

  router.post(
    ROUTES.ui.searchReveal,
    guard(
      localPost(async (_ctx, body) => {
        const b = body as Partial<SearchRevealRequest>;
        if (
          typeof b.harness !== "string" ||
          !b.harness ||
          typeof b.id !== "string" ||
          !b.id ||
          (b.what !== "folder" && b.what !== "transcript")
        )
          return reason(400, "malformed");
        const r = await svc.reveal({ harness: b.harness, id: b.id, what: b.what });
        if (r === "ok") return reply(204);
        return reason(404, r);
      }),
    ),
  );
}
