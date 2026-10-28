// SPDX-License-Identifier: Apache-2.0
// Hide, Mail's archive for a live list: a session (or one inbox prompt) leaves the board
// on this device until it has something new to say, and an undo toast brings it straight
// back. Nothing is deleted and nothing reaches the server; Forget is the one that does.
// A hidden entry remembers the moment its state began (the session's `stateSince`, an
// inbox prompt's own time): a new state, a new turn or a new prompt shows it again, a
// tool call inside the same turn does not. Hide until it needs you is for a session that
// loops ("every 30 minutes, check the nightly build"): its new turns leave it hidden, and
// it shows only while it needs you. The board keeps every hidden session in a folded
// Hidden group, where Unhide (e, the menu, a phone's swipe) brings one back.
import type { SessionKey, SessionSummary } from "@shared/api";
import { useSyncExternalStore } from "react";
import { pushUndo } from "./toasts";

const KEY = "sessionpipe-gui.hidden";
/** At most this many hidden entries are kept (the oldest goes). */
const MAX = 500;

/** An entry's key: a session key, or `att:<session>|<attention id>` for one inbox prompt.
 *  Its value: when the hidden state began, or, hidden until it needs you, when it was
 *  hidden (a stored string from before that reads as it always did). */
type Entry = string | { since: string; until: "needs" };
type Hidden = Record<string, Entry>;

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

/** Whether an entry is still hidden: its state began no later than when it was hidden,
 *  or, hidden until it needs you, it doesn't need you now (whatever its state's age). */
export function isHidden(h: Readonly<Hidden>, key: string, since: string, needsYou = false): boolean {
  const e = h[key];
  if (typeof e === "string") return since <= e;
  return e?.until === "needs" && !needsYou;
}

type Row = Pick<SessionSummary, "key" | "stateSince" | "state">;
const rowHidden = (h: Readonly<Hidden>, s: Row) => isHidden(h, s.key, s.stateSince, s.state === "needs_you");

/** Whether a session is hidden right now (a menu's builder, outside render). */
export const hiddenNow = (s: Row): boolean => rowHidden(read(), s);

/** The sessions a list keeps in its Hidden group: those its filters pass that are still
 *  hidden, in the list's own order. */
export const hiddenRows = <S extends Row>(
  h: Readonly<Hidden>,
  sessions: readonly S[],
  passes: (s: S) => boolean,
): S[] => sessions.filter((s) => passes(s) && rowHidden(h, s));

/** The Hidden group's count. */
export const hiddenCount = <S extends Row>(h: Readonly<Hidden>, sessions: readonly S[], passes: (s: S) => boolean) =>
  hiddenRows(h, sessions, passes).length;

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

/** Hide until it needs you: new turns leave it hidden; Undo as for Hide. */
export function hideUntilNeeded(key: string, o: { title: string; session?: SessionKey }): void {
  write({ ...read(), [key]: { since: new Date().toISOString(), until: "needs" } });
  pushUndo({
    id: `hide|${key}`,
    title: "Hidden until it needs you",
    body: o.title,
    session: o.session,
    undo: () => unhide(key),
  });
}

export const attentionKey = (session: SessionKey, attentionId: string) => `att:${session}|${attentionId}`;
