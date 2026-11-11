// SPDX-License-Identifier: Apache-2.0
// The reducer alone, where what it reads is not in the order it happened. A sender
// records a hook when it gets to it and a receiver takes batches as they come, so a
// session's events reach applyEvent in other orders than the hooks fired in; and the
// sender's clock is not the receiver's: it runs ahead, or steps back. Whatever the order
// and whatever the clock, the session must read as it does when its events come in the
// order they fired under a true clock.
import { describe, expect, it } from "vitest";
import type { ProtocolEvent } from "../../shared/api.js";
import { Session } from "../../test/events.js";
import { applyEvent, LATE_MS, newRecord, refreshState, type SessionRecord } from "./readings.js";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const BASE = NOW - 600_000;
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

/** What a board shows of a session: its state, the turn it is in, its running agents. */
function reading(rec: SessionRecord, now: number) {
  refreshState(rec, now);
  const s = rec.summary;
  return {
    state: s.state,
    ended: rec.ended,
    agents: s.counts.agentsRunning,
    turn: s.currentTurn?.turnId ?? (s.currentTurn ? "?" : null),
    tool: s.currentTool?.callId ?? null,
  };
}
function read(events: ProtocolEvent[]) {
  const rec = newRecord("claude-code", "s", new Date(NOW).toISOString(), "http");
  for (const ev of events) applyEvent(rec, ev, new Date(NOW).toISOString(), "http");
  return reading(rec, NOW);
}

/** Events of one session; `seq` is the order of the calls (the order they were recorded
 *  in), `ms` when each hook fired. */
function recorder() {
  const s = new Session("s");
  return (type: string, ms: number, data: Record<string, unknown> = {}) =>
    s.ev(type, data, { time: new Date(BASE + ms).toISOString() });
}

/** One session read as it arrives: `ms` is when the hook fired by the sender's clock,
 *  `at` when it reached the receiver by its own (50 ms after `ms` unless given), `seq` the
 *  order of the calls unless given. */
function live() {
  const s = new Session("s");
  const iso = (ms: number) => new Date(BASE + ms).toISOString();
  const rec = newRecord("claude-code", "s", iso(0), "http");
  let last = 0;
  const api = {
    rec,
    ev(
      type: string,
      ms: number,
      data: Record<string, unknown> = {},
      o: { at?: number; seq?: number; time?: string } = {},
    ) {
      const at = o.at ?? ms + 50;
      last = Math.max(last, at);
      const e = s.ev(type, data, { time: o.time ?? iso(ms), ...(o.seq === undefined ? {} : { seq: o.seq }) });
      applyEvent(rec, e, iso(at), "http");
      return api;
    },
    /** The reading `after` ms past the last arrival. */
    read: (after = 500) => reading(rec, BASE + last + after),
  };
  return api;
}

