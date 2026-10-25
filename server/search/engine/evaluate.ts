// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. Query compilation (ParsedSearch → clauses of weighted atoms) and the
// per-segment scoring kernels. BM25F (k1 1.2; title 4, prompt 2, reply 1, tool 0.7; a
// subagent's message ×0.8), with N, df and avgdl global across segments and both indexes, so
// the ranking never depends on how the docs happen to be split. Zero allocation per posting:
// everything per doc lives in pooled typed arrays.
import type { ParsedSearch } from "../types.js";
import type { DictEntry, Segment } from "./segment.js";
import { LEN } from "./segment.js";
import type { Matcher } from "./snippet.js";
import { analyze } from "./tokenize.js";

export const K1 = 1.2;
/** Per field code (prompt, reply, tool, then the same three for a subagent). */
export const W = Float64Array.of(2.0, 1.0, 0.7, 2.0, 1.0, 0.7);
export const SUB = Float64Array.of(1, 1, 1, 0.8, 0.8, 0.8);
export const BF = Float64Array.of(0.75, 0.75, 0.5, 0.75, 0.75, 0.5);
export const TITLE_W = 4.0;
export const TITLE_B = 0.3;
export const PLURAL_W = 0.6;
export const PREFIX_W = 0.85;
export const PHRASE_IDF = 0.7;
/** At most this many clauses take part (the rest are ignored; a mask is 32 bits). */
export const MAX_CLAUSES = 24;
export const PHRASE_PREFIX_CAP = 16;

export interface Alt {
  term: string;
  w: number;
}

export type Atom = { kind: "terms"; alts: Alt[] } | { kind: "phrase"; parts: string[]; last?: Alt[]; w: number };

export interface Clause {
  not: boolean;
  atoms: Atom[];
  /** For `unknownWords`: the word as typed, when the clause is a plain word. */
  word?: string;
  /** Every term the clause needs (all must exist for it to match anything). */
  need: string[];
  /** A prefix clause: the prefix (titles match it directly). */
  prefix?: string;
}

/** What compiling needs from the dictionary (global across the read segments). */
export interface Dict {
  df(term: string): number;
  /** The `cap` most frequent terms starting with `p` (exact term included when present). */
  expand(p: string, cap: number): string[];
}

const cpLen = (s: string): number => {
  let k = 0;
  for (const _ of s) k++;
  return k;
};

/** Plural variants of a term (`+s`, `+es`, `−s`, `y↔ies`), whether they exist or not. */
export function pluralForms(t: string): string[] {
  const out: string[] = [];
  const add = (v: string) => {
    if (v !== t && v.length > 1 && !out.includes(v)) out.push(v);
  };
  if (t.length < 3 || /^\d+$/.test(t)) return out;
  add(`${t}s`);
  if (/(s|x|z|ch|sh)$/.test(t)) add(`${t}es`);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) add(t.slice(0, -1));
  if (t.length > 4 && t.endsWith("es")) add(t.slice(0, -2));
  if (t.length > 3 && t.endsWith("y")) add(`${t.slice(0, -1)}ies`);
  if (t.length > 4 && t.endsWith("ies")) add(`${t.slice(0, -3)}y`);
  return out;
}

/** The plural variants that exist in the dictionary. */
function plurals(t: string, dict: Dict): string[] {
  return pluralForms(t).filter((v) => dict.df(v) > 0);
}

export function prefixCap(text: string, live: boolean | undefined): number {
  if (!live) return 64;
  const n = cpLen(text);
  return n <= 2 ? 12 : n === 3 ? 32 : 64;
}

function expansions(p: string, cap: number, dict: Dict): Alt[] {
  return dict.expand(p, cap).map((t) => ({ term: t, w: t === p ? 1 : PREFIX_W }));
}

export interface Compiled {
  pos: Clause[];
  neg: Clause[];
  matcher: Matcher;
}

