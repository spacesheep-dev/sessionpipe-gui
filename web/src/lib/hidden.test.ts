// SPDX-License-Identifier: Apache-2.0
// Hide on this device: a plain Hide comes back with the next state, Hide until it needs
// you comes back only while the session needs you, entries stored before either keep
// reading, and the board's Hidden group counts what is still hidden under its filters.
import type { SessionSummary } from "@shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hiddenCount, hiddenRows, isHidden } from "./hidden";

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
});

describe("stored entries", () => {
  afterEach(() => {
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
