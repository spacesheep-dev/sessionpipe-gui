// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. Every sentence of the held-send notice (HeldNotice.tsx), in one
// place for the owner to read: the words are their own commit.
import { asSentence, cleanReason } from "@shared/reason";

export const HELD_WORDS = {
  /** The notice's first line. */
  title: "Confirm it's you to send this",
  /** When the receiver gave no reason. */
  noReason: "It needs a second look.",
  /** The button that confirms the one send; `signer` is signerLabel(): "your passkey",
   *  "Touch ID", "Face ID" or "your fingerprint". */
  confirm: (signer: string) => `Confirm with ${signer}`,
  /** The button while the confirm is under way. */
  confirming: "Confirming…",
  /** The button that lets the held send go; the words stay where they were typed. */
  drop: "Never mind",
  /** The title when the confirm was held too; `who` is heldFrom(). */
  still: (who: string) => `Still held. ${who} didn't take the confirmation.`,
  /** The label over the receiver's reason, which sits in its own box under it; `who` is
   *  heldFrom(). */
  says: (who: string) => `${who}:`,
  /** Who held it when it is this receiver itself (not a spacesheep a machine is reached through). */
  local: "This computer's sessionpipe",
  /** Where send errors show, when a hold arrived after the words it held were changed. */
  changed: "changed in flight",
  /** Show the held words whole, and back. */
  showAll: "all",
  showLess: "less",
};

/** Who held it, by name: the spacesheep's host, or this receiver. */
export const heldFrom = (host: string | null): string => host ?? HELD_WORDS.local;

/** The receiver's reason as one sentence, cleaned (shared/reason.ts): its first letter up,
 *  a full stop only after a letter or a digit. */
export function heldReason(why: string): string {
  const t = cleanReason(why);
  return t ? asSentence(`${t.charAt(0).toUpperCase()}${t.slice(1)}`) : HELD_WORDS.noReason;
}
