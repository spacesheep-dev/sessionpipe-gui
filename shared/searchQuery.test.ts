// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  freeText,
  isBrowse,
  isEmptySearch,
  lexSearch,
  parseSearch,
  resolveSearchDate,
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
});
