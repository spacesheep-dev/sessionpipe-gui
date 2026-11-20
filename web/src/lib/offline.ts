// SPDX-License-Identifier: Apache-2.0
// A paired machine you rely on that stopped polling: the board's one quiet line. A
// machine counts only when it has control (an event-only machine has no heartbeat, so it
// is never called offline), the receiver reads it offline (its 2 × wait_max_s grace is
// already in `online`), and it matters: a message waits for it, or one of its sessions
// needs you, works or went stale. Hiding the line is per device and keyed by the machine
// and its last poll, so it stays hidden while nothing changes, clears itself when the
// machine is back, and returns when the machine drops again (a new last poll). Machines
// counts and marks a machine online by the same rule (`machineOnline`).
import type { MachineControl, MachineSummary, SessionSummary } from "@shared/api";
import { heard, ms } from "./time";

/** Whether a machine is online, the one rule every page reads: a paired machine by its
 *  heartbeat alone (the receiver's `online`, spacesheep's on an account), since its
 *  sessions' events keep arriving while its daemon is down; an event-only machine, which
 *  has no heartbeat, by an event in the last minute. */
export const machineOnline = (m: Pick<MachineSummary, "lastAt" | "control">, now: number): boolean =>
  m.control ? m.control.online : now - ms(m.lastAt) < 60_000;

/** When a paired machine was last heard from: its last poll here, else its last hello
 *  (spacesheep's last_seen, for a computer reached through an account). */
export const lastHeard = (c: Pick<MachineControl, "lastPollAt" | "lastHelloAt">): string | undefined =>
  c.lastPollAt ?? c.lastHelloAt;

export interface OfflineMachine {
  name: string;
  lastPollAt?: string;
  queued: number;
}

const LIVE = new Set<SessionSummary["state"]>(["needs_you", "working", "stale"]);

/** Every paired machine the receiver reads as offline, whether it matters or not. */
const offline = (machines: Iterable<MachineSummary>) => [...machines].filter((m) => m.control?.online === false);

/** The offline machines worth a line, in the order given; with the board's machine
 *  filter set, only that one is considered. */
export function offlineMachines(
  machines: Iterable<MachineSummary>,
  sessions: Iterable<SessionSummary>,
  machineFilter = "",
): OfflineMachine[] {
  const busy = new Set<string>();
  for (const s of sessions) if (s.machine && LIVE.has(s.state)) busy.add(s.machine);
  return offline(machines)
    .filter((m) => !machineFilter || m.name === machineFilter)
    .filter((m) => m.control!.queued > 0 || busy.has(m.name))
    .map((m) => ({ name: m.name, lastPollAt: m.control!.lastPollAt, queued: m.control!.queued }));
}

/** One drop of one machine: the same until it polls again. */
export const ackKey = (m: { name: string; lastPollAt?: string }): string =>
  JSON.stringify([m.name, m.lastPollAt ?? ""]);

/** What the line shows: the machines whose drop has not been hidden. */
export const unacknowledged = (list: OfflineMachine[], seen: readonly string[]): OfflineMachine[] =>
  list.filter((m) => !seen.includes(ackKey(m)));

/** Hide these drops. */
export const acknowledge = (seen: readonly string[], list: OfflineMachine[]): string[] => [
  ...new Set([...seen, ...list.map(ackKey)]),
];

/** What the line shows while the board holds still under the hand (useListHold): the
 *  machines it showed when the hold began, since appearing or clearing would move every
 *  row below it. A dismissal still hides it at once: that was the person's own hand. */
export const heldLine = (
  shown: OfflineMachine[],
  live: OfflineMachine[],
  seen: readonly string[],
  hold: boolean,
): OfflineMachine[] => (hold ? unacknowledged(shown, seen) : live);

/** Keep only the keys of drops still going on: a machine that came back (or polled and
 *  dropped again) loses its key, so its next drop shows. */
export function pruneAcks(seen: readonly string[], machines: Iterable<MachineSummary>): string[] {
  const now = new Set(offline(machines).map((m) => ackKey({ name: m.name, lastPollAt: m.control!.lastPollAt })));
  return seen.filter((k) => now.has(k));
}

const SEEN_KEY = "sessionpipe-gui.board.offlineSeen";

export function readAcks(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function writeAcks(seen: readonly string[]): void {
  try {
    if (seen.length) localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    else localStorage.removeItem(SEEN_KEY);
  } catch {
    // a private window: hidden for this page only
  }
}

const waits = (n: number, back: string) =>
  n > 0 ? ` ${n} ${n === 1 ? "message waits" : "messages wait"} until ${back} back.` : "";

/** "build-box is offline, last heard 14:02. 2 messages wait until it's back." */
export function offlineWords(list: OfflineMachine[], now = Date.now()): string {
  if (list.length === 1) {
    const m = list[0]!;
    const at = m.lastPollAt ? heard(m.lastPollAt, now) : "";
    return `${m.name} is offline${at ? `, last heard ${at}` : ""}.${waits(m.queued, "it's")}`;
  }
  const queued = list.reduce((n, m) => n + m.queued, 0);
  return `${list.length} machines are offline.${waits(queued, "they're")}`;
}
