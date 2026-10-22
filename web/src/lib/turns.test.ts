// SPDX-License-Identifier: Apache-2.0
// Turns: a transcript lands on the turn it describes, by time, whatever number its sender
// gave it; and a message sent from here finds its own turn, two in a row included.
import type { StoredEvent } from "@shared/api";
import { describe, expect, it } from "vitest";
import { groupTurns, sentTurns, type Turn, turnPrompt, unframe } from "./turns";

const T0 = Date.parse("2026-10-22T10:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

/** One session's events, `time` in seconds after T0. */
function session() {
  let seq = 0;
  return (type: string, s: number, data: Record<string, unknown> = {}): StoredEvent => ({
    protocol: 1,
    id: `e${seq}`,
    type,
    time: iso(s),
    tier: 2,
    harness: { name: "claude-code" },
    session: { id: "s1", seq: seq++ },
    privacy: { rulesets: [], pii: false },
    data,
    arrivedAt: iso(s),
    source: "http",
  });
}
const started = (turns: Turn[]) => turns.filter((t) => t.start);
const prompts = (turns: Turn[]) => started(turns).map(turnPrompt);
const FRAME = "Message via studio-mac.local:7373 (sessionpipe control, signed on the sender's device):\n\n";

describe("groupTurns", () => {
  it("puts each transcript on its own turn when they come one per turn", () => {
    const ev = session();
    const turns = groupTurns([
      ev("session.started", 0),
      ev("turn.started", 1),
      ev("turn.ended", 5),
      // The sender counts its exchanges from 0: the first turn's transcript says 0.
      ev("turn.transcript", 5, { turn: 0, user: "hi", assistant: "Hello!", at: iso(1) }),
      ev("turn.started", 30),
      ev("turn.ended", 40),
      ev("turn.transcript", 40, { turn: 1, user: "What is the coolest feature?", assistant: "…", at: iso(30) }),
    ]);
    expect(prompts(turns)).toEqual(["hi", "What is the coolest feature?"]);
  });

  it("keeps the second prompt on the second turn when both transcripts arrive at its end", () => {
    // The first turn's transcript was not on disk at its Stop; the next Stop reads both.
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 1),
      ev("turn.ended", 5),
      ev("turn.started", 30),
      ev("turn.ended", 40),
      ev("turn.transcript", 40, { turn: 0, user: "hi", assistant: "Hello!", at: iso(1) }),
      ev("turn.transcript", 40, { turn: 1, user: "What is the coolest feature?", assistant: "…", at: iso(30) }),
    ]);
    expect(prompts(turns)).toEqual(["hi", "What is the coolest feature?"]);
  });

  it("reads a transcript stamped at its turn's end (the demo's) as that turn's", () => {
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 1),
      ev("turn.ended", 20),
      ev("turn.transcript", 20, { turn: 1, user: "one", assistant: "a", at: iso(20) }),
      ev("turn.started", 22),
      ev("turn.ended", 40),
      ev("turn.transcript", 40, { turn: 2, user: "two", assistant: "b", at: iso(40) }),
    ]);
    expect(prompts(turns)).toEqual(["one", "two"]);
  });

  it("leaves out an exchange from before the loaded turns (a fork's copied history)", () => {
    const ev = session();
    const turns = groupTurns([
      ev("session.started", 600, { source: "resume" }),
      ev("turn.started", 601),
      ev("turn.ended", 610),
      ev("turn.transcript", 610, { turn: 0, user: "hi", assistant: "Hello!", at: iso(1) }),
      ev("turn.transcript", 610, { turn: 1, user: "coolest?", assistant: "…", at: iso(601) }),
    ]);
    const [t] = started(turns);
    expect(t!.items.filter((i) => i.kind === "event" && i.e.type === "turn.transcript")).toHaveLength(1);
    expect(turnPrompt(t!)).toBe("coolest?");
  });

  it("falls back to the current turn when a transcript carries no readable time", () => {
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 1),
      ev("turn.ended", 5),
      ev("turn.started", 30),
      ev("turn.ended", 40),
      ev("turn.transcript", 40, { turn: 0, user: "two", assistant: "…" }),
    ]);
    expect(prompts(turns)).toEqual([undefined, "two"]);
  });
});

describe("sentTurns", () => {
  it("matches two prompts sent in a row each to its own turn", () => {
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 10),
      ev("turn.ended", 20),
      ev("turn.started", 40),
      ev("turn.ended", 50),
      ev("turn.transcript", 50, { turn: 0, user: `${FRAME}hi`, assistant: "Hello!", at: iso(10) }),
      ev("turn.transcript", 50, {
        turn: 1,
        user: `${FRAME}What is the coolest feature of this app?`,
        assistant: "…",
        at: iso(40),
      }),
    ]);
    const m = sentTurns(
      [
        { id: "m2", at: iso(38), text: "What is the coolest feature of this app?" },
        { id: "m1", at: iso(9), text: "hi" },
      ],
      turns,
    );
    const [first, second] = started(turns);
    expect(m.get("m1")).toBe(first!.n);
    expect(m.get("m2")).toBe(second!.n);
  });

  it("gives the same words sent twice their two turns, in order", () => {
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 10),
      ev("turn.progress", 10, { turn: 0, user: `${FRAME}hi`, assistant: "" }),
      ev("turn.ended", 20),
      ev("turn.started", 40),
      ev("turn.progress", 40, { turn: 1, user: `${FRAME}hi`, assistant: "" }),
    ]);
    const m = sentTurns(
      [
        { id: "a", at: iso(9), text: "hi" },
        { id: "b", at: iso(39), text: "hi" },
      ],
      turns,
    );
    const [first, second] = started(turns);
    expect([m.get("a"), m.get("b")]).toEqual([first!.n, second!.n]);
  });

  it("never matches a turn that started before the message, or other words", () => {
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 10),
      ev("turn.ended", 20),
      ev("turn.transcript", 20, { turn: 0, user: "this is it", assistant: "…", at: iso(10) }),
      ev("turn.started", 300),
      ev("turn.ended", 310),
      ev("turn.transcript", 310, { turn: 1, user: "hi", assistant: "…", at: iso(300) }),
    ]);
    // "hi" is in "this": a short message must be the whole prompt.
    expect(sentTurns([{ id: "x", at: iso(200), text: "hi" }], turns).get("x")).toBe(started(turns)[1]!.n);
    expect(sentTurns([{ id: "y", at: iso(400), text: "hi" }], turns).has("y")).toBe(false);
    expect(sentTurns([{ id: "z", at: iso(0), text: "is it" }], turns).has("z")).toBe(false);
  });

  it("reads a started session's first prompt with its source note after it", () => {
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 10),
      ev("turn.progress", 10, {
        turn: 0,
        user: "What is the coolest feature?\n\n(Sent via studio-mac.local:7373 with sessionpipe control, signed on the sender's device.)",
        assistant: "",
      }),
    ]);
    expect(sentTurns([{ id: "s", at: iso(8), text: "What is the coolest feature?" }], turns).get("s")).toBe(1);
  });
});

describe("unframe", () => {
  it("takes the machine's framing off and keeps where the message came from", () => {
    expect(unframe("Message via 127.0.0.1:7391 (sessionpipe control, signed on the sender's device):\n\nhi")).toEqual({
      text: "hi",
      via: "127.0.0.1:7391",
    });
    expect(unframe("Make a copy\n\n(Sent via studio-mac.local:7373 with sessionpipe control)")).toEqual({
      text: "Make a copy",
      via: "studio-mac.local:7373",
    });
    expect(unframe("Message via email please")).toEqual({ text: "Message via email please" });
  });
});
