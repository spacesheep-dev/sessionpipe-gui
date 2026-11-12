// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. Every sentence of the held-send notice (HeldNotice.tsx), in one
// place for the owner to read: the words are their own commit.

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
};

/** The receiver's reason as one sentence: its first letter up, a full stop at the end. */
export function heldReason(why: string): string {
  const t = why.trim().replace(/[.\s]+$/, "");
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : HELD_WORDS.noReason;
}
