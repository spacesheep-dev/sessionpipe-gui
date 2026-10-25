// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service. /api/ui/search/* over a recording SearchService: parameters,
// limits and their errors (SEARCH-SPEC §3.4), the guard, this-machine-only POSTs, no-store.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROUTES, type SearchIndexStatus, type SessionSearchPage } from "../../shared/api.js";
import { parseSearch } from "../../shared/searchQuery.js";
import { type Handler, Router } from "../http/router.js";
import { registerSearch } from "./routes.js";
import { encodeCursor } from "./service.js";
import type { SearchService } from "./types.js";

const STATUS: SearchIndexStatus = { state: "ready", sessions: 2, messages: 9, bytes: 100, history: true, sources: [] };
const calls: { m: string; args: unknown[] }[] = [];
let revealAnswer: "ok" | "gone" | "not_here" = "ok";

const svc: SearchService = {
  search(q, viewer) {
    calls.push({ m: "search", args: [q, viewer] });
    if (q.cursor === "Zm9v") throw new RangeError("bad_cursor");
    const page: SessionSearchPage = {
      q: q.q,
      sort: q.sort ?? "best",
      parsed: parseSearch(q.q),
      sessions: [],
      total: 0,
      more: false,
      ms: 1,
      index: STATUS,
    };
    return page;
  },
  transcript(harness, id, q, viewer) {
    calls.push({ m: "transcript", args: [harness, id, q, viewer] });
    if (id === "missing") return undefined;
    return { session: {} as never, messages: [], hits: [] };
  },
  facets: () => ({ agents: [], machines: [], repos: [], labels: [] }),
  status: (viewer) => ({ ...STATUS, ...(viewer ? { local: viewer.local } : {}) }),
  reindex(rebuild) {
    calls.push({ m: "reindex", args: [rebuild] });
    return STATUS;
  },
  async setHistory(on) {
    calls.push({ m: "setHistory", args: [on] });
    return { ...STATUS, history: on, state: on ? "ready" : "off" };
  },
  async reveal(r) {
    calls.push({ m: "reveal", args: [r] });
    return revealAnswer;
  },
  close: async () => {},
};

let server: http.Server;
let base: string;

beforeAll(async () => {
  const router = new Router();
  const guard =
    (h: Handler): Handler =>
    (ctx) =>
      ctx.req.headers["x-no-key"] ? { status: 401, json: { reason: "unauthorized" } } : h(ctx);
  registerSearch(router, svc, guard, (ctx) => ctx.req.headers["x-remote"] !== "1");
  server = http.createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  calls.length = 0;
  revealAnswer = "ok";
});

