// SPDX-License-Identifier: Apache-2.0
// The Handoff sheet's pure parts (handoff.ts): who may be asked and in what order, where
// the picker opens, the prefilled text, the signed command (`reply_to` only with the
// switch on, `from` never inside it), and the entry points' words.
import type { MachineControl } from "@shared/api";
import { describe, expect, it } from "vitest";
import { ControlError } from "../../control/api";
import { commandString } from "../../control/command";
import {
  askableSessions,
  askOff,
  canAskFrom,
  defaultTarget,
  handoffFields,
  handoffRefusalWords,
  lastReplyOf,
  parseTarget,
  prefillText,
  REPLY_CUT,
  targetValue,
} from "./handoff";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const me = { key: "claude-code:me", machine: "lab-mac" };
const sessions = [
  { key: "codex:old-done", harness: "codex", machine: "lab-mac", state: "done" as const, lastAt: at(25 * 60) },
  { key: "codex:idle", harness: "codex", machine: "lab-mac", state: "idle" as const, lastAt: at(120) },
  { key: "claude-code:me", harness: "claude-code", machine: "lab-mac", state: "working" as const, lastAt: at(1) },
  { key: "gemini-cli:busy", harness: "gemini-cli", machine: "lab-mac", state: "working" as const, lastAt: at(2) },
  { key: "codex:elsewhere", harness: "codex", machine: "build-box", state: "idle" as const, lastAt: at(3) },
  {
    key: "claude-code:kid",
    harness: "claude-code",
    machine: "lab-mac",
    state: "working" as const,
    lastAt: at(0),
    parentId: "me",
  },
  { key: "codex:done-today", harness: "codex", machine: "lab-mac", state: "done" as const, lastAt: at(60) },
];

describe("askableSessions", () => {
  it("the same machine, newest first, without itself, subagents, other machines, or old done ones", () => {
    expect(askableSessions(sessions, me, NOW).map((s) => s.key)).toEqual([
      "gemini-cli:busy",
      "codex:done-today",
      "codex:idle",
    ]);
  });
  it("nothing for a session with no machine", () => {
    expect(askableSessions(sessions, { key: "x:y" }, NOW)).toEqual([]);
  });
});

describe("defaultTarget", () => {
  const others = askableSessions(sessions, me, NOW);
  it("a new session of the first harness that is not the asker's own", () => {
    expect(
      defaultTarget({
        harnesses: ["claude-code", "codex", "gemini-cli"],
        selfHarness: "claude-code",
        sessions: others,
      }),
    ).toEqual({
      kind: "new",
      harness: "codex",
    });
  });
  it("the remembered agent first, while the hello still lists it", () => {
    const o = { harnesses: ["claude-code", "codex"], selfHarness: "claude-code", sessions: others };
    expect(defaultTarget({ ...o, remembered: "claude-code" })).toEqual({ kind: "new", harness: "claude-code" });
    expect(defaultTarget({ ...o, remembered: "goose" })).toEqual({ kind: "new", harness: "codex" });
  });
  it("the only harness even when it is the asker's own; else the newest session; else nobody", () => {
    expect(defaultTarget({ harnesses: ["claude-code"], selfHarness: "claude-code", sessions: others })).toEqual({
      kind: "new",
      harness: "claude-code",
    });
    expect(defaultTarget({ harnesses: [], selfHarness: "claude-code", sessions: others })).toEqual({
      kind: "session",
      key: "gemini-cli:busy",
    });
    expect(defaultTarget({ harnesses: [], selfHarness: "claude-code", sessions: [] })).toBeNull();
  });
  it("a target survives the picker's value", () => {
    for (const t of [{ kind: "new", harness: "codex" } as const, { kind: "session", key: "codex:a:b" } as const])
      expect(parseTarget(targetValue(t))).toEqual(t);
    expect(parseTarget("")).toBeNull();
    expect(parseTarget("h:")).toBeNull();
  });
});

describe("prefillText", () => {
  it("one line of ours, a rule, the reply", () => {
    expect(prefillText("The suite passed.")).toBe(
      "Give a second opinion on the reply below. Point out what you'd do differently and why.\n\n---\nThe suite passed.",
    );
  });
  it("empty with no reply, so the placeholder asks", () => {
    expect(prefillText(undefined)).toBe("");
    expect(prefillText("   \n")).toBe("");
  });
  it("cuts a long reply at 8 000 characters and says so on its own line", () => {
    const t = prefillText("x".repeat(REPLY_CUT + 10));
    expect(t.endsWith(`${"x".repeat(REPLY_CUT)}…\n(cut)`)).toBe(true);
  });
});

describe("lastReplyOf", () => {
  const s = { lastAssistant: "snippet", progress: { turn: 3, user: "q", assistant: "so far", at: at(0) } };
  it("the newest transcript's assistant text", () => {
    expect(
      lastReplyOf(s, [
        { type: "turn.transcript", data: { assistant: "first" } },
        { type: "tool.ended", data: {} },
        { type: "turn.transcript", data: { assistant: "second" } },
        { type: "turn.transcript", data: { assistant: "" } },
      ]),
    ).toBe("second");
  });
  it("else the running turn's reading, else the summary's snippet, else nothing", () => {
    expect(lastReplyOf(s, [])).toBe("so far");
    expect(lastReplyOf({ lastAssistant: "snippet" })).toBe("snippet");
    expect(lastReplyOf({})).toBe("");
  });
});

