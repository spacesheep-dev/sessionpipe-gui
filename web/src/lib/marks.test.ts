// SPDX-License-Identifier: Apache-2.0
// Since you looked: which rows are unread against the person's marks.
import type { Marks, SessionSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import { isUnread, readsUnread } from "./marks";

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
