// SPDX-License-Identifier: Apache-2.0
// A session's first page fetched ahead of its open: taken with the events streamed since,
// and never one from before the stream last came back.
import "../native/test-env";
import type { SessionDetail, SessionSummary, StoredEvent } from "@shared/api";
import { describe, expect, it } from "vitest";
import { prefetchSession, takeWarm } from "./prefetch";
import type { Store } from "./store";

const ev = (seq: number): StoredEvent =>
  ({
    type: "tool.ended",
    harness: { name: "claude-code" },
    session: { id: "s1", seq },
    data: {},
  }) as unknown as StoredEvent;

function storeAt(resyncs: { n: number }) {
  const listeners = new Set<(e: StoredEvent, s: SessionSummary) => void>();
  const store = {
    get: () => ({ resyncs: resyncs.n }),
    onEvent(l: (e: StoredEvent, s: SessionSummary) => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    transport: { session: async () => ({ events: [ev(1)] }) as unknown as SessionDetail },
  } as unknown as Store;
  const emit = (e: StoredEvent) => {
    for (const l of listeners) l(e, {} as SessionSummary);
  };
  return { store, emit };
}
const s1 = { harness: "claude-code", id: "s1", key: "claude-code:s1" };

describe("a session fetched ahead of its open", () => {
  it("is taken once, with the events the stream brought since", async () => {
    const epoch = { n: 0 };
    const { store, emit } = storeAt(epoch);
    prefetchSession(store, s1);
    emit(ev(2));
    const warm = takeWarm(s1.key, 0);
    expect(warm?.since.map((e) => e.session.seq)).toEqual([2]);
    expect((await warm!.answer).events).toHaveLength(1);
    expect(takeWarm(s1.key, 0)).toBeUndefined();
  });

  it("is not taken when the stream came back in between: the drop's events are in neither part", () => {
    const epoch = { n: 0 };
    const { store, emit } = storeAt(epoch);
    prefetchSession(store, s1);
    emit(ev(2));
    // The stream drops (seq 3 is never heard) and comes back with a fresh snapshot.
    epoch.n = 1;
    emit(ev(4));
    expect(takeWarm(s1.key, epoch.n)).toBeUndefined();
  });
});
