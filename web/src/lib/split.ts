// SPDX-License-Identifier: Apache-2.0
// The side panel: sessions open beside the current page, as tabs. Which tabs and which
// is active live in the URL (`?s=<key>,<key>&t=<active>`; a lone `?s=<key>` still works),
// mirrored to localStorage so a plain reload without params restores them (the URL wins
// when present); the mirror follows the URL, whatever moved it. The width is per device;
// the rectangle an open animates out of is handed over once and consumed by the panel.
// The panel stays until it is closed: it goes along to every page (lib/router.tsx), and a
// session opened as a page leaves it, the other tabs staying beside that page. It shows
// beside the pages that list sessions (and a session's page, and Settings, a window over
// the board); on the others (Setup, Connect, /phone, a missing page) it steps aside, its
// tabs kept for the way back. A plain open is a preview (italic): the next plain open
// takes its place instead of adding a tab, until the person keeps it (keepTab); which tab
// that is lives here, not in the URL, so a reload keeps every tab and drops the mark. On
// the phone there is no beside: a session opened "beside" is its page, pushed over the
// list (lib/transitions.ts), a session's page carries no tabs, and nothing of the panel
// is restored on the next launch (a modal sheet over every page is not how a phone wakes
// up).
import { type SessionKey, sessionKey, splitKey } from "@shared/api";
import { useMemo, useSyncExternalStore } from "react";
import { phoneLayout } from "./device";
import {
  agentPath,
  navigate,
  onLocation,
  panelOnto,
  parseRoute,
  SPLIT_ACTIVE_PARAM,
  SPLIT_PARAM,
  sessionPath,
  setSearchParams,
  usePath,
  useSearchParam,
} from "./router";
import { getSettings } from "./settings";
import { AGENT_TAB_SEP, dropTab, isKey, parseSplit, type SplitState, splitParams } from "./splitState";

export { AGENT_TAB_SEP, agentTabKey, parseSplit, type SplitState } from "./splitState";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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

function current(): SplitState {
  const q = new URLSearchParams(location.search);
  return parseSplit(q.get(SPLIT_PARAM), q.get(SPLIT_ACTIVE_PARAM));
}

/** The mirror for a plain reload; the phone keeps none (nothing modal survives a relaunch). */
function remember(state: SplitState): void {
  if (phoneLayout()) return;
  try {
    if (state.tabs.length === 0) localStorage.removeItem(KEY_TABS);
    else localStorage.setItem(KEY_TABS, JSON.stringify(state));
  } catch {
    // per-page only
  }
}

/** The mirror follows the URL, so the next launch shows the tabs last seen: a tab that
 *  left for its own page, or a strip Back put back, is mirrored like a change made in
 *  the panel. Not before the boot has read the last visit's tabs (restoreSplit): an
 *  address that moves while the app starts carries no tabs yet, and would empty it. */
let mirroring = false;
onLocation(() => {
  if (mirroring) remember(current());
});

/** Writes the state to the URL (the mirror follows it). A change to the set of tabs is
 *  a history entry; switching or reordering replaces the current one. */
function commit(state: SplitState, opts: { replace?: boolean } = {}): void {
  const tabs = state.tabs;
  const active = Math.max(0, Math.min(tabs.length - 1, state.active));
  const { s, t } = splitParams({ tabs, active });
  setSearchParams({ [SPLIT_PARAM]: s, [SPLIT_ACTIVE_PARAM]: t }, opts);
}

/** At boot, with no `?s=` in the URL: the tabs of the last visit, if any. Never on the
 *  phone, whose pages open clean; its mirror (a desktop visit's) stays for a desktop.
 *  On a session's own page (the app opened by a notification) that session's tab is not
 *  put back beside it, as when a move carries the panel there (panelOnto). From here on
 *  the mirror follows the URL. */
