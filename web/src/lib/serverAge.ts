// SPDX-License-Identifier: Apache-2.0
// Owned by: web. In the app the page is the app's own, and the receiver it talks to can be
// older than it: the service on this computer still runs the version that installed it,
// or a receiver on another machine was never updated. An option that receiver is too old
// for then says so in one sentence, with the way to update it, instead of the receiver's
// own "HTTP 404". A page the receiver served itself is its own age and never says it.
import { compareVersions } from "@shared/version";

/** The receiver version that first has each option the page shows (CHANGELOG). */
export const SINCE = {
  /** Settings › Data › A spacesheep account: POST /api/ui/spacesheep (#88). */
  spacesheep: "0.7.5",
} as const;
export type Option = keyof typeof SINCE;

/** What the app's flag (window.sessionpipeShell) says that matters here. */
export interface ShellFlag {
  appVersion?: string;
  receiver?: { name?: string; origin?: string; local?: boolean } | null;
}
const flag = (): ShellFlag | null => (globalThis as { sessionpipeShell?: ShellFlag }).sessionpipeShell ?? null;

/** The one command that puts the app's version in place of the receiver on this computer:
 *  the GUI's release tarball through npx, as the app's own "Start sessionpipe" does. */
export const updateCommand = (appVersion: string): string =>
  `npx -y --package=https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v${appVersion}/sessionpipe-gui-${appVersion}.tgz -- sessionpipe-gui service install`;

export interface OlderReceiver {
  sentence: string;
  /** This computer's receiver: the app can update it (the "Update sessionpipe" button). */
  here: boolean;
  /** Shown under the sentence, to copy; absent where there is none to give. */
  command?: string;
}

/** Is a 404 the receiver's own "no such route" (its router's `{ reason: "not_found" }`),
 *  as against the app's proxy saying it knows no such receiver (plain text)? Only the
 *  first says the receiver is older. */
export const isRouteNotFound = (status: number, body: unknown): boolean =>
  status === 404 && !!body && typeof body === "object" && (body as { reason?: unknown }).reason === "not_found";

/** The words for an option the receiver (at `version`) is older than, in the app; null
 *  when there is nothing to say: not in the app, or not older. `notFound`: the receiver
 *  answered the option's route with its own 404, which says it is older whatever its
 *  version says (up to 0.8.0 that could be the new one while the old code answered; the
 *  version is then left out). `localOrigin`: the receiver the app's launch check found to
 *  be this computer's (its run.json names it); a loopback address alone is not enough,
 *  since a tunnel to another machine is one. */
export function olderReceiver(
  option: Option,
  version: string | undefined,
  opts: { notFound?: boolean; shell?: ShellFlag | null; localOrigin?: string | null } = {},
): OlderReceiver | null {
  const shell = opts.shell === undefined ? flag() : opts.shell;
  if (!shell) return null;
  const below = !!version && compareVersions(version, SINCE[option]) < 0;
  if (!below && !opts.notFound) return null;
  const is = below ? `is ${version}, which is older than this option` : "is older than this option";
  const origin = shell.receiver?.origin;
  const here = !!opts.localOrigin && !!origin && opts.localOrigin === origin;
  if (!here)
    return { sentence: `sessionpipe on ${shell.receiver?.name || "that machine"} ${is}. Update it there.`, here };
  const app = shell.appVersion ?? "";
  return { sentence: `sessionpipe on this computer ${is}.`, here, ...(app ? { command: updateCommand(app) } : {}) };
}
