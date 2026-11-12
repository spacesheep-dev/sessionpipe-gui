// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "../store/store.js";
import {
  cursorAfter,
  JOBS_PAGE,
  loadReads,
  parseRelayPage,
  READS_SAVE_MS,
  RELAY_BUDGET,
  RELAY_LIMIT,
  RELAY_WINDOW_MS,
  type RelayJob,
  readJobs,
  relayPaceMs,
  retryAfterMs,
  type SpacesheepSource,
  startSpacesheepSource,
} from "./spacesheep.js";

describe("the spacesheep relay source (docs/rfcs/08)", () => {
  it("reads a relay page and nothing that isn't one", () => {
    expect(parseRelayPage({ events: [{ a: 1 }], next: 7, oldest: 3, protocol: 1 })).toEqual({
      events: [{ a: 1 }],
      next: 7,
      oldest: 3,
      protocol: 1,
    });
    expect(parseRelayPage({ events: [], next: 0, oldest: null })).toEqual({
      events: [],
      next: 0,
      oldest: null,
      protocol: undefined,
    });
    expect(parseRelayPage({ next: 1 })).toBeNull();
    expect(parseRelayPage("x")).toBeNull();
  });
  it("moves the cursor to the page's end, and notes a gap when the relay no longer holds the cursor's past", () => {
    expect(cursorAfter(0, { events: [], next: 0, oldest: 40 })).toEqual({ cursor: 0, gap: false });
    expect(cursorAfter(10, { events: [{}], next: 12, oldest: 3 })).toEqual({ cursor: 12, gap: false });
    expect(cursorAfter(10, { events: [], next: 10, oldest: 40 })).toEqual({ cursor: 39, gap: true });
    expect(cursorAfter(10, { events: [], next: 10, oldest: 11 })).toEqual({ cursor: 10, gap: false });
  });
  it("notes a gap on a full page too: the first event back is not the one after the cursor", () => {
    // The shape the relay really answers: everything after the cursor it still holds.
    const page = (from: number, n: number) => ({
      events: Array.from({ length: n }, () => ({})),
      next: from + n - 1,
      oldest: from,
    });
    // A GUI off longer than the relay keeps: cursor 5, the relay holds 21 on.
    expect(cursorAfter(5, page(21, 14))).toEqual({ cursor: 34, gap: true });
    expect(cursorAfter(5, page(21, 500))).toEqual({ cursor: 520, gap: true });
    // The one after the cursor is the first back: nothing lost.
    expect(cursorAfter(20, page(21, 14))).toEqual({ cursor: 34, gap: false });
    // Behind the oldest kept but still the next one: no gap (oldest is the cursor's next).
    expect(cursorAfter(20, { events: [{}], next: 25, oldest: 21 })).toEqual({ cursor: 25, gap: false });
    // From the start there is nothing to lose.
    expect(cursorAfter(0, page(21, 14))).toEqual({ cursor: 34, gap: false });
  });
  it("reads the jobs door past a job that waits, so a newer send's word is never out of reach", async () => {
    // spacesheep's door: the jobs after `since`, oldest first, JOBS_PAGE at most.
    const all: RelayJob[] = Array.from({ length: 450 }, (_, i) => ({
      id: i + 1,
      status: "done",
      note: null,
      done_at: 1,
      created_at: 1,
    }));
    const asked: number[] = [];
    const page = async (since: number) => {
      asked.push(since);
      return all.filter((j) => j.id > since).slice(0, JOBS_PAGE);
    };
    // Job 5 waits; job 300 is newer than a page past it.
    let r = await readJobs([5, 300], page);
    expect(asked).toEqual([4, 299]);
    expect(r.jobs.some((j) => j.id === 5) && r.jobs.some((j) => j.id === 300)).toBe(true);
    expect(r.through).toBe(399);
    // A page that comes back short reached the end: everything after it is known.
    asked.length = 0;
    r = await readJobs([440], page);
    expect(asked).toEqual([439]);
    expect(r.through).toBe(Number.POSITIVE_INFINITY);
    // A pending id the list doesn't have at all (past its end).
    asked.length = 0;
    r = await readJobs([5, 900], page);
    expect(asked).toEqual([4, 899]);
    expect(r.through).toBe(Number.POSITIVE_INFINITY);
  });
});

