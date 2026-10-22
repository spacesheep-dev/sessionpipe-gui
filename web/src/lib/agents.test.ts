// SPDX-License-Identifier: Apache-2.0
// Subagents as the lists read them: what one is doing now (no tool facts for a harness
// that does not mark them), the parent's "n subagents running", the task notification,
// and where an agent's panel tab goes.
import type { AgentRun } from "@shared/api";
import { describe, expect, it } from "vitest";

// The router (which opening an agent goes through) listens on the window when loaded.
(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };
const { agentLabel, agentNow, agentsFact, agentsShown, taskNotification } = await import("./agents");
const { agentTabKey, parseTab } = await import("./split");

const T0 = Date.parse("2026-10-22T10:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: "ag1",
  state: "running",
  startedAt: iso(0),
  lastAt: iso(10),
  tools: 1,
  toolErrors: 0,
  attributed: true,
  recentTools: [],
  ...over,
});

describe("agentNow", () => {
  it("names the running tool and how long it has run", () => {
    expect(agentNow(run({ currentTool: { tool: "Grep", since: iso(6) } }), T0 + 10_000)).toBe("Grep · 4 s");
  });
  it("reads Thinking between tools, and quiet once stale", () => {
    expect(agentNow(run(), T0 + 11_000)).toBe("Thinking");
    expect(agentNow(run({ state: "stale" }), T0 + 10_000 + 12 * 60_000)).toBe("Quiet for 12 m 00 s");
  });
  it("says only Running when its tools are not told apart (Codex)", () => {
    expect(agentNow(run({ attributed: false, currentTool: { tool: "shell", since: iso(6) } }), T0 + 9000)).toBe(
      "Running",
    );
  });
  it("is how long it ran once done", () => {
    expect(agentNow(run({ state: "done", endedAt: iso(72) }), T0 + 999_000)).toBe("1 m 12 s");
  });
});

describe("the parent's fact", () => {
  it("counts the open agents, and the quiet ones", () => {
    const base = { counts: { agentsRunning: 2 } } as const;
    expect(agentsFact({ ...base, agents: [run(), run({ id: "b" })] } as never)).toBe("2 subagents running");
    expect(agentsFact({ ...base, agents: [run(), run({ id: "b", state: "stale" })] } as never)).toBe(
      "2 subagents · 1 quiet",
    );
    expect(agentsFact({ counts: { agentsRunning: 0 }, agents: [run({ state: "done" })] } as never)).toBeNull();
  });
});

describe("agent rows", () => {
  it("label with the description only when one was sent", () => {
    expect(agentLabel({ type: "Explore", description: "Find it" })).toBe("Explore · Find it");
    expect(agentLabel({ type: "Explore" })).toBe("Explore");
    expect(agentLabel({})).toBe("Subagent");
  });
  it("show every open agent, then the newest finished ones", () => {
    const list = [
      run({ id: "o1" }),
      run({ id: "d1", state: "done" }),
      run({ id: "d2", state: "done" }),
      run({ id: "d3", state: "done" }),
      run({ id: "d4", state: "done" }),
    ];
    const { shown, more } = agentsShown(list, 3);
    expect(shown.map((a) => a.id)).toEqual(["o1", "d1", "d2", "d3"]);
    expect(more).toBe(1);
  });
});

describe("taskNotification", () => {
  it("reads Claude Code's follow-up prompt, and nothing else", () => {
    const text = [
      "<task-notification>",
      "<task-id>a8f3c2</task-id>",
      "<status>completed</status>",
      '<summary>Agent "Check cache invalidation" finished</summary>',
      "<result>One stale path.</result>",
      "</task-notification>",
    ].join("\n");
    expect(taskNotification(text)).toEqual({
      agentId: "a8f3c2",
      summary: 'Agent "Check cache invalidation" finished',
    });
    expect(taskNotification("Please run the <task-notification> tests")).toBeUndefined();
  });
});

describe("agent tabs", () => {
  it("are the session's key and the agent's id", () => {
    const k = agentTabKey("claude-code:s1", "ag1");
    expect(parseTab(k)).toEqual({ session: "claude-code:s1", agent: "ag1" });
    expect(parseTab("claude-code:s1")).toEqual({ session: "claude-code:s1" });
  });
});
