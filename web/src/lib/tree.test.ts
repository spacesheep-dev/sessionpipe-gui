// SPDX-License-Identifier: Apache-2.0
// The one session tree: what the events say (a subagent's session, an asked one, a chain,
// a loop, a parent off the surface, a folded Done), the person's arrangement over it
// (placed under another, brought to the top level, pinned, a parent gone or hidden, loops
// between the two), four levels and no deeper, and the top level in the Board's own order.
import "../native/test-env";
import type { Arrangement, SessionState, SessionSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import { bySectionThenRecent } from "../data/hooks";
import { foldsAway } from "./delegated";
import {
  arrangeTree,
  descendants,
  eventParent,
  rollUp,
  runsElsewhere,
  TREE_LEVELS,
  type TreeInput,
  type TreeNode,
} from "./tree";

let n = 0;
const s = (key: string, o: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    key,
    harness: key.split(":")[0],
    id: key.split(":")[1],
    machine: "studio-mac",
    state: "idle",
    startedAt: new Date(Date.UTC(2026, 10, 24, 12, 0, n++)).toISOString(),
    ...o,
  }) as unknown as SessionSummary;
const NONE: Arrangement = { rev: 0, placed: {}, pinned: [] };
const shape = (input: Partial<TreeInput> & { all: SessionSummary[] }) => {
  const t = arrangeTree({ arrangement: NONE, ...input });
  const draw = (nodes: TreeNode[]): unknown[] =>
    nodes.map((x) => (x.kids.length ? { [x.s.key]: draw(x.kids) } : x.s.key));
  return draw(t.roots);
};

describe("what the events say", () => {
  it("a subagent's session under its parent; an asked one under the session that asked it", () => {
    const a = s("claude-code:a");
    const sub = s("claude-code:sub", { parentId: "a" });
    const asked = s("codex:b", { delegatedBy: a.key });
    const lone = s("codex:lone", { delegatedBy: "claude-code:gone" });
    expect(shape({ all: [a, sub, asked, lone] })).toEqual([
      "codex:lone",
      { "claude-code:a": ["codex:b", "claude-code:sub"] },
    ]);
  });

  it("a chain of asks is drawn as the chain it is; the Board's row holds every link", () => {
    const a = s("claude-code:a");
    const b = s("codex:b", { delegatedBy: a.key });
    const c = s("gemini-cli:c", { delegatedBy: b.key });
    expect(shape({ all: [c, b, a] })).toEqual([{ "claude-code:a": [{ "codex:b": ["gemini-cli:c"] }] }]);
    const t = arrangeTree({ all: [c, b, a], arrangement: NONE });
    expect(t.childrenOf.get(a.key)?.map((x) => x.key)).toEqual(["gemini-cli:c", "codex:b"]);
  });

  it("a loop nests nobody in it; a session asked by one of them hangs under it", () => {
    const a = s("claude-code:a", { delegatedBy: "codex:b" });
    const b = s("codex:b", { delegatedBy: "claude-code:a" });
    const c = s("gemini-cli:c", { delegatedBy: "codex:b" });
    expect(shape({ all: [a, b, c] })).toEqual([{ "codex:b": ["gemini-cli:c"] }, "claude-code:a"]);
    // A session naming itself stays a session of its own.
    expect(shape({ all: [s("claude-code:me", { delegatedBy: "claude-code:me" })] })).toEqual(["claude-code:me"]);
  });

  it("an asker on another computer, or not drawn here, leaves the asked session at the top level", () => {
    const far = s("claude-code:far", { machine: "build-box" });
    const b = s("codex:b", { delegatedBy: far.key });
    const c = s("gemini-cli:c", { delegatedBy: b.key });
    expect(shape({ all: [far, b, c] })).toEqual([{ "codex:b": ["gemini-cli:c"] }, "claude-code:far"]);
    const a = s("claude-code:a");
    const kid = s("codex:kid", { delegatedBy: a.key });
    expect(shape({ all: [a, kid], drawn: (p) => p.key !== a.key })).toEqual(["codex:kid", "claude-code:a"]);
  });

  it("a parent in a folded Done keeps no live child, but keeps one that needs you", () => {
    const done = s("claude-code:a", { state: "done" });
    const live = s("codex:b", { delegatedBy: done.key, state: "working" });
    const ended = s("codex:c", { delegatedBy: done.key, state: "done" });
    const asks = s("codex:d", { delegatedBy: done.key, state: "needs_you" });
    const needs = (x: SessionSummary) => x.state === "needs_you";
    const hangs = (showDone: boolean) => (c: SessionSummary, p: SessionSummary) => !foldsAway(c, p, showDone, needs);
    expect(shape({ all: [done, live, ended, asks], hangs: hangs(false), needs })).toEqual([
      { "claude-code:a": ["codex:d", "codex:c"] },
      "codex:b",
    ]);
    expect(shape({ all: [done, live, ended, asks], hangs: hangs(true), needs })).toEqual([
      { "claude-code:a": ["codex:d", "codex:b", "codex:c"] },
    ]);
    // The parent is drawn in Needs you, for its child.
    const t = arrangeTree({ all: [done, asks], arrangement: NONE, needs });
    expect(t.sectionOf(done)).toBe("needs_you");
  });

  it("eventParent says what the events alone would hang a session under", () => {
    const a = s("claude-code:a");
    const b = s("codex:b", { delegatedBy: a.key });
    const sub = s("claude-code:sub", { parentId: "a" });
    expect(eventParent(b, [a, b])).toBe(a.key);
    expect(eventParent(sub, [a, sub])).toBe(a.key);
    expect(eventParent(a, [a, b])).toBeUndefined();
    expect(eventParent(b, [b])).toBeUndefined();
  });
});

