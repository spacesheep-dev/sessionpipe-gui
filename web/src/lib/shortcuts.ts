// SPDX-License-Identifier: Apache-2.0
// One keymap for the whole GUI. Every keyboard action is declared here once (id, label,
// group, scope, default keys); components attach a handler with `useShortcut`, and one
// window listener (`installDispatcher`, mounted by the shell) matches key presses to the
// active bindings and runs the handler. Bindings are chord strings, "mod+k", "shift+enter",
// or a two-chord sequence, "g b", pressed within SEQUENCE_MS of each other. `mod` is ⌘ on
// a Mac and ctrl elsewhere. A person's overrides live in localStorage under
// `sessionpipe-gui.shortcuts` as { [actionId]: string[] | null } (null = unbound); a view
// plugin registers its own keys through ThemeApi.shortcuts and they join the same table.
import { type RefObject, useEffect, useRef, useSyncExternalStore } from "react";

export const SEQUENCE_MS = 1200;
export const STORAGE_KEY = "sessionpipe-gui.shortcuts";
export const PRESET_KEY = "sessionpipe-gui.shortcuts.preset";

export type Scope =
  | "global"
  | "lists"
  | "board"
  | "feed"
  | "session"
  | "panel"
  | "review"
  | "inbox"
  | "machines"
  | "palette"
  | "views";

export interface Action {
  id: string;
  label: string;
  /** The heading it is listed under. */
  group: string;
  scope: Scope;
  /** The default bindings. */
  keys: readonly string[];
  /** Fires while a text field has focus too (Esc, the palette's own keys). */
  inInputs?: boolean;
  /** One line of help. */
  hint?: string;
  /** Set on an action a view plugin registered (the view's id). */
  view?: string;
}

// ----- the platform -----

export const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "");

// ----- chords -----

export interface Chord {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Normalized, lower case: "k", "enter", "esc", "up", "/", "?", "space", "plus", "f5". */
  key: string;
}

const KEY_NAMES: Record<string, string> = {
  " ": "space",
  spacebar: "space",
  escape: "esc",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  return: "enter",
  "+": "plus",
  del: "delete",
  pgup: "pageup",
  pgdn: "pagedown",
};
const MOD_NAMES: Record<string, keyof Omit<Chord, "key">> = {
  mod: "mod",
  cmd: IS_MAC ? "mod" : "meta",
  command: IS_MAC ? "mod" : "meta",
  meta: IS_MAC ? "mod" : "meta",
  win: "meta",
  super: "meta",
  ctrl: IS_MAC ? "ctrl" : "mod",
  control: IS_MAC ? "ctrl" : "mod",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

const normalizeKey = (k: string): string => {
  const low = k.toLowerCase();
  return KEY_NAMES[low] ?? low;
};

/** A printable non-alphanumeric key already says whether shift was held ("?" vs "/"). */
const selfShifted = (key: string) => key.length === 1 && !/[a-z0-9]/.test(key);

/** Parses one chord, "mod+shift+k"; null when it makes no sense. */
export function parseChord(text: string): Chord | null {
  const raw = text.trim();
  if (!raw) return null;
  // "+" alone, or "shift++": the last "+" is the key.
  const parts = raw.endsWith("+") ? [...raw.slice(0, -1).split("+").filter(Boolean), "+"] : raw.split("+");
  const chord: Chord = { mod: false, ctrl: false, alt: false, shift: false, meta: false, key: "" };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!.trim().toLowerCase();
    if (!p) return null;
    const last = i === parts.length - 1;
    if (!last) {
      const m = MOD_NAMES[p];
      if (!m) return null;
      chord[m] = true;
    } else {
      chord.key = normalizeKey(p);
    }
  }
  if (!chord.key) return null;
  if (selfShifted(chord.key)) chord.shift = false;
  return chord;
}

