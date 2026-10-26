// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The writer against a fake adapter: first build, growth, partial
// lines, replaced / shrunk / rewritten / deleted files, whole files, forget, history off,
// rebuild, merges, the live tail, the LOCK and recovery.
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSearch } from "../../../shared/searchQuery.js";
import type { EngineQuery, IndexerStatus, SearchSource } from "../types.js";
import { fakeAdapter, fakeEnv, fakeLine } from "./fake.js";
import { openReader, removeIndex } from "./index.js";
import { runIndexer, startIndexer } from "./indexer.js";
import { acquireLock, LockedError, readManifest } from "./manifest.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function world() {
  const root = mkdtempSync(join(tmpdir(), "spe-ix-"));
  roots.push(root);
  const home = join(root, "home");
  const state = join(root, "state");
  const env = fakeEnv(home, state);
  const dir = join(state, "search");
  const adapter = fakeAdapter("history");
  const file = (id: string, ext = "jsonl") => join(home, "fake", `${id}.${ext}`);
  return { root, home, state, env, dir, adapter, file };
}

const q = (text: string, sources: SearchSource[] = ["history"]): EngineQuery => ({
  parsed: parseSearch(text),
  sources,
  sort: "best",
  offset: 0,
  limit: 100,
  hits: 3,
});

const at = Date.parse("2026-10-20T10:00:00Z");

