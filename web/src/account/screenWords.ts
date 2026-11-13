// SPDX-License-Identifier: Apache-2.0
// Owned by: web. What the account's screens say for each state, apart from their React
// (ConnectAccount.tsx, AccountSettings.tsx, ApprovePhone.tsx), so each is tested on its own
// (screens.test.ts): how a connect ended, how the account stands, where this phone's key
// stands in a row, and an ask's refusal. The sentences themselves are accountWords.ts's.
import type { ConnectStep } from "../native/accountConnect";
import { clock, NEW_WORDS as N, REUSED as R, ThisPhone, thisPhone } from "../native/accountWords";
import type { ApproveView } from "./approve";
import type { AccountView } from "./backend";
import type { HubError } from "./shell";

/** How a connect ended, in words. Where a key was made on spacesheep and is not kept here,
 *  the hub's own note is the line: it says what to do about it. */
export function endedWords(s: Extract<ConnectStep, { kind: "ended" }>): { title: string; body: string } {
  switch (s.why) {
    case "unreachable":
      return { title: R.unreachable(s.host), body: N.unreachableBody(thisPhone()) };
    case "wait":
      return { title: N.waitTitle, body: s.at ? N.waitAt(clock(s.at)) : N.waitSoon };
    case "busy":
      return { title: N.notConnected, body: N.busyBody(thisPhone()) };
    case "denied":
      return { title: N.notConnected, body: N.deniedBody };
    case "declined":
      return { title: N.notConnected, body: s.note ?? "" };
    case "expired":
      return { title: N.expiredTitle, body: s.note ?? N.expiredBody };
    case "not-kept":
      return { title: N.notKeptTitle(thisPhone()), body: s.note ?? N.unexpectedBody };
    default:
      return { title: N.unexpectedTitle(s.host), body: N.unexpectedBody };
  }
}

/** The account's state as a mark and words. `again`: the key is refused or missing, and
 *  connecting again is what mends it. */
export function accountState(v: Pick<AccountView, "state" | "relay">): {
  mark: "ok" | "wait" | "warn";
  words: string;
  again: boolean;
} {
  if (v.state === "no_key") return { mark: "warn", words: N.stateNoKey(ThisPhone()), again: true };
  if (v.state === "unauthorized" || v.relay.state === "unauthorized")
    return { mark: "warn", words: N.stateRevoked, again: true };
  if (v.relay.state === "offline") return { mark: "wait", words: N.stateOffline, again: false };
  if (v.relay.state === "limited") return { mark: "wait", words: N.stateLimited, again: false };
  return { mark: "ok", words: N.stateOk, again: false };
}

/** Where this phone's own key stands, in the few words a row has room for. */
export function phoneLine(view: ApproveView | null): { mark: "ok" | "wait" | "warn"; words: string } | null {
  if (!view) return null;
  switch (view.phase.kind) {
    case "approved":
      return { mark: "ok", words: N.approveCanSend };
    case "cooling":
      return { mark: "wait", words: N.composerCooling(ThisPhone(), clock(view.phase.until)) };
    case "waiting":
      return { mark: "wait", words: N.approveWaiting };
    case "dropped":
      return { mark: "warn", words: N.approveDroppedTitle };
    default:
      return { mark: "wait", words: N.approveNotYet };
  }
}

/** An ask's refusal, or a look's, in words; `elsewhere`: the way on is spacesheep itself. */
export function approveError(e: HubError, now: number): { words: string; elsewhere: boolean } {
  if (e.code === "too_many_asks")
    return { words: N.approveTooMany(clock(now + (e.retryAfterS ?? 3600) * 1000)), elsewhere: false };
  if (e.code === "unreachable" || e.code === "timeout") return { words: R.unreachableNow, elsewhere: false };
  // No signer on this phone, or it would not hand over its key: its own reason.
  if (e.code === "unsupported" || e.code === "signer")
    return { words: N.approveCannot(e.message.replace(/\.$/, "")), elsewhere: true };
  // spacesheep's own sentence (its plan, a switch that is off there): as it wrote it, and
  // what it asks for is done there.
  const there = [e.code, e.upstream].some((c) => c === "refused" || c === "talk_off" || c === "pro_required");
  return { words: e.message || R.unreachableNow, elsewhere: there };
}
