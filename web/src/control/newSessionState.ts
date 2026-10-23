// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The New session sheet's state outside React (STEER-SPEC B.2, B.3):
// whether it is open and with what prefill, the board's context (its filter), which
// machine a plain "New session…" means, what each machine was last started with on this
// device (pruned to what it still advertises), and the draft. Every storage read and
// write is wrapped: a private window, or a page that cannot store, still starts sessions.
// The pure parts (`pickContext`, `pruneRemembered`, `aliasHidden`) are tested.
import type { ControlActivity, MachineControl, StartFile, StartPermission } from "@shared/api";
import { useSyncExternalStore } from "react";
import { expandHome, typedFolder } from "./folders";

/** What an entry point knows: "here" is a session's machine, agent and folder. */
export interface NewSessionTarget {
  machine?: string;
  harness?: string;
  /** Absolute, or `~/…` as events report it (expanded with the machine's home). */
  cwd?: string;
  text?: string;
  permission?: StartPermission;
  model?: string;
  files?: StartFile[];
}

interface OpenState {
  open: boolean;
  target: NewSessionTarget;
  /** Bumped on every open, so the sheet takes the new prefill even when already open. */
  seq: number;
}

let state: OpenState = { open: false, target: {}, seq: 0 };
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function openNewSession(target: NewSessionTarget = {}): void {
  state = { open: true, target, seq: state.seq + 1 };
  emit();
}
export function closeNewSession(): void {
  if (!state.open) return;
  state = { ...state, open: false };
  emit();
}
export const newSessionOpen = (): boolean => state.open;

export function useNewSession(): OpenState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

// ----- the board's context (its machine and harness filter) -----

let boardFilter: { machine?: string; harness?: string } = {};
/** The board says which machine and harness it is filtered to (each one value, or none). */
export function setBoardFilter(f: { machine?: string; harness?: string }): void {
  boardFilter = { ...(f.machine ? { machine: f.machine } : {}), ...(f.harness ? { harness: f.harness } : {}) };
}
export const getBoardFilter = () => boardFilter;

// ----- storage -----

export const LAST_KEY = "sp.newSession.last";
export const BY_MACHINE_KEY = "sp.newSession.byMachine";
export const DRAFT_KEY = "sp.newSession.draft";

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, v: unknown): void {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Nowhere to keep it: the next open starts from the board's context.
  }
}

export interface Remembered {
  harness?: string;
  cwd?: string;
  permission?: StartPermission;
  model?: string;
}

export const readLast = (): { machine: string; harness?: string } | null => {
  const v = read<{ machine?: unknown; harness?: unknown }>(LAST_KEY);
  return v && typeof v.machine === "string"
    ? { machine: v.machine, ...(typeof v.harness === "string" ? { harness: v.harness } : {}) }
    : null;
};

export function readRemembered(machineId: string): Remembered {
  const all = read<Record<string, Remembered>>(BY_MACHINE_KEY);
  const r = all && typeof all === "object" ? all[machineId] : undefined;
  return r && typeof r === "object" ? r : {};
}

/** After a start: the machine is the next "New session…"'s, and its choices are kept. */
export function rememberStart(machine: string, machineId: string, r: Remembered): void {
  write(LAST_KEY, { machine, ...(r.harness ? { harness: r.harness } : {}) });
  const all = read<Record<string, Remembered>>(BY_MACHINE_KEY) ?? {};
  all[machineId] = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as Remembered;
  write(BY_MACHINE_KEY, all);
}

export interface Draft {
  machine?: string;
  harness?: string;
  /** What the folder field holds: a choice's absolute path, or text typed by hand. */
  folder?: string;
  text: string;
  permission?: StartPermission;
  model?: string;
  /** Uploaded already (held here a day), so a restored draft can still send them. */
  files?: StartFile[];
}

export function readDraft(): Draft | null {
  const d = read<Draft>(DRAFT_KEY);
  return d && typeof d === "object" && typeof d.text === "string" ? d : null;
}
export function saveDraft(d: Draft | null): void {
  const empty = !d || (!d.text.trim() && !d.files?.length);
  write(DRAFT_KEY, empty ? null : d);
}

// ----- which machine, and what it still offers -----

export interface ContextInput {
  target?: NewSessionTarget;
  /** The board's filter. */
  filter?: { machine?: string; harness?: string };
  last?: { machine: string; harness?: string } | null;
  /** The sessions the store holds (machine and when it was last heard from). */
  sessions: readonly { machine?: string; harness?: string; lastAt: string }[];
  /** The machines a start can go to (paired here), in the sheet's order. */
  machines: readonly string[];
}

/** The sheet's machine and agent when it opens: an explicit target, then a board filter
 *  of one value, then this device's last start, then the machine with the most recent
 *  session, then the first machine. A name that is not a paired machine is passed over. */
