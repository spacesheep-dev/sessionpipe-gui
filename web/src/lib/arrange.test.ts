// SPDX-License-Identifier: Apache-2.0
// What a move means (planMove): the change, the change that undoes it, its words; a move
// that means nothing, or under itself or its own sessions, is none. And the menu's items
// for a session (arrangeItems): Pin or Unpin, Move up and down among the pinned, Move
// under… where there is somewhere to go, Move to top level only where it applies.
import "../native/test-env";
import { type Arrangement, EMPTY_ARRANGEMENT, type SessionSummary } from "@shared/api";
import { applyArrangement } from "@shared/arrangement";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tidy } from "../components/ContextMenu";
import {
  arrangeError,
  arrangeItems,
  createFolder,
  deleteFolder,
  moveTargets,
  planMove,
  recolorFolder,
  renameFolder,
  reorderFolder,
} from "./arrange";
import { PHONE_QUERY, TOUCH_QUERY } from "./device";
import { peekToasts, undoLatest } from "./toasts";
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
const plan = (
  arr: Pick<Arrangement, "placed" | "pinned" | "folders" | "inFolder">,
  key: string,
  move: Parameters<typeof planMove>[4],
) => planMove(arr, arrangeTree({ all, arrangement: arr }), all, key, move, title);
const NONE = { placed: {}, pinned: [] };