/** An hour of a steady stream against the relay, on a fake clock: events every 1/rate s;
 *  a read answers at once with what is waiting, else on the next event (plus spacesheep's
 *  linger), else after 25 s; each answer takes 50 ms. The reader waits relayPaceMs before
 *  each read. Says the most reads in any 600 s (sliding) and in any of spacesheep's fixed
 *  windows, and the longest an event waited to be read. */
export function simulateRelay(
  rate: number,
  seconds: number,
  lingerMs: number,
  restart?: { at: number; withFile: boolean },
) {
  const LAT = 50;
  // Every read spacesheep counted, across a restart; `log` is what this process knows.
  const all: number[] = [];
  let restarted = false;
  const arrivals: number[] = [];
  for (let t = 0; t < seconds * 1000; t += 1000 / rate) arrivals.push(Math.round(t));
  const log: number[] = [];
  const fixed = new Map<number, number>();
  let t = 0;
  let next = 0;
  let maxLag = 0;
  let maxSliding = 0;
  while (t < seconds * 1000) {
    if (restart && !restarted && t >= restart.at * 1000) {
      // The process stops between two saves (READS_SAVE_MS): what it read since the last
      // save is lost to the next one, which starts two seconds later from the file, or
      // (no file) from a third of the budget.
      restarted = true;
      const saved = Math.floor(t / READS_SAVE_MS) * READS_SAVE_MS;
      t += 2000;
      const kept = log.filter((x) => x <= saved && t - x < RELAY_WINDOW_MS);
      log.length = 0;
      log.push(...(restart.withFile ? kept : Array.from({ length: Math.floor(RELAY_BUDGET / 3) }, () => t)));
    }
    t += relayPaceMs(log, t);
    log.push(t);
    all.push(t);
    const sliding = all.filter((x) => t - x < RELAY_WINDOW_MS).length;
    maxSliding = Math.max(maxSliding, sliding);
    const w = Math.floor(t / RELAY_WINDOW_MS);
    void w;
    fixed.set(w, (fixed.get(w) ?? 0) + 1);
    let answerAt: number;
    let upTo: number;
    if (next < arrivals.length && arrivals[next]! <= t) {
      answerAt = t + LAT;
      upTo = t;
    } else if (next < arrivals.length && arrivals[next]! - t <= 25_000) {
      upTo = Math.min(arrivals[next]! + lingerMs, t + 25_000);
      answerAt = upTo + LAT;
    } else {
      t += 25_000 + LAT;
      continue;
    }
    while (next < arrivals.length && arrivals[next]! <= upTo) {
      maxLag = Math.max(maxLag, answerAt - arrivals[next]!);
      next++;
    }
    t = answerAt;
  }
  return { maxLag, maxSliding, maxFixed: Math.max(...fixed.values()), reads: log.length };
}

describe("pacing the relay under spacesheep's limit", () => {
  it("never spends the budget, and a quiet board waits for nothing", () => {
    expect(relayPaceMs([], 0)).toBe(0);
    const third = Array.from({ length: Math.floor(RELAY_BUDGET / 3) }, (_, i) => i * 1000);
    expect(relayPaceMs(third, 200_000)).toBe(0);
    const full = Array.from({ length: RELAY_BUDGET }, (_, i) => i * 1000);
    expect(relayPaceMs(full, 300_000)).toBe(RELAY_WINDOW_MS - 300_000);
    const most = Array.from({ length: RELAY_BUDGET - 1 }, (_, i) => i * 1000);
    // One read left: it waits for the oldest to leave the window, spread over that one.
    expect(relayPaceMs(most, 300_000)).toBe(RELAY_WINDOW_MS - 300_000);
  });

  for (const rate of [0.2, 1, 5])
    for (const linger of [0, 400])
      it(`an hour at ${rate} events a second (linger ${linger} ms): no 429, a few seconds' lag at most`, () => {
        const r = simulateRelay(rate, 3600, linger);
        expect(r.maxSliding).toBeLessThanOrEqual(RELAY_BUDGET);
        expect(r.maxFixed).toBeLessThan(RELAY_LIMIT);
        expect(r.maxLag).toBeLessThan(4500);
        if (process.env.SPGUI_PACE_REPORT) console.log(JSON.stringify({ rate, linger, ...r }));
      });
});

