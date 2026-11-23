// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { SearchFilterKey } from "./api.js";
import {
  freeText,
  isBrowse,
  isEmptySearch,
  lexSearch,
  parseSearch,
  resolveSearchDate,
  searchQueryNote,
  setFilter,
  withoutExclusion,
  withoutFilters,
  withoutQuotes,
} from "./searchQuery.js";

describe("parseSearch", () => {
  it("reads words, phrases, exclusions and prefixes", () => {
    const p = parseSearch('webhook "rate limiter" -staging -"dry run" migrat*');
    expect(p.clauses).toEqual([
      { kind: "word", text: "webhook", not: false },
      { kind: "phrase", text: "rate limiter", not: false },
      { kind: "word", text: "staging", not: true },
      { kind: "phrase", text: "dry run", not: true },
      { kind: "prefix", text: "migrat", not: false },
    ]);
  });

  it("reads filters, aliases and negated filters", () => {
    const p = parseSearch('agent:claude machine:"build box" is:history before:2026-10-20 -label:red in:assistant');
    expect(p.filters).toEqual({
      agent: ["claude-code"],
      machine: ["build box"],
      source: ["history"],
      until: ["2026-10-20"],
      in: ["reply"],
    });
    expect(p.notFilters).toEqual({ label: ["red"] });
    expect(p.clauses).toEqual([]);
    expect(isBrowse(p)).toBe(true);
  });

  it("searches an unknown key as text and says so", () => {
    const p = parseSearch("foo:bar baz");
    expect(p.unknown).toEqual(["foo"]);
    expect(p.clauses.map((c) => c.text)).toEqual(["foo:bar", "baz"]);
  });

  it("does not call a pasted Windows path or URL an unknown filter", () => {
    for (const q of [
      "C:\\Users\\dev\\x.ts",
      "C:/repo/a.ts",
      "D:\\x",
      "-C:\\x",
      "https://example.com/x",
      "file:///tmp/a",
    ]) {
      const p = parseSearch(q);
      expect(p.unknown, q).toEqual([]);
      // Still searched as text, exactly as before.
      expect(p.clauses, q).toEqual([{ kind: "word", text: q.replace(/^-/, ""), not: q.startsWith("-") }]);
    }
    expect(parseSearch("C:\\x", { live: true }).clauses).toEqual([{ kind: "word", text: "C:\\x", not: false }]);
    // Something that still looks like a filter is still reported.
    expect(parseSearch("x:y e: D:\\x").unknown).toEqual(["x", "e"]);
    expect(parseSearch('c:"\\x"').unknown).toEqual(["c"]);
    expect(parseSearch("cwd:/x path:\\\\srv\\a").unknown).toEqual(["cwd", "path"]);
  });

  it("makes the last word a live prefix only while typing", () => {
    expect(parseSearch("webhook ret", { live: true }).clauses.at(-1)).toEqual({
      kind: "prefix",
      text: "ret",
      not: false,
      live: true,
    });
    expect(parseSearch("webhook ret ", { live: true }).clauses.at(-1)?.kind).toBe("word");
    expect(parseSearch("webhook ret").clauses.at(-1)?.kind).toBe("word");
    // A 1-character last word waits.
    expect(parseSearch("webhook r", { live: true }).clauses).toHaveLength(1);
  });

  it("never throws on garbage", () => {
    for (const q of ['"', "-", '-"', "***", "a:", ":", '"unclosed phrase', "agent:", '  -  " ', "\u0000￿"])
      expect(() => parseSearch(q, { live: true })).not.toThrow();
    expect(parseSearch('"unclosed phrase').clauses).toEqual([{ kind: "phrase", text: "unclosed phrase", not: false }]);
    expect(isEmptySearch(parseSearch("agent:"))).toBe(true);
  });

  it("keeps token spans for editing", () => {
    const toks = lexSearch('a "b c" agent:codex');
    expect(toks.map((t) => [t.start, t.end, t.kind])).toEqual([
      [0, 1, "word"],
      [2, 7, "phrase"],
      [8, 19, "filter"],
    ]);
  });
});

