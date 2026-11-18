// SPDX-License-Identifier: Apache-2.0
import "../native/test-env";
import type { ControlActivity, MachineControl, MachineSummary, SessionSummary } from "@shared/api";
import { afterEach, describe, expect, it } from "vitest";
import { approvalOf, sendState } from "../account/sendable";
import { answersOut } from "../control/answers";
import { answerState } from "../control/useSend";
import { markLate, openAttentions } from "../data/hooks";
import { answerWords, askableIds, cursorAfter } from "./PaletteDialog";

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