/** Parses a binding: one chord or two separated by a space, "g b". */
export function parseBinding(text: string): Chord[] | null {
  const chords = text.trim().split(/\s+/).filter(Boolean);
  if (chords.length === 0 || chords.length > 2) return null;
  const out: Chord[] = [];
  for (const c of chords) {
    const p = parseChord(c);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

export function chordString(c: Chord): string {
  const mods: string[] = [];
  if (c.mod) mods.push("mod");
  if (c.ctrl) mods.push("ctrl");
  if (c.alt) mods.push("alt");
  if (c.shift) mods.push("shift");
  if (c.meta) mods.push("meta");
  return [...mods, c.key].join("+");
}

export const bindingString = (seq: readonly Chord[]): string => seq.map(chordString).join(" ");

/** The canonical spelling of a binding written by hand, or null when it does not parse. */
export const canonical = (text: string): string | null => {
  const p = parseBinding(text);
  return p ? bindingString(p) : null;
};

/** The chord a key press is, or null for a lone modifier. */
export function chordOf(e: KeyboardEvent): Chord | null {
  let key = e.key;
  if (!key || ["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead", "Unidentified", "Process"].includes(key))
    return null;
  // With alt held a Mac types another character ("∂" for alt+d): read the physical key.
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (e.altKey && /^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  const chord: Chord = {
    mod: IS_MAC ? e.metaKey : e.ctrlKey,
    ctrl: IS_MAC ? e.ctrlKey : false,
    meta: IS_MAC ? false : e.metaKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key: normalizeKey(key),
  };
  if (selfShifted(chord.key)) chord.shift = false;
  return chord;
}

const sameChord = (a: Chord, b: Chord) =>
  a.key === b.key &&
  a.mod === b.mod &&
  a.ctrl === b.ctrl &&
  a.alt === b.alt &&
  a.shift === b.shift &&
  a.meta === b.meta;

// ----- display -----

const MAC_KEYS: Record<string, string> = {
  enter: "↵",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  backspace: "⌫",
  delete: "⌦",
  tab: "⇥",
  space: "space",
  esc: "esc",
  plus: "+",
};
const PC_KEYS: Record<string, string> = {
  enter: "Enter",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  backspace: "Backspace",
  delete: "Del",
  tab: "Tab",
  space: "Space",
  esc: "Esc",
  plus: "+",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
};

/** One chord as a person reads it: "⌘K", "⇧↵", "g" on a Mac; "Ctrl+K", "Shift+Enter" elsewhere. */
export function formatChord(c: Chord): string {
  if (IS_MAC) {
    const mods = `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.mod ? "⌘" : ""}`;
    // A bare letter stays lower case ("g" then "f"); with a modifier it reads as on the cap, ⌘K.
    const key = MAC_KEYS[c.key] ?? (c.key.length === 1 && mods ? c.key.toUpperCase() : c.key);
    return mods + key;
  }
  const mods: string[] = [];
  if (c.mod) mods.push("Ctrl");
  if (c.alt) mods.push("Alt");
  if (c.shift) mods.push("Shift");
  if (c.meta) mods.push("Win");
  const key = PC_KEYS[c.key] ?? (c.key.length === 1 && mods.length === 0 ? c.key : c.key.toUpperCase());
  return [...mods, key].join("+");
}

/** A binding as a list of chips: ["g", "f"] or ["⌘K"]. */
export function formatBinding(text: string): string[] {
  const seq = parseBinding(text);
  return seq ? seq.map(formatChord) : [text];
}

/** The first active binding of an action as one string, for hints: "⌘K", "g f". */
export function hintFor(id: string): string {
  const k = activeKeys(id)[0];
  return k ? formatBinding(k).join(" ") : "";
}

// ----- browser keys -----

/** Never bindable: the browser owns these on every platform and most never reach the page. */
const BROWSER_HARD = new Set([
  "mod+l",
  "mod+t",
  "mod+n",
  "mod+q",
  "mod+r",
  "mod+shift+n",
  "mod+shift+r",
  "mod+shift+q",
  "alt+f4",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
/** Bindable, but the browser may take them first (a note in the recorder and the help). */
const BROWSER_SOFT = new Set([
  "mod+w",
  "mod+shift+w",
  "mod+shift+t",
  "mod+p",
  "mod+s",
  "mod+f",
  "mod+g",
  "mod+d",
  "mod+h",
  "mod+j",
  "mod+o",
  "mod+u",
  "mod+y",
  "ctrl+tab",
  "ctrl+shift+tab",
  ...Array.from({ length: 9 }, (_, i) => `mod+${i + 1}`),
]);

export const browserTakes = (binding: string): "hard" | "soft" | null => {
  const seq = parseBinding(binding);
  if (!seq) return null;
  for (const c of seq) {
    const s = chordString(c);
    if (BROWSER_HARD.has(s)) return "hard";
  }
  for (const c of seq) if (BROWSER_SOFT.has(chordString(c))) return "soft";
  return null;
};

// ----- the actions -----

const nav = (id: string, label: string, key: string, hint?: string): Action => ({
  id,
  label,
  group: "Go to",
  scope: "global",
  keys: [key],
  hint,
});

export const ACTIONS: readonly Action[] = [
  nav("nav.board", "Board", "g b"),
  nav("nav.inbox", "Inbox", "g i"),
  nav("nav.feed", "Feed", "g f"),
  nav("nav.review", "Review", "g r"),
  nav("nav.machines", "Machines", "g m"),
  nav("nav.connect", "Connect", "g c"),
  nav("nav.setup", "Setup", "g s"),
  nav("nav.views", "Views", "g v", "the installed view plugins"),
  nav("nav.shortcuts", "Keyboard shortcuts", "g k", "this table, as a page"),
  ...Array.from({ length: 9 }, (_, i) =>
    nav(`nav.view${i + 1}`, `View ${i + 1}`, `g ${i + 1}`, "the n-th installed view, in rail order"),
  ),

  {
    id: "palette.toggle",
    label: "Command palette",
    group: "Everywhere",
    scope: "global",
    keys: ["mod+k"],
    inInputs: true,
  },
  { id: "search.focus", label: "Search this page", group: "Everywhere", scope: "global", keys: ["/"] },
  { id: "help.toggle", label: "Keyboard shortcuts help", group: "Everywhere", scope: "global", keys: ["?"] },
  {
    id: "back",
    label: "Back, or close what is open",
    group: "Everywhere",
    scope: "global",
    keys: ["esc"],
    inInputs: true,
    hint: "leaves a text field first; then closes a popover, the panel or a confirm; then goes back",
  },
  { id: "appearance.toggle", label: "Dark / light", group: "Everywhere", scope: "global", keys: ["t"] },
  { id: "colorTheme.next", label: "Next skin", group: "Everywhere", scope: "global", keys: ["shift+t"] },
  { id: "lens.cycle", label: "Cycle the tier lens", group: "Everywhere", scope: "global", keys: ["l"] },
  {
    id: "toasts.focus",
    label: "Jump to the notifications",
    group: "Everywhere",
    scope: "global",
    keys: ["mod+shift+t"],
    inInputs: true,
    hint: "focus moves to the toast stack when one is showing",
  },

  { id: "list.down", label: "Next item", group: "Lists", scope: "lists", keys: ["j", "down"] },
  { id: "list.up", label: "Previous item", group: "Lists", scope: "lists", keys: ["k", "up"] },
  { id: "list.open", label: "Open the item", group: "Lists", scope: "lists", keys: ["enter"] },
  { id: "list.beside", label: "Open beside the page", group: "Lists", scope: "lists", keys: ["shift+enter"] },
  {
    id: "list.background",
    label: "Open beside, as a background tab",
    group: "Lists",
    scope: "lists",
    keys: ["mod+enter"],
  },

  // Mail's flag keys: ⌥⌘1 … ⌥⌘7 set a colour label on the item under the cursor (the
  // selection on the canvas), ⌥⌘0 clears it. The order is LABEL_COLORS.
  ...(["red", "orange", "yellow", "green", "blue", "purple", "grey"] as const).map((c, i) => ({
    id: `label.${c}`,
    label: `Label ${c}`,
    group: "Labels",
    scope: "lists" as const,
    keys: [`mod+alt+${i + 1}`],
  })),
  { id: "label.none", label: "Remove the label", group: "Labels", scope: "lists", keys: ["mod+alt+0"] },

  { id: "feed.pause", label: "Pause / resume the feed", group: "Feed", scope: "feed", keys: ["space"] },
  { id: "feed.new", label: "Show what arrived while paused", group: "Feed", scope: "feed", keys: ["n"] },

  { id: "inbox.allow", label: "Allow the prompt under the cursor", group: "Inbox", scope: "inbox", keys: ["a"] },
  { id: "inbox.deny", label: "Deny the prompt under the cursor", group: "Inbox", scope: "inbox", keys: ["d"] },

  { id: "session.allow", label: "Allow the open permission", group: "Session", scope: "session", keys: ["a"] },
  { id: "session.deny", label: "Deny the open permission", group: "Session", scope: "session", keys: ["d"] },
  { id: "session.prompt", label: "Focus the prompt", group: "Session", scope: "session", keys: ["p"] },
  {
    id: "session.cancel",
    label: "Cancel the running turn",
    group: "Session",
    scope: "session",
    keys: ["c"],
    hint: "asks first",
  },
  { id: "session.follow", label: "Follow the live turn", group: "Session", scope: "session", keys: ["f"] },
  { id: "session.openPage", label: "Open as a page", group: "Session", scope: "session", keys: ["o"] },
  { id: "session.older", label: "Older turns", group: "Session", scope: "session", keys: ["."] },

  { id: "panel.prev", label: "Previous tab", group: "Side panel", scope: "panel", keys: ["[", "ctrl+shift+tab"] },
  { id: "panel.next", label: "Next tab", group: "Side panel", scope: "panel", keys: ["]", "ctrl+tab"] },
  {
    id: "panel.closeTab",
    label: "Close the tab",
    group: "Side panel",
    scope: "panel",
    keys: ["mod+w"],
    hint: "while the panel has focus; the browser keeps it otherwise",
  },
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `panel.tab${i + 1}`,
    label: `Tab ${i + 1}`,
    group: "Side panel",
    scope: "panel" as Scope,
    keys: [`mod+${i + 1}`],
  })),
  { id: "panel.close", label: "Close the panel", group: "Side panel", scope: "panel", keys: ["x"] },

  {
    id: "palette.down",
    label: "Next row",
    group: "Command palette",
    scope: "palette",
    keys: ["down", "ctrl+n"],
    inInputs: true,
  },
  {
    id: "palette.up",
    label: "Previous row",
    group: "Command palette",
    scope: "palette",
    keys: ["up", "ctrl+p"],
    inInputs: true,
  },
  {
    id: "palette.run",
    label: "Run the row",
    group: "Command palette",
    scope: "palette",
    keys: ["enter"],
    inInputs: true,
  },
  {
    id: "palette.beside",
    label: "Open the session beside",
    group: "Command palette",
    scope: "palette",
    keys: ["shift+enter"],
    inInputs: true,
  },
  { id: "palette.close", label: "Close", group: "Command palette", scope: "palette", keys: ["esc"], inInputs: true },
];

const byId = new Map(ACTIONS.map((a) => [a.id, a]));

// ----- view actions (ThemeApi.shortcuts) -----

interface ViewAction extends Action {
  view: string;
  run: () => void;
}
const viewActions = new Map<string, ViewAction>();

/** Registers a view's actions under `<viewId>:<id>`; returns the function that removes them. */
export function registerViewActions(
  viewId: string,
  viewName: string,
  actions: { id: string; label: string; keys: string[]; run(): void; hint?: string }[],
): () => void {
  const ids: string[] = [];
  for (const a of actions) {
    if (!a || typeof a.id !== "string" || !/^[a-z][a-z0-9._-]*$/i.test(a.id) || typeof a.run !== "function") continue;
    const id = `${viewId}:${a.id}`;
    const keys = (Array.isArray(a.keys) ? a.keys : []).map(canonical).filter((k): k is string => !!k);
    viewActions.set(id, {
      id,
      label: String(a.label ?? a.id),
      group: viewName,
      scope: "views",
      keys,
      hint: a.hint,
      view: viewId,
      run: a.run,
    });
    ids.push(id);
  }
  emit();
  return () => {
    for (const id of ids) viewActions.delete(id);
    emit();
  };
}

/** Every action: the host's, then the views'. */
export function allActions(): Action[] {
  return [...ACTIONS, ...viewActions.values()];
}

export const actionById = (id: string): Action | undefined => byId.get(id) ?? viewActions.get(id);

// ----- presets -----

export interface Preset {
  id: string;
  name: string;
  hint: string;
  bindings: Record<string, string[]>;
}

export const PRESETS: Record<string, Preset> = {
  vim: {
    id: "vim",
    name: "Vim-style",
    hint: "h / l for the panel's tabs, shift+L for the lens, : for the palette",
    bindings: {
      "panel.prev": ["h", "[", "ctrl+shift+tab"],
      "panel.next": ["l", "]", "ctrl+tab"],
      "lens.cycle": ["shift+l"],
      "palette.toggle": ["mod+k", ":"],
      "list.open": ["enter", "o"],
      "session.openPage": ["shift+o"],
    },
  },
  emacs: {
    id: "emacs",
    name: "Emacs-ish",
    hint: "alt+n / alt+p move, ctrl+g closes, alt+x is the palette",
    bindings: {
      "list.down": ["j", "down", "alt+n"],
      "list.up": ["k", "up", "alt+p"],
      back: ["esc", "ctrl+g"],
      "palette.toggle": ["mod+k", "alt+x"],
      "palette.down": ["down", "ctrl+n", "alt+n"],
      "palette.up": ["up", "ctrl+p", "alt+p"],
      "palette.close": ["esc", "ctrl+g"],
    },
  },
};

// ----- overrides -----

export type Overrides = Record<string, string[] | null>;

/** Reads and cleans a stored overrides object: known shape, parseable bindings. */
export function sanitizeOverrides(raw: unknown): Overrides {
  const out: Overrides = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id !== "string" || id.length > 120) continue;
    if (v === null) {
      out[id] = null;
      continue;
    }
    if (!Array.isArray(v)) continue;
    const keys = v
      .filter((k): k is string => typeof k === "string")
      .map(canonical)
      .filter((k): k is string => !!k);
    out[id] = [...new Set(keys)].slice(0, 6);
  }
  return out;
}

function readOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeOverrides(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}
function readPreset(): string | null {
  try {
    const p = localStorage.getItem(PRESET_KEY);
    return p && PRESETS[p] ? p : null;
  } catch {
    return null;
  }
}

let overrides: Overrides = readOverrides();
let preset: string | null = readPreset();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
let version = 0;

function write(): void {
  version++;
  try {
    if (Object.keys(overrides).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    if (preset) localStorage.setItem(PRESET_KEY, preset);
    else localStorage.removeItem(PRESET_KEY);
  } catch {
    // private mode or full: the change lasts for this page only
  }
  emit();
}

/** Another tab changed the keymap: follow it. */
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY && e.key !== PRESET_KEY) return;
  overrides = readOverrides();
  preset = readPreset();
  version++;
  emit();
});

export const getOverrides = (): Overrides => overrides;
export const getPreset = (): string | null => preset;
export const isOverridden = (id: string): boolean => id in overrides;

/** The bindings in force for an action: the override, else the defaults. */
export function activeKeys(id: string): string[] {
  const o = overrides[id];
  if (o === null) return [];
  if (o) return o;
  return [...(actionById(id)?.keys ?? [])];
}

/** Every action's active bindings, by id. */
export function activeMap(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const a of allActions()) out[a.id] = activeKeys(a.id);
  return out;
}

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/** Sets an action's bindings; `null` unbinds it; equal to the defaults drops the override. */
export function setBinding(id: string, keys: string[] | null): void {
  const a = actionById(id);
  if (!a) return;
  if (keys === null) overrides[id] = null;
  else {
    const clean = [...new Set(keys.map(canonical).filter((k): k is string => !!k))];
    if (sameKeys(clean, a.keys)) delete overrides[id];
    else overrides[id] = clean;
  }
  write();
}

