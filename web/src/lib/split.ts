// SPDX-License-Identifier: Apache-2.0
// The side panel: sessions open beside the current page, as tabs. Which tabs and which
// is active live in the URL (`?s=<key>,<key>&t=<active>`; a lone `?s=<key>` still works),
// mirrored to localStorage so a plain reload without params restores them (the URL wins
// when present). The width is per device; the rectangle an open animates out of is
// handed over once and consumed by the panel.
import type { SessionKey } from "@shared/api";
import { useMemo, useSyncExternalStore } from "react";
import { SPLIT_ACTIVE_PARAM, SPLIT_PARAM, setSearchParams, useSearchParam } from "./router";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SplitState {
  tabs: SessionKey[];
  active: number;
}

export const SPLIT_MIN = 420;
/** Room the page keeps when the panel is dragged wide. */
export const PAGE_MIN = 360;
/** Inactive tabs kept mounted (their scroll and loaded pages); beyond this the least
 *  recently used is unmounted and reloads at its latest turn when it comes back. */
export const MOUNTED_MAX = 6;
const KEY_WIDTH = "sessionpipe-gui.splitWidth";
const KEY_TABS = "sessionpipe-gui.splitTabs";

let pendingFrom: Rect | null = null;
let width: number | null = (() => {
  try {
    const v = Number(localStorage.getItem(KEY_WIDTH));
    return v >= SPLIT_MIN ? v : null;
  } catch {
    return null;
  }
})();
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** The panel's width for this viewport: the stored one, else 44 %, never under SPLIT_MIN
 *  and never squeezing the page under PAGE_MIN. */
export function splitWidth(viewport = window.innerWidth): number {
  const want = width ?? Math.round(viewport * 0.44);
  return Math.max(SPLIT_MIN, Math.min(want, viewport - PAGE_MIN));
}

export function setSplitWidth(px: number): void {
  width = Math.round(px);
  try {
    localStorage.setItem(KEY_WIDTH, String(width));
  } catch {
    // per-page only
  }
  emit();
}

/** The panel width, live: follows drags and the viewport (the caller re-renders on resize). */
export function useSplitWidth(): number {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => width,
    () => width,
  );
  return splitWidth();
}

// ----- tabs -----

const isKey = (k: string): k is SessionKey => k.includes(":");

/** The separator of a tab that holds one subagent of a session: `<sessionKey>#<agentId>`
 *  (ORGANIZE-SPEC.md §4.5). Its view is the session's, opened on that agent. */
export const AGENT_TAB_SEP = "#";

/** The tab of one agent of a session. */
export const agentTabKey = (session: SessionKey, agentId: string): SessionKey =>
  `${session}${AGENT_TAB_SEP}${agentId}` as SessionKey;

/** A tab's session and, for an agent tab, the agent. */
export function parseTab(tab: string): { session: SessionKey; agent?: string } {
  const i = tab.indexOf(AGENT_TAB_SEP);
  if (i < 0) return { session: tab as SessionKey };
  return { session: tab.slice(0, i) as SessionKey, agent: tab.slice(i + 1) || undefined };
}

/** Where a new tab goes: an agent's right after its session's tab (and after that
 *  session's other agent tabs), so the pair reads as one; anything else at the end. */
function insertAt(tabs: readonly SessionKey[], key: SessionKey): number {
  const { session, agent } = parseTab(key);
  if (!agent) return tabs.length;
  const parent = tabs.indexOf(session);
  if (parent < 0) return tabs.length;
  let i = parent + 1;
  while (i < tabs.length && parseTab(tabs[i]!).session === session && parseTab(tabs[i]!).agent) i++;
  return i;
}