describe("handoffFields", () => {
  const base = { text: "Review this.", from: "claude-code:me", newId: "01ABC" };
  it("a prompt to a session, reply_to inside the signed bytes only with the switch on", () => {
    const on = handoffFields({ ...base, target: { kind: "session", key: "codex:idle" }, bringBack: true });
    expect(on).toEqual({ kind: "prompt", session: "codex:idle", text: "Review this.", replyTo: "claude-code:me" });
    const cmd = JSON.parse(commandString("m_lab", on)) as Record<string, unknown>;
    expect(Object.keys(cmd)).toEqual(["v", "t", "machine", "kind", "session", "text", "reply_to", "nonce", "iat"]);
    expect(cmd.reply_to).toBe("claude-code:me");
    expect(cmd.from).toBeUndefined();
    const off = handoffFields({ ...base, target: { kind: "session", key: "codex:idle" }, bringBack: false });
    expect(off).toEqual({ kind: "prompt", session: "codex:idle", text: "Review this." });
    expect(commandString("m_lab", off)).not.toContain("reply_to");
  });
  it("a start for a new session: cwd, then only the options given, then reply_to", () => {
    const f = handoffFields({
      ...base,
      target: { kind: "new", harness: "codex" },
      bringBack: true,
      cwd: "/Users/demo/code",
      permission: "safe",
      model: "gpt-5.4-codex",
    });
    expect(f).toEqual({
      kind: "start",
      session: "codex:01ABC",
      text: "Review this.",
      cwd: "/Users/demo/code",
      permission: "safe",
      model: "gpt-5.4-codex",
      replyTo: "claude-code:me",
    });
    const cmd = JSON.parse(commandString("m_lab", f)) as Record<string, unknown>;
    expect(Object.keys(cmd)).toEqual([
      "v",
      "t",
      "machine",
      "kind",
      "session",
      "text",
      "cwd",
      "permission",
      "model",
      "reply_to",
      "nonce",
      "iat",
    ]);
    const bare = handoffFields({ ...base, target: { kind: "new", harness: "codex" }, bringBack: false, cwd: "/x" });
    expect(bare).toEqual({ kind: "start", session: "codex:01ABC", text: "Review this.", cwd: "/x" });
  });
});

describe("the entry points", () => {
  const control = (extra: Partial<MachineControl> = {}): MachineControl => ({
    machineId: "m_lab",
    online: true,
    keys: [],
    queued: 0,
    ...extra,
  });
  it("askOff: unpaired, or a daemon that said neither ask nor handoff", () => {
    expect(askOff({ machine: "lab-mac" }, undefined)).toBe("Pair lab-mac to ask from here");
    expect(askOff({}, undefined)).toBe("Pair this machine to ask from here");
    expect(askOff({ machine: "lab-mac" }, control())).toBe("lab-mac needs a newer sessionpipe for this");
    expect(askOff({ machine: "lab-mac" }, control({ ask: false }))).toBeNull();
    expect(askOff({ machine: "lab-mac" }, control({ handoff: true }))).toBeNull();
  });
  it("canAskFrom: paired, a daemon that asks (as the menu item reads it), and a harness in the hello or another session there", () => {
    expect(canAskFrom(me, undefined, sessions, NOW)).toBe(false);
    // A 0.10 daemon (neither `ask` nor `handoff` in the hello): the menu item says what it
    // needs, and the strip's button is not shown either.
    expect(canAskFrom(me, control({ harnesses: ["codex"] }), [], NOW)).toBe(false);
    expect(canAskFrom(me, control({ harnesses: ["codex"], ask: true }), [], NOW)).toBe(true);
    expect(canAskFrom(me, control({ handoff: true }), sessions, NOW)).toBe(true);
    expect(canAskFrom(me, control(), [], NOW)).toBe(false);
  });
  it("handoffRefusalWords: the two refusals only a handoff meets", () => {
    expect(handoffRefusalWords(new ControlError(422, "refused", "handoff"), "lab-mac", true)).toBe(
      "Not sent: lab-mac didn't say it brings answers back. Turn the switch off to ask without that.",
    );
    expect(handoffRefusalWords(new ControlError(422, "refused", "bad_fields"), "lab-mac", true)).toMatch(
      /^Not sent: this receiver's sessionpipe is older/,
    );
    expect(handoffRefusalWords(new ControlError(422, "refused", "bad_fields"), "lab-mac", false)).toBeNull();
    expect(handoffRefusalWords(new ControlError(422, "refused", "folder"), "lab-mac", true)).toBeNull();
    expect(handoffRefusalWords(new Error("x"), "lab-mac", true)).toBeNull();
  });
});
