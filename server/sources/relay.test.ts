// SPDX-License-Identifier: Apache-2.0
// The relay's reader with nothing of the receiver's under it: its doors a fake spacesheep
// (test/account/fake-spacesheep.ts), its keep a map, its clock moved by hand. What the
// receiver's source does with files and a key is in spacesheep.test.ts, unchanged.
import { afterEach, describe, expect, it } from "vitest";
import type { ProtocolEvent } from "../../shared/api.js";
import { asResponse, type FakeAnswer, FakeSpacesheep, ManualClock } from "../../test/account/fake-spacesheep.js";
import { Session } from "../../test/events.js";
import {
  BACKLOG_RESERVE,
  backlogPaceMs,
  cursorFrom,
  type Doors,
  HUB_HEADER,
  RELAY_BUDGET,
  RELAY_LIMIT,
  RELAY_PAGE,
  RELAY_WINDOW_MS,
  type RelayKept,
  type RelayReader,
  type RelayReaderOptions,
  readsFrom,
  relayPaceMs,
  startRelayReader,
} from "./relay.js";

const ORIGIN = "https://ss.test";
const EMAIL = "me@example.com";

/** A hub's own answer (docs/rfcs/08, "The doors"): its header and `{ hub, reason, error }`. */
const hubSays = (status: number, code: string, headers: Record<string, string> = {}): FakeAnswer => ({
  status,
  headers: { "content-type": "application/json", [HUB_HEADER]: code, ...headers },
  body: JSON.stringify({ hub: true, reason: code, error: code }),
});

