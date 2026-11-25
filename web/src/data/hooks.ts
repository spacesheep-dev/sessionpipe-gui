// SPDX-License-Identifier: Apache-2.0
// React bindings for the store. One Store per page load, chosen in main.tsx (real or mock).
import type {
  Arrangement,
  Attention,
  LabelColor,
  Labels,
  LimitsEntry,
  MachineSummary,
  SessionKey,
  SessionState,
  SessionSummary,
} from "@shared/api";
import { isEmptySession, LABEL_DEFAULT_NAMES, SESSION_STATES } from "@shared/api";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useBehind } from "../account/current";
// The one reading of `answerable` the strip and the inbox share (an older server leaves the field unset).
import { answerable } from "../components/ControlStrip";
import { type AnswerOut, answersOut } from "../control/answers";
import { answerLate, useAnswerClock } from "../lib/answerWindow";
import { isQuestion } from "../lib/format";
import { type Hidden, isHidden, useHidden } from "../lib/hidden";
import { canMark, isUnread, markSeen, SEEN_AFTER_MS, setUnread } from "../lib/marks";
import { useShortcut } from "../lib/shortcuts";
import type { AppState, Store } from "./store";

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("StoreContext missing");
  return s;
}

export function useAppState(): AppState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function useConnection() {
  const s = useAppState();
  return { connection: s.connection, retryAt: s.retryAt, snapshotAt: s.snapshotAt };
}

/** How long a page shows its skeleton while the first snapshot is on its way; past this
 *  it says it is still connecting, with Retry. A receiver answers in well under a
 *  second, so this is a wait worth saying out loud, not a failure: the stream stays open. */
export const SLOW_FIRST_LOAD_MS = 6000;

/** A page before its first snapshot: "loading" (the skeleton), "slow" (still connecting
 *  after SLOW_FIRST_LOAD_MS), "down" (the stream failed; the transport retries); null
 *  once loaded. No page sits on a skeleton without saying why: an account with history
 *  still to come (account/current.ts useBehind) is not slow, even at spacesheep's limit
 *  (it reads on by itself), and its page bar says "Catching up…". */
export function useFirstLoad(): "loading" | "slow" | "down" | null {
  const { connection, snapshotAt } = useAppState();
  const behind = useBehind();
  const up = connection === "live" || connection === "connecting";
  const waiting = !snapshotAt && !behind && up;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const t = window.setTimeout(() => setSlow(true), SLOW_FIRST_LOAD_MS);
    return () => window.clearTimeout(t);
  }, [waiting]);
  if (snapshotAt) return null;
  if (!up) return "down";
  if (behind) return "loading";
  return slow ? "slow" : "loading";
}

/** How long a drop has to last before the lists say so: a blip is never drawn. */
const DOWN_GRACE_MS = 400;

/** The instant the stream went down, once it has been down DOWN_GRACE_MS (the page bar
 *  says "Reconnecting…" at the same moment); null while live, connecting for the first
 *  time, or within the grace. The board keeps its rows and stops their clocks at this
 *  instant (POLISH-PLAN.md §6 #17), and a session's composer waits from it. A reader that
 *  mounts while the stream is already down (a page opened during a drop) is down at once,
 *  as the bar is: the grace is for a drop it watched begin. */
