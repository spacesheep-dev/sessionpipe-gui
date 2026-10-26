// SPDX-License-Identifier: Apache-2.0
// The transport's stream: what it does when the first frame, the snapshot, never comes.
import "../native/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EventSourceLike, shellStreams } from "../lib/net";
import { createHttpTransport, SNAPSHOT_LIMIT_MS } from "./transport";

interface Fake extends EventSourceLike {
  on: Map<string, (e: { data: string }) => void>;
  closed: boolean;
}

let opened: Fake[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5); // backoff without jitter: 1 s, 2 s…
  opened = [];
  shellStreams.open = () => {
    const es: Fake = {
      on: new Map(),
      closed: false,
      onopen: null,
      onerror: null,
      addEventListener: (k, fn) => void es.on.set(k, fn),
      close: () => {
        es.closed = true;
      },
    };
    opened.push(es);
    return es;
  };
});
afterEach(() => {
  shellStreams.open = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const snapshot = JSON.stringify({ kind: "snapshot", snapshot: { at: "x" } });

describe("the stream's first snapshot", () => {
  it("one that never arrives fails the stream, which reopens (and says so)", async () => {
    const h = { onMessage: vi.fn(), onOpen: vi.fn(), onError: vi.fn() };
    const stop = createHttpTransport().openStream(h);
    opened[0]?.onopen?.();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_LIMIT_MS - 1);
    expect(h.onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.onError).toHaveBeenCalledOnce();
    expect(opened[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(opened).toHaveLength(2);
    // The next one gets twice as long: a merely slow snapshot gets through.
    await vi.advanceTimersByTimeAsync(SNAPSHOT_LIMIT_MS * 2 - 1);
    expect(h.onError).toHaveBeenCalledOnce();
    opened[1]?.on.get("snapshot")?.({ data: snapshot });
    expect(h.onMessage).toHaveBeenCalledWith({ kind: "snapshot", snapshot: { at: "x" } });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_LIMIT_MS * 10);
    expect(h.onError).toHaveBeenCalledOnce();
    stop();
    expect(opened[1]?.closed).toBe(true);
  });

  it("a snapshot in time, then quiet: the stream stays", async () => {
    const h = { onMessage: vi.fn(), onOpen: vi.fn(), onError: vi.fn() };
    const stop = createHttpTransport().openStream(h);
    opened[0]?.on.get("snapshot")?.({ data: snapshot });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_LIMIT_MS * 10);
    expect(h.onError).not.toHaveBeenCalled();
    expect(opened).toHaveLength(1);
    stop();
  });
});
