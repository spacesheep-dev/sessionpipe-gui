// SPDX-License-Identifier: Apache-2.0
// The store reads the same over either log: the JSONL files (the server) and the events
// held in memory (a store with no disk under it). Same events in, same board out.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProtocolEvent, StoredEvent } from "../../shared/api.js";
import { Session, tempDir } from "../../test/events.js";
import { Simulation } from "../demo/sim.js";
import { StoreCore } from "./core.js";
import { type EventLog, MemoryLog, utf8Bytes } from "./log.js";
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

/** Everything a page reads from a store, as one value: the board, every session's page
 *  (forward, tail, before, by agent), the feed (filtered four ways, and a second page),
 *  search, files changed, the digest. `ms` (how long a search took) is left out. */
function readings(store: StoreCore, o: { cursors?: boolean } = {}) {
  const snap = store.snapshot();
  const sessions = [...snap.sessions].sort((a, b) => (a.key < b.key ? -1 : 1));
  const busiest = [...sessions].sort((x, y) => y.counts.events - x.counts.events)[0]!;
  const withAgent = sessions.find((s) => s.agents.some((a) => !a.session));
  const agent = withAgent?.agents.find((a) => !a.session)?.id;
  const feed = (q: Parameters<StoreCore["feed"]>[0]) => {
    const page = store.feed(q);
    return o.cursors === false ? page.events.map((e) => e.id) : page;
  };
  const first = store.feed({ limit: 150 });
  const { ms: _ms, ...search } = store.search({ q: "the", limit: 50 });
  return {
    sessions,
    machines: snap.machines,
    storageBytes: snap.stats.storageBytes,
    pages: sessions.map((s) => store.sessionDetail(s.key, -1, 1000)),
    tail: store.sessionDetail(busiest.key, undefined, 20, { tail: true }),
    before: store.sessionDetail(busiest.key, undefined, 20, { before: Math.floor(busiest.counts.events / 2) }),
    slim: store.sessionDetail(busiest.key, -1, 1000, { slim: true }),
    agent: agent ? store.sessionDetail(withAgent!.key, -1, 1000, { agent }) : "no agent in the sample",
    feed: feed({ limit: 150 }),
    next:
      o.cursors === false
        ? "after a boot the arrival numbers are the boot's own"
        : store.feed({ limit: 150, before: first.cursor }),
    byHarness: feed({ limit: 100, harness: busiest.harness }),
    byMachine: feed({ limit: 100, machine: busiest.machine }),
    bySession: feed({ limit: 100, session: busiest.key }),
    byText: feed({ limit: 100, q: "test" }),
    search: o.cursors === false ? search.hits : search,
    files: store.filesChanged({}),
    digest: store.digest({}),
  };
}

/** The demo's events, ingested in batches the way a source hands them over (one
 *  arrival time a batch, so events of many sessions tie on it), with the clock moving
 *  between batches; then a tier-0 copy upgraded to tier 3 and a session forgotten. */
function feedBoth(stores: StoreCore[], events: ProtocolEvent[]): void {
  for (let i = 0; i < events.length; i += 250) {
    vi.advanceTimersByTime(7_000);
    for (const s of stores) s.ingest(events.slice(i, i + 250), i % 500 ? "outbox" : "spacesheep");
  }
  const base = {
    protocol: 1 as const,
    time: new Date(Date.now() - 1_000).toISOString(),
    harness: { name: "claude-code" },
    privacy: { rulesets: ["secrets@1"], pii: false },
  };
  const sess = { id: "upgrade-1", seq: 0, machine: "m-upgrade" };
  const asked = {
    ...base,
    id: "01K00000000000000000000002",
    type: "attention.needed",
    tier: 0 as const,
    session: sess,
    data: { attention_id: "a1", kind: "permission" },
  };
  for (const s of stores) s.ingest([asked], "http");
  vi.advanceTimersByTime(1_000);
  const richer = { ...asked, tier: 3 as const, data: { ...asked.data, tool: "Bash", message: "rm -rf dist" } };
  for (const s of stores) expect(s.ingest([richer], "outbox")).toMatchObject({ duplicates: 1 });
  const gone = [...stores[0]!.snapshot().sessions]
    .filter((x) => x.id !== "upgrade-1")
    .sort((a, b) => a.counts.events - b.counts.events)[0]!.key;
  for (const s of stores) s.forget(gone);
}

