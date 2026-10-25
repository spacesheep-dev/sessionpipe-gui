// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. Completion for the token under the caret (ux-search.md §3): the
// filter keys while a bare word could become one (`ag` → `agent:`), the values of a key
// once it has its colon (`agent:co` → `agent:codex`), with counts from the facets. Pure.
import type { SearchFacets, SearchFilterKey } from "@shared/api";
import { lexSearch, SEARCH_FILTER_KEYS } from "@shared/searchQuery";

export interface Completion {
  /** The query's range the choice replaces. */
  start: number;
  end: number;
  /** Values replace and are accepted with ⏎ too; keys only with Tab (⏎ opens a result). */
  kind: "key" | "value";
  key?: SearchFilterKey;
  options: CompletionOption[];
}
export interface CompletionOption {
  /** What goes into the field (a trailing space follows a value). */
  insert: string;
  label: string;
  hint?: string;
  count?: number;
  /** The value, for an option's glyph (an agent's harness, a label's colour). */
  value?: string;
}

const KEY_HINT: Record<SearchFilterKey, string> = {
  agent: "harness",
  machine: "machine name",
  repo: "repo or folder",
  label: "colour label",
  since: "on or after",
  until: "on or before",
  in: "prompt, reply, tool, title",
  source: "history or sessionpipe",
};

/** The short word a person types for a harness. */
const AGENT_SHORT: Record<string, string> = { "claude-code": "claude", "gemini-cli": "gemini" };

const DATES: { v: string; label: string }[] = [
  { v: "today", label: "today" },
  { v: "yesterday", label: "yesterday" },
  { v: "7d", label: "the past 7 days" },
  { v: "30d", label: "the past 30 days" },
  { v: "1y", label: "the past year" },
];

const quote = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

export function completionAt(q: string, caret: number, facets: SearchFacets | null, max = 8): Completion | null {
  const tok = lexSearch(q).find((t) => t.start <= caret && caret <= t.end);
  if (!tok || caret !== tok.end) return null;
  const neg = tok.not ? "-" : "";
  if (tok.kind === "filter" && tok.key) {
    const key = tok.key;
    const typed = tok.value.toLowerCase();
    const opts: CompletionOption[] = [];
    const push = (value: string, label: string, count?: number, hint?: string, insertAs?: string) => {
      const ins = insertAs ?? value;
      if (
        typed &&
        !ins.toLowerCase().startsWith(typed) &&
        !label.toLowerCase().startsWith(typed) &&
        !value.startsWith(typed)
      )
        return;
      opts.push({ insert: `${neg}${key}:${quote(ins)}`, label, count, hint, value });
    };
    if (key === "agent")
      for (const f of facets?.agents ?? [])
        push(f.value, f.label ?? f.value, f.count, undefined, AGENT_SHORT[f.value] ?? f.value);
    else if (key === "machine") {
      for (const f of facets?.machines ?? []) push(f.value, f.value, f.count);
    } else if (key === "repo") for (const f of facets?.repos ?? []) push(f.value, f.value, f.count);
    else if (key === "label") for (const f of facets?.labels ?? []) push(f.value, f.label ?? f.value, f.count);
    else if (key === "since" || key === "until") for (const d of DATES) push(d.v, d.v, undefined, d.label);
    else if (key === "in") for (const v of ["prompt", "reply", "tool", "title"]) push(v, v);
    else if (key === "source") {
      push("history", "history", undefined, "this machine's own logs");
      push("sessionpipe", "sessionpipe", undefined, "what sessionpipe delivered");
    }
    // A finished value needs no list.
    if (opts.length === 1 && opts[0]!.insert === q.slice(tok.start, tok.end)) return null;
    if (!opts.length) return null;
    return { start: tok.start, end: tok.end, kind: "value", key, options: opts.slice(0, max) };
  }
  if (tok.kind !== "word" || tok.unknownKey) return null;
  const w = tok.value.toLowerCase();
  if (w.length < 2) return null;
  const keys = SEARCH_FILTER_KEYS.filter((k) => k.startsWith(w) && k !== w);
  if (!keys.length) return null;
  return {
    start: tok.start,
    end: tok.end,
    kind: "key",
    options: keys.map((k) => ({ insert: `${neg}${k}:`, label: `${k}:`, hint: KEY_HINT[k] })),
  };
}

/** The query with `opt` in the completion's place, and where the caret goes. */
export function applyCompletion(q: string, c: Completion, opt: CompletionOption): { q: string; caret: number } {
  const tail = q.slice(c.end);
  const space = c.kind === "value" && !tail.startsWith(" ") ? " " : "";
  const next = `${q.slice(0, c.start)}${opt.insert}${space}${tail}`;
  return {
    q: next,
    caret: c.start + opt.insert.length + space.length + (c.kind === "value" && tail.startsWith(" ") ? 1 : 0),
  };
}
