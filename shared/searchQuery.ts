// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service (by agreement with the search lead; SEARCH-SPEC.md §4).
// The one query language of session search: the Search page, ⌘K, the CLI and the API all
// read a query string with `parseSearch`, and the page's chips edit it with `setFilter`, so
// the URL, the chips and the terminal command always agree. Pure, no dependencies, safe in
// the web bundle. Forgiving: every input parses, nothing throws.
//
//   webhook retry        every word (session-level AND)
//   "rate limiter"       a phrase; an unclosed quote runs to the end
//   -staging -"dry run"  sessions without it
//   migrat*              a prefix (at least 2 characters before the *)
//   key:value key:"a b"  a filter: agent machine repo label since until in source
//   -label:red           a negated filter
import type { ParsedSearch, SearchClause, SearchFilterKey } from "./api.js";

export const SEARCH_FILTER_KEYS: readonly SearchFilterKey[] = [
  "agent",
  "machine",
  "repo",
  "label",
  "since",
  "until",
  "in",
  "source",
];

/** Other spellings of a key. */
const KEY_ALIASES: Readonly<Record<string, SearchFilterKey>> = {
  harness: "agent",
  is: "source",
  after: "since",
  before: "until",
};

/** What a person types for an agent → the receiver's harness name. */
export const AGENT_ALIASES: Readonly<Record<string, string>> = {
  claude: "claude-code",
  "claude-code": "claude-code",
  cc: "claude-code",
  codex: "codex",
  antigravity: "antigravity",
  agy: "antigravity",
  gemini: "gemini-cli",
  "gemini-cli": "gemini-cli",
  cursor: "cursor",
};

/** `in:` values. */
export const SEARCH_IN_VALUES = ["prompt", "reply", "tool", "title"] as const;
/** `source:` values (`is:` too), with their aliases. */
const SOURCE_ALIASES: Readonly<Record<string, "history" | "sessionpipe">> = {
  history: "history",
  local: "history",
  sessionpipe: "sessionpipe",
  received: "sessionpipe",
};

