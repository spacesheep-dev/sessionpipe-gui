// SPDX-License-Identifier: Apache-2.0
// Turns: a transcript lands on the turn it describes, by time, whatever number its sender
// gave it; a message handed over at a turn's Stop is an exchange of its own after it; and
// a message sent from here finds its own turn, two in a row included, on a machine whose
// clock is behind, with a prompt the machine scrubbed, and never when the session did not
// have it.
import type { AgentRun, StoredEvent } from "@shared/api";
import { describe, expect, it } from "vitest";
import { eventWords, groupTurns, handoffAnswer, sentTurns, type Turn, turnPrompt, unframe } from "./turns";

const T0 = Date.parse("2026-10-22T10:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

/** One session's events, arriving `s` seconds after T0 on the receiver's clock; `time`
 *  is the machine's, `behind` seconds behind it. */
function session(o: { behind?: number } = {}) {
  let seq = 0;
  return (type: string, s: number, data: Record<string, unknown> = {}): StoredEvent => ({
    protocol: 1,
    id: `e${seq}`,
    type,
    time: iso(s - (o.behind ?? 0)),
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
/** The turns someone asked for: begun by a prompt, or by a message a Stop handed over. */
const asked = (turns: Turn[]) => turns.filter((t) => t.start || (t as { continues?: number }).continues !== undefined);
/** What a turn's transcript says the assistant said (the last one filed on it). */
const reply = (t: Turn) =>
  [...t.items].reverse().find((i) => i.kind === "event" && i.e.type === "turn.transcript") as
    | { e: StoredEvent }
    | undefined;
const replies = (turns: Turn[]) => asked(turns).map((t) => reply(t)?.e.data.assistant);
const kinds = (t: Turn) => t.items.map((i) => (i.kind === "event" ? i.e.type : i.kind));
const FRAME = "Message via studio-mac.local:7373 (sessionpipe control, signed on the sender's device):\n\n";

describe("groupTurns", () => {
  it("leaves a status line's usage report out of the turn: it is the account's, not a step", () => {
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 1),
      ev("turn.ended", 5),
      ev("limits.observed", 6, { windows: [{ id: "five_hour", used_percent: 38 }] }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.items.map((i) => (i.kind === "event" ? i.e.type : i.kind))).toEqual(["turn.ended"]);
  });

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

describe("groupTurns: the turn after one that was stopped", () => {
  // conformance/transcripts/claude-code/killed-turn.jsonl: a turn told to count to 1500
  // whose process was ended mid-turn, then a one-word turn. The stopped turn has no Stop
  // of its own; the session's next prompt hook sends what the transcript holds of it. A
  // prompt is stamped as the harness writes it down, a tenth of a second before its hook.
  const COUNT =
    "Do not use any tools. Write the numbers 1 to 1500, one per line, and then on the last line just the word indiaa in capital letters";
  const WORD = "Reply with just the word indiab in capital letters";

  it("keeps its own words: 0.13.5 ends the stopped turn with `interrupt` as the next begins", () => {
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 48.961 + 0.121, { turn_id: "id1" }),
      ev("turn.progress", 48.961 + 0.121, { turn: 0, user: COUNT, assistant: "", at: iso(48.961) }),
      // The next prompt's hook: the stopped turn's end and its exchange first, then its own.
      ev("turn.ended", 82.97 + 0.121, { turn_id: "id1", reason: "interrupt" }),
      ev("turn.transcript", 82.97 + 0.121, { turn: 0, user: COUNT, assistant: "", at: iso(48.961) }),
      ev("turn.started", 82.97 + 0.121, { turn_id: "id5" }),
      ev("turn.progress", 82.97 + 0.121, { turn: 1, user: WORD, assistant: "", at: iso(82.97) }),
      ev("turn.ended", 89.99, { turn_id: "id5", reason: "stop" }),
      ev("turn.transcript", 89.99, { turn: 1, user: WORD, assistant: "INDIAB", at: iso(82.97) }),
    ]);
    // The second exchange used to land on the stopped turn too (its span ran up to the
    // next turn's start), and that is what was drawn: the stopped turn read "INDIAB", the
    // next one nothing.
    expect(prompts(turns)).toEqual([COUNT, WORD]);
    expect(replies(turns)).toEqual(["", "INDIAB"]);
  });

  it("an older sender: no end at all, and Claude Code's stand-in as what it said", () => {
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 48.961 + 0.121, { turn_id: "id1" }),
      ev("turn.progress", 48.961 + 0.121, { turn: 0, user: COUNT, assistant: "", at: iso(48.961) }),
      ev("turn.transcript", 82.97 + 0.121, {
        turn: 0,
        user: COUNT,
        assistant: "No response requested.",
        at: iso(48.961),
      }),
      ev("turn.started", 82.97 + 0.121, { turn_id: "id5" }),
      ev("turn.ended", 89.99, { turn_id: "id5", reason: "stop" }),
      ev("turn.transcript", 89.99, { turn: 1, user: WORD, assistant: "INDIAB", at: iso(82.97) }),
    ]);
    expect(prompts(turns)).toEqual([COUNT, WORD]);
    expect(replies(turns)).toEqual(["No response requested.", "INDIAB"]);
  });
});

