// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. Marks and snippets. The marks come from the same tokenizer as the
// index, so what matched is exactly what is marked: single terms, prefixes, and phrases as one
// mark from the first part to the last. A snippet is the best window of a message (the most
// distinct clauses, then the most marks), cut at word boundaries, whitespace folded, `…` at
// the cuts. A long message is never tokenized whole: a raw indexOf finds the region first
// (arch-engine.md §10: real-data p95 42 ms → 6.6 ms).
import type { SearchMark } from "../types.js";
import { asciiEq, asciiStarts, fold, isWordChar, spans } from "./tokenize.js";

/** What to mark, compiled once per query from its positive clauses. */
export interface Matcher {
  /** term → the clause bits it satisfies. */
  terms: Map<string, number>;
  prefixes: { p: string; bit: number }[];
  phrases: { parts: string[]; lastPrefix: boolean; bit: number }[];
  /** Raw needles for the indexOf pass over long messages (lowercase). */
  needles: string[];
}

export function emptyMatcher(): Matcher {
  return { terms: new Map(), prefixes: [], phrases: [], needles: [] };
}

// scratch reused by every markText call (it never re-enters)
const S_RAW: number[] = [];
const S_TP: number[] = [];
const S_TS: number[] = [];
const S_TE: number[] = [];
const S_FOLD: (string | undefined)[] = [];
const S_IDX: number[] = [];

// the marks of the last markFlat: starts, ends, clause bits (grown as needed)
const MS: number[] = [];
const ME: number[] = [];
const MB: number[] = [];

/** Marks of `text` into MS/ME/MB (sorted, merged); returns how many. No string is made per
 *  token: ASCII spans are compared in place, others folded one by one. */
function markFlat(text: string, m: Matcher): number {
  const byLen = matcherByLen(m);
  const prefixes = m.prefixes;
  const phrases = m.phrases;
  const raw = S_RAW;
  const tp = S_TP;
  const ts = S_TS;
  const te = S_TE;
  const folded = S_FOLD;
  raw.length = 0;
  tp.length = 0;
  ts.length = 0;
  te.length = 0;
  folded.length = 0;
  const keepToks = phrases.length > 0;
  spans(text, (pos, s, e, ascii) => {
    let bit = 0;
    let f: string | undefined;
    if (ascii) {
      const list = byLen.get(e - s);
      if (list) for (let i = 0; i < list.length; i++) if (asciiEq(text, s, e, list[i]![0])) bit |= list[i]![1];
      for (let i = 0; i < prefixes.length; i++) if (asciiStarts(text, s, e, prefixes[i]!.p)) bit |= prefixes[i]!.bit;
    } else {
      f = fold(text.slice(s, e));
      bit |= m.terms.get(f) ?? 0;
      for (let i = 0; i < prefixes.length; i++) if (f.startsWith(prefixes[i]!.p)) bit |= prefixes[i]!.bit;
    }
    if (bit) raw.push(s, e, bit);
    if (keepToks) {
      tp.push(pos);
      ts.push(s);
      te.push(e);
      folded.push(f);
    }
  });
  if (keepToks && tp.length) {
    const eq = (i: number, t: string, prefix: boolean): boolean => {
      const s = ts[i]!;
      const e = te[i]!;
      const f = folded[i];
      if (f === undefined) return prefix ? asciiStarts(text, s, e, t) : asciiEq(text, s, e, t);
      return prefix ? f.startsWith(t) : f === t;
    };
    for (const ph of phrases) {
      const k = ph.parts.length;
      for (let i = 0; i < tp.length; i++) {
        if (!eq(i, ph.parts[0]!, false)) continue;
        const p0 = tp[i]!;
        let last = i;
        let ok = true;
        let j = i;
        for (let q = 1; q < k && ok; q++) {
          const want = p0 + q;
          let x = j + 1;
          while (x < tp.length && tp[x]! < want) x++;
          let hit = -1;
          for (let y = x; y < tp.length && tp[y] === want; y++) {
            if (eq(y, ph.parts[q]!, ph.lastPrefix && q === k - 1)) {
              hit = y;
              break;
            }
          }
          if (hit < 0) ok = false;
          else {
            j = hit;
            last = hit;
          }
        }
        if (ok) raw.push(ts[i]!, Math.max(te[i]!, te[last]!), ph.bit);
      }
    }
  }
  if (!raw.length) return 0;
  const n = raw.length / 3;
  const idx = S_IDX;
  idx.length = 0;
  for (let i = 0; i < n; i++) idx.push(i);
  idx.sort((x, y) => raw[x * 3]! - raw[y * 3]! || raw[y * 3 + 1]! - raw[x * 3 + 1]!);
  let k = 0;
  for (let ii = 0; ii < idx.length; ii++) {
    const i = idx[ii]!;
    const s = raw[i * 3]!;
    const e = raw[i * 3 + 1]!;
    const b = raw[i * 3 + 2]!;
    if (k > 0 && s < ME[k - 1]!) {
      // overlapping (a phrase over its own parts, a whole over its parts): merge
      if (e > ME[k - 1]!) ME[k - 1] = e;
      MB[k - 1]! |= b;
      continue;
    }
    MS[k] = s;
    ME[k] = e;
    MB[k] = b;
    k++;
  }
  return k;
}

