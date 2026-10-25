// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service. The service over a fake backend whose reader is perf's oracle
// (server/search/oracle.ts): shaping, filters, hints, paging, overlays from the store,
// facets, transcripts, status and its frames, the history switch, reveal, the indexer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SearchIndexStatus, type StreamMessage, sessionKey } from "../../shared/api.js";
import { Session, tempDir } from "../../test/events.js";
import { Store } from "../store/store.js";
import { LabelStore } from "../ui/labels.js";
import { fromDocs, type OracleDoc, type OracleFacts } from "./oracle.js";
import { createSearch, decodeCursor, encodeCursor, type SearchBackend } from "./service.js";
import type { IndexerOptions, IndexerStatus, SearchService, SourceAdapter } from "./types.js";

const HOST = "studio-mac";
const HOME = "/Users/demo";
const H = (n: number) => Date.now() - n * 3_600_000;
const CL = sessionKey("claude-code", "0b6a7f3e-aaaa");
const CX = sessionKey("codex", "7c1e2d3f-bbbb");
const AG = sessionKey("antigravity", "c0ffee00-cccc");

let tmp: { dir: string; cleanup: () => void };
let transcriptFile: string;

function corpus(): { docs: OracleDoc[]; facts: OracleFacts[] } {
  const docs: OracleDoc[] = [
    { key: CL, field: "prompt", at: H(30), offset: 0, text: "Why does the Stripe webhook return 409 on retry?" },
    {
      key: CL,
      field: "reply",
      at: H(29.9),
      offset: 100,
      text: "The webhook handler sees the same idempotency key twice.",
    },
    { key: CL, field: "tool", at: H(29.8), offset: 200, text: "Bash pnpm test webhook", tool: "Bash" },
    { key: CL, field: "reply", at: H(29.7), offset: 300, text: "Fixed the webhook retry by keeping the first event." },
    { key: CX, field: "prompt", at: H(5), offset: 0, text: "Rename the rate limiter config on staging" },
    { key: CX, field: "reply", at: H(4.9), offset: 50, text: "Done: rate limiter renamed, staging deploy queued." },
    { key: AG, field: "prompt", at: H(80), offset: 0, text: "Draw the focus ring for the design system" },
  ];
  const facts: OracleFacts[] = [
    {
      key: CL,
      harness: "claude-code",
      id: "0b6a7f3e-aaaa",
      title: { text: "Stripe webhook 409", rank: 25 },
      cwd: "/Users/demo/code/billing",
      firstAt: H(30),
      lastAt: H(29.7),
      resume: { argv: ["claude", "--resume", "0b6a7f3e-aaaa"], cwd: "/Users/demo/code/billing" },
      path: transcriptFile,
    },
    {
      key: CX,
      harness: "codex",
      id: "7c1e2d3f-bbbb",
      cwd: "/Users/demo/code/api",
      firstAt: H(5),
      lastAt: H(4.9),
      resume: { argv: ["codex", "resume", "7c1e2d3f-bbbb"] },
    },
    { key: AG, harness: "antigravity", id: "c0ffee00-cccc", firstAt: H(80), lastAt: H(80), cwd: "/Users/demo/code/ds" },
  ];
  return { docs, facts };
}

interface Fake {
  backend: SearchBackend;
  indexer: IndexerOptions[];
  emit(s: Partial<IndexerStatus>): void;
  removed: string[];
}

function fakeBackend(): Fake {
  const { docs, facts } = corpus();
  const indexer: IndexerOptions[] = [];
  const removed: string[] = [];
  const events: SourceAdapter = {
    id: "events",
    source: "sessionpipe",
    discover: async () => [],
    roots: () => [],
    read: async () => ({ offset: 0 }),
  };
  const f: Fake = {
    indexer,
    removed,
    emit: (s) =>
      indexer.at(-1)?.onStatus?.({
        phase: "idle",
        doneBytes: 0,
        totalBytes: 0,
        firstRun: false,
        gen: {},
        ...s,
      }),
    backend: {
      openReader: async (o) =>
        fromDocs(
          docs.filter((d) => o.sources.includes(d.source ?? "history")),
          facts,
          { sources: o.sources },
        ),
      runIndexer: (o) =>
        new Promise<void>((resolve) => {
          indexer.push(o);
          o.signal?.addEventListener("abort", () => resolve());
        }),
      removeIndex: async (dir, source) => {
        removed.push(source);
        await import("node:fs").then((fs) => fs.rmSync(path.join(dir, source), { recursive: true, force: true }));
      },
      historyAdapters: () => [{ ...events, id: "claude", source: "history" }],
      eventsAdapter: () => events,
      eventsPath: (stateDir, key) => path.join(stateDir, "events", ...key.split(":")),
      sourceEnv: (o) => ({
        home: o.home ?? "",
        stateDir: o.stateDir,
        hostname: o.hostname,
        env: {},
        platform: "darwin",
      }),
    },
  };
  return f;
}

