// SPDX-License-Identifier: Apache-2.0
// A small Markdown parser: text in, a block tree out. No React, no DOM, no raw HTML:
// a `<script>` tag in the source is plain text here, and nothing in the tree can ever
// become markup by itself. The renderer (components/Markdown.tsx) decides what a link
// or an image turns into; this file only records what was written.
//
// Covered: paragraphs, ATX headings (levels clamped to 1–4), emphasis, inline code,
// fenced code, nested lists, blockquotes, rules, GFM pipe tables, links, images
// (alt only), bare http(s) autolinks and line breaks (every newline in a paragraph is
// one). Everything else is text.

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  /** The href is kept verbatim; whether it becomes an anchor is the renderer's call. */
  | { type: "link"; href: string; children: Inline[] }
  /** Deliberately no source: images are never fetched, only named. */
  | { type: "image"; alt: string }
  | { type: "br" };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "blockquote"; children: Block[] }
  | { type: "hr" }
  | { type: "table"; header: Inline[][]; rows: Inline[][][] };

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

/* ---------- blocks ---------- */

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}> ?/;
/** Indent, marker, then the item's first line (a bare marker is an empty item). */
const LIST = /^( *)([-*+]|\d{1,9}[.)])(?: +(.*)| *)$/;
/** A table's delimiter row: `---|:--:|--:`, optionally fenced in pipes. */
const DELIM = /^ {0,3}\|?(?: *:?-+:? *\|)* *:?-+:? *\|? *$/;

const isBlank = (line: string) => line.trim() === "";
const indentOf = (line: string) => line.length - line.trimStart().length;
/** Capture `n` as a string; an optional group that did not match reads as "". */
const group = (m: RegExpExecArray, n: number) => m[n] ?? "";

/** A fence opener: its marker and info string, unless a backtick fence carries a backtick. */
function openFence(line: string): { marker: string; lang: string } | null {
  const m = FENCE.exec(line);
  if (!m || (group(m, 1).startsWith("`") && group(m, 2).includes("`"))) return null;
  return { marker: group(m, 1), lang: group(m, 2).trim().split(/\s+/)[0] ?? "" };
}

/** Would this line end a paragraph and start something else? Only a `1.` item may
 *  interrupt a paragraph: "2019. A fine year" stays prose, as in CommonMark. */
