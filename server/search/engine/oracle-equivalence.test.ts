// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The engine against perf's brute-force oracle (server/search/oracle.ts)
// on random corpora: the same sessions, the same totals, the same matching-doc counts, every
// hit one of the session's matching docs, and the same order wherever the scores are not
// near-ties (the engine quantizes doc lengths to 4 steps per octave, as Lucene does).
//
// Two scoring differences are deliberate and left out of the order check:
//   plurals  the oracle's plural atom takes the highest idf over {t+s, t+es, t−s} including
//            variants that do not exist (df 0 → the highest idf of all), so a doc holding only
//            `tests` outranks one holding `test` for the query `test`. The engine takes the idf
//            over the variants that exist. (Queries with a word whose plural exists — here
//            test/tests — are excluded from the order check.)
//   tf       a prefix's expansions that sit at one position (`http` and the whole
//            `httpserver`) count twice in the engine's summed tf, once in the oracle's.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseSearch } from "../../../shared/searchQuery.js";
import { OracleReader } from "../oracle.js";
import type { EngineQuery, SearchSource } from "../types.js";
import { Reader } from "./reader.js";
import { type GenDoc, randomDocs, rng, VOCAB, writeIndex } from "./testkit.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function randomQuery(r: () => number): { text: string; live: boolean } {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
  const n = 1 + Math.floor(r() * 3);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = pick(VOCAB);
    const k = r();
    if (k < 0.12) parts.push(`-${w.split(/[/\s]/)[0]}`);
    else if (k < 0.25) parts.push(`"${w} ${pick(VOCAB)}"`);
    else if (k < 0.4 && w.length > 3) parts.push(`${w.slice(0, 2 + Math.floor(r() * 3))}*`);
    else parts.push(w);
  }
  const live = r() < 0.3;
  let text = parts.join(" ");
  if (live) text = `${text.replace(/\*$/, "")}`.replace(/"[^"]*$/, "").trim() || "re";
  return { text, live };
}

function setup(seed: number, n: number, sessions: number, segments: number, events = false) {
  const { docs, facts } = randomDocs(seed, n, sessions);
  const dir = mkdtempSync(join(tmpdir(), "spe-oracle-"));
  dirs.push(dir);
  // a third of the sessions also arrived through sessionpipe (D6: history wins)
  const ev: GenDoc[] = events
    ? docs
        .filter((d) => Number(d.key.split(":s")[1]) % 3 === 1)
        .map((d) => ({ ...d, file: d.file + 10_000, seq: d.offset }))
    : [];
  const evOnly: GenDoc[] = events
    ? docs.slice(0, 300).map((d, i) => ({ ...d, key: `codex:ev${i % 17}`, file: 20_000 + (i % 17), seq: i }))
    : [];
  writeIndex(dir, "history", docs, facts, segments);
  const evDocs = [...ev, ...evOnly];
  const sources: SearchSource[] = events ? ["history", "sessionpipe"] : ["history"];
  if (events) writeIndex(dir, "sessionpipe", evDocs, [], 2);
  const engine = new Reader({ dir, sources });
  const oracle = new OracleReader({ sources });
  oracle.add(
    [
      ...docs.map((d) => ({ ...d, source: "history" as const, file: `h/${String(d.file).padStart(6, "0")}` })),
      ...evDocs.map((d) => ({ ...d, source: "sessionpipe" as const, file: `e/${String(d.file).padStart(6, "0")}` })),
    ],
    facts.map((f) => ({ ...f, source: "history" as const })),
  );
  return { engine, oracle, sources };
}

function compare(
  engine: Reader,
  oracle: OracleReader,
  sources: SearchSource[],
  text: string,
  live: boolean,
  extra: Partial<EngineQuery> = {},
) {
  const q: EngineQuery = {
    parsed: parseSearch(text, { live }),
    sources,
    sort: "best",
    offset: 0,
    limit: 500,
    hits: 3,
    ...extra,
  };
  const a = engine.search(q);
  const b = oracle.search(q);
  const ka = a.matches.map((m) => m.session.key);
  const kb = b.matches.map((m) => m.session.key);
  expect([text, [...ka].sort()]).toEqual([text, [...kb].sort()]);
  expect([text, a.total]).toEqual([text, b.total]);
  expect([text, [...a.unknownWords].sort()]).toEqual([text, [...b.unknownWords].sort()]);
  const ob = new Map(b.matches.map((m) => [m.session.key, m]));
  for (const m of a.matches) {
    const o = ob.get(m.session.key)!;
    expect([text, m.session.key, m.matched]).toEqual([text, m.session.key, o.matched]);
    expect(m.hits.length).toBe(o.hits.length);
  }
  // order: wherever the oracle's scores are clearly apart, the engine agrees
  let inversions = 0;
  if (/\btests?\b/.test(text)) return 0;
  for (let i = 0; i + 1 < kb.length; i++) {
    const s1 = b.matches[i]!.score;
    const s2 = b.matches[i + 1]!.score;
    if (s1 - s2 < 0.05 * s1) continue;
    if (ka.indexOf(kb[i]!) > ka.indexOf(kb[i + 1]!)) inversions++;
  }
  return inversions;
}

describe("engine ≡ oracle", () => {
  it("on a random history corpus split over 6 segments", { timeout: 120_000 }, () => {
    const { engine, oracle, sources } = setup(5, 3000, 90, 6);
    const r = rng(17);
    let inv = 0;
    let pairs = 0;
    for (let i = 0; i < 200; i++) {
      const { text, live } = randomQuery(r);
      inv += compare(engine, oracle, sources, text, live);
      pairs++;
    }
    // ranking: no clear inversion on more than a few percent of queries
    expect(inv).toBeLessThanOrEqual(Math.ceil(pairs * 0.05));
  });

  it("with sessionpipe events beside history (D6), filters, fields and newest", { timeout: 120_000 }, () => {
    const { engine, oracle, sources } = setup(8, 2500, 60, 4, true);
    const r = rng(23);
    for (let i = 0; i < 120; i++) {
      const { text, live } = randomQuery(r);
      compare(engine, oracle, sources, text, live);
      compare(engine, oracle, sources, text, live, { sources: ["sessionpipe"] });
      compare(engine, oracle, sources, text, live, { fields: ["prompt", "title"] });
      compare(engine, oracle, sources, text, live, { sort: "newest", allow: (s) => s.harness === "claude-code" });
    }
  });
});
