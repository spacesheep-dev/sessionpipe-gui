// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service. `sessionpipe-gui search` / `index` over a fake backend (the
// oracle as the reader): flags into tokens, the printed page, --json, exit codes, and
// `index` asking a running server instead of fighting it for the LOCK.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROUTES, type SessionSearchPage, sessionKey } from "../../shared/api.js";
import { tempDir } from "../../test/events.js";
import { parseSearchArgs, runIndexCli, runSearchCli } from "./cli.js";
import { fromDocs, type OracleDoc, type OracleFacts } from "./oracle.js";
import type { SearchBackend } from "./service.js";
import type { IndexerOptions, SourceAdapter } from "./types.js";

const CL = sessionKey("claude-code", "0b6a7f3e");
const CX = sessionKey("codex", "7c1e2d3f");
const t = (h: number) => Date.now() - h * 3_600_000;

const docs: OracleDoc[] = [
  { key: CL, field: "prompt", at: t(30), offset: 0, text: "Why does the Stripe webhook return 409 on retry?" },
  { key: CL, field: "reply", at: t(29), offset: 80, text: "Idempotency keys: the webhook retry sees the same key." },
  { key: CX, field: "prompt", at: t(2), offset: 0, text: "Rename the rate limiter on staging" },
];
const facts: OracleFacts[] = [
  {
    key: CL,
    harness: "claude-code",
    id: "0b6a7f3e",
    title: { text: "Stripe webhook 409", rank: 25 },
    cwd: "/Users/demo/code/billing",
    firstAt: t(30),
    lastAt: t(29),
    resume: { argv: ["claude", "--resume", "0b6a7f3e"], cwd: "/Users/demo/code/billing" },
  },
  {
    key: CX,
    harness: "codex",
    id: "7c1e2d3f",
    firstAt: t(2),
    lastAt: t(2),
    resume: { argv: ["codex", "resume", "7c1e2d3f"] },
  },
];

const ran: IndexerOptions[] = [];
let built = true;
const events: SourceAdapter = {
  id: "events",
  source: "sessionpipe",
  discover: async () => [],
  roots: () => [],
  read: async () => ({ offset: 0 }),
};
const backend: SearchBackend = {
  openReader: async (o) => (built ? fromDocs(docs, facts, { sources: o.sources }) : fromDocs([], [], { sources: [] })),
  runIndexer: async (o) => {
    ran.push(o);
    o.onStatus?.({ phase: "building", doneBytes: 5, totalBytes: 10, firstRun: true, gen: {} });
    built = true;
  },
  removeIndex: async () => {},
  historyAdapters: () => [{ ...events, id: "claude", source: "history" }],
  eventsAdapter: () => events,
  eventsPath: (s, k) => path.join(s, k),
  sourceEnv: (o) => ({ home: o.home ?? "", stateDir: o.stateDir, hostname: o.hostname, env: {}, platform: "darwin" }),
};

let tmp: { dir: string; cleanup: () => void };
const run = async (
  fn: typeof runSearchCli,
  argv: string[],
  extra: Partial<Parameters<typeof runSearchCli>[1]> = {},
) => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (b) => {
    out += b;
  });
  stderr.on("data", (b) => {
    err += b;
  });
  const code = await fn(argv, { stdout, stderr, stateDir: tmp.dir, home: "/Users/demo", backend, ...extra });
  return { code, out, err };
};

beforeEach(() => {
  tmp = tempDir("spgui-search-cli-");
  ran.length = 0;
  built = true;
});
afterEach(() => tmp.cleanup());

describe("parseSearchArgs", () => {
  it("appends flags to the query as tokens", () => {
    expect(parseSearchArgs(["webhook", "--agent", "claude", "--since", "7d", "--repo", "my repo", "--newest"])).toEqual(
      {
        q: 'webhook agent:claude since:7d repo:"my repo"',
        newest: true,
        limit: 10,
        json: false,
      },
    );
    expect((parseSearchArgs(["--machine", "this"]) as { q: string }).q).toBe("machine:this");
    expect((parseSearchArgs(["--", "--literal"]) as { q: string }).q).toBe("--literal");
  });

  it("refuses what it cannot read", () => {
    expect(() => parseSearchArgs([])).toThrow(/needs a query/);
    expect(() => parseSearchArgs(["x", "--limit", "0"])).toThrow(/--limit/);
    expect(() => parseSearchArgs(["x", "--bogus"])).toThrow(/unknown option/);
    expect(() => parseSearchArgs(["x", "--agent"])).toThrow(/needs a value/);
  });
});

