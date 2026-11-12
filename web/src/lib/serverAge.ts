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
  receiver?: { name?: string; local?: boolean } | null;
}
const flag = (): ShellFlag | null => (globalThis as { sessionpipeShell?: ShellFlag }).sessionpipeShell ?? null;

/** The one command that puts the app's version in place of the receiver on this computer:
 *  the GUI's release tarball through npx, as the app's own "Start sessionpipe" does. */
export const updateCommand = (appVersion: string): string =>
  `npx -y --package=https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v${appVersion}/sessionpipe-gui-${appVersion}.tgz -- sessionpipe-gui service install`;

export interface OlderReceiver {
  sentence: string;
  /** Shown under the sentence, to copy; absent where there is none to give. */
  command?: string;
}

/** The words for an option the receiver (at `version`) is older than, in the app; null
 *  when there is nothing to say: not in the app, or not older. `notFound`: the receiver
 *  answered the option's route with a 404, which says it is older whatever its version. */
export function olderReceiver(
  option: Option,
  version: string | undefined,
  opts: { notFound?: boolean; shell?: ShellFlag | null } = {},
): OlderReceiver | null {
  const shell = opts.shell === undefined ? flag() : opts.shell;
  if (!shell) return null;
  const older = opts.notFound === true || (!!version && compareVersions(version, SINCE[option]) < 0);
  if (!older) return null;
  const is = version ? `is ${version}, which is older than this option` : "is older than this option";
  if (shell.receiver && shell.receiver.local === false) {
    return { sentence: `sessionpipe on ${shell.receiver.name || "that machine"} ${is}. Update it there.` };
  }
  const app = shell.appVersion ?? "";
  if (!app) return { sentence: `sessionpipe on this computer ${is}. Update it, or reopen the app.` };
  return {
    sentence: `sessionpipe on this computer ${is}. Update it with this command, or reopen the app:`,
    command: updateCommand(app),
  };
}
