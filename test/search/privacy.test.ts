// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. S6 end to end, on a real app over a generated history home:
// remote viewers need the UI key (401 without it) and may never POST (403); the index lives
// under the state dir with 0700 folders and 0600 files and never holds a planted secret, tool
// output or anything else that must not be indexed; turning history off deletes
// `search/history/` and drops those sessions from search, and events are never indexed above
// the tier they arrived at.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GenManifest, generate } from "../../bench/search/gen.mjs";
import { type App, createApp } from "../../server/app.js";
import { ROUTES, type SearchIndexStatus, type SessionSearchPage } from "../../shared/api.js";
import { tempDir } from "../events.js";
import { haveEngine } from "./kit.js";

const PUBLIC = "https://laptop.tail1234.ts.net";
const FORWARDED = {
  "x-forwarded-for": "100.64.0.7",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "laptop.tail1234.ts.net",
};
const NOW = Date.now();

let tmp: { dir: string; cleanup: () => void };
let app: App;
let m: GenManifest;
let state = "";

async function waitReady(ms = 60_000): Promise<SearchIndexStatus> {
  const t = Date.now();
  for (;;) {
    const s = (await (await fetch(`${app.url}${ROUTES.ui.searchStatus}`)).json()) as SearchIndexStatus;
    if (s.state === "ready" || s.state === "off") return s;
    if (Date.now() - t > ms) throw new Error(`index not ready: ${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const search = async (q: string): Promise<SessionSearchPage> => {
  const r = await fetch(`${app.url}${ROUTES.ui.searchSessions}?q=${encodeURIComponent(q)}&limit=100`);
  expect(r.status).toBe(200);
  return (await r.json()) as SessionSearchPage;
};

function walk(dir: string, fn: (p: string, isDir: boolean) => void): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    fn(p, e.isDirectory());
    if (e.isDirectory()) walk(p, fn);
  }
}

beforeAll(async () => {
  tmp = tempDir("spgui-privacy-");
  m = generate({ out: path.join(tmp.dir, "gen"), profile: "gate", size: 600_000, seed: 11, now: NOW });
  // The state dir holds the store's event files the generator wrote (another machine, a
  // shadowed history key, the tier rules); the store loads them at boot.
  state = path.join(tmp.dir, "gen", "state");
  const web = path.join(tmp.dir, "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>t</title>");
  app = await createApp({
    port: 0,
    stateDir: state,
    outbox: false,
    quiet: true,
    webDir: web,
    publicUrl: PUBLIC,
    searchHome: path.join(tmp.dir, "gen", "home"),
  });
  await waitReady();
}, 90_000);

afterAll(async () => {
  await app?.close();
  tmp?.cleanup();
});

describe("search privacy (S6)", () => {
  it("a forwarded visitor needs the UI key for every search route", async () => {
    const get = [
      `${ROUTES.ui.searchSessions}?q=error`,
      ROUTES.ui.searchFacets,
      ROUTES.ui.searchStatus,
      `${ROUTES.ui.searchTranscript}/codex/x`,
    ];
    for (const r of get) {
      expect((await fetch(`${app.url}${r}`, { headers: FORWARDED })).status, r).toBe(401);
      const k = r.includes("?") ? "&" : "?";
      const ok = await fetch(`${app.url}${r}${k}k=${app.config().uiKey}`, { headers: FORWARDED });
      expect([200, 404], r).toContain(ok.status);
    }
  });

  it("a forwarded visitor may never change the index, even with the key", async () => {
    const k = `?k=${app.config().uiKey}`;
    const post = (r: string, body: unknown) =>
      fetch(`${app.url}${r}${k}`, {
        method: "POST",
        headers: { ...FORWARDED, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post(ROUTES.ui.searchReindex, {})).status).toBe(403);
    expect((await post(ROUTES.ui.searchSettings, { history: false })).status).toBe(403);
    expect((await post(ROUTES.ui.searchReveal, { harness: "codex", id: "x", what: "folder" })).status).toBe(403);
    const st = (await (await fetch(`${app.url}${ROUTES.ui.searchStatus}`)).json()) as SearchIndexStatus;
    expect(st.history).toBe(true);
  });

  // The oracle stand-in writes no index (only server.json): this waits for the engine.
  it.skipIf(!haveEngine())("files are 0600 and folders 0700 under <state>/search", () => {
    const dir = path.join(state, "search");
    expect(existsSync(dir)).toBe(true);
    const bad: string[] = [];
    let files = 0;
    if ((statSync(dir).mode & 0o777) !== 0o700) bad.push(`search ${(statSync(dir).mode & 0o777).toString(8)}`);
    walk(dir, (p, isDir) => {
      const mode = statSync(p).mode & 0o777;
      if (!isDir) files++;
      if (mode !== (isDir ? 0o700 : 0o600)) bad.push(`${path.relative(dir, p)} ${mode.toString(8)}`);
    });
    expect(files).toBeGreaterThan(1);
    expect(bad).toEqual([]);
  });

  it("the index bytes never hold a secret, tool output or any never-needle", () => {
    const dir = path.join(state, "search");
    const hay: Buffer[] = [];
    walk(dir, (p, isDir) => {
      if (!isDir) hay.push(readFileSync(p));
    });
    const all = Buffer.concat(hay);
    const leaks: string[] = [];
    for (const s of m.secrets)
      if (all.includes(s) || all.includes(s.slice(4, 20))) leaks.push(`secret ${s.slice(0, 4)}…`);
    // A shadowed key's events are indexed (and skipped at query time), so that needle may be there.
    for (const n of m.needles.filter((x) => x.kind === "never" && !x.why.startsWith("history beats")))
      if (all.includes(n.q.replace(/"/g, ""))) leaks.push(`${n.q} (${n.why})`);
    expect(leaks).toEqual([]);
  });

  it("search finds history, and never what is above an event's tier", async () => {
    const must = m.needles.filter((n) => n.kind === "must" && n.keys.length && !n.sources);
    for (const n of must.slice(0, 12))
      expect((await search(n.q)).sessions.map((s) => s.key).sort(), n.q).toEqual(n.keys);
    for (const n of m.needles.filter((x) => x.why.includes("tier"))) expect((await search(n.q)).total, n.q).toBe(0);
  });

  it("history off deletes search/history/ and drops those sessions; on brings them back", async () => {
    const histNeedle = m.needles.find((n) => n.kind === "must" && n.why === "a Codex prompt")!;
    const evNeedle = m.needles.find((n) => n.kind === "must" && n.why === "sessionpipe turn.transcript")!;
    expect((await search(histNeedle.q)).total).toBe(1);
    const off = await fetch(`${app.url}${ROUTES.ui.searchSettings}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ history: false }),
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as SearchIndexStatus).history).toBe(false);
    expect(existsSync(path.join(state, "search", "history"))).toBe(false);
    expect((await search(histNeedle.q)).total).toBe(0);
    expect((await search(evNeedle.q)).total).toBe(1);
    expect(JSON.parse(readFileSync(path.join(state, "config.json"), "utf8")).searchHistory).toBe(false);
    const on = await fetch(`${app.url}${ROUTES.ui.searchSettings}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ history: true }),
    });
    expect(on.status).toBe(200);
    await waitReady();
    for (let i = 0; i < 100 && (await search(histNeedle.q)).total === 0; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect((await search(histNeedle.q)).total).toBe(1);
  }, 60_000);
});