describe("runIndexer once", () => {
  it("builds an index the reader finds, files 0600, folders 0700", async () => {
    const w = world();
    writeFileSync(
      w.file("a"),
      fakeLine({ k: "p", text: "deploy the webhook", at }) + fakeLine({ k: "r", text: "done", at: at + 1 }),
    );
    writeFileSync(w.file("b"), fakeLine({ k: "p", text: "rate limiter", at }));
    const statuses: IndexerStatus[] = [];
    await runIndexer({
      dir: w.dir,
      env: w.env,
      adapters: [w.adapter],
      history: true,
      mode: "once",
      onStatus: (s) => statuses.push(s),
    });
    const r = await openReader({ dir: w.dir, sources: ["history"] });
    expect(r.search(q("webhook")).matches.map((m) => m.session.key)).toEqual(["claude-code:a"]);
    expect(r.stats().messages).toBe(3);
    expect(statuses.at(-1)!.firstRun).toBe(false);
    for (const f of readdirSync(join(w.dir, "history")))
      expect(statSync(join(w.dir, "history", f)).mode & 0o777).toBe(0o600);
    expect(statSync(w.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(w.dir, "history")).mode & 0o777).toBe(0o700);
    r.close();
  });

  it("reads only what grew, never duplicates, and lets a partial last line wait", async () => {
    const w = world();
    writeFileSync(w.file("a"), fakeLine({ k: "p", text: "alpha one", at }));
    const run = () => runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" });
    await run();
    appendFileSync(w.file("a"), `${fakeLine({ k: "r", text: "alpha two", at: at + 5 })}{"k":"p","text":"alpha thr`);
    await run();
    let r = await openReader({ dir: w.dir, sources: ["history"] });
    expect(r.search(q("alpha")).matches[0]!.matched).toBe(2);
    r.close();
    appendFileSync(w.file("a"), `ee alpha","at":${at + 9}}\n`);
    await run();
    r = await openReader({ dir: w.dir, sources: ["history"] });
    expect(r.search(q("alpha")).matches[0]!.matched).toBe(3);
    expect(r.search(q("three")).total).toBe(1);
    expect(r.stats().messages).toBe(3);
    r.close();
  });

  it("re-reads a replaced, shrunk or rewritten file and drops a deleted one", async () => {
    const w = world();
    const run = () => runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" });
    writeFileSync(
      w.file("a"),
      fakeLine({ k: "p", text: "old words here", at }) + fakeLine({ k: "r", text: "more old", at }),
    );
    writeFileSync(w.file("b"), fakeLine({ k: "p", text: "bravo stays", at }));
    writeFileSync(w.file("c"), fakeLine({ k: "p", text: "charlie goes", at }));
    await run();
    // a: replaced (new inode) by shorter content
    writeFileSync(`${w.file("a")}.new`, fakeLine({ k: "p", text: "new words", at }));
    renameSync(`${w.file("a")}.new`, w.file("a"));
    // c: deleted
    unlinkSync(w.file("c"));
    await run();
    let r = await openReader({ dir: w.dir, sources: ["history"] });
    expect(r.search(q("old")).total).toBe(0);
    expect(r.search(q("new")).total).toBe(1);
    expect(r.search(q("charlie")).total).toBe(0);
    expect(r.search(q("bravo")).total).toBe(1);
    r.close();
    // b: same size, same inode, different head
    const before = statSync(w.file("b")).size;
    writeFileSync(w.file("b"), fakeLine({ k: "p", text: "delta stays", at }), { flag: "r+" });
    expect(statSync(w.file("b")).size).toBe(before);
    await new Promise((res) => setTimeout(res, 20));
    appendFileSync(w.file("b"), fakeLine({ k: "r", text: "echo", at }));
    await run();
    r = await openReader({ dir: w.dir, sources: ["history"] });
    expect(r.search(q("bravo")).total).toBe(0);
    expect(r.search(q("delta")).total).toBe(1);
    expect(r.search(q("echo")).total).toBe(1);
    expect(r.stats().messages).toBe(3);
    r.close();
  });

  it("re-reads a whole file when it changes", async () => {
    const w = world();
    const run = () => runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" });
    writeFileSync(w.file("g", "json"), JSON.stringify([{ k: "p", text: "gemini first", at }]));
    await run();
    writeFileSync(
      w.file("g", "json"),
      JSON.stringify([
        { k: "p", text: "gemini first", at },
        { k: "r", text: "gemini second", at },
      ]),
    );
    await run();
    const r = await openReader({ dir: w.dir, sources: ["history"] });
    expect(r.search(q("gemini")).matches[0]!.matched).toBe(2);
    expect(r.stats().messages).toBe(2);
    r.close();
  });

  it("rebuilds in one switch and keeps the answers", async () => {
    const w = world();
    for (let i = 0; i < 5; i++) writeFileSync(w.file(`s${i}`), fakeLine({ k: "p", text: `session ${i} needle`, at }));
    await runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" });
    const gen0 = readManifest(join(w.dir, "history"))!.gen;
    await runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once", rebuild: true });
    const m = readManifest(join(w.dir, "history"))!;
    expect(m.gen).toBeGreaterThan(gen0);
    const r = await openReader({ dir: w.dir, sources: ["history"] });
    expect(r.search(q("needle")).total).toBe(5);
    expect(r.stats().messages).toBe(5);
    r.close();
    const names = readdirSync(join(w.dir, "history")).filter((f) => f.startsWith("seg-"));
    expect(names.length).toBe(m.segments.length + m.segments.filter((s) => s.del).length);
  });

  it("history off removes history/ and never writes it", async () => {
    const w = world();
    writeFileSync(w.file("a"), fakeLine({ k: "p", text: "secret history", at }));
    await runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" });
    expect(readdirSync(w.dir)).toContain("history");
    await runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: false, mode: "once" });
    expect(readdirSync(w.dir)).not.toContain("history");
    await removeIndex(w.dir, "history");
  });

  it("takes the LOCK; a second writer is refused, a stale lock taken over", async () => {
    const w = world();
    const release = acquireLock(w.dir);
    await expect(
      runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" }),
    ).resolves.toBeUndefined();
    release();
    writeFileSync(join(w.dir, "LOCK"), JSON.stringify({ pid: 1, host: "x" }));
    // pid 1 is alive (launchd/init) and not us: refused
    await expect(
      runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" }),
    ).rejects.toBeInstanceOf(LockedError);
    writeFileSync(join(w.dir, "LOCK"), JSON.stringify({ pid: 999_999_999, host: "x" }));
    await expect(
      runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" }),
    ).resolves.toBeUndefined();
  });

  it("cleans temp files and unnamed segments on open", async () => {
    const w = world();
    writeFileSync(w.file("a"), fakeLine({ k: "p", text: "kept", at }));
    await runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" });
    const idx = join(w.dir, "history");
    writeFileSync(join(idx, "seg-99.sps.tmp"), "junk");
    writeFileSync(join(idx, "seg-98.sps"), "junk");
    writeFileSync(join(idx, "MANIFEST.tmp"), "junk");
    await runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" });
    const names = readdirSync(idx);
    expect(names.some((n) => n.endsWith(".tmp") || n === "seg-98.sps")).toBe(false);
    const r = await openReader({ dir: w.dir, sources: ["history"] });
    expect(r.search(q("kept")).total).toBe(1);
    r.close();
  });
});