describe("the person's arrangement", () => {
  const a = s("claude-code:a");
  const b = s("codex:b", { machine: "build-box" });
  const c = s("claude-code:c", { delegatedBy: a.key });
  const all = [a, b, c];

  it("places a session under another, whatever their computers, and says it was placed", () => {
    const t = arrangeTree({ all, arrangement: { placed: { [b.key]: a.key }, pinned: [] } });
    expect(t.roots.map((x) => x.s.key)).toEqual([a.key]);
    const kids = t.nodes.get(a.key)!.kids;
    expect(kids.map((k) => [k.s.key, k.placed, k.parent])).toEqual([
      [c.key, false, a.key],
      [b.key, true, a.key],
    ]);
  });

  it("brings a session to the top level though its events name a parent, and moves one to another parent", () => {
    expect(shape({ all, arrangement: { placed: { [c.key]: null }, pinned: [] } })).toEqual([
      "claude-code:c",
      "codex:b",
      "claude-code:a",
    ]);
    const moved = arrangeTree({ all, arrangement: { placed: { [c.key]: b.key }, pinned: [] } });
    expect(moved.nodes.get(c.key)).toMatchObject({ parent: b.key, placed: true, level: 1 });
    expect(moved.nodes.get(a.key)!.kids).toEqual([]);
  });

  it("keeps a placement whose parent is gone or not drawn here, inert: the child is at the top level", () => {
    const gone = { placed: { [b.key]: "claude-code:gone" }, pinned: [] };
    expect(arrangeTree({ all, arrangement: gone }).nodes.get(b.key)).toMatchObject({ level: 0, placed: false });
    const hidden = { placed: { [b.key]: a.key }, pinned: [] };
    const t = arrangeTree({ all, arrangement: hidden, drawn: (p) => p.key !== a.key });
    expect(t.nodes.get(b.key)).toMatchObject({ level: 0 });
    expect(t.nodes.get(b.key)?.parent).toBeUndefined();
  });

  it("a pinned session is always at the top level; its own sessions stay under it", () => {
    const t = arrangeTree({ all, arrangement: { placed: { [b.key]: c.key }, pinned: [c.key] } });
    expect(t.nodes.get(c.key)).toMatchObject({ level: 0 });
    expect(t.nodes.get(c.key)!.kids.map((k) => k.s.key)).toEqual([b.key]);
  });

  it("a loop between the events and a placement is cut where the events made it", () => {
    // a is placed under c, and c's events say it was asked by a.
    const t = arrangeTree({ all, arrangement: { placed: { [a.key]: c.key }, pinned: [] } });
    expect(t.nodes.get(c.key)).toMatchObject({ level: 0 });
    expect(t.nodes.get(a.key)).toMatchObject({ parent: c.key, placed: true });
    // A loop of placements alone (the receiver refuses one) nests nobody.
    const own = arrangeTree({ all, arrangement: { placed: { [a.key]: b.key, [b.key]: a.key }, pinned: [] } });
    expect(own.nodes.get(a.key)?.level).toBe(0);
    expect(own.nodes.get(b.key)?.level).toBe(0);
  });

  it("draws four levels; deeper ones are drawn at the fourth, after their ancestor, and nothing is lost", () => {
    const chain = Array.from({ length: 7 }, (_, i) => s(`claude-code:l${i}`));
    const placed = Object.fromEntries(chain.slice(1).map((x, i) => [x.key, chain[i]!.key]));
    const t = arrangeTree({ all: chain, arrangement: { placed, pinned: [] } });
    expect(TREE_LEVELS).toBe(4);
    const level2 = t.nodes.get("claude-code:l2")!;
    expect(level2.kids.map((k) => [k.s.key, k.level])).toEqual([
      ["claude-code:l3", 3],
      ["claude-code:l4", 3],
      ["claude-code:l5", 3],
      ["claude-code:l6", 3],
    ]);
    expect(Math.max(...[...t.nodes.values()].map((x) => x.level))).toBe(3);
    expect(t.nodes.size).toBe(7);
    // The real parent is kept: "Placed here by you" and the drops it may not take.
    expect(t.nodes.get("claude-code:l5")?.parent).toBe("claude-code:l4");
    expect([...descendants(t, "claude-code:l3")].sort()).toEqual([
      "claude-code:l4",
      "claude-code:l5",
      "claude-code:l6",
    ]);
    expect(descendants(t, "claude-code:l0").size).toBe(6);
    expect(t.childrenOf.get("claude-code:l0")).toHaveLength(6);
  });
});

