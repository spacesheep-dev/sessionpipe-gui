// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The Files drawer's state, outside React, per drawer: a session's page
// and its tab in the side panel are two drawers (one `key` per surface), so pressing
// Files on the panel never opens the page's. The bar, the panel head, the keymap and the
// palette all go through here; a drawer closed and reopened finds the file it was on,
// the comments not yet sent, the files marked viewed and where the last review stood.
// Nothing is written anywhere: a reload starts clean (the page's `?file=` reopens a file
// by URL). The one preference, which editor "Open in editor" means, is this device's.
import type { SessionKey } from "@shared/api";
import { useSyncExternalStore } from "react";
import type { Editor, LineComment } from "./model";

export type DrawerMode = "page" | "panel";
export type DrawerTab = "files" | "problems";

/** The session page's `?file=<path>`: the drawer open on that file (lib/router.tsx). */
export const FILE_PARAM = "file";

export interface DrawerState {
  open: boolean;
  tab: DrawerTab;
  /** The file shown, by its repo-relative path; null is the list. */
  path: string | null;
  /** Comments written and not sent yet, oldest first. */
  comments: LineComment[];
  /** Files the person marked as viewed; a later touch of one takes the mark off. */
  viewed: ReadonlySet<string>;
  /** The newest event seq when the last review went: what came after it is "since your review". */
  reviewedSeq: number | null;
}

const CLOSED: DrawerState = Object.freeze({
  open: false,
  tab: "files",
  path: null,
  comments: [],
  viewed: new Set<string>(),
  reviewedSeq: null,
}) as DrawerState;

const states = new Map<string, DrawerState>();
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

/** One drawer per surface: the page's and the panel's are told apart. */
export const drawerId = (key: SessionKey, mode: DrawerMode = "page"): string => `${mode}:${key}`;

export const drawerOf = (key: SessionKey, mode: DrawerMode = "page"): DrawerState =>
  states.get(drawerId(key, mode)) ?? CLOSED;

/** Where focus was when a drawer opened, so closing it puts focus back (the palette's way). */
const openers = new Map<string, HTMLElement>();

export function setDrawer(key: SessionKey, patch: Partial<DrawerState>, mode: DrawerMode = "page"): void {
  const id = drawerId(key, mode);
  const prev = states.get(id) ?? CLOSED;
  const next = { ...prev, ...patch };
  if ((Object.keys(next) as (keyof DrawerState)[]).every((k) => next[k] === prev[k])) return;
  if (next.open && !prev.open && document.activeElement instanceof HTMLElement) openers.set(id, document.activeElement);
  states.set(id, next);
  emit();
}

export const openDrawer = (key: SessionKey, path?: string | null, mode: DrawerMode = "page"): void =>
  setDrawer(key, { open: true, ...(path !== undefined ? { path, tab: "files" } : {}) }, mode);

/** Closes, and puts focus back where it was when the drawer opened (if that is still on screen). */
export function closeDrawer(key: SessionKey, mode: DrawerMode = "page"): void {
  const id = drawerId(key, mode);
  setDrawer(key, { open: false }, mode);
  const back = openers.get(id);
  openers.delete(id);
  if (back?.isConnected && back.getClientRects().length > 0) back.focus({ preventScroll: true });
}

export const toggleDrawer = (key: SessionKey, mode: DrawerMode = "page"): void =>
  drawerOf(key, mode).open ? closeDrawer(key, mode) : openDrawer(key, undefined, mode);

export function addComment(key: SessionKey, c: LineComment, mode: DrawerMode = "page"): void {
  setDrawer(key, { comments: [...drawerOf(key, mode).comments, c] }, mode);
}
export function removeComment(key: SessionKey, id: string, mode: DrawerMode = "page"): void {
  setDrawer(key, { comments: drawerOf(key, mode).comments.filter((c) => c.id !== id) }, mode);
}
/** The comments went (sent, or handed to the composer): cleared, and the review marked at `seq`. */
export function reviewed(key: SessionKey, seq: number, mode: DrawerMode = "page"): void {
  setDrawer(key, { comments: [], reviewedSeq: seq }, mode);
}
export function setViewed(key: SessionKey, path: string, on: boolean, mode: DrawerMode = "page"): void {
  const cur = drawerOf(key, mode).viewed;
  if (cur.has(path) === on) return;
  const next = new Set(cur);
  if (on) next.add(path);
  else next.delete(path);
  setDrawer(key, { viewed: next }, mode);
}

export function useDrawer(key: SessionKey, mode: DrawerMode = "page"): DrawerState {
  const read = () => drawerOf(key, mode);
  return useSyncExternalStore(subscribe, read, read);
}

/** Reset, for tests. */
export function resetDrawers(): void {
  states.clear();
  openers.clear();
  emit();
}

// ----- the editor this device opens files in -----

const EDITOR_KEY = "sessionpipe-gui.editor";
const EDITOR_IDS = new Set<string>(["vscode", "cursor", "zed", "windsurf"]);
let editor: Editor | null = (() => {
  try {
    const v = localStorage.getItem(EDITOR_KEY);
    return v && EDITOR_IDS.has(v) ? (v as Editor) : null;
  } catch {
    return null;
  }
})();

export const getEditor = (): Editor | null => editor;
export function setEditor(e: Editor | null): void {
  editor = e;
  try {
    if (e) localStorage.setItem(EDITOR_KEY, e);
    else localStorage.removeItem(EDITOR_KEY);
  } catch {
    // this page only
  }
  emit();
}
export function useEditor(): Editor | null {
  return useSyncExternalStore(subscribe, getEditor, getEditor);
}
