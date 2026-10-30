// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The pool in words (UX-SPEC.md §2 in the pool review folder), pure and
// tested: an account's name, its status word from the hello (never from the numbers), the
// room count, the swap and served-by sentences, and the readings of a session's events
// that the session page and the chat need. Numbers still come from limits.ts; nothing
// here invents one.
import type {
  ControlActivity,
  LimitsEntry,
  LimitWindow,
  MachinePool,
  MachinePoolAccount,
  MachineSummary,
  ProtocolEvent,
  SessionSummary,
} from "@shared/api";
import {
  isOut,
  orderWindows,
  readWindow,
  staleWords,
  tightest,
  untilWords,
  windowLabel,
  windowSentence,
} from "./limits";
import { ago } from "./time";

const OUT_PERCENT = 98;

// ----- names (§2.1) -----

/** A row's title: the label, with the email muted after it; else the email; never the id. */
export function rowTitle(a: Pick<MachinePoolAccount, "label" | "email">): { title: string; muted?: string } {
  if (a.label) return a.email ? { title: a.label, muted: a.email } : { title: a.label };
  return { title: a.email ?? "Claude account" };
}

const local = (email: string): string => email.slice(0, email.indexOf("@"));

/** The name a sentence or the sidebar uses: the label, else the email's local part (the
 *  whole email when another shown account shares the local part, as `shortNames` does). */
export function sentenceName(
  a: Pick<MachinePoolAccount, "id" | "label" | "email">,
  shown: readonly Pick<MachinePoolAccount, "id" | "label" | "email">[] = [],
): string {
  if (a.label) return a.label;
  if (!a.email) return "Claude account";
  const twins = shown.filter(
    (x) => x.id !== a.id && !x.label && x.email && local(x.email) === local(a.email as string),
  );
  return twins.length ? a.email : local(a.email);
}

/** Possessive, as the spec writes it: "Fiction's", "fiction's". */
export const possessive = (name: string): string => `${name}'s`;

// ----- status words (§2.2) -----

export type StatusTone = "fg" | "fg-2" | "needs" | "fg-3";
export interface StatusWords {
  word: string;
  tone: StatusTone;
  /** " · resets in 2 h 10 m", from `until`; absent otherwise. */
  after?: string;
  /** error: the word is a quiet text button that opens sign-in. */
  action?: "sign-in";
}

/** The status word of one account, from the hello alone. `on` is the pool's switch: "In
 *  use" is never said while it is off. */
export function statusWords(
  a: Pick<MachinePoolAccount, "enabled" | "status" | "current" | "until">,
  on: boolean,
  now: number,
): StatusWords {
  if (!a.enabled || a.status === "disabled") return { word: "Off", tone: "fg-3" };
  if (a.status === "error") return { word: "Sign in again…", tone: "fg-2", action: "sign-in" };
  if (a.status === "limited") {
    const t = a.until ? Date.parse(a.until) : Number.NaN;
    return {
      word: "Used up",
      tone: "needs",
      ...(Number.isFinite(t) && t > now ? { after: ` · ${untilWords(t - now)}` } : {}),
    };
  }
  if (a.current && on) return { word: "In use", tone: "fg" };
  return { word: "Has room", tone: "fg-2" };
}

/** The tooltip on "Used up". */
export const USED_UP_TIP = "sessionpipe sets an account aside just before its limit, so a reply is never cut short.";

// ----- the room count (§2.3) -----

const hasRoom = (a: Pick<MachinePoolAccount, "enabled" | "status" | "current">): boolean =>
  a.enabled && (a.status === "ready" || (a.current && a.status !== "limited" && a.status !== "error"));

/** "3 accounts, 2 with room", "3 accounts, none with room · first back in 2 h 10 m",
 *  "1 account", "No accounts". Disabled and error accounts count, never as room. */
export function roomWords(accounts: readonly MachinePoolAccount[], now: number, withBack = true): string {
  const n = accounts.length;
  if (n === 0) return "No accounts";
  if (n === 1) return "1 account";
  const room = accounts.filter(hasRoom).length;
  if (room > 0) return `${n} accounts, ${room} with room`;
  const back = firstBack(accounts, now);
  return `${n} accounts, none with room${withBack && back ? ` · ${back}` : ""}`;
}

