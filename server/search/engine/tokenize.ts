// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The one tokenizer: the index, the query, the marks and the
// snippets all read text through it, so whatever is indexed is exactly what can be found
// and marked. Unicode-aware, allocation-light (a 64K char-class table, then charCodeAt).
//
//   Words     maximal runs of letters, digits, combining marks and `_`. A run over 200
//             characters (base64, minified code) is skipped; a part over 40 is not emitted.
//   Parts     identifiers split on `_`, lower→Upper (`fooBar`), UPPER→Upper lower
//             (`HTTPServer` → http server) and digit→Upper (`base64Encode`); never on
//             letter→digit (`sha256`, `utf8`, `v8` stay whole). Each part takes a position.
//   Whole     a word of several parts is emitted again whole (lowercased, leading `_`
//             dropped) at its first part's position: `getUserName` = `getusername`.
//   Folding   lowercase; diacritics stripped (NFKD) only when a non-ASCII char is present;
//             `ß` → `ss`.
//   CJK       Han, Hiragana, Katakana, Hangul: one character per token, so `検索` is a
//             phrase of two.
//   No stems  plural variants are a query-time expansion (evaluate.ts).

/** 0 other · 1 lower · 2 upper · 3 digit · 4 caseless letter · 5 CJK · 6 mark · 7 underscore */
const OTHER = 0;
const LOWER = 1;
const UPPER = 2;
const DIGIT = 3;
const CJK = 5;
const MARK = 6;
const UNDERSCORE = 7;

export const MAX_PART = 40;
export const MAX_RUN = 200;

let table: Uint8Array | null = null;

/** The char-class table, built once (about 30 ms) on first use. */
export function charClasses(): Uint8Array {
  if (table) return table;
  const t = new Uint8Array(65536);
  for (let c = 0; c < 128; c++) {
    t[c] =
      c >= 97 && c <= 122
        ? LOWER
        : c >= 65 && c <= 90
          ? UPPER
          : c >= 48 && c <= 57
            ? DIGIT
            : c === 95
              ? UNDERSCORE
              : OTHER;
  }
  const lu = /[\p{Lu}\p{Lt}]/u;
  const ll = /\p{Ll}/u;
  const nd = /\p{Nd}/u;
  const l = /\p{L}/u;
  const m = /\p{M}/u;
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  for (let c = 128; c < 65536; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue; // surrogates separate words (emoji, astral)
    const ch = String.fromCharCode(c);
    if (!l.test(ch) && !nd.test(ch) && !m.test(ch)) continue;
    t[c] = cjk.test(ch) ? CJK : lu.test(ch) ? UPPER : ll.test(ch) ? LOWER : nd.test(ch) ? DIGIT : l.test(ch) ? 4 : MARK;
  }
  table = t;
  return t;
}

const MARKS_RE = /\p{M}/gu;

/** Han, kana, Hangul and their half-width forms: NFKC only (stripping marks after NFKD would
 *  turn デ into テ and break Hangul syllables into jamo). */
const CJK_RE =
  /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9f]/;

/** Case and diacritic folding of one term (ASCII: a plain lowercase). */
export function fold(s: string): string {
  if (s.length <= 2 && CJK_RE.test(s)) return s.normalize("NFKC").toLowerCase();
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) {
      let f = s.normalize("NFKD").replace(MARKS_RE, "").toLowerCase();
      if (f.indexOf("ß") >= 0) f = f.replace(/ß/g, "ss");
      return f;
    }
  }
  return s.toLowerCase();
}

/** Called once per term: its folded text, its position, and [start, end) in `text`. */
export type Emit = (term: string, pos: number, start: number, end: number) => void;

/** Emits every term of `text` in order (positions ascend; a whole identifier repeats its
 *  first part's position). Returns the next free position. */
export function tokenize(text: string, emit: Emit, pos0 = 0): number {
  const ct = table ?? charClasses();
  const n = text.length;
  let pos = pos0;
  let i = 0;
  while (i < n) {
    const c = ct[text.charCodeAt(i)]!;
    if (c === OTHER || c === MARK) {
      i++;
      continue;
    }
    if (c === CJK) {
      emit(fold(text[i]!), pos++, i, i + 1);
      i++;
      continue;
    }
    const start = i;
    let ascii = true;
    while (i < n) {
      const code = text.charCodeAt(i);
      const k = ct[code]!;
      if (k === OTHER || k === CJK) break;
      if (code > 127) ascii = false;
      i++;
    }
    const end = i;
    if (end - start > MAX_RUN) continue;
    let parts = 0;
    let ps = start;
    const firstPos = pos;
    let upper = false;
    for (let j = start; j <= end; j++) {
      const k = j < end ? ct[text.charCodeAt(j)]! : OTHER;
      let cut = j === end || k === UNDERSCORE;
      if (!cut && j > ps && k === UPPER) {
        const prev = ct[text.charCodeAt(j - 1)]!;
        if (prev === LOWER || prev === DIGIT) cut = true;
        else if (prev === UPPER && j + 1 < end && ct[text.charCodeAt(j + 1)] === LOWER) cut = true;
      }
      if (cut) {
        if (j > ps && j - ps <= MAX_PART) {
          const raw = text.slice(ps, j);
          emit(ascii ? (upper ? raw.toLowerCase() : raw) : fold(raw), pos++, ps, j);
          parts++;
        }
        ps = k === UNDERSCORE ? j + 1 : j;
        upper = false;
      }
      if (k === UPPER) upper = true;
    }
    if (parts > 1) {
      let ws = start;
      while (ws < end && text.charCodeAt(ws) === 95) ws++;
      let we = end;
      while (we > ws && text.charCodeAt(we - 1) === 95) we--;
      if (we - ws <= MAX_PART) {
        const raw = text.slice(ws, we);
        emit(ascii ? raw.toLowerCase() : fold(raw), firstPos, ws, we);
      }
    }
  }
  return pos;
}

