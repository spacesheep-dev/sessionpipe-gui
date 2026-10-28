// SPDX-License-Identifier: Apache-2.0
// The three templates (templates.ts) read as workflows the server would take: every
// placeholder names a step that runs before it, and each step's harness is one the first
// paired machine's hello lists.
import type { MachineSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import { agentOptions, agentValue, parseAgentValue } from "./agentPicker";
import { harnessOn, TEMPLATES, workflowFromTemplate } from "./templates";
import { saveProblem } from "./words";

const lab: MachineSummary = {
  name: "lab-mac",
  lastAt: "2026-10-28T10:00:00.000Z",
  harnesses: {},
  sessions: 0,
  working: 0,
  needsYou: 0,
  control: { machineId: "m_lab00000000000001", online: true, keys: [], queued: 0, harnesses: ["claude-code", "codex"] },
};

describe("templates", () => {
  it("each reads as a sound workflow on the first paired machine", () => {
    for (const t of TEMPLATES) {
      const w = workflowFromTemplate(t, lab, { id: t.id, now: "2026-10-28T10:00:00.000Z" });
      expect(saveProblem(w), t.id).toBeNull();
      expect(w.template).toBe(t.id);
      expect(w.input).toEqual({ label: "Task" });
      for (const s of w.steps) expect(s.machineId).toBe("m_lab00000000000001");
    }
  });
  it("a harness the machine does not list falls back to Claude Code, then the first listed", () => {
    expect(harnessOn(lab.control, "gemini-cli")).toBe("claude-code");
    expect(harnessOn({ harnesses: ["codex"] }, "gemini-cli")).toBe("codex");
    expect(harnessOn(undefined, "gemini-cli")).toBe("gemini-cli");
    const w = workflowFromTemplate(TEMPLATES[2]!, lab);
    expect(w.steps[2]!.agent).toEqual({ harness: "claude-code" });
  });
  it("the second opinion's compare step runs after both roots", () => {
    const w = workflowFromTemplate(TEMPLATES[1]!, lab);
    expect(w.steps.map((s) => s.after)).toEqual([[], [], ["first", "second"]]);
  });
});

describe("the agent pop-up", () => {
  it("lists a new session per harness under each paired machine, and keeps a step's lost machine", () => {
    const opts = agentOptions([lab], [], { machineId: "m_gone", agent: { harness: "codex" } }, Date.now());
    expect(opts.map((o) => o.label)).toEqual([
      "lab-mac › Claude Code · new session",
      "lab-mac › Codex · new session",
      "Codex · new session",
    ]);
    expect(opts[2]).toMatchObject({ hint: "not paired", divider: true });
  });
  it("a value reads back to its machine and agent", () => {
    expect(parseAgentValue(agentValue("m1", { harness: "codex" }))).toEqual({
      machineId: "m1",
      agent: { harness: "codex" },
    });
    expect(parseAgentValue(agentValue("m1", { session: "codex:a:b" }))).toEqual({
      machineId: "m1",
      agent: { session: "codex:a:b" },
    });
    expect(parseAgentValue("nope")).toBeNull();
  });
});
