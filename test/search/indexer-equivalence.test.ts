// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. The whole write path against the oracle (SEARCH-SPEC.md §8.3): a
// generated home indexed by runIndexer through the real sources, then changed the way logs
// change (lines appended, a file rewritten shorter, a file replaced by a new inode, a file
// deleted, new sessions), indexed again (tombstones, new segments, merges), and finally grown
// once more without a commit for the reader's live tail. After each step the engine's answers
// equal the oracle's over the same files, read fresh.
import { appendFileSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../bench/search/gen.mjs";
import { loadOracle, oracleTokens } from "../../server/search/oracle.js";
import { eventsAdapter, historyAdapters, sourceEnv } from "../../server/search/sources/index.js";
import type { SearchReader, SourceEnv } from "../../server/search/types.js";
import { parseSearch } from "../../shared/searchQuery.js";
import { tempDir } from "../events.js";
import { allMessages, BOTH, engineModule, haveEngine } from "./kit.js";

const NOW = Date.parse("2026-10-25T00:00:00Z");
let tmp: { dir: string; cleanup: () => void };
let env: SourceEnv;
const adapters = () => [...historyAdapters(), eventsAdapter()];
const home = (): string => path.join(tmp.dir, "gen", "home");
const dir = (): string => path.join(tmp.dir, "search");

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function claudeFiles(): string[] {
  const out: string[] = [];
  const projects = path.join(home(), ".claude", "projects");
  for (const slug of readdirSync(projects))
    for (const f of readdirSync(path.join(projects, slug)))
      if (f.endsWith(".jsonl")) out.push(path.join(projects, slug, f));
  return out.filter((f) => readFileSync(f).at(-1) === 10).sort();
}

const line = (sid: string, uuid: string, text: string, at: number): string =>
  `${JSON.stringify({ type: "user", sessionId: sid, uuid, cwd: "/Users/dev/git/x", timestamp: new Date(at).toISOString(), message: { role: "user", content: text } })}\n`;

/** Query texts drawn from what the oracle holds: words, pairs, phrases, prefixes, exclusions. */
function queriesFrom(o: SearchReader, seed: number, n: number): { q: string; live?: boolean }[] {
  const r = rng(seed);
  const msgs: string[] = [];
  for (const s of o.sessions()) for (const m of allMessages(o, s.key)) msgs.push(m.text);
  const word = (): string => {
    for (let k = 0; k < 20; k++) {
      const t = oracleTokens(msgs[Math.floor(r() * msgs.length)] ?? "").filter(
        (x) => !x.whole && /^[a-z]{3,}$/.test(x.term),
      );
      if (t.length) return t[Math.floor(r() * t.length)]!.term;
    }
    return "error";
  };
  const out: { q: string; live?: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const x = r();
    if (x < 0.3) out.push({ q: word() });
    else if (x < 0.55) out.push({ q: `${word()} ${word()}` });
    else if (x < 0.75) {
      const text = msgs[Math.floor(r() * msgs.length)] ?? "";
      const t = oracleTokens(text).filter((y) => !y.whole);
      if (t.length >= 2) {
        const a = Math.floor(r() * (t.length - 1));
        out.push({ q: `"${text.slice(t[a]!.start, t[a + 1]!.end).replace(/"/g, "")}"` });
      } else out.push({ q: word() });
    } else if (x < 0.85) out.push({ q: `${word()} -${word()}` });
    else out.push({ q: `${word()} ${word().slice(0, 4)}`, live: true });
  }
  return out;
}

async function compare(engine: SearchReader, label: string): Promise<string[]> {
  const oracle = await loadOracle(env, adapters(), { now: () => NOW });
  const diffs: string[] = [];
  const ek = [...engine.sessions()].map((s) => s.key).sort();
  const ok = [...oracle.sessions()]
    .filter((s) => s.messages > 0)
    .map((s) => s.key)
    .sort();
  const ekDocs = [...engine.sessions()]
    .filter((s) => s.messages > 0)
    .map((s) => s.key)
    .sort();
  if (JSON.stringify(ekDocs) !== JSON.stringify(ok))
    diffs.push(`${label}: sessions with docs: engine ${ekDocs.length} (all ${ek.length}), oracle ${ok.length}`);
  for (const k of ok) {
    // Equal timestamps across two files (an Antigravity artifact and its summary) have no
    // order of their own: compare in (at, text) order; ascending `at` is checked below.
    const key = (m: { field: string; at: number; text: string }) =>
      `${String(m.at).padStart(15, "0")}|${m.field}|${m.text}`;
    const ea = allMessages(engine, k);
    for (let i = 1; i < ea.length; i++)
      if (ea[i]!.at && ea[i - 1]!.at > ea[i]!.at)
        diffs.push(`${label}: ${k} engine transcript not in time order at ${i}`);
    const a = ea.map(key).sort();
    const b = allMessages(oracle, k).map(key).sort();
    if (JSON.stringify(a) !== JSON.stringify(b))
      diffs.push(
        `${label}: ${k} transcript ${a.length} vs ${b.length}: ${JSON.stringify(a.map((x) => x.slice(0, 40)))} / ${JSON.stringify(b.map((x) => x.slice(0, 40)))}`,
      );
    if (diffs.length > 10) return diffs;
  }
  // Prefix answers depend on the dictionary's df (tombstoned docs count until a merge), so
  // only queries whose expansions fit under the smallest cap are compared for live prefixes.
  for (const s of queriesFrom(oracle, ek.length, 120)) {
    const q = {
      parsed: parseSearch(s.q, { live: !!s.live }),
      sources: BOTH,
      sort: "best" as const,
      offset: 0,
      limit: 1000,
      hits: 3,
    };
    const a = engine
      .search(q)
      .matches.map((m) => `${m.session.key}:${m.matched}`)
      .sort();
    const b = oracle
      .search(q)
      .matches.map((m) => `${m.session.key}:${m.matched}`)
      .sort();
    if (s.live && JSON.stringify(a) !== JSON.stringify(b)) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const odd = a.find((x) => !b.includes(x)) ?? b.find((x) => !a.includes(x)) ?? "";
      const k = odd.slice(0, odd.lastIndexOf(":"));
      const es = engine.session(k);
      const os = oracle.session(k);
      diffs.push(
        `${label}: ${JSON.stringify(s)} engine ${a.length} oracle ${b.length} (${odd}; engine title "${es?.title}" msgs ${es?.messages}, oracle title "${os?.title}" msgs ${os?.messages})`,
      );
    }
    if (diffs.length > 10) break;
  }
  return diffs;
}

