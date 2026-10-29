// SPDX-License-Identifier: Apache-2.0
// The simulation is checked on its own virtual clock (deterministic, instant), then the
// runner on the wall clock at speed 1000 against a fake store.
import { describe, expect, it } from "vitest";
import { DONE_AFTER_MS, type EventSource, type ProtocolEvent } from "../../shared/api.js";
import type { Control } from "../control/index.js";
import { type Hello, MACHINE_RE, parseHello } from "../control/parse.js";
import type { DemoStart } from "../control/state.js";
import { applyEvent, newRecord, refreshState } from "../store/readings.js";
import type { Store } from "../store/store.js";
import { MODELS } from "./content.js";
import { startDemo } from "./index.js";
import { DEMO_ACP_SESSION, demoMachineId, startDemoMachines } from "./machine.js";
import { DEMO_API_ACCOUNT, DEMO_POOL, DEMO_POOL_UNTIL_MS, type DemoStarted, Simulation } from "./sim.js";
import { TYPE_TIER, validate } from "./validate.js";

class FakeStore {
  batches: { events: ProtocolEvent[]; source: EventSource }[] = [];
  ingest(events: ProtocolEvent[], source: EventSource) {
    this.batches.push({ events: events.map((e) => structuredClone(e)), source });
    return { accepted: events.length, duplicates: 0, rejected: [], stored: [] };
  }
  get events(): ProtocolEvent[] {
    return this.batches.flatMap((b) => b.events);
  }
}
const asStore = (s: FakeStore) => s as unknown as Store;

const T0 = Date.parse("2026-10-14T12:00:00.000Z");
const TEN_MINUTES = 10 * 60_000;
/** Things still in flight at the cut-off are not failures: the window a tool, a
 *  permission prompt or a subagent can legitimately still be open. */
const SETTLE_MS = 90_000;

const key = (e: ProtocolEvent) => `${e.harness.name}:${e.session.id}`;

/** The fixture run's seed: one whose first minutes play every scenario these tests read
 *  (each model, no Antigravity resume in the first 12 minutes). */
const SEED = 2;
function run(seed = SEED, minutes = 10, machines = 2): ProtocolEvent[] {
  const sim = new Simulation({ seed, startAt: T0, speed: 1, machines });
  return sim.advance(minutes * 60_000);
}

