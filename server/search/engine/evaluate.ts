// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. Query compilation (ParsedSearch → clauses of weighted atoms) and the
// per-segment scoring kernels. BM25F (k1 1.2; title 4, prompt 2, reply 1, tool 0.7; a
// subagent's message ×0.8 in the weighted tf), with N, df and avgdl global across segments
// and both indexes, so the ranking never depends on how the docs happen to be split.
//
// An atom is a set of alternatives scored as one: a word's exact term (1.0), its plurals
// (0.6), a prefix's expansions (0.85) — tf summed over the set, idf the set's highest among
// the terms that exist. A clause scores the best of its atoms. Zero allocation per posting:
// everything per doc lives in pooled typed arrays.
import type { ParsedSearch } from "../types.js";
import type { DictEntry, Segment } from "./segment.js";
import { LEN } from "./segment.js";
import type { Matcher } from "./snippet.js";
import { analyze } from "./tokenize.js";

export const K1 = 1.2;
/** Per field code (prompt, reply, tool, then the same three for a subagent at ×0.8). */
export const W = Float64Array.of(2.0, 1.0, 0.7, 1.6, 0.8, 0.56);
export const BF = Float64Array.of(0.75, 0.75, 0.5, 0.75, 0.75, 0.5);
export const TITLE_W = 4.0;
export const TITLE_B = 0.3;
export const PLURAL_W = 0.6;
export const PREFIX_W = 0.85;
export const PHRASE_IDF = 0.7;
/** At most this many clauses take part (the rest are ignored; a mask is 32 bits). */
export const MAX_CLAUSES = 24;

export type Atom =
  /** One slot: any of `terms`. */
  | { kind: "terms"; terms: string[]; w: number }
  /** Consecutive positions; every slot one term, except the last of a prefix phrase. */
  | { kind: "phrase"; slots: string[][]; w: number };

export interface Clause {
  not: boolean;
  atoms: Atom[];
  /** For `unknownWords`: the word as typed, when the clause is a plain word. */
  word?: string;
  /** A single-term word: it is unknown when none of these exist. A multi-part word: when
   *  any of its parts is missing. */
  known?: string[];
  parts: string[];
  /** Title matching of a prefix clause (uncapped): `head` terms, then one starting `prefix`. */
  titlePrefix?: { head: string[]; prefix: string }[];
  /** The atoms' idf, set per query (prepare). */
  idf?: number[];
}

/** What compiling needs from the dictionary (global across the read segments). */
export interface Dict {
  df(term: string): number;
  /** The exact term (when present) plus the `cap` most frequent others starting with `p`. */
  expand(p: string, cap: number): string[];
}

const cpLen = (s: string): number => {
  let k = 0;
  for (const _ of s) k++;
  return k;
};

/** Plural variants of a term: `+s`, `+es`, `−s` (longer than 3). */
export function pluralForms(t: string): string[] {
  const out = new Set([`${t}s`, `${t}es`]);
  if (t.length > 3 && t.endsWith("s")) out.add(t.slice(0, -1));
  out.delete(t);
  return [...out];
}

