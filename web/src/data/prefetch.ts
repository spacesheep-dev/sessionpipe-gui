// SPDX-License-Identifier: Apache-2.0
// Opening a session is instant when the pointer said it was coming (BENCHMARK.md move 5):
// a pointer resting 80 ms on a row, or the keyboard cursor resting 150 ms, fetches that
// session's first page (the query SessionView's cold open asks for) and keeps it for a
// few seconds. SessionView's cold open takes it (`takeWarm`) instead of asking again,
// with every event of that session the stream brought meanwhile, so nothing between the
// two is lost (SessionView merges by seq). An unused answer just expires; nothing is
// fetched twice within its life.
import type { DetailQuery, SessionDetail, SessionSummary, StoredEvent } from "@shared/api";
import type { FocusEvent, PointerEvent } from "react";
import type { Store } from "./store";

const POINTER_MS = 80;
const KEYBOARD_MS = 150;
/** How long a warmed answer is good for. */
const KEEP_MS = 8000;

/** The newest page a session opens on (SessionView's cold open), slim: the full event
 *  is fetched only when a row is expanded. */
export const TAIL = 100;
/** Characters of each tool input/output or transcript kept in a list page. */
export const LIST_PREVIEW = 400;
const COLD: DetailQuery = { tail: true, limit: TAIL, slim: true, preview: LIST_PREVIEW };

interface Warm {
  at: number;
  answer: Promise<SessionDetail>;
  /** Events of this session the stream brought after the fetch went out. */
  since: StoredEvent[];
  off: () => void;
}

const warm = new Map<string, Warm>();

function drop(key: string): void {
  const w = warm.get(key);
  if (!w) return;
  w.off();
  warm.delete(key);
}

/** Fetch a session's first page ahead of its open. */
export function prefetchSession(store: Store, s: Pick<SessionSummary, "harness" | "id" | "key">): void {
  const key = `${s.harness}:${s.id}`;
  const had = warm.get(key);
  if (had && Date.now() - had.at < KEEP_MS) return;
  drop(key);
  const since: StoredEvent[] = [];
  const off = store.onEvent((e) => {
    if (`${e.harness.name}:${e.session.id}` === key) since.push(e);
  });
  const answer = store.transport.session(s.harness, s.id, COLD);
  const w: Warm = { at: Date.now(), answer, since, off };
  warm.set(key, w);
  answer.catch(() => drop(key));
  window.setTimeout(() => {
    if (warm.get(key) === w) drop(key);
  }, KEEP_MS);
}

/** The cold open's answer fetched ahead for `key` ("harness:id"), if still fresh, with
 *  the events streamed since; taking it removes it. */
export function takeWarm(key: string): { answer: Promise<SessionDetail>; since: StoredEvent[] } | undefined {
  const w = warm.get(key);
  if (!w) return undefined;
  drop(key);
  return Date.now() - w.at < KEEP_MS ? w : undefined;
}

/** Props for a row (or its wrapper) that warm its session on a resting pointer or a
 *  resting keyboard cursor. A pointer that only passes over does nothing. */
export function prefetchProps(store: Store, s: Pick<SessionSummary, "harness" | "id" | "key">) {
  let timer: number | undefined;
  const arm = (ms: number) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => prefetchSession(store, s), ms);
  };
  const disarm = () => window.clearTimeout(timer);
  return {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType === "mouse") arm(POINTER_MS);
    },
    onPointerLeave: disarm,
    onFocus: (e: FocusEvent) => {
      if ((e.target as HTMLElement).matches?.(":focus-visible")) arm(KEYBOARD_MS);
    },
    onBlur: disarm,
  };
}