describe("Simulation: a 10-minute run", () => {
  const events = run();
  const cutoff = T0 + TEN_MINUTES - SETTLE_MS;
  const settled = (e: ProtocolEvent) => Date.parse(e.time) < cutoff;

  it("emits a few hundred events and every one validates", () => {
    expect(events.length).toBeGreaterThan(250);
    const bad = events.map((e) => ({ e, problems: validate(e) })).filter((x) => x.problems.length);
    expect(bad.map((x) => `${x.e.type}: ${x.problems.join("; ")}`)).toEqual([]);
    for (const e of events) {
      expect(e.tier).toBe(3);
      expect(e.tier).toBeGreaterThanOrEqual(TYPE_TIER[e.type] ?? 0);
      expect(e.privacy).toEqual({ rulesets: ["secrets@1"], pii: false });
    }
  });

  it("stamps time in emit order and ids that sort with it", () => {
    for (let i = 1; i < events.length; i++) {
      const a = events[i - 1] as ProtocolEvent;
      const b = events[i] as ProtocolEvent;
      if (a.type === "session.backfill" || b.type === "session.backfill") continue;
      // The usage limits' earlier sessions are dated before the demo began (limitsScene).
      if (Date.parse(a.time) < T0 || Date.parse(b.time) < T0) continue;
      expect(Date.parse(b.time)).toBeGreaterThanOrEqual(Date.parse(a.time));
      expect(b.id > a.id).toBe(true);
    }
  });

  it("keeps seq strictly monotonic per (harness, session)", () => {
    const last = new Map<string, number>();
    for (const e of events) {
      const k = key(e);
      const prev = last.get(k);
      if (prev !== undefined) expect(e.session.seq, `${k} after seq ${prev}`).toBeGreaterThan(prev);
      last.set(k, e.session.seq);
    }
  });

  it("starts every session with session.started (or a backfill) before anything else", () => {
    const seen = new Set<string>();
    for (const e of events) {
      const k = key(e);
      if (!seen.has(k)) {
        expect(["session.started", "session.backfill"], `${k} opened with ${e.type}`).toContain(e.type);
        seen.add(k);
      }
    }
    const starts = events.filter((e) => e.type === "session.started").map((e) => e.data.source);
    expect(new Set(starts)).toEqual(new Set(["startup", "resume", "compact", "fork", "unknown"]));
  });

  it("grows the session block COALESCE-style and never drops a learned field", () => {
    const known = new Map<string, Record<string, unknown>>();
    for (const e of events) {
      if (e.type === "session.backfill") continue;
      const k = key(e);
      const prev = known.get(k) ?? {};
      for (const [f, v] of Object.entries(prev))
        if (v) expect(e.session[f as keyof typeof e.session], `${k} lost ${f}`).toBeTruthy();
      known.set(k, { ...prev, ...e.session });
    }
    // The showcase session learns repo, branch, title, model and url after it started.
    const first = events.find(
      (e) => e.type === "session.started" && e.harness.name === "claude-code" && e.session.cwd === "~/code/billing",
    ) as ProtocolEvent;
    const showcase = events.filter((e) => e.session.id === first.session.id);
    expect(first.session.repo).toBeUndefined();
    expect(first.session.cwd).toBe("~/code/billing");
    const later = showcase.find((e) => e.type === "turn.ended") as ProtocolEvent;
    expect(later.session).toMatchObject({
      repo: "github.com/acme/billing",
      branch: "fix/webhook-retry",
      model: expect.stringMatching(/^claude-/),
      url: expect.stringMatching(/^https:\/\/claude\.ai\/code\/session_01/),
      account_id: expect.any(String),
    });
    const sources = new Set(showcase.map((e) => e.session.title_source).filter(Boolean));
    expect(sources).toEqual(new Set(["first-ask", "harness", "custom"]));
  });

  it("clears every attention it raises", () => {
    const open = new Map<string, ProtocolEvent>();
    for (const e of events) {
      const id = e.data.attention_id as string;
      if (e.type === "attention.needed") open.set(`${key(e)}|${id}`, e);
      if (e.type === "attention.cleared") {
        expect(open.delete(`${key(e)}|${id}`), `cleared ${id} that was never raised`).toBe(true);
        expect(e.data.how).toBe("answered");
      }
    }
    expect([...open.values()].filter(settled)).toEqual([]);
    const perm = events.find((e) => e.type === "attention.needed" && e.harness.name === "claude-code") as ProtocolEvent;
    expect(perm.harness.event).toBe("PermissionRequest");
    expect(perm.data).toMatchObject({
      kind: "permission",
      tool: "Bash",
      message: "Bash rm -rf node_modules && npm ci",
    });
    const cleared = events.find(
      (e) => e.type === "attention.cleared" && e.data.attention_id === perm.data.attention_id,
    ) as ProtocolEvent;
    expect(Date.parse(cleared.time) - Date.parse(perm.time)).toBeGreaterThanOrEqual(30_000);
    expect(
      events.some(
        (e) => e.type === "attention.needed" && e.harness.name === "gemini-cli" && e.harness.event === "Notification",
      ),
    ).toBe(true);
  });

  it("ends every tool it starts, with the same call_id", () => {
    const open = new Map<string, ProtocolEvent>();
    const idOf = (e: ProtocolEvent) => `${key(e)}|${(e.data.call_id as string | undefined) ?? e.data.tool}`;
    for (const e of events) {
      if (e.harness.name === "antigravity") continue; // no pre-tool hook: tool.ended alone (below)
      if (e.type === "tool.started") {
        expect(open.has(idOf(e)), `two tool.started for ${idOf(e)}`).toBe(false);
        open.set(idOf(e), e);
      }
      if (e.type === "tool.ended") {
        const started = open.get(idOf(e));
        expect(started, `tool.ended without its tool.started: ${idOf(e)}`).toBeDefined();
        expect(e.data.turn_id).toBe(started?.data.turn_id);
        open.delete(idOf(e));
      }
    }
    expect([...open.values()].filter(settled).map((e) => `${e.harness.name} ${e.data.tool}`)).toEqual([]);
  });

  it("runs Claude Code's subagents inside the parent, as recorded, and Cursor's as child sessions", () => {
    const started = events.filter((e) => e.type === "subagent.started");
    expect(started.length).toBeGreaterThan(0);
    const inParent = started.filter((s) => s.harness.name === "claude-code");
    const asChild = started.filter((s) => s.harness.name === "cursor");
    expect(inParent.length).toBeGreaterThan(0);
    expect(asChild.length).toBeGreaterThan(0);
    for (const s of inParent) {
      const agentId = s.data.agent_id as string;
      // No session of its own: its tools ride on the parent's session with its agent_id.
      expect(events.some((e) => e.session.id === agentId)).toBe(false);
      const tools = events.filter((e) => e.type.startsWith("tool.") && e.data.agent_id === agentId);
      for (const e of tools) {
        expect(e.session.id).toBe(s.session.id);
        expect(e.data.turn_id).toBeDefined();
      }
      const ended = events.find((e) => e.type === "subagent.ended" && e.data.agent_id === agentId);
      if (!ended) continue; // still running when the run stops
      expect(tools.length).toBeGreaterThan(0);
      expect(ended.session.id).toBe(s.session.id);
    }
    for (const s of asChild) {
      const agentId = s.data.agent_id as string;
      const child = events.filter((e) => e.session.id === agentId);
      expect(child.length).toBeGreaterThan(2);
      for (const e of child) {
        expect(e.session.parent_id).toBe(s.session.id);
        if (e.type.startsWith("tool.")) expect(e.data.agent_id).toBe(agentId);
      }
    }
    // Each launch call names its agent: in the output when async (or a child), and the
    // synchronous call's output is the agent's own last message.
    for (const s of started) {
      const agentId = s.data.agent_id as string;
      const call = events.find(
        (e) =>
          e.type === "tool.ended" &&
          (e.data.tool === "Agent" || e.data.tool === "Task") &&
          JSON.stringify(e.data.output).includes(agentId),
      );
      if (!call && !events.some((e) => e.type === "subagent.ended" && e.data.agent_id === agentId)) continue;
      expect(call, `${s.harness.name} ${agentId}`).toBeDefined();
      expect(call?.session.id).toBe(s.session.id);
    }
  });

  it("brings a background agent back with a <task-notification> turn after the launching turn ended", () => {
    const launch = events.find(
      (e) => e.type === "tool.ended" && e.data.tool === "Agent" && (e.data.output as { isAsync?: boolean })?.isAsync,
    ) as ProtocolEvent;
    expect(launch).toBeDefined();
    const agentId = (launch.data.output as { agentId: string }).agentId;
    const mine = events.filter((e) => e.session.id === launch.session.id);
    const at = (pred: (e: ProtocolEvent) => boolean) => mine.findIndex(pred);
    const start = at((e) => e.type === "subagent.started" && e.data.agent_id === agentId);
    const stop = at((e) => e.type === "turn.ended" && e.data.turn_id === launch.data.turn_id);
    const firstTool = at((e) => e.type === "tool.started" && e.data.agent_id === agentId);
    const end = at((e) => e.type === "subagent.ended" && e.data.agent_id === agentId);
    const note = at(
      (e) =>
        e.type === "turn.transcript" &&
        typeof e.data.user === "string" &&
        e.data.user.startsWith("<task-notification>") &&
        e.data.user.includes(`<task-id>${agentId}</task-id>`),
    );
    expect(start).toBeGreaterThan(at((e) => e === launch));
    expect(stop).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(firstTool);
    expect(note).toBeGreaterThan(end);
    expect(mine[note]!.data.user).toMatch(/<result>[^<]+<\/result>/);
    // The agent's tools carry the spawning turn's id, after that turn ended too.
    expect(
      mine
        .filter((e) => e.data.agent_id === agentId && e.type === "tool.ended")
        .every((e) => e.data.turn_id === launch.data.turn_id),
    ).toBe(true);
  });

  it("covers every scenario in the first minutes", () => {
    const types = new Set(events.map((e) => e.type));
    for (const t of [
      "session.backfill",
      "session.started",
      "session.ended",
      "turn.started",
      "turn.progress",
      "turn.transcript",
      "turn.ended",
      "tool.started",
      "tool.ended",
      "files.changed",
      "attention.needed",
      "attention.cleared",
      "subagent.started",
      "subagent.ended",
      "context.compacted",
    ])
      expect(types, t).toContain(t);

    const hookNames = (h: string) => new Set(events.filter((e) => e.harness.name === h).map((e) => e.harness.event));
    for (const n of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PermissionRequest",
      "SubagentStart",
      "SubagentStop",
      "PreCompact",
      "Stop",
      "StopFailure",
      "SessionEnd",
    ])
      expect(hookNames("claude-code"), n).toContain(n);
    for (const n of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"])
      expect(hookNames("codex"), n).toContain(n);
    for (const n of [
      "SessionStart",
      "BeforeAgent",
      "BeforeTool",
      "AfterTool",
      "Notification",
      "AfterAgent",
      "SessionEnd",
    ])
      expect(hookNames("gemini-cli"), n).toContain(n);

    const tools = new Set(events.filter((e) => e.type === "tool.ended").map((e) => e.data.tool));
    for (const t of [
      "Read",
      "Grep",
      "Edit",
      "Write",
      "Bash",
      "WebSearch",
      "Agent",
      "mcp__github__search_issues",
      "read_file",
      "run_shell_command",
    ])
      expect(tools, t).toContain(t);
    expect(events.some((e) => e.type === "tool.ended" && e.data.ok === false && typeof e.data.error === "string")).toBe(
      true,
    );
    expect(events.some((e) => e.type === "tool.ended" && JSON.stringify(e.data.output)?.includes("[redacted]"))).toBe(
      true,
    );
    expect(
      events.some((e) => e.type === "turn.ended" && e.data.reason === "error" && e.data.error === "api_overloaded"),
    ).toBe(true);
    expect(
      events
        .filter((e) => e.type === "turn.ended" && e.data.reason === "stop" && e.harness.name !== "antigravity")
        .every((e) => Number.isInteger(e.data.ms)),
    ).toBe(true);
    expect(events.some((e) => e.type === "context.compacted" && e.data.trigger === "auto")).toBe(true);
    expect(events.some((e) => e.type === "session.ended" && e.data.reason === "exit")).toBe(true);

    expect(new Set(events.map((e) => e.session.machine))).toEqual(new Set(["studio-mac", "build-box", "lab-mac"]));
    const models = new Set(events.map((e) => e.session.model).filter(Boolean));
    for (const m of ["claude-fable-5-1", "claude-opus-5-5", "gpt-5.4-codex", "gemini-3-pro"])
      expect(models, m).toContain(m);
    // Cursor's is the rng's pick of its two.
    expect(events.some((e) => e.harness.name === "cursor" && MODELS.cursor.includes(String(e.session.model)))).toBe(
      true,
    );
    expect(new Set(events.map((e) => e.harness.name))).toEqual(
      new Set(["claude-code", "codex", "gemini-cli", "antigravity", "cursor"]),
    );
    expect(events.every((e) => !e.session.cwd || e.session.cwd.startsWith("~"))).toBe(true);
  });

  it("backfills ~15 sessions over the last 30 days, once, dated with turns", () => {
    const backfill = events.filter((e) => e.type === "session.backfill");
    expect(backfill.length).toBe(15);
    expect(new Set(backfill.map((e) => e.session.id)).size).toBe(15);
    for (const e of backfill) {
      expect(e.session.seq).toBe(0);
      expect(e.harness.event).toBe("backfill");
      expect(e.harness.version).toBeUndefined();
      expect(e.session.title).toBeTruthy();
      expect(Number.isInteger(e.data.turns)).toBe(true);
      const started = Date.parse(e.data.started_at as string);
      const last = Date.parse(e.data.last_at as string);
      expect(started).toBeGreaterThan(T0 - 31 * 86_400_000);
      expect(last).toBeGreaterThan(started);
      expect(Date.parse(e.time)).toBe(last);
    }
    expect(new Set(backfill.map((e) => e.harness.name))).toEqual(
      new Set(["claude-code", "codex", "gemini-cli", "antigravity"]),
    );
    // One of them comes back to life as a resumed session with its seq continuing from 1.
    const resumed = events.find((e) => e.type === "session.started" && e.data.source === "resume") as ProtocolEvent;
    expect(backfill.some((b) => b.session.id === resumed.session.id)).toBe(true);
    expect(resumed.session.seq).toBe(1);
  });

  it("sends turn.progress with the prompt first, then growing assistant text, then the transcript", () => {
    const bySession = new Map<string, ProtocolEvent[]>();
    for (const e of events)
      if (e.type === "turn.progress" || e.type === "turn.transcript")
        bySession.set(key(e), [...(bySession.get(key(e)) ?? []), e]);
    let grew = 0;
    for (const list of bySession.values()) {
      let last: ProtocolEvent | undefined;
      for (const e of list) {
        if (e.type === "turn.progress") {
          if (last?.type === "turn.progress" && last.data.turn === e.data.turn) {
            expect((e.data.assistant as string).length).toBeGreaterThan((last.data.assistant as string).length);
            expect(Date.parse(e.time) - Date.parse(last.time)).toBeGreaterThanOrEqual(20_000);
            grew++;
          } else expect(e.data.assistant).toBe("");
        } else if (last?.type === "turn.progress") expect(e.data.turn).toBe(last.data.turn);
        last = e;
      }
    }
    expect(grew).toBeGreaterThan(0);
  });

  it("leaves one session silent mid-turn", () => {
    const first = events.find(
      (e) => e.type === "session.started" && e.harness.name === "claude-code" && e.session.cwd === "~/code/mobile",
    ) as ProtocolEvent;
    const offline = events.filter((e) => e.session.id === first.session.id);
    expect(offline.some((e) => e.type === "turn.started")).toBe(true);
    expect(offline.some((e) => e.type === "turn.ended" || e.type === "session.ended")).toBe(false);
    expect(Date.parse(offline[offline.length - 1]!.time)).toBeLessThan(T0 + 3 * 60_000);
  });

  it("is the same demo for the same seed, and another for another", () => {
    const strip = (list: ProtocolEvent[]) => list.map(({ id: _id, ...rest }) => rest);
    expect(strip(run(SEED))).toEqual(strip(events));
    expect(strip(run(8))).not.toEqual(strip(events));
  });

  it("puts everything on one machine when asked for one", () => {
    expect(new Set(run(SEED, 3, 1).map((e) => e.session.machine))).toEqual(new Set(["studio-mac"]));
  });

  it("keeps cycling for an hour without running dry or piling up", () => {
    const sim = new Simulation({ seed: 3, startAt: T0, speed: 1 });
    let n = 0;
    for (let m = 1; m <= 60; m++) {
      const slice = sim.advance(m * 60_000);
      expect(slice.flatMap((e) => validate(e))).toEqual([]);
      n += slice.length;
      // The showcase's cycle: the showcase, three reviewers, sessionpipe 0.10's scenes, and
      // the two sessions that ask Codex, each with the Codex session it asked.
      expect(sim.live).toBeLessThanOrEqual(13);
    }
    expect(n).toBeGreaterThan(1500);
  });
});