/** The prefix expansion cap: 12/32/64 for 2/3/4+ code points while typing, else 64. */
export function prefixCap(part: string, live: boolean | undefined): number {
  if (!live) return 64;
  const n = cpLen(part);
  return n <= 2 ? 12 : n === 3 ? 32 : 64;
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
    const clause: Clause = { not: c.not, atoms, parts };
    // A single identifier also matches its joined form (`getUserName` → getusername).
    const w0 = an.wholes[0];
    const whole = an.wholes.length === 1 && w0 && w0.at === 0 && w0.span === parts.length ? w0.term : "";
    if (c.kind === "prefix") {
      const last = parts[parts.length - 1]!;
      const cap = prefixCap(last, c.live);
      const head = parts.slice(0, -1);
      const ex = dict.expand(last, cap);
      if (!head.length) atoms.push({ kind: "terms", terms: ex, w: PREFIX_W });
      else atoms.push({ kind: "phrase", slots: [...head.map((t) => [t]), ex], w: PREFIX_W });
      clause.titlePrefix = [{ head, prefix: last }];
      if (whole) {
        atoms.push({ kind: "terms", terms: dict.expand(whole, cap), w: PREFIX_W });
        clause.titlePrefix.push({ head: [], prefix: whole });
      }
    } else if (parts.length === 1) {
      const t = parts[0]!;
      atoms.push({ kind: "terms", terms: [t], w: 1 });
      if (c.kind === "word") {
        const pl = pluralForms(t);
        atoms.push({ kind: "terms", terms: pl, w: PLURAL_W });
        clause.word = c.text;
        clause.known = [t, ...pl];
      }
    } else {
      atoms.push({ kind: "phrase", slots: parts.map((t) => [t]), w: 1 });
      if (whole) atoms.push({ kind: "terms", terms: [whole], w: 1 });
      if (c.kind === "word") clause.word = c.text;
    }
    if (c.not) {
      neg.push(clause);
      continue;
    }
    const bit = 1 << pos.length;
    pos.push(clause);
    for (const a of atoms) {
      if (a.kind === "terms") for (const t of a.terms) matcher.terms.set(t, (matcher.terms.get(t) ?? 0) | bit);
    }
    if (c.kind === "prefix") {
      if (parts.length === 1) matcher.prefixes.push({ p: parts[0]!, bit });
      else matcher.phrases.push({ parts, lastPrefix: true, bit });
      if (whole) matcher.prefixes.push({ p: whole, bit });
    } else if (parts.length > 1) matcher.phrases.push({ parts, lastPrefix: false, bit });
    matcher.needles.push(parts.reduce((a, b) => (b.length > a.length ? b : a), ""));
    if (c.kind === "word" && parts.length === 1) {
      for (const a of atoms) if (a.kind === "terms") matcher.needles.push(...a.terms);
    }
    if (whole) matcher.needles.push(whole);
  }
  return { pos, neg, matcher };
}

export const idfOf = (N: number, df: number): number => Math.log(1 + (N - df + 0.5) / (df + 0.5));

/** An atom's idf: the highest idf among a slot's terms that exist (a phrase: 0.7·Σ slots). */
export function atomIdf(a: Atom, N: number, dict: Dict): number {
  const slotIdf = (terms: readonly string[]): number => {
    let m = 0;
    for (const t of terms) {
      const df = dict.df(t);
      if (df > 0) m = Math.max(m, idfOf(N, df));
    }
    return m;
  };
  if (a.kind === "terms") return slotIdf(a.terms);
  let s = 0;
  for (const sl of a.slots) s += slotIdf(sl);
  return PHRASE_IDF * s;
}

