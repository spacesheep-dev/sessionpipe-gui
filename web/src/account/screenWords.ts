// SPDX-License-Identifier: Apache-2.0
// Owned by: web. What the account's screens say for each state, apart from their React
// (ConnectAccount.tsx, AccountSettings.tsx, ApprovePhone.tsx, Machines), so each is tested on
// its own (screens.test.ts): how a connect ended, how the account stands, where this phone's
// key stands in a row and on Machines, and an ask's refusal. The sentences themselves are
// accountWords.ts's.
import type { ConnectStep } from "../native/accountConnect";
import { clock, MACHINES as M, NEW_WORDS as N, REUSED as R, SEND, ThisPhone, thisPhone } from "../native/accountWords";
import type { ApproveView } from "./approve";
import type { AccountView } from "./backend";
import type { HubError } from "./shell";

/** How a connect ended, in words: the title says what happened, the body the one next step.
 *  Where a key was made on spacesheep and is not kept here, that step is to revoke it, and the
 *  screen's button opens the page for it; with no such button (the page would be on another
 *  origin), the hub's own note is the line, as it says where. */
export function endedWords(s: Extract<ConnectStep, { kind: "ended" }>): { title: string; body: string } {
  const key = s.revokeUrl ? N.unusedKey : s.note;
  switch (s.why) {
    case "unreachable":
      return { title: R.unreachable(s.host), body: N.unreachableBody };
    case "wait":
      return { title: N.waitTitle, body: s.at ? N.waitAt(clock(s.at)) : N.waitSoon };
    case "busy":
      return { title: N.busyTitle, body: N.busyBody };
    case "denied":
      return { title: N.notConnected, body: N.deniedBody };
    case "declined":
      return { title: N.notConnected, body: key ?? "" };
    case "expired":
      return { title: N.expiredTitle, body: key ?? N.expiredBody };
    case "not-kept":
      return { title: N.notKeptTitle(thisPhone()), body: key ?? N.unexpectedBody };
    default:
      return { title: N.unexpectedTitle, body: N.unexpectedBody };
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

/** Where this phone's own key stands, in the few words a row has room for: the same short
 *  words every screen says it in (SEND). */
export function phoneLine(view: ApproveView | null): { mark: "ok" | "wait" | "warn"; words: string } | null {
  if (!view) return null;
  switch (view.phase.kind) {
    case "approved":
      return { mark: "ok", words: SEND.short.can };
    case "cooling":
      return {
        mark: "wait",
        words: view.phase.exact ? SEND.short.from(clock(view.phase.until)) : SEND.short.by(clock(view.phase.until)),
      };
    case "waiting":
      return { mark: "wait", words: SEND.short.waiting };
    case "dropped":
      return { mark: "warn", words: SEND.short.dropped };
    default:
      return { mark: "wait", words: SEND.short.notYet };
  }
}

/** Machines' one row for this phone, above the computers: a sentence and its mark (none
 *  while it is not approved: the row then is the sentence and, as `ask`, its way on, the
 *  words every place says it with), and whether it opens Approve this iPhone. `cannot`: why
 *  nothing can be signed here, when nothing can; that is the row then, and it opens nothing.
 *  `state` names the row for the page and its tests. */
export function phoneRow(
  view: ApproveView | null,
  cannot: string | null,
): { mark: "ok" | "wait" | "warn" | null; words: string; ask?: string; link: boolean; state: string } | null {
  if (cannot) return { mark: "warn", words: cannot, link: false, state: "cannot" };
  if (!view) return null;
  const p = view.phase;
  switch (p.kind) {
    case "idle":
    case "dropped":
      return {
        mark: null,
        words: N.notApproved(ThisPhone()),
        ask: N.approveThis(thisPhone()),
        link: true,
        state: p.kind,
      };
    case "waiting":
      return { mark: "wait", words: M.waiting, link: true, state: p.kind };
    case "cooling":
      return {
        mark: "wait",
        words: p.exact ? M.canFrom(ThisPhone(), clock(p.until)) : M.canBy(ThisPhone(), clock(p.until)),
        link: true,
        state: p.kind,
      };
    default: {
      // Approved: by every computer of the account, or only by some so far.
      const can = view.machines.filter((m) => m.state === "can").length;
      const all = view.machines.length;
      return can < all
        ? { mark: "wait", words: M.canSome(ThisPhone(), can, all), link: true, state: "some" }
        : { mark: "ok", words: M.can(ThisPhone()), link: true, state: p.kind };
    }
  }
}

/** What one computer's rows on Machines add about this phone, only where it is so: a
 *  sessionpipe there too old for a phone's key (whatever the phone's own state), or, once
 *  the phone is approved, a computer that has not approved it (the way on is Approve this
 *  iPhone). Nothing while the phone is not approved: Machines' own row says that once. */
export function machineNote(
  view: ApproveView | null,
  machineId: string,
): { mark: "wait" | "warn"; words: string; link: boolean } | null {
  const here = view?.machines.find((m) => m.id === machineId);
  if (!view || !here) return null;
  if (here.state === "old") return { mark: "warn", words: M.old, link: false };
  const approved = view.phase.kind === "approved" || view.phase.kind === "cooling";
  if (approved && here.state === "not-yet") return { mark: "wait", words: M.notHere, link: true };
  return null;
}

/** An ask's refusal, or a look's, in words; `elsewhere`: the way on is spacesheep itself.
 *  `at`: when the refusal came (a time it names is counted from then). */
export function approveError(e: HubError, at: number): { words: string; elsewhere: boolean } {
  if (e.code === "too_many_asks")
    return { words: N.approveTooMany(clock(at + (e.retryAfterS ?? 3600) * 1000)), elsewhere: false };
  if (e.code === "unreachable" || e.code === "timeout") return { words: R.unreachableNow, elsewhere: false };
  // No signer on this phone, or it would not hand over its key: its own reason.
  if (e.code === "unsupported" || e.code === "signer")
    return { words: N.approveCannot(e.message.replace(/\.$/, "")), elsewhere: true };
  // spacesheep's own sentence (its plan, a switch that is off there): as it wrote it, and
  // what it asks for is done there.
  const there = [e.code, e.upstream].some((c) => c === "refused" || c === "talk_off" || c === "pro_required");
  return { words: e.message || R.unreachableNow, elsewhere: there };
}
