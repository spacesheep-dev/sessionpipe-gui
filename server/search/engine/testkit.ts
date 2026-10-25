// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. Test helpers (never imported by the server): random docs, writing a
// set of docs straight into an index directory as N segments + MANIFEST (bypassing the
// indexer), and a brute-force matcher with the engine's semantics for equivalence tests.

import { renameSync } from "node:fs";
import { join } from "node:path";
import { sessionKey } from "../../../shared/api.js";
import type { ParsedSearch, SearchDoc, SearchSource, SessionFacts } from "../types.js";
import { Builder } from "./builder.js";
import { pluralForms } from "./evaluate.js";
import { delName, emptyManifest, ensureDir, indexDir, type Manifest, writeDel, writeManifest } from "./manifest.js";
import { analyze } from "./tokenize.js";

/** A tiny seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const VOCAB = [
  "webhook",
  "retry",
  "build",
  "server",
  "error",
  "fix",
  "store",
  "review",
  "migration",
  "rate",
  "limiter",
  "deploy",
  "release",
  "token",
  "session",
  "search",
  "index",
  "cafe",
  "résumé",
  "quokka",
  "zanzibar",
  "elephant",
  "purple",
  "dishwasher",
  "staging",
  "prod",
  "query",
  "queries",
  "tests",
  "test",
  "phrase",
  "getUserName",
  "HTTPServer",
  "src/store/review.ts",
  "sha256",
  "ошибка",
  "検索",
  "rebase",
  "merge",
  "branch",
];

export interface GenDoc extends SearchDoc {
  file: number;
}

/** `n` random docs over `sessions` sessions, `files` files per session. */
export function randomDocs(seed: number, n: number, sessions: number): { docs: GenDoc[]; facts: SessionFacts[] } {
  const r = rng(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(r() * a.length)]!;
  const docs: GenDoc[] = [];
  const facts: SessionFacts[] = [];
  const base = Date.parse("2026-10-01T00:00:00Z");
  const offsets = new Map<number, number>();
  for (let s = 0; s < sessions; s++) {
    const harness = s % 3 === 0 ? "codex" : "claude-code";
    facts.push({
      key: sessionKey(harness, `s${s}`),
      harness,
      id: `s${s}`,
      title: s % 4 === 0 ? { text: `${pick(VOCAB)} ${pick(VOCAB)} plan`, rank: 25 } : undefined,
      cwd: `/work/repo${s % 5}`,
      firstAt: base + s * 3_600_000,
      lastAt: base + s * 3_600_000 + 1_800_000,
    });
  }
  for (let i = 0; i < n; i++) {
    const s = Math.floor(r() * sessions);
    const harness = s % 3 === 0 ? "codex" : "claude-code";
    const words: string[] = [];
    const len = 1 + Math.floor(r() * 18);
    for (let k = 0; k < len; k++) words.push(pick(VOCAB));
    const field = pick(["prompt", "reply", "reply", "tool"] as const);
    const file = s * 2 + (r() < 0.2 ? 1 : 0);
    const off = offsets.get(file) ?? 0;
    offsets.set(file, off + 100);
    const d: GenDoc = {
      key: sessionKey(harness, `s${s}`),
      field,
      at: base + s * 3_600_000 + Math.floor(r() * 1_800_000),
      text: field === "tool" ? `Bash ${words.join(" ")}` : words.join(" "),
      offset: off,
      file: file + 1,
    };
    if (field === "tool") d.tool = "Bash";
    if (file % 2 === 1) {
      d.agent = `agent-${s}`;
      d.agentType = "Explore";
    }
    docs.push(d);
  }
  return { docs, facts };
}

/** Write docs (in order) into `<dir>/<source>/` as `segments` segments; optionally tombstone
 *  docs by predicate. Returns the manifest. */