describe("Antigravity and Cursor, as ADAPTERS.md maps them", () => {
  const events = run(SEED, 12);
  const of = (harness: string) => events.filter((e) => e.harness.name === harness && e.type !== "session.backfill");
  const sessionsOf = (harness: string) => {
    const by = new Map<string, ProtocolEvent[]>();
    for (const e of of(harness)) by.set(e.session.id, [...(by.get(e.session.id) ?? []), e]);
    return [...by.values()];
  };
  const hookNames = (harness: string) => new Set(of(harness).map((e) => e.harness.event));

  it("Antigravity: PreInvocation 0 is the session and the turn; later hooks are heartbeats or tool.ended", () => {
    const ag = of("antigravity");
    expect(ag.length).toBeGreaterThan(20);
    expect(hookNames("antigravity")).toEqual(new Set(["PreInvocation", "PostToolUse", "Stop"]));
    for (const e of ag) expect(e.harness.version).toBe("1.21.9");
    // Every turn.started follows a session.started { source: unknown } from the same hook.
    for (const list of sessionsOf("antigravity"))
      for (const [i, e] of list.entries()) {
        if (e.type !== "turn.started") continue;
        const prev = list[i - 1] as ProtocolEvent;
        expect(prev.type).toBe("session.started");
        expect(prev.data).toEqual({ source: "unknown" });
        expect(prev.harness.event).toBe("PreInvocation");
        expect(e.data).toEqual({});
        expect(prev.session.model).toMatch(/^gemini-/);
        expect(prev.session.title_source).toBe("first-ask");
      }
    const beats = ag.filter((e) => e.type === "session.heartbeat");
    expect(new Set(beats.map((e) => e.harness.event))).toEqual(new Set(["PreInvocation", "PostToolUse"]));
    for (const b of beats) expect(b.data).toEqual({});
    const tools = ag.filter((e) => e.type === "tool.ended");
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.harness.event).toBe("PostToolUse");
      expect(Object.keys(t.data).sort()).toEqual(
        t.data.ok ? ["input", "ok", "tool"] : ["error", "input", "ok", "tool"],
      );
    }
    expect(new Set(tools.map((e) => e.data.tool))).toContain("edit_file");
    for (const type of ["tool.started", "attention.needed", "attention.cleared", "files.changed", "session.ended"])
      expect(
        ag.some((e) => e.type === type),
        type,
      ).toBe(false);
    const stops = ag.filter((e) => e.type === "turn.ended");
    expect(stops.length).toBeGreaterThan(0);
    for (const s of stops) {
      expect(s.harness.event).toBe("Stop");
      expect(s.data).toEqual({ reason: "stop" });
    }
    expect(ag.filter((e) => e.type === "turn.transcript").length).toBe(stops.length);
  });

  it("Antigravity: a finished session ends on a Stop and its transcript, then nothing", () => {
    const opening = sessionsOf("antigravity")[0] as ProtocolEvent[];
    expect(opening[0]?.session.cwd).toBe("~/code/design-system");
    const types = opening.map((e) => e.type);
    expect(types.slice(-2)).toEqual(["turn.ended", "turn.transcript"]);
    expect(types.filter((t) => t === "turn.started").length).toBe(2);
    // and it is over well before the run ends, with no session.ended ever
    expect(Date.parse(opening[opening.length - 1]!.time)).toBeLessThan(T0 + 8 * 60_000);
    expect(types).not.toContain("session.ended");
  });

  it("Cursor: its own hook names, generation ids, files.changed from afterFileEdit, no attention", () => {
    const cu = of("cursor");
    expect(cu.length).toBeGreaterThan(20);
    for (const n of [
      "sessionStart",
      "beforeSubmitPrompt",
      "preToolUse",
      "postToolUse",
      "postToolUseFailure",
      "afterFileEdit",
      "subagentStart",
      "subagentStop",
      "stop",
      "sessionEnd",
    ])
      expect(hookNames("cursor"), n).toContain(n);
    for (const e of cu) expect(e.harness.version).toBe("3.7.36");
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const starts = cu.filter((e) => e.type === "session.started" && e.data.source === "startup");
    expect(starts.length).toBeGreaterThan(0);
    for (const s of starts) {
      expect(s.session.id).toMatch(uuid);
      expect(s.harness.event).toBe("sessionStart");
      expect(["claude-fable-5-1", "gpt-5.5"]).toContain(s.session.model);
    }
    for (const t of cu.filter((e) => e.type === "turn.started")) {
      expect(t.data.turn_id).toMatch(uuid);
      expect(Number.isInteger(t.data.prompt_chars)).toBe(true);
    }
    const changed = cu.filter((e) => e.type === "files.changed");
    expect(changed.length).toBeGreaterThan(0);
    for (const c of changed) {
      expect(c.harness.event).toBe("afterFileEdit");
      expect(Array.isArray(c.data.paths) && c.data.paths.length > 0).toBe(true);
    }
    const tools = new Set(cu.filter((e) => e.type === "tool.ended").map((e) => e.data.tool));
    for (const t of ["Shell", "Read", "Edit", "Grep", "Glob", "Write", "Task"]) expect(tools, t).toContain(t);
    const failed = cu.find((e) => e.type === "tool.ended" && e.data.ok === false) as ProtocolEvent;
    expect(failed.harness.event).toBe("postToolUseFailure");
    expect(cu.some((e) => e.type.startsWith("attention."))).toBe(false);
    for (const s of cu.filter((e) => e.type === "turn.ended")) expect(s.harness.event).toBe("stop");
    expect(cu.some((e) => e.type === "session.ended" && e.harness.event === "sessionEnd")).toBe(true);
  });

  it("reads through the store as the spec means: Antigravity done only by silence, Cursor's files counted", () => {
    const ingest = (list: ProtocolEvent[], now: number) => {
      const first = list[0] as ProtocolEvent;
      const rec = newRecord(first.harness.name, first.session.id, first.time, "demo");
      for (const e of list) applyEvent(rec, e, e.time, "demo");
      refreshState(rec, now);
      return rec;
    };
    const ag = sessionsOf("antigravity")[0] as ProtocolEvent[];
    const lastAg = Date.parse(ag[ag.length - 1]!.time);
    // Mid-turn (after the first heartbeat, before the Stop): working, no current tool.
    const beat = ag.findIndex((e) => e.type === "session.heartbeat");
    const mid = ingest(ag.slice(0, beat + 1), Date.parse(ag[beat]!.time) + 1000);
    expect(mid.summary.state).toBe("working");
    expect(mid.summary.currentTurn).toBeDefined();
    expect(mid.summary.currentTool).toBeUndefined();
    // After the last Stop: idle (the turn's ms came from the clock), not done …
    const after = ingest(ag, lastAg + 60_000);
    expect(after.ended).toBe(false);
    expect(after.summary.state).toBe("idle");
    expect(after.summary.counts.turns).toBe(2);
    expect(after.summary.turnStats.count).toBe(2);
    expect(after.summary.turnStats.lastMs).toBeGreaterThan(0);
    expect(after.summary.counts.filesChanged).toBeGreaterThan(0); // edit_file's file_path, via paths.ts
    expect(after.summary.title).toBe("The Button's focus ring disappears on the dark…");
    expect(after.summary.titleSource).toBe("first-ask");
    expect(after.summary.model).toMatch(/^gemini-/);
    // … until it has been silent for a day: the receiver's own reading, flagged as such.
    const later = ingest(ag, lastAg + DONE_AFTER_MS + 1);
    expect(later.summary.state).toBe("done");
    expect(later.ended).toBe(false);
    expect(later.summary.endedAt).toBeUndefined();

    const cu = sessionsOf("cursor")[0] as ProtocolEvent[];
    const rec = ingest(cu, Date.parse(cu[cu.length - 1]!.time) + 1000);
    expect(rec.ended).toBe(true);
    expect(rec.summary.state).toBe("done");
    expect(rec.summary.counts.filesChanged).toBe(3);
    expect([...rec.files].sort()).toEqual([
      "src/jobs/digest.ts",
      "templates/invoice-ready.txt",
      "templates/password-reset.txt",
    ]);
    expect(rec.summary.counts.subagents).toBe(1);
    expect(rec.summary.counts.toolErrors).toBe(1);
    expect(rec.summary.openAttentions).toEqual([]);
  });
});