let store: Store;
let labels: LabelStore;
let svc: SearchService;
let fake: Fake;
let frames: StreamMessage[];
let history: boolean;
let revealed: [string, string[]][];

async function boot(): Promise<void> {
  fake = fakeBackend();
  svc = await createSearch({
    stateDir: tmp.dir,
    store,
    labels,
    hostname: HOST,
    home: HOME,
    history: () => history,
    setHistory: (on) => {
      history = on;
    },
    broadcast: (m) => frames.push(m),
    port: () => 7919,
    backend: fake.backend,
    reveal: (cmd, args) => revealed.push([cmd, args]),
    tickMs: 0,
    quiet: true,
  });
  fake.emit({ phase: "idle", firstRun: false });
}

beforeEach(async () => {
  tmp = tempDir("spgui-search-");
  transcriptFile = path.join(tmp.dir, "home", "proj.jsonl");
  mkdirSync(path.dirname(transcriptFile), { recursive: true });
  writeFileSync(transcriptFile, "{}\n");
  store = new Store(tmp.dir, { tickMs: 60_000 });
  labels = new LabelStore(tmp.dir, (k) => store.sessionExists(k));
  frames = [];
  history = true;
  revealed = [];
  await boot();
});

afterEach(async () => {
  await svc.close();
  await store.close();
  tmp.cleanup();
});

const local = { local: true };
const remote = { local: false };

describe("search: shaping", () => {
  it("one row per session, best first, with marks, the resume line and the folder", () => {
    const page = svc.search({ q: "webhook retry" }, local);
    expect(page.sort).toBe("best");
    expect(page.sessions.map((s) => s.key)).toEqual([CL]);
    const s = page.sessions[0]!;
    expect(s).toMatchObject({
      harness: "claude-code",
      id: "0b6a7f3e-aaaa",
      source: "history",
      title: "Stripe webhook 409",
      machine: HOST,
      thisMachine: true,
      cwd: "/Users/demo/code/billing",
      resume: "cd '/Users/demo/code/billing' && claude --resume 0b6a7f3e-aaaa",
      transcriptPath: transcriptFile,
    });
    expect(s.hits.length).toBeGreaterThan(0);
    expect(s.hits.length).toBeLessThanOrEqual(3);
    for (const h of s.hits) {
      expect(h.marks.length).toBeGreaterThan(0);
      for (const [a, b] of h.marks) expect(h.text.slice(a, b).toLowerCase()).toMatch(/webhook|retry/);
      expect(h.ref).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Date.parse(h.at)).toBeGreaterThan(0);
    }
    // Transcript order.
    const ats = s.hits.map((h) => Date.parse(h.at));
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(page.total).toBe(1);
    expect(page.ms).toBeGreaterThanOrEqual(0);
    expect(page.index.state).toBe("ready");
    expect(page.index.local).toBeUndefined();
  });

  it("gives the transcript path only to a viewer on this machine", () => {
    expect(svc.search({ q: "webhook" }, remote).sessions[0]!.transcriptPath).toBeUndefined();
  });

  it("Codex gets `codex resume`, Antigravity no command at all", () => {
    expect(svc.search({ q: "rate limiter" }, local).sessions[0]!.resume).toBe("codex resume 7c1e2d3f-bbbb");
    const ag = svc.search({ q: "focus ring" }, local).sessions[0]!;
    expect(ag.resume).toBeUndefined();
    expect(ag.title).toBeTruthy();
  });

  it("a live last word is a prefix; without live it is a word", () => {
    expect(svc.search({ q: "webho", live: true }, local).sessions.map((s) => s.key)).toEqual([CL]);
    expect(svc.search({ q: "webho" }, local).sessions).toEqual([]);
  });

  it("sort=newest orders by the last activity", () => {
    const page = svc.search({ q: "the", sort: "newest" }, local);
    const lasts = page.sessions.map((s) => Date.parse(s.lastAt));
    expect([...lasts].sort((a, b) => b - a)).toEqual(lasts);
  });

  it("a filter-only query browses: newest first, one unmarked first prompt", () => {
    const page = svc.search({ q: "machine:this" }, local);
    expect(page.sort).toBe("newest");
    expect(page.sessions.map((s) => s.key)).toEqual([CX, CL, AG]);
    expect(page.sessions[0]!.hits).toHaveLength(1);
    expect(page.sessions[0]!.hits[0]!.field).toBe("prompt");
    expect(page.sessions[0]!.hits[0]!.marks).toEqual([]);
  });

  it("an empty query returns nothing and no hint", () => {
    const page = svc.search({ q: "   " }, local);
    expect(page.sessions).toEqual([]);
    expect(page.hint).toBeUndefined();
    expect(page.total).toBe(0);
  });

  it("pages by cursor", () => {
    const one = svc.search({ q: "machine:this", limit: 2 }, local);
    expect(one.sessions).toHaveLength(2);
    expect(one.cursor).toBeDefined();
    expect(decodeCursor(one.cursor!)).toBe(2);
    const two = svc.search({ q: "machine:this", limit: 2, cursor: one.cursor }, local);
    expect(two.sessions.map((s) => s.key)).toEqual([AG]);
    expect(two.cursor).toBeUndefined();
    expect(() => svc.search({ q: "x", cursor: "nope!" }, local)).toThrow(RangeError);
    expect(decodeCursor(encodeCursor(40))).toBe(40);
  });

  it("caps the query at 1,000 characters instead of refusing it", () => {
    const page = svc.search({ q: `webhook ${"x".repeat(2000)}` }, local);
    expect(page.q.length).toBe(1000);
  });

  it("reports a filter value that does not read beside the unknown keys", () => {
    const page = svc.search({ q: "webhook since:someday foo:bar" }, local);
    expect(page.parsed.unknown).toEqual(["foo", "since"]);
  });
});

