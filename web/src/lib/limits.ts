// SPDX-License-Identifier: Apache-2.0
// Usage limits in words: how much of each account's windows is left, from sessionpipe's
// limits.observed as the receiver keeps it (server/ui/limits.ts). Every surface (the
// Usage page, the sidebar, New session) words a number here and nowhere else. What is
// left is the figure shown, rounded down so it never flatters; a window whose reset has
// passed reads "Reset", never its last value, since what was used since is unknown; resets
// are relative; a report older than 15 minutes says how old, once. An account is named by
// the paired machines' hellos, never by its id. A window's label comes from its id, then
// its length, so a window the harness adds later (`seven_day_fable`) needs no change here.
// Pure, so it is unit-tested.
import type { HarnessAccount, LimitsEntry, LimitWindow } from "@shared/api";
import { harnessMark } from "./format";
import { ago, ms } from "./time";

const MINUTE = 60_000;
/** A report older than this says "as of 3 h ago". */
export const STALE_MS = 15 * MINUTE;
/** The setup line for Claude Code's numbers, on the machine it runs on. */
export const STATUS_LINE_COMMAND = "sessionpipe install --status-line";

const FIVE_HOURS = 300;
const WEEK = 10_080;

const spaced = (id: string) => id.replace(/_/g, " ").trim();
const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const capWords = (s: string) => s.split(" ").filter(Boolean).map(capFirst).join(" ");

/** A length in whole units: 45 → minutes, 120 → hours, 4 320 → days, else hours. */
function span(minutes: number): { n: string; unit: "minute" | "hour" | "day"; short: string } {
  if (minutes < 60) return { n: String(minutes), unit: "minute", short: "m" };
  if (minutes % 1440 === 0) return { n: String(minutes / 1440), unit: "day", short: "d" };
  const h = minutes / 60;
  return { n: Number.isInteger(h) ? String(h) : h.toFixed(1), unit: "hour", short: "h" };
}

/** A window as the Usage page names it: "5 hours", "This week, all models", "This week,
 *  Fable only", "Spend limit", "90 minutes", or its id in words ("Primary"). */
export function windowLabel(w: Pick<LimitWindow, "id" | "windowMinutes">): string {
  if (w.id === "five_hour") return "5 hours";
  if (w.id === "seven_day") return "This week, all models";
  const model = /^seven_day_(.+)$/.exec(w.id)?.[1];
  if (model) return `This week, ${capWords(spaced(model))} only`;
  if (w.id === "spend_limit") return "Spend limit";
  if (w.windowMinutes === FIVE_HOURS) return "5 hours";
  if (w.windowMinutes === WEEK) return "This week";
  if (w.windowMinutes) {
    const s = span(w.windowMinutes);
    return `${s.n} ${s.unit}${s.n === "1" ? "" : "s"}`;
  }
  return capFirst(spaced(w.id));
}

/** The same in the sidebar's few letters: "5h", "week", "week Fable", "spend", "90m". */
export function windowShort(w: Pick<LimitWindow, "id" | "windowMinutes">): string {
  if (w.id === "five_hour") return "5h";
  if (w.id === "seven_day") return "week";
  const model = /^seven_day_(.+)$/.exec(w.id)?.[1];
  if (model) return `week ${capWords(spaced(model))}`;
  if (w.id === "spend_limit") return "spend";
  if (w.windowMinutes === FIVE_HOURS) return "5h";
  if (w.windowMinutes === WEEK) return "week";
  if (w.windowMinutes) {
    const s = span(w.windowMinutes);
    return `${s.n}${s.short}`;
  }
  return capFirst(spaced(w.id));
}

/** The windows as they arrived, the spend limit last. */
export function orderWindows(windows: readonly LimitWindow[]): LimitWindow[] {
  return [...windows.filter((w) => w.id !== "spend_limit"), ...windows.filter((w) => w.id === "spend_limit")];
}

/** "resets in under a minute", "resets in 42 m", "resets in 2 h 21 m", "resets in 2 d 18 h". */
export function untilWords(msLeft: number): string {
  const d = Math.max(0, msLeft);
  if (d < MINUTE) return "resets in under a minute";
  const m = Math.floor(d / MINUTE);
  if (m < 60) return `resets in ${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `resets in ${h} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")} m` : ""}`;
  return `resets in ${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ""}`;
}

/** The reset as a clock time, for a tooltip only, in the person's own clock as every
 *  other time in the app: "Sat, Oct 31, 2:00 PM" here, "Sat 31 Oct, 14:00" elsewhere. */
