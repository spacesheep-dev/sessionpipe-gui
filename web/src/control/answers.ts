// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. Which open prompts have an answer out, read off the control
// activity: each answer's row names its prompt and decision (ControlActivity.answer), and
// the activity is the page's, so the session page, the Inbox, a toast, a row's menu and
// the badge agree, after a reload too, and no second answer goes. The surface an answer
// was pressed on also knows it by its own press (answersHere), against a receiver whose
// rows do not say which prompt they answered.
import type { Attention, ControlActivity } from "@shared/api";

/** What became of the answers to one open prompt. */
export type AnswerOut =
  /** An answer is on its way or its computer has it, until the prompt clears: which one. */
  | { status: "sent"; decision: "allow" | "deny" }
  /** The computer said the prompt is no longer open (answered elsewhere, or its hook let go). */
  | { status: "closed"; decision?: undefined };

export type AnswerStatus = AnswerOut["status"];

/** On its way, still being asked about, taken, or delivered: an answer the prompt has. */
const isOut = (a: ControlActivity): boolean =>
  !a.outcome || a.outcome === "taken" || a.outcome === "progress" || a.outcome === "delivered";

/** The computer no longer holds the prompt. */
const closes = (a: ControlActivity): boolean =>
  a.outcome === "expired" || (a.outcome === "refused" && (a.code === "no_attention" || a.code === "expired"));

/** The answers to `open` prompts, newest first: only those sent since the prompt was
 *  raised (a prompt asked again under the same id is a new one). Both times are on the
 *  receiver's clock: it stamps the answer's row, and a prompt's time is never later than
 *  its arrival there. On an account, a prompt read again from the relay has its
 *  computer's own time, so a computer whose clock runs far ahead can hide an answer sent
 *  that soon after the prompt. */
function answersTo(activity: readonly ControlActivity[], open: readonly Attention[]): ControlActivity[] {
  const raised = new Map(open.map((a) => [a.attentionId, Date.parse(a.at)]));
  return activity
    .filter((r) => {
      const at = r.answer && raised.get(r.answer.for);
      return r.kind === "permission.answer" && at !== undefined && !(Date.parse(r.at) < at);
    })
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Per open prompt with an answer out or closed, what became of it. An answer out wins
 *  over any other's end (a second answer is refused because of the first); else the
 *  computer saying the prompt is gone closes it. Any other end (failed, unsupported,
 *  refused for another reason, not sent) leaves the prompt open for another answer. */
export function answersOut(
  activity: readonly ControlActivity[],
  open: readonly Attention[],
): Readonly<Record<string, AnswerOut>> {
  const out: Record<string, AnswerOut> = {};
  for (const r of answersTo(activity, open)) {
    const { for: id, decision } = r.answer!;
    if (out[id]?.status === "sent") continue;
    if (isOut(r)) out[id] = { status: "sent", decision };
    else if (!out[id] && closes(r)) out[id] = { status: "closed" };
  }
  return out;
}

/** The newest answer to an open prompt that ended without reaching it, where nothing else
 *  is out for that prompt or closed it: the prompt takes an answer again, and this says
 *  why the last one did not go. */
export function answerEnded(
  activity: readonly ControlActivity[],
  open: readonly Attention[],
  answers: Readonly<Record<string, AnswerOut>>,
): ControlActivity | undefined {
  return answersTo(activity, open).find((r) => !answers[r.answer!.for] && !isOut(r) && !closes(r));
}

/** A press on one surface, for one prompt: the answer that went, with the row it made
 *  (`row`), or the computer refusing it as no longer open before any row was made. `at` is
 *  on the receiver's clock (the row's time, or the prompt's own), so a press for an
 *  earlier prompt under the same id says nothing of this one. */
export type Press = AnswerOut & { at: number; row?: string };

/** What the surface an answer was pressed on knows of the answers to its `open` prompts,
 *  and the answer that ended without reaching its prompt (answerEnded). The activity's
 *  word, with two things only this surface knows: a row its press made that does not say
 *  which prompt it answered (a receiver from before rows said it) answers that press's
 *  prompt, so what became of it is read as any row's; and a press whose row the activity
 *  does not have yet is out from the moment it went. */
export function answersHere(
  activity: readonly ControlActivity[],
  open: readonly Attention[],
  presses: Readonly<Record<string, Press>>,
): { answers: Readonly<Record<string, AnswerOut>>; ended?: ControlActivity } {
  const made = new Map<string, NonNullable<ControlActivity["answer"]>>();
  for (const [id, p] of Object.entries(presses))
    if (p.row && p.status === "sent") made.set(p.row, { for: id, decision: p.decision });
  const read =
    made.size === 0
      ? activity
      : activity.map((r) => {
          const answer = r.kind === "permission.answer" && !r.answer ? made.get(r.id) : undefined;
          return answer ? { ...r, answer } : r;
        });
  const answers: Record<string, AnswerOut> = { ...answersOut(read, open) };
  for (const a of open) {
    const p = presses[a.attentionId];
    if (!p || p.at < Date.parse(a.at) || answers[a.attentionId]?.status === "sent") continue;
    // Its row is in: that says what became of it.
    if (p.row && read.some((r) => r.id === p.row && r.answer)) continue;
    answers[a.attentionId] = p.status === "sent" ? { status: "sent", decision: p.decision } : { status: "closed" };
  }
  const ended = answerEnded(read, open, answers);
  return ended ? { answers, ended } : { answers };
}
