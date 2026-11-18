// SPDX-License-Identifier: Apache-2.0
import "../native/test-env";
import type { ControlActivity, MachineControl, MachineSummary, SessionSummary } from "@shared/api";
import { afterEach, describe, expect, it } from "vitest";
import { approvalOf, sendState } from "../account/sendable";
import { answersOut } from "../control/answers";
import { answerState } from "../control/useSend";
import { markLate, openAttentions } from "../data/hooks";
import { answerWords, askableIds, cursorAfter, peekAttention, sessionMatch, whyText } from "./PaletteDialog";

describe("answerWords", () => {
  it("names a plan review's own pair, with no tool to allow", () => {
    const a = { kind: "permission", tool: "ExitPlanMode" };
    expect(answerWords(a, true)).toEqual({ verb: "Approve plan" });
    expect(answerWords(a, false)).toEqual({ verb: "Keep planning" });
  });
  it("names any other prompt's tool beside Allow and Deny", () => {
    expect(answerWords({ kind: "permission", tool: "run_shell_command" }, true)).toEqual({
      verb: "Allow",
      tool: "Shell",
    });
    expect(answerWords({ kind: "permission" }, false)).toEqual({ verb: "Deny", tool: "this" });
  });
});

describe("askableIds: the prompts the palette lists Allow and Deny for", () => {
  const AT = "2026-11-18T10:00:00Z";
  const at = Date.parse(AT);
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.sessionpipeShell;
  });
  /** The key this app signs with, and one made in a browser. */
  const own = { id: "k-app", alg: -7, spki: "app", name: "Mac app", createdAt: AT };
  const other = { ...own, id: "k-browser", name: "Browser" };
  const paired = (keys = [own]) =>
    ({ machineId: "m1", online: true, keys, queued: 0, keyTypes: ["passkey", "device"] }) as unknown as MachineControl;
  const answer = (o: Partial<ControlActivity>): ControlActivity => ({
    id: "01JD0",
    machineId: "m1",
    kind: "permission.answer",
    at: new Date(at + 2_000).toISOString(),
    expiresAt: new Date(at + 60_000).toISOString(),
    answer: { for: "a1", decision: "allow" },
    ...o,
  });
  /** The ids the palette would list for one Bash prompt on desk-pc, raised at AT: the rows
   *  as useOpenAttentions marks them, the gate as useSendGate builds it (their pure halves). */
  function ids(o: {
    control?: MachineControl;
    afterMs?: number;
    activity?: ControlActivity[];
    app?: boolean;
    tool?: string;
  }): string[] {
    // Inside the Mac app the device key signs (signer.ts signerKind); a browser has passkeys.
    if (o.app) g.sessionpipeShell = { platform: "macos" };
    else delete g.sessionpipeShell;
    const s = {
      key: "claude-code:s-1",
      harness: "claude-code",
      machine: "desk-pc",
      openAttentions: [{ attentionId: "a1", kind: "permission", tool: o.tool ?? "Bash", at: AT, answerable: true }],
    } as unknown as SessionSummary;
    const machines = new Map([["desk-pc", { name: "desk-pc", control: o.control } as MachineSummary]]);
    const now = at + (o.afterMs ?? 5_000);
    const rows = markLate(openAttentions(new Map([[s.key, s]])), machines, now);
    const answers = answersOut(
      o.activity ?? [],
      rows.map((r) => r.attention),
    );
    return [
      ...askableIds(rows, (r) => {
        const control = machines.get(r.session.machine ?? "")?.control;
        const sendable = sendState(null, control, [own], { keyKnown: true, secure: true, account: false });
        const approval = approvalOf(sendable, { device: !!o.app, keyKnown: true });
        const send = { rp: "localhost", secure: true, tap: false, answers, sendable, approval };
        return answerState(r.session, r.attention, control, send, now).off;
      }),
    ];
  }

  it("lists a fresh prompt on a paired machine that trusts this device", () => {
    expect(ids({ control: paired() })).toEqual(["a1"]);
    expect(ids({ control: paired(), app: true })).toEqual(["a1"]);
  });
  it("lists none for a machine that is not paired", () => {
    expect(ids({})).toEqual([]);
  });
  it("lists none in the app for a machine whose keys miss the app's key; a browser's passkeys turn nothing off", () => {
    expect(ids({ control: paired([other]), app: true })).toEqual([]);
    // A browser's list of its own passkeys misses synced ones (sendable.ts approvalOf).
    expect(ids({ control: paired([other]) })).toEqual(["a1"]);
  });
  it("lists none in the app for a sessionpipe too old for its key", () => {
    const old = { ...paired(), keyTypes: ["passkey"] } as unknown as MachineControl;
    expect(ids({ control: old, app: true })).toEqual([]);
    expect(ids({ control: old })).toEqual(["a1"]);
  });
  it("lists none for a Claude Code prompt past its two minutes", () => {
    expect(ids({ control: paired(), afterMs: 110_000 })).toEqual(["a1"]);
    expect(ids({ control: paired(), afterMs: 130_000 })).toEqual([]);
  });
  it("lists none once an answer is out in the activity, or its computer closed the prompt", () => {
    expect(ids({ control: paired(), activity: [answer({})] })).toEqual([]);
    expect(ids({ control: paired(), activity: [answer({ outcome: "delivered" })] })).toEqual([]);
    expect(ids({ control: paired(), activity: [answer({ outcome: "refused", code: "no_attention" })] })).toEqual([]);
    // An answer that failed on its way leaves the prompt open for another.
    expect(ids({ control: paired(), activity: [answer({ outcome: "failed" })] })).toEqual(["a1"]);
    // An answer to an earlier prompt under the same id says nothing of this one.
    expect(ids({ control: paired(), activity: [answer({ at: new Date(at - 5_000).toISOString() })] })).toEqual(["a1"]);
  });
  it("lists none for a question, which is answered on its computer", () => {
    expect(ids({ control: paired(), tool: "AskUserQuestion" })).toEqual([]);
  });
});

