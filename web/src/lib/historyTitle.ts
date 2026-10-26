// SPDX-License-Identifier: Apache-2.0
// Titles of sessions known only from this machine's agent history (web/src/search): the
// receiver holds no summary for them, so the side panel's tab reads the title the search
// index gave when the result was opened or its transcript loaded.
import { useSyncExternalStore } from "react";

const titles = new Map<string, string>();
const subs = new Set<() => void>();
let rev = 0;

export function noteHistoryTitle(key: string, title: string | undefined): void {
  const t = title?.trim();
  if (!t || titles.get(key) === t) return;
  titles.set(key, t);
  rev++;
  for (const s of subs) s();
}

export const historyTitle = (key: string): string | undefined => titles.get(key);

const subscribe = (l: () => void) => {
  subs.add(l);
  return () => {
    subs.delete(l);
  };
};
const get = () => rev;
/** Re-renders the caller when a history title arrives. */
export const useHistoryTitles = (): number => useSyncExternalStore(subscribe, get, get);
