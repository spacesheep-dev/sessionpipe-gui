// SPDX-License-Identifier: Apache-2.0
// Since you looked: which rows are unread against the person's marks, and how seen marks go out.
// Notify me: how loud a session is under its parents, and which banners it drops.
import type { Marks, MarksPatch, SessionSummary } from "@shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Store } from "../data/store";
import {
  canMark,
  effectiveNotify,
  isUnread,
  markSeen,
  notifyCap,
  SEND_EVERY_MS,
  setUnread,
  showsNever,
  toastAllowed,
} from "./marks";

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

  it("with no since (an older server) nothing is unread", () => {
    expect(isUnread(row(), { rev: 0, read: {}, unread: { "claude-code:a": true } })).toBe(false);
  });
});

describe("canMark", () => {
  it("only a settled session the board draws can be marked read or unread", () => {
    expect(canMark(row())).toBe(true);
    expect(canMark(row({ state: "done" }))).toBe(true);
    for (const state of ["needs_you", "working", "stale"] as const) expect(canMark(row({ state }))).toBe(false);
    expect(canMark(row({ parentId: "parent" }))).toBe(false);
    expect(canMark(row({ state: "done", parentId: "parent" }))).toBe(false);
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

// ----- Notify me -----

const tree = (notify: Marks["notify"]) => {
  const m = marks({ notify });
  const at = (id: string, parentId?: string) =>
    ({ key: `claude-code:${id}`, harness: "claude-code", id, parentId }) as SessionSummary;
  const sessions = new Map([at("root"), at("parent", "root"), at("child", "parent")].map((s) => [s.key, s] as const));
  const level = (id: string) => effectiveNotify(sessions.get(`claude-code:${id}`)!, m, sessions);
  return { marks: m, sessions, level };
};

describe("effectiveNotify", () => {
  it("is needs for an unset child of an unset parent", () => {
    expect(tree({}).level("child")).toBe("needs");
    expect(tree(undefined).level("child")).toBe("needs");
  });

  it("caps a louder child at the quietest level an ancestor has set", () => {
    expect(tree({ "claude-code:parent": "never", "claude-code:child": "finishes" }).level("child")).toBe("never");
    expect(tree({ "claude-code:root": "never", "claude-code:child": "finishes" }).level("child")).toBe("never");
  });

  it("caps nothing under a parent set to When it needs me, which is the default", () => {
    // Choosing "When it needs me" clears the parent's own level: it is stored as nothing.
    const t = tree({ "claude-code:child": "finishes" });
    expect(t.level("child")).toBe("finishes");
    expect(notifyCap(t.sessions.get("claude-code:child")!, t.marks, t.sessions)).toBeUndefined();
  });

  it("says whether the cap is the parent's own or one further up", () => {
    const t = tree({ "claude-code:root": "never", "claude-code:parent": "finishes" });
    expect(notifyCap(t.sessions.get("claude-code:child")!, t.marks, t.sessions)).toEqual({
      level: "never",
      parent: false,
    });
    expect(notifyCap(t.sessions.get("claude-code:parent")!, t.marks, t.sessions)).toEqual({
      level: "never",
      parent: true,
    });
  });

  it("lets a default parent cap nothing, and never makes a child louder", () => {
    expect(tree({ "claude-code:child": "finishes" }).level("child")).toBe("finishes");
    expect(tree({ "claude-code:parent": "finishes", "claude-code:child": "never" }).level("child")).toBe("never");
    expect(tree({ "claude-code:parent": "finishes" }).level("child")).toBe("needs");
  });
});

describe("showsNever", () => {
  const shows = (notify: Marks["notify"], id: string, under?: boolean) => {
    const t = tree(notify);
    return showsNever(t.sessions.get(`claude-code:${id}`)!, t.marks, t.sessions, under);
  };
  it("draws the bell on a child row set to Never under a parent that isn't", () => {
    expect(shows({ "claude-code:child": "never" }, "child", true)).toBe(true);
    expect(shows({ "claude-code:parent": "finishes", "claude-code:child": "never" }, "child", true)).toBe(true);
  });
  it("leaves it to the parent's row when the parent is at Never too", () => {
    expect(shows({ "claude-code:parent": "never" }, "child", true)).toBe(false);
    expect(shows({ "claude-code:root": "never", "claude-code:child": "never" }, "child", true)).toBe(false);
  });
  it("draws it on a row of its own whatever the parent is, and on nothing louder", () => {
    expect(shows({ "claude-code:parent": "never" }, "child")).toBe(true);
    expect(shows({ "claude-code:child": "finishes" }, "child", true)).toBe(false);
    expect(shows({}, "child", true)).toBe(false);
  });
});

describe("toastAllowed", () => {
  const t = tree({ "claude-code:parent": "never" });
  it("drops a banner about a session set to Never, on its own or under a parent", () => {
    expect(toastAllowed({ session: "claude-code:parent" }, t.marks, t.sessions)).toBe(false);
    expect(toastAllowed({ session: "claude-code:child" }, t.marks, t.sessions)).toBe(false);
  });
  it("keeps the rest, and a banner about no session", () => {
    expect(toastAllowed({ session: "claude-code:root" }, t.marks, t.sessions)).toBe(true);
    expect(toastAllowed({}, t.marks, t.sessions)).toBe(true);
    expect(toastAllowed({ session: "codex:elsewhere" }, t.marks, t.sessions)).toBe(true);
  });
});
