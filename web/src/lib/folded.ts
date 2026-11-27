// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Shared per-device fold set (session keys, custom folders `f:<id>`,
// projects `p:<key>`) used by both the sidebar tree and the Board's Organized view so
// collapsing a folder or project on this device stays in sync across surfaces.
import { useCallback, useSyncExternalStore } from "react";

export const FOLDED_KEY = "sessionpipe-gui.sidebar.folded";
/** Folded parents / groups remembered at most (the oldest go first). */
const FOLDED_MAX = 500;

function readFolded(): ReadonlySet<string> {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

let current: ReadonlySet<string> = readFolded();
const listeners = new Set<() => void>();

function persist(next: ReadonlySet<string>): void {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...next].slice(-FOLDED_MAX)));
  } catch {
    // a private window: folded for this visit
  }
}

function commit(next: ReadonlySet<string>): void {
  current = next;
  persist(next);
  for (const l of listeners) l();
}

export function setFoldedKey(key: string, fold: boolean): void {
  if (current.has(key) === fold) return;
  const next = new Set(current);
  if (fold) next.add(key);
  else next.delete(key);
  commit(next);
}

export function setFoldedKeys(keys: readonly string[], fold: boolean): void {
  if (keys.length === 0) return;
  let changed = false;
  const next = new Set(current);
  for (const k of keys) {
    if (next.has(k) === fold) continue;
    changed = true;
    if (fold) next.add(k);
    else next.delete(k);
  }
  if (changed) commit(next);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

const snapshot = (): ReadonlySet<string> => current;

/** Current folded keys on this device, plus stable toggle helpers. */
export function useFolded(): [
  ReadonlySet<string>,
  (key: string, fold: boolean) => void,
  (keys: readonly string[], fold: boolean) => void,
] {
  const folded = useSyncExternalStore(subscribe, snapshot, snapshot);
  const toggle = useCallback((key: string, fold: boolean) => setFoldedKey(key, fold), []);
  const toggleMany = useCallback((keys: readonly string[], fold: boolean) => setFoldedKeys(keys, fold), []);
  return [folded, toggle, toggleMany];
}
