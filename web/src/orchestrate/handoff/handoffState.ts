// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The Handoff sheet's state outside React, the way
// control/newSessionState.ts keeps New session's: whether it is open and for which
// session (with the turn it was opened from, when one), the draft a session's sheet was
// closed on, the agent each machine was last asked through, and which mounted host
// shows it (the session page's, or the panel's, when both hold the same session). Every
// storage read and write is wrapped: a private window still asks.
import type { SessionKey } from "@shared/api";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { navigate, sessionPath } from "../../lib/router";

/** What an entry point knows: the asking session, and the reply it was opened from (a
 *  turn's context menu hands the text; the strip and the menus leave it to the sheet,
 *  which reads the session's last reply). */
export interface HandoffTarget {
  session: SessionKey;
  turnSeq?: number;
  reply?: string;
}

interface OpenState {
  open: boolean;
  target: HandoffTarget | null;
  /** Bumped on every open, so the sheet takes the new prefill even when already open. */
  seq: number;
}

let state: OpenState = { open: false, target: null, seq: 0 };
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function openHandoff(target: HandoffTarget): void {
  state = { open: true, target, seq: state.seq + 1 };
  emit();
}
export function closeHandoff(): void {
  if (!state.open) return;
  state = { ...state, open: false };
  emit();
}
export const handoffOpen = (): boolean => state.open;

export function useHandoff(): OpenState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

// ----- the hosts: one per mounted session control; the first for a session shows the sheet -----

const hosts = new Map<SessionKey, symbol[]>();

/** Whether this host (the n-th mounted for `session`) is the one that shows the sheet:
 *  the session page and the split panel can both hold one session, and one sheet is
 *  enough. */
export function useHostLead(session: SessionKey): boolean {
  const me = useRef<symbol | null>(null);
  me.current ??= Symbol("handoff-host");
  const token = me.current;
  useEffect(() => {
    const list = hosts.get(session) ?? [];
    list.push(token);
    hosts.set(session, list);
    emit();
    return () => {
      const now = hosts.get(session) ?? [];
      const rest = now.filter((t) => t !== token);
      if (rest.length) hosts.set(session, rest);
      else hosts.delete(session);
      emit();
    };
  }, [session, token]);
  return useSyncExternalStore(
    subscribe,
    () => hosts.get(session)?.[0] === token,
    () => false,
  );
}

/** Opens the sheet for a session from any surface: when no session control of it is on
 *  the page (a board row, say), its page is opened first, and the sheet shows there. */
export function openHandoffFor(
  s: { key: SessionKey; harness: string; id: string },
  o: Omit<HandoffTarget, "session"> = {},
) {
  const path = sessionPath(s.harness, s.id);
  if (!hosts.has(s.key) && location.pathname !== path) navigate(path);
  openHandoff({ session: s.key, ...o });
}

// ----- storage -----

export const DRAFT_KEY = "sp.handoff.draft";
export const BY_MACHINE_KEY = "sp.handoff.byMachine";
/** Drafts kept, newest last; the oldest goes when there are more. */
export const DRAFTS_MAX = 20;

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
    // Nowhere to keep it: the next open starts from the last reply.
  }
}

/** What a session's sheet held when it was closed with Esc: the text and the choices
 *  the person touched. Kept only once something was edited, so an untouched prefill is
 *  read afresh from the newest reply next time. */
export interface HandoffDraft {
  text: string;
  /** `targetValue()` of the Agent picker. */
  target?: string;
  folder?: string;
  bringBack?: boolean;
  permission?: string;
  model?: string;
}

export function readHandoffDraft(session: SessionKey): HandoffDraft | null {
  const all = read<Record<string, HandoffDraft>>(DRAFT_KEY);
  const d = all && typeof all === "object" ? all[session] : undefined;
  return d && typeof d === "object" && typeof d.text === "string" ? d : null;
}
export function saveHandoffDraft(session: SessionKey, d: HandoffDraft | null): void {
  const all = read<Record<string, HandoffDraft>>(DRAFT_KEY) ?? {};
  delete all[session];
  if (d?.text.trim()) all[session] = d;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - DRAFTS_MAX))) delete all[k];
  write(DRAFT_KEY, Object.keys(all).length ? all : null);
}

/** The agent a machine was last asked through from here (a new session's harness), the
 *  Agent picker's default next time, like New session's `rememberStart`. */
export function readHandoffAgent(machineId: string): string | null {
  const all = read<Record<string, { harness?: unknown }>>(BY_MACHINE_KEY);
  const h = all && typeof all === "object" ? all[machineId]?.harness : undefined;
  return typeof h === "string" ? h : null;
}
export function rememberHandoffAgent(machineId: string, harness: string): void {
  const all = read<Record<string, { harness: string }>>(BY_MACHINE_KEY) ?? {};
  all[machineId] = { harness };
  write(BY_MACHINE_KEY, all);
}