describe("the relay's reader over what its opener hands in", () => {
  let reader: RelayReader | null = null;
  afterEach(() => {
    reader?.stop();
    reader = null;
  });

  /** A reader over a fake spacesheep; `hub` stands between the two when a test gives one. */
  const open = (o: Partial<RelayReaderOptions> & { hubAnswer?: (path: string) => FakeAnswer | null } = {}) => {
    const clock = new ManualClock();
    const ss = new FakeSpacesheep(clock);
    const kept = new Map<RelayKept, unknown>();
    const taken: ProtocolEvent[] = [];
    const loading: boolean[] = [];
    const asked: string[] = [];
    const doors: Doors = async (path, init) => {
      asked.push(path);
      const own = o.hubAnswer?.(path);
      if (own) return asResponse(own);
      return asResponse(
        await ss.handle({ method: "GET", path, authorization: `Bearer ${ss.key}`, signal: init?.signal }),
      );
    };
    const start = (more: Partial<RelayReaderOptions> = {}) => {
      reader = startRelayReader({
        origin: ORIGIN,
        email: EMAIL,
        doors,
        keep: { read: (name) => kept.get(name), write: (name, value) => void kept.set(name, value) },
        sink: {
          ingest: (events) => {
            taken.push(...events);
            return events.length;
          },
          setLoading: (on) => void loading.push(on),
        },
        clock,
        retryMs: 1000,
        ...o,
        ...more,
      });
      return reader;
    };
    return { clock, ss, kept, taken, loading, asked, start };
  };

  const events = (n: number, id = "s-1"): ProtocolEvent[] => {
    const s = new Session(id);
    return Array.from({ length: n }, (_, i) => s.ev(i ? "tool.started" : "session.started", { call_id: `c${i}` }));
  };

  it("reads from the kept cursor, hands the events to the sink, and keeps the cursor it reached", async () => {
    const t = open();
    t.ss.push(events(3));
    const r = t.start();
    await t.clock.settle();
    expect(t.taken).toHaveLength(3);
    expect(t.loading).toEqual([true, false]);
    expect(r.status()).toMatchObject({ state: "ok", cursor: 3, events: 3 });
    expect(t.kept.get("cursor")).toEqual({ origin: ORIGIN, email: EMAIL, cursor: 3 });
    // An event lands; the next read (paced: a third of the budget is taken as spent) brings it.
    t.ss.push(events(1, "s-2"));
    await t.clock.advance(5000);
    expect(r.status()).toMatchObject({ cursor: 4, events: 4 });
    // Stopped, the read times are kept; the next reader goes on from the cursor and from them.
    r.stop();
    const reads = t.kept.get("reads") as { origin: string; email: string; reads: number[] };
    expect(reads).toMatchObject({ origin: ORIGIN, email: EMAIL });
    expect(reads.reads.length).toBeGreaterThan(Math.floor(RELAY_BUDGET / 3));
    t.asked.length = 0;
    t.start();
    await t.clock.settle();
    expect(t.asked.find((p) => p.includes("since="))).toContain("since=4&limit=500&wait=0");
    expect(t.taken).toHaveLength(4);
  });

  it("another account's cursor and read times mean nothing here", () => {
    expect(cursorFrom({ origin: ORIGIN, email: EMAIL, cursor: 9 }, ORIGIN, EMAIL)).toBe(9);
    expect(cursorFrom({ origin: ORIGIN, email: "other@example.com", cursor: 9 }, ORIGIN, EMAIL)).toBe(0);
    expect(cursorFrom({ origin: "https://else.test", email: EMAIL, cursor: 9 }, ORIGIN, EMAIL)).toBe(0);
    expect(cursorFrom({ origin: ORIGIN, email: EMAIL, cursor: -1 }, ORIGIN, EMAIL)).toBe(0);
    expect(cursorFrom(undefined, ORIGIN, EMAIL)).toBe(0);
    expect(cursorFrom("9", ORIGIN, EMAIL)).toBe(0);
    const now = 10_000_000;
    const third = Math.floor(RELAY_BUDGET / 3);
    expect(readsFrom(undefined, ORIGIN, EMAIL, now)).toHaveLength(third);
    expect(readsFrom({ origin: ORIGIN, email: "other@example.com", reads: [now] }, ORIGIN, EMAIL, now)).toHaveLength(
      third,
    );
    expect(
      readsFrom({ origin: ORIGIN, email: EMAIL, reads: [now - 700_000, now - 5, now + 5] }, ORIGIN, EMAIL, now),
    ).toEqual([now - 5]);
    // A key made just now: nobody read with it before, so nothing is taken as spent.
    expect(readsFrom(undefined, ORIGIN, EMAIL, now, false)).toEqual([]);
  });

  it("says its state each time it changes, and each page as it was taken", async () => {
    const states: string[] = [];
    const pages: Array<{ events: number; taken: number; cursor: number; more: boolean }> = [];
    const t = open({ onState: (s) => states.push(s), onPage: (p) => pages.push(p) });
    t.ss.push(events(2));
    t.start();
    await t.clock.settle();
    expect(states).toEqual(["ok"]);
    expect(pages).toEqual([{ events: 2, taken: 2, cursor: 2, more: false }]);
    // The key is revoked: the next read is refused.
    t.ss.revoked = true;
    await t.clock.advance(5000);
    expect(states).toEqual(["ok", "unauthorized"]);
  });

  describe("behind the native hub", () => {
    it("a hub `busy` is not spacesheep's limit: asked again in a second, not counted, never `limited`", async () => {
      let busy = 2;
      const t = open({
        hub: true,
        fresh: true,
        hubAnswer: (p) => (p.includes("since=") && busy-- > 0 ? hubSays(429, "busy", { "retry-after": "1" }) : null),
      });
      t.ss.push(events(2));
      const r = t.start();
      await t.clock.settle();
      // The first read met the hub's full room: nothing taken, nothing said of a limit.
      expect(r.status()).toMatchObject({ state: "starting", cursor: 0 });
      await t.clock.advance(1000);
      expect(r.status().state).toBe("starting");
      await t.clock.advance(1000);
      expect(r.status()).toMatchObject({ state: "ok", cursor: 2 });
      // Two reads never left the hub: spacesheep counted one, and so did the reader.
      expect(t.ss.relayReads).toBe(2);
      r.stop();
      expect((t.kept.get("reads") as { reads: number[] }).reads).toHaveLength(2);
    });

    it("`answer_too_large` asks again for half as many, down to what fits, then for more again", async () => {
      const limits: number[] = [];
      const t = open({
        hub: true,
        hubAnswer: (p) => {
          const m = /since=(\d+)&limit=(\d+)/.exec(p);
          if (!m) return null;
          limits.push(Number(m[2]));
          // Events 1 to 125 are too much for one answer in more than 100 at a time.
          return Number(m[1]) < 125 && Number(m[2]) > 100 ? hubSays(502, "answer_too_large") : null;
        },
      });
      t.ss.push(events(450));
      const r = t.start({ backlog: true, fresh: true });
      await t.clock.advance(50);
      // Halved until it fits; no more again until the cursor is past what was too large.
      expect(limits.slice(0, 7)).toEqual([500, 250, 125, 62, 62, 62, 124]);
      expect(r.status()).toMatchObject({ state: "ok", cursor: 450, events: 450 });
      expect(t.taken).toHaveLength(450);
    });

    it("a hub 401 is the hub's word, not a revoked key; spacesheep's own 401 is", async () => {
      let refused = 0;
      let off = true;
      const t = open({
        hub: true,
        onUnauthorized: () => refused++,
        hubAnswer: (p) => (off && p.includes("since=") ? hubSays(401, "not_connected") : null),
      });
      const r = t.start();
      await t.clock.settle();
      expect(r.status()).toMatchObject({ state: "offline", lastError: "hub: not_connected" });
      expect(refused).toBe(0);
      // The hub lets it through again; spacesheep itself says the key is gone.
      off = false;
      t.ss.revoked = true;
      await t.clock.advance(5000);
      expect(r.status().state).toBe("unauthorized");
      expect(refused).toBe(1);
    });

    it("not behind the hub, the header is never looked at", async () => {
      let refused = 0;
      const t = open({
        onUnauthorized: () => refused++,
        hubAnswer: (p) => (p.includes("since=") ? hubSays(401, "not_connected") : null),
      });
      const r = t.start();
      await t.clock.settle();
      expect(r.status().state).toBe("unauthorized");
      expect(refused).toBe(1);
    });

    it("a hub that cannot reach spacesheep is offline with the hub's code, and the pause grows", async () => {
      let down = true;
      const t = open({
        hub: true,
        hubAnswer: (p) => (down && p.includes("since=") ? hubSays(502, "unreachable") : null),
      });
      t.ss.push(events(1));
      const r = t.start();
      await t.clock.settle();
      expect(r.status()).toMatchObject({ state: "offline", lastError: "hub: unreachable" });
      await t.clock.advance(3000);
      expect(r.status().state).toBe("offline");
      down = false;
      await t.clock.advance(10_000);
      expect(r.status()).toMatchObject({ state: "ok", cursor: 1 });
    });
  });

  describe("history first", () => {
    it("reads a whole backlog at once and tells each page; the receiver's reader paces from the second", async () => {
      const paged = open();
      paged.ss.push(events(RELAY_PAGE * 4));
      const pages: boolean[] = [];
      const r = paged.start({ backlog: true, onPage: (p) => pages.push(p.more) });
      await paged.clock.advance(200);
      expect(r.status()).toMatchObject({ state: "ok", cursor: RELAY_PAGE * 4 });
      // Four full pages (more is waiting after each) and the empty one that says it is over.
      expect(pages.slice(0, 5)).toEqual([true, true, true, true, false]);

      const paced = open();
      paced.ss.push(events(RELAY_PAGE * 4));
      const s = paced.start();
      await paced.clock.advance(200);
      // A third of the budget is taken as spent with nothing kept, so the second read waits.
      expect(s.status().cursor).toBe(RELAY_PAGE);
      await paced.clock.advance(20_000);
      expect(s.status().cursor).toBe(RELAY_PAGE * 4);
    });

    it("keeps the reserve: past it a backlog is paced like any read", () => {
      const now = 1_000_000;
      const spent = (n: number) => Array.from({ length: n }, (_, i) => now - i);
      expect(backlogPaceMs(spent(RELAY_BUDGET - BACKLOG_RESERVE - 1), now)).toBe(0);
      const at = spent(RELAY_BUDGET - BACKLOG_RESERVE);
      expect(backlogPaceMs(at, now)).toBe(relayPaceMs(at, now));
      expect(backlogPaceMs(at, now)).toBeGreaterThan(0);
    });

    for (const seeded of [true, false])
      it(`the relay's whole 50 000 events, then an hour of a busy stream, never reaches 240 in 600 s (${seeded ? "a third taken as spent" : "a key made just now"})`, () => {
        // The reads as spacesheep counts them, on a clock of our own: 100 full pages 50 ms
        // apart with the backlog's pace, then an event a second with the steady pace.
        const start = 1_000_000;
        const log: number[] = seeded ? Array.from({ length: Math.floor(RELAY_BUDGET / 3) }, () => start) : [];
        const counted: number[] = [];
        let t = start;
        let worst = 0;
        const read = (pace: number) => {
          t += pace;
          log.push(t);
          counted.push(t);
          worst = Math.max(worst, counted.filter((x) => t - x < RELAY_WINDOW_MS).length);
          t += 50;
        };
        for (let page = 0; page < 101; page++) read(backlogPaceMs(log, t));
        const backlogMs = t - start;
        while (t < start + 3600_000) read(Math.max(relayPaceMs(log, t), 1000 - 50));
        expect(worst).toBeLessThanOrEqual(RELAY_BUDGET);
        expect(worst).toBeLessThan(RELAY_LIMIT);
        // History is in within seconds, not the minutes the steady pace would take.
        expect(backlogMs).toBeLessThan(seeded ? 60_000 : 10_000);
      });
  });
});
