// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. Marked text: the server's marks kept exactly, inline Markdown read as
// text (code spans without ticks, emphasis without stars), a cut window's stray tick gone.
import { describe, expect, it } from "vitest";
import { pieces } from "./Marked";

const flat = (text: string, marks: [number, number][] = []) =>
  pieces(text, marks)
    .map((p) => `${p.mark ? "[" : ""}${p.code ? "`" : ""}${p.text}${p.code ? "`" : ""}${p.mark ? "]" : ""}`)
    .join("");

describe("pieces", () => {
  it("keeps marks where the server put them", () => {
    expect(flat("retry the webhook", [[10, 17]])).toBe("retry the [webhook]");
    expect(flat("a b", [])).toBe("a b");
  });
  it("reads a code span as code without its ticks, even when a mark splits it", () => {
    expect(flat("calls `retryWithBackoff` now", [[11, 16]])).toBe("calls `retr`[`yWith`]`Backoff` now");
  });
  it("drops emphasis stars and an unpaired tick, keeps snake_case and lone stars", () => {
    expect(flat("looks at *why* it failed")).toBe("looks at why it failed");
    expect(flat("a **bold** move")).toBe("a bold move");
    expect(flat("…cheduleRetry` backs off")).toBe("…cheduleRetry backs off");
    expect(flat("snake_case_name and 2 * 3")).toBe("snake_case_name and 2 * 3");
  });
  it("marks [redacted] placeholders and never throws on odd input", () => {
    expect(pieces("key [redacted] here").some((p) => p.redacted)).toBe(true);
    expect(() =>
      pieces("``` `` ` **", [
        [0, 99],
        [5, 2],
      ]),
    ).not.toThrow();
  });
});