/** ParsedSearch → clauses. A clause that tokenizes into nothing is dropped. */
export function compile(parsed: ParsedSearch, dict: Dict): Compiled {
  const pos: Clause[] = [];
  const neg: Clause[] = [];
  const matcher: Matcher = { terms: new Map(), prefixes: [], phrases: [], needles: [] };
  for (const c of parsed.clauses) {
    if (pos.length + neg.length >= MAX_CLAUSES) break;
    const an = analyze(c.text);
    const parts = an.parts;
    if (!parts.length) continue;
    const atoms: Atom[] = [];
    const clause: Clause = { not: c.not, atoms, need: [...parts] };
    if (c.kind === "prefix") {
      const cap = prefixCap(c.text, c.live);
      if (parts.length === 1) {
        const p = parts[0]!;
        const alts = expansions(p, cap, dict);
        atoms.push({ kind: "terms", alts });
        clause.prefix = p;
        clause.need = [];
      } else {
        const last = parts[parts.length - 1]!;
        const alts = expansions(last, Math.min(cap, PHRASE_PREFIX_CAP), dict);
        atoms.push({ kind: "phrase", parts: parts.slice(0, -1), last: alts, w: 1 });
        clause.need = parts.slice(0, -1);
      }
    } else if (c.kind === "phrase") {
      if (parts.length === 1) atoms.push({ kind: "terms", alts: [{ term: parts[0]!, w: 1 }] });
      else atoms.push({ kind: "phrase", parts, w: 1 });
    } else {
      clause.word = c.text;
      if (parts.length === 1) {
        const t = parts[0]!;
        atoms.push({
          kind: "terms",
          alts: [{ term: t, w: 1 }, ...plurals(t, dict).map((v) => ({ term: v, w: PLURAL_W }))],
        });
      } else {
        atoms.push({ kind: "phrase", parts, w: 1 });
        // `getUserName` also finds `getusername` written as one word
        const whole = an.wholes.length === 1 && an.wholes[0]!.span === parts.length ? an.wholes[0]!.term : undefined;
        if (whole) atoms.push({ kind: "terms", alts: [{ term: whole, w: 1 }] });
      }
    }
    if (c.not) neg.push(clause);
    else {
      const bit = 1 << pos.length;
      pos.push(clause);
      for (const a of atoms) {
        if (a.kind === "terms") {
          for (const alt of a.alts) matcher.terms.set(alt.term, (matcher.terms.get(alt.term) ?? 0) | bit);
        } else if (a.last) {
          matcher.phrases.push({ parts: [...a.parts, parts[parts.length - 1]!], lastPrefix: true, bit });
        } else matcher.phrases.push({ parts: a.parts, lastPrefix: false, bit });
      }
      if (clause.prefix) matcher.prefixes.push({ p: clause.prefix, bit });
      matcher.needles.push(parts.reduce((a, b) => (b.length > a.length ? b : a), ""));
      if (c.kind === "word" && parts.length === 1)
        for (const a of atoms) if (a.kind === "terms") for (const alt of a.alts) matcher.needles.push(alt.term);
    }
  }
  return { pos, neg, matcher };
}

// ───────────────────────────── kernels ─────────────────────────────

const grow = (a: Uint32Array, n: number): Uint32Array<ArrayBuffer> =>
  a.length >= n ? (a as Uint32Array<ArrayBuffer>) : new Uint32Array(Math.max(n, a.length * 2));

/** Pooled per-query scratch, sized to the largest segment. */
export class Scratch {
  N = 0;
  tmp = new Float32Array(0);
  score = new Float32Array(0);
  mask = new Uint32Array(0);
  touched = new Uint32Array(0);
  tmpT = new Uint32Array(0);
  D = new Uint32Array(0);
  F = new Uint32Array(0);
  CD = new Uint32Array(0);
  CS = new Uint32Array(0);
  PS = new Uint32Array(0);
  CP = new Uint32Array(1 << 12);
  POS = new Uint32Array(1 << 12);
  /** Docs written into `tmp` by the current clause. */
  nt = 0;
  ensure(N: number): this {
    if (this.N >= N) return this;
    const n = Math.max(N, Math.ceil(this.N * 1.25));
    this.N = n;
    this.tmp = new Float32Array(n);
    this.score = new Float32Array(n);
    this.mask = new Uint32Array(n);
    this.touched = new Uint32Array(n);
    this.tmpT = new Uint32Array(n);
    this.D = new Uint32Array(n);
    this.F = new Uint32Array(n);
    this.CD = new Uint32Array(n);
    this.CS = new Uint32Array(n + 1);
    this.PS = new Uint32Array(n + 1);
    return this;
  }
  /** Give the memory back when the largest segment shrank a lot (after merges). */
  shrink(N: number): void {
    if (this.N > N * 2 + 4096) {
      this.N = 0;
      this.ensure(N);
    }
  }
}

/** tmp[d] = max(tmp[d], bm25f) for one term's postings. */
export function termInto(seg: Segment, e: DictEntry, idf: number, P: Scratch, fmask: number, avg: Float64Array): void {
  const n = seg.decode(e, P.D, P.F);
  const D = P.D;
  const F = P.F;
  const fc = seg.fc;
  const lc = seg.lc;
  const tmp = P.tmp;
  const T = P.tmpT;
  let nt = P.nt;
  for (let i = 0; i < n; i++) {
    const d = D[i]!;
    const f = fc[d]!;
    if (!(fmask & (1 << f))) continue;
    const tfw = W[f]! * F[i]!;
    const b = BF[f]!;
    const sc = (SUB[f]! * idf * (tfw * (K1 + 1))) / (tfw + K1 * (1 - b + (b * LEN[lc[d]!]!) / avg[f]!));
    if (tmp[d] === 0) T[nt++] = d;
    if (sc > tmp[d]!) tmp[d] = sc;
  }
  P.nt = nt;
}