// A terminal session that was handed a message at its Stop: the events sessionpipe 0.13.4
// sends for conformance/transcripts/claude-code/stop-hook-delivery.jsonl (recorded on
// Claude Code 2.1.322, 2026-11-10; packages/cli/test/delivered-turns.test.ts replays it a
// hook at a time). The typed turn ends at 30.6 s, its Stop hook answers with the message,
// the session answers that and stops again at 36.5 s, and then a background command wakes
// it. The message has no `turn.started`: its transcript is marked `injected`.
const SLEEP =
  "Run `sleep 25` in bash, then read docs/api.md and say one sentence about it, then end with the word LONGDONE.";
const WAITING =
  "`sleep 25` is running in the background, since this environment blocks foreground sleep. I'll read `docs/api.md` once it finishes.";
const ASK = "Reply with only the word INTERRUPT1.";
const DONE =
  "`docs/api.md` is a short stub with a heading and one line pointing to `src/api.ts` for the API details.\n\nLONGDONE";
/** `began`: when the typed turn began, in seconds (the fixture's is 10.6 s). */
function stopHookDelivery(began = 10.6) {
  const ev = session();
  const d = began - 10.6;
  return [
    ev("session.started", 9 + d, { source: "startup" }),
    ev("turn.started", began, { turn_id: "id1", prompt_chars: SLEEP.length }),
    ev("turn.progress", began, { turn: 0, user: SLEEP, assistant: "", at: iso(began) }),
    ev("tool.started", 18.5 + d, { tool: "Bash", call_id: "toolu_1", turn_id: "id1" }),
    ev("tool.ended", 18.6 + d, { tool: "Bash", call_id: "toolu_1", turn_id: "id1", ok: true }),
    // The turn's Stop: the hook hands the message over, and the turn's own exchange goes out.
    ev("turn.ended", 30.58, { turn_id: "id1", reason: "stop", background: 1 }),
    ev("turn.transcript", 30.58, { turn: 0, user: SLEEP, assistant: WAITING, at: iso(began) }),
    // The session answers the message and stops again: no `turn.started` in between.
    ev("turn.ended", 36.53, { turn_id: "id1", reason: "stop" }),
    ev("turn.transcript", 36.53, { turn: 1, user: ASK, assistant: "INTERRUPT1", at: iso(30.6), injected: true }),
    // The background command finishes and wakes the session: a turn nobody asked.
    ev("turn.started", 43.7, { turn_id: "id19", injected: true }),
    ev("tool.started", 46.1, { tool: "Read", call_id: "toolu_2", turn_id: "id19" }),
    ev("tool.ended", 46.2, { tool: "Read", call_id: "toolu_2", turn_id: "id19", ok: true }),
    ev("turn.ended", 47.93, { turn_id: "id19", reason: "stop" }),
    ev("turn.transcript", 47.93, { turn: 2, user: "", assistant: DONE, at: iso(47.883) }),
  ];
}

