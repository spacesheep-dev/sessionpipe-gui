// SPDX-License-Identifier: Apache-2.0
// A start's folder as `~/…` (sessionpipe 0.10, CONTROL.md §3.1 `cwd`: no hello names the
// machine's home folder, so a receiver names a folder under it as `~` or `~/…` and the
// machine reads it under the home of the user its daemon runs as). Two things must take it:
// this receiver's own sessionpipe-core, whose verifier checks every command before it is
// queued (an older one wants an absolute `cwd`), and the machine: "a machine that sends
// `start` also takes a `~` folder"; any other (0.9) refuses one `bad_fields`. Feature
// detection, as devicekeys.ts does for device keys: nothing here assumes the core's
// version, it asks the core's own parser.
import * as core from "sessionpipe-core/control";

/** Does this receiver's core take a `~/…` folder on a start? */
export function coreTakesTilde(c: Pick<typeof core, "parseCommand" | "COMMAND_TYPE"> = core): boolean {
  const cmd = {
    v: 1,
    t: c.COMMAND_TYPE,
    machine: `m_${"a".repeat(22)}`,
    kind: "start",
    session: "claude-code:00000000-0000-4000-8000-000000000000",
    text: "x",
    cwd: "~/x",
    nonce: "A".repeat(22),
    iat: 1_700_000_000,
  };
  try {
    return c.parseCommand(JSON.stringify(cmd)).ok === true;
  } catch {
    return false;
  }
}

/** Whether a machine takes a `~/…` folder: its last hello carried `start`. */
export const machineTakesTilde = (m: { start?: unknown }): boolean => !!m.start;