const E0 = (): DictEntry => ({ df: 0, po: 0, pl: 0, xo: 0, xl: 0 });
const phraseEnts: DictEntry[] = Array.from({ length: 64 }, E0);

/** A phrase of `terms` (consecutive positions): tf = occurrences, idf = 0.7·Σ idf(parts). */
export function phraseInto(
  seg: Segment,
  terms: string[],
  idf: number,
  P: Scratch,
  fmask: number,
  avg: Float64Array,
): void {
  const k = Math.min(terms.length, phraseEnts.length);
  for (let i = 0; i < k; i++) if (!seg.lookup(terms[i]!, phraseEnts[i]!)) return;
  // the rarest part first
  const ord: number[] = [];
  for (let i = 0; i < k; i++) ord.push(i);
  ord.sort((x, y) => phraseEnts[x]!.df - phraseEnts[y]!.df);
  let need = 0;
  for (let i = 0; i < k; i++) need = Math.max(need, phraseEnts[i]!.xl + 1);
  P.CP = grow(P.CP, need);
  P.POS = grow(P.POS, need);
  const k0 = ord[0]!;
  let n = seg.decodePos(phraseEnts[k0]!, P.CD, P.F, P.CS, P.CP);
  const CD = P.CD;
  const CS = P.CS;
  const CP = P.CP;
  // candidates: (doc, start = pos − k0), kept in place
  {
    let w = 0;
    let wk = 0;
    for (let i = 0; i < n; i++) {
      const a0 = CS[i]!;
      const a1 = CS[i + 1]!;
      const ws = wk;
      const d = CD[i]!;
      if (!(fmask & (1 << seg.fc[d]!))) continue;
      for (let j = a0; j < a1; j++) if (CP[j]! >= k0) CP[wk++] = CP[j]! - k0;
      if (wk > ws) {
        CD[w] = d;
        CS[w] = ws;
        w++;
      }
    }
    CS[w] = wk;
    n = w;
  }
  for (let oi = 1; oi < k && n > 0; oi++) {
    const q = ord[oi]!;
    const m = seg.decodePos(phraseEnts[q]!, P.D, P.F, P.PS, P.POS);
    const D = P.D;
    const PS = P.PS;
    const POS = P.POS;
    let w = 0;
    let wk = 0;
    let j = 0;
    for (let i = 0; i < n; i++) {
      const d = CD[i]!;
      while (j < m && D[j]! < d) j++;
      if (j >= m) break;
      if (D[j] !== d) continue;
      const ws = wk;
      const a0 = CS[i]!;
      const a1 = CS[i + 1]!;
      const b1 = PS[j + 1]!;
      let r = PS[j]!;
      for (let x = a0; x < a1; x++) {
        const want = CP[x]! + q;
        while (r < b1 && POS[r]! < want) r++;
        if (r < b1 && POS[r] === want) CP[wk++] = CP[x]!;
      }
      if (wk > ws) {
        CD[w] = d;
        CS[w] = ws;
        w++;
      }
    }
    CS[w] = wk;
    n = w;
  }
  const tmp = P.tmp;
  const T = P.tmpT;
  let nt = P.nt;
  for (let i = 0; i < n; i++) {
    const d = CD[i]!;
    const f = seg.fc[d]!;
    const tfw = W[f]! * (CS[i + 1]! - CS[i]!);
    const b = BF[f]!;
    const sc = (SUB[f]! * idf * (tfw * (K1 + 1))) / (tfw + K1 * (1 - b + (b * LEN[seg.lc[d]!]!) / avg[f]!));
    if (tmp[d] === 0) T[nt++] = d;
    if (sc > tmp[d]!) tmp[d] = sc;
  }
  P.nt = nt;
}

export const idfOf = (N: number, df: number): number => Math.log(1 + (N - df + 0.5) / (df + 0.5));

const lookE = E0();

/** One atom of a clause into `tmp` for one segment. */
export function atomInto(
  seg: Segment,
  a: Atom,
  P: Scratch,
  fmask: number,
  avg: Float64Array,
  N: number,
  dict: Dict,
): void {
  if (a.kind === "terms") {
    for (const alt of a.alts) {
      if (seg.lookup(alt.term, lookE)) termInto(seg, lookE, idfOf(N, dict.df(alt.term)) * alt.w, P, fmask, avg);
    }
    return;
  }
  let base = 0;
  for (const t of a.parts) base += idfOf(N, dict.df(t));
  if (a.last) {
    for (const alt of a.last) {
      const idf = PHRASE_IDF * (base + idfOf(N, dict.df(alt.term))) * alt.w;
      phraseInto(seg, [...a.parts, alt.term], idf, P, fmask, avg);
    }
    return;
  }
  phraseInto(seg, a.parts, PHRASE_IDF * base * a.w, P, fmask, avg);
}