describe("search: filters and hints", () => {
  it("agent, repo and source filters narrow", () => {
    expect(svc.search({ q: "webhook agent:codex" }, local).sessions.map((s) => s.key)).toEqual([]);
    expect(svc.search({ q: "rate agent:codex" }, local).sessions.map((s) => s.key)).toEqual([CX]);
    expect(svc.search({ q: "repo:billing" }, local).sessions.map((s) => s.key)).toEqual([CL]);
    expect(svc.search({ q: "webhook source:sessionpipe" }, local).sessions).toEqual([]);
  });

  it("no results → the first fix that applies", () => {
    expect(svc.search({ q: "webhook agent:codex" }, local).hint).toEqual({ kind: "filters", query: "webhook" });
    expect(svc.search({ q: '"retry webhook"' }, local).hint).toEqual({ kind: "phrase", query: "retry webhook" });
    expect(svc.search({ q: "webhook -retry" }, local).hint).toEqual({
      kind: "exclude",
      word: "retry",
      query: "webhook",
    });
    expect(svc.search({ q: "zebra" }, local).hint).toEqual({ kind: "none" });
  });

  it("says history is still being read on the first run", () => {
    fake.emit({ phase: "building", firstRun: true, doneBytes: 25, totalBytes: 100 });
    const page = svc.search({ q: "zebra" }, local);
    expect(page.hint).toEqual({ kind: "indexing" });
    expect(page.index).toMatchObject({ state: "first-run", progress: 0.25 });
  });
});