function startsBlock(line: string): boolean {
  if (openFence(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)) return true;
  const li = LIST.exec(line);
  return li !== null && /^(\D|1[.)])/.test(group(li, 2));
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  const at = (n: number) => lines[n] ?? "";
  let i = 0;
  while (i < lines.length) {
    const line = at(i);
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = openFence(line);
    if (fence) {
      // Verbatim until a closing run of the same char, at least as long; or the end.
      const body: string[] = [];
      for (i++; i < lines.length; i++) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(at(i));
        if (close && group(close, 1).startsWith(fence.marker)) break;
        body.push(at(i));
      }
      i++;
      out.push({ type: "code", lang: fence.lang, text: body.join("\n") });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = Math.min(group(h, 1).length, 4) as 1 | 2 | 3 | 4;
      const text = group(h, 2)
        .replace(/(^|[ \t])#+[ \t]*$/, "")
        .trim();
      out.push({ type: "heading", level, children: parseInlines(text) });
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push({ type: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      for (; i < lines.length && QUOTE.test(at(i)); i++) inner.push(at(i).replace(QUOTE, ""));
      out.push({ type: "blockquote", children: parseBlocks(inner) });
      continue;
    }

    if (LIST.test(line)) {
      const list = parseList(lines, i);
      out.push(list.block);
      i = list.next;
      continue;
    }

    if (line.includes("|") && at(i + 1).includes("|") && DELIM.test(at(i + 1))) {
      const header = splitRow(line);
      if (header.length === splitRow(at(i + 1)).length) {
        const rows: Inline[][][] = [];
        for (i += 2; i < lines.length && !isBlank(at(i)) && !startsBlock(at(i)); i++) {
          const cells = splitRow(at(i)).slice(0, header.length);
          while (cells.length < header.length) cells.push("");
          rows.push(cells.map((c) => parseInlines(c)));
        }
        out.push({ type: "table", header: header.map((c) => parseInlines(c)), rows });
        continue;
      }
    }

    // A paragraph: this line and every following one until a blank or a new block.
    // Leading space goes per line; trailing space only at the very end, since two
    // trailing spaces before a newline are a hard break.
    const para = [line.trimStart()];
    for (i++; i < lines.length && !isBlank(at(i)) && !startsBlock(at(i)); i++) para.push(at(i).trimStart());
    out.push({ type: "paragraph", children: parseInlines(para.join("\n").trimEnd()) });
  }
  return out;
}

/** A list from line `start`: items are sibling markers at (nearly) the same indent;
 *  lines indented two or more past the marker belong to the current item, so a nested
 *  list or a second paragraph is simply re-parsed from the item's own lines. */
function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = LIST.exec(lines[start] ?? "") as RegExpExecArray;
  const indent = group(first, 1).length;
  const ordered = /\d/.test(group(first, 2));
  const items: string[][] = [];
  let item: string[] = [];
  let contentIndent = 0;
  let prevBlank = false;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = LIST.exec(line);
    if (m && group(m, 1).length < indent + 2) {
      if (ordered !== /\d/.test(group(m, 2))) break; // a different kind of list
      item = [group(m, 3)];
      items.push(item);
      contentIndent = group(m, 1).length + group(m, 2).length + 1;
      prevBlank = false;
    } else if (isBlank(line)) {
      item.push("");
      prevBlank = true;
    } else if (indentOf(line) >= indent + 2) {
      item.push(line.slice(Math.min(indentOf(line), contentIndent)));
      prevBlank = false;
    } else if (!prevBlank && !startsBlock(line)) {
      item.push(line.trimStart()); // a wrapped line continues the item's paragraph
    } else break;
  }
  const startNo = ordered ? Number.parseInt(group(first, 2), 10) : 1;
  return { block: { type: "list", ordered, start: startNo, items: items.map(parseBlocks) }, next: i };
}

/** Pipe-table cells: the outer pipes are optional, `\|` is a literal pipe. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === "\\" && s.charAt(i + 1) === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/* ---------- inlines ---------- */

/** One inline construct recognised at a position: the node and where it ends. */
type Hit = { node: Inline; end: number } | null;

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|>~<]/;
const URL = /^https?:\/\/[^\s<>`]+/;

/** Inline parse of one run of text. `inLink` forbids links inside link text. */
function parseInlines(src: string, inLink = false): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  for (let i = 0; i < src.length; ) {
    const ch = src.charAt(i);
    if (ch === "\n") {
      // Every newline is a line break, as an agent means a reply's lines (GitHub's comments
      // read them so too); the two trailing spaces or the backslash of a hard break go.
      const hard = /( {2,}|\\)$/.exec(text);
      if (hard) text = text.slice(0, -group(hard, 1).length);
      flush();
      out.push({ type: "br" });
      i++;
      continue;
    }
    if (ch === "\\" && ESCAPABLE.test(src.charAt(i + 1))) {
      text += src.charAt(i + 1);
      i += 2;
      continue;
    }
    const hit =
      (ch === "`" && codeSpan(src, i)) ||
      (ch === "!" && src.charAt(i + 1) === "[" && image(src, i)) ||
      (ch === "[" && !inLink && link(src, i)) ||
      (ch === "h" && !inLink && autolink(src, i)) ||
      ((ch === "*" || ch === "_") && emphasis(src, i, inLink));
    if (hit) {
      flush();
      out.push(hit.node);
      i = hit.end;
    } else {
      text += ch;
      i++;
    }
  }
  flush();
  return out;
}

function runLength(src: string, i: number, c: string): number {
  let n = 0;
  while (src.charAt(i + n) === c) n++;
  return n;
}

/** For a backtick run at `i`, the index just past the matching run of the same length. */
function codeSpanEnd(src: string, i: number): number {
  const n = runLength(src, i, "`");
  for (let j = i + n; j < src.length; j++) {
    const m = runLength(src, j, "`");
    if (m === n) return j + m;
    j += Math.max(m - 1, 0);
  }
  return -1;
}