describe("events out of order: the cases", () => {
  it("the end of the run before, recorded after the next run's start, leaves the session and its turn running", () => {
    // A run ends once: the session had not ended when the resume was read, so the one end
    // from before that resume is the run before's.
    const ev = recorder();
    const start = ev("session.started", 0, { source: "startup" });
    const resumed = ev("session.started", 9500, { source: "resume" });
    const prompt = ev("turn.started", 9600, { turn_id: "p2" });
    const end = ev("session.ended", 9400, { reason: "exit" });
    expect(read([start, resumed, prompt, end])).toMatchObject({ state: "working", turn: "p2", ended: false });
    expect(read([start, resumed, end, prompt])).toMatchObject({ state: "working", turn: "p2", ended: false });
    // That run's own end, when it comes, ends the session.
    const stop = ev("turn.ended", 20_000, { turn_id: "p2", reason: "stop" });
    const exit = ev("session.ended", 20_010, { reason: "exit" });
    expect(read([start, resumed, prompt, end, stop, exit])).toMatchObject({ state: "done", ended: true });
  });

  it("the same where the resume is the first event read: its batch delivered first, or a receiver that joined at it", () => {
    // In the order they were recorded; the run before ended 132 ms before the resume, and
    // its end was recorded after it.
    const ev = recorder();
    const startup = ev("session.started", 0, { source: "startup" });
    const stop1 = ev("turn.ended", 4137, { turn_id: "p1" });
    const resumed = ev("session.started", 4380, { source: "resume" });
    const end = ev("session.ended", 4248, { reason: "exit" });
    const prompt = ev("turn.started", 6000, { turn_id: "p2" });
    const tool = ev("tool.started", 7000, { tool: "Bash", call_id: "c2", turn_id: "p2" });
    const running = { state: "working", ended: false, turn: "p2", tool: "c2" };
    // The batch that holds the resume and that end arrives ahead of the one before it.
    expect(read([resumed, end, startup, stop1, prompt, tool])).toMatchObject(running);
    // The receiver's first event is the resume.
    expect(read([resumed, end, prompt, tool])).toMatchObject(running);
    // As recorded.
    expect(read([startup, stop1, resumed, end, prompt, tool])).toMatchObject(running);
    // And the resumed run's own end ends it.
    const stop2 = ev("turn.ended", 9000, { turn_id: "p2", reason: "stop" });
    const exit = ev("session.ended", 9010, { reason: "exit" });
    expect(read([resumed, end, prompt, tool, stop2, exit])).toMatchObject({ state: "done", ended: true });
    // A session whose first event is its startup owes no end: that run's end is its own.
    const fresh = recorder();
    expect(
      read([fresh("session.started", 100, { source: "startup" }), fresh("session.ended", 50, { reason: "exit" })]),
    ).toMatchObject({
      state: "done",
      ended: true,
    });
  });

  it("a turn only implied stands at its newest event: the end of the turn before leaves it running, and it is the turn that event names", () => {
    // In the order they were recorded; the two prompts reach the receiver last (a sink
    // that joined mid-turn, a batch delivered late): tools of p1, then of p2, then p1's end.
    const ev = recorder();
    const hello = ev("session.started", 0);
    const p1 = ev("turn.started", 500, { turn_id: "p1" });
    const read1 = ev("tool.ended", 1000, { tool: "Read", call_id: "c1", turn_id: "p1", ok: true });
    const end1 = ev("turn.ended", 3000, { turn_id: "p1", reason: "stop" });
    const p2 = ev("turn.started", 3500, { turn_id: "p2" });
    const bash = ev("tool.started", 4000, { tool: "Bash", call_id: "c2", turn_id: "p2" });
    const events = [hello, read1, bash, end1];
    expect(read(events)).toMatchObject({ state: "working", turn: "p2", tool: "c2" });
    // p1's own start, later still, is not the turn that is running; p2's is (and its tool
    // is still the one that runs), and p2's end ends it.
    events.push(p1, p2);
    expect(read(events)).toMatchObject({ state: "working", turn: "p2", tool: "c2" });
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

describe("a sender's clock ahead of the receiver's", () => {
  // A time ahead of its arrival stands at the arrival, so a batch from such a clock arrives
  // at one instant. It is still that clock's own order.
  it("one batch holding an end, the next prompt and its tool: the turn and the tool are read", () => {
    const s = live();
    s.ev("session.started", 0).ev("turn.started", 1 * S, { turn_id: "p1" });
    // 3 s ahead, and drained at once.
    s.ev("turn.ended", 8 * S, { turn_id: "p1" }, { at: 7 * S })
      .ev("turn.started", 9 * S, { turn_id: "p2" }, { at: 7 * S })
      .ev("tool.started", 9.5 * S, { tool: "Bash", call_id: "q" }, { at: 7 * S });
    expect(s.read()).toMatchObject({ state: "working", turn: "p2", tool: "q" });
  });

  it("the same with no prompt hook: the tool after the end is a turn", () => {
    const s = live();
    s.ev("session.started", 0).ev("tool.started", 1 * S, { tool: "Bash", call_id: "a" });
    s.ev("turn.ended", 8 * S, {}, { at: 7 * S }).ev(
      "tool.started",
      9.5 * S,
      { tool: "Bash", call_id: "q" },
      { at: 7 * S },
    );
    expect(s.read()).toMatchObject({ state: "working", tool: "q" });
    expect(s.read(9 * MIN)).toMatchObject({ state: "working", tool: "q" });
  });

  it("a hook recorded late in such a batch still finds its turn ended", () => {
    const s = live();
    s.ev("session.started", 0).ev("turn.started", 1 * S, { turn_id: "p1" });
    s.ev("turn.ended", 8 * S, { turn_id: "p1" }, { at: 7 * S }).ev(
      "tool.ended",
      7.99 * S,
      { tool: "Read", call_id: "c", ok: true },
      { at: 7 * S },
    );
    expect(s.read()).toMatchObject({ state: "idle", turn: null });
  });
});

describe("a sender's clock that steps back", () => {
  // Further back than a hook waits to be recorded (LATE_MS), a time says a clock moved,
  // and the event is read where it was recorded.
  it.each([
    ["30 s", 30 * S],
    ["5 min", 5 * MIN],
    ["1 h", H],
  ])("%s back after a turn ended: the next turn reads working from its prompt on, by its id, and ends", (_, back) => {
    const s = live();
    s.ev("session.started", 0)
      .ev("turn.started", 1 * S, { turn_id: "p1" })
      .ev("tool.started", 2 * S, { tool: "Bash", call_id: "a" })
      .ev("tool.ended", 3 * S, { tool: "Bash", call_id: "a", ok: true })
      .ev("turn.ended", 4 * S, { turn_id: "p1", reason: "stop" });
    // The next turn starts 10 s later by a true clock and runs 8 minutes, a tool every 20 s.
    const from = 14 * S;
    s.ev("turn.started", from - back, { turn_id: "p2" }, { at: from + 50 });
    expect(s.read()).toMatchObject({ state: "working", turn: "p2" });
    for (let k = 0; k < 24; k++) {
      const at = from + 1 * S + k * 20 * S;
      s.ev("tool.started", at - back, { tool: "Bash", call_id: `b${k}` }, { at: at + 50 });
      expect(s.read(), `the tool at ${k * 20} s`).toMatchObject({ state: "working", turn: "p2", tool: `b${k}` });
      s.ev("tool.ended", at + 15 * S - back, { tool: "Bash", call_id: `b${k}`, ok: true }, { at: at + 15 * S + 50 });
    }
    s.ev("turn.ended", from + 8 * MIN - back, { turn_id: "p2", reason: "stop" }, { at: from + 8 * MIN + 50 });
    expect(s.read()).toMatchObject({ state: "idle", turn: null });
  });

  it("1 h back after a turn ended, on a harness with no prompt hook and no turn ids: its tools are a turn", () => {
    const s = live();
    s.ev("session.started", 0)
      .ev("tool.started", 1 * S, { tool: "Bash", call_id: "a" })
      .ev("turn.ended", 4 * S, {});
    s.ev("tool.started", 15 * S - H, { tool: "Bash", call_id: "b" }, { at: 15 * S + 50 });
    expect(s.read()).toMatchObject({ state: "working", tool: "b" });
    s.ev("turn.ended", 30 * S - H, {}, { at: 30 * S + 50 });
    expect(s.read()).toMatchObject({ state: "idle", turn: null });
  });

  it("a run resumed on a clock 5 min behind its last end is running, and stays so", () => {
    const s = live();
    s.ev("session.started", 0)
      .ev("turn.started", 1 * S, { turn_id: "p1" })
      .ev("turn.ended", 5 * S, { turn_id: "p1" })
      .ev("session.ended", 6 * S, { reason: "exit" });
    expect(s.read()).toMatchObject({ state: "done", ended: true });
    const back = 5 * MIN;
    const at = 26 * S;
    s.ev("session.started", at - back, { source: "resume" }, { at: at + 50 })
      .ev("turn.started", at + 1 * S - back, { turn_id: "p2" }, { at: at + 1 * S + 50 })
      .ev("tool.started", at + 2 * S - back, { tool: "Bash", call_id: "x" }, { at: at + 2 * S + 50 });
    expect(s.read()).toMatchObject({ state: "working", ended: false, turn: "p2", tool: "x" });
    // Six minutes on, its clock past the old end; then the next turn.
    s.ev("tool.ended", at + 6 * MIN - back, { tool: "Bash", call_id: "x", ok: true }, { at: at + 6 * MIN + 50 }).ev(
      "tool.started",
      at + 6 * MIN + 1 * S - back,
      { tool: "Edit", call_id: "y" },
      { at: at + 6 * MIN + 1 * S + 50 },
    );
    expect(s.read()).toMatchObject({ state: "working", ended: false, turn: "p2", tool: "y" });
    s.ev("turn.ended", at + 7 * MIN - back, { turn_id: "p2" }, { at: at + 7 * MIN + 50 }).ev(
      "turn.started",
      at + 8 * MIN - back,
      { turn_id: "p3" },
      { at: at + 8 * MIN + 50 },
    );
    expect(s.read()).toMatchObject({ state: "working", ended: false, turn: "p3" });
  });

  it("a resume in the very millisecond of the end, its sender's seq started again, is running", () => {
    const s = live();
    s.ev("session.started", 0)
      .ev("turn.started", 1 * S, { turn_id: "p1" })
      .ev("turn.ended", 5 * S, { turn_id: "p1" })
      .ev("session.ended", 6 * S, { reason: "exit" });
    s.ev("session.started", 6 * S, { source: "resume" }, { seq: 0, at: 6.1 * S })
      .ev("turn.started", 6 * S, { turn_id: "p2" }, { seq: 1, at: 6.2 * S })
      .ev("tool.started", 7 * S, { tool: "Bash", call_id: "x" }, { seq: 2, at: 7.1 * S });
    expect(s.read()).toMatchObject({ state: "working", ended: false, turn: "p2", tool: "x" });
  });

  it("5 min back in the middle of a turn: its Stop, timed before its own prompt, ends it, and the next turn is read", () => {
    for (const ids of [true, false]) {
      const id = (turn: string) => (ids ? { turn_id: turn } : {});
      const s = live();
      s.ev("session.started", 0)
        .ev("turn.started", 10 * MIN, id("p1"))
        .ev("tool.started", 10 * MIN + 1 * S, { tool: "Bash", call_id: "a" });
      const back = 5 * MIN;
      const end = 10 * MIN + 30 * S;
      s.ev(
        "tool.ended",
        10 * MIN + 10 * S - back,
        { tool: "Bash", call_id: "a", ok: true },
        { at: 10 * MIN + 10 * S + 50 },
      );
      s.ev("turn.ended", end - back, { ...id("p1"), reason: "stop" }, { at: end + 50 });
      expect(s.read(1 * S), `ids ${ids}`).toMatchObject({ state: "idle", turn: null });
      expect(s.read(2 * H), `ids ${ids}`).toMatchObject({ state: "idle", turn: null });
      // A whole next turn, still timed before the old prompt.
      s.ev("turn.started", end + 1 * MIN - back, id("p2"), { at: end + 1 * MIN + 50 });
      expect(s.read(), `ids ${ids}`).toMatchObject({ state: "working", turn: ids ? "p2" : "?" });
      s.ev("turn.ended", end + 2 * MIN - back, { ...id("p2"), reason: "stop" }, { at: end + 2 * MIN + 50 });
      expect(s.read(), `ids ${ids}`).toMatchObject({ state: "idle", turn: null });
    }
  });

  it("an end dated 1970 is still an end", () => {
    const epoch = "1970-01-01T00:00:00.000Z";
    const turn = live();
    turn.ev("session.started", 0).ev("turn.started", 1 * S, { turn_id: "p1" });
    turn.ev("turn.ended", 0, { turn_id: "p1" }, { time: epoch, at: 3 * S });
    expect(turn.read()).toMatchObject({ state: "idle", turn: null });
    const session = live();
    session.ev("session.started", 0).ev("turn.started", 1 * S, { turn_id: "p1" });
    session.ev("session.ended", 0, { reason: "exit" }, { time: epoch, at: 3 * S });
    expect(session.read()).toMatchObject({ state: "done", ended: true, turn: null });
  });

  it("no further back than a hook waits, an event with only its time to place it is still the ended turn's", () => {
    // What cannot be told apart: a tool's end recorded a second late, and one from a clock
    // that stepped back two seconds, a second after the Stop. Read as the first; the next
    // event timed after the end is read as the turn it is.
    const s = live();
    s.ev("session.started", 0)
      .ev("tool.started", 1 * S, { tool: "Bash", call_id: "a" })
      .ev("turn.ended", 4 * S, {});
    s.ev("tool.started", 5 * S - LATE_MS, { tool: "Bash", call_id: "b" }, { at: 5 * S + 50 });
    expect(s.read()).toMatchObject({ state: "idle" });
    s.ev("tool.ended", 6.5 * S - LATE_MS, { tool: "Bash", call_id: "b", ok: true }, { at: 6.5 * S + 50 });
    expect(s.read()).toMatchObject({ state: "working" });
  });
});

describe("what the reducer keeps for placing events", () => {
  it("is bounded however many agents and turns a session runs", () => {
    const ev = recorder();
    const rec = newRecord("claude-code", "s", new Date(NOW).toISOString(), "http");
    const apply = (e: ProtocolEvent) => applyEvent(rec, e, new Date(NOW).toISOString(), "http");
    apply(ev("session.started", 0));
    for (let n = 0; n < 500; n++) {
      apply(ev("turn.started", n * 100, { turn_id: `p${n}` }));
      apply(ev("subagent.started", n * 100 + 10, { agent_id: `a${n}` }));
      apply(ev("subagent.ended", n * 100 + 20, { agent_id: `a${n}` }));
      apply(ev("turn.ended", n * 100 + 30, { turn_id: `p${n}` }));
    }
    expect(rec.track.agentEnds.size).toBeLessThanOrEqual(64);
    expect(rec.track.agentEnds.has("a499")).toBe(true);
    expect(rec.track.turnIds.length).toBeLessThanOrEqual(16);
    expect(rec.track.callsEnded.length).toBeLessThanOrEqual(32);
  });
});

describe("generated sessions", () => {
  // Sessions in the proportions of a real outbox (529 sessions, 43,213 events, timing
  // only): a turn takes 2 s and more, its first tool comes 2 s to 10 s after the prompt, a
  // run that does nothing ends 60 ms to 70 ms after it starts, a resume follows an end by
  // 0.27 s at the soonest, one end in twelve is a turn ending a second time, and one hook
  // in four is recorded after what fired within the next 1.29 s at the most.
  let seed = 20261111;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const chance = (p: number) => rnd() < p;

  /** A hook as it fired: `job` is the hook process, whose events share a time. */
  interface Fired {
    type: string;
    data: Record<string, unknown>;
    t: number;
    job: number;
  }
  function story(ids: boolean): Fired[] {
    const out: Fired[] = [];
    let t = 0;
    let job = 0;
    const fire = (type: string, data: Record<string, unknown> = {}, wait = 0, same = false) => {
      t += wait;
      if (!same) job++;
      out.push({ type, data, t, job });
    };
    const of = (n: number) => (ids ? { turn_id: `p${n}` } : {});
    fire("session.started", { source: "startup" });
    if (chance(0.2)) {
      fire("session.ended", { reason: "other" }, between(60, 70));
      fire("session.started", { source: "resume" }, between(300, 10_000));
    }
    const turns = between(1, 4);
    let call = 0;
    for (let n = 0; n < turns; n++) {
      const last = n === turns - 1;
      const wait = n === 0 ? between(5, 3000) : chance(0.05) ? between(0, 50) : between(500, 30_000);
      fire("turn.started", { ...of(n), prompt_chars: 40 }, wait);
      fire("turn.progress", { turn: n, user: "ask", assistant: "" }, 0, true);
      let running = false;
      for (let k = between(0, 4); k > 0; k--) {
        const id = `c${call++}`;
        fire(
          "tool.started",
          { tool: "Bash", call_id: id, ...of(n) },
          running ? between(50, 5000) : between(2000, 10_000),
        );
        // The last tool of what was sent may still be running.
        running = last && k === 1 && chance(0.3);
        if (running) break;
        fire("tool.ended", { tool: "Bash", call_id: id, ...of(n), ok: true }, between(20, 5000));
        if (chance(0.3)) fire("turn.progress", { turn: n, user: "ask", assistant: "so far" }, 0, true);
        if (chance(0.05)) fire("session.started", { source: "compact" }, between(100, 2000));
      }
      if (running) return out;
      if (chance(0.25)) {
        fire("subagent.started", { agent_id: `a${n}` }, between(100, 2000));
        fire("tool.started", { tool: "Grep", call_id: `g${n}`, agent_id: `a${n}`, ...of(n) }, between(500, 3000));
        fire(
          "tool.ended",
          { tool: "Grep", call_id: `g${n}`, agent_id: `a${n}`, ...of(n), ok: true },
          between(50, 3000),
        );
        fire("subagent.ended", { agent_id: `a${n}` }, between(8000, 20_000));
      }
      if (last && chance(0.4)) {
        // Still running at the end of what was sent; now and then killed with its turn open.
        if (chance(0.2)) fire("session.ended", { reason: "other" }, between(500, 20_000));
        return out;
      }
      fire("turn.ended", { ...of(n), reason: "stop", background: 0 }, between(1000, 8000));
      if (chance(0.08)) {
        if (chance(0.1)) {
          const id = `c${call++}`;
          fire("tool.started", { tool: "Bash", call_id: id, ...of(n) }, between(2000, 130_000));
          fire("tool.ended", { tool: "Bash", call_id: id, ...of(n), ok: true }, between(20, 5000));
        }
        fire("turn.ended", { ...of(n), reason: "stop", background: 0 }, between(1828, 10_000));
      }
      if (!last && chance(0.2)) {
        fire("session.ended", { reason: "other" }, between(5, 50));
        fire("session.started", { source: "resume" }, chance(0.35) ? between(271, 2000) : between(2000, 10_000));
      }
    }
    if (chance(0.2)) fire("session.ended", { reason: "other" }, between(5, 50));
    return out;
  }

  /** The order the sender recorded them in: a hook now and then waits (half the waits
   *  under 0.1 s, the longest 1.29 s) and is recorded after what fired meanwhile. */
  function recorded(fired: Fired[]): Fired[] {
    const wait = new Map<number, number>();
    for (const e of fired) {
      if (wait.has(e.job)) continue;
      const late = chance(0.25);
      wait.set(
        e.job,
        !late ? 0 : chance(0.7) ? between(1, 100) : chance(0.83) ? between(100, 500) : between(500, 1290),
      );
    }
    return fired
      .map((e, i) => ({ e, i, at: e.t + (wait.get(e.job) ?? 0) }))
      .sort((a, b) => a.at - b.at || a.i - b.i)
      .map((x) => x.e);
  }

  interface Sent {
    ev: ProtocolEvent;
    /** When it reached the receiver, by the receiver's (true) clock. */
    at: number;
  }
  /** The events as a sender sends them: `seq` in the order given; `time` by a clock that
   *  is true, or `back` behind from `from` on, or `ahead` throughout; each arriving 50 ms
   *  after it fired, or (`batch`) several at once. */
  function send(order: Fired[], o: { back?: number; from?: number; ahead?: number; batch?: boolean } = {}): Sent[] {
    const s = new Session("s");
    let hi = 0;
    const out = order.map((e) => {
      const time = e.t + (o.ahead ?? 0) - (o.back !== undefined && e.t > (o.from ?? 0) ? o.back : 0);
      // Arrival never runs backwards: a hook recorded late arrives after what was recorded ahead of it.
      hi = Math.max(hi, e.t + 50);
      return { ev: s.ev(e.type, e.data, { time: new Date(BASE + time).toISOString() }), at: hi };
    });
    if (o.batch)
      for (let i = 0; i < out.length; ) {
        const n = Math.min(out.length - i, between(1, 6));
        for (let k = i; k < i + n; k++) out[k]!.at = out[i + n - 1]!.at;
        i += n;
      }
    return out;
  }

  /** The reading after each event (or only after the last). */
  function readings(sent: Sent[], every = true): string[] {
    const rec = newRecord("claude-code", "s", new Date(BASE).toISOString(), "http");
    const out: string[] = [];
    sent.forEach((x, i) => {
      applyEvent(rec, x.ev, new Date(BASE + x.at).toISOString(), "http");
      if (every || i === sent.length - 1) out.push(JSON.stringify(reading(rec, BASE + x.at + 100)));
    });
    return out;
  }
  const last = (r: string[]) => r[r.length - 1];
  /** The first place two lists of readings differ, in words; "" when they do not. */
  const differ = (got: string[], want: string[], sent: Sent[]): string => {
    const i = got.findIndex((g, k) => g !== want[k]);
    if (i < 0) return "";
    const line = sent.map((x) => `${x.ev.type}@${Date.parse(x.ev.time) - BASE}`).join(" ");
    return `after event ${i}: read ${got[i]}, is ${want[i]}\n${line}`;
  };

  const ROUNDS = 1000;
  const BACK: [string, number][] = [
    ["2 s", 2 * S],
    ["30 s", 30 * S],
    ["5 min", 5 * MIN],
    ["1 h", H],
  ];

  for (const ids of [true, false]) {
    const who = ids ? "a harness that names its turns" : "a harness with no turn ids";

    it(`${who}: a session reads as it happened, hooks recorded late`, () => {
      seed = 20261111;
      const wrong: string[] = [];
      let late = 0;
      for (let round = 0; round < ROUNDS; round++) {
        const fired = story(ids);
        const order = recorded(fired);
        if (order.some((e, i) => e !== fired[i])) late++;
        const sent = send(order);
        const d = differ(readings(sent, false), [last(readings(send(fired)))!], sent);
        if (d) wrong.push(d);
      }
      expect(late, "rounds in which a hook was recorded after a later one").toBeGreaterThan(ROUNDS / 10);
      expect(wrong).toEqual([]);
    });

    it(`${who}: under a clock that steps back, every reading is the one a true clock gives`, () => {
      seed = 20261112;
      const wrong: string[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const fired = story(ids);
        const want = readings(send(fired));
        const end = fired[fired.length - 1]!.t;
        for (const [name, back] of BACK) {
          // The step falls at a random time, and right after a random event (which finds the short gaps).
          for (const from of [Math.floor(rnd() * end), fired[between(0, fired.length - 1)]!.t]) {
            const sent = send(fired, { back, from });
            const d = differ(readings(sent), want, sent);
            if (d) wrong.push(`${name} back from ${from}, ${d}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    it(`${who}: the same with hooks recorded late as well, and under a clock ahead of the receiver's in batches`, () => {
      seed = 20261113;
      const wrong: string[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const fired = story(ids);
        const want = readings(send(fired));
        const order = recorded(fired);
        const end = fired[fired.length - 1]!.t;
        for (const [name, back] of BACK) {
          const sent = send(order, { back, from: Math.floor(rnd() * end) });
          const d = differ(readings(sent, false), [last(want)!], sent);
          if (d) wrong.push(`late and ${name} back, ${d}`);
        }
        for (const ahead of [3 * S, H]) {
          const sent = send(fired, { ahead, batch: true });
          const d = differ(readings(sent), want, sent);
          if (d) wrong.push(`${ahead} ms ahead, ${d}`);
        }
      }
      expect(wrong).toEqual([]);
    });

    it(`${who}: the same whatever order the batches are delivered in`, () => {
      seed = 20261114;
      const wrong: string[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const fired = story(ids);
        const want = last(readings(send(fired)))!;
        const sent = send(recorded(fired));
        // Batches of one to six, one now and then delivered after the next; then any order at all.
        const batches: Sent[][] = [];
        for (let i = 0; i < sent.length; ) {
          const n = between(1, 6);
          batches.push(sent.slice(i, i + n));
          i += n;
        }
        for (let i = 0; i + 1 < batches.length; i++)
          if (chance(0.3)) [batches[i], batches[i + 1]] = [batches[i + 1]!, batches[i]!];
        const shuffled = [...sent];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = between(0, i);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        // Batches out of order: the state and the turn it is in. Any order at all: the state,
        // whether it ended and its running agents.
        const part = (r: string, turn: boolean) => {
          const x = JSON.parse(r) as ReturnType<typeof reading>;
          return JSON.stringify({
            state: x.state,
            ended: x.ended,
            agents: x.agents,
            ...(turn ? { turn: x.turn } : {}),
          });
        };
        const b = last(readings(batches.flat(), false))!;
        if (part(b, true) !== part(want, true))
          wrong.push(
            `batches: read ${b}, is ${want}\n${batches
              .flat()
              .map((x) => `${x.ev.type}@${Date.parse(x.ev.time) - BASE}#${x.ev.session.seq}`)
              .join(" ")}`,
          );
        const a = last(readings(shuffled, false))!;
        if (part(a, false) !== part(want, false))
          wrong.push(
            `any order: read ${a}, is ${want}\n${shuffled.map((x) => `${x.ev.type}@${Date.parse(x.ev.time) - BASE}#${x.ev.session.seq}`).join(" ")}`,
          );
      }
      expect(wrong).toEqual([]);
    });
  }
});
