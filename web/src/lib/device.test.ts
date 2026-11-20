// SPDX-License-Identifier: Apache-2.0
// The shell's platform as page code reads it (the <html> mark, else the flag), and the
// phone layout and the touch keys from their media queries: one list for each query, one
// listener on it, and every part of the page told of a change in that one call. And what
// the system keeps at the window's sides, as the stylesheets' own words come to; and the
// touch app's size class, from the window, as <html> and every part have it.
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
  safeSides,
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
/** Every width from 300 to 1300 in steps of 10, and the pixel either side of each place a
 *  layout changes. */
const WIDTHS = [
  ...Array.from({ length: 101 }, (_, i) => 300 + i * 10),
  ...[719, 720, 721, 839, 840, 841, 599, 600],
].sort((a, b) => a - b);
/** Where a window with a mouse takes the desktop layout, and one with no pointer. */
const MOUSE_FROM = 720;
const NO_POINTER_FROM = 840;
/** The combined layout rule, said plainly: the touch app for a touch-first screen at any
 *  width, for a window with a mouse under 720 px and for no pointer under 840. */
const touchApp = (width: number, pointer: Pointer): boolean =>
  pointer === "coarse" || (pointer === "fine" ? width < MOUSE_FROM : width < NO_POINTER_FROM);