/** What one query word reads as: its parts in order (a phrase when there are several) and
 *  the whole identifier when the word has one (`getUserName` → get user name + getusername). */
export interface Analyzed {
  parts: string[];
  /** Whole identifiers keyed by the position of their first part (index into `parts`). */
  wholes: { at: number; term: string; span: number }[];
}

export function analyze(text: string): Analyzed {
  const parts: string[] = [];
  const wholes: Analyzed["wholes"] = [];
  tokenize(text, (term, pos) => {
    if (pos < parts.length) {
      // A whole identifier repeats its first part's position, after the run's parts.
      wholes.push({ at: pos, term, span: parts.length - pos });
      return;
    }
    parts.push(term);
  });
  return { parts, wholes };
}

/** The terms of `text` in order (parts only), for tests and the title index. */
export function terms(text: string): string[] {
  return analyze(text).parts;
}

/** True when the char at `i` is part of a word (snippet cuts never split one). */
export function isWordChar(text: string, i: number): boolean {
  const ct = table ?? charClasses();
  const k = ct[text.charCodeAt(i)]!;
  return k !== OTHER;
}

/** Called once per term with its span only (no string made): `ascii` when the run has no
 *  character above 127 (then the term is the span lowercased). */
export type SpanEmit = (pos: number, start: number, end: number, ascii: boolean) => void;

/** The same terms as `tokenize`, as spans: the marks and snippets use it to match without
 *  allocating a string per token. */
export function spans(text: string, emit: SpanEmit, pos0 = 0): number {
  const ct = table ?? charClasses();
  const n = text.length;
  let pos = pos0;
  let i = 0;
  while (i < n) {
    const c = ct[text.charCodeAt(i)]!;
    if (c === OTHER || c === MARK) {
      i++;
      continue;
    }
    if (c === CJK) {
      emit(pos++, i, i + 1, false);
      i++;
      continue;
    }
    const start = i;
    let ascii = true;
    while (i < n) {
      const code = text.charCodeAt(i);
      const k = ct[code]!;
      if (k === OTHER || k === CJK) break;
      if (code > 127) ascii = false;
      i++;
    }
    const end = i;
    if (end - start > MAX_RUN) continue;
    let parts = 0;
    let ps = start;
    const firstPos = pos;
    for (let j = start; j <= end; j++) {
      const k = j < end ? ct[text.charCodeAt(j)]! : OTHER;
      let cut = j === end || k === UNDERSCORE;
      if (!cut && j > ps && k === UPPER) {
        const prev = ct[text.charCodeAt(j - 1)]!;
        if (prev === LOWER || prev === DIGIT) cut = true;
        else if (prev === UPPER && j + 1 < end && ct[text.charCodeAt(j + 1)] === LOWER) cut = true;
      }
      if (cut) {
        if (j > ps && j - ps <= MAX_PART) {
          emit(pos++, ps, j, ascii);
          parts++;
        }
        ps = k === UNDERSCORE ? j + 1 : j;
      }
    }
    if (parts > 1) {
      let ws = start;
      while (ws < end && text.charCodeAt(ws) === 95) ws++;
      let we = end;
      while (we > ws && text.charCodeAt(we - 1) === 95) we--;
      if (we - ws <= MAX_PART) emit(firstPos, ws, we, ascii);
    }
  }
  return pos;
}

/** text[s, e) lowercased equals `term` (ASCII spans only). */
export function asciiEq(text: string, s: number, e: number, term: string): boolean {
  if (e - s !== term.length) return false;
  for (let i = 0; i < term.length; i++) {
    let c = text.charCodeAt(s + i);
    if (c >= 65 && c <= 90) c |= 32;
    if (c !== term.charCodeAt(i)) return false;
  }
  return true;
}

/** text[s, e) lowercased starts with `p` (ASCII spans only). */
export function asciiStarts(text: string, s: number, e: number, p: string): boolean {
  if (e - s < p.length) return false;
  for (let i = 0; i < p.length; i++) {
    let c = text.charCodeAt(s + i);
    if (c >= 65 && c <= 90) c |= 32;
    if (c !== p.charCodeAt(i)) return false;
  }
  return true;
}
