// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. Which of a session's carried messages still belong under the
// composer: one in flight always, a settled one until it ages out (a delivery soon, a
// failure after a few minutes or once a later send got through) or is dismissed.
// Dismissals are per device, in localStorage, so a reload does not bring one back.
import type { ControlActivity } from "@shared/api";
import { useSyncExternalStore } from "react";
import { isFinal, shownState } from "./words";

/** How long a delivery, and a failure not dismissed first, stays under the composer. */
export const KEEP_DELIVERED_MS = 2 * 60_000;
export const KEEP_FAILED_MS = 5 * 60_000;

const HIDDEN_KEY = "sessionpipe-gui.control.hidden";
const HIDDEN_CAP = 200;

const listeners = new Set<() => void>();
let hidden: readonly string[] = read();

function read(): readonly string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function dismissActivity(id: string): void {
  if (hidden.includes(id)) return;
  hidden = [...hidden, id].slice(-HIDDEN_CAP);
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden));
  } catch {
    // private mode or blocked storage: the dismissal lasts for this page only
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const get = () => hidden;

export const useHiddenActivity = (): readonly string[] => useSyncExternalStore(subscribe, get, get);

const settledAt = (a: ControlActivity): number => Date.parse(a.ackedAt ?? a.takenAt ?? a.at); // the machine's clock
const succeeded = (a: ControlActivity): boolean => a.outcome === "delivered" || shownState(a) === "progress";

/** `items` newest first: the rows still under the composer at `now`, and how many "show" would add. */
export function visibleActivity(
  items: readonly ControlActivity[],
  dismissed: readonly string[],
  now: number,
): { shown: ControlActivity[]; hidden: number } {
  const shown: ControlActivity[] = [];
  let superseded = false;
  for (const a of items) {
    const keep = !isFinal(a)
      ? true
      : dismissed.includes(a.id)
        ? false
        : a.outcome === "delivered"
          ? now - settledAt(a) < KEEP_DELIVERED_MS
          : !superseded && now - settledAt(a) < KEEP_FAILED_MS;
    if (keep) shown.push(a);
    if (succeeded(a)) superseded = true;
  }
  return { shown, hidden: items.length - shown.length };
}