export function resetClock(iso: string | undefined): string {
  const t = ms(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return `${day}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export interface Reading {
  kind: "left" | "none" | "over" | "reset";
  /** "62% left", "<1% left", "None left", "12% over"; "Reset" once its reset has passed. */
  value: string;
  /** The bar's fill, what is left (0–1); null once reset, when no track is drawn at all:
   *  an empty one would read as none left. */
  fill: number | null;
  /** "resets in 2 h 21 m" ahead of the reset, "Reset 40 m ago" after it, "" with no time. */
  when: string;
  /** Points left (negative when over), for the tightest window. */
  room: number;
}

/** One window at `now`. */
export function readWindow(w: LimitWindow, now: number): Reading {
  const u = w.usedPercent;
  const at = ms(w.resetsAt);
  const room = 100 - u;
  if (!Number.isNaN(at) && at <= now) {
    return { kind: "reset", value: "Reset", fill: null, when: `Reset ${ago(w.resetsAt, now)}`, room };
  }
  const when = Number.isNaN(at) ? "" : untilWords(at - now);
  if (u > 100) return { kind: "over", value: `${Math.ceil(u - 100)}% over`, fill: 0, when, room };
  if (u >= 100) return { kind: "none", value: "None left", fill: 0, when, room };
  if (u >= 99) return { kind: "left", value: "<1% left", fill: 0.01, when, room };
  return { kind: "left", value: `${Math.floor(room)}% left`, fill: room / 100, when, room };
}

/** None left, or past it: the one state the attention colour marks, on its words alone. */
export const isOut = (r: Reading): boolean => r.kind === "none" || r.kind === "over";

/** The window with least left among those that have not reset (a reached one always is),
 *  the spend limit included; the first listed on a tie. Null when every window has reset. */
export function tightest(e: Pick<LimitsEntry, "windows">, now: number): LimitWindow | null {
  let best: LimitWindow | null = null;
  let room = Number.POSITIVE_INFINITY;
  for (const w of orderWindows(e.windows)) {
    const r = readWindow(w, now);
    if (r.kind === "reset") continue;
    if (r.room < room) {
      best = w;
      room = r.room;
    }
  }
  return best;
}

/** "as of 3 h ago" for a report older than STALE_MS, else "". */
export function staleWords(e: Pick<LimitsEntry, "observedAt">, now: number): string {
  const t = ms(e.observedAt);
  return !Number.isNaN(t) && now - t > STALE_MS ? `as of ${ago(e.observedAt, now)}` : "";
}

/** A plan as the harness spells it, lightly: "plus" → "Plus", "max_20x" → "Max 20x". */
export function planWords(plan: string | undefined): string {
  return plan ? capWords(plan.replace(/[_-]+/g, " ")) : "";
}

// ----- names -----

const nameKey = (harness: string, id: string) => `${harness}\n${id}`;

/** What the paired machines' hellos call each account (its email, else its host name),
 *  by harness and id. The receiver keeps no names with the numbers. */
export function accountNames(accounts: Iterable<HarnessAccount>): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of accounts) {
    const label = a.email ?? a.name;
    if (label && !out.has(nameKey(a.harness, a.id))) out.set(nameKey(a.harness, a.id), label);
  }
  return out;
}

/** The name a hello gave this account, or undefined. */
export const nameOf = (names: ReadonlyMap<string, string>, harness: string, id: string | undefined) =>
  id ? names.get(nameKey(harness, id)) : undefined;

/** Who the numbers belong to, as the page's title: "dev@example.com", "api.z.ai",
 *  "Claude Code account" (no hello names it), "Codex on lab-mac" (no account id). */
export function entryTitle(
  e: Pick<LimitsEntry, "harness" | "accountId" | "machine">,
  names: ReadonlyMap<string, string>,
): string {
  const label = harnessMark(e.harness).label;
  if (!e.accountId) return `${label} on ${e.machine}`;
  return nameOf(names, e.harness, e.accountId) ?? `${label} account`;
}

/** "lab-mac", "lab-mac and build-box", "a, b and c". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The muted line under a title: "Claude Code on lab-mac and build-box", the plan after a
 *  comma ("…, Plus plan"); just the plan when the title already names the machine. */
export function entrySubtitle(e: Pick<LimitsEntry, "harness" | "accountId" | "machines" | "plan">): string {
  const plan = e.plan ? `${planWords(e.plan)} plan` : "";
  if (!e.accountId) return plan;
  const where = `${harnessMark(e.harness).label}${e.machines.length ? ` on ${andList(e.machines)}` : ""}`;
  return plan ? `${where}, ${plan}` : where;
}

/** The sidebar's short names, by key: an email's local part (the whole email when two
 *  shown accounts share one), a host name as it is, and for an account no hello names or a
 *  machine's numbers the machine, since the glyph beside it already says the harness (the
 *  harness only when no machine is known). */
export function shortNames(
  entries: readonly Pick<LimitsEntry, "key" | "harness" | "accountId" | "machine">[],
  names: ReadonlyMap<string, string>,
): Map<string, string> {
  const named = entries.map((e) => nameOf(names, e.harness, e.accountId));
  const local = (n: string) => (n.includes("@") ? n.slice(0, n.indexOf("@")) : n);
  const locals = new Map<string, number>();
  for (const n of named) if (n) locals.set(local(n), (locals.get(local(n)) ?? 0) + 1);
  const out = new Map<string, string>();
  entries.forEach((e, i) => {
    const n = named[i];
    if (n) out.set(e.key, (locals.get(local(n)) ?? 0) > 1 ? n : local(n));
    else out.set(e.key, e.machine || harnessMark(e.harness).label);
  });
  return out;
}

/** The page's order, which no number moves: Claude Code, then Codex, then any other
 *  harness by name; within one, the accounts with numbers before those that sent none,
 *  each the ones a hello names first (so "Claude Code account" never falls between two
 *  emails), then by title (then machine). */
export function byPlace<
  T extends { harness: string; title: string; machine: string; named?: boolean; quiet?: unknown },
>(a: T, b: T): number {
  const rank = (h: string) => (h === "claude-code" ? 0 : h === "codex" ? 1 : 2);
  const tier = (x: T) => (x.quiet ? 2 : 0) + (x.named ? 0 : 1);
  return (
    rank(a.harness) - rank(b.harness) ||
    harnessMark(a.harness).label.localeCompare(harnessMark(b.harness).label) ||
    tier(a) - tier(b) ||
    a.title.localeCompare(b.title) ||
    a.machine.localeCompare(b.machine)
  );
}

// ----- sentences -----

/** "5 hours 62% left, resets in 2 h 21 m"; "5 hours reset 40 m ago". */
export function windowSentence(w: LimitWindow, now: number, sep = " "): string {
  const r = readWindow(w, now);
  if (r.kind === "reset") return `${windowLabel(w)}${sep}${r.when.charAt(0).toLowerCase()}${r.when.slice(1)}`;
  return `${windowLabel(w)}${sep}${r.value}${r.when ? `, ${r.when}` : ""}`;
}

/** Who, with the harness unless the title says it: "dev@example.com, Claude Code". */
function who(e: LimitsEntry, title: string): string {
  const label = harnessMark(e.harness).label;
  return title.includes(label) ? title : `${title}, ${label}`;
}

/** Copy usage: "dev@example.com, Claude Code: 5 hours 62% left, resets in 2 h 21 m; This
 *  week, all models 80% left, resets in 2 d 18 h", with "; as of 3 h ago" when stale. */
export function usageText(e: LimitsEntry, title: string, now: number): string {
  const stale = staleWords(e, now);
  const parts = orderWindows(e.windows).map((w) => windowSentence(w, now));
  return `${who(e, title)}: ${parts.join("; ")}${stale ? `; ${stale}` : ""}`;
}

/** The sidebar line's tooltip, a sentence a line: who, each window, how old. */
export function usageTip(e: LimitsEntry, title: string, now: number): string {
  const lines = [`${who(e, title)}.`, ...orderWindows(e.windows).map((w) => `${windowSentence(w, now, ": ")}.`)];
  const age = ago(e.observedAt, now);
  if (age) lines.push(`As of ${age}.`);
  return lines.join("\n");
}

// ----- New session -----

export type AccountPick =
  | { kind: "entry"; entry: LimitsEntry }
  | { kind: "ambiguous"; count: number; each: { name: string; entry: LimitsEntry }[] }
  | null;

/** Whose numbers a start of `harness` on `machine` would use. A start cannot choose an
 *  account, so a machine whose hello names two for the harness has no one number, only
 *  each one's that sent any, by its short name; one it names is that one's; none named,
 *  the machine's own (Codex), else the one account seen there. */
export function accountFor(
  harness: string,
  machine: string,
  accounts: readonly HarnessAccount[] | undefined,
  entries: readonly LimitsEntry[],
): AccountPick {
  const mine = (accounts ?? []).filter((a) => a.harness === harness);
  if (mine.length >= 2) {
    const each = mine.flatMap((a) => entries.find((e) => e.harness === harness && e.accountId === a.id) ?? []);
    const short = shortNames(each, accountNames(mine));
    return { kind: "ambiguous", count: mine.length, each: each.map((e) => ({ name: short.get(e.key)!, entry: e })) };
  }
  const pick = (e: LimitsEntry | undefined): AccountPick => (e ? { kind: "entry", entry: e } : null);
  if (mine.length === 1) return pick(entries.find((e) => e.harness === harness && e.accountId === mine[0]!.id));
  const own = entries.find((e) => e.harness === harness && !e.accountId && e.machine === machine);
  if (own) return pick(own);
  const seen = entries.filter((e) => e.harness === harness && e.accountId && e.machines.includes(machine));
  return seen.length === 1 ? pick(seen[0]) : null;
}

/** An agent's line in New session: the hint at the right ("62% left"), the detail under
 *  its name ("5 hours, resets in 2 h 21 m"), and whether the hint is none left or over.
 *  Two accounts have no hint, since no one number is theirs; the detail has each one's
 *  tightest window ("dev 62% left, work 12% over"), or "2 accounts here" with none. */
export function agentWords(pick: AccountPick, now: number): { hint?: string; detail?: string; out?: boolean } {
  if (!pick) return {};
  if (pick.kind === "ambiguous") {
    const each = pick.each.map(({ name, entry }) => {
      const t = tightest(entry, now);
      const value = t ? readWindow(t, now).value : "Reset";
      const stale = staleWords(entry, now);
      return `${name} ${value.charAt(0).toLowerCase()}${value.slice(1)}${stale ? ` ${stale}` : ""}`;
    });
    return { detail: each.length ? each.join(", ") : `${pick.count} accounts here` };
  }
  const e = pick.entry;
  const stale = staleWords(e, now);
  const t = tightest(e, now);
  if (!t) {
    const first = orderWindows(e.windows)[0];
    return { hint: "Reset", ...(first ? { detail: windowSentence(first, now) } : {}) };
  }
  const r = readWindow(t, now);
  const detail = [windowLabel(t), r.when, stale].filter(Boolean).join(", ");
  return { hint: r.value, detail, out: isOut(r) };
}

// ----- the page's edges -----

/** "Gemini CLI doesn't report its limits." / "Cursor, Gemini CLI and goose don't report
 *  their limits.": the harnesses seen with no source (not Claude Code or Codex, and none
 *  that sent numbers). "" when there are none. */
export function footnote(harnesses: Iterable<string>, entries: readonly Pick<LimitsEntry, "harness">[]): string {
  const reporting = new Set(entries.map((e) => e.harness));
  const silent = [...new Set(harnesses)]
    .filter((h) => h !== "claude-code" && h !== "codex" && h !== "conformance" && !reporting.has(h))
    .map((h) => harnessMark(h).label)
    .sort((a, b) => a.localeCompare(b));
  if (silent.length === 0) return "";
  return silent.length === 1
    ? `${silent[0]} doesn't report its limits.`
    : `${andList(silent)} don't report their limits.`;
}

/** A Claude Code account known here (a hello names it, or a session came from it) that has
 *  sent no numbers: the page says how to turn them on. An API home (`api-…`) has no plan
 *  limits, so it gets no hint. */
export interface QuietAccount {
  key: string;
  harness: "claude-code";
  accountId: string;
  /** Where it was seen, by name. */
  machines: string[];
}

export function quietAccounts(
  known: Iterable<{ harness: string; accountId?: string; machine?: string }>,
  entries: readonly Pick<LimitsEntry, "harness" | "accountId">[],
): QuietAccount[] {
  const reported = new Set(entries.filter((e) => e.harness === "claude-code").map((e) => e.accountId));
  const out = new Map<string, QuietAccount>();
  for (const k of known) {
    if (k.harness !== "claude-code" || !k.accountId || k.accountId.startsWith("api-")) continue;
    if (reported.has(k.accountId)) continue;
    let q = out.get(k.accountId);
    if (!q) {
      q = { key: `claude-code a:${k.accountId}`, harness: "claude-code", accountId: k.accountId, machines: [] };
      out.set(k.accountId, q);
    }
    if (k.machine && !q.machines.includes(k.machine)) q.machines.push(k.machine);
  }
  return [...out.values()];
}
