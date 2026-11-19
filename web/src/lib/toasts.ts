// SPDX-License-Identifier: Apache-2.0
// Owned by: web. In-app toasts: the list the stack (components/Toasts.tsx) renders, and
// the rules of the list. A toast for an open attention stays until it is acted on,
// dismissed or the attention clears; the rest leave after TOAST_MS. Never more than
// TOAST_MAX: the oldest leaving-by-itself one goes first. Each toast plays the sound of
// its moment (lib/sounds.ts) once, when it arrives. Control messages this page sent are
// remembered here so their `delivered` never toasts back at the person who sent them.
// An undo toast ("Hidden · Undo") follows an action that went through at once instead of
// asking first; it lasts UNDO_MS, and ⌘Z (the keymap's `undo`) runs the newest one.
// The stack holds still while it is in use (holdToasts): a pointer over it, keyboard focus
// in it, the window hidden, a finger on a phone's banner. Then no timer runs and a new
// toast waits (its sound plays as it arrives); on release each timer goes on with what it
// had left, never less than HOLD_FLOOR_MS, and the waiting ones come in.
import type { SessionKey } from "@shared/api";
import { useSyncExternalStore } from "react";
import { playSound, type SoundKind } from "./sounds";

export const TOAST_MS = 8000;
export const TOAST_MAX = 3;

export const UNDO_MS = 6000;

/** What a timer has at least once a hold lets go: nothing leaves the moment a hand does. */
export const HOLD_FLOOR_MS = 2000;

export type ToastKind = "needs-you" | "error" | "delivered" | "undo";

export interface Toast {
  id: string;
  kind: ToastKind;
  /** Stays until acted on or dismissed (an open attention); else leaves after TOAST_MS. */
  sticky: boolean;
  session?: SessionKey;
  /** The attention this toast is about; the stack drops it when the attention clears. */
  attentionId?: string;
  /** Allow / Deny on the toast: a control answer can reach the prompt. */
  answerable?: boolean;
  title: string;
  /** What happened, the banner's first words: "Needs you", "Failed", "Started". */
  verb?: string;
  /** For assistive tech: "permission", "error", "delivered"… */
  label: string;
  tool?: string;
  body?: string;
  machine?: string;
  /** None for an undo: the person just did it. */
  sound?: SoundKind;
  at: number;
  /** An undo toast's way back. */
  undo?: () => void;
  /** How long it stays when it leaves by itself (TOAST_MS unless set). */
  ms?: number;
}

let toasts: readonly Toast[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** When each running timer ends (ms since the epoch). */
const due = new Map<string, number>();
/** What each timer has left while the stack is held. */
const left = new Map<string, number>();
/** Pushed while held: shown on release, oldest first. */
let waiting: Toast[] = [];
export type HoldWhy = "pointer" | "focus" | "hidden" | "finger";
const holds = new Set<HoldWhy>();
const commit = (next: readonly Toast[]) => {
  toasts = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(
    subscribe,
    () => toasts,
    () => toasts,
  );
}

/** The toasts shown now, outside React. */
export const peekToasts = (): readonly Toast[] => toasts;

/** Whether the stack is held (holdToasts): for the stack, which then keeps a leaving
 *  card's room until release. */
export function useToastsHeld(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => holds.size > 0,
    () => false,
  );
}

const forget = (id: string) => {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  due.delete(id);
  left.delete(id);
};
const arm = (id: string, ms: number) => {
  forget(id);
  due.set(id, Date.now() + ms);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), ms),
  );
};

export function dismissToast(id: string): void {
  forget(id);
  waiting = waiting.filter((x) => x.id !== id);
  if (toasts.some((x) => x.id === id)) commit(toasts.filter((x) => x.id !== id));
}

/** The list with `toast` in it (in place when its id is there), never more than TOAST_MAX:
 *  the oldest leaving-by-itself one goes first. */
function place(list: readonly Toast[], toast: Toast): readonly Toast[] {
  let next = list.some((x) => x.id === toast.id) ? list.map((x) => (x.id === toast.id ? toast : x)) : [...list, toast];
  while (next.length > TOAST_MAX) {
    const victim = next.find((x) => !x.sticky) ?? next[0]!;
    forget(victim.id);
    next = next.filter((x) => x !== victim);
  }
  return next;
}

/** Adds one toast (oldest first in the list) and plays its sound. A toast with the same
 *  id is replaced in place, with no second sound. While the stack is held a new one waits,
 *  its sound already played. */