describe("startDemo on the wall clock", () => {
  it("ingests valid events as demo in batches of at most 50, and stops", async () => {
    const store = new FakeStore();
    const runner = startDemo(asStore(store), { speed: 1000, seed: 11 });
    await new Promise((r) => setTimeout(r, 700));
    runner.stop();
    const after = store.batches.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(store.batches.length).toBe(after);

    expect(store.batches.length).toBeGreaterThan(1);
    for (const b of store.batches) {
      expect(b.source).toBe("demo");
      expect(b.events.length).toBeGreaterThan(0);
      expect(b.events.length).toBeLessThanOrEqual(50);
    }
    const events = store.events;
    expect(events.length).toBeGreaterThan(200);
    expect(events.flatMap((e) => validate(e))).toEqual([]);
    const types = new Set(events.map((e) => e.type));
    for (const t of [
      "session.backfill",
      "session.started",
      "tool.ended",
      "turn.transcript",
      "attention.cleared",
      "subagent.ended",
    ])
      expect(types, t).toContain(t);
    // Event times are the wall clock, not the virtual one.
    const live = events.filter((e) => e.type !== "session.backfill");
    const span = Date.parse(live[live.length - 1]!.time) - Date.parse(live[0]!.time);
    expect(span).toBeLessThan(2000);
  });
});