/** "first back in 2 h 10 m": the earliest `until` still ahead, or null. */
export function firstBack(accounts: readonly Pick<MachinePoolAccount, "until">[], now: number): string | null {
  let soonest = Number.POSITIVE_INFINITY;
  for (const a of accounts) {
    const t = a.until ? Date.parse(a.until) : Number.NaN;
    if (Number.isFinite(t) && t > now && t < soonest) soonest = t;
  }
  if (!Number.isFinite(soonest)) return null;
  return `first back in ${untilWords(soonest - now).replace(/^resets in /, "")}`;
}

// ----- the policy sentence (§2.5) -----

export const POLICY_SENTENCE =
  "Requests go to the first account in this order that has room; a session stays on its account while it has room.";
export const switchHint = (on: boolean, machine: string, agent = "Claude Code"): string =>
  `${POLICY_SENTENCE} ${on ? `${agent} on ${machine} sends through sessionpipe while this is on.` : `${agent} on ${machine} uses its own login.`}`;

// ----- the swap sentence (§2.6) -----

/** The model a per-model week names, from its id: "seven_day_fable" → "Fable". */
const modelOf = (id: string): string => {
  const m = id.slice("seven_day_".length).replace(/_/g, " ");
  return m.charAt(0).toUpperCase() + m.slice(1);
};

/** Why an account was left, as the reason clause: "'s week is used up". Null when nothing
 *  is known. `limitedBy` is the hello's word when it has one; else the tightest window of
 *  the account's entry when it is out (≥ 98 %) or the account is `limited`. */
export function leftBecause(
  from: {
    status?: MachinePoolAccount["status"];
    limitedBy?: string;
    entry?: Pick<LimitsEntry, "windows"> | null;
  },
  now: number,
): string | null {
  if (from.status === "error" || from.limitedBy === "error") return "needs to sign in again";
  let id = from.limitedBy && from.limitedBy !== "rejected" ? from.limitedBy : undefined;
  if (!id && from.entry) {
    const w = tightest(from.entry, now);
    if (w) {
      const r = readWindow(w, now);
      if (from.status === "limited" || r.kind === "over" || r.kind === "none" || w.usedPercent >= OUT_PERCENT)
        id = w.id;
    }
  }
  if (!id) return from.status === "limited" || from.limitedBy === "rejected" ? "is used up" : null;
  if (id === "seven_day") return "week is used up";
  if (id === "five_hour") return "5 hours are used up";
  if (id.startsWith("seven_day_")) return `week for ${modelOf(id)} is used up`;
  if (id === "spend_limit") return "spend limit is reached";
  return "is used up";
}

/** "Switched to Fiction: Misha's week is used up"; "Switched to Fiction" when nothing is
 *  known; "Switched to Fiction from its own account" when the account it left has no name. */
export function swapWords(to: string, from: string | undefined, because: string | null): string {
  if (because) return `Switched to ${to}: ${possessive(from ?? "its own account")} ${because}`;
  return from ? `Switched to ${to}` : `Switched to ${to} from its own account`;
}

// ----- served by (§2.7) -----

const two = (n: number) => String(n).padStart(2, "0");
/** The clock time, h23, local. */
export const clockTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** "Served by Fiction since 14:02". */
export const servedWords = (name: string, sinceIso: string): string => `Served by ${name} since ${clockTime(sinceIso)}`;

// ----- the picker (§6) -----

/** The Agent menu's line for a pooled harness: the room count, and the current account's
 *  tightest window ("Misha, 5 hours 62% left, resets in 2 h 21 m"). */
export function poolAgentWords(
  pool: MachinePool,
  entryFor: (accountId: string) => LimitsEntry | undefined,
  now: number,
): { hint: string; detail?: string; out?: boolean } {
  const hint = roomWords(pool.accounts, now);
  const current = pool.accounts.find((a) => a.current && hasRoom(a));
  if (!current) return { hint, out: pool.accounts.length > 0 && !pool.accounts.some(hasRoom) };
  const e = entryFor(current.id);
  const w = e ? tightest(e, now) : null;
  const name = sentenceName(current, pool.accounts);
  return { hint, detail: w ? `${name}, ${windowSentence(w, now)}` : name };
}

