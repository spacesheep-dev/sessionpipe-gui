// SPDX-License-Identifier: Apache-2.0
// The store reads the same over either log: the JSONL files (the server) and the events
// held in memory (a store with no disk under it). Same events in, same board out.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProtocolEvent, StoredEvent } from "../../shared/api.js";
import { tempDir } from "../../test/events.js";
import { Simulation } from "../demo/sim.js";
import { StoreCore } from "./core.js";
import { MemoryLog, utf8Bytes } from "./log.js";
import { Store } from "./store.js";

let tmp: { dir: string; cleanup: () => void };
beforeEach(() => {
  tmp = tempDir("spgui-log-");
  vi.useFakeTimers({ now: Date.parse("2026-11-12T12:00:00Z") });
});
afterEach(() => {
  vi.useRealTimers();
  tmp.cleanup();
});

/** The demo's machines over three hours: every event kind, child sessions among them. */
function demoEvents(n: number): ProtocolEvent[] {
  const sim = new Simulation({ machines: 3, seed: 11, speed: 1, startAt: Date.now() - 3 * 3_600_000 });
  const out: ProtocolEvent[] = [];
  for (let v = 60_000; out.length < n && v < 3 * 3_600_000; v += 60_000) out.push(...sim.advance(v));
  return out.slice(0, n);
}

test("the files and the memory log give one board, one session page, one feed and one digest", async () => {
  const events = demoEvents(3000);
  expect(events.length).toBe(3000);
  const onDisk = new Store(tmp.dir);
  const inMemory = new StoreCore("memory", {}, new MemoryLog());
  for (let i = 0; i < events.length; i += 500) {
    onDisk.ingest(events.slice(i, i + 500), "spacesheep");
    inMemory.ingest(events.slice(i, i + 500), "spacesheep");
  }
  const a = onDisk.snapshot();
  const b = inMemory.snapshot();
  expect(a.sessions.some((s) => s.children > 0)).toBe(true);
  expect(b.sessions).toEqual(a.sessions);
  expect(b.machines).toEqual(a.machines);
  expect(b.stats.storageBytes).toBe(a.stats.storageBytes);
  const busiest = [...a.sessions].sort((x, y) => y.counts.events - x.counts.events)[0]!;
  expect(inMemory.sessionDetail(busiest.key, -1, 1000)).toEqual(onDisk.sessionDetail(busiest.key, -1, 1000));
  const feed = onDisk.feed({ limit: 200 });
  expect(inMemory.feed({ limit: 200 })).toEqual(feed);
  expect(inMemory.feed({ limit: 200, before: feed.cursor })).toEqual(onDisk.feed({ limit: 200, before: feed.cursor }));
  expect(inMemory.digest({})).toEqual(onDisk.digest({}));
  await onDisk.close();
  await inMemory.close();
});

test("a store booted from kept events reads as the one that ingested them", async () => {
  const events = demoEvents(2000);
  const kept: StoredEvent[] = [];
  const first = new StoreCore("memory", {}, new MemoryLog());
  for (let i = 0; i < events.length; i += 500)
    kept.push(...first.ingest(events.slice(i, i + 500), "spacesheep").stored);
  const log = new MemoryLog();
  log.seed(kept);
  const again = new StoreCore("memory", {}, log);
  expect(again.snapshot().sessions).toEqual(first.snapshot().sessions);
  await first.close();
  await again.close();
});

test("the server's store, opened again over its files, reads as it did live, child sessions too", async () => {
  const events = demoEvents(2000);
  const live = new Store(tmp.dir);
  for (let i = 0; i < events.length; i += 500) live.ingest(events.slice(i, i + 500), "spacesheep");
  const before = live.snapshot().sessions;
  expect(before.some((s) => s.children > 0)).toBe(true);
  await live.close();
  const again = new Store(tmp.dir);
  expect(again.snapshot().sessions).toEqual(before);
  await again.close();
});

test("utf8Bytes counts as Buffer does", () => {
  for (const s of ["", "abc", "é", "€", "😀", "a\ud83d", "\ude00b", "\u0000߿ࠀ￿", '{"t":"日本語"}'])
    expect(utf8Bytes(s), JSON.stringify(s)).toBe(Buffer.byteLength(s, "utf8"));
});
