// SPDX-License-Identifier: Apache-2.0
// What a move means (planMove): the change, the change that undoes it, its words; a move
// that means nothing, or under itself or its own sessions, is none. And the menu's items
// for a session (arrangeItems): Pin or Unpin, Move up and down among the pinned, Move
// under… where there is somewhere to go, Move to top level only where it applies.
import "../native/test-env";
import { type Arrangement, EMPTY_ARRANGEMENT, type SessionSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import { tidy } from "../components/ContextMenu";
import { arrangeItems, moveTargets, planMove } from "./arrange";
import { arrangeTree } from "./tree";

let n = 0;
const s = (key: string, o: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    key,
    harness: key.split(":")[0],
    id: key.split(":")[1],
    machine: "studio-mac",
    state: "idle",
    stateSince: "2026-11-24T12:00:00.000Z",
    startedAt: new Date(Date.UTC(2026, 10, 24, 12, 0, n++)).toISOString(),
    lastAt: "2026-11-24T12:00:00.000Z",
    openAttentions: [],
    counts: { turns: 1 },
    ...o,
  }) as unknown as SessionSummary;
const A = s("claude-code:a", { title: "Alpha" });
const B = s("codex:b", { title: "Beta", delegatedBy: "claude-code:a" });
const C = s("claude-code:c", { title: "Gamma" });
const all = [A, B, C];
const title = (k: string) => all.find((x) => x.key === k)?.title ?? k;
const plan = (arr: Pick<Arrangement, "placed" | "pinned">, key: string, move: Parameters<typeof planMove>[4]) =>
  planMove(arr, arrangeTree({ all, arrangement: arr }), all, key, move, title);
const NONE = { placed: {}, pinned: [] };

describe("planMove", () => {
  it("under another: a placement, undone by following the events again", () => {
    expect(plan(NONE, C.key, { kind: "under", parent: A.key })).toEqual({
      patch: { placed: { [C.key]: A.key } },
      undo: { follow: [C.key] },
      said: "Moved under Alpha",
      spoken: "Gamma moved under Alpha.",
    });
  });

  it("back under the session its events name: it follows them again", () => {
    const moved = { placed: { [B.key]: C.key }, pinned: [] };
    expect(plan(moved, B.key, { kind: "under", parent: A.key })).toMatchObject({
      patch: { follow: [B.key] },
      undo: { placed: { [B.key]: C.key } },
    });
  });

  it("to the top level: placed there when its events name a parent, else it follows them", () => {
    expect(plan(NONE, B.key, { kind: "top" })).toMatchObject({
      patch: { placed: { [B.key]: null } },
      undo: { follow: [B.key] },
      said: "Moved to the top level",
    });
    const placed = { placed: { [C.key]: A.key }, pinned: [] };
    expect(plan(placed, C.key, { kind: "top" })).toMatchObject({ patch: { follow: [C.key] } });
    // Already there: nothing.
    expect(plan(NONE, C.key, { kind: "top" })).toBeNull();
  });

  it("pins, moves among the pinned, unpins; a pinned row moved under another leaves Pinned", () => {
    expect(plan(NONE, C.key, { kind: "pin" })).toMatchObject({
      patch: { pinned: [C.key] },
      undo: { pinned: [] },
      said: "Pinned",
    });
    const pins = { placed: {}, pinned: [A.key, C.key] };
    expect(plan(pins, C.key, { kind: "pin", at: 0 })).toMatchObject({
      patch: { pinned: [C.key, A.key] },
      said: "Moved in Pinned",
    });
    expect(plan(pins, A.key, { kind: "pin", at: 2 })).toMatchObject({ patch: { pinned: [C.key, A.key] } });
    expect(plan(pins, A.key, { kind: "pin", at: 1 })).toBeNull();
    expect(plan(pins, A.key, { kind: "unpin" })).toMatchObject({ patch: { pinned: [C.key] }, said: "Unpinned" });
    expect(plan(pins, C.key, { kind: "under", parent: A.key })).toMatchObject({
      patch: { placed: { [C.key]: A.key }, pinned: [A.key] },
      undo: { follow: [C.key], pinned: [A.key, C.key] },
    });
    // A pinned row with no parent to go back to, dropped among the sessions: unpinned only.
    expect(plan(pins, C.key, { kind: "top" })).toMatchObject({ patch: { pinned: [A.key] }, said: "Unpinned" });
  });

  it("refuses a session under itself or its own sessions, and a move to where it is", () => {
    expect(plan(NONE, A.key, { kind: "under", parent: A.key })).toBeNull();
    expect(plan(NONE, A.key, { kind: "under", parent: B.key })).toBeNull();
    expect(plan(NONE, B.key, { kind: "under", parent: A.key })).toBeNull();
    expect(plan(NONE, A.key, { kind: "under", parent: "claude-code:gone" })).toBeNull();
  });

  it("offers under every session but itself, its own and its parent now", () => {
    const t = arrangeTree({ all, arrangement: NONE });
    expect(moveTargets(t, A.key).map((x) => x.key)).toEqual([C.key]);
    expect(moveTargets(t, B.key).map((x) => x.key)).toEqual([C.key]);
    expect(
      moveTargets(t, C.key)
        .map((x) => x.key)
        .sort(),
    ).toEqual([A.key, B.key].sort());
  });
});

describe("arrangeItems", () => {
  const store = (arrangement: Arrangement) =>
    ({ get: () => ({ sessions: new Map(all.map((x) => [x.key, x])), arrangement }) }) as never;
  const labels = (arrangement: Arrangement, x: SessionSummary) =>
    tidy(arrangeItems(x, store(arrangement))).map((i) => ("label" in i ? i.label : "─"));

  it("Pin, Move under…; Move to top level only where it is under a session", () => {
    expect(labels(EMPTY_ARRANGEMENT, C)).toEqual(["Pin", "Move under…"]);
    expect(labels(EMPTY_ARRANGEMENT, B)).toEqual(["Pin", "Move under…", "Move to top level"]);
  });

  it("Unpin, and Move up and down where there is a pin to pass", () => {
    const pins = { rev: 1, placed: {}, pinned: [A.key, C.key] };
    expect(labels(pins, A)).toEqual(["Unpin", "Move down", "Move under…"]);
    expect(labels(pins, C)).toEqual(["Unpin", "Move up", "Move under…"]);
  });
});
