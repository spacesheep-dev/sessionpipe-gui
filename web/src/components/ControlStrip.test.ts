// SPDX-License-Identifier: Apache-2.0
import "../native/test-env";
import type { Attention, MachineControl, SessionSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import { answerState } from "../control/useSend";
import { blockedAnswer, keepPlanning } from "./ControlStrip";
import { foldPlan } from "./PlanText";

describe("keepPlanning", () => {
  it("says no to the plan with what the composer says should change", () => {
    expect(keepPlanning("perm-1", "  Use the existing cache\n")).toEqual({
      kind: "permission.answer",
      attentionId: "perm-1",
      allow: false,
      note: "Use the existing cache",
      // Its note is the composer's: a hold of it goes when the composer changes.
      composer: true,
    });
  });
  it("carries no note when the composer is empty", () => {
    const a = keepPlanning("perm-1", " \n ");
    expect(a).toEqual({ kind: "permission.answer", attentionId: "perm-1", allow: false, composer: true });
    expect("note" in a).toBe(false);
  });
});

describe("foldPlan", () => {
  it("folds a plan scrolled while it was whole back to its top", () => {
    const el = { style: { maxHeight: "" }, scrollTop: 250, clientHeight: 170, scrollHeight: 170 };
    expect(foldPlan(el as unknown as HTMLElement)).toBe(false);
    expect(el.scrollTop).toBe(0);
  });
});

describe("an answer inside the hour a newly approved phone waits", () => {
  const line = "This iPhone can send from 5:30 PM";
  it("the bar over Deny / Allow says the hour's own line, never that the page cannot sign", () => {
    expect(blockedAnswer(null, line)).toBe(line);
    // Any other block, and the wrong address, read as they did.
    expect(blockedAnswer(null)).toBe("this page cannot sign an answer");
    expect(blockedAnswer("https://elsewhere.example", line)).toBe("answer it where sending works");
  });
  it("a card's Allow and Deny are off with the same line: no button that will be refused", () => {
    const s = { key: "claude-code:s-1", machine: "studio-mac" } as SessionSummary;
    const a = { attentionId: "a1", kind: "permission", at: "2026-11-13T10:00:00Z", answerable: true } as Attention;
    const control = { machineId: "m1", keys: [], harnesses: {}, modes: [] } as unknown as MachineControl;
    const send = { rp: "spacesheep.dev", secure: true, tap: false, answers: {} };
    const open = answerState(s, a, control, send);
    const cooling = answerState(s, a, control, { ...send, cooling: line });
    expect(cooling).toMatchObject({ reason: line, off: true, tag: "blocked" });
    // Outside the hour the same prompt is as open as it was.
    expect(open.reason === line || open.tag === "blocked").toBe(false);
  });
});
