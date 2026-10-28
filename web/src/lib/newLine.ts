// SPDX-License-Identifier: Apache-2.0
// Where a session's "New" line goes: above the answer of the first turn that ended after
// the person last looked. The mark is taken once, when the session opens (the read mark,
// else the marks' `since`), so the line never moves while the page is open. A turn counts
// only when it is news under the same rule as the store's `newsAt`: one the person typed
// at the terminal of an attended session is theirs, not news. Pure, so it is unit-tested.
import type { Marks, SessionSummary } from "@shared/api";
import { isUnread } from "./marks";
import type { Turn } from "./turns";

/** Where the person left off in `s`, read as it opens: its read mark (else the marks'
 *  `since`) when it is unread, undefined when it is read, and null while the marks are not
 *  in yet (a cold open whose page came before the stream's snapshot), to be read again
 *  once they are rather than taken for read. An older server never sends them: no line. */
export function leftOff(
  s: Pick<SessionSummary, "key" | "state" | "attended" | "newsAt">,
  marks: Marks,
): string | undefined | null {
  if (!marks.since) return null;
  return isUnread(s, marks) ? (marks.read[s.key] ?? marks.since) : undefined;
}

export interface NewLineAt {
  /** The seq of the turn's `turn.ended`: a turn's `n` shifts when older pages load. */
  seq: number;
  /** What the line sits above: the turn's reply; with none, its failure; with neither
   *  (the reply still on its way), the end of its rows, where the reply will land. */
  above: "reply" | "failure" | "end";
}

const ms = (iso: string | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** The line for the loaded turns and the mark taken at open, or null: no mark (the
 *  session was read when it opened), no turn after it that is news, or no loaded turn that
 *  ended at or before it (the first ended turn is already after the mark). That is a
 *  session never looked at, where a line under the first prompt says nothing, or a mark
 *  older than the loaded page, where the first new turn may not be loaded and no line is
 *  better than a wrong one. `attended` is the session's, for turns whose own events don't say. */
export function newLinePlace(
  turns: readonly Turn[],
  mark: string | undefined,
  o: { attended?: boolean } = {},
): NewLineAt | null {
  const since = ms(mark);
  if (!Number.isFinite(since)) return null;
  let first = true;
  for (const t of turns) {
    const ended = t.items.find((i) => i.kind === "event" && i.e.type === "turn.ended");
    if (ended?.kind !== "event") continue;
    const at = ms(ended.e.arrivedAt);
    if (first && at > since) return null;
    first = false;
    if (!(at > since)) continue;
    const attended = ended.e.session.attended ?? t.start?.session.attended ?? o.attended;
    if (t.start?.data.submitted_by === "user" && attended === true) continue;
    const reply = t.items.some(
      (i) =>
        i.kind === "event" &&
        (i.e.type === "turn.transcript" || i.e.type === "turn.progress") &&
        String(i.e.data.assistant ?? "").trim() !== "",
    );
    const failed = String(ended.e.data.reason ?? "") === "error";
    return { seq: ended.e.session.seq, above: reply ? "reply" : failed ? "failure" : "end" };
  }
  return null;
}
