// SPDX-License-Identifier: Apache-2.0
// Owned by: web. A rule's run in words (sessionpipe triggers, CONTROL.md §14.9): the
// session's page says how the rule's run began ("Started by trigger card-todo",
// "Continued by …", or "Run by …" when the run's start was not read), and its card on the
// Board carries a short mark ("trigger card-todo"). The receiver sees only the rule's
// name, never the rule, so nothing links anywhere: the words say where the rule lives and
// how to see it there. Lineage, never authority: nothing reads this to allow, hide, group
// or sort anything.
import { type SessionSummary, TRIGGER_NAME_RE } from "@shared/api";

/** The card's mark is this lead and then the name: the lead is always drawn whole. */
export const TRIGGER_LEAD = "trigger ";

/** A name as text inside a sentence, isolated (U+2068 … U+2069): a computer's name that
 *  holds a direction mark cannot turn the sentence around it. */
const isolate = (s: string) => `⁨${s}⁩`;

export interface TriggerWords {
  /** The rule's name, as the run carried it. */
  name: string;
  /** What goes before the name on the page, always whole: "Started by trigger ". */
  lead: string;
  /** The line under the session's title: "Started by trigger card-todo". */
  sentence: string;
  /** Its tooltip: what ran it, where the rule lives and what a person can do there. */
  tip: string;
}

/** What the page and the card say of the rule that ran a session, or null when no rule
 *  did (or the name is not one a rule can have: the store keeps none such). The word is
 *  the store's (`triggeredFrom`): never "started" unless the run began the session. */
export function triggerWords(
  s: Pick<SessionSummary, "triggeredBy" | "triggeredFrom" | "machine">,
): TriggerWords | null {
  const name = s.triggeredBy;
  if (!name || !TRIGGER_NAME_RE.test(name)) return null;
  const where = s.machine?.trim() ? `on ${isolate(s.machine.trim())}` : "on this session's computer";
  const [verb, did] =
    s.triggeredFrom === "start"
      ? ["Started", "started this session"]
      : s.triggeredFrom === "continue"
        ? ["Continued", "continued this session"]
        : ["Run", "ran this session"];
  const lead = `${verb} by trigger `;
  return {
    name,
    lead,
    sentence: `${lead}${name}`,
    tip: `A rule named ${name} ${where} ${did}. Rules are made, paused and removed only at that computer. To see them there: sessionpipe trigger list`,
  };
}