describe("sessionpipe 0.10 scenes", () => {
  const started: DemoStarted[] = [];
  const sim = new Simulation({ seed: SEED, startAt: T0, speed: 1, onStart: (s) => started.push(s) });
  const events = sim.advance(TEN_MINUTES);
  const read = (k: string, now: number) => {
    const list = events.filter((e) => key(e) === k && Date.parse(e.time) <= now);
    const rec = newRecord(list[0]!.harness.name, list[0]!.session.id, list[0]!.time, "demo");
    for (const e of list) applyEvent(rec, e, e.time, "demo");
    refreshState(rec, now);
    return rec.summary;
  };

  it("leaves work in the background, and the session reads working until it wakes", () => {
    const stop = events.find((e) => e.type === "turn.ended" && e.data.background === 2)!;
    expect(stop.harness.event).toBe("Stop");
    const waiting = read(key(stop), Date.parse(stop.time) + 60_000);
    expect(waiting.state).toBe("working");
    expect(waiting.background).toEqual({ tasks: 2, since: stop.time });
    // It wakes on its own <task-notification> turn, a block the harness wrote.
    const wake = events.find((e) => key(e) === key(stop) && e.type === "turn.started" && e.data.injected === true)!;
    expect(Date.parse(wake.time) - Date.parse(stop.time)).toBeGreaterThan(200_000);
    const woken = read(key(stop), Date.parse(wake.time));
    expect(woken.background).toBeUndefined();
    expect(woken.currentTurn?.injected).toBe(true);
    // The injected prompt never becomes the row's last ask.
    expect(woken.lastUser).toMatch(/^Run the integration suite/);
  });

  it("says who submitted a turn, and a run nobody attended on another API's account", () => {
    const sched = events.find((e) => e.type === "turn.started" && e.data.submitted_by === "schedule_wakeup")!;
    expect(read(key(sched), Date.parse(sched.time)).currentTurn?.submittedBy).toBe("schedule_wakeup");
    const probe = events.filter((e) => e.session.attended === false);
    expect(probe.length).toBeGreaterThan(0);
    expect(new Set(probe.map((e) => e.session.account_id))).toEqual(new Set([DEMO_API_ACCOUNT]));
    const end = probe.find((e) => e.type === "session.ended")!;
    const s = read(key(end), Date.parse(end.time));
    expect(s.attended).toBe(false);
    expect(Date.parse(s.lastAt) - Date.parse(s.startedAt)).toBeLessThan(60_000);
    // Elsewhere the harness says nothing: unknown, never false.
    expect(events.some((e) => e.session.attended === undefined)).toBe(true);
  });

  it("tells the demo machine which sessions it started, with their first message", () => {
    expect(started.length).toBeGreaterThan(0);
    const s = started[0]!;
    expect(s.machine).toBe("lab-mac");
    expect(events.some((e) => e.session.id === s.id && e.type === "session.started")).toBe(true);
    expect(s.text).toMatch(/^Run the integration suite/);
  });

  it("asks Codex from inside a Claude Code turn: the events, the child's delegated_by, the answer", () => {
    const begun = events.find((e) => e.type === "delegation.started" && e.data.via === "ask")!;
    expect(begun.harness.name).toBe("claude-code");
    expect(begun.harness.event).toBeUndefined();
    expect(begun.data).toMatchObject({ harness: "codex", text: expect.stringMatching(/^Review the diff/) });
    expect(begun.data.to).toBeUndefined();
    const ended = events.find((e) => e.type === "delegation.ended" && e.data.ask_id === begun.data.ask_id)!;
    expect(ended.data).toMatchObject({ ok: true, to: expect.stringMatching(/^codex:/), reply: expect.any(String) });
    expect(ended.data.relayed).toBeUndefined();
    // The ask ran inside a Bash call that stayed open for as long as the child did.
    const call = events.find(
      (e) => e.type === "tool.ended" && key(e) === key(begun) && Date.parse(e.time) >= Date.parse(ended.time),
    )!;
    expect((call.data.input as { command: string }).command).toMatch(/^sessionpipe ask codex /);
    expect((call.data.output as { stdout: string }).stdout).toBe(ended.data.reply);
    expect(call.data.ms).toBe(ended.data.ms);
    // The child: Codex, on the same machine and in the same folder, delegated_by the asker.
    const child = events.filter((e) => key(e) === ended.data.to);
    expect(child.length).toBeGreaterThan(3);
    expect(child[0]!.type).toBe("session.started");
    for (const e of child) expect(e.session.delegated_by).toBe(key(begun));
    expect(child[0]!.session.machine).toBe(begun.session.machine);
    expect(child[0]!.session.cwd).toBe(begun.session.cwd);
    const first = child.find((e) => e.type === "turn.transcript")!;
    expect(first.data.user).toMatch(/\n\n\(Asked by claude-code:[^ ]+ on this machine with sessionpipe ask\./);
    expect(first.data.assistant).toBe(ended.data.reply);
    // Through the store: open, the ask keeps the asker working; closed, it carries the answer.
    const mid = read(key(begun), Date.parse(begun.time) + 1000);
    expect(mid.counts.delegationsRunning).toBe(1);
    expect(mid.delegations![0]).toMatchObject({ via: "ask", harness: "codex" });
    const after = read(key(begun), Date.parse(ended.time) + 1000);
    expect(after.counts.delegationsRunning).toBe(0);
    expect(after.delegations![0]).toMatchObject({ to: ended.data.to, ok: true, reply: ended.data.reply });
    expect(read(ended.data.to as string, Date.parse(ended.time)).delegatedBy).toBe(key(begun));
  });

  it("brings a handoff's answer back as a framed prompt, and says it was relayed", () => {
    const begun = events.find((e) => e.type === "delegation.started" && e.data.via === "handoff")!;
    expect(begun.data).toMatchObject({ harness: "codex", to: expect.stringMatching(/^codex:/) });
    const ended = events.find((e) => e.type === "delegation.ended" && e.data.ask_id === begun.data.ask_id)!;
    expect(ended.data).toMatchObject({ ok: true, to: begun.data.to, relayed: "delivered" });
    // The daemon started the child for us: the demo machine has its start.
    expect(started.some((s) => `${s.harness}:${s.id}` === begun.data.to)).toBe(true);
    const child = events.filter((e) => key(e) === begun.data.to);
    for (const e of child) expect(e.session.delegated_by).toBe(key(begun));
    expect(child.find((e) => e.type === "turn.transcript")!.data.user).toMatch(/with sessionpipe control/);
    // Then the answer lands in the asking session as a prompt of its own, and it answers.
    const relay = events.find(
      (e) => key(e) === key(begun) && e.type === "turn.transcript" && Date.parse(e.time) > Date.parse(ended.time),
    )!;
    expect(relay.data.user).toMatch(/^Answer from codex:[0-9a-f]{8} \(sessionpipe handoff, asked via [^)]+\):\n\n/);
    expect(String(relay.data.user).endsWith(String(ended.data.reply))).toBe(true);
    expect(relay.data.assistant).toMatch(/^Codex is right/);
    const after = read(key(begun), Date.parse(relay.time) + 1000);
    expect(after.delegations!.find((d) => d.askId === begun.data.ask_id)).toMatchObject({
      via: "handoff",
      relayed: "delivered",
    });
  });
});