describe("sessionpipe-gui search", () => {
  it("prints the session, its resume line, the marked hits and the page URL; exit 0", async () => {
    const r = await run(runSearchCli, ["webhook", "retry"]);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toMatch(/^1 session · [\d.]+ ms · /);
    expect(r.out).toContain("■ Stripe «webhook» 409");
    expect(r.out).toContain("Claude Code · ");
    expect(r.out).toContain("~/code/billing");
    expect(r.out).toContain("cd '/Users/demo/code/billing' && claude --resume 0b6a7f3e");
    expect(r.out).toMatch(/you +\d{4}-\d\d-\d\d \d\d:\d\d +.*«webhook».*«retry»/);
    expect(r.out).toContain("http://localhost:7373/search?q=webhook%20retry");
  });

  it("--json prints the SessionSearchPage the API answers", async () => {
    const r = await run(runSearchCli, ["rate", "--agent", "codex", "--json"]);
    expect(r.code).toBe(0);
    const page = JSON.parse(r.out) as SessionSearchPage;
    expect(page.q).toBe("rate agent:codex");
    expect(page.sessions.map((s) => s.key)).toEqual([CX]);
    expect(page.sessions[0]!.resume).toBe("codex resume 7c1e2d3f");
    expect(page.sessions[0]!.thisMachine).toBe(true);
  });

  it("exit 1 with nothing, with the hint that applies", async () => {
    const r = await run(runSearchCli, ["webhook", "--agent", "codex"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("No sessions match “webhook agent:codex”.");
    expect(r.out).toContain('Without them: sessionpipe-gui search "webhook"');
  });

  it("exit 2 on a usage error", async () => {
    const r = await run(runSearchCli, ["--limit", "x", "q"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--limit/);
  });

  it("builds the index first when there is none", async () => {
    built = false;
    const r = await run(runSearchCli, ["webhook"]);
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ mode: "once", history: true, rebuild: false });
    expect(r.err).toMatch(/No search index yet/);
    expect(r.code).toBe(0);
  });

  it("honours history off in config.json", async () => {
    writeFileSync(path.join(tmp.dir, "config.json"), JSON.stringify({ searchHistory: false }));
    const r = await run(runSearchCli, ["webhook", "--json"]);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.out) as SessionSearchPage).index.history).toBe(false);
  });
});

describe("sessionpipe-gui index", () => {
  it("indexes in the foreground when no GUI is running", async () => {
    const r = await run(runIndexCli, ["--rebuild"]);
    expect(r.code).toBe(0);
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ mode: "once", rebuild: true });
    expect(r.err).toMatch(/Indexed 2 sessions \(3 messages\)/);
  });

  it("asks a running GUI (server.json) instead, and waits for ready", async () => {
    mkdirSync(path.join(tmp.dir, "search"), { recursive: true });
    // Any live pid that is not ours stands in for the server.
    writeFileSync(path.join(tmp.dir, "search", "server.json"), JSON.stringify({ pid: process.ppid, port: 7999 }));
    const seen: string[] = [];
    let polls = 0;
    const fake = (async (url: string | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(url)} ${init?.body ?? ""}`);
      if (init?.method === "POST") return new Response(JSON.stringify({ state: "updating" }), { status: 202 });
      polls++;
      const state = polls < 2 ? "updating" : "ready";
      return new Response(JSON.stringify({ state, sessions: 9, messages: 1, bytes: 1, history: true, sources: [] }));
    }) as typeof fetch;
    const r = await run(runIndexCli, ["--rebuild"], { fetch: fake });
    expect(r.code).toBe(0);
    expect(ran).toHaveLength(0);
    expect(seen[0]).toBe(`POST http://127.0.0.1:7999${ROUTES.ui.searchReindex} {"rebuild":true}`);
    expect(r.out).toContain("9 sessions · up to date");
  });

  it("--status reads the index; unknown options are a usage error", async () => {
    const r = await run(runIndexCli, ["--status"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/2 sessions · 3 messages/);
    expect((await run(runIndexCli, ["--frobnicate"])).code).toBe(2);
  });
});