describe("groupTurns: a message handed to a terminal session at its Stop", () => {
  it("is an exchange of its own after the typed turn, which keeps its prompt and its reply", () => {
    const turns = groupTurns(stopHookDelivery());
    // Both transcripts used to be filed on the typed turn, and the last was drawn: the
    // typed prompt and what the agent said to it were gone.
    expect(asked(turns).map(turnPrompt)).toEqual([SLEEP, ASK, ""]);
    expect(replies(turns)).toEqual([WAITING, "INTERRUPT1", DONE]);
    const [typed, handed, woken] = asked(turns);
    expect(handed!.start).toBeUndefined();
    expect(handed!.continues).toBe(typed!.n);
    // In order, between its turn and the next, and the next keeps its number.
    expect(typed!.n < handed!.n && handed!.n < woken!.n).toBe(true);
    expect(woken!.n).toBe(typed!.n + 1);
    // The Stop that ended the answer is the exchange's own end; the typed turn keeps its rows.
    expect(kinds(typed!)).toEqual(["turn.progress", "tool", "turn.ended", "turn.transcript"]);
    expect(kinds(handed!)).toEqual(["turn.ended", "turn.transcript"]);
  });

  it("gives the exchange the tools the session ran to answer it, wherever the typed turn's transcript lands", () => {
    // The typed turn's last words were not on disk at its Stop (Claude Code writes them up
    // to 100 ms late): its transcript goes out with the session's next hook instead.
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 10, { turn_id: "id1" }),
      ev("turn.ended", 30, { turn_id: "id1", reason: "stop" }),
      ev("turn.transcript", 32, { turn: 0, user: SLEEP, assistant: WAITING, at: iso(10) }),
      ev("tool.started", 32, { tool: "Read", call_id: "c1", turn_id: "id1" }),
      ev("tool.ended", 33, { tool: "Read", call_id: "c1", turn_id: "id1", ok: true }),
      ev("turn.ended", 36, { turn_id: "id1", reason: "stop" }),
      ev("turn.transcript", 36, { turn: 1, user: ASK, assistant: "INTERRUPT1", at: iso(30.02), injected: true }),
    ]);
    const [typed, handed] = asked(turns);
    expect(kinds(typed!)).toEqual(["turn.ended", "turn.transcript"]);
    expect(kinds(handed!)).toEqual(["tool", "turn.ended", "turn.transcript"]);
    expect(replies(turns)).toEqual([WAITING, "INTERRUPT1"]);
  });

  it("two messages waiting for the same turn are handed over one Stop each, in order", () => {
    // CONTROL.md §6: in `turn` mode the order is the order the session's Stops are handed
    // the messages in. The first answer takes 22 s, so the second message is handed over
    // long after the typed turn's own end: it is still that turn's, never the next one's.
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 10, { turn_id: "id1" }),
      ev("turn.ended", 30, { turn_id: "id1", reason: "stop" }),
      ev("turn.transcript", 30, { turn: 0, user: SLEEP, assistant: WAITING, at: iso(10) }),
      ev("tool.started", 40, { tool: "Read", call_id: "c1", turn_id: "id1" }),
      ev("tool.ended", 41, { tool: "Read", call_id: "c1", turn_id: "id1", ok: true }),
      ev("turn.ended", 52, { turn_id: "id1", reason: "stop" }),
      ev("turn.transcript", 52, { turn: 1, user: ASK, assistant: "INTERRUPT1", at: iso(30.02), injected: true }),
      ev("turn.ended", 58, { turn_id: "id1", reason: "stop" }),
      ev("turn.transcript", 58, {
        turn: 2,
        user: "Reply with only the word INTERRUPT2.",
        assistant: "INTERRUPT2",
        at: iso(52.03),
        injected: true,
      }),
      ev("turn.started", 60, { turn_id: "id2" }),
    ]);
    expect(asked(turns).map(turnPrompt)).toEqual([SLEEP, ASK, "Reply with only the word INTERRUPT2.", undefined]);
    expect(replies(turns).slice(0, 3)).toEqual([WAITING, "INTERRUPT1", "INTERRUPT2"]);
    const [typed, first, second, next] = asked(turns);
    expect([first!.continues, second!.continues]).toEqual([typed!.n, typed!.n]);
    expect(first!.n < second!.n && second!.n < next!.n).toBe(true);
    expect(kinds(first!)).toEqual(["tool", "turn.ended", "turn.transcript"]);
    expect(kinds(second!)).toEqual(["turn.ended", "turn.transcript"]);
  });

  it("an injected prompt that began a turn of its own stays that turn's", () => {
    // A channel's or a peer's message that the harness reported with a prompt hook.
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 10, { turn_id: "id1" }),
      ev("turn.ended", 20, { turn_id: "id1", reason: "stop" }),
      ev("turn.transcript", 20, { turn: 0, user: "hi", assistant: "Hello!", at: iso(10) }),
      ev("turn.started", 26, { turn_id: "id2", injected: true }),
      ev("turn.ended", 29, { turn_id: "id2", reason: "stop" }),
      ev("turn.transcript", 29, { turn: 1, user: "ship it", assistant: "Shipped.", at: iso(26), injected: true }),
    ]);
    expect(turns.map((t) => t.continues)).toEqual([undefined, undefined]);
    expect(prompts(turns)).toEqual(["hi", "ship it"]);
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

  it("gives a tier-2 turn (its length only) to the message the machine took just before it", () => {
    const ev = session();
    const text = "Fix the rounding in refunds.";
    const turns = groupTurns([
      ev("turn.started", 10, { prompt_chars: 9 }),
      ev("turn.started", 30, { prompt_chars: text.length + 120 }),
    ]);
    const m = { id: "p", at: iso(20), takenAt: iso(25), text };
    // The first turn is too short to be these words.
    expect(sentTurns([m], turns).get("p")).toBe(2);
    // Not taken yet: no turn can be its.
    expect(sentTurns([{ ...m, takenAt: undefined }], turns).has("p")).toBe(false);
    // A length that can't be these words is someone else's turn.
    expect(sentTurns([{ ...m, text: "x".repeat(400) }], turns).has("p")).toBe(false);
  });

  it("gives a start the session's first turn, but only when the window begins at it", () => {
    const ev = session();
    const text = "Fix the invoice rounding in src/money.ts.";
    const turns = groupTurns([ev("session.started", 0), ev("turn.started", 4, { prompt_chars: text.length })]);
    const start = { id: "st", at: iso(-2), text, start: true };
    expect(sentTurns([start], turns, undefined, { fromStart: true }).get("st")).toBe(1);
    expect(sentTurns([start], turns).has("st")).toBe(false);
  });
});

