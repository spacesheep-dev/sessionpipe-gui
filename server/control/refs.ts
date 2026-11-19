// SPDX-License-Identifier: Apache-2.0
// Owned by: control. A session ref's shape, alone in its file: the store's readings
// (store/readings.ts) read a ref with the same rule, and the store's core must not pull in
// what control/parse.ts imports (the limits store's files, through it control's state and
// keys), since the core also runs in a page (store/core.ts). parse.ts re-exports it.

/** `<harness>:<session id>`. */
export const SESSION_REF = /^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$/;
