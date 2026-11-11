// SPDX-License-Identifier: Apache-2.0
// What a turn said: never Claude Code's stand-in for a reply that never came, never the
// daemon's note that a turn was cancelled, and a stopped turn's words once, from the ack
// that carried them. The session is the one sessionpipe 0.13.4 was stopped on (2026-11-10,
// 3e846aae): a turn told to count to 1500, stopped at 144, then a one-word turn.
import type { StoredEvent } from "@shared/api";
import { describe, expect, it } from "vitest";
import { said, stoppedWords, turnWords } from "./replies";
import { groupTurns, sentTurns, turnPrompt } from "./turns";

const nums = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join("\n");
const count = (w: string) =>
  `Do not use any tools. Write the numbers 1 to 1500, one per line, and then on the last line just the word ${w} in capital letters`;
const word = (w: string) => `Reply with just the word ${w} in capital letters`;
const NOTE = "(The turn was cancelled.)";
const NONE = "No response requested.";

describe("said", () => {
  it("takes Claude Code's stand-in off, alone or after what the turn did write", () => {
    expect(said(NONE)).toBe("");
    expect(said(`${NONE}\n`)).toBe("");
    expect(said(`Reading the files first.\n\n${NONE}`)).toBe("Reading the files first.");
    expect(said("INDIAB")).toBe("INDIAB");
    // The same words inside a sentence are the agent's own.
    expect(said(`You wrote: ${NONE}`)).toBe(`You wrote: ${NONE}`);
    expect(said("")).toBe("");
  });
});

describe("stoppedWords", () => {
  it("knows the daemon's note at the end of what a stopped turn had written", () => {
    expect(stoppedWords(`1\n2\n3\n\n${NOTE}`)).toBe("1\n2\n3");
    expect(stoppedWords(NOTE)).toBe("");
    expect(
      stoppedWords(
        `half a sentence\n\n${NOTE}\n\n(Not allowed on this machine, since nobody was there to approve: Bash.)`,
      ),
    ).toBe("half a sentence\n\n(Not allowed on this machine, since nobody was there to approve: Bash.)");
  });

  it("an agent quoting the note, or going on after it, was not stopped", () => {
    expect(stoppedWords(`The log says ${NOTE}`)).toBeNull();
    expect(stoppedWords(`${NOTE}\n\nThat is the line the daemon adds.`)).toBeNull();
    expect(stoppedWords("Done.")).toBeNull();
    expect(stoppedWords("")).toBeNull();
  });
});

describe("turnWords", () => {
  it("a turn's own words are drawn once: the ack's reply only while it has none", () => {
    // The transcript holds every piece of text; the final ack's reply is the last piece.
    const whole = `I read all four files in order.\n\n${nums(120)}\nGOLF1`;
    expect(turnWords({ own: whole, reply: `${nums(120)}\nGOLF1`, final: true })).toEqual({
      own: whole,
      stopped: false,
    });
    // While it runs: what the acks streamed, until the turn's own reading has words.
    expect(turnWords({ own: "", reply: "1\n2\n3", final: false })).toEqual({ own: "", ack: "1\n2\n3", stopped: false });
    expect(turnWords({ own: "1\n2", reply: "1\n2\n3", final: false })).toEqual({ own: "1\n2", stopped: false });
    expect(turnWords({})).toEqual({ own: "", stopped: false });
  });

  it("a stopped turn says what it had written, once, and neither string", () => {
    const reply = `${nums(144)}\n\n${NOTE}`;
    // Right after the Stop: the hooks have the prompt and nothing after it.
    expect(turnWords({ own: "", reply, final: true })).toEqual({ own: "", ack: nums(144), stopped: true });
    // Once the session was resumed, an older sender's transcript says the stand-in…
    expect(turnWords({ own: NONE, reply, final: true })).toEqual({ own: "", ack: nums(144), stopped: true });
    // …and 0.13.5's sends the turn with nothing said and an end that says `interrupt`.
    expect(turnWords({ own: "", reply, final: true, reason: "interrupt" })).toEqual({
      own: "",
      ack: nums(144),
      stopped: true,
    });
    // The ack is all the turn wrote: the pieces the transcript kept are not drawn again.
    const kept = "Reading the files first.";
    expect(turnWords({ own: kept, reply: `${kept}\n\nThe first one is\n\n${NOTE}`, final: true })).toEqual({
      own: "",
      ack: `${kept}\n\nThe first one is`,
      stopped: true,
    });
  });

  it("stopped before its first word: no words at all, and it is still a stopped turn", () => {
    expect(turnWords({ own: NONE, reply: NOTE, final: true })).toEqual({ own: "", stopped: true });
    expect(turnWords({ reply: NOTE, final: true })).toEqual({ own: "", stopped: true });
    // A harness whose run does not stream: the note alone, and the transcript's pieces stand.
    expect(turnWords({ own: "Reading the files first.", reply: NOTE, final: true })).toEqual({
      own: "Reading the files first.",
      stopped: true,
    });
  });

  it("reads a stop from the turn's own record when no message from here began it", () => {
    // Stopped at its terminal (Esc): what it had said, and `interrupt`.
    expect(turnWords({ own: "SIX", reason: "interrupt" })).toEqual({ own: "SIX", stopped: true });
    // Its process was ended and it was resumed later: the stand-in, on an older sender.
    expect(turnWords({ own: `so far\n\n${NONE}` })).toEqual({ own: "so far", stopped: true });
    expect(turnWords({ own: NONE })).toEqual({ own: "", stopped: true });
    expect(turnWords({ own: "Done.", reason: "stop" })).toEqual({ own: "Done.", stopped: false });
  });

  it("a note in a reply that is still arriving is the agent's own words so far", () => {
    expect(turnWords({ reply: `The daemon adds\n\n${NOTE}`, final: false })).toEqual({
      own: "",
      ack: `The daemon adds\n\n${NOTE}`,
      stopped: false,
    });
  });
});