/** A code span: verbatim, newlines as spaces, one padding space stripped from each side. */
function codeSpan(src: string, i: number): Hit {
  const end = codeSpanEnd(src, i);
  if (end < 0) return null;
  const n = runLength(src, i, "`");
  let code = src.slice(i + n, end - n).replace(/\n/g, " ");
  if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
  return { node: { type: "code", text: code }, end };
}

/** `[text](dest)` or `[text](<dest> "title")` at `i`, the `[`. Brackets and parens nest. */
function bracket(src: string, i: number): { text: string; href: string; end: number } | null {
  let j = i;
  for (let depth = 0; j < src.length; j++) {
    const ch = src.charAt(j);
    if (ch === "\\") j++;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) break;
  }
  if (src.charAt(j + 1) !== "(") return null;
  let k = j + 2;
  for (let parens = 0; k < src.length; k++) {
    const ch = src.charAt(k);
    if (ch === "\\") k++;
    else if (ch === "(") parens++;
    else if (ch === ")" && parens-- === 0) break;
  }
  if (k >= src.length) return null;
  const dest = src.slice(j + 2, k).trim();
  const href =
    dest.startsWith("<") && dest.includes(">") ? dest.slice(1, dest.indexOf(">")) : (dest.split(/\s+/)[0] ?? "");
  return { text: src.slice(i + 1, j), href, end: k + 1 };
}

function image(src: string, i: number): Hit {
  const m = bracket(src, i + 1);
  return m && { node: { type: "image", alt: m.text }, end: m.end };
}

function link(src: string, i: number): Hit {
  const m = bracket(src, i);
  return m && { node: { type: "link", href: m.href, children: parseInlines(m.text, true) }, end: m.end };
}

/** A bare URL, not glued to a preceding word. It stops before trailing punctuation and
 *  before a closing bracket it did not open. */
function autolink(src: string, i: number): Hit {
  if (/[\w/]/.test(src.charAt(i - 1))) return null;
  const m = URL.exec(src.slice(i));
  if (!m) return null;
  let url = m[0];
  const count = (c: string) => url.split(c).length - 1;
  for (;;) {
    const last = url.charAt(url.length - 1);
    if (/[.,:;!?'"*_~]/.test(last)) url = url.slice(0, -1);
    else if (last === ")" && count("(") < count(")")) url = url.slice(0, -1);
    else if (last === "]" && count("[") < count("]")) url = url.slice(0, -1);
    else break;
  }
  return { node: { type: "link", href: url, children: [{ type: "text", text: url }] }, end: i + url.length };
}

/** `*em*`, `**strong**`, `***both***` and the `_` forms. A run opens when followed by a
 *  non-space and closes at the next run of the same length that follows a non-space;
 *  underscores do not open or close inside a word, so snake_case stays text. */
function emphasis(src: string, i: number, inLink: boolean): Hit {
  const c = src.charAt(i);
  const n = Math.min(runLength(src, i, c), 3);
  const after = src.charAt(i + n);
  if (!after || /\s/.test(after) || after === c) return null;
  if (c === "_" && /\w/.test(src.charAt(i - 1))) return null;
  const delim = c.repeat(n);
  let close = -1;
  for (let j = i + n; j < src.length && close < 0; j++) {
    const ch = src.charAt(j);
    if (ch === "\\") j++;
    else if (ch === "`") j = Math.max(j, codeSpanEnd(src, j) - 1);
    else if (
      src.startsWith(delim, j) &&
      src.charAt(j + n) !== c &&
      src.charAt(j - 1) !== c &&
      !/\s/.test(src.charAt(j - 1)) &&
      (c !== "_" || !/\w/.test(src.charAt(j + n)))
    )
      close = j;
  }
  if (close < 0) return null;
  const children = parseInlines(src.slice(i + n, close), inLink);
  const node: Inline =
    n === 1
      ? { type: "em", children }
      : n === 2
        ? { type: "strong", children }
        : { type: "strong", children: [{ type: "em", children }] };
  return { node, end: close + n };
}
