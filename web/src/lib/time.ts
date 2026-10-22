// SPDX-License-Identifier: Apache-2.0
// One shared one-second clock for every ticking relative time on the page, and the
// humane formatters that read from it.
import { useSyncExternalStore } from "react";

let now = Date.now();
const fine = new Set<() => void>();
const coarse = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let ticks = 0;
/** Coarse subscribers hear every COARSE_EVERY-th second. */
const COARSE_EVERY = 10;

const run = () => {
  now = Date.now();
  ticks++;
  for (const fn of fine) fn();
  if (ticks % COARSE_EVERY === 0) for (const fn of coarse) fn();
};
const settle = () => {
  if (fine.size === 0 && coarse.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
};
const subscribeTo = (set: Set<() => void>) => (l: () => void) => {
  set.add(l);
  if (!timer) {
    // The clock stood still while nothing listened; the first reading is fresh.
    now = Date.now();
    timer = setInterval(run, 1000);
  }
  return () => {
    set.delete(l);
    settle();
  };
};
const subscribeFine = subscribeTo(fine);
const subscribeCoarse = subscribeTo(coarse);
const subscribeOff = () => () => {};
const getNow = () => now;

/** How often a reading of the clock needs to change on screen: every second while it
 *  shows seconds, every ten seconds once it shows minutes or more, never when nothing
 *  it renders moves. */
export type Tick = "fine" | "coarse" | "off";

/** Re-renders the caller as its `tick` asks; "fine" (the default) every second. With
 *  "off" the value is the clock as of the last render that needed it. */
export function useNow(tick: Tick = "fine"): number {
  return useSyncExternalStore(
    tick === "fine" ? subscribeFine : tick === "coarse" ? subscribeCoarse : subscribeOff,
    getNow,
    getNow,
  );
}

/** The tick a relative time of `ageMs` needs: seconds show below `secondsUntil`. */
export const tickFor = (ageMs: number, secondsUntil = 3_600_000): Tick =>
  Number.isNaN(ageMs) ? "off" : ageMs < secondsUntil ? "fine" : "coarse";

const dayStart = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const getToday = () => dayStart(now);

/** The current local day as its start (ms): changes once at midnight, so a list of
 *  day labels re-renders then and not every second. */
export function useToday(): number {
  return useSyncExternalStore(subscribeCoarse, getToday, getToday);
}

export const ms = (iso: string | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/** "just now", "12 s ago", "3 m ago", "2 h ago", "yesterday", "3 d ago", "12 Mar". */
export function ago(iso: string | undefined, at: number): string {
  const t = ms(iso);
  if (Number.isNaN(t)) return "";
  const d = Math.max(0, at - t);
  if (d < 3000) return "just now";
  if (d < 60_000) return `${Math.floor(d / 1000)} s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  if (d < 2 * 86_400_000) return "yesterday";
  if (d < 14 * 86_400_000) return `${Math.floor(d / 86_400_000)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** A duration: "0.4 s", "12 s", "4 m 12 s", "2 h 05 m", "3 d 4 h". */
export function dur(msTotal: number | undefined): string {
  if (msTotal === undefined || Number.isNaN(msTotal)) return "";
  const d = Math.max(0, msTotal);
  if (d < 1000) return `${(d / 1000).toFixed(1)} s`;
  const s = Math.floor(d / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${String(s % 60).padStart(2, "0")} s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")} m`;
  const days = Math.floor(h / 24);
  return `${days} d ${h % 24} h`;
}

/** A duration without seconds once past a minute: "12 s", "4 m", "2 h 05 m". For things
 *  that started a while ago, where a ticking second is noise. */
export function durCoarse(msTotal: number | undefined): string {
  if (msTotal === undefined || Number.isNaN(msTotal)) return "";
  // Whole seconds: a row's age never reads "0.0 s".
  if (msTotal < 60_000) return `${Math.floor(Math.max(0, msTotal) / 1000)} s`;
  const m = Math.floor(msTotal / 60_000);
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")} m`;
  return `${Math.floor(h / 24)} d`;
}

/** A short duration for dense rows: "0.4s", "12s", "4m12s", "2h05m". */
export function durShort(msTotal: number | undefined): string {
  return dur(msTotal).replace(/ /g, "");
}

/** Elapsed since an ISO time, formatted with `dur`. */
export function since(iso: string | undefined, at: number): string {
  const t = ms(iso);
  return Number.isNaN(t) ? "" : dur(at - t);
}

export function clock(iso: string | undefined, withMs = false): string {
  const t = ms(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return withMs ? `${hh}:${mm}:${ss}.${String(d.getMilliseconds()).padStart(3, "0")}` : `${hh}:${mm}:${ss}`;
}

export function dayLabel(iso: string | undefined, at: number): string {
  const t = ms(iso);
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const today = new Date(at);
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return "today";
  const y = new Date(at - 86_400_000);
  if (d.toDateString() === y.toDateString()) return "yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