export function pushToast(toast: Toast): void {
  if (toasts.some((x) => x.id === toast.id)) {
    commit(place(toasts, toast));
    return;
  }
  const queued = waiting.some((x) => x.id === toast.id);
  if (queued) waiting = waiting.map((x) => (x.id === toast.id ? toast : x));
  else if (holds.size > 0) waiting = [...waiting, toast];
  else {
    commit(place(toasts, toast));
    if (!toast.sticky) arm(toast.id, toast.ms ?? TOAST_MS);
  }
  if (!queued && toast.sound) void playSound(toast.sound);
}

/** Holds the stack for `why` (`on`), or lets go of it. The first hold stops every timer
 *  where it is; the last release starts each again with what it had left, at least
 *  HOLD_FLOOR_MS, and brings in the toasts that waited. */
export function holdToasts(why: HoldWhy, on: boolean): void {
  const was = holds.size > 0;
  if (on) holds.add(why);
  else holds.delete(why);
  const now = holds.size > 0;
  if (was === now) return;
  if (now) {
    const at = Date.now();
    for (const [id, t] of timers) {
      clearTimeout(t);
      left.set(id, Math.max(0, (due.get(id) ?? at) - at));
    }
    timers.clear();
    due.clear();
    for (const l of listeners) l();
    return;
  }
  const paused = [...left];
  left.clear();
  for (const [id, ms] of paused) arm(id, Math.max(ms, HOLD_FLOOR_MS));
  const came = waiting;
  waiting = [];
  let next = toasts;
  for (const t of came) next = place(next, t);
  if (next !== toasts) commit(next);
  else for (const l of listeners) l();
  for (const t of came) if (!t.sticky && next.includes(t)) arm(t.id, t.ms ?? TOAST_MS);
}

/** Drops every toast about a session, the moment it is opened by any path. */
export function dismissForSession(key: string): void {
  for (const t of [...toasts, ...waiting]) if (t.session === key && t.kind !== "undo") dismissToast(t.id);
}

let undoSeq = 0;
/** "Hidden · Undo": the action already happened; this is the way back for UNDO_MS. A
 *  second undo toast for the same thing (`id`) replaces the first. */
export function pushUndo(o: {
  id?: string;
  title: string;
  body?: string;
  session?: SessionKey;
  undo: () => void;
}): void {
  const id = `undo|${o.id ?? ++undoSeq}`;
  dismissToast(id);
  pushToast({
    id,
    kind: "undo",
    sticky: false,
    session: o.session,
    title: o.title,
    label: "undo",
    body: o.body,
    at: Date.now(),
    undo: o.undo,
    ms: UNDO_MS,
  });
}

/** Runs one undo toast's way back and takes the toast away. */
export function runUndo(id: string): boolean {
  const t = toasts.find((x) => x.id === id) ?? waiting.find((x) => x.id === id);
  if (!t?.undo) return false;
  dismissToast(id);
  t.undo();
  return true;
}

/** ⌘Z: the newest undo still on screen (or waiting for a hold to end). False when there
 *  is none. */
export function undoLatest(): boolean {
  const t = [...toasts, ...waiting].reverse().find((x) => x.kind === "undo");
  return t ? runUndo(t.id) : false;
}

/** Drops the attention toasts whose attention is no longer open (`keep` is the set of
 *  `${session}|${attentionId}` still open). */
export function pruneAttentionToasts(keep: ReadonlySet<string>): void {
  const open = (t: Toast) => !t.attentionId || keep.has(`${t.session}|${t.attentionId}`);
  waiting = waiting.filter(open);
  const next = toasts.filter(open);
  if (next.length !== toasts.length) {
    for (const t of toasts) if (!next.includes(t)) forget(t.id);
    commit(next);
  }
}

// ----- where focus goes back to -----

let back: Element | null = null;
/** Where ⌘⇧T took focus from (lib/keys.ts): it goes back there. */
export function rememberToastReturn(el: Element | null): void {
  back = el;
}
/** Focus back where it was before the stack (or on the page, #main, when that is gone). */
export function returnFromToasts(): void {
  const el = back;
  back = null;
  const there =
    el instanceof HTMLElement &&
    el !== document.body &&
    el.isConnected &&
    !el.closest("[inert]") &&
    (typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0);
  const to = there ? el : document.getElementById("main");
  to?.focus({ preventScroll: true });
  holdToasts("focus", false);
}

// ----- what this page did itself -----

const own = new Set<string>();
/** Remembers a control message this page sent, by id (control/command.ts). */
export function noteOwnSend(id: string): void {
  own.add(id);
  if (own.size > 500) own.delete(own.values().next().value as string);
}
export const isOwnSend = (id: string): boolean => own.has(id);
