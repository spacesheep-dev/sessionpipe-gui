// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { keyboardHeight, keyboardInsetWanted, showKeyboard } from "./keyboardInset";

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

describe("showKeyboard", () => {
  /** An <html> as far as the keyboard touches it: its style properties and attributes. */
  const root = () => {
    const props = new Map<string, string>();
    const attrs = new Map<string, string>();
    return {
      props,
      attrs,
      style: {
        setProperty: (k: string, v: string | null) => void props.set(k, v ?? ""),
        removeProperty: (k: string) => {
          const was = props.get(k) ?? "";
          props.delete(k);
          return was;
        },
      },
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
    };
  };

  it("puts data-kb on <html> with --kb while the keyboard is up, and takes both away with it", () => {
    const html = root();
    showKeyboard(html, 300);
    expect(html.props.get("--kb")).toBe("300px");
    expect(html.attrs.has("data-kb")).toBe(true);
    showKeyboard(html, 336);
    expect(html.props.get("--kb")).toBe("336px");
    expect(html.attrs.has("data-kb")).toBe(true);
    showKeyboard(html, 0);
    expect(html.props.has("--kb")).toBe(false);
    expect(html.attrs.has("data-kb")).toBe(false);
  });
});