describe("the store's overlay", () => {
  it("a session the store knows takes its title and machine, and counts as both", async () => {
    const s = new Session("0b6a7f3e-aaaa", "claude-code");
    store.ingest(
      [
        s.ev(
          "session.started",
          {},
          { session: { title: "Billing: stop double charges", title_source: "custom", machine: HOST } },
        ),
      ],
      "outbox",
    );
    const m = svc.search({ q: "webhook" }, local).sessions[0]!;
    expect(m.title).toBe("Billing: stop double charges");
    expect(m.source).toBe("both");
    expect(m.summary?.key).toBe(CL);
  });

  it("a forgotten session leaves the results at once", () => {
    const s = new Session("7c1e2d3f-bbbb", "codex");
    store.ingest([s.ev("session.started", {})], "outbox");
    expect(svc.search({ q: "rate" }, local).sessions).toHaveLength(1);
    store.forget(CX);
    expect(svc.search({ q: "rate" }, local).sessions).toEqual([]);
  });

  it("label: filters by the person's labels, and facets count them", () => {
    const s = new Session("7c1e2d3f-bbbb", "codex");
    store.ingest([s.ev("session.started", {})], "outbox");
    labels.patch({ sessions: { [CX]: "blue" }, names: { blue: "Client work" } });
    expect(svc.search({ q: "label:client_work" }, local).sessions.map((x) => x.key)).toEqual([CX]);
    expect(svc.facets().labels).toEqual([{ value: "blue", count: 1, label: "Client work" }]);
  });
});

describe("facets", () => {
  it("counts agents, machines and repos, with display names", () => {
    const f = svc.facets();
    expect(f.agents).toEqual(
      expect.arrayContaining([
        { value: "claude-code", count: 1, label: "Claude Code" },
        { value: "codex", count: 1, label: "Codex" },
      ]),
    );
    expect(f.machines).toEqual([{ value: HOST, count: 3 }]);
    expect(f.repos.map((r) => r.value).sort()).toEqual(["api", "billing", "ds"]);
    expect(f.labels).toEqual([]);
  });

  it("is cached until something changes", () => {
    const a = svc.facets();
    expect(svc.facets()).toBe(a);
    const s = new Session("c0ffee00-cccc", "antigravity");
    store.ingest([s.ev("session.started", {}, { session: { machine: "build-box" } })], "outbox");
    expect(svc.facets()).not.toBe(a);
  });

  it("costs ≤ 5 ms when cached", () => {
    svc.facets();
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) svc.facets();
    expect((performance.now() - t0) / 100).toBeLessThan(5);
  });
});

describe("transcript", () => {
  it("serves the session's messages in order with every hit for the find bar", () => {
    const first = svc.search({ q: "webhook" }, local).sessions[0]!;
    const t = svc.transcript("claude-code", "0b6a7f3e-aaaa", { q: "webhook", around: first.hits[0]!.ref }, local)!;
    expect(t.session).toMatchObject({ key: CL, hits: [], resume: expect.stringContaining("claude --resume") });
    expect(t.messages.map((m) => m.field)).toEqual(["prompt", "reply", "tool", "reply"]);
    expect(t.messages[2]).toMatchObject({ tool: "Bash" });
    expect(t.hits).toHaveLength(4);
    for (const h of t.hits) {
      const msg = t.messages.find((m) => m.ref === h.ref)!;
      for (const [a, b] of h.marks) expect(msg.text.slice(a, b).toLowerCase()).toBe("webhook");
    }
  });

  it("is undefined for a session the index does not hold", () => {
    expect(svc.transcript("claude-code", "nope", {}, local)).toBeUndefined();
  });

  it("has no hits without a query", () => {
    expect(svc.transcript("codex", "7c1e2d3f-bbbb", {}, local)!.hits).toEqual([]);
  });
});

