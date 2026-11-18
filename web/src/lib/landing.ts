// SPDX-License-Identifier: Apache-2.0
// Where the app lands when it opens (Settings › General › Open on): the rule alone, apart
// from app.tsx, which reads the address and moves, so that a unit test can ask it.

/** The address the app was opened at. `asked`: the desktop app opened the window on a page
 *  a menu chose (apps/desktop, window.rs: its init script says so in the history state). */
export interface Opened {
  at: string;
  asked: boolean;
}

/** What `?new=1` brings along (control/NewSession.tsx, useNewFromUrl): they open the New
 *  session sheet over the page and leave the address. */
const SHEET_PARAMS = ["new", "machine", "harness", "cwd"];

/** A bare /: nothing after it, or only the New session sheet's parameters (the installed
 *  app's "New session" shortcut is `/?new=1`), which name a sheet and no page. Without
 *  `new=1` the other three stay in the address, and count. */
function bareRoot(at: string): boolean {
  if (at === "/") return true;
  if (!at.startsWith("/?")) return false;
  const q = new URLSearchParams(at.slice(2));
  if (q.get("new") !== "1") return false;
  for (const name of SHEET_PARAMS) q.delete(name);
  return q.toString() === "";
}

/** The app lands on Open on only when it was opened at a bare / that nobody asked for;
 *  tabs put back from the last visit don't count, nor does the New session sheet. Gives
 *  the page to land on, or null to stay: a key, the mock or a split in the address, and a
 *  menu's Go › Board, are all someone asking. */
export function landingFor(opened: Opened, page: string): string | null {
  return page !== "/" && bareRoot(opened.at) && !opened.asked ? page : null;
}