describe("sentTurns: a message handed over at a turn's Stop", () => {
  // The message was sent from the page while the typed turn ran; the machine acked it
  // `taken` when the Stop hook handed it over and `delivered` when its answer ended.
  const sent = (at: number) => ({
    id: "m",
    at: iso(at),
    takenAt: iso(30.6),
    text: ASK,
    outcome: "delivered",
    ackedAt: iso(36.6),
  });

  it("is the exchange it began, not the typed turn before it", () => {
    const turns = groupTurns(stopHookDelivery());
    const [typed, handed] = asked(turns);
    // It used to be paired with the typed turn, whose prompt it then replaced.
    expect(sentTurns([sent(25)], turns).get("m")).toBe(handed!.n);
    expect(turnPrompt(typed!)).toBe(SLEEP);
  });

  it("when the typed turn began more than a minute before the send", () => {
    // No turn used to be found for it (the typed turn began before it was sent), and it
    // was drawn again at the end with its reply for two minutes.
    const turns = groupTurns(stopHookDelivery(-80));
    expect(sentTurns([sent(15)], turns).get("m")).toBe(asked(turns)[1]!.n);
  });
});

describe("sentTurns: the two clocks, and a prompt the machine scrubbed", () => {
  const TOKEN =
    "use the token ghp_abcdefghijklmnopqrstuvwxyz0123456789 with password=hunter2hunter2 and tell me the count";

  it("a prompt with a secret taken out is still the message that was sent", () => {
    // What sessionpipe's secrets ruleset leaves of it, while the turn runs and once it ended.
    const ev = session();
    const scrubbed = "use the token [redacted] with password=[redacted] and tell me the count";
    const running = groupTurns([
      ev("turn.started", 10, { turn_id: "t1", prompt_chars: TOKEN.length }),
      ev("turn.progress", 10, { turn: 0, user: scrubbed, assistant: "", at: iso(10) }),
    ]);
    expect(sentTurns([{ id: "m", at: iso(9), text: TOKEN }], running).get("m")).toBe(1);
    const ended = groupTurns([
      ev("turn.started", 10, { turn_id: "t1", prompt_chars: TOKEN.length }),
      ev("turn.ended", 19, { turn_id: "t1", reason: "stop" }),
      ev("turn.transcript", 19, { turn: 0, user: scrubbed, assistant: "eight", at: iso(10) }),
    ]);
    expect(sentTurns([{ id: "m", at: iso(9), text: TOKEN }], ended).get("m")).toBe(1);
    // Other words between the marks are another prompt.
    const other = groupTurns([
      ev("turn.started", 10),
      ev("turn.progress", 10, {
        turn: 0,
        user: "use the key [redacted] with password=[redacted] and tell me the sum",
        assistant: "",
      }),
    ]);
    expect(sentTurns([{ id: "m", at: iso(9), text: TOKEN }], other).has("m")).toBe(false);
  });

  it("an email address and a phone number taken out, at the very start and the very end", () => {
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 10),
      ev("turn.progress", 10, { turn: 0, user: "[email] wants a call on [phone]", assistant: "" }),
    ]);
    const m = { id: "m", at: iso(9), text: "ada@example.com wants a call on +1 415 555 0100" };
    expect(sentTurns([m], turns).get("m")).toBe(1);
    // A mark alone says nothing about which message it was.
    const bare = groupTurns([ev("turn.started", 10), ev("turn.progress", 10, { turn: 0, user: "[redacted]" })]);
    expect(sentTurns([{ id: "m", at: iso(9), text: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }], bare).has("m")).toBe(
      false,
    );
  });

  it("a machine whose clock is five minutes behind the receiver's loses nothing", () => {
    // The receiver stamps the message as it queues it and each event as it arrives; the
    // event's own `time` is the machine's. The two clocks used to be compared and given
    // a minute, so neither message found its turn.
    const ev = session({ behind: 300 });
    const first = "Build the release notes from the last ten commits";
    const turns = groupTurns([
      ev("turn.started", 10),
      ev("turn.progress", 10, { turn: 0, user: first, assistant: "" }),
      ev("turn.ended", 40),
      ev("turn.transcript", 40, { turn: 0, user: first, assistant: "Built.", at: iso(10 - 300) }),
      ev("turn.started", 62),
      ev("turn.progress", 62, { turn: 1, user: "continue", assistant: "" }),
    ]);
    const m = sentTurns(
      [
        { id: "a", at: iso(9), text: first, outcome: "delivered", ackedAt: iso(40 - 300) },
        { id: "b", at: iso(61), text: "continue" },
      ],
      turns,
    );
    expect([m.get("a"), m.get("b")]).toEqual([1, 2]);
  });

  it("a turn that reached the receiver before the message was queued is not its turn, whatever its date", () => {
    // The machine's clock is two minutes ahead: by its own date the typed turn began after
    // the message was sent. It was here first.
    const ev = session({ behind: -120 });
    const turns = groupTurns([ev("turn.started", 10), ev("turn.progress", 10, { turn: 0, user: "continue" })]);
    expect(sentTurns([{ id: "m", at: iso(60), text: "continue" }], turns).has("m")).toBe(false);
  });

  it("a turn dated long before the message, arriving after it, is not its turn", () => {
    // A machine that was offline sends what it had held: "continue" typed at its terminal
    // two hours ago arrives five seconds after the message was queued, then the message runs.
    const old = session({ behind: 7200 });
    const now = session();
    const held = [old("turn.started", 105), old("turn.progress", 105, { turn: 3, user: "continue" })];
    const mine = [now("turn.started", 110), now("turn.progress", 110, { turn: 4, user: "continue" })];
    const turns = groupTurns([
      ...held,
      ...mine.map((e) => ({ ...e, session: { ...e.session, seq: e.session.seq + 2 } })),
    ]);
    expect(sentTurns([{ id: "m", at: iso(100), text: "continue" }], turns).get("m")).toBe(2);
  });
});

