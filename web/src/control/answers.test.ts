// SPDX-License-Identifier: Apache-2.0
import type { Attention, ControlActivity, ControlOutcome } from "@shared/api";
import { describe, expect, it } from "vitest";
import { answerEnded, answersHere, answersOut, type Press } from "./answers";

const RAISED = "2026-11-17T10:00:00.000Z";
const prompt: Attention = { attentionId: "perm-1", kind: "permission", tool: "Bash", at: RAISED, answerable: true };
let n = 0;
/** An answer's row, `ms` after the prompt was raised (ids grow, as a ULID's do). */
const row = (
  o: { outcome?: ControlOutcome; code?: string; decision?: "allow" | "deny"; ms?: number; for?: string } = {},
  extra: Partial<ControlActivity> = {},
): ControlActivity => {
  const at = new Date(Date.parse(RAISED) + (o.ms ?? 5_000)).toISOString();
  return {
    id: `01J${String(n++).padStart(8, "0")}`,
    machineId: "m_laptop0123456789abcd",
    kind: "permission.answer",
    session: "claude-code:s-1",
    at,
    expiresAt: at,
    text: o.decision ?? "allow",
    answer: { for: o.for ?? "perm-1", decision: o.decision ?? "allow" },
    ...(o.outcome ? { outcome: o.outcome } : {}),
    ...(o.code ? { code: o.code } : {}),
    ...extra,
  };
};
const of = (...rows: ControlActivity[]) => answersOut(rows, [prompt])["perm-1"];

describe("answersOut: which open prompts have an answer out", () => {
  it("an answer on its way, still asked about, taken or delivered is out, with its decision", () => {
    expect(of(row())).toEqual({ status: "sent", decision: "allow" });
    expect(of(row({ decision: "deny" }))).toEqual({ status: "sent", decision: "deny" });
    expect(of(row({}, { unheard: { state: "asking" } }))).toEqual({ status: "sent", decision: "allow" });
    expect(of(row({ outcome: "taken" }))?.status).toBe("sent");
    // The computer has it and the prompt is still listed: out until the prompt clears.
    expect(of(row({ outcome: "delivered" }))?.status).toBe("sent");
  });

  it("an answer out wins over a second one's refusal", () => {
    const first = row({ outcome: "delivered" });
    const second = row({ outcome: "refused", code: "no_attention", decision: "deny" });
    expect(of(second, first)).toEqual({ status: "sent", decision: "allow" });
  });

  it("the computer saying the prompt is gone closes it", () => {
    expect(of(row({ outcome: "refused", code: "no_attention" }))).toEqual({ status: "closed" });
    expect(of(row({ outcome: "refused", code: "expired" }))).toEqual({ status: "closed" });
    expect(of(row({ outcome: "expired" }))).toEqual({ status: "closed" });
  });

  it("any other end leaves the prompt open for another answer", () => {
    expect(of(row({ outcome: "failed" }))).toBeUndefined();
    expect(of(row({ outcome: "unsupported" }))).toBeUndefined();
    expect(of(row({ outcome: "refused", code: "grant" }))).toBeUndefined();
    expect(of(row({ outcome: "unconfirmed" }))).toBeUndefined();
    expect(of(row({ outcome: "failed" }, { unheard: { state: "unsent", status: 422 } }))).toBeUndefined();
  });

  it("an answer to an earlier prompt under the same id, or to a prompt not open, says nothing", () => {
    // Sent before this prompt was raised: the same command asked again in the same turn.
    expect(of(row({ outcome: "delivered", ms: -30_000 }))).toBeUndefined();
    expect(answersOut([row({ for: "perm-2" })], [prompt])).toEqual({});
    // A row with no answer on it (a kept row from before the rows said it), or another kind.
    expect(of(row({}, { answer: undefined }))).toBeUndefined();
    expect(of(row({}, { kind: "prompt" }))).toBeUndefined();
  });
});