/** One token of the query string, with where it sits (for editing it in place). */
export interface SearchToken {
  start: number;
  end: number;
  not: boolean;
  /** A filter's key (resolved alias), an unknown `key:`, or absent for text. */
  key?: SearchFilterKey;
  unknownKey?: string;
  kind: "word" | "phrase" | "prefix" | "filter";
  /** Without quotes, `-`, `*` or `key:`. */
  value: string;
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "　";
const KEY_RE = /^([A-Za-z][A-Za-z-]*):/;

/** Splits a query into tokens. `"…"` may hold spaces; so may `key:"…"`. */
export function lexSearch(q: string): SearchToken[] {
  const out: SearchToken[] = [];
  let i = 0;
  const n = q.length;
  while (i < n) {
    while (i < n && isSpace(q[i]!)) i++;
    if (i >= n) break;
    const start = i;
    let not = false;
    if (q[i] === "-" && i + 1 < n && !isSpace(q[i + 1]!)) {
      not = true;
      i++;
    }
    if (q[i] === '"') {
      const close = q.indexOf('"', i + 1);
      const end = close < 0 ? n : close + 1;
      const value = q.slice(i + 1, close < 0 ? n : close).trim();
      if (value) out.push({ start, end, not, kind: "phrase", value });
      i = end;
      continue;
    }
    // A bare run up to the next space, except that `key:"…"` takes its quoted value.
    const km = KEY_RE.exec(q.slice(i, Math.min(n, i + 24)));
    if (km) {
      const raw = km[1]!.toLowerCase();
      const key = (SEARCH_FILTER_KEYS as readonly string[]).includes(raw) ? (raw as SearchFilterKey) : KEY_ALIASES[raw];
      let j = i + km[0].length;
      let value: string;
      if (q[j] === '"') {
        const close = q.indexOf('"', j + 1);
        value = q.slice(j + 1, close < 0 ? n : close).trim();
        j = close < 0 ? n : close + 1;
      } else {
        const s = j;
        while (j < n && !isSpace(q[j]!)) j++;
        value = q.slice(s, j);
      }
      if (key) out.push({ start, end: j, not, key, kind: "filter", value });
      else {
        // Not a filter: searched as text (the engine splits `foo:bar` into a phrase).
        const text = q.slice(i, j).replace(/"/g, " ").trim();
        if (text) out.push({ start, end: j, not, unknownKey: raw, kind: "word", value: text });
      }
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !isSpace(q[j]!) && q[j] !== '"') j++;
    let value = q.slice(i, j);
    let kind: SearchToken["kind"] = "word";
    if (value.endsWith("*")) {
      value = value.replace(/\*+$/, "");
      kind = "prefix";
    }
    if (value) out.push({ start, end: j, not, kind, value });
    i = j === i ? i + 1 : j;
  }
  return out;
}

const cpLen = (s: string): number => {
  let k = 0;
  for (const _ of s) k++;
  return k;
};

/** Reads a query. `live`: the person is typing, so a last bare word with no space after it
 *  is a prefix (it has at least 2 characters; a 1-character last word waits). */
export function parseSearch(q: string, opts: { live?: boolean } = {}): ParsedSearch {
  const toks = lexSearch(q);
  const clauses: SearchClause[] = [];
  const filters: ParsedSearch["filters"] = {};
  const notFilters: ParsedSearch["notFilters"] = {};
  const unknown: string[] = [];
  const endsOpen = q.length > 0 && !isSpace(q[q.length - 1]!);
  toks.forEach((t, idx) => {
    const last = idx === toks.length - 1;
    if (t.kind === "filter") {
      const v = normalizeFilterValue(t.key!, t.value);
      if (!v) return;
      const into = t.not ? notFilters : filters;
      const list = into[t.key!] ?? [];
      list.push(v);
      into[t.key!] = list;
      return;
    }
    if (t.unknownKey && !unknown.includes(t.unknownKey)) unknown.push(t.unknownKey);
    if (t.kind === "prefix") {
      if (cpLen(t.value) >= 2) clauses.push({ kind: "prefix", text: t.value, not: t.not });
      else if (t.value) clauses.push({ kind: "word", text: t.value, not: t.not });
      return;
    }
    if (t.kind === "phrase") {
      clauses.push({ kind: "phrase", text: t.value, not: t.not });
      return;
    }
    if (opts.live && last && endsOpen && !t.not && !t.unknownKey) {
      if (cpLen(t.value) >= 2) clauses.push({ kind: "prefix", text: t.value, not: false, live: true });
      return;
    }
    clauses.push({ kind: "word", text: t.value, not: t.not });
  });
  return { clauses, filters, notFilters, unknown };
}

/** A filter value as the engine and the service compare it; "" drops the token. */
export function normalizeFilterValue(key: SearchFilterKey, raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  switch (key) {
    case "agent":
      return AGENT_ALIASES[v.toLowerCase()] ?? v.toLowerCase();
    case "in": {
      const l = v.toLowerCase();
      const map: Record<string, string> = { user: "prompt", ask: "prompt", assistant: "reply", answer: "reply" };
      return map[l] ?? l;
    }
    case "source":
      return SOURCE_ALIASES[v.toLowerCase()] ?? v.toLowerCase();
    case "label":
    case "repo":
    case "machine":
      return v.toLowerCase();
    default:
      return v;
  }
}

/** True when the query has nothing to search or filter by (the page's idle state). */
export function isEmptySearch(p: ParsedSearch): boolean {
  return p.clauses.length === 0 && Object.keys(p.filters).length === 0 && Object.keys(p.notFilters).length === 0;
}

/** True when the query only filters (it browses: newest first, the first prompt shown). */
export function isBrowse(p: ParsedSearch): boolean {
  return !p.clauses.some((c) => !c.not) && !isEmptySearch(p);
}

const quoteValue = (v: string): string => (/[\s"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

/** Replaces every positive `key:` token with `key:value` (appended at the end), or removes
 *  them when `value` is null. Negated tokens of that key are left alone. */
export function setFilter(q: string, key: SearchFilterKey, value: string | null): string {
  const toks = lexSearch(q).filter((t) => t.kind === "filter" && t.key === key && !t.not);
  let out = cut(q, toks);
  if (value !== null && value !== "") out = `${out}${out && !out.endsWith(" ") ? " " : ""}${key}:${quoteValue(value)}`;
  return out;
}

/** The query without any filter (the "Search without filters" hint). */
export function withoutFilters(q: string): string {
  return cut(
    q,
    lexSearch(q).filter((t) => t.kind === "filter"),
  );
}

/** The query with its phrases read as words (the "Search the words" hint). */
export function withoutQuotes(q: string): string {
  return q.replace(/"/g, " ").replace(/\s+/g, " ").trim();
}

/** The query without the excluded word or phrase `word` (the "Search without -x" hint). */
export function withoutExclusion(q: string, word: string): string {
  const w = word.toLowerCase();
  return cut(
    q,
    lexSearch(q).filter((t) => t.not && t.kind !== "filter" && t.value.toLowerCase() === w),
  );
}

/** The free text a find bar starts with: the positive clauses, filters dropped. */
export function freeText(p: ParsedSearch): string {
  return p.clauses
    .filter((c) => !c.not)
    .map((c) => (c.kind === "phrase" ? `"${c.text}"` : c.text))
    .join(" ");
}

/** The first positive value of a filter, as the chips show it. */
export function filterValue(p: ParsedSearch, key: SearchFilterKey): string | undefined {
  return p.filters[key]?.[0];
}

function cut(q: string, toks: SearchToken[]): string {
  if (!toks.length) return q.trim();
  let out = "";
  let at = 0;
  for (const t of [...toks].sort((a, b) => a.start - b.start)) {
    out += q.slice(at, t.start);
    at = t.end;
  }
  out += q.slice(at);
  return out.replace(/\s+/g, " ").trim();
}

const DAY = 86_400_000;
const UNIT_MS: Readonly<Record<string, number>> = { h: 3_600_000, d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY };

/** A `since:` / `until:` value → epoch ms, or undefined when it does not read as a date.
 *  `edge` "start" gives the first instant of a day, "end" the last (so `until:2026-10-20`
 *  includes that day). `tz` is `getTimezoneOffset()` of the viewer (UTC minus local, in
 *  minutes); dates are that viewer's local days. Relative values (`7d`, `12h`, `2w`, `3m`,
 *  `1y`) count back from `now`. */
export function resolveSearchDate(
  value: string,
  edge: "start" | "end",
  now: number = Date.now(),
  tz = 0,
): number | undefined {
  const v = value.trim().toLowerCase();
  const rel = /^(\d{1,4})([hdwmy])$/.exec(v);
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2]!]!;
  const offset = -tz * 60_000; // local = UTC + offset
  const localMidnight = (t: number): number => Math.floor((t + offset) / DAY) * DAY - offset;
  if (v === "today") return edge === "start" ? localMidnight(now) : localMidnight(now) + DAY - 1;
  if (v === "yesterday") return edge === "start" ? localMidnight(now) - DAY : localMidnight(now) - 1;
  const d = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(v);
  if (d) {
    const y = Number(d[1]);
    const m = Number(d[2]) - 1;
    if (m < 0 || m > 11) return undefined;
    if (d[3] === undefined) {
      const start = Date.UTC(y, m, 1) - offset;
      return edge === "start" ? start : Date.UTC(y, m + 1, 1) - offset - 1;
    }
    const day = Number(d[3]);
    if (day < 1 || day > 31) return undefined;
    const start = Date.UTC(y, m, day) - offset;
    return edge === "start" ? start : start + DAY - 1;
  }
  return undefined;
}