describe("editing a query", () => {
  it("sets, replaces and removes a filter", () => {
    expect(setFilter("webhook", "agent", "codex")).toBe("webhook agent:codex");
    expect(setFilter("webhook agent:claude 409", "agent", "codex")).toBe("webhook 409 agent:codex");
    expect(setFilter("webhook agent:claude", "agent", null)).toBe("webhook");
    expect(setFilter("x", "machine", "build box")).toBe('x machine:"build box"');
    expect(setFilter("x -agent:codex", "agent", null)).toBe("x -agent:codex");
  });

  it("closes a phrase left open before adding a filter, so the filter is not searched as text", () => {
    const at = (q: string) => setFilter(q, "agent", "codex");
    for (const [q, want] of [
      ['"rate limiter', '"rate limiter" agent:codex'],
      ['"rate limiter ', '"rate limiter" agent:codex'],
      ['x -"dry run', 'x -"dry run" agent:codex'],
      ['repo:"my repo', 'repo:"my repo" agent:codex'],
      ['foo:"bar', 'foo:"bar" agent:codex'],
      ['x "', 'x "" agent:codex'],
      ['"rate limiter agent:claude', '"rate limiter agent:claude" agent:codex'],
    ]) {
      expect(at(q!)).toBe(want);
      expect(parseSearch(at(q!)).filters.agent).toEqual(["codex"]);
    }
    expect(parseSearch(at('"rate limiter')).clauses).toEqual([{ kind: "phrase", text: "rate limiter", not: false }]);
    // The open quote was the filter being replaced: it goes, and nothing is closed.
    expect(setFilter('x repo:"my re', "repo", "foo")).toBe("x repo:foo");
    // A closed phrase and a removal are left as they are; typing still reads to the end.
    expect(at('"rate limiter" x')).toBe('"rate limiter" x agent:codex');
    expect(setFilter('"rate limiter', "agent", null)).toBe('"rate limiter');
    expect(parseSearch('"rate limiter agent:codex', { live: true }).filters).toEqual({});
  });

  it("builds the no-result hints' queries", () => {
    expect(withoutFilters("webhook agent:codex since:7d 409")).toBe("webhook 409");
    expect(withoutQuotes('"webhook 409" retry')).toBe("webhook 409 retry");
    expect(withoutExclusion("deploy -staging", "staging")).toBe("deploy");
    expect(freeText(parseSearch('webhook "rate limit" -x agent:codex'))).toBe('webhook "rate limit"');
  });
});

