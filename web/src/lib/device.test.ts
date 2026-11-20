// SPDX-License-Identifier: Apache-2.0
// The shell's platform as page code reads it (the <html> mark, else the flag), and the
// phone layout and the touch keys from their media queries: one list for each query, one
// listener on it, and every part of the page told of a change in that one call.
import "../native/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_QUERY,
  localReceiver,
  PANEL_COVERS_QUERY,
  PHONE_QUERY,
  phoneShell,
  reachName,
  SELECT_SHEET_QUERY,
  shellPlatform,
  TOUCH_QUERY,
} from "./device";

const g = globalThis as Record<string, unknown>;
const html = document.documentElement as unknown as { dataset: Record<string, string | undefined> };

/** The module as a page that has just loaded has it: nothing asked of the browser yet. */
const fresh = () => import("./device");

/** A browser's matchMedia, as the stricter engine has it (WebKit): a list says what its
 *  query said when it was made, until the browser next works its lists out, and it tells
 *  its own listeners of a change from what it last said, never of none. `set` is the
 *  window changing (a list made from now on says the new answer, one already kept does
 *  not yet); `turn` is that and the browser working its lists out. */
function fakeMedia(now: Record<string, boolean> = {}) {
  const asked: string[] = [];
  const kept = new Map<string, { matches: boolean; heard: Set<() => void> }[]>();
  g.matchMedia = (q: string) => {
    asked.push(q);
    const heard = new Set<() => void>();
    const list = {
      matches: now[q] ?? false,
      heard,
      addEventListener: (_type: string, l: () => void) => void heard.add(l),
      removeEventListener: (_type: string, l: () => void) => void heard.delete(l),
    };
    kept.set(q, [...(kept.get(q) ?? []), list]);
    return list;
  };
  return {
    asked,
    /** The query's "change" listeners, as the browser holds them, on whichever list. */
    listeners: (q: string) => (kept.get(q) ?? []).flatMap((list) => [...list.heard]),
    set: (q: string, v: boolean) => {
      now[q] = v;
    },
    turn: (q: string, v: boolean) => {
      now[q] = v;
      for (const list of kept.get(q) ?? []) {
        if (list.matches === v) continue;
        list.matches = v;
        for (const l of [...list.heard]) l();
      }
    },
  };
}

