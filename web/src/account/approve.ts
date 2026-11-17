// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Where this phone's own device key stands with a spacesheep account, so it
// can send (docs/rfcs/08, "This phone's device key"). `acct_device_ask` has spacesheep
// raise a request with a two-digit number; on its Devices page a device that can already
// send types that number and approves, once per computer; a key approved that way waits an
// hour before spacesheep carries what it signs. This file reads the device door's answer
// and what the page remembers of its own ask into the one state to show, and says when
// the hour ends as well as it can be known. No sentence, no timer, no request lives here
// (device.ts asks; accountWords.ts has the words). Tested on its own (approve.test.ts).

/** How long a device approved from another device waits before it can send (spacesheep's
 *  machines.ts NEW_DEVICE_WAIT_MS). */
export const NEW_DEVICE_WAIT_MS = 3_600_000;

/** A request seen open this recently, then trusted, was approved between the two looks: an
 *  hour from the moment it was first seen trusted ends no earlier than spacesheep's hour and
 *  at most this much later. Long enough for a trip to Safari to approve it (the page does
 *  not look while it is hidden, and looks again the moment it is back), short enough that
 *  sends are held back by that hour: one held back a few minutes too long is the price of
 *  never offering one that would only be refused. */
export const WATCHED_MS = 600_000;

/** `GET /api/gui/device`, read. */
export interface DeviceDoor {
  /** A computer of the account trusts this phone's key. */
  trusted: boolean;
  machines: { id: string; name: string; trusts: boolean; takesDevice: boolean }[];
  /** A request is open on spacesheep (they last a day). */
  pending: boolean;
  /** Until when the key waits, where spacesheep says it: a time on this phone's clock, or
   *  null for "it may send". Absent where it does not say (the page then works it out, below). */
  coolingUntil?: number | null;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const time = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `here`: this phone's clock as the answer came. spacesheep's `cooling_until` is on its own
 *  clock: where it says its own `now` beside it, the end is the time left from there, counted
 *  on this phone's clock, as a refusal's `until` is (doors.ts). */
export function deviceDoor(json: Record<string, unknown>, here: number = Date.now()): DeviceDoor {
  const trusted = Array.isArray(json.trusted_on) ? json.trusted_on.filter((x) => typeof x === "string") : [];
  const machines = (Array.isArray(json.machines) ? json.machines : [])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({
      id: text(m.id),
      name: text(m.name) || text(m.id),
      trusts: m.trusts === true || trusted.includes(text(m.id)),
      takesDevice: m.takes_device === true,
    }))
    .filter((m) => m.id);
  const until = time(json.cooling_until);
  const theirs = time(json.now);
  return {
    trusted: trusted.length > 0 || machines.some((m) => m.trusts),
    machines,
    pending: json.pending === true,
    ...("cooling_until" in json
      ? { coolingUntil: until === null || theirs === null ? until : here + (until - theirs) }
      : {}),
  };
}

/** What the page remembers of this phone's key for one account (kept across reloads). */
export interface DeviceMemo {
  /** The last ask: the key, the number spacesheep shows beside the request, where Devices is. */
  keyId?: string;
  code?: string;
  askedAt?: number;
  devicesUrl?: string;
  /** When the request was last seen open and the key trusted nowhere (by a look, or by the
   *  ask's own answer). */
  openAt?: number;
  /** When the key was first seen trusted after that, and whether the page had seen it open
   *  within WATCHED_MS before. Never set for a key that was trusted before this page saw it
   *  waiting. */
  trustedAt?: number;
  watched?: boolean;
  /** The hour's end in spacesheep's own word (a send it refused as `cooling`). */
  until?: number;
}

export type MachineState = "can" | "not-yet" | "old";

export type ApprovePhase =
  /** Nothing asked, nothing trusted. */
  | { kind: "idle" }
  /** A request is open on spacesheep; `code`: the number to type there, when this phone has it. */
  | { kind: "waiting"; code: string | null }
  /** Trusted, inside its first hour. `exact`: the end is spacesheep's word, or an hour from
   *  an approval the page saw coming (never early, at most WATCHED_MS late), and sends wait
   *  for it; otherwise the latest it can be, and the first send finds out. */
  | { kind: "cooling"; until: number; exact: boolean }
  | { kind: "approved" }
  /** Asked, and the request is gone with nothing trusted: removed there, or ran out. */
  | { kind: "dropped" };

export interface ApproveView {
  phase: ApprovePhase;
  /** Each computer of the account and whether this phone can send to it. */
  machines: { id: string; name: string; state: MachineState }[];
  /** Trusted by some and a request still open for the rest: the number, to finish there. */
  rest: string | null;
}

