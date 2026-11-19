// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ulid } from "sessionpipe-core";
import { describe, expect, it, vi } from "vitest";
import type { EventSource, ProtocolEvent } from "../../shared/api.js";
import type { Store } from "../store/store.js";
import { startReplay } from "./index.js";
import { planReplay } from "./replay.js";

class FakeStore {
  batches: { events: ProtocolEvent[]; source: EventSource; at: number }[] = [];
  ingest(events: ProtocolEvent[], source: EventSource) {
    this.batches.push({ events, source, at: Date.now() });
    return { accepted: events.length, duplicates: 0, rejected: [], stored: [] };
  }
  get events(): ProtocolEvent[] {
    return this.batches.flatMap((b) => b.events);
  }
}
const asStore = (s: FakeStore) => s as unknown as Store;

const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const event = (
  seq: number,
  atMs: number,
  type = "turn.started",
  data: Record<string, unknown> = {},
): ProtocolEvent => ({
  protocol: 1,
  id: ulid(atMs),
  type,
  time: new Date(atMs).toISOString(),
  tier: 3,
  harness: { name: "claude-code", event: "UserPromptSubmit" },
  session: { id: "s1", seq, machine: "studio-mac" },
  privacy: { rulesets: ["secrets@1"], pii: false },
  data,
});

function fileOf(lines: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spgui-replay-"));
  const file = path.join(dir, "events.jsonl");
  writeFileSync(file, `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`);
  return file;
}

describe("planReplay", () => {
  const stored = { ...event(2, T0 + 60_000), arrivedAt: "2026-10-01T10:01:00.400Z", source: "http" };
  const lines = [
    event(1, T0 + 5_000, "turn.transcript", {
      turn: 0,
      user: "u",
      assistant: "a",
      at: new Date(T0 + 5_000).toISOString(),
    }),
    "not json at all {",
    event(0, T0, "session.started", { source: "startup" }),
    { hello: "world" },
    stored,
    "",
    // Real history can exceed the schema's caps; a replay keeps it.
    event(3, T0 + 70_000, "turn.transcript", {
      turn: 1,
      user: "x".repeat(20_001),
      assistant: "a",
      at: new Date(T0 + 70_000).toISOString(),
    }),
  ];

  it("orders by time, strips StoredEvent fields and skips what is not an event", () => {
    const plan = planReplay(fileOf(lines), { rebase: false });
    expect(plan.skipped).toBe(2);
    expect(plan.events.map((e) => e.session.seq)).toEqual([0, 1, 2, 3]);
    expect(plan.offsets).toEqual([0, 5_000, 60_000, 70_000]);
    expect("arrivedAt" in plan.events[2]!).toBe(false);
    expect("source" in plan.events[2]!).toBe(false);
    expect(plan.events[0]!.time).toBe("2026-10-01T10:00:00.000Z");
  });

  it("rebases so the first event is now and the rest keep their gaps, data times included", () => {
    const now = Date.parse("2026-10-14T20:00:00.000Z");
    const plan = planReplay(fileOf(lines), { rebase: true, now });
    expect(plan.events.map((e) => Date.parse(e.time) - now)).toEqual([0, 5_000, 60_000, 70_000]);
    expect(plan.events[1]!.data.at).toBe(new Date(now + 5_000).toISOString());
    expect(plan.events[0]!.id).toBe((lines[2] as ProtocolEvent).id);
  });

  it("caps long silences when asked", () => {
    const now = Date.parse("2026-10-14T20:00:00.000Z");
    const plan = planReplay(fileOf(lines), { rebase: true, now, maxGapMs: 10_000 });
    expect(plan.offsets).toEqual([0, 5_000, 15_000, 25_000]);
    expect(Date.parse(plan.events[3]!.time) - now).toBe(25_000);
  });

  it("handles an empty or absent-of-events file", () => {
    const plan = planReplay(fileOf(["", "nope"]));
    expect(plan.events).toEqual([]);
    expect(plan.skipped).toBe(1);
  });
});

describe("startReplay", () => {
  it("speed 0: everything at once, in order, batches of at most 50, as demo", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => event(i, T0 + i * 1000));
    const store = new FakeStore();
    const runner = startReplay(asStore(store), fileOf(lines), { speed: 0 });
    await runner.done;
    expect(store.batches.map((b) => b.events.length)).toEqual([50, 50, 20]);
    expect(store.batches.every((b) => b.source === "demo")).toBe(true);
    expect(store.events.map((e) => e.session.seq)).toEqual(lines.map((_, i) => i));
    runner.stop();
  });

  it("paces by the original gaps divided by speed", async () => {
    vi.useFakeTimers();
    try {
      const lines = [event(0, T0), event(1, T0 + 1000), event(2, T0 + 3000)];
      const store = new FakeStore();
      const runner = startReplay(asStore(store), fileOf(lines), { speed: 20 });
      expect(store.events.map((e) => e.session.seq)).toEqual([0]);
      await vi.advanceTimersByTimeAsync(49);
      expect(store.events.map((e) => e.session.seq)).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.events.map((e) => e.session.seq)).toEqual([0, 1]);
      await vi.advanceTimersByTimeAsync(99);
      expect(store.events.map((e) => e.session.seq)).toEqual([0, 1]);
      await vi.advanceTimersByTimeAsync(1);
      await runner.done;
      expect(store.events.map((e) => e.session.seq)).toEqual([0, 1, 2]);
      const [a, b, c] = store.batches.map((x) => x.at) as [number, number, number];
      expect(b - a).toBe(50);
      expect(c - b).toBe(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() cancels what is still to come", async () => {
    const lines = [event(0, T0), event(1, T0 + 10_000)];
    const store = new FakeStore();
    const runner = startReplay(asStore(store), fileOf(lines), { speed: 1 });
    runner.stop();
    await runner.done;
    await new Promise((r) => setTimeout(r, 30));
    expect(store.events.map((e) => e.session.seq)).toEqual([0]);
  });

  it("resolves at once for a file with no events", async () => {
    const store = new FakeStore();
    const runner = startReplay(asStore(store), fileOf(["{"]), { speed: 1 });
    await runner.done;
    expect(store.batches).toEqual([]);
  });
});
