// SPDX-License-Identifier: Apache-2.0
// Hide on this device: a plain Hide comes back with the next state, Hide until it needs
// you comes back only while the session needs you, entries stored before either keep
// reading, another tab's Hide is followed, Undo puts back what a Hide replaced, the
// board's Hidden group counts what is still hidden under its filters, and e leaves the
// cursor in its place.
import type { SessionSummary } from "@shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canHideUntilNeeded, hiddenCount, hiddenRows, inItsPlace, isHidden } from "./hidden";

const T0 = "2026-10-28T10:00:00.000Z";
const T1 = "2026-10-28T10:30:00.000Z";

describe("isHidden", () => {
  it("reads a hidden moment as it always did", () => {
    const h = { a: T0 };
    expect(isHidden(h, "a", T0)).toBe(true);
    expect(isHidden(h, "a", "2026-10-28T09:00:00.000Z")).toBe(true);
    expect(isHidden(h, "a", T1)).toBe(false);
    expect(isHidden(h, "b", T0)).toBe(false);
    // needing you doesn't change a plain Hide: a new state does
    expect(isHidden(h, "a", T0, true)).toBe(true);
    expect(isHidden(h, "a", T1, true)).toBe(false);
  });

  it("keeps Hide until it needs you through new turns, and shows it while it needs you", () => {
    const h = { a: { since: T0, until: "needs" as const } };
    expect(isHidden(h, "a", T0)).toBe(true);
    expect(isHidden(h, "a", T1)).toBe(true);
    expect(isHidden(h, "a", T1, false)).toBe(true);
    expect(isHidden(h, "a", T1, true)).toBe(false);
  });

  it("hidden until it needs you, a plain Hide dismisses that one prompt and the setting holds", () => {
    const h = { a: { since: T0, until: "needs" as const, dismissed: T1 } };
    // The prompt it was hidden on stays hidden; the next needs-you state shows.
    expect(isHidden(h, "a", T1, true)).toBe(true);
    expect(isHidden(h, "a", "2026-10-28T11:00:00.000Z", true)).toBe(false);
    // Working or idle again (a new turn): hidden, as the setting says.
    expect(isHidden(h, "a", "2026-10-28T11:00:00.000Z")).toBe(true);
  });

  it("isn't offered on a session that needs you now, which it would leave in place", () => {
    expect(canHideUntilNeeded({ state: "needs_you" })).toBe(false);
    for (const state of ["working", "idle", "done"] as const) expect(canHideUntilNeeded({ state })).toBe(true);
  });
});

