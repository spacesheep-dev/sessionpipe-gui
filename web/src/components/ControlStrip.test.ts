// SPDX-License-Identifier: Apache-2.0
import "../native/test-env";
import type { Attention, MachineControl, SessionSummary } from "@shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approvalOf, type SendState } from "../account/sendable";
import { answerState } from "../control/useSend";
import { markLate, openAttentions } from "../data/hooks";
import { ANSWER_WINDOW_MS, answerLate } from "../lib/answerWindow";
import { answerable, blockedAnswer, keepPlanning, shownCommand } from "./ControlStrip";
import { foldPlan } from "./PlanText";
import { answerItems } from "./SessionCard";

// Whether the window is a spacesheep account (lib/net.ts reads it once, from the shell).
const net = vi.hoisted(() => ({ account: false }));
vi.mock("../lib/net", async (actual) => ({
  ...(await actual<typeof import("../lib/net")>()),
  accountMode: () => net.account,
}));

describe("a shell prompt's command on its card", () => {
  // 139 characters; Claude Code's adapter puts the first 120 in the message, with no mark.
  const cmd =
    "rsync -av --delete --exclude .env ./dist/ deploy@staging.acme.dev:/srv/billing/next && ssh deploy@staging.acme.dev systemctl reload billing";
  const sent = { tool: "Bash", message: `Bash ${cmd.slice(0, 120)}` };
  it("is the whole command where the session sent the call's input (tier 3)", () => {
    expect(cmd).toHaveLength(139);
    expect(shownCommand(sent, "claude-code", { command: cmd })).toEqual({ cmd, cut: null });
  });
  it("ends in … and says it is the first 120 characters where it did not (tier 2)", () => {
    expect(shownCommand(sent, "claude-code", undefined)).toEqual({
      cmd: `${cmd.slice(0, 120)}…`,
      cut: "The machine sends the first 120 characters",
    });
    // A call that is not the one the message names is not taken for it.
    expect(shownCommand(sent, "claude-code", { command: "npm test" })?.cmd).toBe(`${cmd.slice(0, 120)}…`);
  });
  it("is whole as sent from another harness, and the server's cut at 200 is its own", () => {
    expect(shownCommand({ tool: "Bash", message: `Bash ${cmd}` }, "codex", undefined)).toEqual({ cmd, cut: null });
    const long = `Bash ${"a".repeat(195)}`;
    expect(shownCommand({ tool: "Bash", message: long }, "codex", undefined)).toEqual({
      cmd: `${"a".repeat(195)}…`,
      cut: "The machine sends the first 200 characters",
    });
    expect(shownCommand({ tool: "Bash", message: "npm test" }, "claude-code", undefined)).toEqual({
      cmd: "npm test",
      cut: null,
    });
  });
});

describe("keepPlanning", () => {
  it("says no to the plan with what the composer says should change", () => {
    expect(keepPlanning("perm-1", "  Use the existing cache\n")).toEqual({
      kind: "permission.answer",
      attentionId: "perm-1",
      allow: false,
      note: "Use the existing cache",
      // Its note is the composer's: a hold of it goes when the composer changes.
      composer: true,
    });
  });
  it("carries no note when the composer is empty", () => {
    const a = keepPlanning("perm-1", " \n ");
    expect(a).toEqual({ kind: "permission.answer", attentionId: "perm-1", allow: false, composer: true });
    expect("note" in a).toBe(false);
  });
});

describe("foldPlan", () => {
  it("folds a plan scrolled while it was whole back to its top", () => {
    const el = { style: { maxHeight: "" }, scrollTop: 250, clientHeight: 170, scrollHeight: 170 };
    expect(foldPlan(el as unknown as HTMLElement)).toBe(false);
    expect(el.scrollTop).toBe(0);
  });
});

describe("an answer inside the hour a newly approved phone waits", () => {
  const line = "This iPhone can send from 5:30 PM";
  it("the bar over Deny / Allow says the hour's own line, never that the page cannot sign", () => {
    expect(blockedAnswer(null, line)).toBe(line);
    // Any other block, and the wrong address, read as they did.
    expect(blockedAnswer(null)).toBe("this page cannot sign an answer");
    expect(blockedAnswer("https://elsewhere.example", line)).toBe("answer it where sending works");
  });
  it("a card's Allow and Deny are off with the same line: no button that will be refused", () => {
    const s = { key: "claude-code:s-1", machine: "studio-mac" } as SessionSummary;
    const a = { attentionId: "a1", kind: "permission", at: "2026-11-13T10:00:00Z", answerable: true } as Attention;
    const control = { machineId: "m1", keys: [], harnesses: {}, modes: [] } as unknown as MachineControl;
    const send = { rp: "spacesheep.dev", secure: true, tap: false, answers: {} };
    const now = Date.parse(a.at) + 5_000;
    const open = answerState(s, a, control, send, now);
    const cooling = answerState(s, a, control, { ...send, cooling: line }, now);
    expect(cooling).toMatchObject({ reason: line, off: true, tag: "blocked" });
    // Outside the hour the same prompt is as open as it was.
    expect(open.reason === line || open.tag === "blocked").toBe(false);
  });
});

