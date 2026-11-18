// SPDX-License-Identifier: Apache-2.0
import "./test-env";
import { readFileSync } from "node:fs";
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
  vi.unstubAllGlobals();
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

/** lib/shortcuts.ts and ./menu as that computer loads them: the platform is read once, as
 *  the module loads, so each is loaded again under the navigator of a Mac or of Windows. */
async function loadedOn(platform: "MacIntel" | "Win32" | "Linux x86_64") {
  vi.resetModules();
  vi.stubGlobal("navigator", { platform });
  return { ...(await import("../lib/shortcuts")), ...(await import("./menu")) };
}

/** menu.rs's accelerators by action id, as it compiles them on a Mac or off one, in
 *  lib/shortcuts.ts spelling (CmdOrCtrl is mod). */
function shellKeys(mac: boolean): Map<string, string> {
  const rs = readFileSync(new URL("../../../apps/desktop/src-tauri/src/menu.rs", import.meta.url), "utf8");
  // The arm of a `#[cfg(target_os = "macos")]` / `#[cfg(not(…))]` pair this platform compiles.
  const arm = (re: RegExp): string => {
    const found = [...rs.matchAll(re)].find((m) => !m[1] === mac);
    if (!found?.[2]) throw new Error(`menu.rs: no ${mac ? "Mac" : "non-Mac"} arm for ${re}`);
    return found[2];
  };
  const cfg = /#\[cfg\((not\()?target_os = "macos"\)?\)\]\s*/.source;
  const page = arm(new RegExp(`${cfg}macro_rules! page \\{[^"]*concat!\\("([^"]+)"`, "g"));
  const sidebar = arm(new RegExp(`${cfg}const SIDEBAR: &str = "([^"]+)";`, "g"));
  const out = new Map<string, string>();
  for (const m of rs.matchAll(/\("([a-z-]+)", "[^"]+", Some\((?:"([^"]+)"|page!\("(\w)"\)|(SIDEBAR))\)\)/g)) {
    const accelerator = m[2] ?? (m[3] ? page + m[3] : sidebar);
    out.set(m[1] as string, accelerator.replace("CmdOrCtrl", "mod").toLowerCase());
  }
  return out;
}

