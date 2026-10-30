// SPDX-License-Identifier: Apache-2.0
// Since you looked: which sessions have news the person has not seen yet. A session is
// read up to the `newsAt` it had when it was on screen (server/ui/marks.ts keeps that on
// every device); news after it, a turn ended or the session ended, makes it unread until
// it is seen again or marked read. Only settled rows (idle, done) are ever unread: a row
// that needs you or is working says so already. The row draws it as its lead glyph filled
// in (bits.tsx StateDot), nothing more.
// The hooks that read it on screen (useUnread, useSeen, useUnreadKeys) are in
// data/hooks.ts; this file stays pure but for the send queue. The same document keeps each
// session's own "Notify me" (`notify`): how loud it is, and the submenu that sets it.
import {
  type Marks,
  type MarksPatch,
  type NotifyLevel,
  type SessionKey,
  type SessionSummary,
  sessionKey,
  splitKey,
} from "@shared/api";
import type { MenuItem } from "../components/ContextMenu";
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

// ----- Notify me: how loud each session is (marks.notify) -----

/** Quietest first: a level only ever caps the ones after it. */
const LOUDNESS: readonly NotifyLevel[] = ["never", "needs", "finishes"];
const quieter = (a: NotifyLevel, b: NotifyLevel): NotifyLevel => (LOUDNESS.indexOf(a) <= LOUDNESS.indexOf(b) ? a : b);

/** A session's own level, as the person set it; absent is the default, "needs". */
export const ownNotify = (marks: Marks, key: SessionKey): NotifyLevel => marks.notify?.[key] ?? "needs";

/** What caps a session: the quietest level set on purpose among its ancestors, and
 *  whether that one is its own parent; undefined when no ancestor has one. An ancestor
 *  left on the default caps nothing. The parents are `parentId`, in the same harness.
 *  When #38's `delegatedBy` lands, it joins `parentId` as a parent here. */
export function notifyCap(
  s: Pick<SessionSummary, "key" | "harness" | "parentId">,
  marks: Marks,
  sessions: ReadonlyMap<SessionKey, SessionSummary>,
): { level: NotifyLevel; parent: boolean } | undefined {
  let cap: { level: NotifyLevel; parent: boolean } | undefined;
  const seen = new Set<SessionKey>([s.key]);
  let id = s.parentId;
  while (id) {
    const key = sessionKey(s.harness, id);
    if (seen.has(key)) break;
    seen.add(key);
    const set = marks.notify?.[key];
    if (set && (!cap || quieter(set, cap.level) !== cap.level)) cap = { level: set, parent: seen.size === 2 };
    id = sessions.get(key)?.parentId;
  }
  return cap;
}

/** How loud a session is: its own level, capped by its ancestors'. A parent can quiet its
 *  children, never make them louder. */
export function effectiveNotify(
  s: Pick<SessionSummary, "key" | "harness" | "parentId">,
  marks: Marks,
  sessions: ReadonlyMap<SessionKey, SessionSummary>,
): NotifyLevel {
  const own = ownNotify(marks, s.key);
  const cap = notifyCap(s, marks, sessions);
  return cap ? quieter(own, cap.level) : own;
}

/** Whether a row draws the bell with a slash: its session is at Never. A row nested
 *  under its parent (`under`) draws it only when the parent isn't, so a muted parent's
 *  children don't each repeat it. */
export function showsNever(
  s: Pick<SessionSummary, "key" | "harness" | "parentId">,
  marks: Marks,
  sessions: ReadonlyMap<SessionKey, SessionSummary>,
  under = false,
): boolean {
  if (effectiveNotify(s, marks, sessions) !== "never") return false;
  const parent = under && s.parentId ? sessions.get(sessionKey(s.harness, s.parentId)) : undefined;
  return !parent || effectiveNotify(parent, marks, sessions) !== "never";
}

/** Whether a banner about `session` may show: none for a session set to Never (itself or
 *  under a parent). One the page doesn't know goes by its own level. */
export function toastAllowed(
  t: { session?: SessionKey },
  marks: Marks,
  sessions: ReadonlyMap<SessionKey, SessionSummary>,
): boolean {
  if (!t.session) return true;
  const s = sessions.get(t.session) ?? { key: t.session, harness: splitKey(t.session).harness };
  return effectiveNotify(s, marks, sessions) !== "never";
}

const NOTIFY_LABEL: Record<NotifyLevel, string> = {
  needs: "When it needs me",
  finishes: "When it needs me or finishes",
  never: "Never",
};

/** The "Notify me" submenu every session menu carries: three choices, the one in effect
 *  checked; under a quieter parent the louder ones are inert and say why. Choosing the
 *  default clears the session's own level. */
export function notifyMenu(store: Store, s: SessionSummary): MenuItem {
  const { marks, sessions } = store.get();
  const cap = notifyCap(s, marks, sessions);
  const now = effectiveNotify(s, marks, sessions);
  const set = (level: NotifyLevel) =>
    void store.patchMarks({ notify: { [s.key]: level === "needs" ? null : level } }).catch(() => {});
  return {
    label: "Notify me",
    items: (["needs", "finishes", "never"] as const).map(
      (level): MenuItem => ({
        label: NOTIFY_LABEL[level],
        checked: now === level,
        radio: true,
        disabled:
          cap && quieter(level, cap.level) !== level
            ? `${cap.parent ? "Its parent session" : "A session above it"} is set to ${NOTIFY_LABEL[cap.level]}`
            : undefined,
        run: () => set(level),
      }),
    ),
  };
}
