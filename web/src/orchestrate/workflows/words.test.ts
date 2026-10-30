// SPDX-License-Identifier: Apache-2.0
// The page's words (words.ts): a run's row and bar, a step's row, the durations and the
// save-state problems, as UX-SPEC §4 writes them.
import type { WorkflowRun, WorkflowStep } from "@shared/api";
import { describe, expect, it } from "vitest";
import {
  afterWords,
  durExact,
  newStepId,
  newWorkflowId,
  runGlyph,
  runMetaWords,
  runRowWords,
  saveProblem,
  startedLabel,
  stepRowWords,
} from "./words";

const M = "m_lab00000000000001";
const plan: WorkflowStep[] = [
  { id: "implement", name: "Implement", machineId: M, agent: { harness: "claude-code" }, text: "a {{input}}" },
  { id: "review", name: "Review", machineId: M, agent: { harness: "codex" }, text: "b {{prev}}" },
  { id: "fix", name: "Fix", machineId: M, agent: { harness: "claude-code" }, text: "c {{prev}}" },
];
const base: WorkflowRun = {
  id: "01R",
  workflowId: "w",
  name: "Implement, then review",
  rev: 3,
  status: "running",
  startedAt: "2026-10-28T10:00:00.000Z",
  plan,
  steps: {
    implement: { status: "done", sentAt: "2026-10-28T10:00:00.000Z", endedAt: "2026-10-28T10:02:05.000Z" },
    review: { status: "sent", sentAt: "2026-10-28T10:02:06.000Z" },
    fix: { status: "pending" },
  },
};
const name = (id: string) => (id === M ? "lab-mac" : undefined);

describe("a run's words", () => {
  it("running names the running step; the bar's meta is live", () => {
    expect(runRowWords(base, name)).toEqual({ text: "running · Review" });
    expect(runMetaWords(base, name)).toEqual({ text: "running · started", live: true });
    expect(runGlyph(base)).toBe("spinner");
  });
  it("waiting for a signer is the one accent; waiting for a machine names it", () => {
    const w = {
      ...base,
      status: "waiting" as const,
      waitingFor: "signer" as const,
      steps: { ...base.steps, review: { status: "ready" as const } },
    };
    expect(runRowWords(w, name)).toEqual({ text: "waiting for a signer", tone: "needs" });
    expect(runGlyph(w)).toBe("needs");
    expect(runRowWords({ ...w, waitingFor: "machine" }, name)).toEqual({ text: "waiting for lab-mac" });
    expect(runGlyph({ ...w, waitingFor: "machine" })).toBe("spinner");
  });
  it("done in, failed at, cancelled with its skipped count", () => {
    expect(runRowWords({ ...base, status: "done", endedAt: "2026-10-28T10:06:40.000Z" }, name).text).toBe(
      "done in 6 m 40 s",
    );
    expect(
      runRowWords(
        {
          ...base,
          status: "failed",
          steps: { ...base.steps, review: { status: "failed" }, fix: { status: "skipped" } },
        },
        name,
      ).text,
    ).toBe("failed at Review");
    expect(
      runRowWords(
        {
          ...base,
          status: "cancelled",
          steps: { ...base.steps, review: { status: "skipped" }, fix: { status: "skipped" } },
        },
        name,
      ).text,
    ).toBe("cancelled · 2 steps skipped");
    expect(runGlyph({ status: "cancelled" })).toBe("cancelled");
  });
});

describe("a step's row", () => {
  it("pending says what it runs after; done its span; sent is live with the activity's line", () => {
    expect(stepRowWords(base, 2, { machineName: name })).toEqual({ glyph: "idle", right: "after Review" });
    expect(stepRowWords(base, 0, { machineName: name })).toEqual({ glyph: "done", right: "2 m 05 s" });
    expect(stepRowWords(base, 1, { machineName: name, sentLine: "Starting codex on lab-mac…" })).toEqual({
      glyph: "spinner",
      right: "running",
      live: true,
      second: "Starting codex on lab-mac…",
    });
  });
  it("ready: starting…, then the signer line (with the passkey variant), or the machine's", () => {
    const ready = { ...base, steps: { ...base.steps, review: { status: "ready" as const } } };
    expect(stepRowWords(ready, 1, { machineName: name })).toEqual({ glyph: "idle", right: "starting…" });
    const signer = { ...ready, status: "waiting" as const, waitingFor: "signer" as const };
    expect(stepRowWords(signer, 1, { machineName: name })).toEqual({
      glyph: "needs",
      right: "",
      second: "Waiting for a signer. Open this page on a device that can sign.",
      tone: "needs",
    });
    expect(stepRowWords(signer, 1, { machineName: name, needsUnlock: true }).second).toBe("Waiting for your passkey.");
    expect(stepRowWords({ ...signer, waitingFor: "machine" }, 1, { machineName: name })).toEqual({
      glyph: "idle",
      right: "",
      second: "Waiting for lab-mac. It sends when the machine is back.",
    });
  });
  it("failed carries the activity's words, else the step's error; skipped names why", () => {
    const failed = {
      ...base,
      status: "failed" as const,
      steps: {
        ...base.steps,
        review: { status: "failed" as const, error: "start_limit: too many" },
        fix: { status: "skipped" as const },
      },
    };
    expect(stepRowWords(failed, 1, { machineName: name })).toEqual({
      glyph: "failed",
      right: "failed",
      second: "start_limit: too many",
      tone: "err",
    });
    expect(
      stepRowWords(failed, 1, {
        machineName: name,
        failureWords: "lab-mac refused it: the machine is already starting as many sessions as it allows.",
      }).second,
    ).toMatch(/^lab-mac refused/);
    expect(stepRowWords(failed, 2, { machineName: name })).toEqual({
      glyph: "skipped",
      right: "skipped · Review failed",
    });
    const cancelled = { ...failed, status: "cancelled" as const };
    expect(stepRowWords(cancelled, 2, { machineName: name }).right).toBe("skipped · cancelled");
  });
  it("after words join several", () => {
    const fan: WorkflowStep[] = [
      { ...plan[0]!, id: "first", name: "First", after: [] },
      { ...plan[1]!, id: "second", name: "Second", after: [] },
      { ...plan[2]!, id: "compare", name: "Compare", after: ["first", "second"] },
    ];
    expect(afterWords(fan, 2)).toBe("after First and Second");
    expect(afterWords(fan, 0)).toBe("");
  });
});