describe("rollUp", () => {
  it("gives a folded parent the loudest under it at any depth, and how many of each", () => {
    const p = s("claude-code:rp", { state: "working" });
    const c = s("codex:rc", { state: "idle", delegatedBy: p.key });
    const g = s("codex:rg", { state: "needs_you", delegatedBy: c.key });
    const u = s("codex:ru", { state: "done", delegatedBy: p.key });
    const t = arrangeTree({ all: [p, c, g, u], arrangement: NONE });
    const r = rollUp(t.roots, { unread: (x) => x.key === u.key });
    expect(r.get(p.key)).toEqual({ loud: "needs_you", inside: 3, needs: 1, working: 0, stale: 0, unread: 1 });
    expect(r.get(c.key)).toMatchObject({ loud: "needs_you", inside: 1, needs: 1 });
    expect(r.get(g.key)).toMatchObject({ loud: "none", inside: 0 });
    // A session this surface does not draw (hidden here) counts for nothing, nor what is under it.
    const hid = rollUp(t.roots, { unread: () => false, drawn: (x) => x.key !== c.key });
    expect(hid.get(p.key)).toEqual({ loud: "none", inside: 1, needs: 0, working: 0, stale: 0, unread: 0 });
  });
});

describe("the computer mark", () => {
  it("marks a row under a session on another computer, never a top-level row, a pinned one included", () => {
    const a = s("claude-code:ma");
    const b = s("codex:mb", { machine: "build-box" });
    const c = s("claude-code:mc");
    const all = [a, b, c];
    const t = arrangeTree({ all, arrangement: { placed: { [b.key]: a.key, [c.key]: a.key }, pinned: [] } });
    expect(runsElsewhere(t, b.key)).toBe(true);
    expect(runsElsewhere(t, c.key)).toBe(false);
    // On another computer than the rest, at the top level: no mark (its tooltip says where).
    expect(runsElsewhere(arrangeTree({ all, arrangement: NONE }), b.key)).toBe(false);
    // A placed child pinned, so drawn at the top level: no mark.
    const pinned = arrangeTree({ all, arrangement: { placed: { [b.key]: a.key }, pinned: [b.key] } });
    expect(runsElsewhere(pinned, b.key)).toBe(false);
    // Drawn flat at the last level, it is judged against the session it really hangs under.
    const chain = [
      s("claude-code:f0"),
      s("claude-code:f1"),
      s("claude-code:f2"),
      s("claude-code:f3"),
      s("codex:f4", { machine: "build-box" }),
      s("codex:f5", { machine: "build-box" }),
    ];
    const placed = Object.fromEntries(chain.slice(1).map((x, i) => [x.key, chain[i]!.key]));
    const flat = arrangeTree({ all: chain, arrangement: { placed, pinned: [] } });
    expect(runsElsewhere(flat, "codex:f4")).toBe(true);
    expect(runsElsewhere(flat, "codex:f5")).toBe(false);
  });
});

describe("the order", () => {
  it("is the Board's: by the section a row is drawn in, then the newest started", () => {
    const states: SessionState[] = ["done", "idle", "working", "stale", "needs_you", "idle", "working"];
    const all = states.map((st, i) => s(`claude-code:o${i}`, { state: st }));
    const kid = s("codex:k", { state: "needs_you", delegatedBy: all[1]!.key });
    const needs = (x: SessionSummary) => x.state === "needs_you";
    const t = arrangeTree({ all: [...all, kid], arrangement: NONE, needs });
    const board = [...all].sort(bySectionThenRecent(t.sectionOf));
    expect(t.roots.map((x) => x.s.key)).toEqual(board.map((x) => x.key));
    // The idle parent of a session that needs you is in Needs you, before working rows.
    expect(new Set(t.roots.slice(0, 2).map((x) => x.s.key))).toEqual(new Set(["claude-code:o4", "claude-code:o1"]));
  });
});