export function resetBinding(id: string): void {
  if (!(id in overrides)) return;
  delete overrides[id];
  write();
}

export function resetAll(): void {
  overrides = {};
  preset = null;
  write();
}

// ----- conflicts -----

const LIST_PAGES: readonly Scope[] = ["board", "feed", "inbox"];

/** Whether two scopes can be live at the same time (so a shared key would be ambiguous). */
export function scopesOverlap(a: Scope, b: Scope): boolean {
  if (a === b || a === "global" || b === "global") return true;
  if ((a === "lists" && LIST_PAGES.includes(b)) || (b === "lists" && LIST_PAGES.includes(a))) return true;
  if ((a === "session" && b === "panel") || (a === "panel" && b === "session")) return true;
  // A view page can show the panel, the palette, and the global keys; its own keys shadow
  // the host's on its page, so they are not conflicts.
  return false;
}

const isPrefix = (short: readonly Chord[], long: readonly Chord[]) =>
  short.length < long.length && short.every((c, i) => sameChord(c, long[i]!));

export type Conflict =
  | { kind: "browser"; binding: string }
  | { kind: "action"; action: Action; binding: string }
  | { kind: "prefix"; action: Action; binding: string }
  | { kind: "invalid" };

/** Why `binding` cannot be given to action `id`, or null when it can. */
export function conflictFor(id: string, binding: string): Conflict | null {
  const seq = parseBinding(binding);
  if (!seq) return { kind: "invalid" };
  if (browserTakes(binding) === "hard") return { kind: "browser", binding };
  const me = actionById(id);
  if (!me) return { kind: "invalid" };
  for (const other of allActions()) {
    if (other.id === id || !scopesOverlap(me.scope, other.scope)) continue;
    for (const k of activeKeys(other.id)) {
      const os = parseBinding(k);
      if (!os) continue;
      if (os.length === seq.length && os.every((c, i) => sameChord(c, seq[i]!)))
        return { kind: "action", action: other, binding: k };
      if (isPrefix(os, seq) || isPrefix(seq, os)) return { kind: "prefix", action: other, binding: k };
    }
  }
  return null;
}

