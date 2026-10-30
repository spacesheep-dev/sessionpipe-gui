// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The three templates the list offers under the saved
// workflows (UX-SPEC §4.4): each a fresh copy, named after the template, on the first
// paired machine, every step's agent the harness the template names when that machine's
// hello lists it, else the first harness it lists. Saved on the first change in the
// editor (the copy carries `template: <id>`), never seeded on the server.
import type { MachineControl, MachineSummary, Workflow, WorkflowStep } from "@shared/api";
import { newWorkflowId } from "./words";

export interface TemplateStep {
  id: string;
  name: string;
  harness: string;
  text: string;
  /** Absent: the step before; `[]`: a root. */
  after?: string[];
}

export interface Template {
  id: string;
  name: string;
  /** The one line under the name in the list. */
  line: string;
  steps: TemplateStep[];
}

export const TEMPLATES: readonly Template[] = [
  {
    id: "implement-review",
    name: "Implement, then review",
    line: "Claude Code builds it, Codex reviews, Claude Code fixes",
    steps: [
      {
        id: "implement",
        name: "Implement",
        harness: "claude-code",
        text: "Implement this: {{input}}. Keep the diff small and say what you changed.",
      },
      {
        id: "review",
        name: "Review",
        harness: "codex",
        text: "Review this change for bugs and anything you'd do differently. Be concrete.\n\n{{prev}}",
      },
      {
        id: "fix",
        name: "Fix",
        harness: "claude-code",
        text: "Apply the review below where it is right, say where it isn't.\n\n{{prev}}",
      },
    ],
  },
  {
    id: "second-opinion",
    name: "Second opinion",
    line: "Two agents answer the same question; a third compares",
    steps: [
      { id: "first", name: "First", harness: "claude-code", text: "{{input}}", after: [] },
      { id: "second", name: "Second", harness: "codex", text: "{{input}}", after: [] },
      {
        id: "compare",
        name: "Compare",
        harness: "gemini-cli",
        text: "Two agents answered the same question. Compare the answers, say which is right and why.\n\nQuestion: {{input}}\n\nFirst:\n{{step.first}}\n\nSecond:\n{{step.second}}",
        after: ["first", "second"],
      },
    ],
  },
  {
    id: "plan-build-test",
    name: "Plan, build, test",
    line: "Plan with Claude Code, build with Codex, test with Gemini",
    steps: [
      { id: "plan", name: "Plan", harness: "claude-code", text: "Plan this, as a short list of steps: {{input}}" },
      { id: "build", name: "Build", harness: "codex", text: "Build it, following this plan:\n\n{{prev}}" },
      {
        id: "test",
        name: "Test",
        harness: "gemini-cli",
        text: "Write and run tests for what was just built. Report what passes and what doesn't.\n\n{{prev}}",
      },
    ],
  },
];

export const templateById = (id: string): Template | undefined => TEMPLATES.find((t) => t.id === id);

/** A harness for a template step on a machine: the one named when the hello lists it,
 *  else the first the hello lists (Claude Code before the rest), else the name as is. */
export function harnessOn(control: Pick<MachineControl, "harnesses"> | undefined, want: string): string {
  const list = control?.harnesses ?? [];
  if (list.includes(want)) return want;
  if (list.includes("claude-code")) return "claude-code";
  return list[0] ?? want;
}

/** The template as a workflow on `machine` (the first paired one), unsaved. */
export function workflowFromTemplate(
  t: Template,
  machine: MachineSummary | undefined,
  o: { id?: string; now?: string } = {},
): Workflow {
  const now = o.now ?? new Date().toISOString();
  const c = machine?.control;
  const steps: WorkflowStep[] = t.steps.map((s) => ({
    id: s.id,
    name: s.name,
    machineId: c?.machineId ?? "",
    agent: { harness: harnessOn(c, s.harness) },
    text: s.text,
    ...(s.after ? { after: [...s.after] } : {}),
  }));
  return {
    id: o.id ?? newWorkflowId(t.name),
    name: t.name,
    input: { label: "Task" },
    steps,
    createdAt: now,
    updatedAt: now,
    template: t.id,
  };
}
