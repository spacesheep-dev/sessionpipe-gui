// SPDX-License-Identifier: Apache-2.0
import "./test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIONS, IS_MAC, registerHandler } from "../lib/shortcuts";
import { installKeyFilter, MENU, menuOwns, runMenu } from "./menu";

const nav = vi.hoisted(() => ({ navigate: vi.fn(), back: vi.fn() }));
vi.mock("../lib/router", () => nav);

/** ⌘ on a Mac, ctrl elsewhere (lib/shortcuts.ts reads the platform, node's too). */
const MOD = IS_MAC ? { metaKey: true } : { ctrlKey: true };

const press = (init: KeyboardEventInit, trusted = true) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, "isTrusted", { value: trusted });
  return e;
};

afterEach(() => {
  nav.navigate.mockClear();
  nav.back.mockClear();
});

describe("menu actions", () => {
  it("every id in NATIVE-SPEC §3.10 has an action", () => {
    for (const id of [
      "settings",
      "new-session",
      "find",
      "go-board",
      "go-inbox",
      "go-feed",
      "go-review",
      "go-machines",
      "palette",
      "toggle-sidebar",
      "back",
      "forward",
      "shortcuts",
    ])
      expect(MENU[id], id).toBeDefined();
  });

  it("pages are routes", () => {
    const routes: Record<string, string> = {
      settings: "/settings",
      "go-board": "/",
      "go-inbox": "/inbox",
      "go-feed": "/feed",
      "go-review": "/review",
      "go-machines": "/machines",
    };
    for (const [id, to] of Object.entries(routes)) {
      expect(runMenu(id)).toBe(true);
      expect(nav.navigate).toHaveBeenLastCalledWith(to);
    }
    runMenu("back");
    expect(nav.back).toHaveBeenCalledTimes(1);
  });

  it("keyboard actions run through the dispatcher's own handler, once", () => {
    const window_ = globalThis as unknown as Window;
    const runs: string[] = [];
    // The dispatcher stand-in: it would run palette.toggle on mod+k.
    const offs = ["palette.toggle", "newSession.open", "search.focus", "help.toggle"].map((id) =>
      registerHandler(id, () => runs.push(id)),
    );
    const onKey = (e: KeyboardEvent) => {
      const a = ACTIONS.find((x) => x.id === "palette.toggle")!;
      if (e.key === "k" && (IS_MAC ? e.metaKey : e.ctrlKey) && a) runs.push(`key:${e.key}`);
    };
    window_.addEventListener("keydown", onKey as EventListener);
    try {
      expect(runMenu("palette")).toBe(true);
      // The synthetic press reached the page's listener exactly once.
      expect(runs).toEqual(["key:k"]);
    } finally {
      window_.removeEventListener("keydown", onKey as EventListener);
      for (const off of offs) off();
    }
  });

  it("an unknown id is ignored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(runMenu("format-disk")).toBe(false);
    expect(runMenu("__proto__")).toBe(false);
    warn.mockRestore();
  });
});

describe("the no-double-fire key filter", () => {
  it("knows the chords the menu owns", () => {
    expect(menuOwns(press({ key: "k", ...MOD }))).toBe(true);
    expect(menuOwns(press({ key: "n", ...MOD }))).toBe(true);
    expect(menuOwns(press({ key: ",", ...MOD }))).toBe(true);
    expect(menuOwns(press({ key: "[", ...MOD }))).toBe(true);
    // The pages: ⌃⌘1 on a Mac, Ctrl+Alt+1 elsewhere (where ⌃⌘ would be Ctrl+1).
    const PAGE = IS_MAC ? { ctrlKey: true, metaKey: true } : { ctrlKey: true, altKey: true };
    expect(menuOwns(press({ key: "1", code: "Digit1", ...PAGE }))).toBe(true);
    // The web's own keys stay the web's.
    expect(menuOwns(press({ key: "k" }))).toBe(false);
    expect(menuOwns(press({ key: "1", code: "Digit1", ...MOD }))).toBe(false);
    expect(menuOwns(press({ key: "z", ...MOD }))).toBe(false);
    // The menu's own action, replayed as a key, is never filtered.
    expect(menuOwns(press({ key: "k", ...MOD }, false))).toBe(false);
  });

  it("stops a menu chord before the page's handlers, without preventing it", () => {
    const target = new EventTarget();
    const off = installKeyFilter(target as unknown as Window);
    const seen: string[] = [];
    target.addEventListener("keydown", (e) => seen.push((e as KeyboardEvent).key));
    const owned = press({ key: "k", ...MOD });
    target.dispatchEvent(owned);
    expect(seen).toEqual([]);
    // Not prevented: the native menu still gets the key equivalent.
    expect(owned.defaultPrevented).toBe(false);
    target.dispatchEvent(press({ key: "j" }));
    target.dispatchEvent(press({ key: "k", ...MOD }, false));
    expect(seen).toEqual(["j", "k"]);
    off();
    target.dispatchEvent(press({ key: "k", ...MOD }));
    expect(seen).toEqual(["j", "k", "k"]);
  });
});
