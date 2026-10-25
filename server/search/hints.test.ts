// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service.
import { describe, expect, it } from "vitest";
import { parseSearch } from "../../shared/searchQuery.js";
import { decideHint } from "./hints.js";

const hint = (
  q: string,
  o: { rerun?: (q: string) => boolean; firstRun?: boolean; suggestion?: { word: string; instead: string } } = {},
) => {
  let reruns = 0;
  const h = decideHint({
    q,
    parsed: parseSearch(q),
    firstRun: o.firstRun ?? false,
    suggestion: o.suggestion,
    rerun: (next) => {
      reruns++;
      return o.rerun ? o.rerun(next) : false;
    },
  });
  return { h, reruns };
};

describe("decideHint", () => {
  it("filters first", () => {
    expect(hint('"rate limiter" agent:codex since:7d').h).toEqual({ kind: "filters", query: '"rate limiter"' });
  });

  it("then a phrase", () => {
    expect(hint('"webhook 409" retry').h).toEqual({ kind: "phrase", query: "webhook 409 retry" });
  });

  it("then the spelling (P1)", () => {
    expect(hint("webhok retry", { suggestion: { word: "webhok", instead: "webhook" } }).h).toEqual({
      kind: "spelling",
      word: "webhook",
      query: "webhook retry",
    });
  });

  it("then an exclusion that alone empties it, with one rerun at most", () => {
    const r = hint("deploy -staging -prod", { rerun: (q) => q === "deploy -prod" });
    expect(r.h).toEqual({ kind: "exclude", word: "staging", query: "deploy -prod" });
    expect(r.reruns).toBe(1);
    const none = hint("deploy -staging");
    expect(none.h).toEqual({ kind: "none" });
    expect(none.reruns).toBe(1);
  });

  it("then indexing, else none", () => {
    expect(hint("anything", { firstRun: true }).h).toEqual({ kind: "indexing" });
    expect(hint("anything").h).toEqual({ kind: "none" });
    expect(hint("anything").reruns).toBe(0);
  });
});