describe("durations and dates", () => {
  it("durExact", () => {
    expect(durExact(40_000)).toBe("40 s");
    expect(durExact(125_000)).toBe("2 m 05 s");
    expect(durExact(400_000)).toBe("6 m 40 s");
    expect(durExact(3_900_000)).toBe("1 h 05 m");
    expect(durExact(undefined)).toBe("");
  });
  it("startedLabel", () => {
    const now = new Date(2026, 9, 28, 15, 0).getTime();
    expect(startedLabel(new Date(2026, 9, 28, 14, 2).toISOString(), now)).toBe("Today 14:02");
    expect(startedLabel(new Date(2026, 9, 27, 9, 10).toISOString(), now)).toBe("Yesterday 09:10");
    expect(startedLabel(new Date(2026, 9, 12, 9, 10).toISOString(), now)).toMatch(/12/);
  });
});

describe("saveProblem", () => {
  const w = { name: "x", input: { label: "Task" }, steps: plan };
  it("a sound workflow has none", () => {
    expect(saveProblem(w)).toBeNull();
  });
  it("names the step and the placeholder that is wrong", () => {
    expect(saveProblem({ ...w, steps: [plan[0]!, { ...plan[1]!, text: "{{step.plan}}" }] })).toBe(
      "step 2 names {{step.plan}}, which there isn't",
    );
    expect(saveProblem({ ...w, steps: [{ ...plan[0]!, text: "{{prev}}" }] })).toBe(
      "step 1 names {{prev}}, but nothing runs before it",
    );
    expect(saveProblem({ ...w, input: undefined, steps: [plan[0]!] })).toBe(
      "step 1 names {{input}}, but the workflow takes none",
    );
    expect(saveProblem({ ...w, steps: [plan[0]!, { ...plan[1]!, text: "{{nope}}" }] })).toBe(
      "step 2 names {{nope}}, which isn't a placeholder",
    );
    expect(
      saveProblem({
        ...w,
        steps: [
          { ...plan[0]!, after: [] },
          { ...plan[1]!, after: [], text: "{{step.implement}}" },
        ],
      }),
    ).toBe("step 2 names {{step.implement}}, which doesn't run before it");
  });
  it("a cycle, an empty prompt, the size limits", () => {
    expect(saveProblem({ ...w, steps: [plan[0]!, plan[1]!, { ...plan[2]!, after: ["fix"] }] })).toBe(
      "step 3 can't run after itself",
    );
    expect(saveProblem({ ...w, steps: [{ ...plan[0]!, text: "  " }] })).toBe("step 1 needs a prompt");
    expect(saveProblem({ ...w, steps: [] })).toBe("add a step first");
    expect(
      saveProblem({ ...w, steps: Array.from({ length: 21 }, (_, i) => ({ ...plan[0]!, id: `s${i}`, text: "x" })) }),
    ).toBe("up to 20 steps");
    expect(saveProblem({ ...w, steps: [{ ...plan[0]!, text: "x".repeat(20_001) }] })).toBe(
      "step 1's prompt is over 20,000 characters",
    );
  });
});

describe("ids", () => {
  it("a workflow id is a slug and a tail, within the server's rule", () => {
    expect(newWorkflowId("Implement, then review", () => "abc123")).toBe("implement-then-review-abc123");
    expect(newWorkflowId("", () => "abc123")).toBe("workflow-abc123");
    expect(newWorkflowId("x".repeat(60), () => "abc123")).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });
  it("a step id is unique in its plan", () => {
    expect(newStepId("Review", [])).toBe("review");
    expect(newStepId("Review", ["review"])).toBe("review-2");
    expect(newStepId("", ["step"])).toBe("step-2");
  });
});
