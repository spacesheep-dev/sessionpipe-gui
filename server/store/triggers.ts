// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. Which rule ran a session, and how its run began (sessionpipe
// triggers, CONTROL.md §14.9): the store's reading of `session.triggered_by`, kept apart
// from readings.ts because it is a function of the session's events in their own order
// (seq) and of nothing else, so a live receiver, a rebuild and a restart, which read the
// same events in different orders, say the same thing. Imports nothing of Node's: the page
// on an account and the mock world run it too.
//
// It is lineage, never authority: it is shown ("Started by trigger card-todo"), and nothing
// reads it to allow, hide, sort or skip anything.
import { TRIGGER_NAME_RE } from "../../shared/api.js";

/** How the rule's run began, from the `session.started` that opens it. */
export type TriggerFrom = "start" | "continue" | "unknown";

/** `session.started.source` (events.proto SessionSource) as a run's opening: `startup` is a
 *  fresh start, so the rule started the session; `resume` is "resumed from an earlier
 *  session", so it continued one. `clear` (the person cleared the context), `compact` (after
 *  a compaction: the run's own start was not read), `fork` (forked from another session:
 *  neither the session this one is, nor known to be a new one) and `unknown` say neither,
 *  and neither does a run with no `session.started` read. */
const FROM_SOURCE: Record<string, TriggerFrom> = { startup: "start", resume: "continue" };

/** A stretch of the session's events, in seq order, that carry the same `triggered_by`
 *  (`name`), or none (`null`). `lo` and `hi` are seqs read; `starts` the `session.started`
 *  read inside it, by seq. */
interface Stretch {
  lo: number;
  hi: number;
  name: string | null;
  starts: { seq: number; source: string }[];
}

/** What the reading keeps of a session: the seqs read, as intervals of consecutive seqs,
 *  and its events cut into stretches by `triggered_by`. A session read whole is a few
 *  intervals whatever its length; one read thinned (a relay that sends the main tools
 *  only, a sink below tier 3: every other seq) is about one per event read, as many as
 *  the store's own set of seqs holds. Two stretches side by side never share a name.
 *  Both are the same for the same events, whatever order they were read in. */
export interface TriggerTrack {
  seen: [number, number][];
  stretches: Stretch[];
}

export const newTriggerTrack = (): TriggerTrack => ({ seen: [], stretches: [] });

/** The rule's name an event carries, only in a rule name's shape; anything else (another
 *  type, uppercase, a space, a `:`, 41 characters) is no name, as `launched_by` drops what
 *  is not a session key. */
export function triggerName(v: unknown): string | null {
  return typeof v === "string" && TRIGGER_NAME_RE.test(v) ? v : null;
}

/** The events a machine writes into a session on its own, not the run's hooks (PROTOCOL.md
 *  §4): the daemon's `delegation.started` and `delegation.ended` for an ask or a handoff the
 *  session made, `limits.observed` (the account's numbers, which the account pool reads off
 *  a request the session made, not only its status line), and a `session.backfill` sent
 *  again with the session's next seq once a better name is known. Only the hooks stamp
 *  `triggered_by` (CONTROL.md §14.9), so these land in the middle of a rule's run with no
 *  name, and they say nothing of who runs the session. One without a name is passed over:
 *  it neither carries a run on nor ends one, as a seq never read. With a name it is read as
 *  any event is. */
const MACHINE_WRITES = new Set(["delegation.started", "delegation.ended", "limits.observed", "session.backfill"]);

/** What the reading takes of one protocol event, or null for one it passes over. */
export function triggerInput(ev: {
  type: string;
  session: { seq: number; triggered_by?: unknown };
  data: Record<string, unknown>;
}): { seq: number; name: string | null; source?: string } | null {
  const name = triggerName(ev.session.triggered_by);
  if (name === null && MACHINE_WRITES.has(ev.type)) return null;
  if (ev.type !== "session.started") return { seq: ev.session.seq, name };
  const source = ev.data.source;
  return { seq: ev.session.seq, name, source: typeof source === "string" ? source : "" };
}

/** Read one protocol event (triggerInput, then noteTriggerEvent). */
export function noteTrigger(t: TriggerTrack, ev: Parameters<typeof triggerInput>[0]): void {
  const x = triggerInput(ev);
  if (x) noteTriggerEvent(t, x.seq, x.name, x.source);
}

