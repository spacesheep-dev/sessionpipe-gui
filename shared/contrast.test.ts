// SPDX-License-Identifier: Apache-2.0
// A skin's warnings name the focus ring when it falls under 3:1 on the page or the card,
// in the same short form as the text tiers.
import { describe, expect, it } from "vitest";
import { textTierWarnings } from "./contrast.js";

describe("the focus ring's floor", () => {
  it("a pale --focus warns on both grounds, in the text tiers' form", () => {
    expect(textTierWarnings({ "--focus": "#e8e8e6" }, "light")).toEqual([
      "--focus on --bg 1.2:1, needs 3",
      "--focus on --bg-2 1.2:1, needs 3",
    ]);
  });

  it("a page the stock ring cannot be seen on warns too; one it can does not", () => {
    expect(textTierWarnings({ "--bg": "#d8d8d4", "--bg-2": "#d8d8d4" }, "dark")).toContain(
      "--focus on --bg 1.3:1, needs 3",
    );
    expect(textTierWarnings({ "--focus": "#5c5c5a" }, "light")).toEqual([]);
    expect(textTierWarnings({ "--focus": "#f5f5f3" }, "dark")).toEqual([]);
  });

  it("a ring the parser cannot read is left unmeasured", () => {
    expect(textTierWarnings({ "--focus": "color-mix(in oklch, var(--fg) 20%, transparent)" }, "light")).toEqual([]);
  });
});