describe("stored entries", () => {
  afterEach(() => {
    vi.doUnmock("./toasts");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("still reads the plain strings stored before Hide until it needs you", async () => {
    const stored = JSON.stringify({ "claude-code:a": T0, "codex:b": { since: T0, until: "needs" } });
    vi.stubGlobal("localStorage", { getItem: () => stored, setItem: () => {} });
    vi.resetModules();
    const { hiddenNow } = await import("./hidden");
    expect(hiddenNow({ key: "claude-code:a", stateSince: T0, state: "idle" })).toBe(true);
    expect(hiddenNow({ key: "claude-code:a", stateSince: T1, state: "working" })).toBe(false);
    expect(hiddenNow({ key: "codex:b", stateSince: T1, state: "working" })).toBe(true);
    expect(hiddenNow({ key: "codex:b", stateSince: T1, state: "needs_you" })).toBe(false);
  });

  it("follows another tab, and doesn't write its old copy back over it", async () => {
    let stored = "{}";
    let onStorage: ((e: { key: string | null }) => void) | undefined;
    vi.stubGlobal("localStorage", { getItem: () => stored, setItem: (_: string, v: string) => (stored = v) });
    vi.stubGlobal("window", { addEventListener: (_: string, f: typeof onStorage) => (onStorage = f) });
    vi.doMock("./toasts", () => ({ pushUndo: () => {} }));
    vi.resetModules();
    const { hide, hiddenNow } = await import("./hidden");
    const a = { key: "claude-code:a", stateSince: T0, state: "idle" } as const;
    expect(hiddenNow(a)).toBe(false);
    // the other tab hides a
    stored = JSON.stringify({ "claude-code:a": T0 });
    onStorage?.({ key: "sessionpipe-gui.hidden" });
    expect(hiddenNow(a)).toBe(true);
    hide("codex:b", T0, { title: "b" });
    expect(Object.keys(JSON.parse(stored))).toEqual(["claude-code:a", "codex:b"]);
  });
});

describe("Hide on a session hidden until it needs you", () => {
  afterEach(() => {
    vi.doUnmock("./toasts");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps the setting: the prompt is hidden, the next turn stays hidden, the next prompt shows", async () => {
    let stored = JSON.stringify({ "codex:b": { since: T0, until: "needs" } });
    vi.stubGlobal("localStorage", { getItem: () => stored, setItem: (_: string, v: string) => (stored = v) });
    vi.doMock("./toasts", () => ({ pushUndo: () => {} }));
    vi.resetModules();
    const { hide, hiddenNow } = await import("./hidden");
    const needs = { key: "codex:b", stateSince: T1, state: "needs_you" } as const;
    expect(hiddenNow(needs)).toBe(false);
    hide("codex:b", T1, { title: "nightly build" });
    expect(JSON.parse(stored)).toEqual({ "codex:b": { since: T0, until: "needs", dismissed: T1 } });
    expect(hiddenNow(needs)).toBe(true);
    // Answered, it works on: hidden, as before the prompt.
    expect(hiddenNow({ key: "codex:b", stateSince: "2026-10-28T11:00:00.000Z", state: "working" })).toBe(true);
    // The next time it needs you, it shows again.
    expect(hiddenNow({ key: "codex:b", stateSince: "2026-10-28T11:30:00.000Z", state: "needs_you" })).toBe(false);
    // A plain Hide on a plain entry is still a stamp.
    hide("gemini:e", T1, { title: "e" });
    expect(JSON.parse(stored)["gemini:e"]).toBe(T1);
  });
});

describe("Undo", () => {
  afterEach(() => {
    vi.doUnmock("./toasts");
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("puts back the entry a Hide replaced, so Hide until it needs you isn't lost", async () => {
    let stored = JSON.stringify({ "codex:b": { since: T0, until: "needs" } });
    vi.stubGlobal("localStorage", { getItem: () => stored, setItem: (_: string, v: string) => (stored = v) });
    const undos: (() => void)[] = [];
    vi.doMock("./toasts", () => ({ pushUndo: (o: { undo: () => void }) => undos.push(o.undo) }));
    vi.resetModules();
    const { hide, hiddenNow } = await import("./hidden");
    // it needs you, so it shows; e hides this one prompt, then Undo
    hide("codex:b", T1, { title: "nightly build" });
    undos.pop()!();
    expect(hiddenNow({ key: "codex:b", stateSince: "2026-10-28T11:00:00.000Z", state: "working" })).toBe(true);
    // a first Hide's Undo still unhides
    hide("gemini:e", T1, { title: "e" });
    undos.pop()!();
    expect(JSON.parse(stored)).toEqual({ "codex:b": { since: T0, until: "needs" } });
  });
});

describe("hiddenCount", () => {
  const row = (key: string, machine: string, state: SessionSummary["state"], stateSince = T1) =>
    ({ key, machine, state, stateSince }) as SessionSummary;
  const sessions = [
    row("claude-code:a", "mac", "idle", T0), // hidden, its state unchanged
    row("claude-code:b", "mac", "working", T1), // hidden before its new turn: back
    row("codex:c", "mac", "working"), // until it needs you, a new turn later
    row("codex:d", "mac", "needs_you"), // until it needs you, and it does
    row("gemini:e", "linux", "idle", T0), // hidden, on the other machine
    row("gemini:f", "mac", "idle"), // never hidden
  ];
  const h = {
    "claude-code:a": T0,
    "claude-code:b": T0,
    "codex:c": { since: T0, until: "needs" as const },
    "codex:d": { since: T0, until: "needs" as const },
    "gemini:e": T0,
  };

  it("counts the sessions still hidden that the filters pass", () => {
    expect(hiddenCount(h, sessions, () => true)).toBe(3);
    expect(hiddenCount(h, sessions, (s) => s.machine === "mac")).toBe(2);
    expect(hiddenCount(h, sessions, (s) => s.machine === "linux")).toBe(1);
    expect(hiddenCount({}, sessions, () => true)).toBe(0);
  });

  it("leaves out a row the list still holds in its old place, so it isn't shown twice", () => {
    // codex:c's prompt was just answered under the pointer: held in Needs you until it leaves
    const holds = new Set(["codex:c"]);
    expect(hiddenRows(h, sessions, () => true, holds).map((s) => s.key)).toEqual(["claude-code:a", "gemini:e"]);
    expect(hiddenCount(h, sessions, () => true, holds)).toBe(2);
  });
});

describe("inItsPlace", () => {
  it("keeps the cursor at its index when e moves its row into Hidden, so e goes down the list", () => {
    // the board's rows with Hidden open: Working a, b, c, then Hidden h
    let rows = ["a", "b", "c", "h"];
    let cursor = 0;
    for (const hid of ["a", "b"]) {
      expect(rows[cursor]).toBe(hid);
      const next = inItsPlace(rows, cursor)!;
      rows = [...rows.filter((r) => r !== hid), hid];
      cursor = rows.indexOf(next);
    }
    expect(cursor).toBe(0);
    expect(rows).toEqual(["c", "h", "a", "b"]);
  });

  it("takes the row before at the end, and nothing when the row was the only one", () => {
    // Unhide on the last hidden row: it goes back up, the cursor stays at the bottom
    expect(inItsPlace(["c", "a", "b"], 2)).toBe("a");
    expect(inItsPlace(["a"], 0)).toBeUndefined();
  });
});