describe("status, frames and the history switch", () => {
  it("merges reader stats with the indexer's status", () => {
    const s = svc.status(local);
    expect(s).toMatchObject({ state: "ready", sessions: 3, history: true, local: true });
    expect(s.sources.length).toBeGreaterThan(0);
    expect(svc.status().local).toBeUndefined();
  });

  it("sends searchIndex frames at most once a second, never with `local`", async () => {
    const at: number[] = [];
    const sent: SearchIndexStatus[] = [];
    frames.length = 0;
    const t0 = Date.now();
    const orig = frames.push.bind(frames);
    frames.push = (...m: StreamMessage[]) => {
      for (const f of m)
        if (f.kind === "searchIndex") {
          at.push(Date.now());
          sent.push(f.status);
        }
      return orig(...m);
    };
    for (let i = 1; i <= 30; i++) {
      fake.emit({ phase: "building", firstRun: true, doneBytes: i, totalBytes: 30 });
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 1100));
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBeLessThanOrEqual(Math.ceil((Date.now() - t0) / 1000) + 1);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(990);
    expect(sent.at(-1)).toMatchObject({ state: "first-run", progress: 1 });
    for (const st of sent) expect("local" in st).toBe(false);
  });

  it("reads as updating once a pass runs over a second", async () => {
    fake.emit({ phase: "building", firstRun: false, doneBytes: 1, totalBytes: 10 });
    expect(svc.status().state).toBe("ready");
    await new Promise((r) => setTimeout(r, 1050));
    expect(svc.status().state).toBe("updating");
    fake.emit({ phase: "idle", firstRun: false });
    expect(svc.status().state).toBe("ready");
  });

  it("an indexer error is the error state, with its sentence", () => {
    fake.emit({ phase: "error", error: "disk full" });
    expect(svc.status()).toMatchObject({ state: "error", error: "disk full" });
  });

  it("history off removes history/, drops those sessions and persists the setting", async () => {
    mkdirSync(path.join(tmp.dir, "search", "history"), { recursive: true });
    const s = await svc.setHistory(false);
    expect(history).toBe(false);
    expect(s.state).toBe("off");
    expect(existsSync(path.join(tmp.dir, "search", "history"))).toBe(false);
    expect(fake.removed).toEqual(["history"]);
    expect(svc.search({ q: "webhook" }, local).sessions).toEqual([]);
    expect(fake.indexer.at(-1)!.history).toBe(false);
    const on = await svc.setHistory(true);
    expect(history).toBe(true);
    expect(on.state).toBe("first-run");
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.indexer.at(-1)!.history).toBe(true);
    expect(svc.search({ q: "webhook" }, local).sessions).toHaveLength(1);
  });

  it("writes server.json for `sessionpipe-gui index`, and removes it on close", async () => {
    const f = path.join(tmp.dir, "search", "server.json");
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ pid: process.pid, port: 7919 });
    await svc.close();
    expect(existsSync(f)).toBe(false);
  });

  it("rebuild restarts the in-process indexer with rebuild set", async () => {
    const n = fake.indexer.length;
    svc.reindex(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.indexer.length).toBe(n + 1);
    expect(fake.indexer.at(-1)!.rebuild).toBe(true);
    expect(fake.indexer.at(-1)!.mode).toBe("watch");
  });
});

describe("reveal", () => {
  it("shows the transcript or the folder of a session that ran here", async () => {
    expect(await svc.reveal({ harness: "claude-code", id: "0b6a7f3e-aaaa", what: "transcript" })).toBe("ok");
    const [cmd, args] = revealed.at(-1)!;
    if (process.platform === "darwin") expect([cmd, args]).toEqual(["open", ["-R", transcriptFile]]);
    else expect(args.join(" ")).toContain(path.dirname(transcriptFile));
  });

  it("answers gone when the path is missing, not_here for another machine", async () => {
    expect(await svc.reveal({ harness: "claude-code", id: "0b6a7f3e-aaaa", what: "folder" })).toBe("gone");
    expect(await svc.reveal({ harness: "claude-code", id: "nope", what: "folder" })).toBe("gone");
    const s = new Session("feedbeef", "claude-code");
    store.ingest([s.ev("session.started", {}, { session: { machine: "build-box", cwd: tmp.dir } })], "outbox");
    expect(await svc.reveal({ harness: "claude-code", id: "feedbeef", what: "folder" })).toBe("not_here");
    expect(revealed).toHaveLength(0);
  });
});