describe.skipIf(!haveEngine())("runIndexer + reader = oracle through changes", () => {
  beforeAll(() => {
    tmp = tempDir("spgui-ixeq-");
    generate({ out: path.join(tmp.dir, "gen"), profile: "gate", size: 2_000_000, seed: 9, now: NOW, turns: [12, 8] });
    env = sourceEnv({ home: home(), stateDir: path.join(tmp.dir, "gen", "state"), hostname: "eq-host" });
  });
  afterAll(() => tmp?.cleanup());

  it("first build, then appends, rewrites, replacements, deletions, new sessions, then the live tail", async () => {
    const e = await engineModule();
    const run = () => e.runIndexer({ dir: dir(), env, adapters: adapters(), history: true, mode: "once" });
    await run();
    let r = await e.openReader({ dir: dir(), sources: BOTH });
    expect(await compare(r, "first build")).toEqual([]);
    r.close();

    const files = claudeFiles();
    for (let round = 0; round < 4; round++) {
      // one file rewritten shorter, in place (same inode)
      const shrink = files[(round * 13 + 3) % files.length]!;
      const lines = readFileSync(shrink, "utf8").split("\n").filter(Boolean);
      // (its title records may go with the cut half: the facts must follow the file)
      writeFileSync(shrink, `${lines.slice(0, Math.max(1, Math.floor(lines.length / 2))).join("\n")}\n`);
      // one file replaced by a new inode with the same name and a changed head
      const repl = files[(round * 17 + 5) % files.length]!;
      const body = readFileSync(repl, "utf8").split("\n").filter(Boolean);
      writeFileSync(
        `${repl}.new`,
        `${line(path.basename(repl, ".jsonl"), `eq-head-${round}`, `replaced head eqhead${round}`, NOW - 1000)}${body.join("\n")}\n`,
      );
      renameSync(`${repl}.new`, repl);
      // one file deleted (skip the shrink and replace targets)
      const del = files.find((f, i) => i % 11 === round && f !== shrink && f !== repl && statSync(f).size > 0);
      if (del) {
        rmSync(del);
        files.splice(files.indexOf(del), 1);
      }
      // appends to ten files (after the rewrites, so none is cut)
      for (let i = 0; i < 10; i++) {
        const f = files[(round * 31 + i * 7) % files.length]!;
        appendFileSync(
          f,
          line(
            path.basename(f, ".jsonl"),
            `eq-${round}-${i}`,
            `round ${round} appended eqprobe${round}x${i} retry webhook`,
            NOW + round * 1000 + i,
          ),
        );
      }
      // a new session
      const slug = path.dirname(files[0]!);
      const sid = `eeeeeeee-0000-4000-a000-00000000000${round}`;
      writeFileSync(
        path.join(slug, `${sid}.jsonl`),
        line(sid, `eq-new-${round}`, `a brand new session eqnew${round}`, NOW + round),
      );
      await run();
      r = await e.openReader({ dir: dir(), sources: BOTH });
      expect(await compare(r, `round ${round}`)).toEqual([]);
      for (let i = 0; i < 10; i++)
        expect(
          r.search({
            parsed: parseSearch(`eqprobe${round}x${i}`),
            sources: BOTH,
            sort: "best",
            offset: 0,
            limit: 10,
            hits: 1,
          }).total,
        ).toBe(1);
      r.close();
    }

    // The live tail: bytes appended after the last commit are found by tick(), no writer.
    r = await e.openReader({ dir: dir(), sources: BOTH, live: { env, adapters: adapters() } });
    const hot = files[3]!;
    appendFileSync(hot, line(path.basename(hot, ".jsonl"), "eq-live-1", "typed a moment ago eqlivetail", Date.now()));
    r.hint(hot);
    for (
      let i = 0;
      i < 50 &&
      r.search({ parsed: parseSearch("eqlivetail"), sources: BOTH, sort: "best", offset: 0, limit: 10, hits: 1 })
        .total === 0;
      i++
    ) {
      r.tick();
      await new Promise((res) => setTimeout(res, 20));
    }
    const live = r.search({
      parsed: parseSearch("eqlivetail"),
      sources: BOTH,
      sort: "best",
      offset: 0,
      limit: 10,
      hits: 1,
    });
    expect(live.total).toBe(1);
    expect(live.matches[0]!.hits[0]!.live).toBe(true);
    expect(await compare(r, "live tail")).toEqual([]);
    r.close();
  }, 240_000);
});