describe("answerEnded: why the last answer did not go", () => {
  it("is the newest answer that ended without reaching the prompt, while nothing else is out", () => {
    const refused = row({ outcome: "refused", code: "grant" });
    expect(answerEnded([refused], [prompt], {})).toBe(refused);
    // Another answer out, or the prompt closed: nothing to say.
    expect(answerEnded([refused], [prompt], { "perm-1": { status: "sent", decision: "deny" } })).toBeUndefined();
    const out = row();
    expect(answerEnded([out, refused], [prompt], answersOut([out, refused], [prompt]))).toBeUndefined();
    expect(answerEnded([row({ outcome: "refused", code: "no_attention" })], [prompt], {})).toBeUndefined();
  });
});

describe("answersHere: what the surface that pressed knows", () => {
  /** This surface's press for perm-1: the row it made, at that row's time. */
  const pressed = (r: ControlActivity, decision: "allow" | "deny" = "allow"): Record<string, Press> => ({
    "perm-1": { status: "sent", decision, at: Date.parse(r.at), row: r.id },
  });
  /** A receiver from before rows said which prompt they answered. */
  const older = (r: ControlActivity): ControlActivity => ({ ...r, answer: undefined });

  it("is out from the moment it went, before its row is in", () => {
    const r = row();
    expect(answersHere([], [prompt], pressed(r)).answers).toEqual({ "perm-1": { status: "sent", decision: "allow" } });
  });

  it("reads its own row as this prompt's where the row does not say so", () => {
    const of = (r: ControlActivity) => answersHere([older(r)], [prompt], pressed(r));
    expect(of(row()).answers["perm-1"]).toEqual({ status: "sent", decision: "allow" });
    expect(of(row({ outcome: "delivered", decision: "deny" })).answers["perm-1"]).toEqual({
      status: "sent",
      decision: "allow",
    });
    expect(of(row({ outcome: "refused", code: "no_attention" })).answers["perm-1"]).toEqual({ status: "closed" });
    // Refused for another reason: Allow and Deny back, and why.
    const refused = row({ outcome: "refused", code: "grant" });
    const here = answersHere([older(refused)], [prompt], pressed(refused));
    expect(here.answers).toEqual({});
    expect(here.ended).toMatchObject({ id: refused.id, answer: { for: "perm-1", decision: "allow" } });
  });

  it("read for one prompt (a list row, a banner), another prompt's refused answer says nothing of it", () => {
    const other: Attention = { ...prompt, attentionId: "perm-2" };
    const refused = row({ outcome: "refused", code: "grant" });
    // Read for the session's prompts, the refusal is perm-1's, said once...
    expect(answersHere([refused], [prompt, other], {}).ended).toBe(refused);
    // ...and perm-2's row, which reads its own prompt only, has nothing to say.
    expect(answersHere([refused], [other], {})).toEqual({ answers: {} });
  });

  it("leaves a row that says what it answered, and rows it did not make, as they are", () => {
    const refused = row({ outcome: "refused", code: "grant" });
    expect(answersHere([refused], [prompt], pressed(refused))).toEqual({ answers: {}, ended: refused });
    // A row from an older receiver that no press here made: nothing says whose it is.
    expect(answersHere([older(row())], [prompt], {})).toEqual({ answers: {} });
  });

  it("a press for an earlier prompt under the same id says nothing", () => {
    const r = row({ ms: -30_000 });
    expect(answersHere([older(r)], [prompt], pressed(r))).toEqual({ answers: {} });
  });

  it("a press the computer refused as no longer open, before any row, closes the prompt as raised", () => {
    const closed: Record<string, Press> = { "perm-1": { status: "closed", at: Date.parse(prompt.at) } };
    expect(answersHere([], [prompt], closed).answers).toEqual({ "perm-1": { status: "closed" } });
    // The same id raised again later: a new prompt.
    const again = { ...prompt, at: new Date(Date.parse(RAISED) + 60_000).toISOString() };
    expect(answersHere([], [again], closed).answers).toEqual({});
  });
});
