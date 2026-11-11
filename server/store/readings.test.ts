// SPDX-License-Identifier: Apache-2.0
// The reducer alone, out of order. A sender records a hook when it gets to it and a
// receiver takes batches as they come, so a session's events reach applyEvent in other
// orders than the hooks fired in. Whatever the order, the session must read as it does
// when they come in the order they fired. And a clock that runs ahead holds nothing.
import { describe, expect, it } from "vitest";
import type { ProtocolEvent } from "../../shared/api.js";
import { Session } from "../../test/events.js";
import { applyEvent, newRecord, refreshState } from "./readings.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const BASE = NOW - 600_000;

/** What a board shows of a session: its state, the turn it is in, its running agents. */
function read(events: ProtocolEvent[]) {
  const rec = newRecord("claude-code", "s", new Date(NOW).toISOString(), "http");
  for (const ev of events) applyEvent(rec, ev, new Date(NOW).toISOString(), "http");
  refreshState(rec, NOW);
  const s = rec.summary;
  return {
    state: s.state,
    ended: rec.ended,
    agents: s.counts.agentsRunning,
    turn: s.currentTurn?.turnId ?? (s.currentTurn ? "?" : null),
    tool: s.currentTool?.callId ?? null,
  };
}

/** Events of one session; `seq` is the order of the calls (the order they were recorded
 *  in), `ms` when each hook fired. */
function recorder() {
  const s = new Session("s");
  return (type: string, ms: number, data: Record<string, unknown> = {}) =>
    s.ev(type, data, { time: new Date(BASE + ms).toISOString() });
}

describe("events out of order: the cases", () => {
  it("a run's end from before the turn that is open leaves it running, its run's start still on its way", () => {
    const ev = recorder();
    const start = ev("session.started", 0, { source: "startup" });
    const resumed = ev("session.started", 9500, { source: "resume" });
    const prompt = ev("turn.started", 9600, { turn_id: "p2" });
    const end = ev("session.ended", 9400, { reason: "exit" });
    expect(read([start, prompt, end])).toMatchObject({ state: "working", turn: "p2", ended: false });
    expect(read([start, prompt, end, resumed])).toMatchObject({ state: "working", turn: "p2", ended: false });
  });

  it("a turn only implied stands at its newest event: the end of the turn before leaves it running, and it is the turn that event names", () => {
    // A sink sent no turn.started yet (they are on their way): tools of p1, then of p2, then p1's end.
    const ev = recorder();
    const events = [
      ev("session.started", 0),
      ev("tool.ended", 1000, { tool: "Read", call_id: "c1", turn_id: "p1", ok: true }),
      ev("tool.started", 4000, { tool: "Bash", call_id: "c2", turn_id: "p2" }),
      ev("turn.ended", 3000, { turn_id: "p1", reason: "stop" }),
    ];
    expect(read(events)).toMatchObject({ state: "working", turn: "p2", tool: "c2" });
    // p1's own start, later still, is not the turn that is running; p2's is, and p2's end ends it.
    events.push(ev("turn.started", 500, { turn_id: "p1" }), ev("turn.started", 3500, { turn_id: "p2" }));
    expect(read(events)).toMatchObject({ state: "working", turn: "p2" });
    events.push(ev("turn.ended", 6000, { turn_id: "p2", reason: "stop" }));
    expect(read(events)).toMatchObject({ state: "idle", turn: null });
  });

  it("a call whose end was read is not the tool that runs now when its start is recorded after it, and counts once", () => {
    const ev = recorder();
    const input = { file_path: "a.ts" };
    const call = (n: number, at: number) => [
      { ...ev("tool.ended", at + 12, { tool: "Read", call_id: `c${n}`, ok: true, input }), tier: 3 as const },
      { ...ev("tool.started", at, { tool: "Read", call_id: `c${n}`, input }), tier: 3 as const },
    ];
    const events = [
      ev("session.started", 0),
      ev("turn.started", 1000, { turn_id: "p1" }),
      ...call(1, 2000),
      ...call(2, 3000),
    ];
    const rec = newRecord("claude-code", "s", new Date(NOW).toISOString(), "http");
    for (const e of events) applyEvent(rec, e, new Date(NOW).toISOString(), "http");
    expect(rec.summary.currentTool).toBeUndefined();
    // Two calls on the same input are two starts, not four: no loop yet.
    expect(rec.track.starts).toHaveLength(2);
  });
});

