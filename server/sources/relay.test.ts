// SPDX-License-Identifier: Apache-2.0
// The relay's reader with nothing of the receiver's under it: its doors a fake spacesheep
// (test/account/fake-spacesheep.ts), its keep a map, its clock moved by hand. What the
// receiver's source does with files and a key is in spacesheep.test.ts, unchanged.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProtocolEvent } from "../../shared/api.js";
import { asResponse, type FakeAnswer, FakeSpacesheep, ManualClock } from "../../test/account/fake-spacesheep.js";
import { Session } from "../../test/events.js";
import {
  BACKLOG_RESERVE,
  backlogPaceMs,
  cursorFrom,
  type Doors,
  HUB_BUSY_RUN,
  HUB_HEADER,
  HUB_UNPASSABLE_MS,
  READS_SAVE_MS,
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

  describe("behind the native hub, where the first read or a single event goes wrong", () => {
    /** What the sink was told, in order: "loading true", "ingest 250", "loading false". */
    const told = (o: Parameters<typeof open>[0] = {}) => {
      const t = open(o);
      const order: string[] = [];
      const start = (more: Partial<RelayReaderOptions> = {}) =>
        t.start({
          sink: {
            ingest: (events) => {
              order.push(`ingest ${events.length}`);
              t.taken.push(...events);
              return events.length;
            },
            setLoading: (on) => void order.push(`loading ${on}`),
          },
          ...more,
        });
      return { ...t, order, start };
    };

    it("a first read the hub finds too large is still the first: loading ends when its page is taken", async () => {
      const t = told({
        hub: true,
        hubAnswer: (p) => {
          const m = /since=(\d+)&limit=(\d+)/.exec(p);
          return m && Number(m[1]) === 0 && Number(m[2]) > 250 ? hubSays(502, "answer_too_large") : null;
        },
      });
      t.ss.push(events(400));
      const r = t.start({ backlog: true, fresh: true });
      await t.clock.advance(50);
      expect(r.status()).toMatchObject({ state: "ok", cursor: 400 });
      // Nothing was handed over as live traffic before the first page: history stays history.
      expect(t.order.slice(0, 3)).toEqual(["loading true", "ingest 250", "loading false"]);
      expect(t.order.filter((x) => x.startsWith("loading"))).toEqual(["loading true", "loading false"]);
    });

    it("a first read that met the hub's full room is still the first", async () => {
      let busy = 2;
      const t = told({
        hub: true,
        fresh: true,
        hubAnswer: (p) => (p.includes("since=") && busy-- > 0 ? hubSays(429, "busy", { "retry-after": "1" }) : null),
      });
      t.ss.push(events(3));
      t.start();
      await t.clock.settle();
      expect(t.order).toEqual(["loading true"]);
      await t.clock.advance(2000);
      expect(t.order).toEqual(["loading true", "ingest 3", "loading false"]);
    });

    it("a first read asked again that then fails, or is stopped, ends loading all the same", async () => {
      let n = 0;
      const failing = told({
        hub: true,
        fresh: true,
        hubAnswer: (p) =>
          p.includes("since=")
            ? n++ === 0
              ? hubSays(429, "busy", { "retry-after": "1" })
              : hubSays(502, "unreachable")
            : null,
      });
      const r = failing.start();
      await failing.clock.settle();
      expect(failing.order).toEqual(["loading true"]);
      await failing.clock.advance(1000);
      expect(r.status()).toMatchObject({ state: "offline", lastError: "hub: unreachable" });
      expect(failing.order).toEqual(["loading true", "loading false"]);
      r.stop();

      const stopped = told({
        hub: true,
        fresh: true,
        hubAnswer: (p) => (p.includes("since=") ? hubSays(429, "busy", { "retry-after": "1" }) : null),
      });
      const s = stopped.start();
      await stopped.clock.settle();
      expect(stopped.order).toEqual(["loading true"]);
      s.stop();
      expect(stopped.order).toEqual(["loading true", "loading false"]);
    });

    it("not behind the hub, loading ends with the first read whatever came of it, as it always did", async () => {
      const t = told();
      // spacesheep's limit is spent before the first read.
      t.ss.limit = 0;
      t.ss.push(events(2));
      const r = t.start();
      await t.clock.settle();
      expect(r.status().state).toBe("limited");
      expect(t.order).toEqual(["loading true", "loading false"]);
    });

    /** The relay reads asked, as "since/limit". */
    const relayAsks = (asked: string[]): string[] =>
      asked.flatMap((p) => {
        const m = /since=(\d+)&limit=(\d+)/.exec(p);
        return m ? [`${m[1]}/${m[2]}`] : [];
      });

    it("one event the hub cannot pass even alone is never stepped over: offline in the hub's words, the cursor where it is, asked for again slowly", async () => {
      let stuck = true;
      const states: string[] = [];
      const t = open({
        hub: true,
        onState: (s) => states.push(s),
        // The third event is more than the hub passes, in any answer that would hold it.
        hubAnswer: (p) => {
          const m = /since=(\d+)&limit=(\d+)/.exec(p);
          if (!m || !stuck) return null;
          const [since, limit] = [Number(m[1]), Number(m[2])];
          return since < 3 && since + limit >= 3 ? hubSays(502, "answer_too_large") : null;
        },
      });
      const all = events(12);
      t.ss.push(all);
      const r = t.start({ backlog: true, fresh: true });
      await t.clock.advance(100);
      // What comes before it is read; it is asked for alone, and there the reader stays.
      const stays = { state: "offline", lastError: "hub: answer_too_large", cursor: 2, events: 2 };
      expect(r.status()).toMatchObject(stays);
      expect(r.status()).not.toHaveProperty("skipped");
      expect(states).toEqual(["ok", "offline"]);
      expect(t.taken.map((e) => e.id)).toEqual(all.slice(0, 2).map((e) => e.id));
      expect(t.kept.get("cursor")).toEqual({ origin: ORIGIN, email: EMAIL, cursor: 2 });
      expect(relayAsks(t.asked).filter((a) => a === "2/1")).toHaveLength(1);
      // Ten minutes on: a few more asks for that one event, and nothing has moved.
      await t.clock.advance(600_000);
      const again = relayAsks(t.asked).filter((a) => a === "2/1").length - 1;
      expect(again).toBe(Math.floor(600_000 / HUB_UNPASSABLE_MS));
      expect(again).toBeLessThanOrEqual(4);
      expect(relayAsks(t.asked).every((a) => Number(a.split("/")[0]) <= 2)).toBe(true);
      expect(r.status()).toMatchObject(stays);
      expect(t.kept.get("cursor")).toEqual({ origin: ORIGIN, email: EMAIL, cursor: 2 });
      expect(states).toEqual(["ok", "offline"]);
      // The hub passes it: every event arrives, the one it held back among them, in order.
      stuck = false;
      await t.clock.advance(HUB_UNPASSABLE_MS);
      expect(r.status()).toMatchObject({ state: "ok", cursor: 12, events: 12 });
      expect(r.status().lastError).toBeUndefined();
      expect(t.taken.map((e) => e.id)).toEqual(all.map((e) => e.id));
      expect(states).toEqual(["ok", "offline", "ok"]);
    });

    it("a hub that finds every answer too large loses nothing: the cursor stays over three starts, and all of it is read once the hub passes pages", async () => {
      let failing = true;
      const t = told({
        hub: true,
        hubAnswer: (p) => (failing && p.includes("since=") ? hubSays(502, "answer_too_large") : null),
      });
      const all = events(12);
      t.ss.push(all);
      for (let launch = 0; launch < 3; launch++) {
        t.asked.length = 0;
        t.order.length = 0;
        const r = t.start({ backlog: true, fresh: true });
        await t.clock.advance(600_000);
        expect(r.status(), `launch ${launch}`).toMatchObject({
          state: "offline",
          lastError: "hub: answer_too_large",
          cursor: 0,
          events: 0,
        });
        expect(t.kept.get("cursor"), `launch ${launch}`).toBeUndefined();
        // Halved from a full page to one event, then a few asks for that one in ten minutes.
        const asks = relayAsks(t.asked);
        expect(asks.slice(0, 9)).toEqual(["0/500", "0/250", "0/125", "0/62", "0/31", "0/15", "0/7", "0/3", "0/1"]);
        expect(asks.slice(9).every((a) => a === "0/1")).toBe(true);
        expect(asks.length - 9).toBe(Math.floor(600_000 / HUB_UNPASSABLE_MS));
        // The first read asked again and then failed: loading ended, with nothing taken.
        expect(t.order).toEqual(["loading true", "loading false"]);
        r.stop();
      }
      failing = false;
      const r = t.start({ backlog: true });
      await t.clock.advance(30_000);
      expect(r.status()).toMatchObject({ state: "ok", cursor: 12, events: 12 });
      expect(t.taken.map((e) => e.id)).toEqual(all.map((e) => e.id));
    });

    it("an event the hub never passed and the relay then let go is said as a gap, like any other", async () => {
      let held = true;
      const t = open({
        hub: true,
        hubAnswer: (p) => {
          const m = /since=(\d+)&limit=(\d+)/.exec(p);
          if (!m || !held) return null;
          const [since, limit] = [Number(m[1]), Number(m[2])];
          return since < 3 && since + limit >= 3 ? hubSays(502, "answer_too_large") : null;
        },
      });
      const all = events(12);
      t.ss.push(all);
      const r = t.start({ backlog: true, fresh: true });
      await t.clock.advance(600_000);
      expect(r.status()).toMatchObject({ state: "offline", lastError: "hub: answer_too_large", cursor: 2 });
      // The relay drops it, and two after it. The next ask comes through, behind what the
      // relay still holds: a gap, said, and the board has what is left.
      t.ss.drop(5);
      held = false;
      await t.clock.advance(HUB_UNPASSABLE_MS);
      expect(r.status()).toMatchObject({ state: "gap", cursor: 12, events: 9 });
      expect(r.status().lastError).toContain("the relay no longer holds events before 6");
      expect(t.taken.map((e) => e.id)).toEqual([...all.slice(0, 2), ...all.slice(5)].map((e) => e.id));
    });

    it("a start with no cursor whose oldest held event the hub cannot pass waits at nothing, and reads on when the relay lets it go", async () => {
      let held = true;
      const t = open({
        hub: true,
        hubAnswer: (p) => (held && p.includes("since=") ? hubSays(502, "answer_too_large") : null),
      });
      const all = events(110);
      t.ss.push(all);
      // The relay has trimmed: the oldest it holds is seq 101, and that one is too large.
      t.ss.drop(100);
      const r = t.start({ backlog: true, fresh: true });
      await t.clock.advance(600_000);
      expect(r.status()).toMatchObject({ state: "offline", lastError: "hub: answer_too_large", cursor: 0, events: 0 });
      expect(t.kept.get("cursor")).toBeUndefined();
      t.ss.drop(101);
      held = false;
      await t.clock.advance(HUB_UNPASSABLE_MS);
      expect(r.status()).toMatchObject({ state: "ok", cursor: 110, events: 9 });
      expect(t.taken.map((e) => e.id)).toEqual(all.slice(101).map((e) => e.id));
    });

    it("a hub that is always busy is said and waited out: a handful of asks in ten minutes, not one a second", async () => {
      let busy = true;
      const states: string[] = [];
      const t = open({
        hub: true,
        fresh: true,
        onState: (s) => states.push(s),
        hubAnswer: (p) => (busy && p.includes("since=") ? hubSays(429, "busy", { "retry-after": "1" }) : null),
      });
      t.ss.push(events(2));
      const r = t.start();
      await t.clock.advance(600_000);
      const reads = t.asked.filter((p) => p.includes("since=")).length;
      expect(reads).toBeGreaterThan(HUB_BUSY_RUN);
      expect(reads).toBeLessThan(40);
      expect(r.status()).toMatchObject({ state: "offline", lastError: "hub: busy", cursor: 0 });
      expect(states).toEqual(["offline"]);
      // None of them was a read spacesheep counted.
      expect(t.ss.relayReads).toBe(0);
      // The hub has room again: read on, and the state says so.
      busy = false;
      await t.clock.advance(120_000);
      expect(r.status()).toMatchObject({ state: "ok", cursor: 2 });
      expect(states).toEqual(["offline", "ok"]);
    });

    it("a keep that throws stops nothing: the page is taken, the read times are written when it lets them", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const t = open();
        const kept = new Map<RelayKept, unknown>();
        let refuse = true;
        const pages: number[] = [];
        t.ss.push(events(3));
        const r = t.start({
          fresh: true,
          onPage: (p) => pages.push(p.cursor),
          keep: {
            read: (name) => kept.get(name),
            write: (name, value) => {
              if (refuse) throw new Error("storage is full");
              kept.set(name, value);
            },
          },
        });
        await t.clock.settle();
        // The cursor could not be kept: the page is taken all the same, and told.
        expect(t.taken).toHaveLength(3);
        expect(r.status()).toMatchObject({ state: "ok", cursor: 3 });
        expect(pages).toEqual([3]);
        // The timer that writes the read times goes on through a refusal...
        await t.clock.advance(40_000);
        expect(kept.get("reads")).toBeUndefined();
        expect(errors).toHaveBeenCalled();
        // ...and writes them once it can.
        refuse = false;
        await t.clock.advance(40_000);
        expect((kept.get("reads") as { reads: number[] }).reads.length).toBeGreaterThan(0);
        expect(r.status().state).toBe("ok");
      } finally {
        errors.mockRestore();
      }
    });

    it("read times a keep refused are still owed: written at the next turn of the timer, with no read in between", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const t = open();
        const kept = new Map<RelayKept, unknown>();
        let refuse = true;
        let refused = 0;
        // spacesheep's limit is spent: the one read is answered 429, and the next is ten minutes off.
        t.ss.limit = 0;
        const r = t.start({
          fresh: true,
          keep: {
            read: (name) => kept.get(name),
            write: (name, value) => {
              if (refuse) {
                refused++;
                throw new Error("storage is full");
              }
              kept.set(name, value);
            },
          },
        });
        await t.clock.settle();
        expect(r.status().state).toBe("limited");
        const reads = () => t.asked.filter((p) => p.includes("since=")).length;
        expect(reads()).toBe(1);
        // The timer's first turn is refused...
        await t.clock.advance(READS_SAVE_MS + 1000);
        expect(refused).toBe(1);
        expect(kept.get("reads")).toBeUndefined();
        // ...and its next one writes what the first could not, though nothing was read since.
        refuse = false;
        await t.clock.advance(READS_SAVE_MS);
        expect(reads()).toBe(1);
        expect((kept.get("reads") as { reads: number[] }).reads).toHaveLength(1);
      } finally {
        errors.mockRestore();
      }
    });

    it("a hub busy now and then is never the hub failing: only reads answered busy one after another count", async () => {
      let busy = 0;
      const states: string[] = [];
      const t = open({
        hub: true,
        fresh: true,
        onState: (s) => states.push(s),
        hubAnswer: (p) => (p.includes("since=") && busy-- > 0 ? hubSays(429, "busy", { "retry-after": "1" }) : null),
      });
      const r = t.start();
      await t.clock.settle();
      // Twice as many busy answers as would be a failure in a row, each followed by a page.
      for (let i = 1; i <= HUB_BUSY_RUN * 2; i++) {
        busy = 1;
        t.ss.push(events(1, `s-${i}`));
        await t.clock.advance(30_000);
        expect(r.status(), `round ${i}`).toMatchObject({ state: "ok", cursor: i });
      }
      expect(states).toEqual(["ok"]);
    });

    it("a first read asked again ends loading when the key turns out revoked, by a send's word or the relay's own", async () => {
      // A send found the key revoked while the first read waited on the hub's room.
      const bySend = told({
        hub: true,
        fresh: true,
        hubAnswer: (p) => (p.includes("since=") ? hubSays(429, "busy", { "retry-after": "5" }) : null),
      });
      const a = bySend.start();
      await bySend.clock.settle();
      expect(bySend.order).toEqual(["loading true"]);
      a.unauthorized();
      expect(bySend.order).toEqual(["loading true", "loading false"]);
      expect(a.status().state).toBe("unauthorized");

      // The hub had the first read asked again, and spacesheep then refused the key itself.
      let busy = 1;
      const byRelay = told({
        hub: true,
        fresh: true,
        hubAnswer: (p) => (p.includes("since=") && busy-- > 0 ? hubSays(429, "busy", { "retry-after": "1" }) : null),
      });
      byRelay.ss.revoked = true;
      const b = byRelay.start();
      await byRelay.clock.settle();
      expect(byRelay.order).toEqual(["loading true"]);
      await byRelay.clock.advance(1000);
      expect(b.status().state).toBe("unauthorized");
      expect(byRelay.order).toEqual(["loading true", "loading false"]);
    });

    it("stopped while an answer is still being read (doors that ignore the signal): nothing of it is taken", async () => {
      const t = open();
      const kept = new Map<RelayKept, unknown>();
      let release: (() => void) | null = null;
      const page = {
        events: events(2),
        next: 2,
        oldest: 1,
        protocol: 1,
      };
      const r = startRelayReader({
        origin: ORIGIN,
        email: EMAIL,
        clock: t.clock,
        fresh: true,
        keep: { read: (name) => kept.get(name), write: (name, value) => void kept.set(name, value) },
        sink: {
          ingest: (list) => {
            t.taken.push(...list);
            return list.length;
          },
          setLoading: () => {},
        },
        // These doors never look at the signal: the answer arrives whatever happens.
        doors: async (path) =>
          ({
            status: 200,
            ok: true,
            headers: { get: () => null },
            json: () =>
              path.includes("since=")
                ? new Promise((resolve) => {
                    release = () => resolve(page);
                  })
                : Promise.resolve({ machines: [], rp_id: "ss.test" }),
          }) as unknown as Response,
      });
      reader = r;
      await t.clock.settle();
      expect(release).not.toBeNull();
      r.stop();
      release!();
      await t.clock.settle();
      expect(t.taken).toHaveLength(0);
      expect(kept.get("cursor")).toBeUndefined();
      expect(r.status().cursor).toBe(0);
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
