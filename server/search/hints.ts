// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service. What the no-result state offers (SEARCH-SPEC §3.3, UX §9.3):
// the first fix that applies, in this order — drop the filters, read the phrase as words,
// the near spelling (P1), drop the one exclusion that empties everything (one rerun at
// most), say history is still being read, or nothing.
import type { ParsedSearch, SearchHint } from "../../shared/api.js";
import { lexSearch, withoutExclusion, withoutFilters, withoutQuotes } from "../../shared/searchQuery.js";
import { hasFilters } from "./filters.js";

export interface HintInput {
  /** The query as typed. */
  q: string;
  parsed: ParsedSearch;
  /** The engine's near word for an unknown one (P1). */
  suggestion?: { word: string; instead: string };
  /** Runs the query again with `q` instead and says whether anything matched. Called at most once. */
  rerun: (q: string) => boolean;
  /** The first pass over history has not committed yet. */
  firstRun: boolean;
}

/** `word` replaced by `instead` where it was typed (the spelling hint's query). */
function replaceWord(q: string, word: string, instead: string): string {
  const w = word.toLowerCase();
  for (const t of lexSearch(q)) {
    if (t.kind !== "filter" && !t.not && t.value.toLowerCase() === w) {
      const raw = q.slice(t.start, t.end);
      const at = raw.toLowerCase().indexOf(w);
      if (at < 0) continue;
      return q.slice(0, t.start) + raw.slice(0, at) + instead + raw.slice(at + word.length) + q.slice(t.end);
    }
  }
  return q;
}

export function decideHint(h: HintInput): SearchHint {
  const { q, parsed } = h;
  if (hasFilters(parsed)) return { kind: "filters", query: withoutFilters(q) };
  if (parsed.clauses.some((c) => c.kind === "phrase" && !c.not)) return { kind: "phrase", query: withoutQuotes(q) };
  if (h.suggestion) {
    return {
      kind: "spelling",
      word: h.suggestion.instead,
      query: replaceWord(q, h.suggestion.word, h.suggestion.instead),
    };
  }
  const positive = parsed.clauses.some((c) => !c.not);
  const exclusion = parsed.clauses.find((c) => c.not);
  if (positive && exclusion) {
    const next = withoutExclusion(q, exclusion.text);
    if (next !== q.trim() && h.rerun(next)) return { kind: "exclude", word: exclusion.text, query: next };
  }
  if (h.firstRun) return { kind: "indexing" };
  return { kind: "none" };
}
