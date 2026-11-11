// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. A machine paired on a spacesheep account (docs/rfcs/08) takes
// commands signed for that receiver's rp id, not this one's: the store notes each
// machine's `control.remote` as it arrives, and the signer asks here before it signs.
import type { MachineControl } from "@shared/api";

const byMachine = new Map<string, string>();

/** Remember where a machine's commands are signed for (nothing for a local machine). */
export function noteMachineControl(c: MachineControl | undefined): void {
  if (!c) return;
  if (c.remote?.rpId) byMachine.set(c.machineId, c.remote.rpId);
  else byMachine.delete(c.machineId);
}

/** The rp id a command to `machineId` is signed for, when it is not this receiver's. */
export function remoteRpFor(machineId: string): string | undefined {
  return byMachine.get(machineId);
}
