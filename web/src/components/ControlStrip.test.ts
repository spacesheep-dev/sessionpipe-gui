// SPDX-License-Identifier: Apache-2.0
import "../native/test-env";
import { describe, expect, it } from "vitest";
import { keepPlanning } from "./ControlStrip";
import { foldPlan } from "./PlanText";

describe("keepPlanning", () => {
  it("says no to the plan with what the composer says should change", () => {
    expect(keepPlanning("perm-1", "  Use the existing cache\n")).toEqual({
      kind: "permission.answer",
      attentionId: "perm-1",
      allow: false,
      note: "Use the existing cache",
    });
  });
  it("carries no note when the composer is empty", () => {
    const a = keepPlanning("perm-1", " \n ");
    expect(a).toEqual({ kind: "permission.answer", attentionId: "perm-1", allow: false });
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
