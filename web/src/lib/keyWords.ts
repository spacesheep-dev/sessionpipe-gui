// SPDX-License-Identifier: Apache-2.0
// What a page says when the receiver refuses its key (a 401): the key it holds does not
// open the board, so the board's link is opened again. One set of words for every place
// that meets it: the whole page (components/KeyRefused.tsx), a send, an upload, a pairing,
// a device request, a workflow saved. The server's 401 page says the same (server/static.ts).

/** Inside a line, after "not sent · " and the like. */
export const KEY_LOST = "this page's key does not open the board: open the board's link again";

/** As a sentence of its own. */
export const KEY_LOST_SENTENCE =
  "This page's key does not open the board: open the board's link again from Connect on the computer this board runs on.";

/** The whole page's title and its one line, by where the page runs. */
export const KEY_REFUSED = {
  title: "Open the board's link again",
  browser:
    "The key this browser has does not open this board: on the computer this board runs on, open Connect, then open its link here or scan its QR code.",
  phone:
    "The key this phone has does not open this board: on the computer this board runs on, open Connect and scan its QR code with this app.",
  app: "The key this app has does not open this board: Receivers… opens the app's list of boards, where its link is added again.",
  scan: "Scan the code",
  receivers: "Receivers…",
  again: "Try again",
} as const;