describe("watch mode", () => {
  it("commits the first build quickly, then hot appends, forget and stop", { timeout: 60_000 }, async () => {
    const w = world();
    for (let i = 0; i < 30; i++)
      writeFileSync(w.file(`s${i}`), fakeLine({ k: "p", text: `hello world ${i}`, at: at + i }));
    const commits: number[] = [];
    const t0 = Date.now();
    const ix = startIndexer(
      {
        dir: w.dir,
        env: w.env,
        adapters: [w.adapter],
        history: true,
        mode: "watch",
        onCommit: () => commits.push(Date.now() - t0),
      },
      { inProcess: true, tickMs: 50, sweepMs: 500, idleExitMs: 60_000 },
    );
    const r = await openReader({ dir: w.dir, sources: ["history"] });
    const until = async (pred: () => boolean, ms = 30_000) => {
      const end = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((res) => setTimeout(res, 20));
        r.refresh();
      }
    };
    await until(() => r.search(q("hello")).total === 30);
    expect(commits[0]!).toBeLessThan(5000);
    appendFileSync(w.file("s3"), fakeLine({ k: "r", text: "brand new reply", at: at + 100 }));
    ix.send({ t: "hint", path: w.file("s3") });
    ix.send({ t: "commit" });
    await until(() => r.search(q("brand")).total === 1);
    ix.send({ t: "forget", key: "claude-code:s4" });
    await until(() => !r.search(q("hello")).matches.some((m) => m.session.key === "claude-code:s4"));
    ix.send({ t: "stop" });
    await ix.done;
    r.close();
  });

  it("exits on its own after the idle time", async () => {
    const w = world();
    writeFileSync(w.file("a"), fakeLine({ k: "p", text: "x", at }));
    const ix = startIndexer(
      { dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "watch" },
      { inProcess: true, tickMs: 20, sweepMs: 100, idleExitMs: 300 },
    );
    await ix.done;
    expect(readManifest(join(w.dir, "history"))!.built).toBe(true);
  });

  it("keeps few segments as commits pile up (merges), with the same answers", { timeout: 60_000 }, async () => {
    const w = world();
    writeFileSync(w.file("a"), "");
    const ix = startIndexer(
      { dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "watch" },
      { inProcess: true, tickMs: 10, sweepMs: 50, idleExitMs: 60_000 },
    );
    const r = await openReader({ dir: w.dir, sources: ["history"] });
    for (let i = 0; i < 30; i++) {
      appendFileSync(w.file("a"), fakeLine({ k: "p", text: `round ${i} marker`, at: at + i }));
      ix.send({ t: "hint", path: w.file("a") });
      ix.send({ t: "commit" });
      await new Promise((res) => setTimeout(res, 40));
    }
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      r.refresh();
      if (r.search(q("marker")).matches[0]?.matched === 30) break;
      await new Promise((res) => setTimeout(res, 30));
    }
    expect(r.search(q("marker")).matches[0]!.matched).toBe(30);
    expect(readManifest(join(w.dir, "history"))!.segments.length).toBeLessThanOrEqual(11);
    ix.send({ t: "stop" });
    await ix.done;
    r.close();
  });
});