export function restoreSplit(): void {
  mirroring = true;
  if (phoneLayout()) return;
  if (new URLSearchParams(location.search).has(SPLIT_PARAM)) return;
  try {
    const raw = localStorage.getItem(KEY_TABS);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<SplitState>;
    const tabs = Array.isArray(parsed.tabs)
      ? parsed.tabs.filter((k): k is string => typeof k === "string" && isKey(k))
      : [];
    if (tabs.length === 0) return;
    const last = splitParams({ tabs, active: typeof parsed.active === "number" ? parsed.active : 0 });
    const here = panelOnto(`${location.pathname}${location.search}`, last.s ?? "", last.t);
    if (here) commit(parseSplit(here.s, here.t), { replace: true });
  } catch {
    // ignore a bad mirror
  }
}

export interface OpenSplitOptions {
  from?: Rect;
  /** Add the tab without switching to it (unless the panel was closed). */
  background?: boolean;
  /** A plain open (a click, ↵, Space, a toast): it takes the preview tab's place, if
   *  there is one, instead of adding a tab. Without it the tab is kept. */
  preview?: boolean;
}

// ----- the preview tab -----

/** The one tab a plain open may replace, by its key; null when every tab is kept. */
let preview: SessionKey | null = null;
const previewListeners = new Set<() => void>();
function setPreview(key: SessionKey | null): void {
  if (preview === key) return;
  preview = key;
  for (const l of previewListeners) l();
}
// A preview tab that left the strip (closed, opened as its page, Back) is no longer one.
onLocation(() => {
  if (preview && !current().tabs.includes(preview)) setPreview(null);
});

/** The preview tab's key, or null. */
export function previewTab(): SessionKey | null {
  return preview && current().tabs.includes(preview) ? preview : null;
}

/** Keeps the tab from now on: the next plain open adds its own. For a key that is no
 *  tab's, or a kept one, nothing. A session's key keeps its agents' tab too, as typing
 *  in the session's composer does. */
export function keepTab(key: SessionKey): void {
  if (preview && (preview === key || parseTab(preview).session === key)) setPreview(null);
}

/** The preview tab's key, live (null when every tab is kept). */
export function usePreviewTab(): SessionKey | null {
  return useSyncExternalStore(
    (l) => {
      previewListeners.add(l);
      return () => {
        previewListeners.delete(l);
      };
    },
    () => preview,
    () => preview,
  );
}

/** The page a tab opens as on the phone: the session's, on its agent for an agent tab. */
export function tabPath(tab: SessionKey): string {
  const { session, agent } = parseTab(tab);
  const { harness, id } = splitKey(session);
  return agent ? agentPath(harness, id, agent) : sessionPath(harness, id);
}

/** Opens `key` beside the page. On the phone that is its page, pushed (a row opens its
 *  detail, with the list behind the back button); `background` and `preview` have no
 *  meaning there. A session already open is switched to (an explicit open keeps it).
 *  Otherwise a preview open takes the preview tab's place, in the same history entry,
 *  or adds a preview tab when there is none; any other open adds a kept tab. */
export function openSplit(key: SessionKey, opts: OpenSplitOptions = {}): void {
  if (phoneLayout()) {
    navigate(tabPath(key));
    return;
  }
  const st = current();
  const asPreview = !!opts.preview && !opts.background;
  const i = st.tabs.indexOf(key);
  if (i >= 0) {
    if (!asPreview && preview === key) setPreview(null);
    if (!opts.background && i !== st.active) commit({ ...st, active: i }, { replace: true });
    return;
  }
  const was = previewTab();
  if (asPreview && was) {
    const tabs = st.tabs.map((k) => (k === was ? key : k));
    setPreview(key);
    commit({ tabs, active: tabs.indexOf(key) }, { replace: true });
    return;
  }
  if (st.tabs.length === 0) pendingFrom = opts.from ?? null;
  const at = insertAt(st.tabs, key);
  const tabs = [...st.tabs.slice(0, at), key, ...st.tabs.slice(at)];
  const kept = st.tabs[st.active];
  if (asPreview) setPreview(key);
  // An agent's tab opened beside its session keeps the session's: the pair stays together.
  else if (preview && preview === parseTab(key).session) setPreview(null);
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
  commit(dropTab(st, index));
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
  // A tab moved by hand is one the person means to keep.
  if (preview === k) setPreview(null);
  const activeKey = st.tabs[st.active]!;
  commit({ tabs, active: tabs.indexOf(activeKey) }, { replace: true });
}