/** The first index whose interval or stretch ends at or after `seq`. */
function firstEndingAtOrAfter<T>(list: T[], end: (x: T) => number, seq: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (end(list[mid]!) < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Note `seq` as read; false when it was read already (the store never applies one twice,
 *  but the reading does not rely on it). */
function see(t: TriggerTrack, seq: number): boolean {
  const s = t.seen;
  const i = firstEndingAtOrAfter(s, (x) => x[1], seq - 1);
  const at = s[i];
  if (at && at[0] <= seq && seq <= at[1]) return false;
  if (at && at[1] === seq - 1) {
    at[1] = seq;
    const next = s[i + 1];
    if (next && next[0] === seq + 1) {
      at[1] = next[1];
      s.splice(i + 1, 1);
    }
  } else if (at && at[0] === seq + 1) at[0] = seq;
  else s.splice(i, 0, [seq, seq]);
  return true;
}

/** The seq read just before `seq`, and just after it (`seq` itself read). */
function before(t: TriggerTrack, seq: number): number {
  const s = t.seen;
  const i = firstEndingAtOrAfter(s, (x) => x[1], seq);
  const at = s[i]!;
  return at[0] < seq ? seq - 1 : s[i - 1]![1];
}
function after(t: TriggerTrack, seq: number): number {
  const s = t.seen;
  const i = firstEndingAtOrAfter(s, (x) => x[1], seq);
  const at = s[i]!;
  return at[1] > seq ? seq + 1 : s[i + 1]![0];
}

const byStart = (a: { seq: number }, b: { seq: number }) => a.seq - b.seq;

/** Read one event: its seq, the name it carries (or none) and, for a `session.started`,
 *  its source. */
export function noteTriggerEvent(t: TriggerTrack, seq: number, name: string | null, source?: string): void {
  if (!see(t, seq)) return;
  // A stretch's starts are touched only for a start: an event that is none (nearly every
  // one) copies nothing, so a session with many starts costs no more per event.
  const start = source === undefined ? undefined : { seq, source };
  const list = t.stretches;
  const i = firstEndingAtOrAfter(list, (x) => x.hi, seq);
  const here = list[i];
  if (here && here.lo < seq) {
    // Inside a stretch (its first and last are read, so it reaches past `seq` both ways).
    if (here.name === name) {
      if (start) {
        const last = here.starts[here.starts.length - 1];
        here.starts.push(start);
        if (last && last.seq > seq) here.starts.sort(byStart);
      }
      return;
    }
    const left: Stretch = {
      lo: here.lo,
      hi: before(t, seq),
      name: here.name,
      starts: here.starts.filter((x) => x.seq < seq),
    };
    const right: Stretch = {
      lo: after(t, seq),
      hi: here.hi,
      name: here.name,
      starts: here.starts.filter((x) => x.seq > seq),
    };
    list.splice(i, 1, left, { lo: seq, hi: seq, name, starts: start ? [start] : [] }, right);
    return;
  }
  // Between two stretches (or before the first, or after the last): nothing read lies
  // between `seq` and either neighbour. The two never share a name, so `seq` joins one of
  // them at most.
  const prev = list[i - 1];
  const next = here;
  if (prev && prev.name === name) {
    prev.hi = seq;
    if (start) prev.starts.push(start);
  } else if (next && next.name === name) {
    next.lo = seq;
    if (start) next.starts.unshift(start);
  } else list.splice(i, 0, { lo: seq, hi: seq, name, starts: start ? [start] : [] });
}

/** The reading: the rule of the newest stretch that carries one (an event without the
 *  name, or with another, ends a stretch; seqs never read do not), and how that run
 *  began, from the first `session.started` read inside it. Undefined when no event read
 *  carries a rule's name. */
export function triggerReading(t: TriggerTrack): { name: string; from: TriggerFrom } | undefined {
  for (let i = t.stretches.length - 1; i >= 0; i--) {
    const s = t.stretches[i]!;
    if (s.name === null) continue;
    const first = s.starts[0];
    return { name: s.name, from: (first && FROM_SOURCE[first.source]) || "unknown" };
  }
  return undefined;
}