describe("planMove", () => {
  it("under another: a placement, undone by following the events again", () => {
    expect(plan(NONE, C.key, { kind: "under", parent: A.key })).toEqual({
      patch: { placed: { [C.key]: A.key } },
      undo: { follow: [C.key] },
      said: "Moved under “Alpha”",
      spoken: "Gamma moved under Alpha.",
      undone: "Gamma is back at the top level.",
    });
  });

  it("back under the session its events name: it follows them again", () => {
    const moved = { placed: { [B.key]: C.key }, pinned: [] };
    expect(plan(moved, B.key, { kind: "under", parent: A.key })).toMatchObject({
      patch: { follow: [B.key] },
      undo: { placed: { [B.key]: C.key } },
      undone: "Beta is back under Gamma.",
    });
  });

  it("to the top level: placed there when its events name a parent, else it follows them", () => {
    expect(plan(NONE, B.key, { kind: "top" })).toMatchObject({
      patch: { placed: { [B.key]: null } },
      undo: { follow: [B.key] },
      said: "Moved to top level",
      spoken: "Beta moved to top level.",
      undone: "Beta is back under Alpha.",
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
      spoken: "Gamma pinned.",
      undone: "Gamma is back at the top level.",
    });
    // Pinning a child says it moved to top level.
    expect(plan(NONE, B.key, { kind: "pin" })).toMatchObject({
      patch: { pinned: [B.key] },
      said: "Pinned and moved to top level",
      spoken: "Beta pinned and moved to top level.",
      undone: "Beta is back under Alpha.",
    });
    const pins = { placed: {}, pinned: [A.key, C.key] };
    expect(plan(pins, C.key, { kind: "pin", at: 0 })).toMatchObject({
      patch: { pinned: [C.key, A.key] },
      said: "Moved within Pinned",
      spoken: "Gamma moved to 1 of 2 in Pinned.",
      undone: "Gamma is back in Pinned.",
    });
    expect(plan(pins, A.key, { kind: "pin", at: 2 })).toMatchObject({
      patch: { pinned: [C.key, A.key] },
      spoken: "Alpha moved to 2 of 2 in Pinned.",
    });
    expect(plan(pins, A.key, { kind: "pin", at: 1 })).toBeNull();
    expect(plan(pins, A.key, { kind: "unpin" })).toMatchObject({
      patch: { pinned: [C.key] },
      said: "Unpinned",
      undone: "Alpha is back in Pinned.",
    });
    expect(plan(pins, C.key, { kind: "under", parent: A.key })).toMatchObject({
      patch: { placed: { [C.key]: A.key }, pinned: [A.key] },
      undo: { follow: [C.key], pinned: [A.key, C.key] },
      undone: "Gamma is back in Pinned.",
    });
    // A pinned row with no parent to go back to, dropped among the sessions: unpinned only.
    expect(plan(pins, C.key, { kind: "top" })).toMatchObject({ patch: { pinned: [A.key] }, said: "Unpinned" });
  });

  it("formats refusal messages for pin limits, move limits, folder errors, and save failures", () => {
    expect(arrangeError("too_many", { kind: "pin" })).toBe("Couldn't pin. Pinned holds up to 100.");
    expect(arrangeError("too_many", { kind: "under", parent: A.key })).toBe("Couldn't move. Only 500 moves are kept.");
    expect(arrangeError("too_many", { kind: "folder", folderId: "f1" })).toBe(
      "Couldn't move to folder. Limit reached.",
    );
    expect(arrangeError("bad_folder", { kind: "folder", folderId: "f1" })).toBe("That folder no longer exists.");
    expect(arrangeError("network", { kind: "top" })).toBe("Couldn't save the move. Try again.");
  });

  it("moves into/out of folders, promotes children, and clears inFolder on pin or nest with exact undo", () => {
    const withFolder = {
      placed: {},
      pinned: [],
      folders: [{ id: "f_work", name: "Work" }],
      inFolder: {},
    };
    // Root session into folder.
    expect(plan(withFolder, C.key, { kind: "folder", folderId: "f_work" })).toEqual({
      patch: { inFolder: { [C.key]: "f_work" } },
      undo: { inFolder: { [C.key]: null } },
      said: "Moved to “Work”",
      spoken: "Gamma moved to Work.",
      undone: "Gamma is back at the top level.",
    });
    // Event-parented child B into folder promotes to root (placed[B] = null) + inFolder.
    expect(plan(withFolder, B.key, { kind: "folder", folderId: "f_work" })).toMatchObject({
      patch: { placed: { [B.key]: null }, inFolder: { [B.key]: "f_work" } },
      undo: { follow: [B.key], inFolder: { [B.key]: null } },
      said: "Moved to “Work”",
    });
    // Pinning a foldered session clears inFolder; undo restores it.
    const foldered = { ...withFolder, inFolder: { [C.key]: "f_work" } };
    expect(plan(foldered, C.key, { kind: "pin" })).toMatchObject({
      patch: { pinned: [C.key], inFolder: { [C.key]: null } },
      undo: { pinned: [], inFolder: { [C.key]: "f_work" } },
      undone: "Gamma is back in Work.",
    });
    // Nesting a foldered session under A clears inFolder; undo restores it.
    expect(plan(foldered, C.key, { kind: "under", parent: A.key })).toMatchObject({
      patch: { placed: { [C.key]: A.key }, inFolder: { [C.key]: null } },
      undo: { follow: [C.key], inFolder: { [C.key]: "f_work" } },
    });
    // Moving foldered session to top level removes from folder.
    expect(plan(foldered, C.key, { kind: "top" })).toMatchObject({
      patch: { inFolder: { [C.key]: null } },
      undo: { inFolder: { [C.key]: "f_work" } },
      said: "Removed from “Work”",
    });
    expect(plan(foldered, C.key, { kind: "unfolder" })).toMatchObject({
      patch: { inFolder: { [C.key]: null } },
      undo: { inFolder: { [C.key]: "f_work" } },
    });
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
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.matchMedia;
    vi.resetModules();
  });
  const store = (arrangement: Arrangement) =>
    ({ get: () => ({ sessions: new Map(all.map((x) => [x.key, x])), arrangement }) }) as never;
  const labels = (arrangement: Arrangement, x: SessionSummary) =>
    tidy(arrangeItems(x, store(arrangement))).map((i) => ("label" in i ? i.label : "─"));

  it("Pin, Move to folder, Move under…; Move to top level only where it is under a session", () => {
    expect(labels(EMPTY_ARRANGEMENT, C)).toEqual(["Pin", "Move to folder", "Move under…"]);
    expect(labels(EMPTY_ARRANGEMENT, B)).toEqual(["Pin", "Move to folder", "Move under…", "Move to top level"]);
  });

  it("Unpin, and Move up and down in Pinned where there is a pin to pass", () => {
    const pins = { rev: 1, placed: {}, pinned: [A.key, C.key] };
    expect(labels(pins, A)).toEqual(["Unpin", "Move down in Pinned", "Move to folder", "Move under…"]);
    expect(labels(pins, C)).toEqual(["Unpin", "Move up in Pinned", "Move to folder", "Move under…"]);
  });

  it("lists folders with checked on current, Remove from folder, and New folder… in submenu", () => {
    const arr: Arrangement = {
      rev: 2,
      placed: {},
      pinned: [],
      folders: [
        { id: "f1", name: "Work", color: "blue" },
        { id: "f2", name: "Ideas" },
      ],
      inFolder: { [C.key]: "f1" },
    };
    const menu = tidy(arrangeItems(C, store(arr)));
    const sub = menu.find((i) => "items" in i && i.label === "Move to folder");
    expect(sub && "items" in sub).toBe(true);
    const subItems = tidy(sub && "items" in sub ? sub.items : []);
    expect(subItems.map((i) => ("label" in i ? i.label : "─"))).toEqual([
      "Work",
      "Ideas",
      "Remove from folder",
      "─",
      "New folder…",
    ]);
    const work = subItems[0];
    expect(work && "checked" in work && work.checked).toBe(true);
  });

  it("includes Pin, Unpin and Pinned moves on a compact phone alongside Move to folder, Move under… and Move to top level", async () => {
    g.matchMedia = (q: string) => ({
      matches: q === PHONE_QUERY || q === TOUCH_QUERY,
      addEventListener() {},
      removeEventListener() {},
    });
    Object.assign(g, { innerWidth: 390, innerHeight: 844 });
    vi.resetModules();
    const { arrangeItems: phoneItems } = await import("./arrange");
    const pins = { rev: 1, placed: {}, pinned: [A.key, C.key] };
    const phoneLabels = (arr: Arrangement, x: SessionSummary) =>
      tidy(phoneItems(x, store(arr))).map((i) => ("label" in i ? i.label : "─"));
    expect(phoneLabels(pins, A)).toEqual(["Unpin", "Move down in Pinned", "Move to folder", "Move under…"]);
    expect(phoneLabels(EMPTY_ARRANGEMENT, B)).toEqual(["Pin", "Move to folder", "Move under…", "Move to top level"]);
  });

  it("offers Search folders… in the Move to folder submenu when more than 8 folders exist", () => {
    const folders = Array.from({ length: 9 }, (_, i) => ({ id: `f${i + 1}`, name: `Folder ${i + 1}` }));
    const arr: Arrangement = { rev: 1, placed: {}, pinned: [], folders };
    const menu = tidy(arrangeItems(C, store(arr)));
    const sub = menu.find((i) => "items" in i && i.label === "Move to folder");
    expect(sub && "items" in sub).toBe(true);
    const subItems = tidy(sub && "items" in sub ? sub.items : []);
    expect(subItems.map((i) => ("label" in i ? i.label : "─"))).toContain("Search folders…");
  });
});

