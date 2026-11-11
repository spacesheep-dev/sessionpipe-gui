// SPDX-License-Identifier: Apache-2.0
// What an open session view holds of its events: nothing falls between the first page and
// the live ones, and a read after the stream came back only ever adds.
import type { SessionSummary, StoredEvent } from "@shared/api";
import { describe, expect, it } from "vitest";
import { mergeBySeq, REREAD_BACK, REREAD_MAX, rereadQuery, rereadShort, tapSession } from "./sessionFeed";

const KEY = "claude-code:s1";
const ev = (seq: number, type = "tool.ended", id = "s1"): StoredEvent =>
  ({ type, harness: { name: "claude-code" }, session: { id, seq }, data: {} }) as unknown as StoredEvent;
const seqs = (list: readonly StoredEvent[]) => list.map((e) => e.session.seq);

/** A store's event side: `emit` is the stream bringing one. */
function stream() {
  const listeners = new Set<(e: StoredEvent, s: SessionSummary) => void>();
  return {
    listeners,
    onEvent(l: (e: StoredEvent, s: SessionSummary) => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    emit(e: StoredEvent) {
      const s = { key: `${e.harness.name}:${e.session.id}` } as SessionSummary;
      for (const l of listeners) l(e, s);
    },
  };
}

describe("one listener from the open to the close", () => {
  it("holds what arrives while the first page is read, then hands each event straight on, with none between", () => {
    const store = stream();
    const live: StoredEvent[] = [];
    const tap = tapSession(store, KEY, (e) => live.push(e), [ev(3)]);
    store.emit(ev(4));
    store.emit(ev(9, "tool.ended", "another"));
    // The page's answer lands: the held events are merged into it in the same breath…
    const page = mergeBySeq([ev(1), ev(2), ev(3)], tap.release());
    // …and the very next event, before anything has rendered, is not lost.
    store.emit(ev(5));
    store.emit(ev(6));
    expect(seqs(page)).toEqual([1, 2, 3, 4]);
    expect(seqs(live)).toEqual([5, 6]);
    expect(store.listeners.size).toBe(1);
    tap.stop();
    store.emit(ev(7));
    expect(seqs(live)).toEqual([5, 6]);
    expect(store.listeners.size).toBe(0);
  });
});

describe("the read after the stream came back", () => {
  it("adds what the drop kept from the view, in order, and keeps every copy the view held", () => {
    const full = { ...ev(11), data: { output: "the whole output" } } as StoredEvent;
    const held = [ev(10), full, ev(12)];
    // The drop: 13 to 15, and 9, recorded late, among the ones the view had.
    const merged = mergeBySeq(held, [ev(9), ev(10), ev(11), ev(12), ev(13), ev(14), ev(15)]);
    expect(seqs(merged)).toEqual([9, 10, 11, 12, 13, 14, 15]);
    expect(merged[2]).toBe(full);
    expect(merged[1]).toBe(held[0]);
  });

  it("is the same list when nothing was missed, so nothing redraws", () => {
    const held = [ev(1), ev(2)];
    expect(mergeBySeq(held, [ev(1), ev(2)])).toBe(held);
    expect(mergeBySeq(held, [])).toBe(held);
  });

  it("loses nothing when its answer lands after newer live events, or twice", () => {
    // Asked at seq 12; 13 and 14 arrive live before the answer (which ends at 13) does.
    const held = [ev(10), ev(11), ev(12), ev(13), ev(14)];
    const answer = [ev(11), ev(12), ev(13)];
    expect(mergeBySeq(held, answer)).toBe(held);
    const once = mergeBySeq([ev(10)], [ev(11), ev(11), ev(12)]);
    expect(seqs(once)).toEqual([10, 11, 12]);
    expect(seqs(mergeBySeq(once, [ev(11), ev(12)]))).toEqual([10, 11, 12]);
  });

  it("asks forwards from a little before its newest event; a view with nothing reads its newest page", () => {
    expect(rereadQuery([], 100)).toEqual({ tail: true, limit: 100 });
    expect(rereadQuery([ev(4), ev(7)], 100)).toEqual({ after: 3, limit: REREAD_MAX });
    const long = Array.from({ length: 250 }, (_, i) => ev(i * 2));
    expect(rereadQuery(long, 100)).toEqual({ after: long[250 - REREAD_BACK]!.session.seq - 1, limit: REREAD_MAX });
  });

  it("an answer that came back full may have left events out", () => {
    expect(rereadShort(Array.from({ length: REREAD_MAX - 1 }, (_, i) => ev(i)))).toBe(false);
    expect(rereadShort(Array.from({ length: REREAD_MAX }, (_, i) => ev(i)))).toBe(true);
  });
});
