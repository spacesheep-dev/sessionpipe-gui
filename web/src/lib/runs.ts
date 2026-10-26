// SPDX-License-Identifier: Apache-2.0
// What sessionpipe 0.10 says about a run beyond its state, as the lists word it: the
// background work its last turn left in flight (`turn.ended.background`), whether a person
// attends it (`session.attended`), and who submitted a turn (`turn.started.submitted_by`).
// Absent is unknown everywhere (PROTOCOL.md §3, §4): nothing here reads silence as a no.
import type { SessionSummary } from "@shared/api";

/** A finished unattended run this short is a probe or a script's one-shot: the board dims it. */
export const QUIET_RUN_MS = 60_000;

/** "waiting on 2 background tasks": the last turn ended with its own work still running,
 *  so the session is paused on it, not done. Null while a turn runs, or with none left. */
export function backgroundFact(s: Pick<SessionSummary, "background" | "currentTurn">): string | null {
  const n = s.currentTurn ? 0 : (s.background?.tasks ?? 0);
  return n > 0 ? `waiting on ${n} background task${n === 1 ? "" : "s"}` : null;
}

/** A run nobody attended (`attended: false`, never an absent one) that is over and lasted
 *  under a minute: drawn quiet on the board, and never a banner. */
export const quietRun = (s: Pick<SessionSummary, "attended" | "state" | "startedAt" | "lastAt">): boolean =>
  s.attended === false &&
  (s.state === "done" || s.state === "idle") &&
  Date.parse(s.lastAt) - Date.parse(s.startedAt) < QUIET_RUN_MS;

/** A turn's submitter in a person's words, when the harness said it was not the person
 *  (PROTOCOL.md §4: the harness's own word, kept as sent): "Scheduled", "Loop wake-up",
 *  "System". A person (`user`) or the SDK the machine delivers a message through (`sdk`)
 *  gets nothing; an unknown word is shown as it came. */
const SUBMITTED: Record<string, string> = {
  user: "",
  sdk: "",
  system: "System",
  loop_wakeup: "Loop wake-up",
  schedule_wakeup: "Scheduled",
  poll_event: "Poll event",
};
export function submittedLabel(by: unknown): string | undefined {
  if (typeof by !== "string" || !by) return undefined;
  const known = SUBMITTED[by];
  return known === undefined ? `Submitted by ${by}` : known || undefined;
}
