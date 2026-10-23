// SPDX-License-Identifier: Apache-2.0
// Hide, Mail's archive for a live list: a session (or one inbox prompt) leaves the board
// on this device until it has something new to say, and an undo toast brings it straight
// back. Nothing is deleted and nothing reaches the server; Forget is the one that does.
// A hidden entry remembers the moment its state began (the session's `stateSince`, an
// inbox prompt's own time): a new state, a new turn or a new prompt shows it again, a
// tool call inside the same turn does not.
import type { SessionKey } from "@shared/api";
import { useSyncExternalStore } from "react";
import { pushUndo } from "./toasts";

const KEY = "sessionpipe-gui.hidden";
/** At most this many hidden entries are kept (the oldest goes). */
const MAX = 500;

/** An entry's key: a session key, or `att:<session>|<attention id>` for one inbox prompt. */
type Hidden = Record<string, string>;

let hidden: Hidden | null = null;
const listeners = new Set<() => void>();

function read(): Hidden {
  if (hidden) return hidden;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    hidden = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Hidden) : {};
  } catch {
    hidden = {};
  }
  return hidden;
}

function write(next: Hidden): void {
  const keys = Object.keys(next);
  if (keys.length > MAX) for (const k of keys.slice(0, keys.length - MAX)) delete next[k];
  hidden = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // a private window: hidden for this page only
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** The hidden entries, live. */
export function useHidden(): Readonly<Hidden> {
  return useSyncExternalStore(subscribe, read, read);
}

/** Whether an entry is still hidden: its state began no later than when it was hidden. */
export const isHidden = (h: Readonly<Hidden>, key: string, since: string): boolean =>
  h[key] !== undefined && since <= h[key]!;

export function unhide(key: string): void {
  const h = read();
  if (h[key] === undefined) return;
  const next = { ...h };
  delete next[key];
  write(next);
}

/** Hide at once, with "Hidden · Undo" for six seconds (⌘Z too). */
export function hide(key: string, since: string, o: { title: string; session?: SessionKey }): void {
  write({ ...read(), [key]: since });
  pushUndo({ id: `hide|${key}`, title: "Hidden", body: o.title, session: o.session, undo: () => unhide(key) });
}

export const attentionKey = (session: SessionKey, attentionId: string) => `att:${session}|${attentionId}`;