const get = (p: string, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { headers });
const post = (p: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(`${base}${p}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("GET /sessions", () => {
  it("reads every parameter, and says no-store", async () => {
    const r = await get(
      `${ROUTES.ui.searchSessions}?q=${encodeURIComponent("webhook agent:codex")}&sort=newest&limit=30&live=1&tz=-420&hits=1&cursor=${encodeCursor(30)}`,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(calls[0]!.args).toEqual([
      { q: "webhook agent:codex", sort: "newest", limit: 30, live: true, tz: -420, hits: 1, cursor: encodeCursor(30) },
      { local: true },
    ]);
  });

  it("answers 400 for a bad limit, cursor or tz; cuts q; clamps hits", async () => {
    for (const [qs, reason] of [
      ["limit=0", "bad_limit"],
      ["limit=101", "bad_limit"],
      ["limit=abc", "bad_limit"],
      ["cursor=!!", "bad_cursor"],
      ["cursor=Zm9v", "bad_cursor"],
      ["tz=x", "bad_tz"],
      ["tz=99999", "bad_tz"],
    ]) {
      const r = await get(`${ROUTES.ui.searchSessions}?q=a&${qs}`);
      expect([qs, r.status]).toEqual([qs, 400]);
      expect(await r.json()).toEqual({ reason });
    }
    await get(`${ROUTES.ui.searchSessions}?q=${"y".repeat(1500)}&hits=9`);
    const q = calls.at(-1)!.args[0] as { q: string; hits: number };
    expect(q.q.length).toBe(1000);
    expect(q.hits).toBe(3);
  });

  it("a remote viewer is not local; no key is 401", async () => {
    await get(`${ROUTES.ui.searchSessions}?q=a`, { "x-remote": "1" });
    expect(calls.at(-1)!.args[1]).toEqual({ local: false });
    expect((await get(`${ROUTES.ui.searchSessions}?q=a`, { "x-no-key": "1" })).status).toBe(401);
    expect((await get(ROUTES.ui.searchStatus, { "x-no-key": "1" })).status).toBe(401);
    expect(
      (await post(ROUTES.ui.searchReindex, {}, { "x-no-key": "1", "content-type": "application/json" })).status,
    ).toBe(401);
  });
});

describe("GET /transcript, /facets, /status", () => {
  it("passes refs and the limit; 404 when the index has no such session", async () => {
    const r = await get(`${ROUTES.ui.searchTranscript}/claude-code/abc?q=webhook&around=1a-2b&limit=500`);
    expect(r.status).toBe(200);
    expect(calls[0]!.args).toEqual([
      "claude-code",
      "abc",
      { q: "webhook", around: "1a-2b", before: undefined, after: undefined, limit: 200 },
      { local: true },
    ]);
    await get(`${ROUTES.ui.searchTranscript}/claude-code/abc?around=${encodeURIComponent("../etc")}`);
    expect((calls.at(-1)!.args[2] as { around?: string }).around).toBeUndefined();
    const miss = await get(`${ROUTES.ui.searchTranscript}/claude-code/missing`);
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ reason: "not_found" });
  });

  it("status carries `local`; facets answer", async () => {
    expect(await (await get(ROUTES.ui.searchStatus)).json()).toMatchObject({ state: "ready", local: true });
    expect(await (await get(ROUTES.ui.searchStatus, { "x-remote": "1" })).json()).toMatchObject({ local: false });
    const f = await get(ROUTES.ui.searchFacets);
    expect(f.headers.get("cache-control")).toBe("no-store");
    expect(await f.json()).toEqual({ agents: [], machines: [], repos: [], labels: [] });
  });

  it("leaves the old GET /api/ui/search alone", async () => {
    expect((await get(`${ROUTES.ui.search}?q=x`)).status).toBe(404); // not registered here
  });
});

describe("the POSTs: this machine only, JSON only", () => {
  it("reindex: 202 with the status; rebuild must be a boolean", async () => {
    const r = await post(ROUTES.ui.searchReindex, { rebuild: true });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ state: "ready", local: true });
    expect(calls.at(-1)).toEqual({ m: "reindex", args: [true] });
    expect((await post(ROUTES.ui.searchReindex, "")).status).toBe(202);
    expect(calls.at(-1)).toEqual({ m: "reindex", args: [false] });
    expect((await post(ROUTES.ui.searchReindex, { rebuild: "yes" })).status).toBe(400);
  });

  it("settings: history boolean; 400 malformed, 415 json_only", async () => {
    const r = await post(ROUTES.ui.searchSettings, { history: false });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ state: "off", history: false, local: true });
    expect((await post(ROUTES.ui.searchSettings, { history: "off" })).status).toBe(400);
    expect((await post(ROUTES.ui.searchSettings, "{not json")).status).toBe(400);
    expect((await post(ROUTES.ui.searchSettings, [true])).status).toBe(400);
    const plain = await post(ROUTES.ui.searchSettings, { history: true }, { "content-type": "text/plain" });
    expect(plain.status).toBe(415);
    expect(await plain.json()).toEqual({ reason: "json_only" });
  });

  it("reveal: 204, 404 gone / not_here, 400 malformed", async () => {
    const ok = await post(ROUTES.ui.searchReveal, { harness: "codex", id: "x", what: "folder" });
    expect(ok.status).toBe(204);
    revealAnswer = "gone";
    const gone = await post(ROUTES.ui.searchReveal, { harness: "codex", id: "x", what: "transcript" });
    expect([gone.status, await gone.json()]).toEqual([404, { reason: "gone" }]);
    revealAnswer = "not_here";
    const nh = await post(ROUTES.ui.searchReveal, { harness: "codex", id: "x", what: "folder" });
    expect([nh.status, await nh.json()]).toEqual([404, { reason: "not_here" }]);
    expect((await post(ROUTES.ui.searchReveal, { harness: "codex", id: "x", what: "rm -rf" })).status).toBe(400);
  });

  it("a remote viewer gets 403 local_only on every POST, before anything runs", async () => {
    const h = { "content-type": "application/json", "x-remote": "1" };
    for (const p of [ROUTES.ui.searchReindex, ROUTES.ui.searchSettings, ROUTES.ui.searchReveal]) {
      const r = await post(p, { history: true, harness: "a", id: "b", what: "folder" }, h);
      expect([p, r.status, await r.json()]).toEqual([p, 403, { reason: "local_only" }]);
    }
    expect(calls).toEqual([]);
  });
});
