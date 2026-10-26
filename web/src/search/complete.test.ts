// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. Completion for the token under the caret: keys from a bare word,
// values with counts after the colon, and the query rewritten in place.
import type { SearchFacets } from "@shared/api";
import { describe, expect, it } from "vitest";
import { applyCompletion, completionAt } from "./complete";

const facets: SearchFacets = {
  agents: [
    { value: "claude-code", count: 22, label: "Claude Code" },
    { value: "codex", count: 13, label: "Codex" },
  ],
  machines: [{ value: "build-box", count: 4 }],
  repos: [{ value: "billing", count: 3 }],
  labels: [{ value: "red", count: 1, label: "Urgent" }],
};

describe("completionAt", () => {
  it("offers keys for a bare word that starts one, accepted with Tab only", () => {
    const c = completionAt("webhook ag", 10, facets)!;
    expect(c.kind).toBe("key");
    expect(c.options.map((o) => o.insert)).toEqual(["agent:"]);
    expect(completionAt("webhook a", 9, facets)).toBeNull(); // one letter waits
    expect(completionAt("in", 2, facets)).toBeNull(); // a whole key is no prefix of another
  });
  it("offers values with counts after the colon, the short agent word inserted", () => {
    const c = completionAt("webhook agent:", 14, facets)!;
    expect(c.kind).toBe("value");
    expect(c.options.map((o) => [o.insert, o.count])).toEqual([
      ["agent:claude", 22],
      ["agent:codex", 13],
    ]);
    expect(completionAt("agent:co", 8, facets)!.options.map((o) => o.insert)).toEqual(["agent:codex"]);
    expect(completionAt("-label:", 7, facets)!.options[0]!.insert).toBe("-label:red");
    expect(completionAt("since:", 6, facets)!.options.map((o) => o.insert)).toContain("since:7d");
  });
  it("is quiet when the caret is not at a token's end, or the value is already whole", () => {
    expect(completionAt("agent:codex rest", 3, facets)).toBeNull();
    expect(completionAt("agent:codex", 11, facets)).toBeNull();
  });
  it("rewrites the token in place with a trailing space after a value", () => {
    const q = "fix agent:co retry";
    const c = completionAt(q, 12, facets)!;
    expect(applyCompletion(q, c, c.options[0]!)).toEqual({ q: "fix agent:codex retry", caret: 16 });
    const k = completionAt("ma", 2, facets)!;
    expect(applyCompletion("ma", k, k.options[0]!)).toEqual({ q: "machine:", caret: 8 });
  });
});
