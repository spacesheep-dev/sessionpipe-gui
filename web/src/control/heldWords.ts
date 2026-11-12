// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. Every sentence of the held-send notice (HeldNotice.tsx), in one
// place for the owner to read: the words are their own commit.

export const HELD_WORDS = {
  /** The notice's first line. */
  title: "held",
  /** When the receiver gave no reason. */
  noReason: "held",
  /** The button that confirms the one send; `signer` is signerLabel(). */
  confirm: (signer: string) => `confirm (${signer})`,
  /** The button while the confirm is under way. */
  confirming: "confirming",
  /** The button that lets the held send go. */
  drop: "drop",
};

/** The receiver's reason as one sentence: its first letter up, a full stop at the end. */
export function heldReason(why: string): string {
  const t = why.trim().replace(/[.\s]+$/, "");
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : HELD_WORDS.noReason;
}