describe("resolveSearchDate", () => {
  const now = Date.UTC(2026, 9, 25, 15, 0); // 22:00 at UTC+7
  const tz = -420;
  it("reads relative values", () => {
    expect(resolveSearchDate("7d", "start", now, tz)).toBe(now - 7 * 86_400_000);
    expect(resolveSearchDate("12h", "start", now, tz)).toBe(now - 12 * 3_600_000);
  });
  it("reads local days", () => {
    const midnight = Date.UTC(2026, 9, 24, 17, 0); // Oct 25 00:00 at UTC+7
    expect(resolveSearchDate("today", "start", now, tz)).toBe(midnight);
    expect(resolveSearchDate("yesterday", "start", now, tz)).toBe(midnight - 86_400_000);
    expect(resolveSearchDate("2026-10-25", "start", now, tz)).toBe(midnight);
    expect(resolveSearchDate("2026-10-25", "end", now, tz)).toBe(midnight + 86_400_000 - 1);
  });
  it("refuses what is not a date", () => {
    expect(resolveSearchDate("soon", "start", now, tz)).toBeUndefined();
    expect(resolveSearchDate("2026-13-01", "start", now, tz)).toBeUndefined();
  });
  it("refuses a day the month does not have, rather than rolling into the next month", () => {
    for (const v of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-11-31", "2100-02-29"])
      for (const edge of ["start", "end"] as const) expect(resolveSearchDate(v, edge, now, tz)).toBeUndefined();
    const feb29 = Date.UTC(2028, 1, 28, 17, 0); // 2028-02-29 00:00 at UTC+7
    expect(resolveSearchDate("2028-02-29", "start", now, tz)).toBe(feb29);
    expect(resolveSearchDate("2028-02-29", "end", now, tz)).toBe(feb29 + 86_400_000 - 1);
    expect(resolveSearchDate("2000-02-29", "start", now, tz)).toBe(Date.UTC(2000, 1, 28, 17, 0));
    expect(resolveSearchDate("2026-11-30", "end", now, tz)).toBe(Date.UTC(2026, 10, 30, 17, 0) - 1);
    expect(resolveSearchDate("2026-12-31", "start", now, tz)).toBe(Date.UTC(2026, 11, 30, 17, 0));
  });
});

describe("searchQueryNote", () => {
  it("names a filter value that does not read, then a key that is not a filter", () => {
    expect(searchQueryNote({ unknown: ["since"], bad: [{ key: "since", value: "2026-2-1" }] })).toBe(
      "“since:2026-2-1” isn't a date, so it was left out. Dates: 7d, 12h, today, yesterday, 2026-10, 2026-10-01",
    );
    expect(searchQueryNote({ unknown: ["foo", "since"], bad: [{ key: "since", value: "2026-2-1" }] })).toBe(
      "“since:2026-2-1” isn't a date, so it was left out. Dates: 7d, 12h, today, yesterday, 2026-10, 2026-10-01. " +
        "“foo:” isn't a filter, so it was searched as text. Filters: agent machine repo label since until in source",
    );
    expect(searchQueryNote({ unknown: ["until"], bad: [{ key: "until", value: "3days" }] })).toMatch(
      /^“until:3days” isn't a date, so it was left out\./,
    );
    expect(searchQueryNote({ unknown: ["in"], bad: [{ key: "in", value: "everything" }] })).toBe(
      "“in:everything” isn't a field, so it was left out. in: prompt reply tool title",
    );
    expect(searchQueryNote({ unknown: ["source"], bad: [{ key: "source", value: "mars" }] })).toBe(
      "“source:mars” isn't an index, so it was left out. source: history sessionpipe",
    );
  });

  it("calls only a real unknown key an unknown filter, and says nothing when there is neither", () => {
    expect(searchQueryNote({ unknown: ["foo"] })).toBe(
      "“foo:” isn't a filter, so it was searched as text. Filters: agent machine repo label since until in source",
    );
    expect(searchQueryNote({ unknown: [] })).toBeUndefined();
    expect(searchQueryNote({ unknown: [], bad: [] })).toBeUndefined();
    expect(searchQueryNote({ unknown: ["label"], bad: [{ key: "label", value: "x" }] })).toBe(
      "“label:x” didn't read, so it was left out",
    );
  });

  it("puts a full stop between the two notes, never a doubled one", () => {
    const foo =
      "“foo:” isn't a filter, so it was searched as text. Filters: agent machine repo label since until in source";
    const both = (key: SearchFilterKey, value: string) =>
      searchQueryNote({ unknown: ["foo", key], bad: [{ key, value }] });
    expect(both("in", "everything")).toBe(
      `“in:everything” isn't a field, so it was left out. in: prompt reply tool title. ${foo}`,
    );
    expect(both("source", "mars")).toBe(
      `“source:mars” isn't an index, so it was left out. source: history sessionpipe. ${foo}`,
    );
    expect(both("until", "3days")).toBe(
      `“until:3days” isn't a date, so it was left out. Dates: 7d, 12h, today, yesterday, 2026-10, 2026-10-01. ${foo}`,
    );
    expect(both("label", "x")).toBe(`“label:x” didn't read, so it was left out. ${foo}`);
    for (const key of ["in", "source", "since", "until", "label"] as const) expect(both(key, "x")).not.toContain("..");
  });
});