describe("live tail", () => {
  it("finds bytes nobody committed yet, and forgets them once committed", async () => {
    const w = world();
    writeFileSync(w.file("a"), fakeLine({ k: "p", text: "committed text", at }));
    await runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" });
    const r = await openReader({ dir: w.dir, sources: ["history"], live: { env: w.env, adapters: [w.adapter] } });
    appendFileSync(w.file("a"), fakeLine({ k: "r", text: "fresh tail words", at: at + 1 }));
    writeFileSync(w.file("new"), fakeLine({ k: "p", text: "fresh new session", at: at + 2 }));
    r.hint(w.file("a"));
    r.hint(w.file("new"));
    await r.tickNow();
    const res = r.search(q("fresh"));
    expect(res.matches.map((m) => m.session.key).sort()).toEqual(["claude-code:a", "claude-code:new"]);
    expect(res.matches.every((m) => m.hits.every((h) => h.live))).toBe(true);
    // the transcript of a tail-only session works, refs resolve
    const t = r.transcript("claude-code:new", { limit: 10 })!;
    expect(t.messages[0]!.text).toBe("fresh new session");
    // after a commit the reader resets the tail: no duplicate
    await runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" });
    expect(r.refresh()).toBe(true);
    await r.tickNow();
    const again = r.search(q("fresh"));
    expect(again.matches.find((m) => m.session.key === "claude-code:a")!.matched).toBe(1);
    expect(again.matches.every((m) => m.hits.every((h) => !h.live))).toBe(true);
    const r2 = r.transcript("claude-code:new", { around: t.messages[0]!.ref, limit: 10 })!;
    expect(r2.messages[0]!.text).toBe("fresh new session");
    expect(r.stats().messages).toBe(3);
    // a quiet tick is cheap
    const t0 = performance.now();
    await r.tickNow();
    expect(performance.now() - t0).toBeLessThan(50);
    r.close();
  });
  it("reads a line appended to a fully committed, recently changed file without a hint", async () => {
    const w = world();
    writeFileSync(w.file("a"), fakeLine({ k: "p", text: "committed text", at }));
    await runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" });
    const r = await openReader({ dir: w.dir, sources: ["history"], live: { env: w.env, adapters: [w.adapter] } });
    await r.tickNow(); // the first discovery: nothing past the committed offset yet
    expect(r.search(q("appended")).matches).toEqual([]);
    appendFileSync(w.file("a"), fakeLine({ k: "r", text: "appended while you work", at: at + 1 }));
    await r.tickNow();
    const res = r.search(q("appended"));
    expect(res.matches.map((m) => m.session.key)).toEqual(["claude-code:a"]);
    expect(res.matches[0]!.hits.every((h) => h.live)).toBe(true);
    r.close();
  });
});

describe("facts follow their file", () => {
  it("a deleted or rewritten file takes its facts (title) with it", async () => {
    const w = world();
    const run = () => runIndexer({ dir: w.dir, env: w.env, adapters: [w.adapter], history: true, mode: "once" });
    writeFileSync(
      w.file("a"),
      fakeLine({ k: "t", text: "", title: "Zeppelin plans" }) + fakeLine({ k: "p", text: "first ask", at }),
    );
    writeFileSync(
      w.file("b"),
      fakeLine({ k: "t", text: "", title: "Gondola notes" }) + fakeLine({ k: "p", text: "other", at }),
    );
    await run();
    let r = await openReader({ dir: w.dir, sources: ["history"] });
    expect(r.search(q("zeppelin")).total).toBe(1);
    r.close();
    // a: rewritten shorter without its title record; b: deleted
    writeFileSync(`${w.file("a")}.new`, fakeLine({ k: "p", text: "first ask", at }));
    renameSync(`${w.file("a")}.new`, w.file("a"));
    unlinkSync(w.file("b"));
    await run();
    r = await openReader({ dir: w.dir, sources: ["history"] });
    expect(r.search(q("zeppelin")).total).toBe(0);
    expect(r.search(q("gondola")).total).toBe(0);
    expect(r.session("claude-code:a")!.title).toBeUndefined();
    expect(r.session("claude-code:b")).toBeUndefined();
    expect([...r.sessions()].map((s) => s.key)).toEqual(["claude-code:a"]);
    r.close();
  });
});
