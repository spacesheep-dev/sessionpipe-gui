// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { type Matcher, snippet } from "./snippet.js";

const phrase = (a: string, b: string): Matcher => ({
  terms: new Map(),
  prefixes: [],
  phrases: [{ parts: [a, b], lastPrefix: false, bit: 1 }],
  needles: [a.length >= b.length ? a : b],
});

describe("snippet", () => {
  it("finds a phrase in a long message whose word also stands alone earlier", () => {
    const text = `alpha first. ${"filler words here ".repeat(150)}then alpha beta at last. ${"tail ".repeat(50)}`;
    expect(text.length).toBeGreaterThan(2000);
    const s = snippet(text, phrase("alpha", "beta"));
    expect(s.marks.length).toBe(1);
    const [a, b] = s.marks[0]!;
    expect(s.text.slice(a, b)).toBe("alpha beta");
  });

  it("still reads the region first when the needle is where the match is", () => {
    const text = `${"filler words here ".repeat(150)}then alpha beta at last.`;
    const s = snippet(text, phrase("alpha", "beta"));
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.marks.map(([a, b]) => s.text.slice(a, b))).toEqual(["alpha beta"]);
  });
});