/** Other actions in non-overlapping scopes that use the same binding (shown as a note, not refused). */
export function sharedWith(id: string, binding: string): Action[] {
  const seq = parseBinding(binding);
  const me = actionById(id);
  if (!seq || !me) return [];
  const out: Action[] = [];
  for (const other of allActions()) {
    if (other.id === id || scopesOverlap(me.scope, other.scope)) continue;
    for (const k of activeKeys(other.id)) {
      const os = parseBinding(k);
      if (os && os.length === seq.length && os.every((c, i) => sameChord(c, seq[i]!))) out.push(other);
    }
  }
  return out;
}

export const conflictWords = (c: Conflict): string => {
  switch (c.kind) {
    case "browser":
      return `${formatBinding(c.binding).join(" ")} belongs to the browser`;
    case "action":
      return `${formatBinding(c.binding).join(" ")} is ${c.action.label}`;
    case "prefix":
      return `clashes with ${formatBinding(c.binding).join(" ")} (${c.action.label})`;
    case "invalid":
      return "not a key";
  }
};

// ----- applying a preset -----

/** Applies a preset (or none): the previous preset's actions go back to their defaults
 *  first; a preset binding that would conflict is skipped and reported. */
export function applyPreset(id: string | null): { skipped: { id: string; reason: string }[] } {
  const skipped: { id: string; reason: string }[] = [];
  const was = preset ? PRESETS[preset] : undefined;
  if (was) for (const aid of Object.keys(was.bindings)) delete overrides[aid];
  preset = null;
  const p = id ? PRESETS[id] : undefined;
  if (id && p) {
    for (const [aid, keys] of Object.entries(p.bindings)) {
      const ok = keys.filter((k) => {
        const c = conflictFor(aid, k);
        if (c && c.kind !== "action") {
          skipped.push({ id: aid, reason: conflictWords(c) });
          return false;
        }
        return true;
      });
      // A clash with another action of the same preset is fine: both change together.
      const a = actionById(aid);
      if (a) {
        if (sameKeys(ok, a.keys)) delete overrides[aid];
        else overrides[aid] = ok;
      }
    }
    preset = id;
  }
  write();
  return { skipped };
}

