// SPDX-License-Identifier: Apache-2.0
// Owned by: web. A system notification when a new answerable attention arrives on the
// stream while this tab is in the background, and the app badge (installed PWA) with the
// number open. Opt-in per device ("Notify me", in the inbox header and the quick
// settings): the browser's permission is asked once, when the toggle is turned on, and
// the choice lives in localStorage. The first snapshot never notifies: those prompts
// were already waiting when the page opened. Each session's own "Notify me" (synced, in
// marks.json, lib/marks.ts) says how loud it is: Never silences it here, and "When it
// needs me or finishes" adds one notification each time it has news and is idle or done.
import type { NotifyLevel, SessionSummary } from "@shared/api";
import { useEffect, useSyncExternalStore } from "react";
import { type OpenAttention, openAttentions, useAnswerableCount, useStore } from "../data/hooks";
import { ATTENTION_LABEL, oneLine, sessionTitle, toolLabel } from "./format";
import { effectiveNotify } from "./marks";
import { navigate, sessionPath } from "./router";

const KEY = "sessionpipe-gui.notify";

export type NotifyPermission = NotificationPermission | "unsupported";

export interface NotifyState {
  /** The person asked for notifications here (and the browser allowed them). */
  on: boolean;
  permission: NotifyPermission;
}

const permission = (): NotifyPermission =>
  typeof Notification === "undefined" ? "unsupported" : Notification.permission;

const read = (): NotifyState => {
  let want = false;
  try {
    want = localStorage.getItem(KEY) === "1";
  } catch {
    // private mode or blocked storage: off
  }
  const p = permission();
  return { on: want && p === "granted", permission: p };
};

