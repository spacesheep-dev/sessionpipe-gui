// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The feed cursor: event time and arrival number, opaque to the
// client, as base64url. Written without Node's Buffer so the store's core runs in a page
// too (store/core.ts), and read as Buffer read it: cursor.test.ts holds the two to the
// same answer for any string.

const ALPHABET = /[A-Za-z0-9+/_-]/;

/** `${t}.${no}` as base64url without padding. The text is ASCII, so btoa's base64 is
 *  Buffer's, with base64url's two characters in place of `+` and `/`. */
export const encodeCursor = (r: { t: number; no: number }): string =>
  btoa(`${r.t}.${r.no}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** base64 or base64url to a byte string, the way Node's Buffer decodes it: a character
 *  outside both alphabets is skipped (Node reads only a character's low byte, so it is
 *  taken the same way here), the first `=` ends the text, and a lone last character is
 *  dropped. atob alone throws on all three. */
function decodeBase64url(c: string): string {
  let s = "";
  for (let i = 0; i < c.length; i++) {
    const ch = String.fromCharCode(c.charCodeAt(i) & 0xff);
    if (ch === "=") break;
    if (!ALPHABET.test(ch)) continue;
    s += ch === "-" ? "+" : ch === "_" ? "/" : ch;
  }
  if (s.length % 4 === 1) s = s.slice(0, -1);
  return atob(s + "==".slice(0, (4 - (s.length % 4)) % 4));
}

export const decodeCursor = (c: string): { t: number; no: number } | null => {
  // Digits and a dot are ASCII, so a byte string matches exactly where Buffer's UTF-8
  // reading of the same bytes did.
  const m = /^(\d+)\.(\d+)$/.exec(decodeBase64url(c));
  return m ? { t: Number(m[1]), no: Number(m[2]) } : null;
};
