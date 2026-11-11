// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { cursorAfter, parseRelayPage } from "./spacesheep.js";

describe("the spacesheep relay source (docs/rfcs/08)", () => {
  it("reads a relay page and nothing that isn't one", () => {
    expect(parseRelayPage({ events: [{ a: 1 }], next: 7, oldest: 3, protocol: 1 })).toEqual({
      events: [{ a: 1 }],
      next: 7,
      oldest: 3,
      protocol: 1,
    });
    expect(parseRelayPage({ events: [], next: 0, oldest: null })).toEqual({
      events: [],
      next: 0,
      oldest: null,
      protocol: undefined,
    });
    expect(parseRelayPage({ next: 1 })).toBeNull();
    expect(parseRelayPage("x")).toBeNull();
  });
  it("moves the cursor to the page's end, and notes a gap when the relay no longer holds the cursor's past", () => {
    expect(cursorAfter(0, { events: [], next: 0, oldest: 40 })).toEqual({ cursor: 0, gap: false });
    expect(cursorAfter(10, { events: [{}], next: 12, oldest: 3 })).toEqual({ cursor: 12, gap: false });
    expect(cursorAfter(10, { events: [], next: 10, oldest: 40 })).toEqual({ cursor: 39, gap: true });
    expect(cursorAfter(10, { events: [], next: 10, oldest: 11 })).toEqual({ cursor: 10, gap: false });
  });
});
