// SPDX-License-Identifier: Apache-2.0
// A receiver's reason, as the page may show it: someone else's words (spacesheep's second
// look, a machine's refusal), so plain visible text only. One function cleans every reason
// on every path, on the server as it is passed on (server/control/ui.ts) and in the page as
// it is shown (web/src/control/command.ts, heldWords.ts). What survives is letters, marks
// (at most two in a row), numbers, punctuation, symbols and plain spaces (reason.test.ts
// passes every code point through it).
//
// The patterns are written with \p{…} and \u{…} escapes and the u flag, so the source
// holds none of the characters they name.

/** Control characters (a newline among them) and the line and paragraph separators:
 *  each becomes a space, so words on two lines stay two words. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
/** What draws nothing, or nothing a reader can check: format characters (bidi controls,
 *  zero-width, tags, the soft hyphen, interlinear annotation), private use, unassigned
 *  code points, surrogates, everything Unicode calls default-ignorable (variation
 *  selectors, the Hangul fillers, U+034F, U+17B4/5, U+1D173-1D17A), and the blank-looking
 *  characters that are none of those (the braille blank, the Hangul fillers again, the
 *  Khitan filler U+16FE4, the null notehead U+1D159, SignWriting's fill and rotation
 *  modifiers U+1DA9B-1DA9F and U+1DAA1-1DAAF). */
const INVISIBLE =
  /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}\u{16FE4}\u{1D159}\u{1DA9B}-\u{1DA9F}\u{1DAA1}-\u{1DAAF}]/gu;
/** A run of combining marks past two: the rest would draw over the lines around it. */
const MARK_FLOOD = /(\p{M}{2})\p{M}+/gu;

/** As many characters as a machine's daemon may write as an ack's `detail` (sessionpipe
 *  `control/daemon.ts` cuts it there), which is also what spacesheep keeps of a job's note. */
export const NOTE_MAX = 500;

/** Outside text as one line of what can be seen: breaks become spaces, invisible characters
 *  go, at most two combining marks in a row, whitespace collapsed. Read no further than
 *  `max * 8` UTF-16 units, so megabytes are cleaned no further than they could be shown
 *  (even every character dropped or doubled leaves enough), and never half a surrogate
 *  pair. `cut` says the text was longer than what was read. */
function plainLine(s: string, max: number): { text: string; cut: boolean } {
  const room = max * 8;
  let head = s.length > room ? s.slice(0, room) : s;
  const last = head.charCodeAt(head.length - 1);
  if (head.length < s.length && last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  const text = head.replace(BREAKS, " ").replace(INVISIBLE, "").replace(MARK_FLOOD, "$1").replace(/\s+/g, " ").trim();
  return { text, cut: head.length < s.length };
}

/** The reason as one line of plain text: breaks become spaces, invisible characters go,
 *  at most two combining marks in a row, whitespace collapsed, at most `max` characters
 *  (an ellipsis where it was cut, however short it cleans). For words a person reads;
 *  what the page reads a value out of goes through `cleanNote`. */
export function cleanReason(s: unknown, max = 200): string {
  if (typeof s !== "string") return "";
  const { text: t, cut } = plainLine(s, max);
  const chars = Array.from(t);
  if (chars.length <= max && !cut) return t;
  if (chars.length < max) return `${t}…`;
  return `${chars
    .slice(0, max - 1)
    .join("")
    .replace(/\s+$/, "")}…`;
}

/** A job's note as a row carries it to the page: the same plain line, whole up to what a
 *  daemon may send (`NOTE_MAX`), and past that cut with nothing put in its place. The page
 *  reads values out of a note (a `login.begin`'s is "<pending id> <URL>",
 *  web/src/lib/pool.ts), so no character is ever added to one: what it ends in is what its
 *  sender wrote. */
export function cleanNote(s: unknown, max = NOTE_MAX): string {
  if (typeof s !== "string") return "";
  const { text } = plainLine(s, max);
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("").trimEnd();
}

/** A full stop after words that end in a letter or a digit; anything else (a question
 *  mark, an ellipsis, a closing bracket) ends the sentence as it is. */
export function asSentence(s: string): string {
  return /[\p{L}\p{N}]$/u.test(s) ? `${s}.` : s;
}
