// SPDX-License-Identifier: Apache-2.0
// Since you looked: which sessions have news the person has not seen yet. A session is
// read up to the `newsAt` it had when it was on screen (server/ui/marks.ts keeps that on
// every device); news after it, a turn ended or the session ended, makes it unread until
// it is seen again or marked read. Only settled rows (idle, done) are ever unread: a row
// that needs you or is working says so already. The row draws it as its lead glyph filled
// in (bits.tsx StateDot), nothing more.
// The hooks that read it on screen (useUnread, useSeen, useUnreadKeys) are in
// data/hooks.ts; this file stays pure but for the send queue.
import type { Marks, MarksPatch, SessionKey, SessionSummary } from "@shared/api";
import type { Store } from "../data/store";

/** Whether a session has news since the person last looked. An older server sends no
 *  `since`, and then nothing is unread. */
export function isUnread(s: Pick<SessionSummary, "key" | "state" | "attended" | "newsAt">, marks: Marks): boolean {
  if (s.state !== "idle" && s.state !== "done") return false;
  if (!marks.since) return false;
  if (marks.unread[s.key]) return true;
  // An unattended run is quiet on the board (lib/runs.ts quietRun); it never asks to be read.
  return s.attended !== false && !!s.newsAt && s.newsAt > (marks.read[s.key] ?? marks.since);
}

/** Whether "Mark as read" / "Mark as unread" and `u` apply: only a row that can draw
 *  unread, a settled session the board shows (a subagent's row draws no mark). */
export function canMark(s: Pick<SessionSummary, "state" | "parentId">): boolean {
  return (s.state === "idle" || s.state === "done") && !s.parentId;
}

/** Mark sessions read up to the news they carry now, or unread. A manual mark goes at
 *  once and takes back whatever the seen marks still had queued for those keys. */
export function setUnread(store: Store, sessions: readonly SessionSummary[], unread: boolean): void {
  if (!sessions.length) return;
  for (const s of sessions) dropQueued(s.key);
  const p: MarksPatch = unread
    ? { unread: Object.fromEntries(sessions.map((s) => [s.key, true as const])) }
    : {
        unread: Object.fromEntries(sessions.map((s) => [s.key, null])),
        read: Object.fromEntries(sessions.filter((s) => s.newsAt).map((s) => [s.key, s.newsAt!])),
      };
  store.patchMarks(p).catch((e) => console.warn("marks not saved:", (e as Error).message));
}

// ----- seen on screen, sent at most once every SEND_EVERY_MS -----

/** How long a session must be on screen, in a visible and focused window, to count as seen. */
export const SEEN_AFTER_MS = 1000;
/** Seen marks go out together, at most this often. */
export const SEND_EVERY_MS = 2000;

let queued: { read: Record<SessionKey, string>; unread: Record<SessionKey, null> } = { read: {}, unread: {} };
let lastSent = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function dropQueued(key: SessionKey): void {
  delete queued.read[key];
  delete queued.unread[key];
}

function flush(store: Store): void {
  timer = null;
  const p: MarksPatch = {};
  if (Object.keys(queued.read).length) p.read = queued.read;
  if (Object.keys(queued.unread).length) p.unread = queued.unread;
  queued = { read: {}, unread: {} };
  if (!p.read && !p.unread) return;
  lastSent = Date.now();
  store.patchMarks(p).catch((e) => console.warn("marks not saved:", (e as Error).message));
}

/** Queue a seen session: read up to `newsAt`, and its manual unread cleared when asked. */
export function markSeen(store: Store, key: SessionKey, newsAt: string | undefined, clearUnread: boolean): void {
  const marks = store.get().marks;
  // An older server keeps no marks.
  if (!marks.since) return;
  if (newsAt && newsAt > (marks.read[key] ?? marks.since)) queued.read[key] = newsAt;
  if (clearUnread && marks.unread[key]) queued.unread[key] = null;
  if (!(key in queued.read) && !(key in queued.unread)) return;
  if (timer) return;
  timer = setTimeout(() => flush(store), Math.max(0, lastSent + SEND_EVERY_MS - Date.now()));
}