// ----- the machines' pools -----

/** The account ids some machine pools (the Usage page draws them in their section, never
 *  free-standing), and the machines that pool each. */
export function pooledIds(machines: Iterable<Pick<MachineSummary, "name" | "control">>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of machines)
    for (const a of m.control?.pool?.accounts ?? []) {
      const where = out.get(a.id) ?? [];
      if (!where.includes(m.name)) where.push(m.name);
      out.set(a.id, where);
    }
  return out;
}

/** A machine pools accounts: its hello has `pool` with the switch on. */
export const pooling = (m: Pick<MachineSummary, "control"> | undefined): boolean => !!m?.control?.pool?.on;

// ----- a session's events (§7.1, §7.2) -----

export interface Swap {
  /** The `limits.observed` that first named the new account (its seq and time). */
  seq: number;
  at: string;
  /** The account it left: the session's own at first (may be undefined), then the last. */
  from?: string;
  to: string;
}

/** The switches in a session, from its `limits.observed` events' `account_id` in seq
 *  order: one swap each time the serving account changes, starting from the session's own
 *  (`accountId`). A report with no `account_id` says nothing. The events are the ones the
 *  session page already loads; nothing extra is fetched. */
export function swaps(events: readonly ProtocolEvent[], s: Pick<SessionSummary, "accountId">): Swap[] {
  const out: Swap[] = [];
  let serving = s.accountId;
  const sorted = [...events].filter((e) => e.type === "limits.observed").sort((a, b) => a.session.seq - b.session.seq);
  for (const e of sorted) {
    const id = e.data?.account_id;
    if (typeof id !== "string" || !id || id === serving) continue;
    out.push({ seq: e.session.seq, at: e.time, ...(serving ? { from: serving } : {}), to: id });
    serving = id;
  }
  return out;
}

/** Who serves the session now, from its events: the last swap's account when it is not
 *  the session's own, with when it took over. The same reading the server puts on
 *  `SessionSummary.servedBy`; this one works from the page's events. */
export function servedBy(
  events: readonly ProtocolEvent[],
  s: Pick<SessionSummary, "accountId">,
): { accountId: string; since: string } | null {
  const last = swaps(events, s).at(-1);
  return last && last.to !== s.accountId ? { accountId: last.to, since: last.at } : null;
}

// ----- the ack's detail -----

/** A `login.begin`'s answer (CONTROL.md, the pool: the ack's `detail` is
 *  "<pending login id> <URL>", the id, one space, the URL): the id is the first word when
 *  it has the shape of one, the URL the first https URL anywhere in the line (so a daemon
 *  that words it more fully still reads), and `text` what is left besides them. */
export function loginFromDetail(detail: string | undefined): {
  url: string | null;
  pendingId: string | null;
  text: string;
} {
  const d = (detail ?? "").trim();
  const m = /https:\/\/[^\s<>"']+/.exec(d);
  const url = m ? m[0].replace(/[.,;:)\]]+$/, "") : null;
  const first = d.split(/\s+/)[0] ?? "";
  const pendingId =
    url && first && !first.startsWith("https://") && /^[A-Za-z0-9._:-]{1,128}$/.test(first) ? first : null;
  let text = d;
  if (url) text = text.replace(url, "");
  if (pendingId) text = text.replace(pendingId, "");
  return { url, pendingId, text: text.replace(/\s{2,}/g, " ").trim() };
}

/** The pool commands among the activity, newest first: those on the pool's own session. */
export const isPoolActivity = (a: ControlActivity): boolean => a.kind === "pool";

// ----- the picker's line, as the Agent menu draws it (§6) -----

/** The Agent menu's three parts for a pooled harness, the Usage spec's picker shape: the
 *  hint at the right is the current account's tightest value ("62% left"), the detail under
 *  the name the room count and that account's window ("3 accounts, 2 with room · Misha,
 *  5 hours, resets in 2 h 21 m", with "numbers as of 3 h ago" when its entry is stale), and
 *  `out` when the hint takes the accent: "None left" when no account has room and one is
 *  used up. Every account off or in error has no hint, only the count. */
