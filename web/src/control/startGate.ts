// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. Whether New session can start on a machine, or Ask another agent
// ask there, from this page: one state that both sheets read, so neither offers a Start that
// would only be refused. In the composer's order (useSend.ts answerState): the machine's own
// reasons first (not paired, an address or a page that can't sign, a sessionpipe too old for
// the key), then this device's: not approved at all (the sheet gives way to Approve this
// iPhone), approved and this machine has not added the key yet (off an account: does not
// trust it), inside the hour a new device waits where its end is known (approve.ts `exact`;
// the form stays, Start waits). Built on account/sendable.ts's state, so the sheets say what
// the composer, Machines and the Approve page say. Pure: startGate.test.ts.
import type { MachineControl } from "@shared/api";
import type { SendState } from "../account/sendable";
import { clock, SEND, START, ThisPhone, thisPhone } from "../native/accountWords";
import { deviceWords, machineTakes, signerKind, updateWords } from "./signer";
import { WRONG_ORIGIN } from "./words";

export type StartGate =
  /** This machine can't take one from here: `short` for its row in the picker, `long` the line
   *  under the form, `approve` when the way on is approving this device (/add-device). */
  | { kind: "machine"; short: string; long: string; approve?: boolean }
  /** This device isn't approved: nothing on the sheet could go, so the sheet is the way on. */
  | { kind: "approve" }
  /** Approved, inside its first hour, with the end known: `long` says from when. */
  | { kind: "cooling"; until: number; long: string };

/** Null where a start can go. `send`: this device and the machine (account/sendable.ts);
 *  `hint`: why the page can't sign, as signer.ts signHint says it. */
export function startGate(
  name: string,
  c: Pick<MachineControl, "keyTypes"> | undefined,
  o: { wrong: string | null; secure: boolean; hint: string; send: SendState },
): StartGate | null {
  const machine = (short: string, long: string, approve?: boolean): StartGate => ({
    kind: "machine",
    short,
    long,
    ...(approve ? { approve } : {}),
  });
  if (!c) return machine("not paired", `Pair ${name} from its terminal to start sessions there.`);
  if (o.wrong) return machine("can't sign from this address", WRONG_ORIGIN(o.wrong));
  const device = signerKind() === "device";
  if (!o.secure)
    return machine(
      device ? "can't sign here" : "can't sign from this address",
      `${o.hint.charAt(0).toUpperCase()}${o.hint.slice(1)}.`,
    );
  const s = o.send;
  if (!machineTakes(c) || s.kind === "old") return machine(START.old, updateWords(name));
  if (s.kind === "unapproved" || s.kind === "waiting") return { kind: "approve" };
  if (s.kind === "catching-up") {
    if (s.account) return machine(START.notHere, SEND.long.notHere(name, thisPhone()));
    return device
      ? machine(START.notHere, `${name} doesn't trust ${deviceWords().this} yet.`, true)
      : machine(
          `no passkey here that ${name} trusts`,
          `${name} trusts no passkey from this browser. Add this device from one it trusts.`,
        );
  }
  // Where the hour's end is only the latest it can be, the start goes and finds out: a
  // refusal makes the end known (account/doors.ts), and the sheet then waits for it.
  if (s.kind === "cooling" && s.exact)
    return { kind: "cooling", until: s.until, long: SEND.long.from(ThisPhone(), clock(s.until)) };
  return null;
}

/** A gate that holds the machine itself, not this device: its row is off in the picker. */
export const machineBlocked = (g: StartGate | null): boolean => g?.kind === "machine";
