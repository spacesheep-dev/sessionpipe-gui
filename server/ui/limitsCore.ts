// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. Each account's usage limits (shared/api.ts LimitsEntry): the
// newest limits.observed per (harness, session.account_id), or per machine when the events
// carry no account id (Codex). The numbers belong to the account, not to a session, so
// they live beside the store rather than on a SessionSummary: forgetting a session keeps
// them. Where they are kept is their opener's (docKeep.ts): the receiver's is
// <stateDir>/limits.json (limits.ts LimitsStore); nothing here is Node's. It follows the store's `event` messages, so it sees
// only what the store accepted (the receiver's and the outbox's alike), and every change
// goes to every page as one `limits` frame with the whole list. Demo numbers stay in
// memory and go when demo mode does, so a real receiver keeps no pretend accounts.
// A pooled account (DESIGN §2.3) is keyed by the event's `data.account_id` when it has
// one, the account that served the request, else by the session's own; and a hello's
// `pool.accounts[].windows`, the daemon's freshest numbers for an idle account, feed the
// same entries, dated by the hello (followControl).
import {
  LIMIT_WINDOWS_MAX,
  LIMITS_MACHINES_MAX,
  LIMITS_MAX,
  type LimitsEntry,
  type LimitWindow,
  type MachineSummary,
  type StoredEvent,
  type StreamMessage,
} from "../../shared/api.js";
import { DEMO_MACHINE } from "../control/rows.js";
import type { DocKeep } from "./docKeep.js";

const WINDOW_ID = /^[a-z0-9_]{1,64}$/;
const HARNESS = /^[a-z][a-z0-9-]{0,39}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const CONTROL = /[\u0000-\u001f\u007f]/;
/** used_percent's ceiling: a spend limit passed a hundredfold is still a number. */
const USED_MAX = 10_000;
const PLAN_MAX = 64;

export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const isTime = (v: unknown): v is string => typeof v === "string" && RFC3339.test(v) && Number.isFinite(Date.parse(v));

/** One window as the event or the file has it (`used_percent` or `usedPercent`), or null
 *  when it does not validate. An absent or null resets_at / window_minutes is not known. */
function readWindow(w: unknown): LimitWindow | null {
  if (!w || typeof w !== "object") return null;
  const o = w as Record<string, unknown>;
  const id = o.id;
  const used = o.used_percent ?? o.usedPercent;
  const resets = o.resets_at ?? o.resetsAt;
  const minutes = o.window_minutes ?? o.windowMinutes;
  if (typeof id !== "string" || !WINDOW_ID.test(id)) return null;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > USED_MAX) return null;
  if (resets != null && !isTime(resets)) return null;
  if (minutes != null && !(Number.isInteger(minutes) && (minutes as number) > 0)) return null;
  return {
    id,
    usedPercent: used,
    ...(resets != null ? { resetsAt: new Date(resets as string).toISOString() } : {}),
    ...(minutes != null ? { windowMinutes: minutes as number } : {}),
  };
}

/** The windows that validate, in their order, the first of an id only, at most
 *  LIMIT_WINDOWS_MAX; a bad one is skipped, not the event. */
export function readWindows(raw: unknown): LimitWindow[] {
  if (!Array.isArray(raw)) return [];
  const out: LimitWindow[] = [];
  for (const w of raw) {
    const ok = readWindow(w);
    if (ok && !out.some((x) => x.id === ok.id)) out.push(ok);
    if (out.length >= LIMIT_WINDOWS_MAX) break;
  }
  return out;
}

const readPlan = (v: unknown): string | undefined => {
  const p = typeof v === "string" ? v.trim() : "";
  return p && p.length <= PLAN_MAX && !CONTROL.test(p) ? p : undefined;
};

/** An event's time, never after its arrival (the store's clampTime); with no time, the
 *  arrival itself. */
function clamp(time: string, arrivedAt: string | undefined): string {
  const t = Date.parse(time);
  const a = arrivedAt ? Date.parse(arrivedAt) : Date.now();
  if (!Number.isFinite(t)) return new Date(a).toISOString();
  return new Date(Math.min(t, a)).toISOString();
}