/** Sets `clause.idf` for every clause (once per query). */
export function prepare(clauses: Clause[], N: number, dict: Dict): void {
  for (const c of clauses) c.idf = c.atoms.map((a) => atomIdf(a, N, dict));
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
  acc = new Float32Array(0);
  accT = new Uint32Array(0);
  flag = new Uint8Array(1 << 12);
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
    this.acc = new Float32Array(n);
    this.accT = new Uint32Array(n);
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

/** BM25 of one doc (field code f, length code l) at tf `tf`. */
function bm25(f: number, l: number, tf: number, idf: number, avg: Float64Array): number {
  const tfw = W[f]! * tf;
  const b = BF[f]!;
  return (idf * (tfw * (K1 + 1))) / (tfw + K1 * (1 - b + (b * LEN[l]!) / avg[f]!));
}

const E0 = (): DictEntry => ({ df: 0, po: 0, pl: 0, xo: 0, xl: 0 });
const lookE = E0();

/** A one-slot atom: tf summed over its terms per doc, then tmp[d] = max(tmp[d], bm25). */
export function termsInto(
  seg: Segment,
  terms: readonly string[],
  idfw: number,
  P: Scratch,
  fmask: number,
  avg: Float64Array,
): void {
  const fc = seg.fc;
  const acc = P.acc;
  const AT = P.accT;
  let na = 0;
  for (const t of terms) {
    if (!seg.lookup(t, lookE)) continue;
    const n = seg.decode(lookE, P.D, P.F);
    const D = P.D;
    const F = P.F;
    for (let i = 0; i < n; i++) {
      const d = D[i]!;
      if (!(fmask & (1 << fc[d]!))) continue;
      if (acc[d] === 0) AT[na++] = d;
      acc[d]! += F[i]!;
    }
  }
  const tmp = P.tmp;
  const T = P.tmpT;
  const lc = seg.lc;
  let nt = P.nt;
  for (let i = 0; i < na; i++) {
    const d = AT[i]!;
    const sc = bm25(fc[d]!, lc[d]!, acc[d]!, idfw, avg);
    acc[d] = 0;
    if (tmp[d] === 0) T[nt++] = d;
    if (sc > tmp[d]!) tmp[d] = sc;
  }
  P.nt = nt;
}

const phraseEnts: DictEntry[] = Array.from({ length: 64 }, E0);

/** Candidates of a phrase of single terms: CD docs, CS ranges into CP start positions. */
function phraseCandidates(seg: Segment, terms: readonly string[], P: Scratch, fmask: number): number {
  const k = Math.min(terms.length, phraseEnts.length);
  for (let i = 0; i < k; i++) if (!seg.lookup(terms[i]!, phraseEnts[i]!)) return 0;
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
  return n;
}

/** A phrase atom: tf = occurrences, tmp[d] = max(tmp[d], bm25). The last slot may hold several
 *  terms (a prefix's expansions): the head is matched once, then each expansion after it. */
export function phraseInto(
  seg: Segment,
  slots: readonly (readonly string[])[],
  idfw: number,
  P: Scratch,
  fmask: number,
  avg: Float64Array,
): void {
  const last = slots[slots.length - 1]!;
  const multi = last.length !== 1;
  if (multi && !last.length) return;
  const head: string[] = [];
  for (let i = 0; i < (multi ? slots.length - 1 : slots.length); i++) head.push(slots[i]![0]!);
  if (!head.length) return;
  const n = phraseCandidates(seg, head, P, fmask);
  if (!n) return;
  const CD = P.CD;
  const CS = P.CS;
  const CP = P.CP;
  const tmp = P.tmp;
  const T = P.tmpT;
  let nt = P.nt;
  if (!multi) {
    for (let i = 0; i < n; i++) {
      const d = CD[i]!;
      const sc = bm25(seg.fc[d]!, seg.lc[d]!, CS[i + 1]! - CS[i]!, idfw, avg);
      if (tmp[d] === 0) T[nt++] = d;
      if (sc > tmp[d]!) tmp[d] = sc;
    }
    P.nt = nt;
    return;
  }
  // one flag per candidate start, whichever expansion completed it
  const total = CS[n]!;
  if (P.flag.length < total) P.flag = new Uint8Array(Math.max(total, P.flag.length * 2));
  const flag = P.flag;
  flag.fill(0, 0, total);
  const k = head.length;
  for (const t of last) {
    if (!seg.lookup(t, lookE)) continue;
    P.POS = grow(P.POS, lookE.xl + 1);
    const m = seg.decodePos(lookE, P.D, P.F, P.PS, P.POS);
    const D = P.D;
    const PS = P.PS;
    const POS = P.POS;
    let j = 0;
    for (let i = 0; i < n; i++) {
      const d = CD[i]!;
      while (j < m && D[j]! < d) j++;
      if (j >= m) break;
      if (D[j] !== d) continue;
      const b1 = PS[j + 1]!;
      let r = PS[j]!;
      for (let x = CS[i]!; x < CS[i + 1]!; x++) {
        const want = CP[x]! + k;
        while (r < b1 && POS[r]! < want) r++;
        if (r < b1 && POS[r] === want) flag[x] = 1;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    let tf = 0;
    for (let x = CS[i]!; x < CS[i + 1]!; x++) tf += flag[x]!;
    if (!tf) continue;
    const d = CD[i]!;
    const sc = bm25(seg.fc[d]!, seg.lc[d]!, tf, idfw, avg);
    if (tmp[d] === 0) T[nt++] = d;
    if (sc > tmp[d]!) tmp[d] = sc;
  }
  P.nt = nt;
}

/** Every atom of a clause into `tmp` for one segment (`prepare` set the idfs). */
export function clauseInto(seg: Segment, c: Clause, P: Scratch, fmask: number, avg: Float64Array): void {
  for (let i = 0; i < c.atoms.length; i++) {
    const a = c.atoms[i]!;
    const idf = (c.idf?.[i] ?? 0) * a.w;
    if (idf <= 0) continue;
    if (a.kind === "terms") termsInto(seg, a.terms, idf, P, fmask, avg);
    else phraseInto(seg, a.slots, idf, P, fmask, avg);
  }
}
