// SPDX-License-Identifier: Apache-2.0
// Owned by: platform. The curated extras: the official views and plugins from
// sessionpipe-gui-themes, by id. Every one of them ships inside the GUI (scripts/build.mjs
// copies them into dist/bundled/<kind>s/), so `sessionpipe-gui extras list` and the Views
// page's Extras list are the whole picture and `extras add` has nothing left to install.
// The npm name each would install from is kept for the day the packages are published;
// nothing reads it today. Sizes are the packages as packed at 0.2.0, rounded.
import type { ExtraEntry } from "../../shared/api.js";

export const EXTRAS: readonly ExtraEntry[] = [
  {
    id: "canvas",
    kind: "view",
    name: "Canvas",
    npm: "@sessionpipe-gui/theme-canvas",
    line: "Every live session as a window on an infinite canvas; the Map draws devices, accounts, machines and repos around them.",
    size: "44 kB",
    bundled: true,
  },
  {
    id: "office",
    kind: "view",
    name: "Office",
    npm: "@sessionpipe-gui/theme-office",
    line: "Every machine a room, every live session a person at a desk; posture is the state, amber marks who needs you.",
    size: "36 kB",
    bundled: true,
  },
  {
    id: "ping-a-human",
    kind: "plugin",
    name: "ping-a-human",
    npm: "@sessionpipe-gui/plugin-ping-a-human",
    line: "A Telegram message when a session needs you; Allow / Deny taps come back as suggestions you confirm with a passkey. Off until you enable it.",
    size: "27 kB",
    bundled: true,
  },
];

export function findExtra(id: string): ExtraEntry | undefined {
  return EXTRAS.find((e) => e.id === id);
}

/** The ones `extras add all` would install: everything that is not already in the
 *  package, which today is nothing. */
export function installableExtras(): ExtraEntry[] {
  return EXTRAS.filter((e) => !e.bundled);
}

/** One block per entry, for `extras list`. */
export function formatCatalog(installed: (e: ExtraEntry) => boolean): string {
  const lines = EXTRAS.map((e) => {
    const state = e.bundled ? "bundled" : installed(e) ? "installed" : "";
    const head = `${e.id.padEnd(18)} ${e.kind.padEnd(7)} ${e.name}${state ? `  [${state}]` : ""}`;
    return `${head}\n    ${e.line}\n    ${e.size}`;
  });
  return `${lines.join("\n")}\n`;
}