// ----- export / import -----

export interface Exported {
  app: "sessionpipe-gui";
  shortcuts: 1;
  preset: string | null;
  overrides: Overrides;
}

export function exportJson(): string {
  const doc: Exported = { app: "sessionpipe-gui", shortcuts: 1, preset, overrides };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Loads an exported file. Unknown actions are dropped, conflicts inside the file are
 *  resolved first come first served; the result says what was skipped and why. */
export function importJson(text: string): { applied: number; skipped: { id: string; reason: string }[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("not JSON");
  }
  const doc = parsed as Partial<Exported> | Overrides;
  const raw = doc && typeof doc === "object" && "overrides" in doc ? (doc as Partial<Exported>).overrides : doc;
  const incoming = sanitizeOverrides(raw);
  const next: Overrides = {};
  const skipped: { id: string; reason: string }[] = [];
  const before = overrides;
  overrides = next;
  try {
    for (const [id, keys] of Object.entries(incoming)) {
      if (!actionById(id)) {
        skipped.push({ id, reason: "unknown action" });
        continue;
      }
      if (keys === null) {
        next[id] = null;
        continue;
      }
      const ok: string[] = [];
      for (const k of keys) {
        const c = conflictFor(id, k);
        if (c) skipped.push({ id, reason: conflictWords(c) });
        else ok.push(k);
      }
      const a = actionById(id)!;
      if (!sameKeys(ok, a.keys)) next[id] = ok;
    }
  } catch (e) {
    overrides = before;
    throw e;
  }
  const p = doc && typeof doc === "object" && "preset" in doc ? (doc as Partial<Exported>).preset : null;
  preset = typeof p === "string" && PRESETS[p] ? p : null;
  write();
  return { applied: Object.keys(next).length, skipped };
}

// ----- live state for React -----

/** Re-renders when a binding, a preset or the set of view actions changes. */
export function useShortcutMap(): Record<string, string[]> {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  return activeMap();
}

export function useBindingVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

// ----- handlers -----

export interface HandlerOptions {
  /** Among several live handlers for one action, the higher runs first (default 0). */
  priority?: number;
  /** The element this handler belongs to: it wins while focus is inside it. */
  within?: () => HTMLElement | null;
  enabled?: () => boolean;
}

interface Handler extends HandlerOptions {
  id: string;
  /** Anything but `false` means the key was taken. */
  run: (e: KeyboardEvent) => unknown;
  order: number;
}

const handlers = new Map<string, Set<Handler>>();
let order = 0;

/** Attaches a handler to an action. `run` may return false to decline (the next handler,
 *  or the browser, gets the key). Returns the function that detaches it. */
export function registerHandler(id: string, run: Handler["run"], opts: HandlerOptions = {}): () => void {
  const h: Handler = { id, run, order: order++, ...opts };
  let set = handlers.get(id);
  if (!set) {
    set = new Set();
    handlers.set(id, set);
  }
  set.add(h);
  return () => {
    set?.delete(h);
  };
}

/** The React form: the latest `run` always runs, the registration stays put. */
export function useShortcut(
  id: string,
  run: (e: KeyboardEvent) => unknown,
  opts: { enabled?: boolean; priority?: number; within?: RefObject<HTMLElement | null> } = {},
): void {
  const runRef = useRef(run);
  runRef.current = run;
  const enabledRef = useRef(opts.enabled ?? true);
  enabledRef.current = opts.enabled ?? true;
  const withinRef = useRef(opts.within);
  withinRef.current = opts.within;
  const priority = opts.priority ?? 0;
  useEffect(
    () =>
      registerHandler(id, (e) => runRef.current(e), {
        priority,
        enabled: () => enabledRef.current,
        within: () => withinRef.current?.current ?? null,
      }),
    [id, priority],
  );
}

const hasLiveHandler = (id: string): boolean => {
  const v = viewActions.get(id);
  if (v) return true;
  const set = handlers.get(id);
  if (!set) return false;
  for (const h of set) if (h.enabled?.() !== false) return true;
  return false;
};

/** Runs the best handler for an action; true when one took the key. */
function runAction(id: string, e: KeyboardEvent): boolean {
  const v = viewActions.get(id);
  if (v) {
    v.run();
    return true;
  }
  const set = handlers.get(id);
  if (!set) return false;
  const active = document.activeElement;
  const live = [...set].filter((h) => h.enabled?.() !== false);
  live.sort((a, b) => {
    const fa = active && a.within?.()?.contains(active) ? 1 : 0;
    const fb = active && b.within?.()?.contains(active) ? 1 : 0;
    if (fa !== fb) return fb - fa;
    if ((a.priority ?? 0) !== (b.priority ?? 0)) return (b.priority ?? 0) - (a.priority ?? 0);
    return b.order - a.order;
  });
  for (const h of live) if (h.run(e) !== false) return true;
  return false;
}

// ----- typing contexts -----

const NON_TEXT_INPUTS = new Set(["radio", "checkbox", "button", "submit", "reset", "range", "color", "file"]);

/** Whether a key press belongs to a text field (so letters and `/` leave it alone). */
export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el?.tagName) return false;
  const tag = el.tagName;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((el as HTMLInputElement).type);
  return tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