describe.each([
  ["a Mac", "MacIntel"],
  ["Windows and Linux", "Win32"],
] as const)("on %s", (_name, platform) => {
  const mac = platform === "MacIntel";

  it("no menu key is a default binding", async () => {
    const { ACTIONS, PRESETS, MENU, chordString, parseBinding } = await loadedOn(platform);
    const chords = (keys: string) => (parseBinding(keys) ?? []).map(chordString);
    // Each chord the menu owns, and the one action that may have it: the item's own.
    const owned = new Map<string, string | undefined>();
    for (const m of Object.values(MENU)) for (const c of chords(m.keys ?? "")) owned.set(c, m.fires);
    const bound = [
      ...ACTIONS.map((a) => [a.id, a.keys] as const),
      ...Object.values(PRESETS).flatMap((p) => Object.entries(p.bindings)),
    ];
    const taken = bound.flatMap(([id, keys]) =>
      keys.filter((k) => chords(k).some((c) => owned.has(c) && owned.get(c) !== id)).map((k) => `${id}: ${k}`),
    );
    expect(taken).toEqual([]);
  });

  it("the page's keys are menu.rs's", async () => {
    const { MENU, canonical } = await loadedOn(platform);
    const shell = shellKeys(mac);
    // Every item with a key, and its key, as the shell's menu has it on this platform.
    for (const [id, item] of Object.entries(MENU))
      expect(canonical(shell.get(id) ?? ""), id).toBe(canonical(item.keys ?? ""));
    expect(shell.size).toBeGreaterThanOrEqual(Object.keys(MENU).length);
  });

  it("the pages' and the sidebar's keys are the menu's; a label's key is the page's", async () => {
    const { menuOwns, chordOf, chordString } = await loadedOn(platform);
    const read = (init: KeyboardEventInit) => chordString(chordOf(press(init))!);
    if (mac) {
      expect(menuOwns(press({ key: "1", code: "Digit1", ctrlKey: true, metaKey: true }))).toBe(true);
      expect(menuOwns(press({ key: "s", code: "KeyS", ctrlKey: true, metaKey: true }))).toBe(true);
      // ⌥⌘1 is Label red, and ⌘B is nobody's.
      expect(menuOwns(press({ key: "¡", code: "Digit1", altKey: true, metaKey: true }))).toBe(false);
      expect(menuOwns(press({ key: "b", code: "KeyB", metaKey: true }))).toBe(false);
      return;
    }
    // Ctrl+Shift+1 as a keyboard sends it: the key is "!", the digit is in the code.
    expect(read({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true })).toBe("mod+shift+1");
    expect(menuOwns(press({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(menuOwns(press({ key: "b", code: "KeyB", ctrlKey: true }))).toBe(true);
    // Ctrl+Alt is how Windows reports AltGr: Ctrl+Alt+1 is Label red, Ctrl+Alt+2 and
    // Ctrl+Alt+S type ² and ś, and none of them is the menu's.
    expect(menuOwns(press({ key: "1", code: "Digit1", ctrlKey: true, altKey: true }))).toBe(false);
    expect(menuOwns(press({ key: "²", code: "Digit2", ctrlKey: true, altKey: true }))).toBe(false);
    expect(menuOwns(press({ key: "ś", code: "KeyS", ctrlKey: true, altKey: true }))).toBe(false);
    // An AZERTY keyboard types "&" on the 1: Ctrl+1 is still the list's first item.
    expect(read({ key: "&", code: "Digit1", ctrlKey: true })).toBe("mod+1");
  });

  it("ctrl+n and ctrl+p move in the palette on a Mac only", async () => {
    const { actionById, PRESETS } = await loadedOn(platform);
    expect(actionById("palette.down")?.keys).toEqual(mac ? ["down", "ctrl+n"] : ["down"]);
    expect(actionById("palette.up")?.keys).toEqual(mac ? ["up", "ctrl+p"] : ["up"]);
    expect(PRESETS.emacs?.bindings["palette.down"]).toEqual(mac ? ["down", "ctrl+n", "alt+n"] : ["down", "alt+n"]);
  });
});

describe("a page's key that reaches the page", () => {
  /** A key filter of its own, and the keys that got past it to the page's handlers. */
  const filtered = (install: (t: Window, gtk?: boolean) => () => void, gtk: boolean) => {
    const target = new EventTarget();
    install(target as unknown as Window, gtk);
    const seen: string[] = [];
    target.addEventListener("keydown", (e) => seen.push((e as KeyboardEvent).key));
    return { target, seen };
  };
  const inbox = () => press({ key: "@", code: "Digit2", ctrlKey: true, shiftKey: true });

  it("on Linux GTK's menu let it through, so the page opens the page; no other key of the menu's", async () => {
    const { installKeyFilter } = await loadedOn("Linux x86_64");
    const { target, seen } = filtered(installKeyFilter, true);
    const page = inbox();
    target.dispatchEvent(page);
    expect(nav.navigate.mock.calls).toEqual([["/inbox"]]);
    expect(page.defaultPrevented).toBe(true);
    // Ctrl+K is the menu's alone: GTK took it before the page, so the page runs nothing.
    const palette = press({ key: "k", code: "KeyK", ctrlKey: true });
    target.dispatchEvent(palette);
    expect(palette.defaultPrevented).toBe(false);
    expect(nav.navigate).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it("on Windows the menu answers it, so the page only lets it pass", async () => {
    const { installKeyFilter } = await loadedOn("Win32");
    const { target, seen } = filtered(installKeyFilter, false);
    const page = inbox();
    target.dispatchEvent(page);
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(page.defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
  });
});
