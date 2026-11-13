// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The sends of an account whose answer nobody heard (docs/rfcs/08, "The
// doors"). A send is sent (spacesheep holds a job), not sent (a refusal that proves no job
// was made), or unknown; this file keeps the unknown ones until they are one of the other
// two. Each is a row the page is shown (`unheard` on its activity), kept in the `sends`
// document with the bytes that were signed, and asked again with those same bytes as soon
// as spacesheep can be reached: spacesheep takes a command once, so the asking cannot send
// it twice, and its answer says which it was (doors.ts `Sent`). When the bytes are too old
// to make a job any more, what the jobs door lists settles it. While a send is unknown,
// the same kind of send for the same session is held, so one tap cannot make a second job
// of the same words.
import type { ControlActivity } from "@shared/api";
import { cleanReason } from "@shared/reason";
import type { ControlCommand } from "sessionpipe-core/control";
import { type MachineRow, type MessageRow, messageRow, REMOTE_CODE_RE, toActivity } from "../../../server/control/rows";
import { type AccountDoors, SEND_UNKNOWN_CODE, type Sent } from "./doors";

/** How long after an asking the next one is made, while nothing else says to ask sooner. */
export const UNHEARD_WAITS_MS: readonly number[] = [8000, 15_000, 30_000, 60_000];
/** A send that was settled as not sent, or as one nobody can say, is kept this long. */
export const UNHEARD_KEEP_MS = 86_400_000;
/** At most this many are kept; the oldest settled ones go first. */
export const UNHEARD_MAX = 50;
/** A look in the jobs door that cannot be read is made again at most this often for one
 *  send: at up to LOOK_PAGES reads a look, that bounds what one send may ever read. */
export const UNHEARD_LOOKS_MAX = 20;
/** A send nobody could say anything of for this long is one nobody ever will. */
export const UNHEARD_GIVE_UP_MS = 7 * 86_400_000;

/** One send as the `sends` document keeps it. */
export interface UnheardKept {
  /** The row of the command as it was read, with nothing of what signed it. */
  row: MessageRow;
  state: "asking" | "unsent" | "unknown";
  /** What the app said of the asking, in its words. */
  why: string;
  /** When the first asking began, on this page's clock. */
  askedAt: number;
  /** The highest spacesheep job id the page knew of when the send began: its own job, if
   *  one was made, is after it, and the jobs door is always read from here for it. */
  floor: number;
  /** The bytes that were signed, while asking them again can still say something; the
   *  command alone once they are too old to make a job (the jobs door is read by it). */
  body?: { cmd: string; csig?: unknown; grant?: unknown; confirm?: unknown };
  /** The bytes are too old to make a job any more: the jobs door has the last word. */
  dead?: boolean;
  /** How many looks in the jobs door could not be read (UNHEARD_LOOKS_MAX). */
  looks?: number;
  /** Not sent: the refusal as a send answers it (`status`, and the body's reason, code, detail). */
  refusal?: { status: number; reason: string; code?: string; detail?: string };
  /** When it was settled. */
  settledAt?: number;
}

