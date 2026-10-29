// SPDX-License-Identifier: Apache-2.0
// React bindings for the store. One Store per page load, chosen in main.tsx (real or mock).
import type {
  Attention,
  LabelColor,
  Labels,
  MachineSummary,
  SessionKey,
  SessionState,
  SessionSummary,
} from "@shared/api";
import { LABEL_DEFAULT_NAMES, SESSION_STATES } from "@shared/api";
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
// The one reading of `answerable` the strip and the inbox share (an older server leaves the field unset).
import { answerable } from "../components/ControlStrip";
import { sessionTitle } from "../lib/format";
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
 *  it says it is still connecting, with Retry now. A receiver answers in well under a
 *  second, so this is a wait worth saying out loud, not a failure: the stream stays open. */
export const SLOW_FIRST_LOAD_MS = 6000;

/** A page before its first snapshot: "loading" (the skeleton), "slow" (still connecting
 *  after SLOW_FIRST_LOAD_MS), "down" (the stream failed; the transport retries); null
 *  once loaded. No page sits on a skeleton without saying why. */
export function useFirstLoad(): "loading" | "slow" | "down" | null {
  const { connection, snapshotAt } = useAppState();
  const waiting = !snapshotAt && (connection === "live" || connection === "connecting");
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const t = window.setTimeout(() => setSlow(true), SLOW_FIRST_LOAD_MS);
    return () => window.clearTimeout(t);
  }, [waiting]);
  if (snapshotAt) return null;
  if (!waiting) return "down";
  return slow ? "slow" : "loading";
}

/** How long a drop has to last before the lists say so: a blip is never drawn. */
const DOWN_GRACE_MS = 400;

/** The instant the stream went down, once it has been down DOWN_GRACE_MS (the shell's
 *  footer says "Reconnecting" at the same moment); null while live, connecting for the
 *  first time, or within the grace. The board keeps its rows and stops their clocks at
 *  this instant (POLISH-PLAN.md §6 #17). */
export function useStreamDown(): number | null {
  const { connection, snapshotAt } = useAppState();
  const down = !!snapshotAt && (connection === "reconnecting" || connection === "offline");
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    if (!down) {
      setAt(null);
      return;
    }
    const began = Date.now();
    const t = window.setTimeout(() => setAt(began), DOWN_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [down]);
  return down ? at : null;
}

/** One session's summary: re-renders only when that session changes, not on every event
 *  of every other session (a whole-state subscription did, at one render per event). */
export function useSession(key: SessionKey): SessionSummary | undefined {
  const store = useStore();
  const read = useCallback(() => store.get().sessions.get(key), [store, key]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** The sessions that name `key` as their launcher, newest first. The array is kept until
 *  the set, a title or a state changes, so a launcher's page follows runs that start later. */
export function useLaunched(key: SessionKey): SessionSummary[] {
  const store = useStore();
  const last = useRef<{ sig: string; list: SessionSummary[] }>({ sig: "", list: [] });
  const read = useCallback(() => {
    const list: SessionSummary[] = [];
    for (const s of store.get().sessions.values()) if (s.launchedBy === key && s.key !== key) list.push(s);
    list.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.key.localeCompare(b.key));
    // What the header renders: the title as sessionTitle derives it, and the state.
    // ...and the start, which the menu's "ago" and the order read.
    const sig = list.map((s) => `${s.key}\u0000${sessionTitle(s)}\u0000${s.state}\u0000${s.startedAt}`).join("\u0001");
    if (sig !== last.current.sig) last.current = { sig, list };
    return last.current.list;
  }, [store, key]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/** The person's colour labels (the whole document: names and every session's). */
export function useLabels(): Labels {
  const store = useStore();
  const read = useCallback(() => store.get().labels, [store]);
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

/** The board's order: by state, then, within a state, newest session first by when it
 *  started, a key that never changes while it lives. Ordering by the last event made a
 *  group re-sort on every event (9 swaps in 20 s under the pointer); a row now moves only
 *  when it changes section. The key breaks a tie so two renders never disagree. The name
 *  is kept for its callers (the palette). */
export const byStateThenRecent = (a: SessionSummary, b: SessionSummary) =>
  STATE_RANK[a.state] - STATE_RANK[b.state] ||
  b.startedAt.localeCompare(a.startedAt) ||
  (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** All sessions, top-level ones sorted by state then start, with children attached. */
export function useSessionTree(): {
  all: SessionSummary[];
  roots: SessionSummary[];
  childrenOf: ReadonlyMap<SessionKey, SessionSummary[]>;
} {
  const { sessions } = useAppState();
  return useMemo(() => {
    const all = [...sessions.values()];
    const childrenOf = new Map<SessionKey, SessionSummary[]>();
    const roots: SessionSummary[] = [];
    for (const s of all) {
      if (s.parentId) {
        const pk: SessionKey = `${s.harness}:${s.parentId}`;
        if (sessions.has(pk)) {
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
  /** A control `permission.answer` can reach it (shared/api.ts `Attention.answerable`). */
  answerable: boolean;
}

/** Every open attention across every session, newest first. */
export function openAttentions(sessions: ReadonlyMap<SessionKey, SessionSummary>): OpenAttention[] {
  const out: OpenAttention[] = [];
  for (const session of sessions.values())
    for (const attention of session.openAttentions)
      out.push({ session, attention, answerable: attention.kind === "permission" && answerable(attention) });
  return out.sort((a, b) => b.attention.at.localeCompare(a.attention.at));
}

export function useOpenAttentions(): OpenAttention[] {
  const { sessions } = useAppState();
  return useMemo(() => openAttentions(sessions), [sessions]);
}

/** Open attentions a person can answer from here: the inbox badge and the title's "(n)". */
export function useAnswerableCount(): number {
  return useOpenAttentions().filter((r) => r.answerable).length;
}
