// SPDX-License-Identifier: Apache-2.0
// The Node the GUI needs, in one place: package.json's `engines`, which is Vite's (the
// `npx github:` line builds the web app on the user's Node). server/cli.ts checks it
// before it starts, scripts/prepare.mjs before it builds. Plain JS with no imports, so it
// loads on any Node and an old one gets a sentence, not a stack trace. Working on the code
// needs 22.12 or later (Vitest); CI's Node comes from .nvmrc.

/** The range `^20.19.0 || >=22.12.0`, as a person reads it. */
export const NODE_FLOOR = "Node 22.12 or later, or Node 20 from 20.19 on";

/** Whether Node `version` ("22.12.0", "v20.19.1") is inside `^20.19.0 || >=22.12.0`. */
export function nodeSupported(version) {
  const [major = 0, minor = 0] = String(version)
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  if (major === 20) return minor >= 19;
  if (major === 22) return minor >= 12;
  return major > 22;
}
