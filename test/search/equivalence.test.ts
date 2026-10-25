// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. The engine against the oracle (SEARCH-SPEC.md §8.3): random corpora
// written as several segments with tombstones, both indexes with overlapping keys, then a few
// hundred random queries (words, phrases cut from real docs, identifiers, paths, CJK,
// diacritics, prefixes, exclusions, fields, sources, allow, browse, both sorts). The answer
// must be the same set of sessions, the same matched counts, hits drawn from the same docs,
// and the same transcripts and find-bar hits.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Reader } from "../../server/search/engine/reader.js";
import { type GenDoc, writeIndex } from "../../server/search/engine/testkit.js";
import {
  fromDocs,
  type OracleDoc,
  type OracleFacts,
  type OracleReader,
  oracleTokens,
} from "../../server/search/oracle.js";
import type { EngineQuery, SearchReader, SearchSource, SessionFacts } from "../../server/search/types.js";
import { parseSearch } from "../../shared/searchQuery.js";
import { allMessages } from "./kit.js";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const DAY = 86_400_000;

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

// Prefixes stay under the smallest expansion cap (12) for most stems, so the capped and
// uncapped expansions agree; the comparisons skip a prefix with more completions.
const WORDS = (
  "webhook retry retries build builder server error errors fix store review migration rate limiter deploy " +
  "release queue worker timeout schema table column cursor page token tokens index search query phrase " +
  "kitchen weather price model branch commit merge rebase test tests testing tested receiver daemon hook " +
  "outbox canvas board feed inbox label colour theme font layout render paint frame latency memory cache " +
  "segment posting prefix ranking snippet alpha beta gamma delta omega zebra yak quartz"
).split(" ");
const IDENTS = [
  "getUserName",
  "get_user_name",
  "HTTPServer",
  "parseHTTPResponse",
  "base64Encode",
  "sha256",
  "rateLimiterV2",
  "__init__",
];
const PATHS = ["src/store/review.ts", "server/search/engine/reader.ts", "web/src/pages/Search.tsx", "docs/README.md"];
const INTL = ["検索更新", "Café", "Größe", "naïve", "Ошибка", "テスト"];

interface Corpus {
  docs: (GenDoc & { source: SearchSource; dead: boolean })[];
  facts: (SessionFacts & { source: SearchSource })[];
}

function corpus(seed: number, sessions: number): Corpus {
  const r = rng(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
  const docs: Corpus["docs"] = [];
  const facts: Corpus["facts"] = [];
  let file = 0;
  let at = NOW - 90 * DAY;
  const text = (): string => {
    const n = 2 + Math.floor(r() * 25);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const x = r();
      out.push(x < 0.06 ? pick(IDENTS) : x < 0.1 ? pick(PATHS) : x < 0.13 ? pick(INTL) : pick(WORDS));
      if (r() < 0.08) out[out.length - 1] += pick([".", ",", ":", "!"]);
    }
    return out.join(" ");
  };
  for (let s = 0; s < sessions; s++) {
    const harness = r() < 0.6 ? "claude-code" : "codex";
    const id = `s${seed}-${s}`;
    const key = `${harness}:${id}`;
    const inHistory = r() < 0.75;
    const inEvents = !inHistory || r() < 0.3;
    for (const source of [inHistory ? "history" : null, inEvents ? "sessionpipe" : null] as (SearchSource | null)[]) {
      if (!source) continue;
      const files = 1 + Math.floor(r() * 3);
      let seq = 0;
      for (let f = 0; f < files; f++) {
        file++;
        const n = 1 + Math.floor(r() * 30);
        const agent = f > 0 && source === "history" && r() < 0.5 ? `agent${f}` : undefined;
        for (let i = 0; i < n; i++) {
          at += 1000 + Math.floor(r() * 3 * 3_600_000);
          const field = pick(["prompt", "reply", "reply", "tool"] as const);
          const d: Corpus["docs"][number] = {
            key,
            field,
            at,
            text: text(),
            offset: i * 512,
            file,
            source,
            dead: source === "history" && r() < 0.08,
          };
          if (field === "tool") d.tool = pick(["Bash", "Read", "mcp__github__search_issues"]);
          if (agent) {
            d.agent = agent;
            d.agentType = "Explore";
          }
          if (source === "sessionpipe") d.seq = seq++;
          docs.push(d);
        }
      }
      const f: Corpus["facts"][number] = { key, harness, id, source, firstAt: at - DAY, lastAt: at };
      if (r() < 0.7)
        f.title = {
          text: `${pick(WORDS)} ${pick(WORDS)} ${r() < 0.3 ? pick(IDENTS) : pick(WORDS)}`,
          rank: pick([10, 25, 30, 50]),
        };
      if (source === "sessionpipe") f.machine = pick(["build-box", "studio-mac"]);
      f.cwd = `/Users/dev/${pick(WORDS)}`;
      facts.push(f);
    }
  }
  return { docs, facts };
}

