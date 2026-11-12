// SPDX-License-Identifier: Apache-2.0
// A receiver's reason, as the page may show it: someone else's words (spacesheep's second
// look, a machine's refusal), so plain text only. One function cleans every reason on
// every path, on the server as it is passed on (server/control/ui.ts) and in the page as it
// is shown (web/src/control/command.ts, heldWords.ts).

/** Control characters (a newline among them, and the line and paragraph separators)
 *  become a space; bidi controls and zero-width characters, which could make the words
 *  read other than they are, go. Built from code points, so the source holds none of them. */
const range = (a: number, b: number): string => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`;
const one = (a: number): string => String.fromCodePoint(a);
const CONTROL = new RegExp(`[${range(0x00, 0x1f)}${range(0x7f, 0x9f)}${one(0x2028)}${one(0x2029)}]`, "g");
const INVISIBLE = new RegExp(
  `[${one(0x061c)}${one(0x180e)}${range(0x200b, 0x200f)}${range(0x202a, 0x202e)}${range(0x2060, 0x2069)}${one(0xfeff)}]`,
  "g",
);

/** The reason as one line of plain text: controls and invisible characters out,
 *  whitespace collapsed, at most `max` characters (an ellipsis where it was cut). */
export function cleanReason(s: unknown, max = 200): string {
  if (typeof s !== "string") return "";
  const t = s.replace(CONTROL, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
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