export function closeSplit(): void {
  commit({ tabs: [], active: 0 });
}

/** Closes the panel within the history entry that is open: for a move to another page
 *  that takes the panel away (it covered the page, Shell.tsx), so Back is still one step. */
export function leaveSplit(): void {
  commit({ tabs: [], active: 0 }, { replace: true });
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

/** The pages the panel opens beside: the session lists, a session and the installed views
 *  (canvas, office); Settings is over whichever page is open, and keeps its layout. Never
 *  Setup, Connect, /phone, a pairing page or a path the app has no page for, where a live
 *  session beside it reads as broken. */
const BESIDE = new Set(["board", "inbox", "search", "feed", "review", "machines", "session", "theme"]);
export const panelBeside = (path: string): boolean => BESIDE.has(parseRoute(path).name);

/** How an open was asked for: "primary" is a plain click or ↵, "other" holds ⇧ (⇧↵), and
 *  "background" holds ⌘ (⌘↵). */
export type OpenHow = "primary" | "other" | "background";

/** The one rule for where a session opens: "primary" goes the way Settings › Open sessions
 *  says, "other" the other way, and "background" is a tab that does not take the panel.
 *  Where the panel cannot show (the phone, Usage, Workflows, Shortcuts…) every way is the
 *  page, so no tab opens out of sight. Callers keep their own extras (where it animates
 *  from, a #seq, a file) and only ask which way. */
export function openWay(how: OpenHow): "page" | "beside" | "background" {
  if (phoneLayout() || !panelBeside(location.pathname)) return "page";
  if (how === "background") return "background";
  const beside = getSettings().openSessions === "beside";
  return (how === "primary") === beside ? "beside" : "page";
}

/** How a click asked: ⌘ (Ctrl) a background tab, ⇧ (or ⌥) the other way, else plain. */
export const howOf = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): OpenHow =>
  e.metaKey || e.ctrlKey ? "background" : e.shiftKey || e.altKey ? "other" : "primary";

/** Opens a session by the one rule (openWay): as its page, beside the page (a plain open
 *  is the preview tab; one that went the other way, or a menu's (`keep`), is kept) or as a
 *  background tab. `hash`
 *  (`#seq-N`) lands it on a row: the page carries it, the panel reads it once
 *  (components/SessionView.tsx). Not the theme API's openSession, which is always the page. */
export function openSession(
  key: SessionKey,
  how: OpenHow,
  opts: { from?: Rect; hash?: string; keep?: boolean } = {},
): void {
  const way = openWay(how);
  if (way === "page") {
    navigate(tabPath(key));
    if (opts.hash) history.replaceState(history.state, "", `${location.pathname}${location.search}${opts.hash}`);
    return;
  }
  openSplit(key, { from: opts.from, background: way === "background", preview: how === "primary" && !opts.keep });
  if (!opts.hash) return;
  history.replaceState(history.state, "", `${location.pathname}${location.search}${opts.hash}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** A page the app asks for while its window is up (a notification's click, the menu bar's
 *  session): a session's own page opens by the one rule, as a plain open, so the page and
 *  its tabs stay; any other address is navigated to. A cold start is not asked here: the
 *  window opens on the address. */
export function openAsked(to: string): void {
  const at = to.indexOf("#");
  const bare = at < 0 ? to : to.slice(0, at);
  const r = parseRoute(bare);
  if (r.name !== "session" || bare.includes("?")) {
    navigate(to);
    return;
  }
  openSession(sessionKey(r.harness, r.id), "primary", at < 0 ? {} : { hash: to.slice(at) });
}

/** Whether the panel shows on the current page (its tabs stay in the URL either way). */
export function usePanelHere(): boolean {
  return panelBeside(usePath());
}

/** The active session key in the panel, or null; null too on a page the panel steps
 *  aside for, so the shell lays the page out full width there. */
export function useSplitKey(): SessionKey | null {
  const st = useSplit();
  const here = usePanelHere();
  return here ? (st.tabs[st.active] ?? null) : null;
}