describe("the indexer child (fork, nice, IPC)", () => {
  /** A stand-in for `dist/cli.js index --ipc`: logs its argv, priority and every message. */
  const CHILD = `
import { appendFileSync } from "node:fs";
import os from "node:os";
const log = process.env.FAKE_CHILD_LOG;
const w = (o) => appendFileSync(log, JSON.stringify(o) + "\\n");
w({ argv: process.argv.slice(2) });
setTimeout(() => w({ nice: os.getPriority() }), 100);
process.send({ t: "status", status: { phase: "idle", doneBytes: 4, totalBytes: 4, firstRun: false, gen: { history: 1 } } });
process.on("message", (m) => {
  w({ got: m });
  if (m.t === "commit") process.send({ t: "committed", source: "history", gen: 2 });
  if (m.t === "stop") process.exit(0);
});
`;
  let logFile: string;
  const lines = (): Record<string, unknown>[] =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  const until = async (f: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
    return f();
  };

  beforeEach(async () => {
    await svc.close();
    const script = path.join(tmp.dir, "child.mjs");
    writeFileSync(script, CHILD);
    logFile = path.join(tmp.dir, "child.log");
    process.env.FAKE_CHILD_LOG = logFile;
    fake = fakeBackend();
    svc = await createSearch({
      stateDir: tmp.dir,
      store,
      labels,
      hostname: HOST,
      home: HOME,
      history: () => history,
      setHistory: (on) => {
        history = on;
      },
      broadcast: (m) => frames.push(m),
      port: () => 7919,
      backend: fake.backend,
      cliPath: script,
      tickMs: 0,
      quiet: true,
    });
  });
  afterEach(() => {
    delete process.env.FAKE_CHILD_LOG;
  });

  it("forks `index --ipc --state … --search-home …` at nice 10 and runs no indexer in-process", async () => {
    expect(await until(() => lines().some((l) => "nice" in l))).toBe(true);
    expect(lines()[0]!.argv).toEqual(["index", "--ipc", "--state", tmp.dir, "--search-home", HOME, "--hostname", HOST]);
    expect(lines().find((l) => "nice" in l)!.nice).toBe(10);
    expect(fake.indexer).toHaveLength(0);
  });

  it("hints the events file of a session that just got an event, and forwards a forget", async () => {
    expect(await until(() => lines().length > 0)).toBe(true);
    const s = new Session("7c1e2d3f-bbbb", "codex");
    store.ingest([s.ev("session.started", {})], "outbox");
    expect(await until(() => lines().some((l) => (l.got as { t?: string })?.t === "hint"))).toBe(true);
    const hint = lines().find((l) => (l.got as { t?: string })?.t === "hint")!.got as { path: string };
    expect(hint.path).toBe(path.join(tmp.dir, "events", "codex", "7c1e2d3f-bbbb"));
    store.forget(CX);
    expect(await until(() => lines().some((l) => (l.got as { t?: string })?.t === "forget"))).toBe(true);
    expect(lines().find((l) => (l.got as { t?: string })?.t === "forget")!.got).toEqual({ t: "forget", key: CX });
  });

  it("reindex sends commit; the committed answer refreshes the reader; close stops the child", async () => {
    expect(await until(() => lines().length > 0)).toBe(true);
    svc.reindex(false);
    expect(await until(() => lines().some((l) => (l.got as { t?: string })?.t === "commit"))).toBe(true);
    svc.reindex(true);
    expect(await until(() => lines().some((l) => (l.got as { t?: string })?.t === "rebuild"))).toBe(true);
    await svc.close();
    expect(lines().some((l) => (l.got as { t?: string })?.t === "stop")).toBe(true);
  });

  it("history off tells the child, and removes history/ itself if the child does not", async () => {
    expect(await until(() => lines().length > 0)).toBe(true);
    mkdirSync(path.join(tmp.dir, "search", "history"), { recursive: true });
    const s = await svc.setHistory(false);
    expect(s.state).toBe("off");
    expect(lines().some((l) => JSON.stringify(l.got) === JSON.stringify({ t: "history", on: false }))).toBe(true);
    expect(existsSync(path.join(tmp.dir, "search", "history"))).toBe(false);
  });
});

describe("the wire's `more`", () => {
  it("means past the exact count, not another page", () => {
    const page = svc.search({ q: "machine:this", limit: 1 }, local);
    expect(page.cursor).toBeDefined();
    expect(page.more).toBe(false);
    expect(page.total).toBe(3);
  });
});

describe("turning history on", () => {
  it("stays first-run until the indexer reports it, ignoring a stale idle status", async () => {
    await svc.setHistory(false);
    const s = await svc.setHistory(true);
    expect(s.state).toBe("first-run");
    fake.emit({ phase: "idle", firstRun: false }); // sent before the indexer heard
    expect(svc.status().state).toBe("first-run");
    fake.emit({ phase: "building", firstRun: true, doneBytes: 1, totalBytes: 4 });
    expect(svc.status()).toMatchObject({ state: "first-run", progress: 0.25 });
    fake.emit({ phase: "idle", firstRun: false });
    expect(svc.status().state).toBe("ready");
  });
});