describe("sentTurns: a message the session never had", () => {
  // "continue" is sent from the page a minute after the first turn and the machine refuses
  // it; five hours on, "continue" is typed at the terminal.
  const typedLater = () => {
    const ev = session();
    return groupTurns([
      ev("turn.started", 0),
      ev("turn.ended", 20),
      ev("turn.transcript", 20, { turn: 0, user: "start", assistant: "Started.", at: iso(0) }),
      ev("turn.started", 18_000),
      ev("turn.ended", 18_030),
      ev("turn.transcript", 18_030, { turn: 1, user: "continue", assistant: "Going on.", at: iso(18_000) }),
    ]);
  };
  const m = { id: "m", at: iso(60), text: "continue" };

  it("a refused, an expired or an unsupported message is nobody's prompt", () => {
    const turns = typedLater();
    // With no outcome check, the refusal was drawn on the turn typed five hours later.
    for (const outcome of ["refused", "expired", "unsupported"])
      expect(sentTurns([{ ...m, outcome, ackedAt: iso(61) }], turns).has("m")).toBe(false);
    // Nor is one that failed before the session had it: a file that did not arrive, a
    // session that did not take what was put in its inbox.
    for (const code of ["file", "held"])
      expect(sentTurns([{ ...m, outcome: "failed", code, ackedAt: iso(61) }], turns).has("m")).toBe(false);
  });

  it("the message that did run keeps its turn", () => {
    // The refused one is sent again and runs. The turn used to go to the refused message:
    // the refusal was drawn on it, and the second message was left without one.
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 100),
      ev("turn.progress", 100, { turn: 0, user: "continue", assistant: "" }),
      ev("turn.ended", 130),
      ev("turn.transcript", 130, { turn: 0, user: "continue", assistant: "Going on.", at: iso(100) }),
    ]);
    const map = sentTurns(
      [
        { id: "refused", at: iso(60), text: "continue", outcome: "refused", code: "folder", ackedAt: iso(61) },
        { id: "ran", at: iso(98), text: "continue", outcome: "delivered", ackedAt: iso(131) },
      ],
      turns,
    );
    expect(map.has("refused")).toBe(false);
    expect(map.get("ran")).toBe(1);
  });

  it("a message that failed part-way did reach the session: its turn is its turn", () => {
    const ev = session();
    const turns = groupTurns([ev("turn.started", 62), ev("turn.progress", 62, { turn: 0, user: "continue" })]);
    expect(sentTurns([{ ...m, outcome: "failed", ackedAt: iso(90) }], turns).get("m")).toBe(1);
  });

  it("a delivered message whose own turn is not loaded never takes a later one that says the same", () => {
    // Its turn is on an older page; "continue" typed twenty minutes after the machine's
    // last word on it is another turn. There used to be no upper bound.
    const ev = session();
    const turns = groupTurns([ev("turn.started", 1300), ev("turn.progress", 1300, { turn: 9, user: "continue" })]);
    expect(sentTurns([{ ...m, outcome: "delivered", ackedAt: iso(95) }], turns).has("m")).toBe(false);
    // While it has no final ack its turn may still come.
    expect(sentTurns([{ ...m, outcome: "taken" }], turns).get("m")).toBe(1);
  });
});

