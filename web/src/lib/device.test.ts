// SPDX-License-Identifier: Apache-2.0
// The shell's platform as page code reads it (the <html> mark, else the flag), and the
// phone layout and the touch keys from their media queries.
import "../native/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_QUERY,
  localReceiver,
  PANEL_COVERS_QUERY,
  PHONE_QUERY,
  panelCovers,
  phoneLayout,
  phoneShell,
  reachName,
  shellPlatform,
  TOUCH_QUERY,
  touchKeys,
  wideLayout,
} from "./device";

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

describe("reachName", () => {
  const here = { id: "rx1", name: "This Mac", origin: "http://127.0.0.1:7373", local: true };

  it("names this Mac's own receiver, and this computer's off a Mac", () => {
    g.sessionpipeShell = { v: 1, platform: "macos", receiver: here };
    expect(reachName()).toBe("sessionpipe on this Mac");
    expect(localReceiver()).toBe(true);
    html.dataset.shell = "windows";
    expect(reachName()).toBe("sessionpipe on this computer");
    html.dataset.shell = "linux";
    expect(reachName()).toBe("sessionpipe on this computer");
    expect(localReceiver()).toBe(true);
  });

  it("names another computer by its name", () => {
    g.sessionpipeShell = { v: 1, platform: "macos", receiver: { ...here, name: "studio-mac", local: false } };
    expect(reachName()).toBe("studio-mac");
    expect(localReceiver()).toBe(false);
    g.sessionpipeShell = { v: 1, platform: "ios", receiver: { ...here, name: "studio-mac", local: false } };
    expect(reachName()).toBe("studio-mac");
  });

  it("names spacesheep for an account", () => {
    g.sessionpipeShell = {
      v: 1,
      platform: "ios",
      receiver: { ...here, name: "me@example.com", local: false, kind: "spacesheep" },
    };
    expect(reachName()).toBe("spacesheep");
    expect(localReceiver()).toBe(false);
  });

  it("is sessionpipe in a browser, and before a window has a receiver", () => {
    expect(reachName()).toBe("sessionpipe");
    expect(localReceiver()).toBe(false);
    g.sessionpipeShell = { v: 1, platform: "macos", receiver: null };
    expect(reachName()).toBe("sessionpipe");
    expect(localReceiver()).toBe(false);
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

type Pointer = "fine" | "coarse" | "none";
/** What a browser answers for the queries this file's module writes: clauses joined by
 *  commas, each a run of `(max-width: Npx)`, `(min-width: Npx)` and `(pointer: …)` joined
 *  by `and`. Anything else is not a query of ours, and throws. */
function matches(query: string, width: number, pointer: Pointer): boolean {
  return query.split(",").some((clause) =>
    clause
      .trim()
      .split(/\s+and\s+/)
      .every((feature) => {
        const m = /^\((max-width|min-width|pointer): (\d+px|fine|coarse|none)\)$/.exec(feature);
        if (!m) throw new Error(`not read: ${feature}`);
        if (m[1] === "pointer") return m[2] === pointer;
        const px = Number.parseInt(m[2]!, 10);
        return m[1] === "max-width" ? width <= px : width >= px;
      }),
  );
}
const POINTERS: Pointer[] = ["fine", "coarse", "none"];
/** The page in a window this wide, with this for its main pointer. */
const windowOf = (width: number, pointer: Pointer) => {
  g.matchMedia = (q: string) => ({
    matches: matches(q, width, pointer),
    addEventListener() {},
    removeEventListener() {},
  });
};

describe("the two layouts", () => {
  it("are exact opposites: every window has one of them, whatever its pointer", () => {
    for (const width of [320, 700, 719, 720, 760, 839, 840, 1440])
      for (const pointer of POINTERS)
        expect(`${width} ${pointer}: ${matches(PHONE_QUERY, width, pointer)}`).toBe(
          `${width} ${pointer}: ${!matches(DESKTOP_QUERY, width, pointer)}`,
        );
  });

  it("keep a window with a mouse a desktop down to 720 px, where it was 840", () => {
    const phone = (width: number, pointer: Pointer) => matches(PHONE_QUERY, width, pointer);
    expect([700, 719, 720, 760, 839, 840].map((w) => phone(w, "fine"))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    // A touch screen, and one with no pointer at all, change where they always did: a
    // phone and a tablet held upright keep the phone's layout.
    for (const pointer of ["coarse", "none"] as const)
      expect([700, 719, 720, 760, 839, 840].map((w) => phone(w, pointer))).toEqual([
        true,
        true,
        true,
        true,
        true,
        false,
      ]);
  });

  it("are what the page's code is told: wideLayout is phoneLayout's opposite", () => {
    windowOf(760, "fine");
    expect([phoneLayout(), wideLayout()]).toEqual([false, true]);
    windowOf(760, "coarse");
    expect([phoneLayout(), wideLayout()]).toEqual([true, false]);
    windowOf(700, "fine");
    expect([phoneLayout(), wideLayout()]).toEqual([true, false]);
  });
});

describe("panelCovers", () => {
  it("is the desktop layout under 840 px: no room for a session beside its page", () => {
    for (const width of [700, 719, 720, 760, 839, 840, 1440])
      for (const pointer of POINTERS) {
        const narrowDesktop = pointer === "fine" && [720, 760, 839].includes(width);
        expect(`${width} ${pointer}: ${matches(PANEL_COVERS_QUERY, width, pointer)}`).toBe(
          `${width} ${pointer}: ${narrowDesktop}`,
        );
      }
    expect(panelCovers()).toBe(false);
    windowOf(760, "fine");
    expect(panelCovers()).toBe(true);
    windowOf(840, "fine");
    expect(panelCovers()).toBe(false);
    windowOf(760, "coarse");
    expect(panelCovers()).toBe(false);
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