const ARROWS = new Set(["up", "down", "left", "right", "home", "end"]);
/** A radio group, a tab strip, a slider or a separator uses the arrows itself. */
function claimsArrows(t: EventTarget | null, key: string): boolean {
  if (!ARROWS.has(key)) return false;
  const el = t as HTMLElement | null;
  if (!el?.tagName) return false;
  if (el.tagName === "INPUT" && ["radio", "range"].includes((el as HTMLInputElement).type)) return true;
  const role = el.getAttribute("role");
  return role === "tab" || role === "slider" || role === "separator" || role === "option" || role === "listbox";
}

// ----- the dispatcher -----

let pending: { chord: Chord; at: number } | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
const pendingListeners = new Set<() => void>();
const setPending = (p: typeof pending) => {
  pending = p;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
  if (p) pendingTimer = setTimeout(() => setPending(null), SEQUENCE_MS);
  for (const l of pendingListeners) l();
};

/** The first chord of a sequence, while the second is awaited (for a hint on screen). */
export function usePendingChord(): string | null {
  return useSyncExternalStore(
    (l) => {
      pendingListeners.add(l);
      return () => {
        pendingListeners.delete(l);
      };
    },
    () => (pending ? formatChord(pending.chord) : null),
    () => null,
  );
}

interface Candidate {
  action: Action;
  seq: Chord[];
}