describe("folder CRUD and atomic Undo", () => {
  const makeStore = (initial: Arrangement = EMPTY_ARRANGEMENT) => {
    let arrangement = initial;
    const sessions = new Map(all.map((x) => [x.key, x]));
    return {
      get: () => ({ sessions, arrangement }),
      patchArrangement: async (p: Parameters<typeof applyArrangement>[1]) => {
        arrangement = applyArrangement(arrangement, p, (k) => sessions.has(k));
        return arrangement;
      },
    } as never;
  };

  it("creates, renames, recolors, reorders, and deletes a folder with Undo restoring sessions", () => {
    const st = makeStore();
    const f1 = createFolder(st, "Work", { color: "blue", moveSession: C.key });
    expect(f1).not.toBeNull();
    expect((st as { get(): { arrangement: Arrangement } }).get().arrangement.folders).toEqual([
      { id: f1!.id, name: "Work", color: "blue" },
    ]);
    expect((st as { get(): { arrangement: Arrangement } }).get().arrangement.inFolder).toEqual({ [C.key]: f1!.id });

    const f2 = createFolder(st, "Play");
    expect(f2).not.toBeNull();
    expect(renameFolder(st, f1!.id, "Core")).toBe(true);
    expect(recolorFolder(st, f1!.id, "green")).toBe(true);
    expect(reorderFolder(st, f1!.id, 1)).toBe(true);
    expect((st as { get(): { arrangement: Arrangement } }).get().arrangement.folders?.map((f) => f.name)).toEqual([
      "Play",
      "Core",
    ]);

    // Delete folder: sessions return to Sessions, and Undo restores BOTH folder and memberships!
    expect(deleteFolder(st, f1!.id)).toBe(true);
    expect((st as { get(): { arrangement: Arrangement } }).get().arrangement.folders?.map((f) => f.name)).toEqual([
      "Play",
    ]);
    expect((st as { get(): { arrangement: Arrangement } }).get().arrangement.inFolder).toBeUndefined();

    const toast = peekToasts().find((t) => t.id === "undo|arrange");
    expect(toast?.undo).toBeDefined();
    expect(undoLatest()).toBe(true);
    const afterUndo = (st as { get(): { arrangement: Arrangement } }).get().arrangement;
    expect(afterUndo.folders?.map((f) => f.name)).toEqual(["Play", "Core"]);
    expect(afterUndo.inFolder).toEqual({ [C.key]: f1!.id });
  });

  it("deleteFolder undo merges into the latest folder list without clobbering concurrent edits", () => {
    const st = makeStore();
    const f1 = createFolder(st, "Alpha")!;
    const f2 = createFolder(st, "Beta")!;
    expect(deleteFolder(st, f1.id)).toBe(true);
    // Simulate a concurrent folder rename + new folder from another device before Undo runs.
    const live = st as unknown as {
      get(): { arrangement: Arrangement };
      patchArrangement(p: Parameters<typeof applyArrangement>[1]): Promise<Arrangement>;
    };
    void live.patchArrangement({
      folders: [
        { id: f2.id, name: "Beta Renamed" },
        { id: "f_remote", name: "Remote" },
      ],
    });
    expect(undoLatest()).toBe(true);
    expect(live.get().arrangement.folders?.map((f) => f.name)).toEqual(["Alpha", "Beta Renamed", "Remote"]);
  });
});