export function writeIndex(
  dir: string,
  source: SearchSource,
  docs: GenDoc[],
  facts: SessionFacts[],
  segments: number,
  dead?: (d: GenDoc, i: number) => boolean,
): Manifest {
  const idx = indexDir(dir, source);
  ensureDir(idx);
  const m = emptyManifest(source);
  const per = Math.ceil(docs.length / Math.max(1, segments));
  for (let s = 0; s < Math.max(1, segments); s++) {
    const part = docs.slice(s * per, (s + 1) * per);
    const b = new Builder();
    if (s === 0) for (const f of facts) b.facts(f);
    for (const d of part) b.add(d, d.file);
    if (b.empty) continue;
    const name = `seg-${m.nextSeg++}.sps`;
    const r = b.encode(join(idx, `${name}.tmp`));
    renameSync(join(idx, `${name}.tmp`), join(idx, name));
    const entry = { name, docs: part.length, bytes: r.bytes, crc: r.crc, dels: 0 } as Manifest["segments"][number];
    if (dead) {
      const bits = new Uint8Array(Math.ceil(part.length / 8));
      let c = 0;
      part.forEach((d, i) => {
        if (dead(d, s * per + i)) {
          bits[i >> 3]! |= 1 << (i & 7);
          c++;
        }
      });
      if (c) {
        entry.del = delName(name, 1);
        entry.dels = c;
        writeDel(idx, entry.del, bits);
      }
    }
    m.segments.push(entry);
  }
  for (const d of docs) {
    const p = `/fake/${d.file}.jsonl`;
    m.files[p] ??= {
      id: d.file,
      adapter: "claude",
      kind: "append",
      dev: 0,
      ino: 0,
      size: 0,
      mtimeMs: 0,
      offset: 0,
      head: 0,
      headLen: 0,
      lastAt: 0,
    };
  }
  m.nextFile = Math.max(...docs.map((d) => d.file), 0) + 1;
  m.gen = 1;
  m.built = true;
  writeManifest(idx, m);
  return m;
}

const TOK_CACHE = new Map<string, { t: string; pos: number }[]>();

/** Brute force with the engine's matching semantics: which sessions match, and which docs. */
export function bruteMatch(
  docs: GenDoc[],
  parsed: ParsedSearch,
  live: (d: GenDoc) => boolean = () => true,
): { sessions: Set<string>; docs: Map<string, Set<number>> } {
  const tokOf = (text: string) => {
    const hit = TOK_CACHE.get(text);
    if (hit) return hit;
    const toks: { t: string; pos: number }[] = [];
    const an = analyze(text);
    an.parts.forEach((t, pos) => {
      toks.push({ t, pos });
    });
    for (const w of an.wholes) toks.push({ t: w.term, pos: w.at });
    if (TOK_CACHE.size > 50_000) TOK_CACHE.clear();
    TOK_CACHE.set(text, toks);
    return toks;
  };
  const clauseMatch = (c: ParsedSearch["clauses"][number], toks: { t: string; pos: number }[]): boolean => {
    const an = analyze(c.text);
    const parts = an.parts;
    if (!parts.length) return true;
    const has = (t: string, pos?: number, prefix = false) =>
      toks.some((x) => (prefix ? x.t.startsWith(t) : x.t === t) && (pos === undefined || x.pos === pos));
    const phrase = (ps: string[], lastPrefix: boolean) =>
      toks.some(
        (x) => x.t === ps[0] && ps.every((p, k) => has(p, x.pos + k, lastPrefix && k === ps.length - 1 && k > 0)),
      );
    if (c.kind === "prefix") {
      if (parts.length === 1) return has(parts[0]!, undefined, true);
      return phrase(parts, true);
    }
    if (parts.length === 1) {
      const t = parts[0]!;
      return has(t) || (c.kind === "word" && pluralForms(t).some((v) => has(v)));
    }
    const whole = an.wholes.length === 1 && an.wholes[0]!.span === parts.length ? an.wholes[0]!.term : "";
    return phrase(parts, false) || (c.kind === "word" && !!whole && has(whole));
  };
  const pos = parsed.clauses.filter((c) => !c.not && analyze(c.text).parts.length);
  const neg = parsed.clauses.filter((c) => c.not && analyze(c.text).parts.length);
  const bySess = new Map<string, { mask: number; docs: Set<number> }>();
  const dropped = new Set<string>();
  docs.forEach((d, i) => {
    if (!live(d)) return;
    const toks = tokOf(d.text);
    for (const c of neg) if (clauseMatch(c, toks)) dropped.add(d.key);
    let m = 0;
    pos.forEach((c, ci) => {
      if (clauseMatch(c, toks)) m |= 1 << ci;
    });
    if (!m) return;
    let s = bySess.get(d.key);
    if (!s) {
      s = { mask: 0, docs: new Set() };
      bySess.set(d.key, s);
    }
    s.mask |= m;
    s.docs.add(i);
  });
  const ALL = (1 << pos.length) - 1;
  const sessions = new Set<string>();
  const out = new Map<string, Set<number>>();
  for (const [k, s] of bySess) {
    if (s.mask === ALL && !dropped.has(k)) {
      sessions.add(k);
      out.set(k, s.docs);
    }
  }
  return { sessions, docs: out };
}
