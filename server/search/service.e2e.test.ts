// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service. End to end on the real engine and sources (SEARCH-SPEC §6 M3):
// a generated history home (bench/search/gen.mjs --profile demo, invented content), a temp
// state dir, the whole app over HTTP, the in-process indexer, then the CLI on the same
// index. Skipped until the engine exports openReader (server/search/engine/index.ts).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ROUTES,
  type SearchFacets,
  type SearchIndexStatus,
  type SearchTranscript,
  type SessionSearchPage,
} from "../../shared/api.js";
import { tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { runSearchCli } from "./cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const hasEngine =
  existsSync(path.join(here, "engine", "index.ts")) && existsSync(path.join(here, "sources", "index.ts"));

interface GenManifest {
  sessions: Record<string, number>;
  messages: number;
  secrets: string[];
}

describe.skipIf(!hasEngine)("session search end to end (engine + sources + app)", () => {
  let tmp: { dir: string; cleanup: () => void };
  let app: App;
  let man: GenManifest;
  let home: string;
  const get = async <T>(p: string): Promise<{ status: number; body: T; headers: Headers }> => {
    const r = await fetch(`${app.url}${p}`);
    return { status: r.status, body: (await r.json()) as T, headers: r.headers };
  };
  const search = (q: string, extra = "") =>
    get<SessionSearchPage>(`${ROUTES.ui.searchSessions}?q=${encodeURIComponent(q)}&limit=100${extra}`).then(
      (r) => r.body,
    );

  beforeAll(async () => {
    tmp = tempDir("spgui-search-e2e-");
    const gen = (await import(path.join(here, "..", "..", "bench", "search", "gen.mjs"))) as {
      generate(o: { out: string; profile: string }): unknown;
    };
    const out = path.join(tmp.dir, "gen");
    gen.generate({ out, profile: "demo" });
    man = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8")) as GenManifest;
    home = path.join(out, "home");
    app = await createApp({
      port: 0,
      host: "0.0.0.0",
      stateDir: path.join(out, "state"),
      outbox: false,
      testDoor: true,
      quiet: true,
      searchHome: home,
    });
    // The in-process indexer's first pass.
    const t0 = Date.now();
    for (;;) {
      const s = (await get<SearchIndexStatus>(ROUTES.ui.searchStatus)).body;
      if (s.state === "ready" && s.sessions > 0) break;
      if (Date.now() - t0 > 20_000) throw new Error(`index not ready: ${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    tmp?.cleanup();
  });

  it("indexes every harness of the generated home", async () => {
    const s = (await get<SearchIndexStatus>(ROUTES.ui.searchStatus)).body;
    expect(s).toMatchObject({ state: "ready", history: true, local: true });
    const f = (await get<SearchFacets>(ROUTES.ui.searchFacets)).body;
    const agents = Object.fromEntries(f.agents.map((a) => [a.value, a.count]));
    for (const h of ["claude-code", "codex", "antigravity", "gemini-cli"]) expect(agents[h]).toBeGreaterThan(0);
    const codex = await search("agent:codex source:history");
    expect(codex.sessions.length).toBe(man.sessions.codex);
  });

  it("finds words, shapes rows, and answers no-store", async () => {
    const browse = await search("source:history");
    const first = browse.sessions.find((s) => s.hits[0]?.text)!;
    // A word from a real prompt of that session finds it.
    const word = first.hits[0]!.text.split(/\W+/).filter((w) => w.length > 5)[0]!;
    const page = await search(word);
    expect(page.sessions.length).toBeGreaterThan(0);
    for (const s of page.sessions) {
      expect(s.title).toBeTruthy();
      expect(s.machine).toBeTruthy();
      expect(s.hits.length).toBeLessThanOrEqual(3);
      for (const h of s.hits) for (const [a, b] of h.marks) expect(b).toBeGreaterThan(a);
      if (s.harness === "claude-code") expect(s.resume).toMatch(/claude --resume /);
      if (s.harness === "codex") expect(s.resume).toMatch(/^codex resume /);
      if (s.harness === "antigravity" || s.harness === "gemini-cli") expect(s.resume).toBeUndefined();
    }
    expect(page.ms).toBeLessThan(50);
    const r = await fetch(`${app.url}${ROUTES.ui.searchSessions}?q=${word}`);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("never finds a planted secret", async () => {
    for (const secret of man.secrets) {
      const page = await search(secret);
      expect([secret.slice(0, 4), page.sessions.length]).toEqual([secret.slice(0, 4), 0]);
    }
  });

  it("serves a history transcript with the find bar's hits", async () => {
    const browse = await search("source:history agent:claude");
    const s = browse.sessions[0]!;
    const word = s.hits[0]!.text.split(/\W+/).filter((w) => w.length > 4)[0]!;
    const t = (
      await get<SearchTranscript>(
        `${ROUTES.ui.searchTranscript}/${s.harness}/${s.id}?q=${encodeURIComponent(word)}&around=${s.hits[0]!.ref}`,
      )
    ).body;
    expect(t.messages.length).toBeGreaterThan(0);
    expect(t.session.key).toBe(s.key);
    expect(t.hits.length).toBeGreaterThan(0);
    expect((await get(`${ROUTES.ui.searchTranscript}/claude-code/not-a-session`)).status).toBe(404);
  });

  it("the CLI reads the same index with no server involved", async () => {
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (b) => {
      out += b;
    });
    const code = await runSearchCli(["agent:codex", "--json", "--limit", "100"], {
      stdout,
      stderr: new PassThrough(),
      stateDir: app.stateDir,
      home,
    });
    expect(code).toBe(0);
    expect((JSON.parse(out) as SessionSearchPage).sessions.length).toBeGreaterThan(0);
  });

  it("keeps the index private: 0700 directories, 0600 files", () => {
    const dir = path.join(app.stateDir, "search");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? [path.join(d, e.name), ...walk(path.join(d, e.name))] : [path.join(d, e.name)],
      );
    for (const p of walk(dir)) {
      const mode = statSync(p).mode & 0o777;
      expect([path.relative(dir, p), mode]).toEqual([path.relative(dir, p), statSync(p).isDirectory() ? 0o700 : 0o600]);
    }
  });

  it("remote viewers: the UI key, no POSTs, no transcript path", async () => {
    const lan = app.lanUrls[0];
    if (lan) {
      const base = lan.replace(/:\d+$/, `:${app.port}`);
      expect((await fetch(`${base}${ROUTES.ui.searchSessions}?q=agent:codex`)).status).toBe(401);
      const ok = await fetch(`${base}${ROUTES.ui.searchSessions}?q=agent:codex&k=${app.config().uiKey}`);
      expect(ok.status).toBe(200);
    }
    const remote = { "x-spgui-test-remote": "192.168.77.9", "content-type": "application/json" };
    for (const p of [ROUTES.ui.searchReindex, ROUTES.ui.searchSettings, ROUTES.ui.searchReveal]) {
      const r = await fetch(`${app.url}${p}`, { method: "POST", headers: remote, body: '{"history":false}' });
      expect([p, r.status]).toEqual([p, 403]);
    }
    const page = (await (
      await fetch(`${app.url}${ROUTES.ui.searchSessions}?q=source:history`, { headers: remote })
    ).json()) as SessionSearchPage;
    expect(page.sessions.length).toBeGreaterThan(0);
    for (const s of page.sessions) expect(s.transcriptPath).toBeUndefined();
    const st = (await (
      await fetch(`${app.url}${ROUTES.ui.searchStatus}`, { headers: remote })
    ).json()) as SearchIndexStatus;
    expect(st.local).toBe(false);
    const mine = await search("source:history");
    expect(mine.sessions.some((s) => s.transcriptPath)).toBe(true);
  });

  it("history off deletes history/ and those sessions leave search", async () => {
    const r = await fetch(`${app.url}${ROUTES.ui.searchSettings}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ history: false }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as SearchIndexStatus).state).toBe("off");
    expect(existsSync(path.join(app.stateDir, "search", "history"))).toBe(false);
    expect((await search("source:history")).sessions).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(app.stateDir, "config.json"), "utf8")).searchHistory).toBe(false);
  });
});