test("every reading agrees over the files and the memory log, live and booted again", async () => {
  const events = demoEvents(3000);
  const memory = new MemoryLog();
  const onDisk = new Store(tmp.dir);
  const inMemory = new StoreCore("memory", {}, memory);
  feedBoth([onDisk, inMemory], events);
  const live = readings(onDisk);
  expect(live.sessions.some((s) => s.children > 0)).toBe(true);
  expect(live.agent).not.toBe("no agent in the sample");
  expect(live.files.repos.length).toBeGreaterThan(0);
  expect(live.search.hits.length).toBeGreaterThan(0);
  expect(live.sessions.find((s) => s.id === "upgrade-1")?.maxTier).toBe(3);
  expect(readings(inMemory)).toEqual(live);
  await onDisk.close();
  await inMemory.close();

  // Booted again: the two logs read the same, and what a page sees is what it saw live.
  // (The feed's cursors carry arrival numbers, which a boot gives out again: compared by
  // the events they page through.)
  const diskAgain = new Store(tmp.dir);
  const memoryAgain = new StoreCore("memory", {}, memory);
  const booted = readings(diskAgain, { cursors: false });
  expect(readings(memoryAgain, { cursors: false })).toEqual(booted);
  const { feed: _f, next: _n, byHarness: _h, byMachine: _m, bySession: _s, byText: _t, search: _q, ...liveRest } = live;
  const { feed: f, next: _n2, byHarness: h, byMachine: m, bySession: s2, byText: t, search: q, ...bootRest } = booted;
  expect(bootRest).toEqual(liveRest);
  expect(f).toEqual(live.feed.events.map((e) => e.id));
  expect(h).toEqual(live.byHarness.events.map((e) => e.id));
  expect(m).toEqual(live.byMachine.events.map((e) => e.id));
  expect(s2).toEqual(live.bySession.events.map((e) => e.id));
  expect(t).toEqual(live.byText.events.map((e) => e.id));
  expect(q).toEqual(live.search.hits);
  await diskAgain.close();
  await memoryAgain.close();
});

test("past keepDays, a boot keeps the short preview over either log alike", async () => {
  const events = demoEvents(1500);
  const memory = new MemoryLog();
  const first = [new Store(tmp.dir, { keepDays: 1 }), new StoreCore("memory", { keepDays: 1 }, memory)];
  feedBoth(first, events);
  for (const s of first) await s.close();
  // Two days on: everything ingested is past keepDays.
  vi.advanceTimersByTime(2 * 86_400_000);
  const again = [new Store(tmp.dir, { keepDays: 1 }), new StoreCore("memory", { keepDays: 1 }, memory)];
  const a = readings(again[0]!, { cursors: false });
  expect(readings(again[1]!, { cursors: false })).toEqual(a);
  // Some preview was cut to the old length, so the trimming ran and both did it.
  expect(JSON.stringify(a.slim).includes('"preview"')).toBe(true);
  for (const s of again) s.tick();
  expect(again[1]!.snapshot().sessions).toEqual(again[0]!.snapshot().sessions);
  for (const s of again) await s.close();
});

test("what a reader does to an event it was given is not what the memory log keeps", async () => {
  const log: EventLog = new MemoryLog();
  const store = new StoreCore("memory", {}, log);
  const [ev] = demoEvents(1);
  const { stored } = store.ingest([ev!], "spacesheep");
  const key = store.snapshot().sessions[0]!.key;
  const read = store.sessionDetail(key, -1, 10)!.events[0]!;
  expect(read).toEqual(stored[0]);
  (stored[0]!.data as Record<string, unknown>).changed = "by the caller";
  (read.data as Record<string, unknown>).changed = "by a reader";
  expect(store.sessionDetail(key, -1, 10)!.events[0]!.data).not.toHaveProperty("changed");
  await store.close();
});

test("events that tie on arrival: the memory log boots in the order they came, the files in the folder's order", async () => {
  // One batch is one arrival time, so a boot can only order its sessions by what the log
  // gives back. The memory log gives them in the order they were appended, which is the
  // order they came. The files keep no arrival number: their order is the folder's, as it
  // always was on the server (this branch leaves it so). The two need not agree, since a
  // store only ever boots over its own log and never against the other's: what each must
  // keep is the set, and the memory log the live order too.
  const when = new Date(Date.now() - 30_000).toISOString();
  const parent = new Session("zz-parent");
  const kids = ["m-child", "b-child", "x-child", "a-child"].map((id) => new Session(id));
  const batch = [
    parent.ev("session.started", {}, { time: when }),
    ...kids.flatMap((k) => [
      k.ev("session.started", {}, { time: when, session: { parent_id: "zz-parent" } }),
      k.ev("tool.started", { tool: "Read" }, { time: when, session: { parent_id: "zz-parent" } }),
    ]),
  ];
  const memory = new MemoryLog();
  const live = [new Store(tmp.dir), new StoreCore("memory", {}, memory)];
  for (const s of live) s.ingest(batch, "http");
  const show = (s: StoreCore) => ({
    children: s.sessionDetail("claude-code:zz-parent")!.children.map((c) => c.id),
    agents: s.session("claude-code:zz-parent")!.agents.map((a) => a.id),
    feed: s.feed({}).events.map((e) => `${e.session.id}#${e.session.seq}`),
  });
  const before = show(live[0]!);
  expect(show(live[1]!)).toEqual(before);
  expect(before.children).toEqual(["m-child", "b-child", "x-child", "a-child"]);
  for (const s of live) await s.close();
  const again = [new Store(tmp.dir), new StoreCore("memory", {}, memory)];
  const disk = show(again[0]!);
  const page = show(again[1]!);
  for (const s of again) await s.close();
  expect(page).toEqual(before);
  const sorted = (x: ReturnType<typeof show>) => ({
    children: [...x.children].sort(),
    agents: [...x.agents].sort(),
    feed: [...x.feed].sort(),
  });
  expect(sorted(disk)).toEqual(sorted(before));
});
