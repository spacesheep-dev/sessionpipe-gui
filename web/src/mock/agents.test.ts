// SPDX-License-Identifier: Apache-2.0
// The mock reads subagents as the receiver does (server/store/readings.ts): an agent's
// launch call names it, its tools are its own, a foreground call's output and a
// background agent's <task-notification> carry its result.
import type { StoredEvent } from "@shared/api";
import { describe, expect, it } from "vitest";
import { AgentReading } from "./agents";
import { World } from "./world";

const T0 = Date.parse("2026-10-22T10:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
let seq = 0;
const ev = (type: string, s: number, data: Record<string, unknown> = {}): StoredEvent => ({
  protocol: 1,
  id: `e${seq}`,
  type,
  time: iso(s),
  tier: 3,
  harness: { name: "claude-code" },
  session: { id: "s1", seq: seq++ },
  privacy: { rulesets: [], pii: false },
  data,
  arrivedAt: iso(s),
  source: "http",
});

describe("AgentReading", () => {
  it("links a background agent to its call and takes its result from the notification", () => {
    const r = new AgentReading();
    const events = [
      ev("turn.started", 0, { turn_id: "t1" }),
      ev("tool.started", 1, {
        tool: "Agent",
        call_id: "c1",
        turn_id: "t1",
        input: { description: "Check cache invalidation", subagent_type: "Explore" },
      }),
      ev("tool.ended", 2, {
        tool: "Agent",
        call_id: "c1",
        output: { isAsync: true, status: "async_launched", agentId: "ag1" },
      }),
      ev("subagent.started", 2, { agent_id: "ag1", agent_type: "Explore" }),
      ev("turn.ended", 3, { turn_id: "t1" }),
      ev("tool.started", 4, { tool: "Grep", call_id: "c2", agent_id: "ag1", turn_id: "t1" }),
    ];
    const own = events.map((e) => r.apply(e));
    expect(own).toEqual([false, false, false, false, false, true]);
    let [a] = r.settle(T0 + 5000, false, iso(5));
    expect(a).toMatchObject({
      id: "ag1",
      type: "Explore",
      description: "Check cache invalidation",
      callId: "c1",
      turnId: "t1",
      state: "running",
      attributed: true,
      currentTool: { tool: "Grep" },
    });
    r.apply(ev("tool.ended", 6, { tool: "Grep", call_id: "c2", agent_id: "ag1", ok: false }));
    r.apply(ev("subagent.ended", 7, { agent_id: "ag1" }));
    r.apply(
      ev("turn.transcript", 9, {
        user: "<task-notification>\n<task-id>ag1</task-id>\n<result>One stale path.</result>\n</task-notification>",
      }),
    );
    [a] = r.settle(T0 + 10_000, false, iso(10));
    expect(a).toMatchObject({ state: "done", tools: 1, toolErrors: 1, result: "One stale path." });
    expect(a!.currentTool).toBeUndefined();
  });

  it("takes a foreground agent's result from the call's output", () => {
    const r = new AgentReading();
    for (const e of [
      ev("tool.started", 0, { tool: "Agent", call_id: "c1", input: { description: "List untested paths" } }),
      ev("subagent.started", 1, { agent_id: "ag2", agent_type: "general-purpose" }),
      ev("subagent.ended", 5, { agent_id: "ag2" }),
      ev("tool.ended", 6, {
        tool: "Agent",
        call_id: "c1",
        output: { status: "completed", agentId: "ag2", content: [{ type: "text", text: "Eviction has no tests." }] },
      }),
    ])
      r.apply(e);
    expect(r.settle(T0 + 7000, false, iso(7))[0]).toMatchObject({
      description: "List untested paths",
      result: "Eviction has no tests.",
      state: "done",
    });
  });
});

describe("the mock World", () => {
  it("plays the three-agent scene inside one session, and keeps one child session as an agent", () => {
    const w = new World();
    const snap = w.snapshot();
    if (snap.kind !== "snapshot") throw new Error("no snapshot");
    const bm25 = snap.snapshot.sessions.find((s) => s.title === "Search: review the BM25 cache")!;
    expect(bm25.state).toBe("working");
    expect(bm25.agents).toHaveLength(3);
    expect(bm25.counts.agentsRunning).toBe(1);
    expect(bm25.currentTool).toBeUndefined();
    const done = bm25.agents.filter((a) => a.state === "done");
    expect(done.map((a) => a.result).every(Boolean)).toBe(true);
    const parent = snap.snapshot.sessions.find((s) => s.title === "Open-source session hooks")!;
    expect(parent.agents.some((a) => a.session)).toBe(true);
    expect(parent.agents.find((a) => a.id === "ag_explore_1")?.state).toBe("running");
    const detail = w.detail(parent.harness, parent.id, { agent: "ag_explore_1" })!;
    expect(detail.events.length).toBeGreaterThan(0);
    expect(detail.events.every((e) => e.data.agent_id === "ag_explore_1" || e.data.call_id === "toolu_explore_1")).toBe(
      true,
    );
  });
});
