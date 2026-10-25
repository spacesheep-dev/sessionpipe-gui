// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. Marks and snippets. The marks come from the same tokenizer as the
// index, so what matched is exactly what is marked: single terms, prefixes, and phrases as one
// mark from the first part to the last. A snippet is the best window of a message (the most
// distinct clauses, then the most marks), cut at word boundaries, whitespace folded, `…` at
// the cuts. A long message is never tokenized whole: a raw indexOf finds the region first
// (arch-engine.md §10: real-data p95 42 ms → 6.6 ms).
import type { SearchMark } from "../types.js";
import { isWordChar, tokenize } from "./tokenize.js";

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

interface Tok {
  t: string;
  pos: number;
  s: number;
  e: number;
}

/** Marks in `text` (sorted, non-overlapping) and the clause bits they cover. */
export function markText(text: string, m: Matcher): { marks: SearchMark[]; bits: number[] } {
  const toks: Tok[] = [];
  const needToks = m.phrases.length > 0;
  const raw: [number, number, number][] = [];
  tokenize(text, (t, pos, s, e) => {
    if (needToks) toks.push({ t, pos, s, e });
    let bit = m.terms.get(t) ?? 0;
    if (!bit) for (const p of m.prefixes) if (t.startsWith(p.p)) bit |= p.bit;
    if (bit) raw.push([s, e, bit]);
  });
  if (needToks && toks.length) {
    // Positions → the first token at each position (a whole identifier shares its first part's).
    for (const ph of m.phrases) {
      const k = ph.parts.length;
      for (let i = 0; i < toks.length; i++) {
        const a = toks[i]!;
        if (a.t !== ph.parts[0]) continue;
        let j = i;
        let ok = true;
        let last = a;
        for (let q = 1; q < k && ok; q++) {
          const want = a.pos + q;
          let x = j + 1;
          while (x < toks.length && toks[x]!.pos < want) x++;
          // several tokens may share a position (whole identifiers): try each
          let hit = -1;
          for (let y = x; y < toks.length && toks[y]!.pos === want; y++) {
            const t = toks[y]!.t;
            const need = ph.parts[q]!;
            if (t === need || (ph.lastPrefix && q === k - 1 && t.startsWith(need))) {
              hit = y;
              break;
            }
          }
          if (hit < 0) ok = false;
          else {
            j = hit;
            last = toks[hit]!;
          }
        }
        if (ok) raw.push([a.s, Math.max(a.e, last.e), ph.bit]);
      }
    }
  }
  if (!raw.length) return { marks: [], bits: [] };
  raw.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const marks: SearchMark[] = [];
  const bits: number[] = [];
  for (const [s, e, b] of raw) {
    const lm = marks[marks.length - 1];
    if (lm && s < lm[1]) {
      // overlapping (a phrase over its own parts, a whole over its parts): merge
      if (e > lm[1]) lm[1] = e;
      bits[bits.length - 1]! |= b;
      continue;
    }
    marks.push([s, e]);
    bits.push(b);
  }
  return { marks, bits };
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

const isWs = (c: number): boolean => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x2028 || c === 0x2029;

/** Folds whitespace runs in text[a, b) into single spaces, mapping marks along. */
function foldPiece(text: string, a: number, b: number, marks: SearchMark[]): { text: string; marks: SearchMark[] } {
  const map = new Int32Array(b - a + 1);
  let out = "";
  let k = 0;
  let run = a;
  let inWs = false;
  for (let i = a; i < b; i++) {
    if (isWs(text.charCodeAt(i))) {
      if (!inWs) {
        out += `${text.slice(run, i)} `;
        inWs = true;
        map[i - a] = k++;
      } else map[i - a] = k;
      run = i + 1;
    } else {
      inWs = false;
      map[i - a] = k++;
    }
  }
  out += text.slice(run, b);
  map[b - a] = k;
  const ms: SearchMark[] = [];
  for (const [s, e] of marks) {
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
  const mk = markText(src, m);
  const room = width - 2; // the ellipses
  if (!mk.marks.length) return cut(text, 0, Math.min(text.length, room), [], width);
  // best window: most distinct clause bits, then most marks
  let best = 0;
  let bestScore = -1;
  const ms = mk.marks;
  for (let i = 0, j = 0; i < ms.length; i++) {
    while (ms[i]![1] - ms[j]![0] > room && j < i) j++;
    let bits = 0;
    for (let k = j; k <= i; k++) bits |= mk.bits[k]!;
    const sc = popcount(bits) * 1000 + (i - j + 1);
    if (sc > bestScore) {
      bestScore = sc;
      best = j;
    }
  }
  const first = ms[best]!;
  let lastEnd = first[1];
  for (let k = best; k < ms.length && ms[k]![1] - first[0] <= room; k++) lastEnd = ms[k]![1];
  // centre the marked span, leaning on context before it (a third)
  const span = lastEnd - first[0];
  const lead = Math.max(0, Math.min(40, Math.floor((room - span) / 3)));
  let a = base + first[0] - lead;
  a = Math.max(0, Math.min(a, text.length - room));
  const b = Math.min(text.length, a + room);
  const abs: SearchMark[] = ms.map(([s, e]) => [s + base, e + base]);
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
function region(text: string, m: Matcher): [number, number] {
  const low = text.toLowerCase();
  const hits: [number, number][] = [];
  m.needles.forEach((nd, i) => {
    if (!nd) return;
    let from = 0;
    for (let k = 0; k < 16; k++) {
      const at = low.indexOf(nd, from);
      if (at < 0) break;
      hits.push([at, i]);
      from = at + nd.length;
    }
  });
  if (!hits.length) return [0, Math.min(text.length, LONG)];
  hits.sort((x, y) => x[0] - y[0]);
  const W = 1800;
  let best = hits[0]![0];
  let bestN = -1;
  for (let i = 0, j = 0; i < hits.length; i++) {
    while (hits[i]![0] - hits[j]![0] > W) j++;
    const seen = new Set<number>();
    for (let k = j; k <= i; k++) seen.add(hits[k]![1]);
    if (seen.size > bestN) {
      bestN = seen.size;
      best = hits[j]![0];
    }
  }
  const a = Math.max(0, best - 300);
  return [a, Math.min(text.length, a + W + 300)];
}