function candidates(): Candidate[] {
  const out: Candidate[] = [];
  // Views first: their keys shadow the host's while the view is mounted.
  for (const a of [...viewActions.values(), ...ACTIONS]) {
    if (!hasLiveHandler(a.id)) continue;
    for (const k of activeKeys(a.id)) {
      const seq = parseBinding(k);
      if (seq) out.push({ action: a, seq });
    }
  }
  return out;
}

/** Whether a key press is one of an action's single-chord bindings (for components that
 *  read keys themselves, like the palette). */
export function matches(
  e:
    | KeyboardEvent
    | { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string },
  id: string,
): boolean {
  const c = chordOf(e as KeyboardEvent);
  if (!c) return false;
  for (const k of activeKeys(id)) {
    const seq = parseBinding(k);
    if (seq && seq.length === 1 && sameChord(seq[0]!, c)) return true;
  }
  return false;
}

/** Whether a mounted view plugin owns this key press: the key is a bare one (no mod,
 *  not a `g …` sequence, not Esc) and focus is inside the view's container or nowhere in
 *  particular (the body). A view's own keys, registered or listened for, win there; the
 *  host's mod chords, its navigation sequences and Esc work everywhere. */
function viewOwns(e: KeyboardEvent, chord: Chord): boolean {
  const host = document.querySelector<HTMLElement>("[data-theme-id]:not([hidden])");
  if (!host) return false;
  if (chord.mod || chord.ctrl || chord.alt || chord.meta || chord.key === "esc") return false;
  // Inside the view, or on one of its ancestors (the body, <main> after a click in it).
  const t = e.target as Node | null;
  return !t || t === document || host.contains(t) || t.contains(host);
}

function onKeyDown(e: KeyboardEvent): void {
  // A key something else already took (a view's own listener) is not ours.
  if (e.defaultPrevented || e.isComposing) return;
  const chord = chordOf(e);
  if (!chord) return;
  const typing = isTyping(e.target);
  const arrows = claimsArrows(e.target, chord.key);
  const inView = viewOwns(e, chord);
  const allowed = (a: Action) => (a.inInputs || !typing) && !(arrows && !a.inInputs);
  // On a view's page only its own actions, the host's two-key sequences and Esc are in play
  // (mod chords never count as the view's: `viewOwns` is false for them).
  const all = candidates().filter(
    (c) => !inView || c.action.view !== undefined || c.seq.length === 2 || c.action.id === "back",
  );

  if (pending) {
    const first = pending.chord;
    setPending(null);
    const exact = all.filter(
      (c) => c.seq.length === 2 && sameChord(c.seq[0]!, first) && sameChord(c.seq[1]!, chord) && allowed(c.action),
    );
    for (const c of exact) {
      if (runAction(c.action.id, e)) {
        e.preventDefault();
        return;
      }
    }
    // A sequence that went nowhere: the second key is tried on its own below.
  }

  const singles = all.filter((c) => c.seq.length === 1 && sameChord(c.seq[0]!, chord) && allowed(c.action));
  for (const c of singles) {
    if (runAction(c.action.id, e)) {
      e.preventDefault();
      return;
    }
  }
  const prefixes = all.filter((c) => c.seq.length === 2 && sameChord(c.seq[0]!, chord) && allowed(c.action));
  if (prefixes.length > 0) {
    e.preventDefault();
    setPending({ chord, at: Date.now() });
  }
}

let installed = 0;
/** Mounts the window listener; returns the function that unmounts it. */
export function installDispatcher(): () => void {
  if (installed++ === 0) window.addEventListener("keydown", onKeyDown);
  return () => {
    if (--installed === 0) {
      window.removeEventListener("keydown", onKeyDown);
      setPending(null);
    }
  };
}
