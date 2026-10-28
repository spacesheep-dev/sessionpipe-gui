// SPDX-License-Identifier: Apache-2.0
// Which moments raise a system notification, by a session's own "Notify me".
import type { SessionSummary } from "@shared/api";
import { describe, expect, it, vi } from "vitest";
import type { NotifyMoment } from "./notify";

// The router listens on `window` as it loads; the decision itself needs no page.
vi.stubGlobal("window", { addEventListener: () => {} });
const { finishedMoment, shouldNotify } = await import("./notify");

const T = "2026-10-28T10:00:00.000Z";
const LATER = "2026-10-28T10:05:00.000Z";
const at = (o: Partial<SessionSummary>) => ({ key: "claude-code:a", state: "idle", newsAt: T, ...o }) as SessionSummary;
const prompt: NotifyMoment = { kind: "attention", answerable: true };
const notice: NotifyMoment = { kind: "attention", answerable: false };

describe("shouldNotify", () => {
  it("never notifies a session set to Never", () => {
    expect(shouldNotify(prompt, "never", true)).toBe(false);
    expect(shouldNotify({ kind: "finished" }, "never", true)).toBe(false);
  });

  it("notifies When it needs me only for a prompt it can answer", () => {
    expect(shouldNotify(prompt, "needs", undefined)).toBe(true);
    expect(shouldNotify(notice, "needs", undefined)).toBe(false);
    expect(shouldNotify({ kind: "finished" }, "needs", undefined)).toBe(false);
  });

  it("notifies or finishes on news, not on a tool call", () => {
    const finished = finishedMoment(T, at({ newsAt: LATER }));
    expect(finished).toEqual({ kind: "finished" });
    expect(shouldNotify(finished!, "finishes", true)).toBe(true);
    expect(shouldNotify(prompt, "finishes", true)).toBe(true);
    // A tool call moves the session, never its newsAt.
    expect(finishedMoment(T, at({ state: "working", currentTool: { tool: "Bash", since: LATER } }))).toBeNull();
    expect(finishedMoment(T, at({ lastAt: LATER }))).toBeNull();
    // News while it still works (its own background work) is not a finish.
    expect(finishedMoment(T, at({ state: "working", newsAt: LATER }))).toBeNull();
    expect(finishedMoment(T, at({ state: "done", newsAt: LATER }))).toEqual({ kind: "finished" });
  });

  it("never notifies an unattended run", () => {
    expect(shouldNotify(prompt, "needs", false)).toBe(false);
    expect(shouldNotify({ kind: "finished" }, "finishes", false)).toBe(false);
  });
});