describe("cursorAfter: where the cursor goes when its row leaves the list", () => {
  const row = (id: string) => ({
    id,
    section: id.startsWith("a:") ? "Needs you" : id.startsWith("s:") ? "Sessions" : "Go to",
  });
  const list = (...ids: string[]) => ids.map(row);

  it("goes to the row of the session the row was about", () => {
    // "Allow Bash in one" was at 2; its pair left, and "Allow Bash in two" took its place.
    const rows = list("s:cc:two", "s:cc:one", "a:p2:Allow", "a:p2:Deny", "g:Board");
    expect(cursorAfter(rows, { at: 2, session: "cc:one" })).toBe(1);
    expect(rows[2]?.id).toBe("a:p2:Allow");
  });
  it("takes the row now in its place where the session is not listed", () => {
    expect(cursorAfter(list("s:cc:two", "s:cc:three", "g:Board"), { at: 1, session: "cc:one" })).toBe(1);
    expect(cursorAfter(list("s:cc:two", "g:Board"), { at: 1 })).toBe(1);
    // Past the end: the last row.
    expect(cursorAfter(list("s:cc:two", "g:Board"), { at: 5 })).toBe(1);
  });
  it("never lands on another prompt's Allow or Deny: the row before it, else the first one after", () => {
    expect(cursorAfter(list("s:cc:two", "a:p2:Allow", "a:p2:Deny", "g:Board"), { at: 1, session: "cc:one" })).toBe(0);
    expect(cursorAfter(list("a:p2:Allow", "a:p2:Deny", "g:Board"), { at: 0, session: "cc:one" })).toBe(2);
    expect(cursorAfter(list("a:p2:Allow", "a:p2:Deny"), { at: 0, session: "cc:one" })).toBe(-1);
    expect(cursorAfter([], { at: 0 })).toBe(-1);
  });
});

