// SPDX-License-Identifier: Apache-2.0
// The command palette: ⌘K / ctrl+K on any page (a view plugin, the split panel) opens one
// input over the page. This module is its open state and its key, mounted once from
// app.tsx; the dialog itself (PaletteDialog.tsx: the rows, the sub-lists, the preview) is
// fetched once the page is idle, so it costs the first load nothing and the first ⌘K is
// as quick as any. Asked for before that fetch lands, an invisible field takes the keys
// typed meanwhile and hands them to the dialog.
import { useSyncExternalStore } from "react";
import { lazyModule, whenIdle } from "../lib/lazy";
import { usePresence } from "../lib/motion";
import { useShortcut } from "../lib/shortcuts";

/** The shortcut as this platform writes it, for hints. */
export const PALETTE_KEY = /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "") ? "⌘K" : "Ctrl K";

// ----- open state: a tiny external store, so a hint anywhere can open the palette -----

let isOpen = false;
/** Bumped on every open: a palette reopened during its exit starts fresh. */
let opens = 0;
/** Where focus was when the palette opened; it goes back there on close. */
let returnTo: HTMLElement | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function openPalette(): void {
  if (isOpen) return;
  returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  isOpen = true;
  opens++;
  early = "";
  emit();
}

export function closePalette(): void {
  if (!isOpen) return;
  isOpen = false;
  emit();
  const el = returnTo;
  returnTo = null;
  if (el?.isConnected) el.focus();
  // Focus leaves the palette the moment it closes, not when its exit ends: the next key
  // ("g f" straight after Esc) is the page's, never swallowed by the fading field.
  const left = document.activeElement;
  if (left instanceof HTMLElement && left.closest(".pal")) left.blur();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const usePaletteOpen = () =>
  useSyncExternalStore(
    subscribe,
    () => isOpen,
    () => isOpen,
  );

const dialogModule = lazyModule(() => import("./PaletteDialog"));
whenIdle(() => void dialogModule.preload().catch(() => {}));

/** What was typed while the dialog was still on its way; the dialog starts from it. */
let early = "";
export function takeEarlyQuery(): string {
  const q = early;
  early = "";
  return q;
}

/** ⌘K / ctrl+K (the `palette.toggle` action, rebindable on /shortcuts); the dialog while open. */
export function Palette() {
  const open = usePaletteOpen();
  useShortcut("palette.toggle", () => (isOpen ? closePalette() : openPalette()));
  const mod = dialogModule.use();
  // It stays mounted for its exit (zoom-out, --dur-exit), inert, then goes.
  const { mounted, closing } = usePresence(open);
  if (!mounted) return null;
  if (!mod) return closing ? null : <KeyCatch />;
  return <mod.PaletteDialog key={opens} closing={closing} />;
}

/** The stand-in for the few milliseconds the dialog may still be loading: a field no one
 *  sees, holding focus so the keys typed after ⌘K are the palette's, not the page's. */
function KeyCatch() {
  return (
    <input
      className="sr-only"
      aria-label="Search sessions, actions and pages"
      // biome-ignore lint/a11y/noAutofocus: it stands in for the palette's own field, which takes focus as it opens
      autoFocus
      onChange={(e) => {
        early = e.target.value;
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") closePalette();
      }}
    />
  );
}
