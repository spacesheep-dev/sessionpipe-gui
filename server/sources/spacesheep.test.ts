// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "../store/store.js";
import {
  cursorAfter,
  JOBS_PAGE,
  parseRelayPage,
  type RelayJob,
  readJobs,
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
    const s = start((u) => {
      if (u.includes("/machines")) return json({ machines: [] });
      polls++;
      return json({ error: "rate_limited" }, 429, { "retry-after": "120" });
    });
    await settle();
    expect(s.status()).toMatchObject({ state: "limited", lastError: "HTTP 429" });
    // It waits the two minutes it was told (not the 5 ms retry), so it asked once.
    await settle();
    expect(polls).toBe(1);
  });
});