// The whole session, as the receiver held it: the hooks' events (an older sender: the
// stopped turns arrive saying the stand-in when the session is next resumed) and the four
// messages with their acks, ids and clocks as they were.
describe("the session sessionpipe 0.13.4 was stopped on", () => {
  let seq = 0;
  // A hook runs a tenth of a second after the prompt it reports was written down.
  const ev = (type: string, at: number, data: Record<string, unknown> = {}): StoredEvent => ({
    protocol: 1,
    id: `e${seq}`,
    type,
    time: new Date(at + 121).toISOString(),
    tier: 2,
    harness: { name: "claude-code" },
    session: { id: "3e846aae", seq: seq++ },
    privacy: { rulesets: [], pii: false },
    data,
    arrivedAt: new Date(at + 160).toISOString(),
    source: "http",
  });
  const t = (ms: number) => new Date(ms).toISOString();
  const events = [
    ev("turn.started", 1794361368961, { turn_id: "a" }),
    ev("turn.progress", 1794361368961, { turn: 0, user: count("indiaa"), assistant: "", at: t(1794361368961) }),
    // Stopped at 144; nothing more until the next message resumes the session.
    ev("turn.transcript", 1794361402970, { turn: 0, user: count("indiaa"), assistant: NONE, at: t(1794361368961) }),
    ev("turn.started", 1794361402970, { turn_id: "b" }),
    ev("turn.ended", 1794361410600, { turn_id: "b", reason: "stop" }),
    ev("turn.transcript", 1794361410600, { turn: 1, user: word("indiab"), assistant: "INDIAB", at: t(1794361402970) }),
    ev("turn.started", 1794361416546, { turn_id: "c" }),
    ev("turn.progress", 1794361416546, { turn: 2, user: count("indiac1"), assistant: "", at: t(1794361416546) }),
    ev("turn.transcript", 1794361428776, { turn: 2, user: count("indiac1"), assistant: NONE, at: t(1794361416546) }),
    ev("turn.started", 1794361428776, { turn_id: "d" }),
    ev("turn.ended", 1794361432800, { turn_id: "d", reason: "stop" }),
    ev("turn.transcript", 1794361432800, {
      turn: 3,
      user: word("indiac2"),
      assistant: "INDIAC2",
      at: t(1794361428776),
    }),
  ];
  const sent = [
    {
      id: "1026",
      at: t(1794361367440),
      text: count("indiaa"),
      reply: `${nums(144)}\n\n${NOTE}`,
      ackedAt: t(1794361376268),
    },
    { id: "1028", at: t(1794361401097), text: word("indiab"), reply: "INDIAB", ackedAt: t(1794361410702) },
    {
      id: "1030",
      at: t(1794361415021),
      text: count("indiac1"),
      reply: `${nums(448)}\n\n${NOTE}`,
      ackedAt: t(1794361427356),
    },
    // Queued behind the turn that was then stopped: it runs next, in order.
    { id: "1031", at: t(1794361422776), text: word("indiac2"), reply: "INDIAC2", ackedAt: t(1794361432886) },
  ].map((m) => ({ ...m, outcome: "delivered" }));

  it("draws each turn once, in order: the stopped ones with what they had written", () => {
    const turns = groupTurns(events).filter((x) => x.start);
    const joined = sentTurns(sent, turns);
    expect(sent.map((m) => joined.get(m.id))).toEqual(turns.map((x) => x.n));
    const drawn = turns.map((x, i) => {
      const own = [...x.items].reverse().find((it) => it.kind === "event" && it.e.type === "turn.transcript");
      const reason = x.items.find((it) => it.kind === "event" && it.e.type === "turn.ended");
      return {
        prompt: turnPrompt(x),
        ...turnWords({
          own: own?.kind === "event" ? own.e.data.assistant : undefined,
          reply: sent[i]!.reply,
          final: true,
          reason: reason?.kind === "event" ? reason.e.data.reason : undefined,
        }),
      };
    });
    expect(drawn).toEqual([
      { prompt: count("indiaa"), own: "", ack: nums(144), stopped: true },
      { prompt: word("indiab"), own: "INDIAB", stopped: false },
      { prompt: count("indiac1"), own: "", ack: nums(448), stopped: true },
      { prompt: word("indiac2"), own: "INDIAC2", stopped: false },
    ]);
    expect(JSON.stringify(drawn)).not.toMatch(/No response requested|The turn was cancelled/);
  });

  it("right after the first Stop, before the session is resumed", () => {
    // The hooks have the prompt and nothing after it: no end, no transcript.
    const turns = groupTurns(events.slice(0, 2)).filter((x) => x.start);
    expect(sentTurns(sent.slice(0, 1), turns).get("1026")).toBe(turns[0]!.n);
    expect(turnWords({ own: "", reply: sent[0]!.reply, final: true })).toEqual({
      own: "",
      ack: nums(144),
      stopped: true,
    });
  });
});
