// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. The search's words, in one place (ux-search.md §15): the result
// line, a row's date and meta, the status line, the footers. Pure, tested.
import type { SearchIndexStatus, SessionMatch } from "@shared/api";
import { harnessMark } from "../lib/format";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "24 sessions · 6 ms", "1 session · 6 ms", "200+ sessions · 9 ms". */
export function resultLine(total: number, more: boolean, ms: number): string {
  const n = more ? `${Math.min(total, 200).toLocaleString()}+ sessions` : plural(total, "session");
  return `${n} · ${fmtMs(ms)}`;
}
export const fmtMs = (ms: number): string => `${ms < 10 ? Math.max(0.1, Math.round(ms * 10) / 10) : Math.round(ms)} ms`;

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** The right column: `16:12` today, `Yesterday`, `Oct 24` this year, `Mar 2025` before. */
export function shortDate(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const n = new Date(now);
  if (sameDay(d, n)) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay(d, new Date(now - DAY))) return "Yesterday";
  if (d.getFullYear() === n.getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** The tooltip: `Oct 24, 2026, 16:12 – 16:40` (the end's day too when it differs). */
export function spanTip(first: string, last: string): string {
  const a = new Date(first);
  const b = new Date(last);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return "";
  const day = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return sameDay(a, b) ? `${day(a)}, ${time(a)} – ${time(b)}` : `${day(a)}, ${time(a)} – ${day(b)}, ${time(b)}`;
}

/** How long a session ran, coarse: dropped under a minute; `28 m`, `2 h`, `3 d`. */
export function spanCoarse(first: string, last: string): string {
  const d = Date.parse(last) - Date.parse(first);
  if (!(d >= MIN)) return "";
  if (d < HOUR) return `${Math.floor(d / MIN)} m`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h`;
  return `${Math.floor(d / DAY)} d`;
}

/** `/Users/demo/code/billing` → `~/code/billing`. */
export function tildeFold(p: string | undefined): string {
  if (!p) return "";
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}

const repoName = (repo: string | undefined): string => {
  if (!repo) return "";
  const parts = repo
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  return parts.length >= 3 ? parts.slice(-2).join("/") : parts.join("/");
};

/** Where it ran: the machine, or for a history-only session `this Mac's history`
 *  (`studio-mac's history` to a viewer elsewhere). */
export function whereFact(m: SessionMatch): string {
  if (m.source === "history") {
    if (m.thisMachine && isThisDevice()) return `this ${macWord()}'s history`;
    return `${m.machine ?? "this machine"}'s history`;
  }
  return m.machine ?? "";
}

/** At most three facts: where · what · how long (or the Claude account). */
export function metaFacts(m: SessionMatch): string[] {
  const out = [whereFact(m)];
  const what = repoName(m.repo) || tildeFold(m.cwd);
  if (what) out.push(what);
  const third = m.account ?? spanCoarse(m.firstAt, m.lastAt);
  if (third) out.push(third);
  return out.filter(Boolean).slice(0, 3);
}

/** "Mac" on a Mac, else "machine": the history's owner as a person calls it. */
export function macWord(): string {
  return typeof navigator !== "undefined" && /Mac/.test(navigator.platform ?? "") ? "Mac" : "machine";
}
/** The viewer is on the machine that serves the page (loopback). */
export function isThisDevice(): boolean {
  return typeof location === "undefined" || /^(localhost|127\.|\[::1\])/.test(location.hostname);
}

export const harnessName = (h: string): string => harnessMark(h).label;

/** The index status as one quiet line (UX §8). `withResults`: the page shows results. */
export function statusWords(s: SearchIndexStatus, withResults = false): string {
  const pct = `${Math.round((s.progress ?? 0) * 100)} %`;
  switch (s.state) {
    case "first-run":
      return withResults
        ? `History still being read · ${pct}, more may turn up`
        : `Reading this ${macWord()}'s agent history · ${pct}`;
    case "updating":
      return `${plural(s.sessions, "session")} · updating…`;
    case "off":
      return `${plural(s.sessions, "session")} from sessionpipe · history search is `;
    case "error":
      return "The index needs rebuilding. Search still covers what sessionpipe received.";
    default:
      return `${plural(s.sessions, "session")} · up to date`;
  }
}

/** "212 MB". */
export function bytesWord(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
  if (n < 1e9) return `${Math.round(n / 1e6)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/** "4 s ago", "3 min ago", "2 h ago", "Oct 24". */
export function updatedWord(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const d = Math.max(0, now - Date.parse(iso));
  if (d < MIN) return `${Math.max(1, Math.floor(d / 1000))} s ago`;
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  return new Date(Date.parse(iso)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The history transcript's footer (UX §7). */
export function footerWords(m: SessionMatch): string {
  const who = harnessName(m.harness);
  const where = m.thisMachine && isThisDevice() ? `this ${macWord()}` : (m.machine ?? "this machine");
  if (!m.resume) return `From ${who}'s log on ${where}.`;
  return m.thisMachine && isThisDevice()
    ? `From ${who}'s log on ${where}. Resume it in a terminal:`
    : `From ${who}'s log on ${where}. Resume it there in a terminal:`;
}

/** The ID item when no resume line is verified: Antigravity calls it a conversation. */
export const idWord = (harness: string): string => (harness === "antigravity" ? "conversation ID" : "session ID");
