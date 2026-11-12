// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { cursorAfter, JOBS_PAGE, parseRelayPage, type RelayJob, readJobs } from "./spacesheep.js";

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
