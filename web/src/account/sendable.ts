// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Whether this device can send to one computer, as one state that every
// screen which says so reads: the composer, New session, Ask another agent, Machines. On a
// spacesheep account spacesheep is the gate, so its device door decides (approve.ts's view:
// the phase, and the computer's own entry); the computer's key list is read only where the
// door has no entry for it. Off an account the key list decides, as it always has: a key
// this device holds among the ones the machine trusts. `sendWords` picks each state's
// words, which are accountWords.new.ts's SEND (the signer's own off an account). Tested on
// its own (sendable.test.ts).
import type { MachineControl } from "@shared/api";
import { useCallback } from "react";
import { useRpId } from "../control/hooks";
import { canSign, ownKeyKnown, updateWords, useOwnKeys } from "../control/signer";
import { clock, SEND, ThisPhone, thisPhone } from "../native/accountWords";
import type { ApproveView } from "./approve";
import { accountBackend } from "./current";
import { usePhone } from "./device";

export type SendState =
  /** It can send there. */
  | { kind: "can" }
  /** Approved, inside the hour a new device waits; `exact` as approve.ts's phase says. */
  | { kind: "cooling"; until: number; exact: boolean }
  /** Not approved: nothing asked, or (`dropped`) the request was removed or ran out. */
  | { kind: "unapproved"; dropped: boolean }
  /** A request is open on spacesheep; `code`: the number to type there, when this phone has it. */
  | { kind: "waiting"; code: string | null }
  /** This computer does not trust the key yet. On an account the phone is approved and the
   *  computer adds the key when it is next online; off one (`account: false`) the device
   *  is not approved on it. */
  | { kind: "catching-up"; account: boolean }
  /** The computer's sessionpipe predates device keys. */
  | { kind: "old" }
  /** Nothing can be signed on this page (signHint says why). */
  | { kind: "cannot-sign" }
  /** Not known yet: no machine, or the device's own key not read yet. Nothing is said. */
  | { kind: "unknown" };

/** What of a machine's control status the state reads. */
export type SendControl = Pick<MachineControl, "machineId" | "keys">;

const UNKNOWN: SendState = { kind: "unknown" };
const CAN: SendState = { kind: "can" };

/** `view`: the device door's word on an account (null before the first look, and off one).
 *  `own`: the keys this device holds; `keyKnown`: whether that list is the whole answer.
 *  `secure`: this page can sign at all. `account`: the window shows a spacesheep account. */
export function sendState(
  view: ApproveView | null,
  control: SendControl | undefined,
  own: readonly { id: string }[],
  o: { keyKnown: boolean; secure: boolean; account: boolean },
): SendState {
  if (!control) return UNKNOWN;
  if (!o.secure) return { kind: "cannot-sign" };
  const listed = control.keys.some((k) => own.some((m) => m.id === k.id));
  // Off an account, the key list. On one before the door's first word, the list may say
  // yes; it never says no, which only the door can.
  if (!o.account || !view) {
    if (listed) return CAN;
    return o.keyKnown && !o.account ? { kind: "catching-up", account: false } : UNKNOWN;
  }
  const p = view.phase;
  if (p.kind === "idle" || p.kind === "dropped") return { kind: "unapproved", dropped: p.kind === "dropped" };
  if (p.kind === "waiting") return { kind: "waiting", code: p.code };
  // Approved: whether this computer has the key yet, by the door's entry for it, else by its list.
  const here = view.machines.find((m) => m.id === control.machineId);
  if (here?.state === "old") return { kind: "old" };
  if (here ? here.state !== "can" : !listed) {
    // No entry, and the list read before the key was: nothing is known of this computer yet.
    return here || o.keyKnown ? { kind: "catching-up", account: true } : UNKNOWN;
  }
  return p.kind === "cooling" ? { kind: "cooling", until: p.until, exact: p.exact } : CAN;
}

/** `sendState` for any computer, from what this page knows now: drawn again as the signer,
 *  the device door and the rp id change. */
export function useSendStates(rp: string | null): (control: SendControl | undefined) => SendState {
  const own = useOwnKeys(rp);
  const { view } = usePhone();
  const secure = canSign(rp);
  const keyKnown = !!rp && ownKeyKnown(rp);
  const account = accountBackend() !== null;
  return useCallback(
    (control) => sendState(view, control, own, { keyKnown, secure, account }),
    [view, own, keyKnown, secure, account],
  );
}

/** `sendState` for one computer. */
export function useSendState(control: SendControl | undefined): SendState {
  return useSendStates(useRpId())(control);
}

/** A state in words, on an account: `short` for a row or a list, `long` for the one sentence
 *  where there is room, `approve` when the way on is "Approve this iPhone" (/add-device).
 *  Null where these words say nothing: it can't sign (the page's own line says why), nothing
 *  is known yet, or the key list's word off an account (the signer's own words say that). */
export function sendWords(
  s: SendState,
  machine: string,
): { short: string; long: string | null; approve: boolean } | null {
  switch (s.kind) {
    case "can":
      return { short: SEND.short.can, long: null, approve: false };
    case "cooling": {
      const t = clock(s.until);
      return s.exact
        ? { short: SEND.short.from(t), long: SEND.long.from(ThisPhone(), t), approve: false }
        : { short: SEND.short.by(t), long: SEND.long.by(ThisPhone(), t), approve: false };
    }
    case "unapproved":
      return {
        short: s.dropped ? SEND.short.dropped : SEND.short.notYet,
        long: SEND.long.notYet(ThisPhone()),
        approve: true,
      };
    case "waiting":
      return { short: SEND.short.waiting, long: SEND.long.notYet(ThisPhone()), approve: true };
    case "catching-up":
      return s.account
        ? { short: SEND.short.notHere, long: SEND.long.notHere(machine, thisPhone()), approve: false }
        : null;
    case "old":
      return { short: SEND.short.old, long: updateWords(machine), approve: false };
    default:
      return null;
  }
}
