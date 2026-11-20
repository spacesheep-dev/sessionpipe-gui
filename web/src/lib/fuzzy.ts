// SPDX-License-Identifier: Apache-2.0
// Fuzzy matching for the command palette: the query must be a subsequence of the text,
// case-insensitive. A hit at the start of a word (after a space, a slash, a dash, a dot,
// a colon, or at a camelCase step) scores more, a run of adjacent hits more again, a gap
// a little less. Nothing to install: one small dynamic programme, O(text × query), over
// strings a palette row is made of. `positions` are the matched indexes, for underlining.

export interface FuzzyMatch {
  score: number;
  /** Indexes into the text, ascending. */
  positions: number[];
}

const MATCH = 1;
const WORD_START = 3;
const RUN = 3;
const GAP = 1;
/** A little off per character before the first hit, so "pay" prefers "payments" to "repay". */
const LEAD = 0.05;

const BOUNDARY = /[\s\-_./:@#()[\]{}"'“”«»,;|]/;

const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();

/** Whether `text[i]` begins a word. */
export function isWordStart(text: string, i: number): boolean {
  if (i <= 0) return true;
  const prev = text[i - 1] as string;
  const cur = text[i] as string;
  if (BOUNDARY.test(prev)) return true;
  return isLower(prev) && isUpper(cur);
}

/** The best way `query` fits into `text` as a subsequence, or null when it does not.
 *  An empty query matches everything with a score of 0. */
export function fuzzy(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const m = q.length;
  const n = t.length;
  if (m === 0) return { score: 0, positions: [] };
  if (m > n) return null;

  // Quick exit: is it a subsequence at all?
  let k = 0;
  for (let i = 0; i < n && k < m; i++) if (t[i] === q[k]) k++;
  if (k < m) return null;

  // prev[i]: best score with the first j-1 query chars matched, the last at text index i.
  // prevMax[i] / prevArg[i]: the best of prev[0..i] and where it is, so a gap costs O(1).
  const NEG = Number.NEGATIVE_INFINITY;
  let prev = new Float64Array(n).fill(NEG);
  let prevMax = new Float64Array(n).fill(NEG);
  let prevArg = new Int32Array(n).fill(-1);
  const parents: Int32Array[] = [];

  for (let j = 0; j < m; j++) {
    const cur = new Float64Array(n).fill(NEG);
    const parent = new Int32Array(n).fill(-1);
    const c = q[j];
    for (let i = j; i < n; i++) {
      if (t[i] !== c) continue;
      const base = MATCH + (isWordStart(text, i) ? WORD_START : 0);
      if (j === 0) {
        cur[i] = base - i * LEAD;
        continue;
      }
      const run = i > 0 && prev[i - 1] !== NEG ? (prev[i - 1] as number) + RUN : NEG;
      const gap = i > 1 && prevMax[i - 2] !== NEG ? (prevMax[i - 2] as number) - GAP : NEG;
      if (run === NEG && gap === NEG) continue;
      if (run >= gap) {
        cur[i] = base + run;
        parent[i] = i - 1;
      } else {
        cur[i] = base + gap;
        parent[i] = prevArg[i - 2] as number;
      }
    }
    const curMax = new Float64Array(n).fill(NEG);
    const curArg = new Int32Array(n).fill(-1);
    let best = NEG;
    let arg = -1;
    for (let i = 0; i < n; i++) {
      if ((cur[i] as number) > best) {
        best = cur[i] as number;
        arg = i;
      }
      curMax[i] = best;
      curArg[i] = arg;
    }
    parents.push(parent);
    prev = cur;
    prevMax = curMax;
    prevArg = curArg;
  }

  const end = prevArg[n - 1] as number;
  if (end < 0) return null;
  const positions = new Array<number>(m);
  let i = end;
  for (let j = m - 1; j >= 0; j--) {
    positions[j] = i;
    i = (parents[j] as Int32Array)[i] as number;
  }
  return { score: prevMax[n - 1] as number, positions };
}

export interface FieldsMatch {
  score: number;
  /** One list of matched indexes per field, in the order the fields were given. */
  positions: number[][];
}

/** A query of several words against several fields: every word must fit some field; the
 *  score is the sum of each word's best score in any field, so rows rank as they always
 *  have. A word's underlines go to the field it fits best; where it starts in a field does
 *  not count there, and a tie goes to the earlier field (callers list shown fields first).
 *  Positions are collected per field, so a title and a repo can each carry their own
 *  underlines. */
export function fuzzyFields(query: string, fields: readonly string[]): FieldsMatch | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const positions: number[][] = fields.map(() => []);
  if (words.length === 0) return { score: 0, positions };
  let score = 0;
  for (const w of words) {
    let best: { f: number; m: FuzzyMatch; fit: number } | null = null;
    let top = Number.NEGATIVE_INFINITY;
    for (let f = 0; f < fields.length; f++) {
      const m = fuzzy(w, fields[f] as string);
      if (!m) continue;
      top = Math.max(top, m.score);
      const fit = m.score + (m.positions[0] ?? 0) * LEAD;
      if (!best || fit > best.fit + 1e-6) best = { f, m, fit };
    }
    if (!best) return null;
    score += top;
    const list = positions[best.f] as number[];
    for (const p of best.m.positions) if (!list.includes(p)) list.push(p);
  }
  for (const list of positions) list.sort((a, b) => a - b);
  return { score, positions };
}
