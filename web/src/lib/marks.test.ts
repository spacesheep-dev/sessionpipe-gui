// SPDX-License-Identifier: Apache-2.0
// Since you looked: which rows are unread against the person's marks, and how seen marks go out.
import type { Marks, MarksPatch, SessionSummary } from "@shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Store } from "../data/store";
import { isUnread, markSeen, readsUnread, SEND_EVERY_MS, setUnread } from "./marks";

const SINCE = "2026-10-28T10:00:00.000Z";
const marks = (m: Partial<Marks> = {}): Marks => ({ rev: 1, since: SINCE, read: {}, unread: {}, ...m });
const row = (s: Partial<SessionSummary> = {}) =>
  ({ key: "claude-code:a", state: "idle", newsAt: "2026-10-28T10:05:00.000Z", ...s }) as SessionSummary;

describe("isUnread", () => {
  it("is unread when its news is newer than the read mark, or than since when it has none", () => {
    expect(isUnread(row(), marks())).toBe(true);
    expect(isUnread(row({ state: "done" }), marks())).toBe(true);
    expect(isUnread(row(), marks({ read: { "claude-code:a": "2026-10-28T10:05:00.000Z" } }))).toBe(false);
    expect(isUnread(row(), marks({ read: { "claude-code:a": "2026-10-28T10:04:00.000Z" } }))).toBe(true);
    // News from before the receiver kept marks, or none at all, is read.
    expect(isUnread(row({ newsAt: "2026-10-28T09:00:00.000Z" }), marks())).toBe(false);
    expect(isUnread(row({ newsAt: undefined }), marks())).toBe(false);
  });

  it("is never unread while it needs you, works or has gone quiet", () => {
    for (const state of ["needs_you", "working", "stale"] as const) {
      expect(isUnread(row({ state }), marks())).toBe(false);
      expect(isUnread(row({ state }), marks({ unread: { "claude-code:a": true } }))).toBe(false);
    }
  });

  it("never for a run nobody attended; attended or unknown is", () => {
    expect(isUnread(row({ attended: false }), marks())).toBe(false);
    expect(isUnread(row({ attended: true }), marks())).toBe(true);
  });

  it("a manual unread wins over the read mark", () => {
    const m = marks({
      read: { "claude-code:a": "2026-10-28T10:05:00.000Z" },
      unread: { "claude-code:a": true },
    });
    expect(isUnread(row(), m)).toBe(true);
    expect(isUnread(row({ newsAt: undefined }), m)).toBe(true);
  });

  it("a manual unread on a row that works shows once it settles, and the menu and u read it as unread", () => {
    const m = marks({ unread: { "claude-code:a": true } });
    expect(isUnread(row({ state: "working" }), m)).toBe(false);
    expect(readsUnread(row({ state: "working" }), m)).toBe(true);
    expect(readsUnread(row({ state: "working" }), marks())).toBe(false);
  });

  it("with no since (an older server) nothing is unread", () => {
    expect(isUnread(row(), { rev: 0, read: {}, unread: { "claude-code:a": true } })).toBe(false);
  });
});

describe("the seen queue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends at most once every 2 s, keys merged, and a manual mark takes back what was queued", async () => {
    vi.useFakeTimers();
    const sent: MarksPatch[] = [];
    const m = marks({ unread: { "claude-code:c": true } });
    const store = {
      get: () => ({ marks: m }),
      patchMarks: async (p: MarksPatch) => {
        sent.push(structuredClone(p));
        return m;
      },
    } as unknown as Store;
    const at = (min: number) => `2026-10-28T10:${String(min).padStart(2, "0")}:00.000Z`;

    markSeen(store, "claude-code:a", at(1), true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([{ read: { "claude-code:a": at(1) } }]);

    markSeen(store, "claude-code:b", at(2), true);
    markSeen(store, "claude-code:c", undefined, true);
    // Already read up to it, and no manual unread: nothing to send.
    markSeen(store, "claude-code:e", "2026-10-28T09:00:00.000Z", true);
    await vi.advanceTimersByTimeAsync(SEND_EVERY_MS - 1);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent[1]).toEqual({ read: { "claude-code:b": at(2) }, unread: { "claude-code:c": null } });

    markSeen(store, "claude-code:d", at(3), true);
    setUnread(store, [row({ key: "claude-code:d" })], true);
    expect(sent[2]).toEqual({ unread: { "claude-code:d": true } });
    await vi.advanceTimersByTimeAsync(SEND_EVERY_MS);
    expect(sent).toHaveLength(3);
  });
});