export function pickContext(o: ContextInput): { machine?: string; harness?: string } {
  const ok = (m: string | undefined): m is string => !!m && o.machines.includes(m);
  const t = o.target ?? {};
  if (ok(t.machine)) return { machine: t.machine, ...(t.harness ? { harness: t.harness } : {}) };
  const harness = t.harness ?? o.filter?.harness;
  const withHarness = (machine: string, fallback?: string) => ({
    machine,
    ...(harness ? { harness } : fallback ? { harness: fallback } : {}),
  });
  if (ok(o.filter?.machine)) return withHarness(o.filter.machine);
  if (o.last && ok(o.last.machine)) return withHarness(o.last.machine, o.last.harness);
  let best: { machine: string; at: string } | null = null;
  for (const s of o.sessions)
    if (ok(s.machine) && (!best || s.lastAt > best.at)) best = { machine: s.machine, at: s.lastAt };
  if (best) return withHarness(best.machine);
  return o.machines[0] ? withHarness(o.machines[0]) : harness ? { harness } : {};
}

/** A remembered choice, less anything the machine no longer advertises: a harness not in
 *  its hello, a level not offered for that harness, a model where none is taken (or not
 *  on a closed list), a folder it would not allow. */
export function pruneRemembered(r: Remembered, c: MachineControl, machine: string): Remembered {
  const out: Remembered = {};
  const harness = r.harness && c.harnesses?.includes(r.harness) ? r.harness : undefined;
  if (harness) out.harness = harness;
  const opts = harness ? c.start?.[harness] : undefined;
  if (r.permission && opts?.permissions.includes(r.permission)) out.permission = r.permission;
  if (r.model && opts && (opts.anyModel || opts.models?.includes(r.model))) out.model = r.model;
  if (r.cwd) {
    const abs = expandHome(r.cwd, c.home);
    if (abs && typedFolder(abs, { folders: c.folders, home: c.home, machine }).ok) out.cwd = abs;
  }
  return out;
}

/** The Codex / Antigravity alias window (STEER-SPEC B.5): for 30 s after a start, a new
 *  session on the same machine, harness and folder that has no title of its own and is not
 *  the start's key is the same run under the harness's own id; the board hides it (its
 *  events still reach the store) until the window passes. Nothing is merged. */
export const ALIAS_WINDOW_MS = 30_000;
export function aliasHidden(
  s: { key: string; harness: string; machine?: string; cwd?: string; title?: string; startedAt?: string },
  starts: readonly ControlActivity[],
  machineIdOf: (name: string | undefined) => string | undefined,
  home: (machineId: string) => string | undefined,
  now: number,
): boolean {
  if (s.title) return false;
  const id = machineIdOf(s.machine);
  if (!id || !s.cwd) return false;
  for (const a of starts) {
    if (a.kind !== "start" || a.machineId !== id || !a.session || a.session === s.key) continue;
    if (now - Date.parse(a.at) > ALIAS_WINDOW_MS) continue;
    if (a.session.slice(0, a.session.indexOf(":")) !== s.harness) continue;
    const cwd = expandHome(s.cwd, home(id)) ?? s.cwd;
    if (a.cwd && cwd === a.cwd) return true;
  }
  return false;
}

// ----- what a machine offers, in the picker's words -----

const shortVersion = (v: string | undefined): string | undefined => /^(\d+\.\d+)/.exec(v ?? "")?.[1];

/** A machine's row in the Machine picker, the facts that make the choice informed
 *  (STEER-SPEC B.3): at the right how it starts sessions ("auto", "safe mode", "0.9 · no
 *  model choice" for a daemon whose hello has no `start`, or "offline"), and under the
 *  name the agents it runs. */
export function machineFacts(
  c: MachineControl | undefined,
  label: (h: string) => string,
): { hint?: string; detail?: string } {
  if (!c) return {};
  const detail = c.harnesses?.length ? c.harnesses.map(label).join(", ") : undefined;
  if (!c.online) return { hint: "offline", ...(detail ? { detail } : {}) };
  const hint = !c.start
    ? `${shortVersion(c.version) ?? "older"} · no model choice`
    : c.mode === "safe"
      ? "safe mode"
      : c.mode === "auto"
        ? "auto"
        : undefined;
  return { ...(hint ? { hint } : {}), ...(detail ? { detail } : {}) };
}

/** The Permission row when the machine shows no pop-up for it: the one level a start
 *  gets there, or that it is set at the machine (and its mode, when the hello said), so
 *  the row keeps its place on every machine. Null when a pop-up is shown. */
export function fixedPermission(
  c: MachineControl | undefined,
  harness: string | undefined,
  label: Record<string, string>,
): string | null {
  const opts = harness ? c?.start?.[harness] : undefined;
  if (opts && opts.permissions.length >= 2) return null;
  if (opts?.permissions.length === 1) return label[opts.permissions[0]!] ?? opts.permissions[0]!;
  if (c?.mode === "safe") return "Safe mode, set at the machine";
  if (c?.mode === "auto") return "Auto mode, set at the machine";
  return "Set at the machine";
}
