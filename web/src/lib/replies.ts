// SPDX-License-Identifier: Apache-2.0
// What a turn said, read from the two records of it: the transcript its machine's hooks
// sent (every piece of text, joined) and the reply the machine's acks carried for the
// message that began it (the last piece; for a turn that was stopped, all it had written).
// Two strings in those records are nobody's words: Claude Code's stand-in for a reply that
// never came, and the daemon's note that a turn was cancelled. Neither is ever drawn as
// what the agent said; both say the turn was stopped. Pure, so all of it is unit-tested.

/** Claude Code's own stand-in (model `<synthetic>`) for the reply of a turn that ended
 *  before it had one: written when the session is next resumed, so a stopped turn arrives
 *  saying it. sessionpipe 0.13.5 no longer sends it; older senders did, and stored events
 *  hold it. */
const NO_REPLY = "No response requested.";

/** The daemon's note at the end of what a turn it was told to stop had written
 *  (sessionpipe's CANCELLED_NOTE, CONTROL.md §6 `cancel`), and the head of its note of what
 *  nobody was there to approve, which may follow. */
const CANCELLED_NOTE = "(The turn was cancelled.)";
const DENIED_HEAD = "(Not allowed on this machine";

/** A turn's text without Claude Code's stand-in, alone or as the last paragraph after what
 *  the turn did write. The same words inside a sentence are the agent's own. */
export function said(text: string): string {
  const t = text.replace(/\s+$/, "");
  if (t === NO_REPLY) return "";
  const cut = t.length - NO_REPLY.length;
  if (cut > 0 && t.slice(cut) === NO_REPLY && /\n\s*$/.test(t.slice(0, cut)))
    return t.slice(0, cut).replace(/\s+$/, "");
  return text;
}

/** The words of a turn that was stopped, from the reply its machine acked: what it had
 *  written, without the daemon's note ("" for a turn stopped before its first word). Null
 *  for any other reply: an agent quoting the note, or going on after it, was not stopped. */
export function stoppedWords(reply: string): string | null {
  const s = reply.replace(/\s+$/, "");
  const i = s.lastIndexOf(CANCELLED_NOTE);
  if (i < 0 || (i > 0 && s.charAt(i - 1) !== "\n")) return null;
  const rest = s.slice(i + CANCELLED_NOTE.length).replace(/^\s+/, "");
  if (rest && !rest.startsWith(DENIED_HEAD)) return null;
  const before = s.slice(0, i).replace(/\s+$/, "");
  return rest ? (before ? `${before}\n\n${rest}` : rest) : before;
}

export interface TurnWords {
  /** The turn's own words as they are drawn: its transcript's (else the running turn's
   *  reading), without the stand-in. Empty when it has none, or when `ack` stands for them. */
  own: string;
  /** The reply the machine's acks carried, drawn in the reply's place: while the turn has
   *  no words of its own, or, for a stopped turn, as all it wrote. Never the daemon's note. */
  ack?: string;
  /** The turn was stopped: by a Stop sent from a page (the ack says so), at its terminal
   *  (its end says `interrupt`), or its process was ended (the stand-in is there). */
  stopped: boolean;
}

/** What a turn said and whether it was stopped. `own` is its transcript's or its progress's
 *  `assistant`; `reply` the reply on the message sent from here that became it, and
 *  `final` whether that message's last ack is in (only then is a note at the reply's end
 *  the daemon's); `reason` its `turn.ended`'s. A stopped turn's reply is the daemon's own
 *  reading of everything the turn wrote, so it stands for the transcript's (which holds
 *  only the pieces that were whole) wherever it has words. */
export function turnWords(o: { own?: unknown; reply?: string; final?: boolean; reason?: unknown }): TurnWords {
  const raw = typeof o.own === "string" ? o.own : "";
  const own = said(raw).trim() ? said(raw) : "";
  const cut = o.final && o.reply !== undefined ? stoppedWords(o.reply) : null;
  const stopped = cut !== null || o.reason === "interrupt" || (raw.trim() !== "" && said(raw).trim() !== raw.trim());
  if (cut !== null) return cut.trim() ? { own: "", ack: cut, stopped } : { own, stopped };
  return { own, ...(o.reply?.trim() && !own ? { ack: o.reply } : {}), stopped };
}