/** Marks in `text` (sorted, non-overlapping) and the clause bits they cover. */
export function markText(text: string, m: Matcher): { marks: SearchMark[]; bits: number[] } {
  const n = markFlat(text, m);
  const marks: SearchMark[] = [];
  const bits: number[] = [];
  for (let i = 0; i < n; i++) {
    marks.push([MS[i]!, ME[i]!]);
    bits.push(MB[i]!);
  }
  return { marks, bits };
}

const byLenCache = new WeakMap<Matcher, Map<number, [string, number][]>>();
function matcherByLen(m: Matcher): Map<number, [string, number][]> {
  let x = byLenCache.get(m);
  if (x) return x;
  x = new Map();
  for (const [t, b] of m.terms) {
    let l = x.get(t.length);
    if (!l) {
      l = [];
      x.set(t.length, l);
    }
    l.push([t, b]);
  }
  byLenCache.set(m, x);
  return x;
}

const popcount = (x: number): number => {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
};

const LONG = 2000;

let FOLD_MAP = new Int32Array(1024);
let FOLD_BUF = new Uint16Array(1024);
const UTF16 = new TextDecoder("utf-16le");

const isWs = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x2028 || c === 0x2029;

/** Folds whitespace runs in text[a, b) into single spaces, mapping marks along (one string
 *  made, from a reused buffer). */
function foldPiece(text: string, a: number, b: number, marks: SearchMark[]): { text: string; marks: SearchMark[] } {
  const len = b - a;
  if (FOLD_MAP.length < len + 1) FOLD_MAP = new Int32Array(Math.max(len + 1, FOLD_MAP.length * 2));
  if (FOLD_BUF.length < len) FOLD_BUF = new Uint16Array(Math.max(len, FOLD_BUF.length * 2));
  const map = FOLD_MAP;
  const buf = FOLD_BUF;
  let k = 0;
  let inWs = false;
  let changed = false;
  for (let i = a; i < b; i++) {
    const c = text.charCodeAt(i);
    if (isWs(c)) {
      if (!inWs) {
        if (c !== 32) changed = true;
        map[i - a] = k;
        buf[k++] = 32;
        inWs = true;
      } else {
        changed = true;
        map[i - a] = k;
      }
    } else {
      inWs = false;
      map[i - a] = k;
      buf[k++] = c;
    }
  }
  map[len] = k;
  const out = changed ? UTF16.decode(buf.subarray(0, k)) : text.slice(a, b);
  const ms: SearchMark[] = [];
  for (let i = 0; i < marks.length; i++) {
    const s = marks[i]![0];
    const e = marks[i]![1];
    if (e <= a || s >= b) continue;
    const ss = map[Math.max(s, a) - a]!;
    const ee = map[Math.min(e, b) - a]!;
    if (ee > ss) ms.push([ss, ee]);
  }
  return { text: out, marks: ms };
}

/** The best window of `text` of at most `width` UTF-16 units, with its marks. */
export function snippet(text: string, m: Matcher, width = 160): { text: string; marks: SearchMark[] } {
  let base = 0;
  let src = text;
  if (text.length > LONG) {
    const r = region(text, m);
    base = r[0];
    src = text.slice(r[0], r[1]);
  }
  let n = markFlat(src, m);
  if (!n && src !== text) {
    // The needle's first occurrences were not where the match is (a phrase whose word also
    // stands alone earlier): mark the whole text once rather than show an unmarked start.
    base = 0;
    src = text;
    n = markFlat(src, m);
  }
  const room = width - 2; // the ellipses
  if (!n) return cut(text, 0, Math.min(text.length, room), [], width);
  // best window: most distinct clause bits, then most marks
  let best = 0;
  let bestScore = -1;
  for (let i = 0, j = 0; i < n; i++) {
    while (ME[i]! - MS[j]! > room && j < i) j++;
    let bits = 0;
    for (let k = j; k <= i; k++) bits |= MB[k]!;
    const sc = popcount(bits) * 1000 + (i - j + 1);
    if (sc > bestScore) {
      bestScore = sc;
      best = j;
    }
  }
  const f0 = MS[best]!;
  let lastEnd = ME[best]!;
  for (let k = best; k < n && ME[k]! - f0 <= room; k++) lastEnd = ME[k]!;
  // centre the marked span, leaning on context before it (a third)
  const span = lastEnd - f0;
  const lead = Math.max(0, Math.min(40, Math.floor((room - span) / 3)));
  let a = base + f0 - lead;
  a = Math.max(0, Math.min(a, text.length - room));
  const b = Math.min(text.length, a + room);
  // only the marks that can show in the window become objects
  const abs: SearchMark[] = [];
  for (let k = 0; k < n; k++) {
    const s0 = MS[k]! + base;
    const e0 = ME[k]! + base;
    if (e0 > a - 16 && s0 < b + 16) abs.push([s0, e0]);
  }
  return cut(text, a, b, abs, width);
}

