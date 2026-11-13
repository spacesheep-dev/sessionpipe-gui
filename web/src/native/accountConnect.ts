// SPDX-License-Identifier: Apache-2.0
// Connecting a spacesheep account on the phone (docs/rfcs/08, "The phone on an account"):
// the steps a person goes through, apart from the React (ConnectAccount.tsx) and the shell
// (account/shell.ts ConnectCalls). The hub does the connecting: it asks spacesheep for a
// code, opens the confirm page itself, polls, holds an approval until the person answers
// its question here, and says where the connect stands (`acct_connect_start`'s answer, the
// `account` event, `acct_status`). This file turns what the hub says into the screen to
// show and, where a connect ended, into why. No sentence lives here (accountWords.ts).
// Tested on its own (accountConnect.test.ts).
import { ownUrl } from "../account/outside";
import { type ConnectView, hubError } from "../account/shell";

/** Where the hub connects when no origin is named. */
export const DEFAULT_ORIGIN = "https://spacesheep.dev";

/** Why a connect did not end in an account, as the person's next step differs:
 *  - `unreachable`: spacesheep could not be reached;
 *  - `wait`: too many tries, or spacesheep asked to wait (`at`: when to try again, if known);
 *  - `busy`: another of the hub's questions is open on this phone;
 *  - `denied`: refused on spacesheep's page;
 *  - `declined`: refused here, in the hub's own question (a key was made there);
 *  - `expired`: nobody confirmed in time;
 *  - `not-kept`: approved, and this phone could not keep the account;
 *  - `unexpected`: an answer this version cannot use. */
export type Ended = "unreachable" | "wait" | "busy" | "denied" | "declined" | "expired" | "not-kept" | "unexpected";

export type ConnectStep =
  /** What this is, before anything is asked of spacesheep (a start is one of three an hour). */
  | { kind: "intro" }
  | { kind: "starting" }
  /** A connect was under way when the app opened: the hub is asked where it stands. */
  | { kind: "resuming" }
  /** The number to compare; `opened` once the confirm page was handed to the browser. */
  | { kind: "number"; host: string; digits: string; opened: boolean }
  /** Approved on spacesheep; the hub's question is on this phone. */
  | { kind: "asking"; host: string; digits?: string }
  /** The account is kept: the shell is asked to show it. */
  | { kind: "opening"; host: string; receiver: string }
  /** `digits`: the number of the connect that ended, so an older word of the same connect
   *  (still "pending") that arrives late is known for what it is. */
  | { kind: "ended"; why: Ended; host: string; at?: number; note?: string; revokeUrl?: string; digits?: string };

export type ConnectEvent =
  /** Continue on the intro; Try again where a connect ended. */
  | { type: "go" }
  /** What the hub says of the connect: a start's answer, the `account` event, a status read.
   *  `accounts`: the ids of the accounts on this phone, when the hub said them too. */
  | { type: "connect"; connect: ConnectView | null; accounts?: readonly string[] }
  /** `acct_connect_start` (or showing the account) was refused. */
  | { type: "refused"; error: unknown; now: number }
  /** The confirm page was handed to the browser. */
  | { type: "opened" }
  /** Back to the start (a connect was cancelled). */
  | { type: "reset" };

export const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
};

/** A start's refusal, as why. Null: the person's own no (to the hub's question about a
 *  server that is not spacesheep.dev), which is not a failure to show. */
export function refusedWhy(error: unknown): Ended | null {
  switch (hubError(error).code) {
    case "cancelled":
      return null;
    case "unreachable":
      return "unreachable";
    case "too_many_starts":
    case "rate_limited":
      return "wait";
    case "busy":
    case "not_asked":
      return "busy";
    default:
      return "unexpected";
  }
}

const endedWhy = (c: ConnectView): Ended => {
  switch (c.state) {
    case "denied":
      return "denied";
    case "declined":
      return "declined";
    case "expired":
      return "expired";
    default:
      return c.error === "keystore" || c.error === "io" || c.error === "conflict" ? "not-kept" : "unexpected";
  }
};

/** `host`: of the origin this flow connects to, for the steps the hub has not named one in. */
export function connectStep(prev: ConnectStep, ev: ConnectEvent, host: string): ConnectStep {
  switch (ev.type) {
    case "go":
      return prev.kind === "intro" || prev.kind === "ended" ? { kind: "starting" } : prev;
    case "opened":
      return prev.kind === "number" ? { ...prev, opened: true } : prev;
    case "reset":
      return prev.kind === "opening" ? prev : { kind: "intro" };
    case "refused": {
      // The shell is replacing the window, or already has. (A resume whose read of the hub
      // failed ends like a start that could not reach it.)
      if (prev.kind !== "starting" && prev.kind !== "opening" && prev.kind !== "resuming") return prev;
      const why = refusedWhy(ev.error);
      if (!why) return { kind: "intro" };
      const wait = hubError(ev.error).retryAfterS;
      return {
        kind: "ended",
        why,
        host: prev.kind === "opening" ? prev.host : host,
        ...(why === "wait" && wait && wait > 0 ? { at: ev.now + wait * 1000 } : {}),
      };
    }
    case "connect": {
      const c = ev.connect;
      if (prev.kind === "opening") return prev;
      if (!c) {
        // The connect is gone (cancelled, or its outcome cleared): nothing to wait for.
        return prev.kind === "number" || prev.kind === "asking" || prev.kind === "resuming" ? { kind: "intro" } : prev;
      }
      const h = hostOf(c.origin);
      // An older word of a connect this screen is already past (the hub's question is up, or
      // it ended) must not bring its number back. A new connect has a new number.
      if (
        c.state === "pending" &&
        (prev.kind === "asking" || prev.kind === "ended") &&
        prev.digits &&
        prev.digits === c.digits
      )
        return prev;
      if (c.state === "pending")
        return {
          kind: "number",
          host: h,
          digits: c.digits,
          opened: prev.kind === "number" && prev.digits === c.digits ? prev.opened : false,
        };
      if (c.state === "asking") return { kind: "asking", host: h, ...(c.digits ? { digits: c.digits } : {}) };
      if (c.state === "approved") {
        // An approval whose account is no longer here (disconnected since) is old news.
        if (!c.receiver || (ev.accounts && !ev.accounts.includes(c.receiver)))
          return prev.kind === "resuming" ? { kind: "intro" } : prev;
        return { kind: "opening", host: h, receiver: c.receiver };
      }
      // An outcome while a new start is on its way is the last try's.
      if (prev.kind === "starting") return prev;
      return {
        kind: "ended",
        why: endedWhy(c),
        host: h,
        ...(c.digits ? { digits: c.digits } : {}),
        ...(c.note ? { note: c.note } : {}),
        // Where to revoke the key, when that is on the origin the connect was for.
        ...(ownUrl(c.revokeUrl, c.origin) ? { revokeUrl: c.revokeUrl } : {}),
      };
    }
  }
}

/** Four digits as they are read out: "48 21". */
export const spaced = (digits: string): string =>
  digits.length === 4 ? `${digits.slice(0, 2)} ${digits.slice(2)}` : digits;

/** The account a refused start says is already here: the one at `origin` that is fine. */
export function alreadyHere(
  accounts: readonly { id: string; origin: string; state: string }[],
  origin: string | undefined,
): string | null {
  const at = origin ?? DEFAULT_ORIGIN;
  const ok = accounts.filter((a) => a.state === "ok");
  return (ok.find((a) => a.origin === at) ?? (ok.length === 1 ? ok[0] : undefined))?.id ?? null;
}
