// SPDX-License-Identifier: Apache-2.0
// The palette's matcher: subsequence only, word starts and runs win, positions line up.
import { describe, expect, it } from "vitest";
import { fuzzy, fuzzyFields } from "../web/src/lib/fuzzy.js";

const hits = (q: string, t: string) =>
  fuzzy(q, t)
    ?.positions.map((i) => t[i])
    .join("");

describe("fuzzy", () => {
  it("matches a subsequence, case-insensitively, and nothing else", () => {
    expect(hits("wrs", "Webhook retry on bad signature")).toBe("Wrs");
    expect(fuzzy("xyz", "Webhook retry")).toBeNull();
    expect(fuzzy("", "anything")).toEqual({ score: 0, positions: [] });
    expect(fuzzy("longer than", "short")).toBeNull();
  });

  it("prefers word starts to letters inside a word", () => {
    const m = fuzzy("br", "Billing: refund sweep")!;
    expect(m.positions).toEqual([0, 9]);
    const inside = fuzzy("pay", "repayment")!;
    const start = fuzzy("pay", "payments")!;
    expect(start.score).toBeGreaterThan(inside.score);
  });

  it("prefers a run of adjacent letters to a scattered match", () => {
    expect(fuzzy("inv", "Invoice PDF export")!.score).toBeGreaterThan(fuzzy("inv", "I never voted")!.score);
  });

  it("sees camelCase and path steps as word starts", () => {
    expect(fuzzy("sc", "SessionCard")!.positions).toEqual([0, 7]);
    expect(fuzzy("ag", "acme/gateway")!.positions).toEqual([0, 5]);
  });
});

describe("fuzzyFields", () => {
  it("needs every word to fit some field, and keeps positions per field", () => {
    const m = fuzzyFields("webhook mac", ["Webhook retry", "macbook", "acme/api"])!;
    expect(m.positions[0]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(m.positions[1]).toEqual([0, 1, 2]);
    expect(m.positions[2]).toEqual([]);
    expect(fuzzyFields("webhook zzz", ["Webhook retry", "macbook"])).toBeNull();
  });

  // The palette lists the fields a row draws first (title, machine, repo), then the ones
  // it only draws on a hit (branch, model): the bold letters belong where they can be seen.
  it("puts a word on the title that holds it, not on a later field where it starts sooner", () => {
    const m = fuzzyFields("webhook", [
      "Second opinion on the webhook retry",
      "lab-mac",
      "acme/billing",
      "demo/webhook-backoff",
      "",
    ])!;
    expect(m.positions[0]).toEqual([22, 23, 24, 25, 26, 27, 28]);
    expect(m.positions[3]).toEqual([]);
    const end = fuzzyFields("backoff", [
      "Webhook retries with backoff",
      "demo-laptop",
      "acme/relay",
      "demo/webhook-backoff",
      "",
    ])!;
    expect(end.positions[0]).toEqual([21, 22, 23, 24, 25, 26, 27]);
    expect(end.positions[3]).toEqual([]);
  });

  it("still puts a word on the field it fits best: a whole word, not scattered letters", () => {
    expect(fuzzyFields("mac", ["Make a cache", "lab-mac"])!.positions).toEqual([[], [4, 5, 6]]);
    const m = fuzzyFields("webhook", ["We shook the hook", "", "", "demo/webhook-backoff", ""])!;
    expect(m.positions[0]).toEqual([]);
    expect(m.positions[3]).toEqual([5, 6, 7, 8, 9, 10, 11]);
  });

  it("scores the row by the field the word went to: where it starts there still counts between rows", () => {
    const fields = (title: string) => [title, "lab-mac", "acme/billing", "demo/webhook-backoff", ""];
    const early = fuzzyFields("webhook", fields("Webhook retry on bad signature"))!;
    const late = fuzzyFields("webhook", fields("Second opinion on the webhook retry"))!;
    expect(early.score).toBeGreaterThan(late.score);
    expect(late.score).toBeCloseTo(fuzzy("webhook", "Second opinion on the webhook retry")!.score);
  });
});