describe("the read budget across a restart", () => {
  it("a restart mid-stream at 1 event a second, from the saved reads, stays under 240 in any 600 s", () => {
    for (const at of [200, 300, 450, 700]) {
      const r = simulateRelay(1, 1800, 400, { at, withFile: true });
      expect(r.maxSliding).toBeLessThan(RELAY_LIMIT);
      expect(r.maxLag).toBeLessThan(5000);
      if (process.env.SPGUI_PACE_REPORT) console.log(JSON.stringify({ restartAt: at, ...r }));
    }
  });
});

describe("Retry-After", () => {
  it("reads seconds and dates, and nothing else", () => {
    expect(retryAfterMs("120")).toBe(120_000);
    expect(retryAfterMs(new Date(10_000 + 30_000).toUTCString(), 10_000)).toBe(30_000);
    expect(retryAfterMs("soon")).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });
});

describe("the spacesheep source's status", () => {
  const ORIGIN = "https://ss.test";
  let dir: string;
  let src: SpacesheepSource | null = null;
  afterEach(() => {
    src?.stop();
    src = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  /** A source over a fake relay: `answer` is what each request gets. */
  const start = (answer: (url: string) => Response, cursor = 0) => {
    dir = mkdtempSync(path.join(tmpdir(), "spgui-ss-"));
    if (cursor)
      writeFileSync(
        path.join(dir, "spacesheep-cursor.json"),
        JSON.stringify({ origin: ORIGIN, email: "me@x", cursor }),
      );
    const store = { dir, ingest: () => ({ accepted: 0 }), setLoading: () => {} } as unknown as Store;
    // Each answer after a tick of the clock, as a network's would: the loop polls again at once.
    const fetch = (async (u: string | URL) => {
      await new Promise((r) => setTimeout(r, 2));
      return answer(String(u));
    }) as typeof globalThis.fetch;
    src = startSpacesheepSource(store, {
      origin: ORIGIN,
      key: "ss_x",
      email: "me@x",
      connectedAt: "",
      fetch,
      retryMs: 5,
    });
    return src;
  };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("says gap when a full page comes back from past the cursor, and keeps saying it", async () => {
    let oldest = 21;
    const s = start((u) => {
      if (u.includes("/machines")) return json({ machines: [] });
      const since = Number(new URL(u).searchParams.get("since"));
      const from = Math.max(since + 1, oldest);
      return json({ events: from <= 34 ? [{}] : [], next: from <= 34 ? 34 : since, oldest, protocol: 1 });
    }, 5);
    await settle();
    expect(s.status()).toMatchObject({ state: "gap", cursor: 34 });
    expect(s.status().lastError).toContain("before 21");
    oldest = 30;
    await s.tick();
    expect(s.status().state).toBe("gap");
  });

  it("goes unauthorized the moment a send finds the key revoked, and polls no more", async () => {
    let polls = 0;
    const s = start((u) => {
      if (u.includes("/machines")) return json({ machines: [] });
      polls++;
      return json({ events: [], next: 0, oldest: null, protocol: 1 });
    });
    await settle();
    expect(s.status().state).toBe("ok");
    s.unauthorized();
    expect(s.status()).toMatchObject({ state: "unauthorized" });
    const after = polls;
    await settle();
    expect(polls - after).toBeLessThanOrEqual(1);
    expect(s.status().state).toBe("unauthorized");
  });

  it("a 429 is spacesheep asking to wait, not spacesheep unreachable: limited, for as long as it said", async () => {
    let polls = 0;
    let machinesRead = 0;
    const s = start((u) => {
      if (u.includes("/machines")) {
        machinesRead++;
        return json({ machines: [] });
      }
      polls++;
      return json({ error: "rate_limited" }, 429, { "retry-after": "120" });
    });
    await settle();
    expect(s.status()).toMatchObject({ state: "limited", lastError: "HTTP 429" });
    // It waits the two minutes it was told (not the 5 ms retry), so it asked once.
    await settle();
    expect(polls).toBe(1);
    // The machine list (not metered) is read all the same.
    expect(machinesRead).toBeGreaterThanOrEqual(1);
  });

  it("reads the jobs door at the pace it is told, and at once on a kick", async () => {
    let jobs = 0;
    let pace: "fast" | "slow" | "none" = "slow";
    dir = mkdtempSync(path.join(tmpdir(), "spgui-ss-"));
    const store = { dir, ingest: () => ({ accepted: 0 }), setLoading: () => {} } as unknown as Store;
    const fetch = (async (u: string | URL) => {
      await new Promise((r) => setTimeout(r, 2));
      if (String(u).includes("/jobs")) {
        jobs++;
        return json({ jobs: [] });
      }
      if (String(u).includes("/machines")) return json({ machines: [] });
      await new Promise((r) => setTimeout(r, 50));
      return json({ events: [], next: 0, oldest: null, protocol: 1 });
    }) as typeof globalThis.fetch;
    src = startSpacesheepSource(store, {
      origin: ORIGIN,
      key: "ss_x",
      email: "me@x",
      connectedAt: "",
      fetch,
      pendingJobs: () => [1],
      jobsCadence: () => pace,
      onJobs: () => {},
    });
    // Slow: nothing within the first few seconds' worth of a fast pace.
    await settle();
    expect(jobs).toBe(0);
    src.kickJobs();
    await settle();
    expect(jobs).toBe(1);
    pace = "fast";
    src.kickJobs();
    src.kickJobs();
    await settle();
    // Two kicks while one read is out: that one and one more, not three.
    expect(jobs).toBeGreaterThanOrEqual(2);
    expect(jobs).toBeLessThanOrEqual(3);
  });

  it("hands on spacesheep's time from the jobs answer: its `now`, else its Date header", async () => {
    const got: Array<number | undefined> = [];
    let body: Record<string, unknown> = { jobs: [], now: 1_700_000_000_000 };
    let headers: Record<string, string> = { date: new Date(1_600_000_000_000).toUTCString() };
    dir = mkdtempSync(path.join(tmpdir(), "spgui-ss-"));
    const store = { dir, ingest: () => ({ accepted: 0 }), setLoading: () => {} } as unknown as Store;
    const fetch = (async (u: string | URL) => {
      await new Promise((r) => setTimeout(r, 2));
      if (String(u).includes("/jobs")) return json(body, 200, headers);
      if (String(u).includes("/machines")) return json({ machines: [] });
      await new Promise((r) => setTimeout(r, 50));
      return json({ events: [], next: 0, oldest: null, protocol: 1 });
    }) as typeof globalThis.fetch;
    src = startSpacesheepSource(store, {
      origin: ORIGIN,
      key: "ss_x",
      email: "me@x",
      connectedAt: "",
      fetch,
      pendingJobs: () => [1],
      jobsCadence: () => "slow",
      onJobs: (_j, _t, now) => got.push(now),
    });
    await src.pollJobs();
    body = { jobs: [] };
    await src.pollJobs();
    headers = {};
    await src.pollJobs();
    expect(got).toEqual([1_700_000_000_000, 1_600_000_000_000, undefined]);
  });

  it("loads the saved reads of this account's last window, and with none usable takes a third as spent", () => {
    dir = mkdtempSync(path.join(tmpdir(), "spgui-reads-"));
    const file = path.join(dir, "spacesheep-reads.json");
    const now = 10_000_000;
    expect(loadReads(file, ORIGIN, "me@x", now)).toEqual(Array(Math.floor(RELAY_BUDGET / 3)).fill(now));
    writeFileSync(
      file,
      JSON.stringify({ origin: ORIGIN, email: "me@x", reads: [now - 700_000, now - 5000, now - 1000] }),
    );
    expect(loadReads(file, ORIGIN, "me@x", now)).toEqual([now - 5000, now - 1000]);
    expect(loadReads(file, ORIGIN, "other@x", now)).toHaveLength(Math.floor(RELAY_BUDGET / 3));
    writeFileSync(file, "not json");
    expect(loadReads(file, ORIGIN, "me@x", now)).toHaveLength(Math.floor(RELAY_BUDGET / 3));
  });

  it("writes the reads down at stop, and the next source goes on from them", async () => {
    let polls = 0;
    start(() => {
      polls++;
      return json({ events: [], next: 0, oldest: null, protocol: 1 });
    });
    await settle();
    src!.stop();
    src = null;
    const saved = JSON.parse(readFileSync(path.join(dir, "spacesheep-reads.json"), "utf8")) as { reads: number[] };
    expect(saved.reads.length).toBeGreaterThanOrEqual(Math.floor(RELAY_BUDGET / 3) + 1);
    expect(polls).toBeGreaterThan(0);
  });
});