describe("peekAttention: what the preview says a row's session waits on", () => {
  const AT = "2026-11-18T10:00:00Z";
  const question = { attentionId: "q1", kind: "permission" as const, tool: "AskUserQuestion", at: AT };
  const bash = { attentionId: "p1", kind: "permission" as const, tool: "Bash", message: "npm ci", at: AT };
  const waits = { state: "needs_you" as const, openAttentions: [question, bash] };

  it("is the board row's prompt for a session that needs you, a question included", () => {
    expect(peekAttention({ session: waits })).toBe(question);
    expect(peekAttention({ session: { state: "needs_you", openAttentions: [bash] } })).toBe(bash);
  });
  it("is an Allow or Deny row's own prompt, not the session's first", () => {
    expect(peekAttention({ session: waits, attention: bash })).toBe(bash);
  });
  it("is nothing for a session that waits on nothing, a subagent's row, or a row about no session", () => {
    expect(peekAttention({ session: { state: "working", openAttentions: [] } })).toBeUndefined();
    expect(peekAttention({ session: { state: "idle", openAttentions: [] } })).toBeUndefined();
    expect(peekAttention({ session: waits, agent: { id: "a1" } })).toBeUndefined();
    expect(peekAttention({})).toBeUndefined();
  });
});

describe("whyText: the branch or the model as a row has room for it", () => {
  const BRANCH = "feature/webhook-retry-backoff";
  const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

  it("is whole where the match starts in its first 20 letters", () => {
    expect(whyText(BRANCH, range(8, 7))).toEqual({ text: BRANCH, at: range(8, 7) });
    expect(whyText("demo/webhook-backoff", range(13, 7))).toEqual({ text: "demo/webhook-backoff", at: range(13, 7) });
  });
  it("starts later, at a word, where the match is past that: the bold letters are in what is drawn", () => {
    const { text, at } = whyText(BRANCH, range(22, 7));
    expect(text).toBe("…retry-backoff");
    expect(at.map((i) => text[i]).join("")).toBe("backoff");
  });
  it("keeps to 20 letters where no word starts in reach", () => {
    const { text, at } = whyText("averyveryverylongbranchnamebackoff", range(27, 7));
    expect(text).toBe("…ngbranchnamebackoff");
    expect(at).toEqual(range(13, 7));
  });
  it("starts at the match where more than 20 letters follow it: the end is what is cut", () => {
    const { text, at } = whyText("users/dev/experiments/backoff-for-the-webhook-retry-queue", range(22, 7));
    expect(text).toBe("…backoff-for-the-webhook-retry-queue");
    expect(at).toEqual(range(1, 7));
  });
  it("is whole where a first word is in its start, though another is past the cut", () => {
    expect(whyText(BRANCH, [...range(0, 7), ...range(22, 7)]).text).toBe(BRANCH);
  });
});

describe("sessionMatch: a row shows its model once", () => {
  const s = {
    title: "Tidy the retry queue",
    machine: "lab-mac",
    repo: "github.com/acme/billing",
    branch: "main",
    model: "claude-fable-5-1",
  } as SessionSummary;
  // The fields: title, machine, repo, branch, the model as it reads, the model as it is named.
  const hits = (query: string) => sessionMatch(query, s)?.positions.map((p) => p.length);

  it("puts a word of the model on the form it reads in", () => {
    expect(hits("fable")).toEqual([0, 0, 0, 0, 5, 0]);
    expect(hits("fable 5.1")).toEqual([0, 0, 0, 0, 8, 0]);
  });
  it("puts every word on the model's name where one of them is only there", () => {
    expect(hits("claude")).toEqual([0, 0, 0, 0, 0, 6]);
    expect(hits("claude fable")).toEqual([0, 0, 0, 0, 0, 11]);
    expect(hits("tidy claude fable")).toEqual([4, 0, 0, 0, 0, 11]);
  });
  it("keeps the rank the words had on both forms", () => {
    expect(sessionMatch("claude fable", s)?.score).toBe(
      (sessionMatch("claude", s)?.score ?? 0) + (sessionMatch("fable", s)?.score ?? 0),
    );
  });
  it("leaves both where a word fits only the form it reads in", () => {
    expect(hits("claude 5.1")).toEqual([0, 0, 0, 0, 3, 6]);
  });
  it("is nothing where a word fits no field", () => {
    expect(sessionMatch("claude zebra", s)).toBeNull();
  });
});
