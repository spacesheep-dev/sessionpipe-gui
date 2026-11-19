// SPDX-License-Identifier: Apache-2.0
// Subagents as the lists read them: what one is doing now (no tool facts for a harness
// that does not mark them), the parent's "n subagents running", when its tree opens by
// itself, the task notification, and where an agent's panel tab goes.
import type { AgentRun, SessionState } from "@shared/api";
import { describe, expect, it } from "vitest";

// The router (which opening an agent goes through) listens on the window when loaded.
(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };
const {
  agentFound,
  agentLabel,
  agentNow,
  agentsChoice,
  agentsFact,
  agentsLive,
  agentsOpen,
  agentsRunningFact,
  agentsShown,
  setAgentsChoice,
  taskNotification,
} = await import("./agents");
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
    expect(agentNow(run({ state: "stale" }), T0 + 10_000 + 12 * 60_000)).toBe("Quiet for 12 m");
  });
  it("says only Running when its tools are not told apart (Codex)", () => {
    expect(agentNow(run({ attributed: false, currentTool: { tool: "shell", since: iso(6) } }), T0 + 9000)).toBe(
      "Running",
    );
  });
  it("is how long it ran once done", () => {
    expect(agentNow(run({ state: "done", endedAt: iso(72) }), T0 + 999_000)).toBe("1 m");
  });
});

describe("the parent's fact", () => {
  it("on the session page counts the open agents, and the quiet ones", () => {
    const base = { counts: { agentsRunning: 2 } } as const;
    expect(agentsFact({ ...base, agents: [run(), run({ id: "b" })] } as never)).toBe("2 subagents running");
    expect(agentsFact({ ...base, agents: [run(), run({ id: "b", state: "stale" })] } as never)).toBe(
      "2 subagents · 1 quiet",
    );
    expect(agentsFact({ counts: { agentsRunning: 0 }, agents: [run({ state: "done" })] } as never)).toBeNull();
  });
  it("on the board counts only the agents running now", () => {
    expect(agentsRunningFact({ agents: [run(), run({ id: "b" }), run({ id: "c", state: "done" })] })).toBe(
      "2 subagents running",
    );
    expect(agentsRunningFact({ agents: [run(), run({ id: "b", state: "stale" })] })).toBe("1 subagent running");
    // Gone quiet, every one: nothing to say (counts.agentsRunning would still say 2).
    expect(agentsRunningFact({ agents: [run({ state: "stale" }), run({ id: "b", state: "stale" })] })).toBeNull();
    expect(agentsRunningFact({ agents: [] })).toBeNull();
  });
});

describe("a parent's tree", () => {
  const parent = (state: SessionState, ...agents: AgentRun[]) => ({ state, agents });
  it("is live only while it works or needs you and an agent runs now", () => {
    expect(agentsLive(parent("working", run({ state: "done" }), run({ id: "b" })))).toBe(true);
    expect(agentsLive(parent("needs_you", run()))).toBe(true);
    // Quiet agents keep counts.agentsRunning up, and the parent stale: not live.
    expect(agentsLive(parent("working", run({ state: "stale" }), run({ id: "b", state: "stale" })))).toBe(false);
    expect(agentsLive(parent("stale", run()))).toBe(false);
    expect(agentsLive(parent("idle", run({ state: "done" })))).toBe(false);
  });
  it("opens by itself while live, and the person's choice wins either way", () => {
    expect(agentsOpen(parent("stale", run({ state: "stale" })), undefined)).toBe(false);
    expect(agentsOpen(parent("needs_you", run()), undefined)).toBe(true);
    expect(agentsOpen(parent("stale", run({ state: "stale" })), true)).toBe(true);
    expect(agentsOpen(parent("working", run()), false)).toBe(false);
    // The choice is the one kept on this device for that parent.
    setAgentsChoice("claude-code:quiet", true);
    expect(agentsOpen(parent("stale", run({ state: "stale" })), agentsChoice("claude-code:quiet"))).toBe(true);
    expect(agentsChoice("claude-code:other")).toBeUndefined();
  });
});

describe("agent rows", () => {
  it("label with the description only when one was sent", () => {
    expect(agentLabel({ type: "Explore", description: "Find it" })).toBe("Explore · Find it");
    expect(agentLabel({ type: "Explore" })).toBe("Explore");
    expect(agentLabel({})).toBe("Subagent");
  });
  const list = [
    run({ id: "o1", type: "general-purpose" }),
    ...[1, 2, 3, 4, 5].map((n) => run({ id: `d${n}`, state: "done", type: n % 2 ? "Explore" : "general-purpose" })),
  ];
  it("show every open agent, then the newest finished ones", () => {
    const { shown, more } = agentsShown(list, 3);
    expect(shown.map((a) => a.id)).toEqual(["o1", "d1", "d2", "d3"]);
    expect(more).toBe(2);
    // A phone with an agent still open: the open ones, every finished one left for "Show n finished".
    const folded = agentsShown(list, 0);
    expect(folded.shown.map((a) => a.id)).toEqual(["o1"]);
    expect(folded.more).toBe(5);
  });
  it("list the one a fold would leave out", () => {
    const { shown, more } = agentsShown(list.slice(0, 5), 3);
    expect(shown.map((a) => a.id)).toEqual(["o1", "d1", "d2", "d3", "d4"]);
    expect(more).toBe(0);
  });
  it("list the finished ones a search found, whatever their age", () => {
    expect(agentFound(list[1]!, "explore")).toBe(true);
    expect(agentFound(list[1]!, "Explore general")).toBe(false);
    expect(agentFound(list[1]!, " ")).toBe(false);
    const found = (a: AgentRun) => agentFound(a, "Explore");
    // The open one stays; d1, d3 and d5 are the Explore ones, d2 and d4 wait under "Show 2 more".
    const { shown, more } = agentsShown(list, 3, found);
    expect(shown.map((a) => a.id)).toEqual(["o1", "d1", "d3", "d5"]);
    expect(more).toBe(2);
    // Nothing finished that it found: the open ones, and every finished one left.
    const none = agentsShown(list, 3, (a) => agentFound(a, "Plan"));
    expect(none.shown.map((a) => a.id)).toEqual(["o1"]);
    expect(none.more).toBe(5);
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