function open(
  dir: string,
  c: Corpus,
  segments: number,
  sources: SearchSource[],
): { engine: SearchReader; oracle: OracleReader } {
  for (const source of ["history", "sessionpipe"] as const) {
    const docs = c.docs.filter((d) => d.source === source);
    const facts = c.facts.filter((f) => f.source === source).map(({ source: _, ...f }) => f);
    if (docs.length) writeIndex(dir, source, docs, facts, segments, (d) => (d as Corpus["docs"][number]).dead);
  }
  const engine = new Reader({ dir, sources });
  const odocs: OracleDoc[] = c.docs
    .filter((d) => !d.dead)
    .map(({ dead: _, file, ...d }) => ({ ...d, file: `/fake/${file}.jsonl` }));
  const ofacts: OracleFacts[] = c.facts;
  const oracle = fromDocs(odocs, ofacts, { now: () => NOW, sources });
  return { engine, oracle };
}

interface QSpec {
  q: string;
  live?: boolean;
  sources?: SearchSource[];
  sort?: "best" | "newest";
  allow?: "codex" | "recent";
}

function queries(seed: number, c: Corpus, n: number): QSpec[] {
  const r = rng(seed * 7 + 1);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
  const alive = c.docs.filter((d) => !d.dead);
  const phrase = (): string => {
    for (let k = 0; k < 20; k++) {
      const d = pick(alive);
      const toks = oracleTokens(d.text).filter((t) => !t.whole);
      if (toks.length < 3) continue;
      const i = Math.floor(r() * (toks.length - 2));
      const len = 2 + Math.floor(r() * 2);
      const a = toks[i]!;
      const b = toks[Math.min(toks.length - 1, i + len - 1)]!;
      const s = d.text.slice(a.start, b.end).replace(/"/g, "");
      if (s.trim()) return `"${s}"`;
    }
    return `"${pick(WORDS)} ${pick(WORDS)}"`;
  };
  const out: QSpec[] = [];
  for (let i = 0; i < n; i++) {
    const x = r();
    let q: string;
    let live = false;
    if (x < 0.15) q = pick(WORDS);
    else if (x < 0.27) q = `${pick(WORDS)} ${pick(WORDS)}`;
    else if (x < 0.32) q = `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}`;
    else if (x < 0.47) q = phrase();
    else if (x < 0.53) q = pick(IDENTS);
    else if (x < 0.58) q = pick(PATHS);
    else if (x < 0.63) q = pick(INTL);
    else if (x < 0.7) q = `${pick(WORDS).slice(0, 2 + Math.floor(r() * 3))}*`;
    else if (x < 0.75) {
      q = `${pick(WORDS)} ${pick(WORDS).slice(0, 2 + Math.floor(r() * 3))}`;
      live = true;
    } else if (x < 0.82) q = `${pick(WORDS)} -${pick(WORDS)}`;
    else if (x < 0.85) q = `${pick(WORDS)} -${phrase()}`;
    else if (x < 0.9) q = `${pick(WORDS)} in:${pick(["prompt", "reply", "tool", "title"])}`;
    else if (x < 0.94) q = `agent:claude ${r() < 0.5 ? `-${pick(WORDS)}` : ""}`.trim();
    else q = `${pick(WORDS)} ${pick(WORDS)}`;
    const spec: QSpec = { q, live };
    const y = r();
    if (y < 0.15) spec.sources = ["history"];
    else if (y < 0.3) spec.sources = ["sessionpipe"];
    if (r() < 0.3) spec.sort = "newest";
    if (r() < 0.15) spec.allow = r() < 0.5 ? "codex" : "recent";
    out.push(spec);
  }
  return out;
}

function engineQuery(s: QSpec, opened: SearchSource[]): EngineQuery {
  const parsed = parseSearch(s.q, { live: !!s.live });
  const q: EngineQuery = {
    parsed,
    sources: s.sources ?? opened,
    sort: s.sort ?? "best",
    offset: 0,
    limit: 1000,
    hits: 3,
  };
  const fin = parsed.filters.in?.filter((f): f is "prompt" | "reply" | "tool" | "title" =>
    ["prompt", "reply", "tool", "title"].includes(f),
  );
  if (fin?.length) q.fields = fin;
  const agent = parsed.filters.agent?.[0];
  if (s.allow === "codex") q.allow = (x) => x.harness === "codex";
  else if (s.allow === "recent") q.allow = (x) => x.lastAt >= NOW - 30 * DAY;
  else if (agent) q.allow = (x) => x.harness === agent;
  return q;
}

/** Prefixes with more completions than the smallest cap answer differently by design. */
const TERMS = new WeakMap<OracleReader, Set<string>>();
function capped(o: OracleReader, s: QSpec): boolean {
  const parsed = parseSearch(s.q, { live: !!s.live });
  let terms = TERMS.get(o);
  if (!terms) {
    terms = new Set<string>();
    for (const sess of o.sessions())
      for (const m of allMessages(o, sess.key)) for (const t of oracleTokens(m.text)) terms.add(t.term);
    TERMS.set(o, terms);
  }
  for (const c of parsed.clauses) {
    if (c.kind !== "prefix") continue;
    const last =
      oracleTokens(c.text)
        .filter((t) => !t.whole)
        .at(-1)?.term ?? "";
    let n = 0;
    for (const t of terms) if (t.startsWith(last) && t !== last) n++;
    if (n > 12) return true;
  }
  return false;
}

function compare(engine: SearchReader, oracle: OracleReader, specs: QSpec[], opened: SearchSource[]): string[] {
  const diffs: string[] = [];
  for (const s of specs) {
    if (capped(oracle, s)) continue;
    const eq = engineQuery(s, opened);
    const e = engine.search(eq);
    const o = oracle.search(engineQuery(s, opened));
    const label = `${JSON.stringify(s)}`;
    const ek = e.matches.map((m) => m.session.key).sort();
    const ok = o.matches.map((m) => m.session.key).sort();
    if (JSON.stringify(ek) !== JSON.stringify(ok)) {
      const extra = ek.filter((k) => !ok.includes(k));
      const missing = ok.filter((k) => !ek.includes(k));
      diffs.push(
        `${label}: sessions engine ${ek.length} oracle ${ok.length}; extra ${extra.slice(0, 3)} missing ${missing.slice(0, 3)}`,
      );
      continue;
    }
    if (Math.min(e.total, 200) !== Math.min(o.total, 200)) diffs.push(`${label}: total ${e.total} vs ${o.total}`);
    const om = new Map(o.matches.map((m) => [m.session.key, m]));
    const allHits = new Map(
      oracle.search({ ...engineQuery(s, opened), hits: 100_000 }).matches.map((m) => [m.session.key, m.hits]),
    );
    for (const m of e.matches) {
      const x = om.get(m.session.key)!;
      if (m.matched !== x.matched) diffs.push(`${label}: ${m.session.key} matched ${m.matched} vs ${x.matched}`);
      if (m.hits.length !== x.hits.length)
        diffs.push(`${label}: ${m.session.key} hits ${m.hits.length} vs ${x.hits.length}`);
      if (!!m.titleMarks?.length !== !!x.titleMarks?.length)
        diffs.push(
          `${label}: ${m.session.key} titleMarks ${JSON.stringify(m.titleMarks)} vs ${JSON.stringify(x.titleMarks)} on "${m.session.title}" / "${x.session.title}"`,
        );
      // every engine hit is a doc the oracle also matches (asked for many hits, the oracle
      // returns every doc it matched)
      const parsed = parseSearch(s.q, { live: !!s.live });
      const browse = !parsed.clauses.some((c) => !c.not);
      if (!browse) {
        const allowed = new Set((allHits.get(m.session.key) ?? []).map((h) => `${h.at}|${h.field}`));
        for (const h of m.hits)
          if (!allowed.has(`${h.at}|${h.field}`))
            diffs.push(`${label}: ${m.session.key} hit at ${h.at} ${h.field} is not a matching doc`);
      }
      for (const h of m.hits)
        for (const [a, b] of h.marks)
          if (a < 0 || b > h.text.length || a >= b) diffs.push(`${label}: bad mark ${a},${b}`);
    }
    if (diffs.length > 40) break;
  }
  return diffs;
}

const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "spgui-equiv-"));
  tmps.push(d);
  return d;
};