export interface UnheardOptions {
  kept?: UnheardKept[] | null;
  doors: Pick<AccountDoors, "ask" | "look">;
  /** The machine's row, once the account's list has brought it. */
  machine(id: string): MachineRow | undefined;
  /** spacesheep holds it: the row becomes a send like any other, under the same id (`job`
   *  null: taken, and its job cannot be named). */
  adopt(u: UnheardKept, cmd: ControlCommand, job: number | null): void;
  /** No job was made: the refusal as a send of these bytes answers it now. */
  refused(u: UnheardKept, status: number, json: Record<string, unknown>): UnheardKept["refusal"];
  /** A row was added or changed: the page is told, and the document written. */
  changed(a: ControlActivity | null): void;
  /** Nothing is asked while this says no (the account is gone, its key refused). */
  mayAsk(): boolean;
  newId(now: number): string;
  now?: () => number;
  setTimeout?: (f: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
}

export interface Unheard {
  /** A send nobody heard the answer to: its row, as the page is shown it. */
  add(
    m: MachineRow,
    body: Record<string, unknown>,
    cmd: ControlCommand,
    said: Extract<Sent, { kind: "unknown" }>,
    at: { askedAt: number; floor: number },
    from?: string,
  ): ControlActivity;
  /** The send that holds `cmd` back: one of the same kind for the same session of the same
   *  machine that is still unknown (a start: for the same machine with the same words). */
  holding(machineId: string, cmd: ControlCommand): UnheardKept | undefined;
  /** Every row kept, newest first. */
  activity(): ControlActivity[];
  /** What the document keeps. */
  kept(): UnheardKept[];
  /** Ask now (spacesheep can be reached again, the machines are listed). */
  kick(): void;
  stop(): void;
}

const parse = (cmd: string | undefined): ControlCommand | null => {
  try {
    const c = JSON.parse(String(cmd)) as ControlCommand | null;
    return c && typeof c === "object" && !Array.isArray(c) ? c : null;
  } catch {
    return null;
  }
};

/** The rows a kept document holds, or none when it holds none that read. */
export function readUnheard(raw: unknown): UnheardKept[] {
  const list = (raw as { unheard?: unknown } | null)?.unheard;
  if (!Array.isArray(list)) return [];
  return (
    list
      .filter(
        (u): u is UnheardKept =>
          !!u &&
          typeof u === "object" &&
          !!(u as UnheardKept).row &&
          typeof (u as UnheardKept).row.id === "string" &&
          typeof (u as UnheardKept).row.machineId === "string" &&
          typeof (u as UnheardKept).askedAt === "number" &&
          ["asking", "unsent", "unknown"].includes((u as UnheardKept).state),
      )
      // One kept without where its send began is looked for from the start of the list.
      .map((u) => (typeof u.floor === "number" && u.floor >= 0 ? u : { ...u, floor: 0 }))
  );
}

/** A row as the page reads it. */
export function unheardActivity(u: UnheardKept): ControlActivity {
  const a = toActivity(u.row);
  const at = u.settledAt ? new Date(u.settledAt).toISOString() : undefined;
  if (u.state === "asking")
    return { ...a, code: SEND_UNKNOWN_CODE, detail: cleanReason(u.why), unheard: { state: "asking" } };
  if (u.state === "unknown")
    return {
      ...a,
      outcome: "unconfirmed",
      code: SEND_UNKNOWN_CODE,
      detail: cleanReason(u.why),
      ...(at ? { ackedAt: at } : {}),
      unheard: { state: "unknown" },
    };
  const r = u.refusal ?? { status: 502, reason: u.why };
  const detail = cleanReason(r.detail ?? r.reason);
  return {
    ...a,
    outcome: "failed",
    ...(r.code && REMOTE_CODE_RE.test(r.code) ? { code: r.code } : {}),
    ...(detail ? { detail } : {}),
    ...(at ? { ackedAt: at } : {}),
    unheard: { state: "unsent", status: r.status, reason: cleanReason(r.reason) },
  };
}

export function openUnheard(o: UnheardOptions): Unheard {
  const now = o.now ?? (() => Date.now());
  const later = o.setTimeout ?? ((f: () => void, ms: number) => setTimeout(f, ms));
  const cancel = o.clearTimeout ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const rows = new Map<string, UnheardKept>();
  for (const u of o.kept ?? []) rows.set(u.row.id, u);
  /** Per row: the askings made in this launch, and the timer of the next. */
  const tries = new Map<string, number>();
  const timers = new Map<string, unknown>();
  const busy = new Set<string>();
  let stopped = false;

  const trim = (): void => {
    const t = now();
    for (const [id, u] of rows)
      if (u.state !== "asking" && t - (u.settledAt ?? u.askedAt) > UNHEARD_KEEP_MS) rows.delete(id);
    const settled = [...rows.values()]
      .filter((u) => u.state !== "asking")
      .sort((a, b) => (a.row.id < b.row.id ? -1 : 1));
    while (rows.size > UNHEARD_MAX && settled.length) rows.delete(settled.shift()!.row.id);
  };
  const settle = (u: UnheardKept, state: "unsent" | "unknown"): void => {
    u.state = state;
    u.settledAt = now();
    delete u.body;
    const t = timers.get(u.row.id);
    if (t) cancel(t);
    timers.delete(u.row.id);
    o.changed(unheardActivity(u));
  };
  const schedule = (u: UnheardKept): void => {
    if (stopped || u.state !== "asking" || timers.has(u.row.id)) return;
    const n = tries.get(u.row.id) ?? 0;
    const wait = UNHEARD_WAITS_MS[Math.min(n, UNHEARD_WAITS_MS.length - 1)]!;
    timers.set(
      u.row.id,
      later(() => {
        timers.delete(u.row.id);
        void ask(u);
      }, wait),
    );
  };
  const ask = async (u: UnheardKept): Promise<void> => {
    if (stopped || u.state !== "asking" || busy.has(u.row.id) || !rows.has(u.row.id)) return;
    if (!o.mayAsk()) return schedule(u);
    // Nobody could say for a week: nobody will.
    if (now() - u.askedAt > UNHEARD_GIVE_UP_MS) return settle(u, "unknown");
    const m = o.machine(u.row.machineId);
    const cmd = parse(u.body?.cmd);
    busy.add(u.row.id);
    tries.set(u.row.id, (tries.get(u.row.id) ?? 0) + 1);
    try {
      if (!u.dead && u.body && cmd && m) {
        const said = await o.doors.ask({ id: u.row.machineId }, u.body, {
          again: true,
          askedAt: u.askedAt,
          floor: u.floor,
        });
        if (stopped || !rows.has(u.row.id)) return;
        if (said.kind === "sent") {
          rows.delete(u.row.id);
          const t = timers.get(u.row.id);
          if (t) cancel(t);
          timers.delete(u.row.id);
          o.adopt(u, cmd, said.job);
          return o.changed(null);
        }
        if (said.kind === "refused") {
          u.refusal = o.refused(u, said.status, said.json);
          return settle(u, "unsent");
        }
        u.why = said.why || u.why;
        if (said.dead) {
          u.dead = true;
          // Of the bytes, only the command is needed from here on.
          u.body = { cmd: u.body.cmd };
          o.changed(null);
        }
      }
      if (u.dead) {
        if (!u.body) return settle(u, "unknown");
        const l = await o.doors.look({ id: u.row.machineId }, u.body, u.askedAt, u.floor);
        if (stopped || !rows.has(u.row.id)) return;
        // The list is longer than a look reads: it will say no more the next time. Nobody can
        // say, for good; one look, never a loop.
        if (l.more) return settle(u, "unknown");
        // It could not be read: tried again, a bounded number of times.
        if (!l.read) {
          u.looks = (u.looks ?? 0) + 1;
          if (u.looks >= UNHEARD_LOOKS_MAX) return settle(u, "unknown");
          return void o.changed(null);
        }
        // Read from where the send began to the list's end, it holds nothing this send could
        // have become, and nothing more can come: that, and only that, is not sent.
        if (l.told && l.fits.length === 0) {
          u.refusal = { status: 422, reason: u.why, code: "too_old" };
          return settle(u, "unsent");
        }
        // It lists something this send may be, or cannot tell: nobody can say.
        return settle(u, "unknown");
      }
      // The bytes cannot be asked again (not read back): nobody can say.
      if (!u.body || !cmd) return settle(u, "unknown");
    } catch (e) {
      console.error("[account] a send nobody heard: %s", (e as Error)?.message ?? e);
    } finally {
      busy.delete(u.row.id);
      if (u.state === "asking" && rows.has(u.row.id)) schedule(u);
    }
  };

  trim();
  for (const u of rows.values()) if (u.state === "asking") schedule(u);

  return {
    add(m, body, cmd, said, { askedAt, floor }, from) {
      const t = now();
      const row = messageRow(m, { cmd: "" }, cmd, {
        via: "ui",
        ...(from ? { from } : {}),
        id: o.newId(t),
        now: askedAt,
      });
      const u: UnheardKept = {
        row,
        state: "asking",
        why: said.why,
        askedAt,
        floor,
        body: {
          cmd: String(body.cmd),
          csig: body.csig ?? null,
          grant: body.grant ?? null,
          confirm: body.confirm ?? null,
        },
        ...(said.dead ? { dead: true } : {}),
      };
      rows.set(row.id, u);
      trim();
      // The askings made as it was sent count: the next is a while off.
      tries.set(row.id, 0);
      const a = unheardActivity(u);
      o.changed(a);
      if (said.dead) void ask(u);
      else schedule(u);
      return a;
    },
    holding(machineId, cmd) {
      for (const u of rows.values()) {
        if (u.state !== "asking" || u.row.machineId !== machineId || u.row.kind !== cmd.kind) continue;
        if (cmd.kind === "start" ? u.row.text === (cmd as { text?: string }).text : u.row.session === cmd.session)
          return u;
      }
      return undefined;
    },
    activity: () => [...rows.values()].map(unheardActivity).sort((a, b) => (a.id < b.id ? 1 : -1)),
    kept: () => [...rows.values()],
    kick() {
      for (const u of rows.values()) {
        if (u.state !== "asking") continue;
        const t = timers.get(u.row.id);
        if (t) cancel(t);
        timers.delete(u.row.id);
        void ask(u);
      }
    },
    stop() {
      stopped = true;
      for (const t of timers.values()) cancel(t);
      timers.clear();
    },
  };
}
