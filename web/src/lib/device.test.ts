// SPDX-License-Identifier: Apache-2.0
// The shell's platform as page code reads it (the <html> mark, else the flag), and the
// phone layout and the touch keys from their media queries.
import "../native/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { PHONE_QUERY, phoneLayout, phoneShell, shellPlatform, TOUCH_QUERY, touchKeys } from "./device";

const g = globalThis as Record<string, unknown>;
const html = document.documentElement as unknown as { dataset: Record<string, string | undefined> };

afterEach(() => {
  delete g.sessionpipeShell;
  delete g.matchMedia;
  delete html.dataset.shell;
});

describe("shellPlatform", () => {
  it("is null in a browser", () => {
    expect(shellPlatform()).toBeNull();
    expect(phoneShell()).toBe(false);
  });

  it("reads the mark shell.ts puts on <html>, and the flag before the mark is there", () => {
    g.sessionpipeShell = { v: 1, platform: "ios" };
    expect(shellPlatform()).toBe("ios");
    expect(phoneShell()).toBe(true);
    html.dataset.shell = "android";
    expect(shellPlatform()).toBe("android");
    expect(phoneShell()).toBe(true);
    html.dataset.shell = "macos";
    expect(phoneShell()).toBe(false);
  });

  it("takes no platform it doesn't know", () => {
    g.sessionpipeShell = { v: 1, platform: "watchos" };
    expect(shellPlatform()).toBeNull();
    html.dataset.shell = "";
    expect(shellPlatform()).toBeNull();
  });
});

describe("phoneLayout", () => {
  it("is false without matchMedia, else what the phone query says", () => {
    expect(phoneLayout()).toBe(false);
    const asked: string[] = [];
    g.matchMedia = (q: string) => {
      asked.push(q);
      return { matches: q === PHONE_QUERY, addEventListener() {}, removeEventListener() {} };
    };
    expect(phoneLayout()).toBe(true);
    expect(asked).toEqual([PHONE_QUERY]);
  });
});

describe("touchKeys", () => {
  it("is the main pointer, never the width: a narrow desktop window keeps Return to send", () => {
    expect(touchKeys()).toBe(false);
    let coarse = false;
    g.matchMedia = (q: string) => ({
      matches: q === PHONE_QUERY || (q === TOUCH_QUERY && coarse),
      addEventListener() {},
      removeEventListener() {},
    });
    expect(phoneLayout()).toBe(true);
    expect(touchKeys()).toBe(false);
    coarse = true;
    expect(touchKeys()).toBe(true);
  });
});
