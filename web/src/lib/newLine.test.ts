// SPDX-License-Identifier: Apache-2.0
// The New line: it lands on the answer of the first turn that ended after the mark,
// never on the person's own terminal turn, and not at all when it can't be placed right.
import { EMPTY_MARKS, type Marks, type SessionSummary, type StoredEvent } from "@shared/api";
import { describe, expect, it } from "vitest";
import { leftOff, newLinePlace } from "./newLine";
import { groupTurns } from "./turns";

const T0 = Date.parse("2026-10-28T10:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

/** One session's events, `time` and `arrivedAt` in seconds after T0. */
function session(attended?: boolean) {
  let seq = 1;
  return (type: string, s: number, data: Record<string, unknown> = {}): StoredEvent => ({
    protocol: 1,
    id: `e${seq}`,
    type,
    time: iso(s),
    tier: 3,
    harness: { name: "claude-code" },
    session: { id: "s1", seq: seq++, ...(attended === undefined ? {} : { attended }) },
    privacy: { rulesets: [], pii: false },
    data,
    arrivedAt: iso(s),
    source: "http",
  });
}

/** A whole turn: started at `s`, two tools, ended at `s + 10`, its reply after. */
function turn(ev: ReturnType<typeof session>, s: number, o: { by?: string; reply?: string; error?: string } = {}) {
  return [
    ev("turn.started", s, o.by ? { submitted_by: o.by } : {}),
    ev("tool.started", s + 1, { tool: "Read", call_id: `r${s}` }),
    ev("tool.ended", s + 2, { tool: "Read", call_id: `r${s}`, ok: true }),
    ev("tool.started", s + 3, { tool: "Bash", call_id: `b${s}` }),
    ev("tool.ended", s + 4, { tool: "Bash", call_id: `b${s}`, ok: true }),
    ev("turn.ended", s + 10, o.error ? { reason: "error", error: o.error } : { reason: "stop" }),
    ...(o.reply === undefined ? [] : [ev("turn.transcript", s + 10, { user: "go", assistant: o.reply, at: iso(s) })]),
  ];
}
const endedSeq = (events: StoredEvent[], s: number) =>
  events.find((e) => e.type === "turn.ended" && e.time === iso(s + 10))!.session.seq;

describe("newLinePlace", () => {
  it("lands above the reply of the first turn after the mark, not on its tools", () => {
    const ev = session();
    const events = [
      ...turn(ev, 0, { reply: "One." }),
      ...turn(ev, 100, { reply: "Two." }),
      ...turn(ev, 200, { reply: "Three." }),
    ];
    const line = newLinePlace(groupTurns(events), iso(50));
    expect(line).toEqual({ seq: endedSeq(events, 100), above: "reply" });
  });

  it("skips the person's own terminal turn in an attended session", () => {
    const ev = session(true);
    const events = [
      ...turn(ev, 0, { reply: "One." }),
      ...turn(ev, 100, { by: "user", reply: "You asked at the terminal." }),
      ...turn(ev, 200, { by: "schedule_wakeup", reply: "The loop woke up." }),
    ];
    expect(newLinePlace(groupTurns(events), iso(50))).toEqual({ seq: endedSeq(events, 200), above: "reply" });
  });

  it("counts a user's turn as news when the session is not known to be attended", () => {
    const ev = session();
    const events = [...turn(ev, 0, { reply: "One." }), ...turn(ev, 100, { by: "user", reply: "Two." })];
    expect(newLinePlace(groupTurns(events), iso(50))?.seq).toBe(endedSeq(events, 100));
    // The session's own reading says attended when the events don't.
    expect(newLinePlace(groupTurns(events), iso(50), { attended: true })).toBeNull();
  });

  it("draws no line when the session was read at open (no mark)", () => {
    const ev = session();
    const events = [...turn(ev, 0, { reply: "One." }), ...turn(ev, 100, { reply: "Two." })];
    expect(newLinePlace(groupTurns(events), undefined)).toBeNull();
  });

  it("draws no line when nothing ended after the mark", () => {
    const ev = session();
    const events = [...turn(ev, 0, { reply: "One." }), ev("turn.started", 100)];
    expect(newLinePlace(groupTurns(events), iso(50))).toBeNull();
  });

  it("a session never looked at (every loaded turn ended after the mark) gets no line", () => {
    // Started after `since` and never opened: its mark is `since`, and the whole session
    // is loaded. Nothing above the first answer was ever read, so there's no line.
    const ev = session();
    const events = [...turn(ev, 100, { reply: "Two." }), ...turn(ev, 200, { reply: "Three." })];
    expect(newLinePlace(groupTurns(events), iso(50))).toBeNull();
  });

  it("draws no line when the mark is older than the loaded page", () => {
    const ev = session();
    const events = [...turn(ev, 100, { reply: "Two." }), ...turn(ev, 200, { reply: "Three." })];
    expect(newLinePlace(groupTurns(events), iso(50))).toBeNull();
    // The page reaches back past the mark: the line is placed.
    expect(newLinePlace(groupTurns(events), iso(150))?.seq).toBe(endedSeq(events, 200));
  });

  it("puts a failure-only turn's line above the failure", () => {
    const ev = session();
    const events = [...turn(ev, 0, { reply: "One." }), ...turn(ev, 100, { error: "rate limited" })];
    expect(newLinePlace(groupTurns(events), iso(50))).toEqual({ seq: endedSeq(events, 100), above: "failure" });
  });

  it("puts the line where the reply will land when it hasn't arrived yet", () => {
    const ev = session();
    const events = [...turn(ev, 0, { reply: "One." }), ...turn(ev, 100)];
    expect(newLinePlace(groupTurns(events), iso(50))?.above).toBe("end");
  });
});

describe("leftOff", () => {
  const since = iso(0);
  const marks = (m: Partial<Marks> = {}): Marks => ({ rev: 1, since, read: {}, unread: {}, ...m });
  const row = { key: "claude-code:s1", state: "idle", newsAt: iso(300) } as SessionSummary;

  it("is the read mark, else since, when the session is unread; undefined when it is read", () => {
    expect(leftOff(row, marks({ read: { "claude-code:s1": iso(100) } }))).toBe(iso(100));
    expect(leftOff(row, marks())).toBe(since);
    expect(leftOff(row, marks({ read: { "claude-code:s1": iso(300) } }))).toBeUndefined();
  });

  it("waits (null) while the marks are not in yet, rather than reading the session as read", () => {
    // A cold open: the session's page and summary came before the stream's snapshot.
    expect(leftOff(row, EMPTY_MARKS)).toBeNull();
  });
});