let state: NotifyState = read();
const listeners = new Set<() => void>();
const commit = (next: NotifyState) => {
  state = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useNotifyPref(): NotifyState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** Turns notifications on (asking the browser once, if it has not been asked) or off.
 *  Resolves to the resulting state: `on` stays false when the browser refused. */
export async function setNotifyPref(on: boolean): Promise<NotifyState> {
  let p = permission();
  if (on && p === "default") {
    try {
      p = await Notification.requestPermission();
    } catch {
      p = permission();
    }
  }
  const want = on && p === "granted";
  try {
    if (want) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // the choice lasts for this page only
  }
  commit({ on: want, permission: p });
  return state;
}

/** Whether a notification would reach anyone: the page is not the one being looked at. */
const inBackground = (): boolean => document.visibilityState !== "visible" || !document.hasFocus();

/** What a moment is, for a notification: a prompt opened (`answerable` when a control
 *  answer can reach it), or a session's news (`newsAt`) moved on while it is idle or done. */
export type NotifyMoment = { kind: "attention"; answerable: boolean } | { kind: "finished" };

/** Whether one moment notifies a session at `level`, before the page's own conditions
 *  (Notify me on, the tab in the background). Nobody attends an unattended run. */
export function shouldNotify(m: NotifyMoment, level: NotifyLevel, attended: boolean | undefined): boolean {
  if (attended === false || level === "never") return false;
  return m.kind === "attention" ? m.answerable : level === "finishes";
}

/** The moment a session's change is, given the `newsAt` seen before it: "finished" when
 *  its news moved on and it is idle or done. A tool call, progress or a prompt never moves
 *  `newsAt`, and neither does a turn typed at the terminal it is attended at. */
export function finishedMoment(before: string | undefined, s: SessionSummary): NotifyMoment | null {
  if (!s.newsAt || s.newsAt === before || (s.state !== "idle" && s.state !== "done")) return null;
  return { kind: "finished" };
}

/** The `newsAt` a session's next finish is read against: what it had when it was last
 *  idle or done (or first seen), not the summary before this one. News that moves while
 *  it still works (a subagent open, background work) is not a finish then, and the same
 *  news must still read as one when it settles; compared with the previous summary alone,
 *  it never did. `told` is the page's memory of that, per session, updated here. */
export function newsBefore(
  told: Map<string, string | undefined>,
  s: SessionSummary,
  was: SessionSummary | undefined,
): string | undefined {
  const before = told.has(s.key) ? told.get(s.key) : was?.newsAt;
  if (!told.has(s.key) || s.state === "idle" || s.state === "done") told.set(s.key, s.newsAt);
  return before;
}

/** Whether a "finished" raised for this news is raised again with the turn's own answer.
 *  A turn's transcript lands just after its end (spec PROTOCOL.md, turn.transcript), so
 *  the answer the end carried was the turn before's. Only while it is still idle or done:
 *  a new turn's answer is not this one's. */
export function answerCame(
  raisedFor: string | undefined,
  before: SessionSummary | undefined,
  s: SessionSummary,
): boolean {
  if (!raisedFor || raisedFor !== s.newsAt || (s.state !== "idle" && s.state !== "done")) return false;
  return !!before && before.lastAssistant !== s.lastAssistant;
}

/** The notification for one attention. */
function show(r: OpenAttention): void {
  const s = r.session;
  const a = r.attention;
  const title = `${sessionTitle(s)} needs you · ${a.tool ? toolLabel(a.tool) : (ATTENTION_LABEL[a.kind] ?? a.kind)}`;
  raise(title, { body: a.message ? oneLine(a.message, 160) : undefined, tag: `${s.key}|${a.attentionId}` }, "/inbox");
}

/** "<title> finished", with its last answer; a newer one replaces it, and a click opens
 *  the session. A new finish sounds again even when the last one is still in the
 *  notification centre (`renotify`); the same finish raised again with its answer
 *  replaces it quietly. */
export function showFinished(s: SessionSummary, again = false): void {
  const body = s.lastAssistant ? oneLine(s.lastAssistant, 160) : undefined;
  const tag = `${s.key}|finished`;
  raise(`${sessionTitle(s)} finished`, { body, tag, renotify: !again }, sessionPath(s.harness, s.id));
}

/** From the page when the browser allows it there (desktops), else through the service
 *  worker's registration (Android requires it); a click opens `url`. `renotify` is
 *  Chrome's, missing from the DOM types; other browsers ignore it. */
function raise(title: string, o: NotificationOptions & { renotify?: boolean }, url: string): void {
  const options: NotificationOptions = { ...o, icon: "/brand/apple-touch-icon.png", data: { url } };
  try {
    const n = new Notification(title, options);
    n.onclick = () => {
      window.focus();
      navigate(url);
      n.close();
    };
  } catch {
    navigator.serviceWorker
      ?.getRegistration()
      .then((reg) => reg?.showNotification(title, options))
      .catch(() => {});
  }
}

/** The per-tab watcher: notifies on each answerable attention the stream adds after the
 *  first snapshot (when this tab is in the background and notifications are on), and keeps
 *  the app badge at the number open. Mounted once, in App. */
export function useAttentionEffects(): void {
  const store = useStore();
  useEffect(() => {
    /** Ids known so far; null until the first snapshot, which only seeds it. */
    let known: Set<string> | null = null;
    /** The sessions as last seen (the store replaces the map on every change). */
    let prev: ReadonlyMap<string, SessionSummary> = new Map();
    /** The `newsAt` each "finished" was raised for, until the turn's answer comes. */
    const raised = new Map<string, string>();
    /** The `newsAt` each session last settled with (newsBefore). */
    const told = new Map<string, string | undefined>();
    const check = () => {
      const st = store.get();
      if (!st.snapshotAt) return;
      const rows = openAttentions(st.sessions).filter((r) => r.answerable);
      const ids = new Set(rows.map((r) => `${r.session.key}|${r.attention.attentionId}`));
      const seen = prev;
      prev = st.sessions;
      // Read on every pass, foreground or not: a finish seen while the page was looked
      // at is not raised later.
      const before = new Map<string, string | undefined>();
      for (const s of st.sessions.values()) before.set(s.key, newsBefore(told, s, seen.get(s.key)));
      for (const k of told.keys()) if (!st.sessions.has(k)) told.delete(k);
      if (known === null) {
        known = ids;
        return;
      }
      const fresh = rows.filter((r) => !known?.has(`${r.session.key}|${r.attention.attentionId}`));
      known = ids;
      if (!state.on || !inBackground()) {
        raised.clear();
        return;
      }
      const level = (s: SessionSummary) => effectiveNotify(s, st.marks, st.sessions);
      // Oldest first, so the newest ends up on top of the stack.
      for (const r of fresh.reverse())
        if (shouldNotify({ kind: "attention", answerable: true }, level(r.session), r.session.attended)) show(r);
      for (const s of st.sessions.values()) {
        const was = seen.get(s.key);
        const m = finishedMoment(before.get(s.key), s);
        if (m) {
          raised.delete(s.key);
          if (!shouldNotify(m, level(s), s.attended)) continue;
          showFinished(s);
          raised.set(s.key, s.newsAt!);
        } else if (answerCame(raised.get(s.key), was, s)) {
          raised.delete(s.key);
          if (shouldNotify({ kind: "finished" }, level(s), s.attended)) showFinished(s, true);
        } else if (s.state !== "idle" && s.state !== "done") raised.delete(s.key);
      }
      for (const k of raised.keys()) if (!st.sessions.has(k)) raised.delete(k);
    };
    check();
    return store.subscribe(check);
  }, [store]);

  const n = useAnswerableCount();
  useEffect(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (n > 0) nav.setAppBadge?.(n).catch(() => {});
    else nav.clearAppBadge?.().catch(() => {});
  }, [n]);
}

/** "(n) " when answerable attentions are open, else nothing: the tab title's prefix. */
export const titlePrefix = (n: number): string => (n > 0 ? `(${n}) ` : "");