export class LimitsCore {
  /** What is kept: every entry a real sender reported. */
  private real: Map<string, LimitsEntry>;
  /** The demo's, over the real ones, in memory only. */
  private readonly demo = new Map<string, LimitsEntry>();
  private readonly listeners = new Set<(m: StreamMessage) => void>();

  constructor(private readonly keep: DocKeep) {
    this.real = this.load();
  }

  /** Every entry, in key order (the page orders them its own way). */
  list(): LimitsEntry[] {
    const all = new Map(this.real);
    for (const [k, e] of this.demo) all.set(k, e);
    return [...all.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** One accepted event. A limits.observed with a window that validates replaces its
   *  entry's windows and plan, unless an entry reported later is there. `machine`: the
   *  session's, when the event's block leaves it out. The account is the event's
   *  `data.account_id` when the pool set one (the account that served the request), else
   *  the session's own. Returns whether anything changed. */
  observe(ev: StoredEvent, machine?: string): boolean {
    if (ev.type !== "limits.observed" || !ev.data || typeof ev.data !== "object") return false;
    const windows = readWindows(ev.data.windows);
    const where = str(ev.session.machine) ?? machine;
    if (!windows.length || !where) return false;
    const account = str(ev.data.account_id) ?? str(ev.session.account_id);
    return this.put({
      harness: ev.harness.name,
      account,
      machine: where,
      windows,
      plan: readPlan(ev.data.plan),
      observedAt: clamp(ev.time, ev.arrivedAt),
      arrived: clamp("", ev.arrivedAt),
      demo: ev.source === "demo",
    });
  }

  /** A machine's hello (MachineControl, from the control stream): each pooled account's
   *  windows, dated by the hello. The same newest-wins rule as an event's, so a session's
   *  own report a minute ago is not replaced by an idle poll from before it. A demo
   *  machine's (ids under DEMO_MACHINE) stay in memory like the demo's events. */
  observeMachine(m: MachineSummary): boolean {
    const pool = m.control?.pool;
    if (!pool || !m.control?.lastHelloAt) return false;
    const observedAt = clamp(m.control.lastHelloAt, undefined);
    const demo = m.control.machineId.startsWith(DEMO_MACHINE);
    let changed = false;
    for (const a of pool.accounts) {
      if (!a.windows?.length) continue;
      if (
        this.put({
          harness: pool.harness,
          account: a.id,
          machine: m.name,
          windows: a.windows,
          observedAt,
          arrived: clamp("", undefined),
          demo,
        })
      )
        changed = true;
    }
    return changed;
  }

  private put(r: {
    harness: string;
    account: string | undefined;
    machine: string;
    windows: LimitWindow[];
    plan?: string;
    observedAt: string;
    arrived: string;
    demo: boolean;
  }): boolean {
    const key = r.account ? `${r.harness} a:${r.account}` : `${r.harness} m:${r.machine}`;
    const have = r.demo ? (this.demo.get(key) ?? this.real.get(key)) : this.real.get(key);
    // Newest wins, by the report's time. An entry dated after this very arrival was dated by
    // this machine's clock before it went back (or comes from the file of such a run): it
    // is newer than nothing, or it would hold every report off until that time.
    if (have && r.observedAt < have.observedAt && have.observedAt <= r.arrived) return false;
    // A hello's windows carry no plan: the one already known for the account stays.
    const plan = r.plan ?? have?.plan;
    const next: LimitsEntry = {
      key,
      harness: r.harness,
      ...(r.account ? { accountId: r.account } : {}),
      machine: r.machine,
      machines: [r.machine, ...(have?.machines ?? []).filter((m) => m !== r.machine)].slice(0, LIMITS_MACHINES_MAX),
      ...(plan ? { plan } : {}),
      windows: r.windows,
      observedAt: r.observedAt,
    };
    // A real report wins over the demo's for the same key; the demo's never reaches the file.
    const map = r.demo ? this.demo : this.real;
    const shadowed = !r.demo && this.demo.has(key);
    if (!shadowed && JSON.stringify(map.get(key)) === JSON.stringify(next)) return false;
    map.set(key, next);
    if (shadowed) this.demo.delete(key);
    cap(map);
    if (!r.demo) this.save();
    this.emit();
    return true;
  }

  /** "Forget these numbers": the entry goes until its next report. False when unknown. */
  forget(key: string): boolean {
    const real = this.real.delete(key);
    const demo = this.demo.delete(key);
    if (!real && !demo) return false;
    if (real) this.save();
    this.emit();
    return true;
  }

  /** Demo mode stopped: its numbers go with it. */
  dropDemo(): void {
    if (!this.demo.size) return;
    this.demo.clear();
    this.emit();
  }

  /** Follow the store: each accepted event, read for its limits. */
  follow(store: { subscribe(l: (m: StreamMessage) => void): () => void }): () => void {
    return store.subscribe((m) => {
      if (m.kind === "event" && m.event.type === "limits.observed") this.observe(m.event, m.session.machine);
    });
  }

  /** Follow the control channel: each machine frame (a hello landed, or a poll), read for
   *  its pooled accounts' windows. */
  followControl(control: { subscribe(l: (m: StreamMessage) => void): () => void }): () => void {
    return control.subscribe((m) => {
      if (m.kind === "machine") this.observeMachine(m.machine);
    });
  }

  subscribe(l: (m: StreamMessage) => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private emit(): void {
    const limits = this.list();
    for (const l of this.listeners) {
      try {
        l({ kind: "limits", limits });
      } catch (e) {
        console.error("[limits] listener: %s", (e as Error).message);
      }
    }
  }

  /** Kept whole, like the labels. A failed write keeps the numbers in memory and says so;
   *  the next report writes again. */
  private save(): void {
    try {
      this.keep.save({ version: 1, entries: [...this.real.values()] });
    } catch (e) {
      console.error("[limits] write: %s", (e as Error).message);
    }
  }

  /** What was kept, as it is; with nothing kept it is empty, a broken one is set aside
   *  (never lost) and read as empty. Entries that do not validate are dropped. */
  private load(): Map<string, LimitsEntry> {
    const out = new Map<string, LimitsEntry>();
    try {
      const raw = this.keep.load() as { entries?: unknown } | undefined;
      if (raw === undefined) return out;
      for (const e of Array.isArray(raw.entries) ? raw.entries : []) {
        const entry = readEntry(e);
        if (entry) out.set(entry.key, entry);
      }
      cap(out);
      return out;
    } catch {
      this.keep.setAside?.();
      return new Map();
    }
  }
}

/** An entry from the file, or null. Its key is made again from what it holds. */
function readEntry(raw: unknown): LimitsEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const harness = str(o.harness);
  const machine = str(o.machine);
  const accountId = str(o.accountId);
  const windows = readWindows(o.windows);
  if (!harness || !HARNESS.test(harness) || !machine || !windows.length || !isTime(o.observedAt)) return null;
  const machines = Array.isArray(o.machines) ? o.machines.filter((m): m is string => !!str(m)) : [];
  const plan = readPlan(o.plan);
  return {
    key: accountId ? `${harness} a:${accountId}` : `${harness} m:${machine}`,
    harness,
    ...(accountId ? { accountId } : {}),
    machine,
    machines: [machine, ...machines.filter((m) => m !== machine)].slice(0, LIMITS_MACHINES_MAX),
    ...(plan ? { plan } : {}),
    windows,
    observedAt: new Date(o.observedAt as string).toISOString(),
  };
}

/** LIMITS_MAX at most: past it, the entry reported longest ago goes. */
function cap(map: Map<string, LimitsEntry>): void {
  while (map.size > LIMITS_MAX) {
    let oldest: LimitsEntry | undefined;
    for (const e of map.values()) if (!oldest || e.observedAt < oldest.observedAt) oldest = e;
    if (!oldest) return;
    map.delete(oldest.key);
  }
}