describe("a prompt's answer window", () => {
  const AT = "2026-11-16T10:00:00Z";
  const at = Date.parse(AT);
  const claude = { key: "claude-code:s-1", harness: "claude-code", machine: "Misha-Petrov-laptop" } as SessionSummary;
  const codex = { ...claude, key: "codex:s-2", harness: "codex" } as SessionSummary;
  const prompt = { attentionId: "a1", kind: "permission", tool: "Bash", at: AT, answerable: true } as Attention;
  const base = { machineId: "m1", online: true, keys: [], queued: 0, keyTypes: ["passkey", "device"] };
  /** A computer reached through spacesheep, whose last_seen moves on every poll. */
  const remote = (lastHelloAt?: string) =>
    ({
      ...base,
      ...(lastHelloAt ? { lastHelloAt } : {}),
      remote: { via: "spacesheep", origin: "https://spacesheep.dev", rpId: "spacesheep.dev" },
    }) as MachineControl;
  const local = { ...base, lastHelloAt: AT } as MachineControl;
  const send = { rp: "spacesheep.dev", secure: true, tap: false, answers: {} };
  const after = (ms: number) => at + ms;
  const seen = (ms: number) => new Date(after(ms)).toISOString();

  it("is open at 30 s and 90 s on a computer spacesheep saw just now", () => {
    for (const ms of [30_000, 90_000]) {
      const st = answerState(claude, prompt, remote(seen(ms)), send, after(ms));
      expect(st, `${ms / 1000} s`).toEqual({ reason: null, off: false, status: undefined, tag: "open" });
      expect(answerLate(prompt, remote(seen(ms)), "claude-code", after(ms))).toBe(false);
    }
  });

  it("is open when spacesheep has no last_seen", () => {
    expect(answerState(claude, prompt, remote(), send, after(5_000)).tag).toBe("open");
  });

  it("is late once the hook let go, on a computer reached through spacesheep or here", () => {
    expect(ANSWER_WINDOW_MS).toBe(120_000);
    expect(answerLate(prompt, remote(), "claude-code", after(ANSWER_WINDOW_MS))).toBe(false);
    for (const control of [remote(seen(130_000)), local]) {
      expect(answerLate(prompt, control, "claude-code", after(130_000))).toBe(true);
      expect(answerState(claude, prompt, control, send, after(130_000))).toEqual({
        reason: "too late to answer from here; answer it on Misha-Petrov-laptop",
        off: true,
        status: undefined,
        tag: "late",
      });
    }
    // With no name: its computer.
    const nameless = { ...claude, machine: undefined } as SessionSummary;
    expect(answerState(nameless, prompt, local, send, after(130_000)).reason).toBe(
      "too late to answer from here; answer it on its computer",
    );
    // No word of pairing.
    expect(answerState(claude, prompt, remote(seen(720_000)), send, after(720_000)).reason).not.toMatch(/pair/);
  });

  it("is never late for another harness, or on an unpaired computer", () => {
    expect(answerLate(prompt, local, "codex", after(720_000))).toBe(false);
    expect(answerState(codex, prompt, local, send, after(720_000)).tag).toBe("open");
    expect(answerState(claude, prompt, undefined, send, after(720_000)).tag).toBe("unpaired");
  });

  it("while an account reads its history, a computer with no pairing yet is not called unpaired", () => {
    expect(answerState(claude, prompt, undefined, send, after(5_000))).toMatchObject({
      reason: "pair Misha-Petrov-laptop to send messages",
      tag: "unpaired",
    });
    expect(answerState(claude, prompt, undefined, { ...send, catching: true }, after(5_000))).toEqual({
      reason: null,
      off: true,
      status: undefined,
      tag: "blocked",
    });
  });

  it("says the hour a newly approved phone waits first", () => {
    const line = "This iPhone can send from 5:30 PM";
    expect(answerState(claude, prompt, remote(), { ...send, cooling: line }, after(130_000))).toMatchObject({
      reason: line,
      off: true,
      tag: "blocked",
      sentence: true,
    });
  });

  it("says which reasons are sentences of their own, and which are phrases after what they turn off", () => {
    // A phrase: not paired, a page that cannot sign, too late.
    expect(answerState(claude, prompt, undefined, send, after(5_000)).sentence).toBeUndefined();
    expect(answerState(claude, prompt, local, { ...send, secure: false }, after(5_000)).sentence).toBeUndefined();
    expect(answerState(claude, prompt, local, send, after(130_000)).sentence).toBeUndefined();
    // A sentence: a sessionpipe too old for the app's key.
    const g = globalThis as Record<string, unknown>;
    g.sessionpipeShell = { platform: "ios" };
    try {
      const old = { ...local, keyTypes: ["passkey"] } as MachineControl;
      expect(answerState(claude, prompt, old, send, after(5_000))).toMatchObject({
        reason: "Update sessionpipe on Misha-Petrov-laptop to send from the app",
        sentence: true,
      });
    } finally {
      delete g.sessionpipeShell;
    }
  });

  it("says a prompt the computer no longer holds was already answered, or timed out", () => {
    const closed = { ...send, answers: { a1: { status: "closed" as const } } };
    expect(answerState(claude, prompt, local, closed, after(5_000))).toMatchObject({
      reason: "already answered, or timed out",
      off: true,
      tag: "closed",
    });
  });

  it("says which answer is out, and what it waits for, in one line every surface shares", () => {
    const out = (decision: "allow" | "deny", a: Attention = prompt, control: MachineControl = local) =>
      answerState(claude, a, control, { ...send, answers: { a1: { status: "sent", decision } } }, after(5_000));
    expect(out("allow")).toEqual({
      reason: "Allowed · waiting for Misha-Petrov-laptop",
      off: true,
      status: "sent",
      tag: "sent",
      receipt: { what: "Allowed", text: "Allowed · waiting for Misha-Petrov-laptop" },
    });
    expect(out("deny").reason).toBe("Denied · waiting for Misha-Petrov-laptop");
    // A plan review's.
    const plan = { ...prompt, tool: "ExitPlanMode" };
    expect(out("allow", plan).receipt).toEqual({
      what: "Plan approved",
      text: "Plan approved · waiting for Misha-Petrov-laptop",
    });
    expect(out("deny", plan).reason).toBe("Asked for changes · waiting for Misha-Petrov-laptop");
    // Its computer offline: until it is back.
    expect(out("allow", prompt, { ...local, online: false }).reason).toBe(
      "Allowed · waiting for Misha-Petrov-laptop to come back",
    );
    // Its hook let go: late says so, not the receipt.
    const late = answerState(
      claude,
      prompt,
      local,
      { ...send, answers: { a1: { status: "sent", decision: "allow" } } },
      after(130_000),
    );
    expect(late.tag).toBe("late");
    expect(late.receipt).toBeUndefined();
  });

  it("offers nothing in a menu while an answer is out or the prompt closed", () => {
    for (const out of [{ status: "sent", decision: "allow" }, { status: "closed" }] as const) {
      const st = answerState(claude, prompt, local, { ...send, answers: { a1: out } }, after(5_000));
      expect(
        answerItems("Bash", st, () => {}),
        out.status,
      ).toEqual([]);
    }
    expect(answerItems("Bash", answerState(claude, prompt, local, send, after(5_000)), () => {})).toHaveLength(2);
  });

  it("leaves a late prompt out of the count", () => {
    const fresh = { ...prompt, attentionId: "a2", at: seen(100_000) };
    const machines = new Map([["Misha-Petrov-laptop", { name: "Misha-Petrov-laptop", control: local }]]);
    const rows = [
      { session: claude, attention: fresh, answerable: true },
      { session: claude, attention: prompt, answerable: true },
      { session: codex, attention: prompt, answerable: true },
    ];
    const count = (now: number) => markLate(rows, machines as never, now).filter((r) => r.answerable).length;
    expect(count(after(110_000))).toBe(3);
    // The same list while none has run out.
    expect(markLate(rows, machines as never, after(110_000))).toBe(rows);
    expect(
      markLate(rows, machines as never, after(130_000)).map((r) => [r.attention.attentionId, r.answerable, !!r.late]),
    ).toEqual([
      ["a2", true, false],
      ["a1", false, true],
      ["a1", true, false],
    ]);
    expect(count(after(130_000))).toBe(2);
    expect(count(after(230_000))).toBe(1);
  });

  it("leaves a question out of the count: it is answered on its computer, though its hook waits", () => {
    const question = {
      ...prompt,
      attentionId: "q1",
      tool: "AskUserQuestion",
      message: "AskUserQuestion",
      at: seen(1_000),
    } as Attention;
    const s = { ...claude, openAttentions: [question, prompt] } as SessionSummary;
    const rows = openAttentions(new Map([[s.key, s]]));
    expect(rows.map((r) => [r.attention.attentionId, r.answerable])).toEqual([
      ["q1", false],
      ["a1", true],
    ]);
    // The protocol's word is unchanged: the twin of a question is still told from it.
    expect(answerable(question)).toBe(true);
  });
});

