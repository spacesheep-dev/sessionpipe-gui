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
 *  characters that are none of those (the braille blank, the Hangul fillers again). */
const INVISIBLE =
  /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}]/gu;
/** A run of combining marks past two: the rest would draw over the lines around it. */
const MARK_FLOOD = /(\p{M}{2})\p{M}+/gu;

/** The reason as one line of plain text: breaks become spaces, invisible characters go,
 *  at most two combining marks in a row, whitespace collapsed, at most `max` characters
 *  (an ellipsis where it was cut). */
export function cleanReason(s: unknown, max = 200): string {
  if (typeof s !== "string") return "";
  const t = s.replace(BREAKS, " ").replace(INVISIBLE, "").replace(MARK_FLOOD, "$1").replace(/\s+/g, " ").trim();
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  return `${chars
    .slice(0, max - 1)
    .join("")
    .replace(/\s+$/, "")}…`;
}

/** A full stop after words that end in a letter or a digit; anything else (a question
 *  mark, an ellipsis, a closing bracket) ends the sentence as it is. */
export function asSentence(s: string): string {
  return /[\p{L}\p{N}]$/u.test(s) ? `${s}.` : s;
}