export function poolPickerWords(
  pool: MachinePool,
  entryFor: (accountId: string) => LimitsEntry | undefined,
  now: number,
): { hint?: string; detail?: string; out?: boolean } {
  const room = roomWords(pool.accounts, now);
  const current = pool.accounts.find((a) => a.current && hasRoom(a));
  if (!current) {
    const usedUp = pool.accounts.some((a) => a.enabled && a.status === "limited");
    return usedUp ? { hint: "None left", detail: room, out: true } : { detail: room };
  }
  const name = sentenceName(current, pool.accounts);
  const e = entryFor(current.id);
  const t = e ? tightest(e, now) : null;
  if (!e) return { detail: `${room} · ${name}` };
  if (!t) {
    const first = orderWindows(e.windows)[0];
    return { hint: "Reset", detail: first ? `${room} · ${name}, ${windowSentence(first, now)}` : `${room} · ${name}` };
  }
  const r = readWindow(t, now);
  const stale = staleWords(e, now);
  const detail = [`${room} · ${name}`, windowLabel(t), r.when, stale ? `numbers ${stale}` : ""]
    .filter(Boolean)
    .join(", ");
  return { hint: r.value, detail, out: isOut(r) };
}

// ----- the sidebar's tooltip (§7.3) -----

/** One other account of the pool in a sentence: "Fiction has room.", "Spacesheep is used
 *  up, resets in 2 h 10 m.", "Misha needs to sign in again.", "Old is off." */
export function accountSentence(a: MachinePoolAccount, shown: readonly MachinePoolAccount[], now: number): string {
  const name = sentenceName(a, shown);
  const s = statusWords(a, false, now);
  if (s.word === "Off") return `${name} is off.`;
  if (s.action === "sign-in") return `${name} needs to sign in again.`;
  if (s.word === "Used up") return `${name} is used up${s.after ? `,${s.after.slice(2)}` : ""}.`;
  return `${name} has room.`;
}

/** The pooled machine's sidebar line, a sentence a line: the current account, where and
 *  that it is in use, each of its windows, every other account's state, how old the
 *  numbers are. With no account in room the first line is the count instead. */
export function poolTip(
  pool: MachinePool,
  machine: string,
  entry: LimitsEntry | undefined,
  now: number,
  agent = "Claude Code",
): string {
  const current = pool.accounts.find((a) => a.current && hasRoom(a));
  const lines = current
    ? [`${sentenceName(current, pool.accounts)}, ${agent} on ${machine}, in use.`]
    : [`${agent} on ${machine}: ${roomWords(pool.accounts, now)}.`];
  if (entry) lines.push(...orderWindows(entry.windows).map((w) => `${windowSentence(w, now, ": ")}.`));
  for (const a of pool.accounts) if (a !== current) lines.push(accountSentence(a, pool.accounts, now));
  const age = entry ? ago(entry.observedAt, now) : "";
  if (age) lines.push(`As of ${age}.`);
  return lines.join("\n");
}

// ----- a report's windows (§7.2) -----

/** The windows a `limits.observed` carries, read into the page's shape (`used_percent` →
 *  `usedPercent`), so the chat can say why an account was left from the report that said
 *  so. Empty when the event has none worth reading. */
export function eventWindows(e: Pick<ProtocolEvent, "data">): LimitWindow[] {
  const raw = e.data?.windows;
  if (!Array.isArray(raw)) return [];
  const out: LimitWindow[] = [];
  for (const w of raw as Record<string, unknown>[]) {
    if (!w || typeof w.id !== "string" || typeof w.used_percent !== "number") continue;
    out.push({
      id: w.id,
      usedPercent: w.used_percent,
      ...(typeof w.resets_at === "string" ? { resetsAt: w.resets_at } : {}),
      ...(typeof w.window_minutes === "number" ? { windowMinutes: w.window_minutes } : {}),
    });
  }
  return out;
}

// ----- the section's words (§3.5–§3.7, §4) -----

export const IMPORT_COMMAND = "sessionpipe pool add --import";
export const LOGIN_COMMAND = "sessionpipe pool add --login";
export const SAVING_ORDER = "saving order…";
/** Why the Toggle, the grips and Move are off while a command is out. */
export const stillSaving = (machine: string): string => `${machine} is still saving the last change`;
/** The daemon answered `unsupported`: it predates account switching. */
export const olderDaemon = (machine: string): string =>
  `${machine}'s sessionpipe is older than account switching. Update it there.`;
