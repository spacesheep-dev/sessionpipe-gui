// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. Which open prompts have an answer out, read off the control
// activity: each answer's row names its prompt and decision (ControlActivity.answer), and
// the activity is the page's, so the session page, the Inbox, a toast, a row's menu and
// the badge agree, after a reload too, and no second answer goes.
import type { Attention, ControlActivity } from "@shared/api";

export type AnswerStatus = "sent" | "closed";

/** What became of the answers to one open prompt. */
export interface AnswerOut {
  /** "sent": an answer is on its way or its computer has it, until the prompt clears;
   *  "closed": the computer said the prompt is no longer open (answered elsewhere, or its
   *  hook let go). */
  status: AnswerStatus;
  /** The answer that went, where it is known. */
  decision?: "allow" | "deny";
}

/** On its way, still being asked about, taken, or delivered: an answer the prompt has. */
const isOut = (a: ControlActivity): boolean =>
  !a.outcome || a.outcome === "taken" || a.outcome === "progress" || a.outcome === "delivered";

/** The computer no longer holds the prompt. */
const closes = (a: ControlActivity): boolean =>
  a.outcome === "expired" || (a.outcome === "refused" && (a.code === "no_attention" || a.code === "expired"));

/** The answers to `open` prompts, newest first: only those sent since the prompt was
 *  raised (a prompt asked again under the same id is a new one). */
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
    const id = r.answer!.for;
    if (out[id]?.status === "sent") continue;
    if (isOut(r)) out[id] = { status: "sent", decision: r.answer!.decision };
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
