// SPDX-License-Identifier: Apache-2.0
// Where the app lands when it opens (Settings › General › Open on): the rule alone, apart
// from app.tsx, which reads the address and moves, so that a unit test can ask it.

/** The address the app was opened at. `asked`: the desktop app opened the window on a page
 *  a menu chose (apps/desktop, window.rs: its init script says so in the history state). */
export interface Opened {
  at: string;
  asked: boolean;
}

/** The app lands on Open on only when it was opened at a bare / that nobody asked for;
 *  tabs put back from the last visit don't count. Gives the page to land on, or null to
 *  stay: a key, the mock or a split in the address, and a menu's Go › Board, are all
 *  someone asking. */
export function landingFor(opened: Opened, page: string): string | null {
  return page !== "/" && opened.at === "/" && !opened.asked ? page : null;
}