describe("eventWords", () => {
  it("writes the rows a log would print raw as words", () => {
    expect(eventWords({ type: "session.started", data: { source: "startup" } })).toEqual({ text: "Session started" });
    expect(eventWords({ type: "session.started", data: { source: "resume" } }).text).toBe("Session resumed");
    expect(eventWords({ type: "files.changed", data: { paths: ["src/api/handler.ts"] } })).toEqual({
      text: "Changed handler.ts",
      detail: "src/api",
    });
    expect(eventWords({ type: "files.changed", data: { paths: ["a/b.ts", "c.ts", "d.ts"] } }).text).toBe(
      "Changed b.ts and 2 more",
    );
    expect(eventWords({ type: "context.compacted", data: { trigger: "auto" } })).toEqual({ text: "Context compacted" });
    expect(eventWords({ type: "attention.cleared", data: { how: "answered" } })).toEqual({ text: "Answered" });
    expect(eventWords({ type: "files.changed", data: { paths: ["README.md"] } })).toEqual({
      text: "Changed README.md",
    });
    expect(eventWords({ type: "custom.thing_done", data: {} }).text).toBe("Custom thing done");
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

  it("takes the ask trailer off and keeps who asked", () => {
    const asked =
      "Review the diff.\n\n(Asked by claude-code:abc-1 on this machine with sessionpipe ask. Answer here in full: your reply is returned to that session automatically. Don't run a command or call a tool just to send it.)";
    expect(unframe(asked)).toEqual({ text: "Review the diff.", askedBy: "claude-code:abc-1" });
  });
});

describe("handoffAnswer", () => {
  it("reads the daemon's frame on an answer brought back, and nothing else", () => {
    expect(
      handoffAnswer(
        "Answer from codex:1f3a9c0e (sessionpipe handoff, asked via studio-mac.local:7373):\n\nTwo things.",
      ),
    ).toEqual({ harness: "codex", shortId: "1f3a9c0e", via: "studio-mac.local:7373", reply: "Two things." });
    expect(handoffAnswer("Answer from the review: it's fine")).toBeUndefined();
    expect(handoffAnswer("hi")).toBeUndefined();
  });
});

describe("groupTurns: asks", () => {
  it("puts the ask in the turn it began in and closes it by ask id, wherever the end lands", () => {
    const ev = session();
    const turns = groupTurns([
      ev("turn.started", 1),
      ev("tool.started", 2, { tool: "Bash", call_id: "c1", input: { command: "sessionpipe ask codex 'review'" } }),
      ev("delegation.started", 3, { ask_id: "01A", via: "ask", harness: "codex", text: "review" }),
      ev("turn.ended", 40),
      ev("delegation.ended", 41, { ask_id: "01A", to: "codex:t1", ok: true, ms: 38_000, reply: "Fine." }),
      ev("turn.started", 50),
      ev("delegation.ended", 51, { ask_id: "01B", to: "codex:t2", ok: false, ms: 10, error: "harness: no" }),
    ]);
    const [first, second] = started(turns);
    const asks = first!.items.filter((i) => i.kind === "delegation");
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      askId: "01A",
      started: { type: "delegation.started" },
      ended: { type: "delegation.ended" },
    });
    // After the tool that ran it: the ask reads where it happened.
    expect(first!.items.map((i) => i.kind)).toEqual(["tool", "delegation", "event"]);
    const alone = second!.items.filter((i) => i.kind === "delegation");
    expect(alone).toHaveLength(1);
    expect(alone[0]).toMatchObject({ askId: "01B" });
    expect((alone[0] as { started?: unknown }).started).toBeUndefined();
  });

  it("words the events for the feed", () => {
    expect(eventWords({ type: "delegation.started", data: { via: "ask", harness: "codex" } })).toEqual({
      text: "Asked Codex",
      detail: "running",
    });
    expect(eventWords({ type: "delegation.started", data: { via: "handoff", harness: "gemini-cli" } }).text).toBe(
      "You asked Gemini CLI",
    );
    expect(
      eventWords({ type: "delegation.ended", data: { to: "codex:t1", ok: true, ms: 125_000, relayed: "delivered" } }),
    ).toEqual({
      text: "Asked Codex",
      detail: "answered in 2 m · answer relayed here",
    });
    expect(
      eventWords({
        type: "delegation.ended",
        data: { harness: "codex", ok: false, ms: 40_000, error: "harness: gemini-cli is not installed here" },
      }).detail,
    ).toBe("failed after 40 s · harness: gemini-cli is not installed here");
  });
});

