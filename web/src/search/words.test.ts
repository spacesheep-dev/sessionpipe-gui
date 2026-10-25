// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. The page's words: the result line, dates, a row's three facts.
import type { SessionMatch } from "@shared/api";
import { describe, expect, it } from "vitest";
import { metaFacts, resultLine, shortDate, spanCoarse, statusWords, tildeFold } from "./words";

const match = (o: Partial<SessionMatch>): SessionMatch => ({
  key: "codex:1",
  harness: "codex",
  id: "1",
  source: "sessionpipe",
  title: "t",
  thisMachine: false,
  firstAt: "2026-10-24T10:00:00Z",
  lastAt: "2026-10-24T10:28:00Z",
  hits: [],
  moreHits: 0,
  score: 1,
  ...o,
});

describe("words", () => {
  it("says the result line the UX copy says", () => {
    expect(resultLine(24, false, 6)).toBe("24 sessions · 6 ms");
    expect(resultLine(1, false, 6.24)).toBe("1 session · 6.2 ms");
    expect(resultLine(200, true, 9)).toBe("200+ sessions · 9 ms");
  });
  it("dates a row: a clock today, Yesterday, a day this year, a month before", () => {
    const now = new Date(2026, 9, 25, 15, 0).getTime();
    expect(shortDate(new Date(2026, 9, 25, 9, 5).toISOString(), now)).toBe("09:05");
    expect(shortDate(new Date(2026, 9, 24, 9, 5).toISOString(), now)).toBe("Yesterday");
    expect(shortDate(new Date(2026, 2, 3).toISOString(), now)).toMatch(/Mar 3|3 Mar/);
    expect(shortDate(new Date(2025, 2, 3).toISOString(), now)).toMatch(/2025/);
  });
  it("keeps at most three facts: where, what, how long (or the account)", () => {
    expect(metaFacts(match({ machine: "build-box", repo: "github.com/acme/billing" }))).toEqual([
      "build-box",
      "acme/billing",
      "28 m",
    ]);
    expect(metaFacts(match({ machine: "m", cwd: "/Users/demo/code/x", account: "work" }))).toEqual([
      "m",
      "~/code/x",
      "work",
    ]);
    expect(spanCoarse("2026-10-24T10:00:00Z", "2026-10-24T10:00:30Z")).toBe("");
    expect(tildeFold("/home/ana/src")).toBe("~/src");
  });
  it("words the index status", () => {
    const base = { sessions: 12431, messages: 1, bytes: 0, history: true, sources: [] };
    expect(statusWords({ ...base, state: "ready" })).toBe("12,431 sessions · up to date");
    expect(statusWords({ ...base, state: "updating" })).toBe("12,431 sessions · updating…");
    expect(statusWords({ ...base, state: "first-run", progress: 0.38 }, true)).toBe(
      "History still being read · 38 %, more may turn up",
    );
  });
});
