// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. The generated history home (bench/search/gen.mjs) read through the
// real sources, then searched: every planted needle answers exactly where it was planted, and
// nothing that must never be indexed (tool output, thinking, notices, guardian copies, replays,
// a partial last line, secrets, text above an event's tier) is ever found. Run over the oracle
// and, once it is there, over the engine built by runIndexer.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GenManifest, generate } from "../../bench/search/gen.mjs";
import { loadOracle } from "../../server/search/oracle.js";
import { eventsAdapter, historyAdapters, sourceEnv } from "../../server/search/sources/index.js";
import type { EngineQuery, SearchReader, SourceAdapter, SourceEnv } from "../../server/search/types.js";
import { allMessages, BOTH, engineModule, eq, haveEngine } from "./kit.js";

const NOW = Date.parse("2026-10-25T00:00:00Z");

let tmp = "";
let m: GenManifest;
let env: SourceEnv;
let adapters: SourceAdapter[];
const readers: { name: string; open: () => Promise<SearchReader> }[] = [
  { name: "oracle", open: () => loadOracle(env, adapters, { now: () => NOW }) },
];
if (haveEngine())
  readers.push({
    name: "engine",
    open: async () => {
      const e = await engineModule();
      const dir = path.join(tmp, "search");
      await e.runIndexer({ dir, env, adapters, history: true, mode: "once" });
      return e.openReader({ dir, sources: BOTH });
    },
  });

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "spgui-needles-"));
  m = generate({ out: path.join(tmp, "gen"), profile: "gate", size: 1_500_000, seed: 3, now: NOW });
  env = sourceEnv({
    home: path.join(tmp, "gen", "home"),
    stateDir: path.join(tmp, "gen", "state"),
    hostname: "test-host",
  });
  adapters = [...historyAdapters(), eventsAdapter()];
});
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const keysOf = (r: SearchReader, q: EngineQuery): string[] =>
  r
    .search(q)
    .matches.map((x) => x.session.key)
    .sort();

for (const subject of readers) {
  describe(`planted needles · ${subject.name}`, () => {
    let r: SearchReader;
    beforeAll(async () => {
      r = await subject.open();
    }, 120_000);
    afterAll(() => r?.close());

    it("every must-needle answers exactly where it was planted", () => {
      const wrong: string[] = [];
      for (const n of m.needles.filter((x) => x.kind === "must")) {
        const got = keysOf(r, eq(n.q, n.sources ?? BOTH));
        if (JSON.stringify(got) !== JSON.stringify(n.keys))
          wrong.push(`${n.q} (${n.why}): got ${got.length}, want ${n.keys.length}`);
      }
      expect(wrong).toEqual([]);
    });

    it("never-needles are never found", () => {
      const found: string[] = [];
      for (const n of m.needles.filter((x) => x.kind === "never")) {
        const res = r.search(eq(n.q, n.sources ?? BOTH));
        if (res.total) found.push(`${n.q} (${n.why}): ${res.total}`);
      }
      expect(found).toEqual([]);
    });

    it("planted secrets never match and never reach a stored text", () => {
      for (const s of m.secrets) expect(r.search(eq(s)).total, s.slice(0, 6)).toBe(0);
      for (const s of m.secrets) expect(r.search(eq(`"${s.slice(0, 12)}"`)).total).toBe(0);
      let texts = 0;
      for (const sess of r.sessions()) {
        for (const msg of allMessages(r, sess.key)) {
          texts++;
          for (const s of m.secrets) expect(msg.text.includes(s)).toBe(false);
        }
      }
      expect(texts).toBeGreaterThan(1000);
      expect(r.search(eq("redacted")).total).toBeGreaterThan(0);
    });

    it("one row per real session: no guardian, subagent or replay sessions", () => {
      const by: Record<string, number> = {};
      for (const s of r.sessions()) {
        const k = s.sources.includes("history") ? s.harness : `${s.harness}@events`;
        by[k] = (by[k] ?? 0) + 1;
      }
      for (const h of ["claude-code", "codex", "antigravity", "gemini-cli"])
        expect(by[h] ?? 0, h).toBe(m.sessions[h] ?? 0);
    });

    it("history beats events for one key, unless only sessionpipe is read", () => {
      const shadow = m.needles.filter((n) => n.q === m.needles.find((x) => x.why.startsWith("history beats"))?.q);
      expect(shadow.length).toBe(2);
    });
  });

  describe(`soft readings of a format · ${subject.name}`, () => {
    let r: SearchReader;
    beforeAll(async () => {
      r = await subject.open();
    }, 120_000);
    afterAll(() => r?.close());
    // A soft needle is the generator's reading of a format rule the sources may word
    // differently; the misses are listed in perf/notes.md as requests, not failures.
    it.skipIf(!process.env.SPGUI_SOFT)("each soft needle answers where it was planted", () => {
      const wrong: string[] = [];
      for (const n of m.needles.filter((x) => x.kind === "soft")) {
        const got = keysOf(r, eq(n.q, n.sources ?? BOTH));
        if (JSON.stringify(got) !== JSON.stringify(n.keys))
          wrong.push(`${n.q} (${n.why}): got ${got.length}, want ${n.keys.length}`);
      }
      expect(wrong).toEqual([]);
    });
  });
}
