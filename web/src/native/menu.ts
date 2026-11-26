// SPDX-License-Identifier: Apache-2.0
// The app menu's actions (NATIVE-SPEC §3.10), as the page runs them. The shell's menu
// sends `menu { action }`; each id maps to what the page already does for it: a route, or
// the keyboard action of lib/shortcuts.ts (run through the one dispatcher, with the
// person's own binding, so a rebound key still works). Keys a menu item owns are the
// menu's inside the shell: the page lets them pass (no handler runs, nothing is
// prevented), the menu answers, and nothing fires twice.
import { type NewSessionTarget, openNewSession } from "../control/newSessionState";
import { back, navigate, openSettings } from "../lib/router";
import { activeKeys, type Chord, chordOf, chordString, IS_MAC, parseBinding } from "../lib/shortcuts";

export interface MenuItem {
  /** The key equivalent the shell's menu item carries, in lib/shortcuts.ts spelling. */
  keys?: string;
  /** The keyboard action the item runs (lib/shortcuts.ts): the one action that may have
   *  the item's key as its own. */
  fires?: string;
  run: (payload: MenuPayload) => void;
}
/** The `menu` event: the action, and for New session (the global shortcut, a
 *  `sessionpipe://new` link) what to prefill. A link never sends. */
export interface MenuPayload {
  action?: string;
  prefill?: { machine?: unknown; harness?: unknown; folder?: unknown };
}

const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
/** New session, prefilled from a link: only the three strings it may carry. */
export function prefillTarget(p: MenuPayload["prefill"]): NewSessionTarget {
  const t: NewSessionTarget = {};
  const machine = text(p?.machine);
  const harness = text(p?.harness);
  const cwd = text(p?.folder);
  if (machine) t.machine = machine;
  if (harness) t.harness = harness;
  if (cwd) t.cwd = cwd;
  return t;
}

/** ⌃⌘1 … ⌃⌘5 for the pages, not ⌘1 … ⌘5: those open the n-th item of a list and the n-th
 *  tab of the side panel (lib/shortcuts.ts, list.jump / panel.tab). Off a Mac `ctrl` is
 *  `mod`, so ⌃⌘ would collapse to Ctrl+1 (the list's own key): there it is Ctrl+Shift, as
 *  in menu.rs. Not Ctrl+Alt: Windows reports AltGr as Ctrl+Alt, so the menu would take the
 *  characters AltGr types (² and @ on the 2), and Ctrl+Alt+1 … 7 are the colour labels. */
const PAGE = IS_MAC ? "ctrl+mod" : "shift+mod";
/** Toggle Sidebar: ⌃⌘S on a Mac, Ctrl+B elsewhere (Ctrl+Alt+S is AltGr+S, a Polish ś). */
const SIDEBAR = IS_MAC ? "ctrl+mod+s" : "mod+b";

/** An item that is one of the page's keyboard actions, run as that action's key runs it. */
const firing = (keys: string, id: string): MenuItem => ({ keys, fires: id, run: () => fire(id) });

export const MENU: Record<string, MenuItem> = {
  settings: { keys: "mod+,", run: () => openSettings() },
  "new-session": { keys: "mod+n", run: (p) => openNewSession(prefillTarget(p.prefill)) },
  find: firing("mod+f", "search.focus"),
  "go-board": { keys: `${PAGE}+1`, run: () => navigate("/") },
  "go-inbox": { keys: `${PAGE}+2`, run: () => navigate("/inbox") },
  "go-feed": { keys: `${PAGE}+3`, run: () => navigate("/feed") },
  "go-review": { keys: `${PAGE}+4`, run: () => navigate("/review") },
  "go-machines": { keys: `${PAGE}+5`, run: () => navigate("/machines") },
  palette: firing("mod+k", "palette.toggle"),
  // The page's own key for the sessions column (sidebar.toggle) is this chord; in the app
  // the menu has it, and hides the rail and the column together, as a Mac app's sidebar.
  "toggle-sidebar": { keys: SIDEBAR, fires: "sidebar.toggle", run: () => toggleSidebar() },
  back: { keys: "mod+[", run: () => back("/") },
  forward: { keys: "mod+]", run: () => history.forward() },
  shortcuts: firing("mod+/", "help.toggle"),
};

