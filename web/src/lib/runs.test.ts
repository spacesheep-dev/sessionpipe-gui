// SPDX-License-Identifier: Apache-2.0
// What sessionpipe 0.10 adds to a row: background work, an unattended run, who submitted a turn.
import { describe, expect, it } from "vitest";
import { backgroundFact, quietRun, submittedLabel } from "./runs";

const T = "2026-10-26T10:00:00.000Z";
const after = (s: number) => new Date(Date.parse(T) + s * 1000).toISOString();

describe("backgroundFact", () => {
  it("counts what the last turn left running, and says nothing while a turn runs", () => {
    expect(backgroundFact({ background: { tasks: 2, since: T } })).toBe("waiting on 2 background tasks");
    expect(backgroundFact({ background: { tasks: 1, since: T } })).toBe("waiting on 1 background task");
    expect(backgroundFact({ background: { tasks: 1, since: T }, currentTurn: { since: T } })).toBeNull();
    expect(backgroundFact({})).toBeNull();
  });
});

describe("quietRun", () => {
  const run = { attended: false, state: "done" as const, startedAt: T, lastAt: after(20) };
  it("is a finished unattended run under a minute", () => {
    expect(quietRun(run)).toBe(true);
    expect(quietRun({ ...run, state: "idle" })).toBe(true);
    expect(quietRun({ ...run, lastAt: after(90) })).toBe(false);
    expect(quietRun({ ...run, state: "working" })).toBe(false);
  });
  it("never one the harness said nothing about, or attended", () => {
    expect(quietRun({ ...run, attended: undefined })).toBe(false);
    expect(quietRun({ ...run, attended: true })).toBe(false);
  });
});

describe("submittedLabel", () => {
  it("names the harness's own non-person words, keeps an unknown one, and says nothing for a person", () => {
    expect(submittedLabel("schedule_wakeup")).toBe("Scheduled");
    expect(submittedLabel("loop_wakeup")).toBe("Loop wake-up");
    expect(submittedLabel("system")).toBe("System");
    expect(submittedLabel("user")).toBeUndefined();
    expect(submittedLabel("sdk")).toBeUndefined();
    expect(submittedLabel(undefined)).toBeUndefined();
    expect(submittedLabel("cron_tick")).toBe("Submitted by cron_tick");
  });
});
