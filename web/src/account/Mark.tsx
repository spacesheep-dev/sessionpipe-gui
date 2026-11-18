// SPDX-License-Identifier: Apache-2.0
// Owned by: web. A state as its mark and its words (mark.css): how the account's screens
// (Settings › App, Approve this iPhone) and Machines on an account say where a thing stands.
// On its own so Machines draws it without the account's screens.
import "./mark.css";

export function Mark({ kind, children }: { kind: "ok" | "wait" | "warn"; children: string }) {
  return (
    <span className={`acct-state acct-state--${kind}`} data-state={kind}>
      {children}
    </span>
  );
}
