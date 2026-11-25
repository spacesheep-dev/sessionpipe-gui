// SPDX-License-Identifier: Apache-2.0
// The part of a line that gives way first leaves whole once it would be a stub, never
// while it is whole or keeps a few characters.
import { describe, expect, it } from "vitest";
import { GIVE_WAY_EM, leavesLine } from "./giveWay";

describe("leavesLine", () => {
  it("leaves only when cut to under a few characters' room: 39 px of the line's 13 px", () => {
    // About four characters: "acme…" keeps its words, "acm…" leaves.
    expect(GIVE_WAY_EM).toBe(3);
    expect(leavesLine({ cut: true, width: 12, fontPx: 13 })).toBe(true);
    expect(leavesLine({ cut: true, width: 38.5, fontPx: 13 })).toBe(true);
    expect(leavesLine({ cut: true, width: 39, fontPx: 13 })).toBe(false);
    expect(leavesLine({ cut: true, width: 90, fontPx: 13 })).toBe(false);
    // In ems: the same four characters at another size.
    expect(leavesLine({ cut: true, width: 47.5, fontPx: 16 })).toBe(true);
    expect(leavesLine({ cut: true, width: 48, fontPx: 16 })).toBe(false);
  });
  it("stays when it is whole, however short", () => {
    expect(leavesLine({ cut: false, width: 12, fontPx: 13 })).toBe(false);
    expect(leavesLine({ cut: false, width: 0, fontPx: 13 })).toBe(false);
  });
});