beforeEach(() => vi.resetModules());
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
  it("is false without matchMedia, else what the phone query says", async () => {
    const { phoneLayout, wideLayout } = await fresh();
    expect(phoneLayout()).toBe(false);
    const media = fakeMedia({ [PHONE_QUERY]: true });
    expect(phoneLayout()).toBe(true);
    expect(media.asked).toEqual([PHONE_QUERY]);
    expect(wideLayout()).toBe(false);
  });

  it("keeps one list for a query, with one listener, and asks the browser no more once a part listens", async () => {
    const { phoneLayout, wideLayout, onPhoneLayout, touchKeys } = await fresh();
    const media = fakeMedia();
    onPhoneLayout(() => {});
    onPhoneLayout(() => {});
    phoneLayout();
    wideLayout();
    phoneLayout();
    expect(media.asked).toEqual([PHONE_QUERY]);
    expect(media.listeners(PHONE_QUERY)).toHaveLength(1);
    // Another query is another list, with its own one listener.
    touchKeys();
    expect(media.asked).toEqual([PHONE_QUERY, TOUCH_QUERY]);
    expect(media.listeners(TOUCH_QUERY)).toHaveLength(1);
  });

  it("tells every subscriber from the one listener, in one call, the new layout already in place", async () => {
    const { phoneLayout, onPhoneLayout } = await fresh();
    const media = fakeMedia();
    const told: string[] = [];
    onPhoneLayout(() => told.push(`bar:${phoneLayout()}`));
    onPhoneLayout(() => told.push(`page:${phoneLayout()}`));
    expect(media.listeners(PHONE_QUERY)).toHaveLength(1);
    // The browser's one call: a window narrowed across the width.
    media.turn(PHONE_QUERY, true);
    expect(told).toEqual(["bar:true", "page:true"]);
  });

  it("turns when the browser says so, for all at once: nobody reads the new width early", async () => {
    const { phoneLayout, wideLayout, onPhoneLayout } = await fresh();
    const media = fakeMedia({ [PHONE_QUERY]: true });
    let told = 0;
    onPhoneLayout(() => told++);
    // Resized, and the "change" not yet sent (a render on the resize event): a list made
    // now would say wide already, and a part that asked it would be alone in that.
    media.set(PHONE_QUERY, false);
    expect(phoneLayout()).toBe(true);
    expect(wideLayout()).toBe(false);
    media.turn(PHONE_QUERY, false);
    expect(told).toBe(1);
    expect(phoneLayout()).toBe(false);
    expect(wideLayout()).toBe(true);
  });

  it("while nobody listens, asks afresh: a width still settling as the files load is not kept", async () => {
    const { phoneLayout, onPhoneLayout } = await fresh();
    // A phone's window before its viewport is applied: 980 px wide, so not the phone's.
    const media = fakeMedia({ [PHONE_QUERY]: false });
    expect(phoneLayout()).toBe(false);
    // The viewport applied, the "change" not sent yet, and the first render asks.
    media.set(PHONE_QUERY, true);
    expect(phoneLayout()).toBe(true);
    // The parts listen from there, to the list that gave that answer: when the browser
    // works its lists out, it has no news for them.
    let told = 0;
    onPhoneLayout(() => told++);
    media.turn(PHONE_QUERY, true);
    expect(phoneLayout()).toBe(true);
    expect(media.listeners(PHONE_QUERY)).toHaveLength(1);
    expect(told).toBe(0);
  });

  it("is told when a width asked afresh went back before the browser had worked its lists out", async () => {
    const { phoneLayout, onPhoneLayout } = await fresh();
    const media = fakeMedia({ [PHONE_QUERY]: false });
    expect(phoneLayout()).toBe(false);
    // Narrow for a moment, and asked in that moment.
    media.set(PHONE_QUERY, true);
    expect(phoneLayout()).toBe(true);
    let told = 0;
    onPhoneLayout(() => told++);
    // Wide again. The first list never said narrow, so it has no change to tell; the
    // list that said it is the one listened to.
    media.turn(PHONE_QUERY, false);
    expect(told).toBe(1);
    expect(phoneLayout()).toBe(false);
    expect(media.listeners(PHONE_QUERY)).toHaveLength(1);
  });

  it("stops telling a subscriber that has left", async () => {
    const { onPhoneLayout } = await fresh();
    const media = fakeMedia();
    let stays = 0;
    let leaves = 0;
    onPhoneLayout(() => stays++);
    const off = onPhoneLayout(() => leaves++);
    media.turn(PHONE_QUERY, true);
    off();
    media.turn(PHONE_QUERY, false);
    expect([stays, leaves]).toEqual([2, 1]);
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

  it("are what the page's code is told: wideLayout is phoneLayout's opposite", async () => {
    const { phoneLayout, wideLayout } = await fresh();
    windowOf(760, "fine");
    expect([phoneLayout(), wideLayout()]).toEqual([false, true]);
    windowOf(760, "coarse");
    expect([phoneLayout(), wideLayout()]).toEqual([true, false]);
    windowOf(700, "fine");
    expect([phoneLayout(), wideLayout()]).toEqual([true, false]);
  });
});

describe("panelCovers", () => {
  it("is the desktop layout under 840 px with a mouse: no room for a session beside its page", async () => {
    for (const width of [700, 719, 720, 760, 839, 840, 1440])
      for (const pointer of POINTERS) {
        const narrowDesktop = pointer === "fine" && [720, 760, 839].includes(width);
        expect(`${width} ${pointer}: ${matches(PANEL_COVERS_QUERY, width, pointer)}`).toBe(
          `${width} ${pointer}: ${narrowDesktop}`,
        );
      }
    const { panelCovers } = await fresh();
    expect(panelCovers()).toBe(false);
    windowOf(760, "fine");
    expect(panelCovers()).toBe(true);
    windowOf(840, "fine");
    expect(panelCovers()).toBe(false);
    windowOf(760, "coarse");
    expect(panelCovers()).toBe(false);
  });
});

describe("the Select's sheet", () => {
  it("has its own width, narrower than the phone layout's, unchanged", () => {
    expect(SELECT_SHEET_QUERY).toBe("(max-width: 599px)");
  });
});

describe("touchKeys", () => {
  it("is the main pointer, never the width: a narrow desktop window keeps Return to send", async () => {
    const { phoneLayout, touchKeys } = await fresh();
    expect(touchKeys()).toBe(false);
    const media = fakeMedia({ [PHONE_QUERY]: true });
    expect(phoneLayout()).toBe(true);
    expect(touchKeys()).toBe(false);
    media.turn(TOUCH_QUERY, true);
    expect(touchKeys()).toBe(true);
  });
});
