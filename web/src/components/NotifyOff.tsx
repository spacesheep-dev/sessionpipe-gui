// SPDX-License-Identifier: Apache-2.0
// A session set to Never (its own "Notify me", or a parent's) as a small bell with a
// slash, the Inbox bell's drawing (NotifyToggle.tsx): before the time on a board row,
// before what it does now on a child row. The other levels draw nothing.
import type { SessionSummary } from "@shared/api";
import { useSyncExternalStore } from "react";
import { useStore } from "../data/hooks";
import { showsNever } from "../lib/marks";

/** The bell, or nothing. A child row (`under` its parent) draws it only when the parent
 *  doesn't. It reads the level itself, so a row re-renders only when that changes. */
export function NotifyOff({ s, under = false }: { s: SessionSummary; under?: boolean }) {
  const store = useStore();
  const read = () => showsNever(s, store.get().marks, store.get().sessions, under);
  const off = useSyncExternalStore(store.subscribe, read, read);
  if (!off) return null;
  return (
    <span className="card-muted" role="img" aria-label="Notifications off" title="Notifications off">
      <svg
        viewBox="0 0 20 20"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.2 1.5H4.3z" />
        <path d="M8.3 17a1.8 1.8 0 0 0 3.4 0" />
        <path d="M3.5 3.5l13 13" />
      </svg>
    </span>
  );
}