describe("engine = oracle on random corpora", { timeout: 180_000 }, () => {
  for (const [seed, sessions, segments] of [
    [1, 30, 1],
    [2, 40, 3],
    [3, 60, 7],
  ] as const) {
    it(`seed ${seed}: ${sessions} sessions in ${segments} segment(s), tombstones, both indexes`, () => {
      const c = corpus(seed, sessions);
      const opened: SearchSource[] = ["history", "sessionpipe"];
      const { engine, oracle } = open(tmp(), c, segments, opened);
      const diffs = compare(engine, oracle, queries(seed, c, 250), opened);
      engine.close();
      expect(diffs.slice(0, 15)).toEqual([]);
    });
  }

  it("transcripts and find-bar hits agree (dedupe, order, tombstones)", () => {
    const c = corpus(4, 30);
    const opened: SearchSource[] = ["history", "sessionpipe"];
    const { engine, oracle } = open(tmp(), c, 4, opened);
    const diffs: string[] = [];
    for (const s of oracle.sessions()) {
      const e = allMessages(engine, s.key).map((m) => `${m.at}|${m.field}|${m.text}`);
      const o = allMessages(oracle, s.key).map((m) => `${m.at}|${m.field}|${m.text}`);
      if (JSON.stringify(e) !== JSON.stringify(o)) diffs.push(`${s.key}: transcript ${e.length} vs ${o.length}`);
      for (const q of ["webhook", '"rate limiter"', "getUserName", "検索"]) {
        const p = parseSearch(q);
        const tE = new Map(allMessages(engine, s.key).map((m) => [m.ref, m]));
        const tO = new Map(allMessages(oracle, s.key).map((m) => [m.ref, m]));
        const he = engine.hitsIn(s.key, p).map((h) => {
          const m = tE.get(h.ref);
          return `${m?.at}:${h.marks.map(([a, b]) => m?.text.slice(a, b).toLowerCase()).join(",")}`;
        });
        const ho = oracle.hitsIn(s.key, p).map((h) => {
          const m = tO.get(h.ref);
          return `${m?.at}:${h.marks.map(([a, b]) => m?.text.slice(a, b).toLowerCase()).join(",")}`;
        });
        if (JSON.stringify(he) !== JSON.stringify(ho))
          diffs.push(`${s.key} ${q}: hitsIn ${he.length} vs ${ho.length} (${he[0]} / ${ho[0]})`);
      }
    }
    engine.close();
    expect(diffs.slice(0, 15)).toEqual([]);
  });

  it("history off: only the events index answers", () => {
    const c = corpus(5, 30);
    const opened: SearchSource[] = ["sessionpipe"];
    const { engine, oracle } = open(tmp(), c, 2, opened);
    const diffs = compare(engine, oracle, queries(5, c, 120), opened);
    engine.close();
    expect(diffs.slice(0, 15)).toEqual([]);
  });

  it("overlay titles and forget agree", () => {
    const c = corpus(6, 25);
    const opened: SearchSource[] = ["history", "sessionpipe"];
    const { engine, oracle } = open(tmp(), c, 2, opened);
    const keys = [...oracle.sessions()].map((s) => s.key);
    for (const [i, k] of keys.entries()) {
      if (i % 3 === 0) {
        const ov = { title: `zebra quartz renamed ${i}`, titleRank: 50, machine: "studio-mac" };
        engine.setOverlay(k, ov);
        oracle.setOverlay(k, ov);
      }
      if (i % 7 === 1) {
        engine.forget(k);
        oracle.forget(k);
      }
    }
    const diffs = compare(
      engine,
      oracle,
      [{ q: "zebra" }, { q: "quartz renamed" }, { q: "renamed in:title" }, ...queries(6, c, 80)],
      opened,
    );
    for (const k of keys) {
      const a = engine.session(k);
      const b = oracle.session(k);
      if (!!a !== !!b) diffs.push(`${k}: session() presence`);
      else if (a && b && a.title !== b.title) diffs.push(`${k}: title ${a.title} vs ${b.title}`);
    }
    engine.close();
    expect(diffs.slice(0, 15)).toEqual([]);
  });
});