describe("a sender whose clock runs ahead", () => {
  it("an end dated far ahead stands at its arrival: the next turn is not held back by it", () => {
    const ev = recorder();
    const at = (ms: number) => new Date(BASE + ms).toISOString();
    const rec = newRecord("claude-code", "s", at(0), "http");
    const arrive = (e: ProtocolEvent, ms: number) => applyEvent(rec, e, at(ms), "http");
    arrive(ev("session.started", 0), 100);
    arrive(ev("turn.started", 1000, { turn_id: "p1" }), 1100);
    // The Stop's `time` is a day ahead of this receiver's clock.
    arrive(ev("turn.ended", 86_400_000, { turn_id: "p1", reason: "stop" }), 9100);
    expect(rec.summary.currentTurn).toBeUndefined();
    // What fired before it arrived is still the ended turn's…
    arrive(ev("tool.ended", 9000, { tool: "Read", call_id: "c1", turn_id: "p1", ok: true }), 9200);
    expect(rec.summary.currentTurn).toBeUndefined();
    // …and the next prompt, timed by an honest clock again, is a turn.
    arrive(ev("turn.started", 20_000, { turn_id: "p2" }), 20_100);
    expect(rec.summary.currentTurn?.turnId).toBe("p2");
    arrive(ev("session.ended", 2 * 86_400_000, { reason: "exit" }), 30_000);
    arrive(ev("session.started", 40_000, { source: "resume" }), 40_100);
    expect(rec.ended).toBe(false);
  });
});

describe("events out of order: any session", () => {
  let seed = 20261110;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = (n: number) => Math.floor(rnd() * n);
  const shuffled = <T>(list: T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = pick(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  /** A session as its hooks fired: one to four turns with tools, progress and agents, some
   *  runs ended and resumed, the last turn sometimes still running. */
  function story(): { type: string; data: Record<string, unknown>; ms: number }[] {
    const out: { type: string; data: Record<string, unknown>; ms: number }[] = [];
    let ms = 1000;
    const fire = (type: string, data: Record<string, unknown> = {}) => {
      ms += 1 + pick(3000);
      out.push({ type, data, ms });
    };
    fire("session.started", { source: "startup" });
    const turns = 1 + pick(4);
    for (let n = 0; n < turns; n++) {
      fire("turn.started", { turn_id: `p${n}` });
      for (let k = pick(4); k > 0; k--) {
        fire("tool.started", { tool: "Bash", call_id: `c${n}_${k}`, turn_id: `p${n}` });
        if (rnd() < 0.3) fire("turn.progress", { turn: n, user: "ask", assistant: "so far" });
        fire("tool.ended", { tool: "Bash", call_id: `c${n}_${k}`, turn_id: `p${n}`, ok: true });
      }
      if (rnd() < 0.3) {
        fire("subagent.started", { agent_id: `a${n}` });
        fire("tool.ended", { tool: "Grep", call_id: `g${n}`, agent_id: `a${n}`, ok: true });
        fire("subagent.ended", { agent_id: `a${n}` });
      }
      const last = n === turns - 1;
      if (!last || rnd() < 0.6) fire("turn.ended", { turn_id: `p${n}`, reason: "stop" });
      if (!last && rnd() < 0.2) {
        fire("session.ended", { reason: "exit" });
        fire("session.started", { source: "resume" });
      }
    }
    if (rnd() < 0.2) fire("session.ended", { reason: "exit" });
    return out;
  }

  it("reads the same whatever order its events are recorded and delivered in", () => {
    const ROUNDS = 400;
    const differs = { recorded: 0, batches: 0, shuffled: 0, turn: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      // Recorded mostly as fired; a hook is now and then recorded after the next one.
      const order = story();
      for (let i = 0; i + 1 < order.length; i++)
        if (rnd() < 0.25) [order[i], order[i + 1]] = [order[i + 1]!, order[i]!];
      const ev = recorder();
      const recorded = order.map((e) => ev(e.type, e.ms, e.data));
      const fired = [...recorded].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      const want = read(fired);
      const same = (got: ReturnType<typeof read>) =>
        got.state === want.state && got.ended === want.ended && got.agents === want.agents;
      // As recorded (the order a sink sends them in).
      const a = read(recorded);
      if (!same(a)) differs.recorded++;
      // In batches of one to six, a batch now and then delivered after the next.
      const batches: ProtocolEvent[][] = [];
      for (let i = 0; i < recorded.length; ) {
        const n = 1 + pick(6);
        batches.push(recorded.slice(i, i + n));
        i += n;
      }
      for (let i = 0; i + 1 < batches.length; i++)
        if (rnd() < 0.3) [batches[i], batches[i + 1]] = [batches[i + 1]!, batches[i]!];
      const b = read(batches.flat());
      if (!same(b)) differs.batches++;
      if (a.turn !== want.turn || b.turn !== want.turn) differs.turn++;
      // In any order at all.
      if (!same(read(shuffled(recorded)))) differs.shuffled++;
    }
    expect(differs).toEqual({ recorded: 0, batches: 0, shuffled: 0, turn: 0 });
  });
});