/** Runs a menu action; false for an id the page does not know (logged, ignored). */
export function runMenu(action: string, payload: MenuPayload = { action }): boolean {
  const item = Object.hasOwn(MENU, action) ? MENU[action] : undefined;
  if (!item) {
    console.warn("unknown menu action", action);
    return false;
  }
  item.run(payload);
  return true;
}

/** Each chord a menu item owns, and the item. */
const OWNED = new Map(
  Object.entries(MENU).flatMap(([id, m]) => (parseBinding(m.keys ?? "") ?? []).map((c) => [chordString(c), id])),
);

/** The native menu item a real key press belongs to (a synthetic one never does: it is
 *  the menu's own action arriving through `fire`). */
function ownerOf(e: KeyboardEvent): string | undefined {
  if (!e.isTrusted || e.isComposing) return undefined;
  const c = chordOf(e);
  return c ? OWNED.get(chordString(c)) : undefined;
}

/** Whether a real key press belongs to a native menu item. */
export const menuOwns = (e: KeyboardEvent): boolean => ownerOf(e) !== undefined;

/** In the shell, a capture listener ahead of every other: a key a menu item owns goes to
 *  the menu, past the page's handlers. Returns the function that removes it.
 *
 *  `gtk` (Linux): a page's key that reaches the page is opened by the page. GTK 3 tries
 *  the menu's keys before the page gets one, so a key it took never arrives; but where
 *  Shift+1 types "!" it looks for Ctrl+! among them, finds no item, and passes the key
 *  on. A route opened twice is still that route. */
export function installKeyFilter(
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  gtk = false,
) {
  const onKey = (e: KeyboardEvent) => {
    const id = ownerOf(e);
    if (!id) return;
    e.stopImmediatePropagation();
    if (gtk && id.startsWith("go-")) {
      e.preventDefault();
      runMenu(id);
    }
  };
  const capture = { capture: true };
  target.addEventListener("keydown", onKey as EventListener, capture);
  return () => target.removeEventListener("keydown", onKey as EventListener, capture);
}

const KEY_OF: Record<string, string> = {
  esc: "Escape",
  enter: "Enter",
  space: " ",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  plus: "+",
  tab: "Tab",
};

/** The key press that is this chord, as the dispatcher reads it. */
export function keyEventInit(c: Chord): KeyboardEventInit {
  const key = KEY_OF[c.key] ?? c.key;
  const code = /^[a-z]$/.test(c.key) ? `Key${c.key.toUpperCase()}` : /^[0-9]$/.test(c.key) ? `Digit${c.key}` : "";
  return {
    key,
    code,
    metaKey: IS_MAC ? c.mod : c.meta,
    ctrlKey: IS_MAC ? c.ctrl : c.mod,
    altKey: c.alt,
    shiftKey: c.shift,
    bubbles: true,
    cancelable: true,
  };
}

/** Runs a keyboard action the way its key would: the person's first binding, pressed. */
export function fire(id: string, target: EventTarget = window): boolean {
  const seq = parseBinding(activeKeys(id)[0] ?? "");
  if (!seq) return false;
  for (const c of seq) target.dispatchEvent(new KeyboardEvent("keydown", keyEventInit(c)));
  return true;
}

const RAIL_KEY = "sessionpipe-gui.native.rail";

/** Toggle Sidebar (⌃⌘S, Ctrl+B off a Mac): the rail folds away, remembered on this device. */
export function toggleSidebar(on?: boolean): void {
  const d = document.documentElement;
  const hide = on === undefined ? !d.hasAttribute("data-rail-hidden") : !on;
  d.toggleAttribute("data-rail-hidden", hide);
  try {
    localStorage.setItem(RAIL_KEY, hide ? "hidden" : "");
  } catch {}
}

export function restoreSidebar(): void {
  try {
    if (localStorage.getItem(RAIL_KEY) === "hidden") document.documentElement.toggleAttribute("data-rail-hidden", true);
  } catch {}
}