/** text[a, b) cut at word boundaries, whitespace folded, `…` at the cuts. */
function cut(
  text: string,
  a: number,
  b: number,
  marks: SearchMark[],
  width: number,
): { text: string; marks: SearchMark[] } {
  let s = a;
  let e = b;
  // don't start or end inside a word (back off at most 12 chars, never past a mark)
  const firstMark = marks.find((x) => x[1] > a)?.[0] ?? b;
  if (s > 0 && isWordChar(text, s - 1) && isWordChar(text, s)) {
    let k = s;
    while (k < s + 12 && k < firstMark && k < e && isWordChar(text, k)) k++;
    if (k < firstMark && k < e && k - s < 12) s = k;
  }
  let lastMark = a;
  for (const x of marks) if (x[0] < b && x[1] > lastMark) lastMark = x[1];
  if (e < text.length && isWordChar(text, e - 1) && isWordChar(text, e)) {
    let k = e;
    while (k > e - 12 && k > lastMark && k > s && isWordChar(text, k - 1)) k--;
    if (k > lastMark && k > s && e - k < 12) e = k;
  }
  // trim whitespace at the edges
  while (s < e && isWs(text.charCodeAt(s))) s++;
  while (e > s && isWs(text.charCodeAt(e - 1))) e--;
  const f = foldPiece(text, s, e, marks);
  const pre = s > 0 ? "…" : "";
  const post = e < text.length ? "…" : "";
  let body = f.text;
  let fm = f.marks;
  if (pre.length + body.length + post.length > width) {
    body = body.slice(0, width - pre.length - post.length);
    fm = fm.filter((x) => x[1] <= body.length);
  }
  const off = pre.length;
  return { text: pre + body + post, marks: off ? fm.map(([x, y]) => [x + off, y + off]) : fm };
}

/** The ~1,800-char region of a long text holding the most distinct needles. */
/** One case-insensitive regex over a query's needles (the short ones only when nothing longer
 *  exists: a 1–2 letter needle hits inside every word and says nothing about where to look). */
const NEEDLE_RE = new WeakMap<Matcher, { re: RegExp; index: Map<string, number> } | null>();
function needleRe(m: Matcher): { re: RegExp; index: Map<string, number> } | null {
  const hit = NEEDLE_RE.get(m);
  if (hit !== undefined) return hit;
  const all = [...new Set(m.needles.filter(Boolean))];
  const long = all.filter((n) => n.length >= 3);
  const use = (long.length ? long : all).sort((x, y) => y.length - x.length).slice(0, 24);
  const out = use.length
    ? {
        re: new RegExp(use.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi"),
        index: new Map(use.map((n, i) => [n, i])),
      }
    : null;
  NEEDLE_RE.set(m, out);
  return out;
}

const REGION = 900;

/** The region of a long text holding the most distinct needles (no lowercased copy made). */
function region(text: string, m: Matcher): [number, number] {
  const nr = needleRe(m);
  if (!nr) return [0, Math.min(text.length, LONG)];
  const re = nr.re;
  re.lastIndex = 0;
  const at: number[] = [];
  const which: number[] = [];
  for (let k = 0; k < 64; k++) {
    const x = re.exec(text);
    if (!x) break;
    at.push(x.index);
    which.push(nr.index.get(x[0].toLowerCase()) ?? 0);
    if (x[0].length === 0) re.lastIndex++;
  }
  if (!at.length) return [0, Math.min(text.length, LONG)];
  let best = at[0]!;
  let bestN = -1;
  for (let i = 0, j = 0; i < at.length; i++) {
    while (at[i]! - at[j]! > REGION) j++;
    let mask = 0;
    for (let k = j; k <= i; k++) mask |= 1 << (which[k]! & 31);
    const n = popcount(mask);
    if (n > bestN) {
      bestN = n;
      best = at[j]!;
    }
  }
  const a = Math.max(0, best - 200);
  return [a, Math.min(text.length, a + REGION + 400)];
}