describe("an answer from a device that is not approved, or that its computer has not added yet", () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.sessionpipeShell;
    net.account = false;
  });
  const AT = "2026-11-16T10:00:00Z";
  const now = Date.parse(AT) + 5_000;
  const s = { key: "claude-code:s-1", harness: "claude-code", machine: "Misha-Petrov-laptop" } as SessionSummary;
  const a = { attentionId: "a1", kind: "permission", tool: "Bash", at: AT, answerable: true } as Attention;
  // spacesheep's list of keys for the computer, without this phone's.
  const control = {
    machineId: "m1",
    online: true,
    keys: [{ id: "key-mac", alg: -7, addedAt: "" }],
    queued: 0,
    keyTypes: ["passkey", "device"],
  } as MachineControl;
  const send = { rp: "spacesheep.dev", secure: true, tap: false, answers: {} };
  const unapproved: SendState = { kind: "unapproved", dropped: false };
  const app = (s: SendState) => approvalOf(s, { device: true, keyKnown: true });

  it("the app's key, not approved: off with one reason, and nothing to press, not even in a menu", () => {
    g.sessionpipeShell = { platform: "ios" };
    net.account = true;
    for (const state of [unapproved, { kind: "waiting", code: "71" } as SendState]) {
      const st = answerState(s, a, control, { ...send, approval: app(state) }, now);
      expect(st).toEqual({
        reason: "This iPhone can't send yet",
        off: true,
        status: undefined,
        tag: "unapproved",
        approve: true,
        sentence: true,
      });
      expect(answerItems(a.tool, st, () => {})).toEqual([]);
    }
    // Off an account the sentence is the one it always was there (a Mac's, a browser's).
    net.account = false;
    g.sessionpipeShell = { platform: "macos" };
    expect(answerState(s, a, control, { ...send, approval: app(unapproved) }, now).reason).toBe(
      "This Mac can't answer yet",
    );
  });

  it("inside the hour a newly approved phone waits, the hour's line wins", () => {
    const line = "This iPhone can send from 5:30 PM";
    expect(answerState(s, a, control, { ...send, cooling: line, approval: app(unapproved) }, now)).toMatchObject({
      reason: line,
      off: true,
      tag: "blocked",
    });
  });

  it("approved, and the computer has not added the key yet: off with the computer's sentence, the pair kept, the way on Approve", () => {
    g.sessionpipeShell = { platform: "ios" };
    const st = answerState(s, a, control, { ...send, approval: app({ kind: "catching-up", account: true }) }, now);
    expect(st).toEqual({
      reason: "Misha-Petrov-laptop hasn't added this iPhone yet",
      off: true,
      status: undefined,
      tag: "blocked",
      approve: true,
      sentence: true,
    });
    expect(answerItems(a.tool, st, () => {})).toMatchObject([
      { label: "Allow Bash", disabled: st.reason },
      { label: "Deny Bash", disabled: st.reason },
    ]);
  });

  it("off an account, a computer that doesn't trust the app's key: its own words, as the composer's", () => {
    g.sessionpipeShell = { platform: "macos" };
    const untrusted: SendState = { kind: "catching-up", account: false };
    const st = answerState(s, a, control, { ...send, approval: app(untrusted), sendable: untrusted }, now);
    expect(st).toEqual({
      reason: "Misha-Petrov-laptop doesn't trust this Mac yet",
      off: true,
      status: undefined,
      tag: "unapproved",
      approve: true,
      sentence: true,
    });
    expect(answerItems(a.tool, st, () => {})).toEqual([]);
  });

  it("a browser's passkey is never turned off by its list, nor the app before its key is read", () => {
    for (const o of [
      { device: false, keyKnown: true },
      { device: true, keyKnown: false },
    ])
      expect(answerState(s, a, control, { ...send, approval: approvalOf(unapproved, o) }, now)).toEqual({
        reason: null,
        off: false,
        status: undefined,
        tag: "open",
      });
  });
});
