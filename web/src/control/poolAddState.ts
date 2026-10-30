// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The Add account sheet's state outside React (UX-SPEC §4), the way
// newSessionState.ts holds New session's: which machine it is for, and, opened from a
// "Sign in again…" row, the account to sign in again as. Every way in (the section's last
// row, its menus, the page footnote, a free-standing section's menu) calls openPoolAdd.
import { useSyncExternalStore } from "react";

export interface PoolAddTarget {
  machine: string;
  /** Opened from an error row: the account's email, for "Sign in again as …". */
  again?: string;
}

interface OpenState {
  open: boolean;
  target: PoolAddTarget;
  /** Bumped on every open, so the sheet starts over even when already open. */
  seq: number;
}

let state: OpenState = { open: false, target: { machine: "" }, seq: 0 };
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function openPoolAdd(target: PoolAddTarget): void {
  state = { open: true, target, seq: state.seq + 1 };
  emit();
}
export function closePoolAdd(): void {
  if (!state.open) return;
  state = { ...state, open: false };
  emit();
}

export function usePoolAdd(): OpenState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