/** Parses `s` and `t` as the URL carries them. */
export function parseSplit(s: string | null, t: string | null): SplitState {
  const tabs = (s ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(isKey)
    .filter((k, i, all) => all.indexOf(k) === i);
  const n = Number(t);
  const active = tabs.length === 0 ? 0 : Number.isInteger(n) ? Math.max(0, Math.min(tabs.length - 1, n)) : 0;
  return { tabs, active };
}

function current(): SplitState {
  const q = new URLSearchParams(location.search);
  return parseSplit(q.get(SPLIT_PARAM), q.get(SPLIT_ACTIVE_PARAM));
}

function remember(state: SplitState): void {
  try {
    if (state.tabs.length === 0) localStorage.removeItem(KEY_TABS);
    else localStorage.setItem(KEY_TABS, JSON.stringify(state));
  } catch {
    // per-page only
  }
}

/** Writes the state to the URL (and the mirror). A change to the set of tabs is a
 *  history entry; switching or reordering replaces the current one. */
function commit(state: SplitState, opts: { replace?: boolean } = {}): void {
  const tabs = state.tabs;
  const active = Math.max(0, Math.min(tabs.length - 1, state.active));
  remember({ tabs, active });
  setSearchParams(
    {
      [SPLIT_PARAM]: tabs.length ? tabs.join(",") : null,
      [SPLIT_ACTIVE_PARAM]: tabs.length > 1 || active > 0 ? String(active) : null,
    },
    opts,
  );
}

/** At boot, with no `?s=` in the URL: the tabs of the last visit, if any. */
export function restoreSplit(): void {
  if (new URLSearchParams(location.search).has(SPLIT_PARAM)) return;
  try {
    const raw = localStorage.getItem(KEY_TABS);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<SplitState>;
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs.filter((k): k is string => typeof k === "string" && isKey(k))
      : [];
    if (tabs.length === 0) return;
    commit({ tabs, active: typeof parsed.active === "number" ? parsed.active : 0 }, { replace: true });
  } catch {
    // ignore a bad mirror
  }
}

export interface OpenSplitOptions {
  from?: Rect;
  /** Add the tab without switching to it (unless the panel was closed). */
  background?: boolean;
}

export function openSplit(key: SessionKey, opts: OpenSplitOptions = {}): void {
  const st = current();
  const i = st.tabs.indexOf(key);
  if (i >= 0) {
    if (!opts.background && i !== st.active) commit({ ...st, active: i }, { replace: true });
    return;
  }
  if (st.tabs.length === 0) pendingFrom = opts.from ?? null;
  const at = insertAt(st.tabs, key);
  const tabs = [...st.tabs.slice(0, at), key, ...st.tabs.slice(at)];
  const kept = st.tabs[st.active];
  commit({ tabs, active: opts.background && kept ? tabs.indexOf(kept) : at });
}

export function activateTab(index: number): void {
  const st = current();
  if (index < 0 || index >= st.tabs.length || index === st.active) return;
  commit({ ...st, active: index }, { replace: true });
}

export function cycleTab(delta: 1 | -1): void {
  const st = current();
  if (st.tabs.length < 2) return;
  activateTab((st.active + delta + st.tabs.length) % st.tabs.length);
}

/** Closes a tab; the active one hands over to its right neighbour, else the left; the
 *  last one closes the panel. */
export function closeTab(index: number): void {
  const st = current();
  if (index < 0 || index >= st.tabs.length) return;
  const tabs = st.tabs.filter((_, i) => i !== index);
  let active = st.active;
  if (index < st.active) active -= 1;
  else if (index === st.active) active = Math.min(index, tabs.length - 1);
  commit({ tabs, active });
}

/** Keeps the tab at `index` and closes every other one (the tab's menu). */
export function closeOthers(index: number): void {
  const st = current();
  const keep = st.tabs[index];
  if (!keep || st.tabs.length < 2) return;
  commit({ tabs: [keep], active: 0 });
}

export function moveTab(from: number, to: number): void {
  const st = current();
  if (from === to || from < 0 || to < 0 || from >= st.tabs.length || to >= st.tabs.length) return;
  const tabs = [...st.tabs];
  const [k] = tabs.splice(from, 1);
  tabs.splice(to, 0, k!);
  const activeKey = st.tabs[st.active]!;
  commit({ tabs, active: tabs.indexOf(activeKey) }, { replace: true });
}

export function closeSplit(): void {
  commit({ tabs: [], active: 0 });
}

/** The rectangle the last `openSplit` asked to animate from, once. */
export function takeFrom(): Rect | null {
  const r = pendingFrom;
  pendingFrom = null;
  return r;
}

/** The tabs and the active index, live from the URL. */
export function useSplit(): SplitState {
  const s = useSearchParam(SPLIT_PARAM);
  const t = useSearchParam(SPLIT_ACTIVE_PARAM);
  // One state object per URL: the panel keys effects on `tabs`, and a fresh array every
  // render had those effects setting state (and rendering) in a loop, ~1000 commits/s.
  return useMemo(() => parseSplit(s, t), [s, t]);
}

/** The active session key in the panel, or null. */
export function useSplitKey(): SessionKey | null {
  const st = useSplit();
  return st.tabs[st.active] ?? null;
}
