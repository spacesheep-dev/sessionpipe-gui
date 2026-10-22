// SPDX-License-Identifier: Apache-2.0
// The agents reading (shared/api.ts AgentRun): subagents as Claude Code and Codex send
// them, inside the parent's session, and as a child session with parent_id.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionKey } from "../../shared/api.js";
import { Session, SID, tempDir } from "../../test/events.js";
import { Store } from "./store.js";

const KEY = sessionKey("claude-code", SID);
let tmp: { dir: string; cleanup: () => void };
let store: Store;

beforeEach(() => {
  tmp = tempDir();
  store = new Store(tmp.dir, { tickMs: 60_000, statsMs: 60_000 });
});
afterEach(async () => {
  await store.close();
  tmp.cleanup();
});

const read = () => store.session(KEY)!;

describe("agents", () => {
  it("reads Claude Code's background agent in the order the recording has it", () => {
    const s = new Session();
    const feed = (type: string, data: Record<string, unknown> = {}) => store.ingest([s.ev(type, data)], "http");
    feed("session.started", { source: "startup" });
    feed("turn.started", { turn_id: "t1", prompt_chars: 120 });
    feed("tool.started", {
      tool: "Agent",
      call_id: "toolu_1",
      turn_id: "t1",
      input: { description: "Find ad-hoc money formatting", subagent_type: "Explore" },
    });
    feed("tool.ended", {
      tool: "Agent",
      call_id: "toolu_1",
      turn_id: "t1",
      ok: true,
      output: { isAsync: true, status: "async_launched", agentId: "adae41" },
    });
    feed("subagent.started", { agent_id: "adae41", agent_type: "Explore" });
    // The orchestrator's turn ends while its agent works on.
    feed("turn.ended", { turn_id: "t1", reason: "stop" });
    let r = read();
    expect(r.state).toBe("working");
    expect(r.counts.agentsRunning).toBe(1);
    expect(r.agents[0]).toMatchObject({
      id: "adae41",
      type: "Explore",
      description: "Find ad-hoc money formatting",
      callId: "toolu_1",
      turnId: "t1",
      state: "running",
    });
    expect(r.agents[0]!.result).toBeUndefined();

    feed("tool.started", { tool: "Bash", call_id: "toolu_2", agent_id: "adae41", turn_id: "t1", input: {} });
    r = read();
    // The agent's tool is the agent's, not the orchestrator's.
    expect(r.currentTool).toBeUndefined();
    expect(r.currentTurn).toBeUndefined();
    expect(r.agents[0]!.currentTool).toMatchObject({ tool: "Bash", callId: "toolu_2" });
    expect(r.agents[0]!.attributed).toBe(true);

    feed("tool.ended", { tool: "Bash", call_id: "toolu_2", agent_id: "adae41", ok: false });
    r = read();
    expect(r.agents[0]).toMatchObject({ tools: 1, toolErrors: 1, recentTools: [{ tool: "Bash", ok: false }] });
    expect(r.agents[0]!.currentTool).toBeUndefined();

    feed("subagent.ended", { agent_id: "adae41", agent_type: "Explore" });
    r = read();
    expect(r.state).toBe("idle");
    expect(r.counts.agentsRunning).toBe(0);
    expect(r.agents[0]!.state).toBe("done");
    expect(r.agents[0]!.endedAt).toBeDefined();

    // The harness's own follow-up turn carries the result (tier 2+).
    const note =
      "<task-notification>\n<task-id>adae41</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n" +
      '<summary>Agent "Find ad-hoc money formatting" finished</summary>\n<result>Three places: render.ts:88, monthly.ts:41, backfill.ts:17.</result>\n</task-notification>';
    feed("turn.started", { turn_id: "t2", prompt_chars: note.length });
    feed("turn.ended", { turn_id: "t2", reason: "stop" });
    feed("turn.transcript", { turn: 1, user: note, assistant: "Fixed the two in src/." });
    expect(read().agents[0]!.result).toBe("Three places: render.ts:88, monthly.ts:41, backfill.ts:17.");
  });

  it("keeps a synchronous agent's result and the orchestrator's own tool", () => {
    const s = new Session();
    store.ingest(
      [
        s.ev("turn.started", { turn_id: "t1" }),
        s.ev("tool.started", { tool: "Agent", call_id: "c1", input: { description: "Review the diff" } }),
        s.ev("subagent.started", { agent_id: "a1", agent_type: "general-purpose" }),
      ],
      "http",
    );
    expect(read().currentTool).toMatchObject({ tool: "Agent" });
    store.ingest(
      [
        s.ev("subagent.ended", { agent_id: "a1" }),
        s.ev("tool.ended", {
          tool: "Agent",
          call_id: "c1",
          ok: true,
          output: "Two issues: a missing await in pay.ts.",
        }),
      ],
      "http",
    );
    const a = read().agents[0]!;
    expect(a).toMatchObject({ id: "a1", description: "Review the diff", callId: "c1", state: "done" });
    expect(a.result).toBe("Two issues: a missing await in pay.ts.");
  });

  it("runs parallel agents side by side, open ones first", () => {
    const s = new Session();
    store.ingest(
      [
        s.ev("turn.started", { turn_id: "t1" }),
        s.ev("tool.started", { tool: "Agent", call_id: "c1", input: { description: "One", subagent_type: "Explore" } }),
        s.ev("tool.ended", { tool: "Agent", call_id: "c1", output: { isAsync: true, agentId: "a1" } }),
        s.ev("subagent.started", { agent_id: "a1", agent_type: "Explore" }),
        s.ev("tool.started", { tool: "Agent", call_id: "c2", input: { description: "Two", subagent_type: "Explore" } }),
        s.ev("tool.ended", { tool: "Agent", call_id: "c2", output: { isAsync: true, agentId: "a2" } }),
        s.ev("subagent.started", { agent_id: "a2", agent_type: "Explore" }),
        s.ev("turn.ended", { turn_id: "t1" }),
        s.ev("subagent.ended", { agent_id: "a1" }),
      ],
      "http",
    );
    const r = read();
    expect(r.agents.map((a) => [a.id, a.state, a.description])).toEqual([
      ["a2", "running", "Two"],
      ["a1", "done", "One"],
    ]);
    expect(r.counts.agentsRunning).toBe(1);
    expect(r.counts.subagents).toBe(2);
    expect(r.state).toBe("working");
  });

  it("reads Codex's bracket-only agent without attributing tools", () => {
    const s = new Session(SID, "codex");
    store.ingest(
      [
        s.ev("turn.started", { turn_id: "t1" }),
        s.ev("subagent.started", { agent_id: "worker-1", agent_type: "worker" }),
        s.ev("tool.started", { tool: "exec", call_id: "x1" }),
      ],
      "http",
    );
    const r = store.session(sessionKey("codex", SID))!;
    expect(r.agents[0]).toMatchObject({ id: "worker-1", attributed: false, tools: 0 });
    expect(r.currentTool).toMatchObject({ tool: "exec" });
  });

  it("closes open agents when the session ends", () => {
    const s = new Session();
    store.ingest([s.ev("subagent.started", { agent_id: "a1" }), s.ev("session.ended", { reason: "exit" })], "http");
    expect(read().agents[0]!.state).toBe("done");
    expect(read().counts.agentsRunning).toBe(0);
  });

  it("merges a child session (parent_id) into its parent's agents, either arrival order", () => {
    const child = new Session("ag_child", "claude-code");
    store.ingest(
      [
        child.ev("session.started", { source: "fork" }, { session: { parent_id: SID } }),
        child.ev("tool.started", { tool: "Grep", call_id: "g1" }, { session: { parent_id: SID } }),
      ],
      "http",
    );
    const parent = new Session();
    store.ingest(
      [parent.ev("turn.started", { turn_id: "t1" }), parent.ev("subagent.started", { agent_id: "ag_child" })],
      "http",
    );
    let r = read();
    expect(r.children).toBe(1);
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0]).toMatchObject({
      id: "ag_child",
      session: sessionKey("claude-code", "ag_child"),
      state: "running",
      currentTool: { tool: "Grep" },
    });
    store.ingest([child.ev("tool.ended", { tool: "Grep", call_id: "g1", ok: true })], "http");
    expect(read().agents[0]).toMatchObject({ tools: 1 });
    store.ingest([parent.ev("subagent.ended", { agent_id: "ag_child" })], "http");
    r = read();
    expect(r.agents[0]!.state).toBe("done");
    store.forget(sessionKey("claude-code", "ag_child"));
    expect(read().agents[0]!.session).toBeUndefined();
  });

  it("pages one agent's events with DetailQuery.agent", () => {
    const s = new Session();
    store.ingest(
      [
        s.ev("turn.started", { turn_id: "t1" }),
        s.ev("tool.started", { tool: "Agent", call_id: "c1", input: { description: "Sweep" } }),
        s.ev("tool.ended", { tool: "Agent", call_id: "c1", output: { isAsync: true, agentId: "a1" } }),
        s.ev("subagent.started", { agent_id: "a1" }),
        s.ev("tool.started", { tool: "Read", call_id: "own" }),
        s.ev("tool.started", { tool: "Grep", call_id: "g1", agent_id: "a1" }),
        s.ev("tool.ended", { tool: "Grep", call_id: "g1", agent_id: "a1" }),
        s.ev("subagent.ended", { agent_id: "a1" }),
      ],
      "http",
    );
    const d = store.sessionDetail(KEY, undefined, undefined, { agent: "a1", slim: true })!;
    expect(d.events.map((e) => e.type)).toEqual([
      "tool.started",
      "tool.ended",
      "subagent.started",
      "tool.started",
      "tool.ended",
      "subagent.ended",
    ]);
    expect(d.total).toBe(6);
  });

  it("reads the same after a restart", async () => {
    const s = new Session();
    store.ingest(
      [
        s.ev("turn.started", { turn_id: "t1" }),
        s.ev("tool.started", { tool: "Agent", call_id: "c1", input: { description: "Sweep" } }),
        s.ev("subagent.started", { agent_id: "a1", agent_type: "Explore" }),
      ],
      "http",
    );
    const before = read().agents;
    await store.close();
    store = new Store(tmp.dir, { tickMs: 60_000, statsMs: 60_000 });
    expect(read().agents).toEqual(before);
  });
});