describe("groupTurns: subagents", () => {
  const agent = (over: Partial<AgentRun> = {}): AgentRun => ({
    id: "ag1",
    type: "Explore",
    description: "Check cache invalidation",
    callId: "c_launch",
    turnId: "t1",
    state: "done",
    startedAt: iso(2),
    lastAt: iso(30),
    tools: 2,
    toolErrors: 0,
    attributed: true,
    recentTools: [],
    ...over,
  });

  it("makes the launching call the head of the agent's block, in the spawning turn", () => {
    const ev = session();
    const turns = groupTurns(
      [
        ev("turn.started", 1, { turn_id: "t1" }),
        ev("tool.started", 2, { tool: "Agent", call_id: "c_launch", turn_id: "t1" }),
        ev("tool.ended", 3, { tool: "Agent", call_id: "c_launch", turn_id: "t1", ok: true }),
        ev("subagent.started", 3, { agent_id: "ag1", agent_type: "Explore" }),
        ev("tool.started", 4, { tool: "Grep", call_id: "c1", agent_id: "ag1", turn_id: "t1" }),
        ev("tool.ended", 5, { tool: "Grep", call_id: "c1", agent_id: "ag1", turn_id: "t1", ok: true }),
      ],
      [agent()],
    );
    const t1 = started(turns)[0]!;
    expect(t1.items.map((i) => i.kind)).toEqual(["agent"]);
    const block = t1.items[0]!;
    if (block.kind !== "agent") throw new Error("not an agent");
    expect(block.launch?.started?.data.call_id).toBe("c_launch");
    expect(block.launch?.ended?.data.call_id).toBe("c_launch");
    expect(block.started?.type).toBe("subagent.started");
    expect(block.tools).toHaveLength(1);
    expect(block.tools[0]!.ended?.data.tool).toBe("Grep");
  });

  it("homes a background agent's tools in its spawning turn, after that turn's Stop", () => {
    const ev = session();
    const turns = groupTurns(
      [
        ev("turn.started", 1, { turn_id: "t1" }),
        ev("subagent.started", 2, { agent_id: "ag1", agent_type: "Explore" }),
        ev("turn.ended", 3, { turn_id: "t1", reason: "stop" }),
        ev("turn.started", 10, { turn_id: "t2" }),
        // Claude Code stamps the spawning turn on the agent's tools.
        ev("tool.started", 11, { tool: "Read", call_id: "c2", agent_id: "ag1", turn_id: "t1" }),
        ev("tool.ended", 12, { tool: "Read", call_id: "c2", agent_id: "ag1", turn_id: "t1", ok: false }),
        ev("subagent.ended", 13, { agent_id: "ag1" }),
        ev("tool.started", 14, { tool: "Bash", call_id: "c3", turn_id: "t2" }),
      ],
      [agent({ callId: undefined })],
    );
    const [t1, t2] = started(turns);
    const block = t1!.items.find((i) => i.kind === "agent");
    if (block?.kind !== "agent") throw new Error("no agent block in turn 1");
    expect(block.tools.map((t) => t.ended?.data.ok)).toEqual([false]);
    expect(block.ended?.type).toBe("subagent.ended");
    // The second turn keeps only its own tool.
    expect(t2!.items.map((i) => (i.kind === "tool" ? i.started?.data.tool : i.kind))).toEqual(["Bash"]);
  });

  it("homes an agent by the summary's turn when its events name none", () => {
    const ev = session();
    const turns = groupTurns(
      [
        ev("turn.started", 1, { turn_id: "t1" }),
        ev("turn.ended", 2, { turn_id: "t1" }),
        ev("turn.started", 3, { turn_id: "t2" }),
        ev("tool.started", 4, { tool: "Grep", call_id: "c9", agent_id: "ag1" }),
      ],
      [agent({ callId: undefined })],
    );
    expect(started(turns)[0]!.items.some((i) => i.kind === "agent")).toBe(true);
    expect(started(turns)[1]!.items.some((i) => i.kind === "agent")).toBe(false);
  });
});