/** The Notice while the daemon is offline: plainer with the switch off. */
export const offlineNotice = (machine: string, on: boolean): string =>
  on
    ? `${machine}'s sessionpipe is offline, so Claude Code there can't reach Claude while switching is on.`
    : `${machine}'s sessionpipe is offline.`;
/** The sign-in group's lead sentence; "again as …" when opened from an error row. */
export const signInLead = (machine: string, again?: string): string =>
  `${again ? `Sign in again as ${again}. ` : ""}${machine} opens a sign-in link; you sign in on claude.ai and paste the code it shows. Nothing from the account reaches this device.`;
export const CODE_INCOMPLETE =
  "That isn't the whole code. Paste everything the page showed, including the part after #.";
export const LOGIN_EXPIRED = "The sign-in took too long. Start over to get a new link.";
export const cannotSignInHere = (machine: string): string =>
  `${machine}'s sessionpipe can't sign in from here. Use the command below.`;

/** A machine's detail ends the sentence it is quoted in. */
const ended = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

export interface CommandNote {
  text: string;
  err: boolean;
  /** Stays until something else happens (unsupported); else gone after 8 s. */
  sticky?: boolean;
}

/** The note under the section header for a pool command's state (§3.6), with
 *  `refusal(code)` the app's refusal words; null once delivered (the hello says). */
export function commandNote(
  a: Pick<ControlActivity, "outcome" | "code" | "detail">,
  machine: string,
  online: boolean,
  refusal: (code: string | undefined) => string,
): CommandNote | null {
  const detail = a.detail?.trim();
  switch (a.outcome) {
    case undefined:
    case "taken":
    case "progress":
      return { text: online ? `Sending to ${machine}…` : `Waiting for ${machine} to come online.`, err: false };
    case "delivered":
      return null;
    case "refused":
      return { text: `${machine} refused it: ${ended(a.code ? refusal(a.code) : (detail ?? "refused"))}`, err: true };
    case "unsupported":
      return { text: olderDaemon(machine), err: true, sticky: true };
    case "failed":
      return { text: `It didn't reach ${machine}${detail ? `: ${ended(detail)}` : "."}`, err: true };
    case "expired":
      return { text: `${machine} didn't take it in time.`, err: true };
  }
}

/** A sign-in's failure line (§4.2), or null while it is on its way or done. */
export function loginFailure(
  a: Pick<ControlActivity, "outcome" | "code" | "detail" | "poolAction">,
  machine: string,
  refusal: (code: string | undefined) => string,
): CommandNote | null {
  const detail = a.detail?.trim() ?? "";
  if (a.outcome === "unsupported") return { text: cannotSignInHere(machine), err: true, sticky: true };
  if (a.outcome === "refused") {
    if (a.poolAction === "login.complete") {
      if (a.code === "expired" || /expir|too long|ten minutes/i.test(detail)) return { text: LOGIN_EXPIRED, err: true };
      if (/already/i.test(detail)) {
        const email = /[^\s@]+@[^\s@]+\.[^\s@.]+/.exec(detail)?.[0]?.replace(/[.,;:]+$/, "");
        return { text: `${email ?? "That account"} is already on ${machine}.`, err: true };
      }
      return {
        text: `${machine} couldn't finish the sign-in: ${ended(detail || refusal(a.code))} Check the code and try again.`,
        err: true,
      };
    }
    return commandNote(a, machine, true, refusal);
  }
  return commandNote(a, machine, true, refusal);
}

/** The Remove confirm (§3.5): with one account left, what the machine is left with. */
export function removeConfirm(name: string, machine: string, last: boolean): { title: string; body: string } {
  return {
    title: `Remove ${name} from ${machine}?`,
    body: `sessionpipe forgets its sign-in on ${machine}. ${
      last
        ? `${machine} will have no accounts to switch between.`
        : "Sessions on it move to the next account with room."
    } Claude Code's own login is not touched.`,
  };
}

/** The list with the item at `from` moved to `to`; the same list when nothing moves. */
export function moveIn<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const out = [...list];
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it as T);
  return out;
}