/** What to remember after a look at the door. */
export function remember(memo: DeviceMemo, door: DeviceDoor, now: number): DeviceMemo {
  const next: DeviceMemo = { ...memo };
  if (door.trusted) {
    // Only an approval this page saw coming has a time: a key trusted before the page ever
    // saw it waiting was approved at some time nobody here knows, and no hour is made up.
    if (next.trustedAt === undefined && next.openAt !== undefined) {
      next.trustedAt = now;
      next.watched = now - next.openAt <= WATCHED_MS;
    }
    delete next.openAt;
  } else {
    // Removed on spacesheep (or never approved): nothing of an hour to remember.
    delete next.trustedAt;
    delete next.watched;
    delete next.until;
    if (door.pending) next.openAt = now;
    else delete next.openAt;
  }
  return next;
}

/** A computer of the account as the page's own machine list has it, and whether it trusts
 *  a key this phone holds. What is known of the key where the hub has no word of it: the
 *  hub knows a phone's key for an account only once that account was asked for it, and an
 *  account connected again is a new one to the hub, while the key and the computers' trust
 *  in it are as they were. */
export interface KnownMachine {
  id: string;
  name: string;
  trusts: boolean;
  takesDevice: boolean;
}

/** `door`: null before the hub ever asked for this phone (`no_device_key`). `known`: the
 *  account's computers as the page lists them, read only then. */
export function approveView(
  memo: DeviceMemo,
  door: DeviceDoor | null,
  now: number,
  known: readonly KnownMachine[] = [],
): ApproveView {
  if (!door) {
    // Nothing asked through this account, and no computer trusts a key of this phone: the ask is offered.
    if (!known.some((m) => m.trusts)) return { phase: { kind: "idle" }, machines: [], rest: null };
    // A computer already trusts it: what is granted is never asked for again. Whether its
    // hour is over only spacesheep can say, and says in a send it refuses (`memo.until`).
    const until = memo.until !== undefined && memo.until > now ? Math.min(memo.until, now + NEW_DEVICE_WAIT_MS) : null;
    return {
      phase: until === null ? { kind: "approved" } : { kind: "cooling", until, exact: until === memo.until },
      machines: known.map((m) => ({
        id: m.id,
        name: m.name,
        state: (m.trusts ? "can" : m.takesDevice ? "not-yet" : "old") as MachineState,
      })),
      rest: null,
    };
  }
  const machines = door.machines.map((m) => ({
    id: m.id,
    name: m.name,
    state: (m.trusts ? "can" : m.takesDevice ? "not-yet" : "old") as MachineState,
  }));
  const code = memo.code ?? null;
  if (!door.trusted) {
    const phase: ApprovePhase = door.pending
      ? { kind: "waiting", code }
      : memo.askedAt !== undefined
        ? { kind: "dropped" }
        : { kind: "idle" };
    return { phase, machines, rest: null };
  }
  const rest = door.pending && machines.some((m) => m.state === "not-yet") ? code : null;
  // The hour's end: spacesheep's word on the door; its word in a refusal; else an hour from
  // when this page first saw the key trusted after seeing it wait, which is the approval's
  // time to within WATCHED_MS when it watched, and the latest it can have been when it did
  // not. A key it never saw wait can send as far as the page knows: if spacesheep still
  // holds it, the first send it refuses says until when (`memo.until`).
  let until: number | null = null;
  let exact = true;
  if (door.coolingUntil !== undefined) until = door.coolingUntil;
  else if (memo.until !== undefined) until = memo.until;
  else if (memo.trustedAt !== undefined) {
    until = memo.trustedAt + NEW_DEVICE_WAIT_MS;
    exact = memo.watched === true;
  }
  // The wait is an hour and no more: a time remembered or reported past an hour from now
  // (a clock that was wrong when it was written, or is wrong now) is that hour's end at
  // the latest, and never said as exact.
  if (until !== null && until > now + NEW_DEVICE_WAIT_MS) {
    until = now + NEW_DEVICE_WAIT_MS;
    exact = false;
  }
  const phase: ApprovePhase = until !== null && until > now ? { kind: "cooling", until, exact } : { kind: "approved" };
  return { phase, machines, rest };
}

/** The memo, read from what was kept: anything else is nothing. */
export function memoFrom(raw: string | null): DeviceMemo {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (!j || typeof j !== "object") return {};
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const s = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const memo: DeviceMemo = {
      keyId: s(j.keyId),
      code: s(j.code),
      askedAt: n(j.askedAt),
      devicesUrl: s(j.devicesUrl),
      openAt: n(j.openAt),
      trustedAt: n(j.trustedAt),
      watched: j.watched === true ? true : undefined,
      until: n(j.until),
    };
    for (const k of Object.keys(memo) as (keyof DeviceMemo)[]) if (memo[k] === undefined) delete memo[k];
    return memo;
  } catch {
    return {};
  }
}