export function useStreamDown(): number | null {
  const { connection, snapshotAt } = useAppState();
  const down = !!snapshotAt && (connection === "reconnecting" || connection === "offline");
  const [at, setAt] = useState<number | null>(() => (down ? Date.now() : null));
  useEffect(() => {
    if (!down) {
      setAt(null);
      return;
    }
    const began = Date.now();
    const t = window.setTimeout(() => setAt((was) => was ?? began), DOWN_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [down]);
  return down ? at : null;
}

/** Says on <html> that the stream is down (`data-stream="down"`, from the same instant as
 *  useStreamDown), so a surface can go quiet in its stylesheet alone. Mounted once, by
 *  the shell. */
export function useStreamMark(): void {
  const down = useStreamDown() !== null;
  useEffect(() => {
    const root = document.documentElement;
    if (down) root.dataset.stream = "down";
    else delete root.dataset.stream;
    return () => {
      delete root.dataset.stream;
    };
  }, [down]);
}

/** How many times the stream has come back with a fresh snapshot (AppState.resyncs):
 *  what a page read on its own, it reads again when this moves. */
export function useResyncs(): number {
  const store = useStore();
  const read = useCallback(() => store.get().resyncs, [store]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** One session's summary: re-renders only when that session changes, not on every event
 *  of every other session (a whole-state subscription did, at one render per event). */
export function useSession(key: SessionKey): SessionSummary | undefined {
  const store = useStore();
  const read = useCallback(() => store.get().sessions.get(key), [store, key]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** The person's colour labels (the whole document: names and every session's). */
export function useLabels(): Labels {
  const store = useStore();
  const read = useCallback(() => store.get().labels, [store]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** How the person arranged the session tree (lib/tree.ts reads it). */
export function useArrangement(): Arrangement {
  const store = useStore();
  const read = useCallback(() => store.get().arrangement, [store]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** Each account's newest usage limits (the whole list; it changes only when a report
 *  does). The page words them (web/src/lib/limits.ts). */
export function useLimits(): readonly LimitsEntry[] {
  const store = useStore();
  const read = useCallback(() => store.get().limits, [store]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** One session's label and what it is called, or undefined: re-renders only when that
 *  session's label (or that label's name) changes. */
export function useLabel(key: SessionKey): { color: LabelColor; name: string } | undefined {
  const store = useStore();
  const readColor = useCallback(() => store.get().labels.sessions[key], [store, key]);
  const color = useSyncExternalStore(store.subscribe, readColor, readColor);
  const readName = useCallback(
    () => (color ? (store.get().labels.names[color] ?? LABEL_DEFAULT_NAMES[color]) : undefined),
    [store, color],
  );
  const name = useSyncExternalStore(store.subscribe, readName, readName);
  return useMemo(() => (color && name ? { color, name } : undefined), [color, name]);
}

// ----- read marks (lib/marks.ts) -----

/** A row's unread, re-rendering only when it flips. */
export function useUnread(s: SessionSummary): boolean {
  const store = useStore();
  const read = useCallback(() => isUnread(s, store.get().marks), [store, s]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** On screen: the page is visible and its window has focus. */
const looking = () => document.visibilityState === "visible" && document.hasFocus();

/** Marks a session read once it has been on screen for SEEN_AFTER_MS, and each newer
 *  `newsAt` after another SEEN_AFTER_MS while it stays there. A manual unread is cleared
 *  only on arriving (the session opened, the window come back to): marked unread while on
 *  screen, it stays unread until the person leaves and comes back. `key` null: nothing. */
export function useSeen(key: SessionKey | null): void {
  const store = useStore();
  const readNews = useCallback(() => (key ? store.get().sessions.get(key)?.newsAt : undefined), [store, key]);
  const newsAt = useSyncExternalStore(store.subscribe, readNews, readNews);
  // Before the first snapshot there are no marks to go by (no `since`): a second spent then
  // would spend the arrival too, so the second starts once they come.
  const readReady = useCallback(() => !!store.get().marks.since, [store]);
  const ready = useSyncExternalStore(store.subscribe, readReady, readReady);
  const [here, setHere] = useState(looking);
  useEffect(() => {
    const update = () => setHere(looking());
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    update();
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);
  // Arriving is a new key, or the window coming back: the first mark after it may clear a
  // manual unread, the ones while it stays only move the read mark.
  const arrived = useRef(true);
  const shown = useRef(key);
  if (shown.current !== key) {
    shown.current = key;
    arrived.current = true;
  }
  if (!here) arrived.current = true;
  useEffect(() => {
    if (!key || !here || !ready) return;
    const t = window.setTimeout(() => {
      markSeen(store, key, newsAt, arrived.current);
      arrived.current = false;
    }, SEEN_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [store, key, here, ready, newsAt]);
}

/** `u` marks what a list's cursor is on read when it is unread, else unread; on a row that
 *  can draw neither it does nothing. */
export function useUnreadKeys(sessions: () => readonly SessionSummary[]): void {
  const store = useStore();
  useShortcut("list.unread", () => {
    const list = sessions().filter(canMark);
    if (!list.length) return false;
    const marks = store.get().marks;
    setUnread(store, list, !list.every((s) => isUnread(s, marks)));
  });
}

/** The machines map alone (it changes at most about once a second). */
export function useMachinesMap(): ReadonlyMap<string, MachineSummary> {
  const store = useStore();
  const read = useCallback(() => store.get().machines, [store]);
  return useSyncExternalStore(store.subscribe, read, read);
}

const STATE_RANK: Record<SessionState, number> = Object.fromEntries(SESSION_STATES.map((s, i) => [s, i])) as Record<
  SessionState,
  number
>;

const newestFirst = (a: SessionSummary, b: SessionSummary) =>
  b.startedAt.localeCompare(a.startedAt) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** The board's order: by state, then, within a state, newest session first by when it
 *  started, a key that never changes while it lives. Ordering by the last event made a
 *  group re-sort on every event (9 swaps in 20 s under the pointer); a row now moves only
 *  when it changes section. The key breaks a tie so two renders never disagree. The name
 *  is kept for its callers (the palette). */
export const byStateThenRecent = (a: SessionSummary, b: SessionSummary) =>
  STATE_RANK[a.state] - STATE_RANK[b.state] || newestFirst(a, b);

/** The same order by the section a row is drawn in (`sectionOf`), which for a parent whose
 *  child needs you is Needs you (pages/Board.tsx). */
export const bySectionThenRecent =
  (sectionOf: (s: SessionSummary) => SessionState) => (a: SessionSummary, b: SessionSummary) =>
    STATE_RANK[sectionOf(a)] - STATE_RANK[sectionOf(b)] || newestFirst(a, b);

/** The sessions a list or a picker offers: every one the store holds but those nothing has
 *  happened in yet (shared/api.ts `isEmptySession`). The same map, so `get` and `values`
 *  read as before; kept while the set does not change. */
export function useListedSessions(): ReadonlyMap<SessionKey, SessionSummary> {
  const { sessions } = useAppState();
  return useMemo(() => {
    let out: Map<SessionKey, SessionSummary> | null = null;
    for (const [k, s] of sessions)
      if (isEmptySession(s)) {
        out ??= new Map(sessions);
        out.delete(k);
      }
    return out ?? sessions;
  }, [sessions]);
}

/** The sessions the lists show, top-level ones sorted by state then start, with children
 *  attached. A session nothing has happened in yet (shared/api.ts `isEmptySession`: a
 *  harness a program started and stopped) is left out until its first turn; its page and
 *  Search still find it. */
export function useSessionTree(): {
  all: SessionSummary[];
  roots: SessionSummary[];
  childrenOf: ReadonlyMap<SessionKey, SessionSummary[]>;
} {
  const { sessions } = useAppState();
  return useMemo(() => {
    const all = [...sessions.values()].filter((s) => !isEmptySession(s));
    const listed = new Set(all.map((s) => s.key));
    const childrenOf = new Map<SessionKey, SessionSummary[]>();
    const roots: SessionSummary[] = [];
    for (const s of all) {
      if (s.parentId) {
        const pk: SessionKey = `${s.harness}:${s.parentId}`;
        // Under a parent the list shows; a child of one it leaves out is a root of its own.
        if (listed.has(pk)) {
          const list = childrenOf.get(pk) ?? [];
          list.push(s);
          childrenOf.set(pk, list);
          continue;
        }
      }
      roots.push(s);
    }
    roots.sort(byStateThenRecent);
    for (const list of childrenOf.values()) list.sort(byStateThenRecent);
    return { all, roots, childrenOf };
  }, [sessions]);
}

export function useMachines(): MachineSummary[] {
  const { machines } = useAppState();
  return useMemo(() => [...machines.values()].sort((a, b) => a.name.localeCompare(b.name)), [machines]);
}

// ----- attentions -----

/** One open attention with the session it belongs to (the inbox's row). */
export interface OpenAttention {
  session: SessionSummary;
  attention: Attention;
  /** A control `permission.answer` can reach it (shared/api.ts `Attention.answerable`), and
   *  can carry its answer: a question's is the option chosen, given on its computer. */
  answerable: boolean;
  /** Its hook stopped waiting for an answer (lib/answerWindow.ts): no longer answerable,
   *  it waits in its terminal. Marked by `markLate`. */
  late?: boolean;
}

/** Every open attention across every session, newest first. */
export function openAttentions(sessions: ReadonlyMap<SessionKey, SessionSummary>): OpenAttention[] {
  const out: OpenAttention[] = [];
  for (const session of sessions.values())
    for (const attention of session.openAttentions)
      out.push({
        session,
        attention,
        answerable: attention.kind === "permission" && answerable(attention) && !isQuestion(attention),
      });
  return out.sort((a, b) => b.attention.at.localeCompare(a.attention.at));
}

/** `rows` with each answerable prompt past its window as of `now` marked late, and no
 *  longer answerable; the same list when none is. */
export function markLate(
  rows: OpenAttention[],
  machines: ReadonlyMap<string, MachineSummary>,
  now: number,
): OpenAttention[] {
  const late = (r: OpenAttention) =>
    r.answerable &&
    answerLate(
      r.attention,
      r.session.machine ? machines.get(r.session.machine)?.control : undefined,
      r.session.harness,
      now,
    );
  return rows.some(late) ? rows.map((r) => (late(r) ? { ...r, answerable: false, late: true } : r)) : rows;
}

/** Every open attention, newest first; a prompt turns late (`markLate`) as its window
 *  runs out. */
export function useOpenAttentions(): OpenAttention[] {
  const { sessions, machines } = useAppState();
  const all = useMemo(() => openAttentions(sessions), [sessions]);
  const now = useAnswerClock(all.filter((r) => r.answerable).map((r) => r.attention));
  return markLate(all, machines, now);
}

/** Every open prompt of `s` has its answer out, or its computer closed it
 *  (control/answers.ts): it needs nobody now, though it waits for its computer to say so. */
export const answeredAll = (s: SessionSummary, out: Readonly<Record<string, AnswerOut>>): boolean =>
  s.openAttentions.length > 0 && s.openAttentions.every((a) => !!out[a.attentionId]);

/** Whether a session waits on you, as the badge counts it: it needs you, is not hidden on
 *  this device in that state, and has no prompt left without an answer out. */
export const needsYouNow = (
  s: SessionSummary,
  hidden: Readonly<Hidden>,
  out: Readonly<Record<string, AnswerOut>>,
): boolean => s.state === "needs_you" && !isHidden(hidden, s.key, s.stateSince, true) && !answeredAll(s, out);

/** The sessions that need you: the inbox badge, the title's "(n)" and the app's badge, the
 *  same number the Board's Needs you (a child under its parent included), the Dock and the
 *  menu bar count. Every session in that state, the Board's filters or not, less one
 *  hidden on this device and one whose every prompt has its answer out, from the moment
 *  the answer went. */
export function useNeedsYouCount(): number {
  const store = useStore();
  const { sessions, control } = useAppState();
  const hidden = useHidden();
  const waiting = useMemo(
    () => [...sessions.values()].filter((s) => s.state === "needs_you" && !isHidden(hidden, s.key, s.stateSince, true)),
    [sessions, hidden],
  );
  // Which prompts have an answer out is the activity's word: read it while one waits.
  const asks = waiting.length > 0;
  useEffect(() => {
    if (asks) store.loadControl();
  }, [store, asks]);
  const out = useMemo(
    () =>
      answersOut(
        control,
        waiting.flatMap((s) => s.openAttentions),
      ),
    [control, waiting],
  );
  return waiting.filter((s) => needsYouNow(s, hidden, out)).length;
}
