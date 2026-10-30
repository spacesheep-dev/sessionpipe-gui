// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { keyboardHeight, keyboardInsetWanted } from "./keyboardInset";

describe("keyboardHeight", () => {
  it("is the layout viewport's shortfall below the visual one", () => {
    expect(keyboardHeight({ height: 516, offsetTop: 0, scale: 1 }, 852)).toBe(336);
    // iOS scrolled the visual viewport down to show the field: the keyboard is what is
    // left under it, not the whole shortfall.
    expect(keyboardHeight({ height: 516, offsetTop: 40, scale: 1 }, 852)).toBe(296);
  });

  it("is 0 with no keyboard, under a toolbar's worth, past the end, or pinch-zoomed", () => {
    expect(keyboardHeight({ height: 852, offsetTop: 0, scale: 1 }, 852)).toBe(0);
    expect(keyboardHeight({ height: 840, offsetTop: 0, scale: 1 }, 852)).toBe(0);
    expect(keyboardHeight({ height: 860, offsetTop: 0, scale: 1 }, 852)).toBe(0);
    expect(keyboardHeight({ height: 400, offsetTop: 0, scale: 2 }, 852)).toBe(0);
  });
});

describe("keyboardInsetWanted", () => {
  it("follows the keyboard on iOS's shell and in a plain browser, never on Android or a desktop app", () => {
    expect(keyboardInsetWanted("ios", true)).toBe(true);
    expect(keyboardInsetWanted(undefined, true)).toBe(true);
    expect(keyboardInsetWanted("android", true)).toBe(false);
    expect(keyboardInsetWanted("macos", true)).toBe(false);
    expect(keyboardInsetWanted("ios", false)).toBe(false);
  });
});