describe("usage limits", () => {
  // As the runner does: the paired machine's hello names lab-mac's account first.
  const sim = new Simulation({ seed: SEED, startAt: T0, speed: 1 });
  const lab = sim.account(sim.v010Machine, "claude-code");
  const events = sim.advance(TEN_MINUTES);
  const reports = events.filter((e) => e.type === "limits.observed");
  const ago = (e: ProtocolEvent) => T0 - Date.parse(e.time);
  const windows = (e: ProtocolEvent) =>
    (e.data.windows as { id: string; used_percent: number; resets_at?: string; window_minutes?: number }[]).map(
      (w) =>
        `${w.id} ${w.used_percent}${w.window_minutes ? ` /${w.window_minutes}` : ""}${w.resets_at ? ` ${(Date.parse(w.resets_at) - T0) / 60_000}m` : ""}`,
    );
  const first = (harness: string, machine: string, account?: string) =>
    reports.find(
      (e) => e.harness.name === harness && e.session.machine === machine && e.session.account_id === account,
    )!;

  it("leaves every account's last report at once, in an earlier session of its harness and machine", () => {
    const studio = first("claude-code", "studio-mac", sim.account("studio-mac", "claude-code"));
    expect(ago(studio)).toBe(3 * 3_600_000);
    expect(windows(studio)).toEqual(["five_hour 100 /300 70m", "seven_day 42 /10080 7260m"]);
    const api = first("claude-code", "lab-mac", DEMO_API_ACCOUNT);
    expect(ago(api)).toBe(60_000);
    expect(windows(api)).toEqual(["spend_limit 112 17280m"]);
    const codexLab = first("codex", "lab-mac");
    expect(ago(codexLab)).toBe(2 * 60_000);
    expect(windows(codexLab)).toEqual(["primary 8 /300 223m", "secondary 26 /10080 5880m"]);
    expect(codexLab.data.plan).toBe("plus");
    const codexBuild = first("codex", "build-box");
    expect(ago(codexBuild)).toBe(2 * 3_600_000);
    expect(windows(codexBuild)).toEqual(["primary 64 /300 -40m", "secondary 91 /10080 1680m"]);
    expect(codexBuild.data.plan).toBe("pro");
    const dev = first("claude-code", "lab-mac", lab);
    expect(ago(dev)).toBe(60_000);
    expect(windows(dev)).toEqual(["five_hour 38 /300 141m", "seven_day 20 /10080 3960m", "seven_day_fable 29 3960m"]);
    // Each arrives in the demo's first tick, from Claude Code's status line or Codex's Stop.
    for (const r of [studio, api, codexLab, codexBuild, dev]) {
      expect(events.indexOf(r)).toBeLessThan(events.findIndex((e) => Date.parse(e.time) > T0 + 1000));
      expect(r.harness.event).toBe(r.harness.name === "codex" ? "Stop" : "StatusLine");
      const session = events.filter((e) => key(e) === key(r));
      expect(session.map((e) => e.type)).toEqual([
        "session.started",
        "turn.started",
        "turn.ended",
        "turn.transcript",
        "limits.observed",
        "session.ended",
      ]);
    }
    // Codex sends no account id: its numbers are the machine's.
    expect(reports.filter((e) => e.harness.name === "codex").every((e) => e.session.account_id === undefined)).toBe(
      true,
    );
    expect(reports.flatMap((e) => validate(e))).toEqual([]);
  });

  it("moves lab-mac's 5-hour window on as its replies come, a point or two at a time", () => {
    const later = reports.filter((e) => e.session.account_id === lab && Date.parse(e.time) > T0);
    expect(later.length).toBeGreaterThan(0);
    let used = 38;
    for (const r of later) {
      const [five, ...rest] = windows(r);
      const now = Number(five!.split(" ")[1]);
      expect(now - used === 1 || now - used === 2, `${used} → ${now}`).toBe(true);
      used = now;
      expect(rest).toEqual(["seven_day 20 /10080 3960m", "seven_day_fable 29 3960m"]);
      expect(r.session.machine).toBe("lab-mac");
    }
  });
});