describe("the two layouts", () => {
  it("are exact opposites, and each window has the one the rule names: a touch screen the touch app at any width", () => {
    const wrong: string[] = [];
    for (const width of WIDTHS)
      for (const pointer of POINTERS) {
        const phone = matches(PHONE_QUERY, width, pointer);
        const desktop = matches(DESKTOP_QUERY, width, pointer);
        if (phone === desktop || phone !== touchApp(width, pointer))
          wrong.push(`${width} ${pointer}: phone ${phone}, desktop ${desktop}`);
      }
    expect(wrong).toEqual([]);
  });

  it("keep a window with a mouse a desktop down to 720 px, and one with no pointer to 840", () => {
    const phone = (width: number, pointer: Pointer) => matches(PHONE_QUERY, width, pointer);
    expect([700, 719, 720, 760, 839, 840].map((w) => phone(w, "fine"))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect([700, 719, 720, 760, 839, 840].map((w) => phone(w, "none"))).toEqual([true, true, true, true, true, false]);
    // A phone, a tablet on its side, an opened phone turned: the touch app all the way.
    expect([320, 393, 669, 820, 951, 1180, 1366, 2560].map((w) => phone(w, "coarse"))).toEqual(Array(8).fill(true));
  });

  it("are what the page's code is told: wideLayout is phoneLayout's opposite, at every width and pointer", async () => {
    const wrong: string[] = [];
    for (const width of WIDTHS)
      for (const pointer of POINTERS) {
        const { phoneLayout, wideLayout } = await fresh();
        windowOf(width, pointer);
        const told = [phoneLayout(), wideLayout()];
        if (told[0] === told[1] || told[0] !== touchApp(width, pointer)) wrong.push(`${width} ${pointer}: ${told}`);
        vi.resetModules();
      }
    expect(wrong).toEqual([]);
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

describe("safeSides", () => {
  const doc = document as unknown as Record<string, unknown>;
  afterEach(() => {
    delete doc.body;
    delete doc.createElement;
    delete g.getComputedStyle;
  });

  /** A page whose engine works the probe's padding out as `padding`; the probes it was
   *  asked for, each with whether it is still in the page. */
  function fakePage(padding: { paddingLeft: string; paddingRight: string }) {
    const probes: { style: { cssText: string }; inPage: boolean; remove(): void }[] = [];
    doc.createElement = () => {
      const probe = {
        style: { cssText: "" },
        inPage: false,
        remove() {
          probe.inPage = false;
        },
      };
      probes.push(probe);
      return probe;
    };
    doc.body = {
      append(probe: { inPage: boolean }) {
        probe.inPage = true;
      },
    };
    g.getComputedStyle = () => padding;
    return probes;
  }

  it("is nothing at either side where there is no page to ask", () => {
    expect(safeSides()).toEqual({ left: 0, right: 0 });
  });

  it("is what the stylesheets' own words come to, and leaves nothing in the page", () => {
    const probes = fakePage({ paddingLeft: "84px", paddingRight: "0px" });
    expect(safeSides()).toEqual({ left: 84, right: 0 });
    expect(probes).toHaveLength(1);
    // A shell's --safe-* first, else the engine's env(), as every stylesheet has it.
    expect(probes[0]!.style.cssText).toContain("var(--safe-left, env(safe-area-inset-left))");
    expect(probes[0]!.style.cssText).toContain("var(--safe-right, env(safe-area-inset-right))");
    expect(probes[0]!.inPage).toBe(false);
  });

  it("is 0 for a side the engine has no length for", () => {
    fakePage({ paddingLeft: "", paddingRight: "44.5px" });
    expect(safeSides()).toEqual({ left: 0, right: 44.5 });
  });
});

describe("sizeClass", () => {
  const set = (width: number, height: number) => Object.assign(g, { innerWidth: width, innerHeight: height });
  const doc = document as unknown as { activeElement: unknown };
  const resize = (width: number, height: number) => {
    set(width, height);
    dispatchEvent(new Event("resize"));
  };
  /** followSizeClass, stopped after the test: a module of an earlier test hears no resize. */
  let stop = () => {};
  afterEach(() => {
    stop();
    stop = () => {};
    delete g.innerWidth;
    delete g.innerHeight;
    delete html.dataset.sizeClass;
    doc.activeElement = null;
  });
  const sizes = (list: string) => list.split(" ").map((s) => s.split("x").map(Number) as [number, number]);
  const follow = async () => {
    const m = await fresh();
    const followSizeClass = () => {
      stop = m.followSizeClass();
    };
    return { ...m, followSizeClass };
  };

  it("is regular from 600 wide and 560 high on a touch screen, and compact under either", async () => {
    const { sizeClass } = await fresh();
    fakeMedia({ [TOUCH_QUERY]: true, [PHONE_QUERY]: true });
    // The inner display upright and turned (and the first estimate of it), iPads, an
    // Android tablet.
    for (const [w, h] of sizes("669x951 951x669 626x890 890x626 820x1180 1180x820 744x1133 1280x800")) {
      set(w, h);
      expect(sizeClass(), `${w}x${h}`).toBe("regular");
    }
    // The outer display both ways, Split View, iPhones, an Android phone on its side.
    for (const [w, h] of sizes("466x678 678x466 470x669 445x626 393x852 320x568 915x412")) {
      set(w, h);
      expect(sizeClass(), `${w}x${h}`).toBe("compact");
    }
  });

  it("is none in a window with a mouse, at any size", async () => {
    const { sizeClass } = await fresh();
    fakeMedia({ [PHONE_QUERY]: true });
    for (const [w, h] of sizes("1280x800 669x951 393x852 466x678")) {
      set(w, h);
      expect(sizeClass(), `${w}x${h}`).toBeNull();
    }
  });

  it("is on <html> before any part is told, and each part is told once, in one call", async () => {
    const { followSizeClass, sizeClass, onSizeClass } = await follow();
    const media = fakeMedia({ [TOUCH_QUERY]: true, [PHONE_QUERY]: true });
    set(466, 678);
    followSizeClass();
    expect(html.dataset.sizeClass).toBe("compact");
    const told: string[] = [];
    onSizeClass(() => told.push(`sidebar:${sizeClass()}:${html.dataset.sizeClass}`));
    onSizeClass(() => told.push(`page:${sizeClass()}:${html.dataset.sizeClass}`));
    // Unfolded: the mark is there in the resize itself, before either is told.
    resize(669, 951);
    expect(told).toEqual(["sidebar:regular:regular", "page:regular:regular"]);
    // A turn that keeps the class tells nobody.
    resize(951, 669);
    expect(told).toHaveLength(2);
    // A mouse takes over: no size class, and no mark.
    media.turn(TOUCH_QUERY, false);
    expect(sizeClass()).toBeNull();
    expect(html.dataset.sizeClass).toBeUndefined();
    expect(told.slice(2)).toEqual(["sidebar:null:undefined", "page:null:undefined"]);
  });

  it("keeps the height it had while Android's keyboard is up, and reads it again once the field is left", async () => {
    const { followSizeClass, sizeClass } = await follow();
    fakeMedia({ [TOUCH_QUERY]: true, [PHONE_QUERY]: true });
    set(1280, 800);
    followSizeClass();
    expect(sizeClass()).toBe("regular");
    // A field takes the focus and the shell makes the view shorter for the keys.
    doc.activeElement = { tagName: "TEXTAREA" };
    resize(1280, 450);
    expect(sizeClass()).toBe("regular");
    expect(html.dataset.sizeClass).toBe("regular");
    // The keys go, and come back.
    resize(1280, 800);
    resize(1280, 450);
    expect(sizeClass()).toBe("regular");
    // A change of width is always read: a turn with the keys up.
    resize(800, 450);
    expect(sizeClass()).toBe("compact");
    resize(1280, 800);
    expect(sizeClass()).toBe("regular");
    // With no field in hand, a shorter window is a shorter window.
    doc.activeElement = null;
    resize(1280, 450);
    expect(sizeClass()).toBe("compact");
    expect(html.dataset.sizeClass).toBe("compact");
  });

  it("reads the window again when the app comes back, for a fold made while it was away", async () => {
    const { followSizeClass, sizeClass } = await follow();
    fakeMedia({ [TOUCH_QUERY]: true, [PHONE_QUERY]: true });
    set(669, 951);
    followSizeClass();
    expect(html.dataset.sizeClass).toBe("regular");
    // Folded in the background: no resize reaches the page.
    set(466, 678);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sizeClass()).toBe("compact");
    expect(html.dataset.sizeClass).toBe("compact");
    // Opened again, and the page shown from the back-forward cache.
    set(669, 951);
    dispatchEvent(new Event("pageshow"));
    expect(html.dataset.sizeClass).toBe("regular");
  });

  it("takes a checkbox in hand for no keyboard", async () => {
    const { followSizeClass, sizeClass } = await follow();
    fakeMedia({ [TOUCH_QUERY]: true, [PHONE_QUERY]: true });
    set(1280, 800);
    followSizeClass();
    doc.activeElement = { tagName: "INPUT", type: "checkbox" };
    resize(1280, 450);
    expect(sizeClass()).toBe("compact");
  });
});