describe("the pool at work", () => {
  const events = run(SEED, 12);
  const scene = events.filter(
    (e) => e.session.account_id === DEMO_POOL.spacesheep.id && e.session.machine === "lab-mac",
  );
  it("plays a session on Spacesheep's login that the pool moves to Misha's after its first turn", () => {
    expect(scene.length).toBeGreaterThan(0);
    const reports = scene.filter((e) => e.type === "limits.observed");
    expect(reports[0]?.data).toMatchObject({ account_id: DEMO_POOL.spacesheep.id });
    expect((reports[0]!.data.windows as { id: string; used_percent: number; resets_at: string }[])[0]).toMatchObject({
      id: "five_hour",
      used_percent: 99.2,
      resets_at: new Date(T0 + DEMO_POOL_UNTIL_MS).toISOString(),
    });
    const own = events.find(
      (e) =>
        e.session.machine === "lab-mac" &&
        e.harness.name === "claude-code" &&
        e.session.account_id !== DEMO_POOL.spacesheep.id &&
        e.session.account_id !== DEMO_API_ACCOUNT,
    )?.session.account_id;
    expect(own).toBeTruthy();
    expect(reports.slice(1).every((e) => e.data.account_id === own)).toBe(true);
    expect(reports.length).toBeGreaterThanOrEqual(3);
    // The first report comes after the first turn; no earlier one names the pool.
    const firstTurnEnd = scene.findIndex((e) => e.type === "turn.ended");
    expect(scene.indexOf(reports[0]!)).toBeGreaterThan(firstTurnEnd);
    expect(scene.some((e) => e.type === "session.ended")).toBe(false);
    for (const e of scene) expect(validate(e)).toEqual([]);
  });
  it("leaves the cast as it was: the same machines, and no other session on that login", () => {
    expect(new Set(events.map((e) => e.session.machine))).toEqual(new Set(["studio-mac", "build-box", "lab-mac"]));
    expect(new Set(scene.map((e) => e.session.id)).size).toBe(1);
  });
});

describe("demo machines", () => {
  it("pairs the 0.10 scenes' machine in inherit mode, and takes it away on stop", () => {
    const calls: string[] = [];
    const hellos: Hello[] = [];
    const runs: DemoStart[] = [];
    const control = {
      demo: {
        machine: (id: string, h: Hello) => {
          calls.push(`machine ${id}`);
          hellos.push(h);
        },
        poll: () => {},
        start: (_id: string, r: DemoStart) => runs.push(r),
        remove: () => {
          calls.push("remove");
          return 2;
        },
      },
    } as unknown as Control;
    const m = startDemoMachines(control, "lab-mac", () => "acct", T0);
    expect(calls).toEqual([
      `machine ${demoMachineId("lab-mac")}`,
      `machine ${demoMachineId("mini-mac")}`,
      `machine ${demoMachineId("desk-pc")}`,
    ]);
    const [newer, mini, desk] = hellos;
    expect(newer).toMatchObject({ mode: "inherit", version: "0.11.0" });
    // The pool (DESIGN §3, UX-SPEC §13): on with Misha in use, Fiction with room and no
    // numbers, Spacesheep used up with when it is back and its idle numbers.
    expect(newer!.pool).toMatchObject({
      on: true,
      harness: "claude-code",
      accounts: [
        { id: "acct", label: "Misha", status: "ready", current: true },
        { id: DEMO_POOL.fiction.id, label: "Fiction", status: "ready", current: false },
        {
          id: DEMO_POOL.spacesheep.id,
          status: "limited",
          until: new Date(T0 + DEMO_POOL_UNTIL_MS).toISOString(),
          limitedBy: "five_hour",
        },
      ],
    });
    expect(newer!.pool?.accounts[1]?.windows).toBeUndefined();
    expect(newer!.pool?.accounts[2]?.windows?.[0]).toMatchObject({ id: "five_hour", usedPercent: 99.2 });
    expect(newer!.accounts.map((a) => a.id)).toEqual(
      expect.arrayContaining([DEMO_POOL.fiction.id, DEMO_POOL.spacesheep.id]),
    );
    // An account in error, one in use, one turned off; and a pool that is off.
    expect(mini!.pool?.accounts.map((a) => [a.label, a.status, a.current])).toEqual([
      ["Misha", "error", false],
      ["Work", "ready", true],
      ["Old", "disabled", false],
    ]);
    expect(mini!.pool?.accounts[2]?.enabled).toBe(false);
    expect(desk!.pool).toMatchObject({ on: false, accounts: [{ label: "Misha" }, { label: "Fiction" }] });
    expect(desk!.pool?.accounts.some((a) => a.current)).toBe(false);
    for (const h of hellos)
      expect(parseHello({ ...h, key_types: h.keyTypes, prompt_files: h.promptFiles })?.pool).toBeTruthy();
    expect(newer!.start?.["claude-code"]).toMatchObject({ permissions: ["read", "safe"], permission: "inherit" });
    expect(newer!.harnesses).toContain("goose");
    expect(newer).toMatchObject({ ask: true, handoff: true });
    expect(newer!.accounts).toContainEqual({ harness: "claude-code", id: DEMO_API_ACCOUNT, name: "api.z.ai" });
    // The ACP agent's run: delivered over `api`, its reply in the ack.
    expect(runs[0]).toMatchObject({ session: DEMO_ACP_SESSION, mode: "api" });
    m.started({ harness: "claude-code", id: "s1", machine: "lab-mac", cwd: "~/code/billing", text: "hi", at: T0 });
    m.started({ harness: "claude-code", id: "s2", machine: "studio-mac", cwd: "~/code/billing", text: "hi", at: T0 });
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({
      session: "claude-code:s1",
      cwd: "/Users/demo/code/billing",
      applied: { permission: "inherit" },
    });
    m.stop();
    expect(calls.at(-1)).toBe("remove");
    expect(demoMachineId("lab-mac")).toMatch(MACHINE_RE);
  });
});
