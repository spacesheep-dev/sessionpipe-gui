// SPDX-License-Identifier: Apache-2.0
// A history router: pushState, no hash. `useRoute()` gives the parsed location; `navigate`
// and `<Link>` move; the browser's back button works because we listen to popstate. On a
// phone a session opened from a list pushes in and our Back pops it (lib/transitions.ts
// decides, styles/transitions.css draws), through document.startViewTransition.
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useMemo,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { phoneLayout } from "./device";
import { getSettings } from "./settings";
import { agentTabKey, dropTab, parseSplit, splitParams } from "./splitState";
import { type NavDirection, type NavKind, navDirection } from "./transitions";

export type Route =
  | { name: "board" }
  | { name: "inbox" }
  | { name: "session"; harness: string; id: string }
  | { name: "feed" }
  | { name: "machines" }
  | { name: "usage" }
  | { name: "connect" }
  | { name: "setup" }
  | { name: "themes" }
  | { name: "review" }
  | { name: "workflows" }
  /** The editor on one workflow (`new` opens a fresh one; `?template=` a template's copy). */
  | { name: "workflow"; id: string }
  | { name: "workflowRun"; id: string }
  | { name: "search" }
  | { name: "shortcuts" }
  | { name: "theme"; id: string }
  | { name: "pair"; code: string }
  | { name: "add-device" }
  | { name: "phone" }
  | { name: "missing"; path: string };

const listeners = new Set<() => void>();

/** The path the app shows: what `current()` reported at the last emit. A popstate's URL
 *  has already moved when it arrives, so this is where a pop comes from. (Guarded: a unit
 *  test imports this module without a window.) */
let shownPath = typeof location === "undefined" ? "/" : location.pathname + location.search;
/** The path `current()` keeps reporting while a transition waits for its frame: the URL
 *  has moved (a pushState, a popstate), the page must not until the update runs. */
let heldPath: string | null = null;
const current = () => heldPath ?? location.pathname + location.search;
const emit = () => {
  for (const l of listeners) l();
  shownPath = current();
};

/** What the device says of a move right now (lib/transitions.ts decides with it). */
const navEnv = () => ({
  phone: phoneLayout(),
  reduced: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  supported: "startViewTransition" in document,
});

/** Plays a push or pop view transition around `apply` (the emit that renders the new
 *  page), or runs it at once when there is none to play. The URL has moved already (the
 *  caller's pushState, or the popstate): `from` is held as the path the app shows until
 *  the browser has captured the old page and calls back, which can take it more than a
 *  frame on a long page; the URL never waits for that. `data-nav` on <html> names the
 *  direction for the transition's life (styles/transitions.css). The render is flushed
 *  synchronously, so the new page is in the DOM for its snapshot; one task more lets a
 *  lazy page's retry land (the session's body is its own chunk) before it is taken. */
function transition(dir: NavDirection | null, from: string, apply: () => void): void {
  if (!dir) {
    apply();
    return;
  }
  heldPath = from;
  const html = document.documentElement;
  html.dataset.nav = dir;
  const vt = document.startViewTransition(async () => {
    heldPath = null;
    flushSync(apply);
    await new Promise<void>((r) => setTimeout(r, 0));
  });
  vt.finished.finally(() => {
    if (html.dataset.nav === dir) delete html.dataset.nav;
  });
}

/** Set while our own Back's history.back() is in flight: the popstate it brings is ours to
 *  animate as a pop. It times out, so a Back that left the document (or never came back
 *  as a popstate) cannot claim a later gesture's. */
let ownBack = 0;
/** How the page last changed: the app's own move forward ("navigate"), a replace (a
 *  redirect), or Back and Forward. Null until it has. */
let lastKind: NavKind | null = null;
export const lastMove = (): NavKind | null => lastKind;
if (typeof window !== "undefined")
  window.addEventListener("popstate", () => {
    const ours = ownBack !== 0;
    window.clearTimeout(ownBack);
    ownBack = 0;
    lastKind = ours ? "back" : "popstate";
    // Settings closing back onto the entry it was opened on by its address: that entry
    // drops the parameter as it shows.
    if (stripSettings) {
      stripSettings = false;
      history.replaceState(withoutSettingsMark(), "", withoutSettings());
    }
    const from = shownPath;
    const to = location.pathname + location.search;
    const dir = navDirection(parseRoute(from).name, parseRoute(to).name, ours ? "back" : "popstate", navEnv());
    transition(dir, from, emit);
  });

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
/** Calls the listener after each move of the address (a navigation, a parameter set or
 *  removed, Back and Forward), for code outside React; returns the way to stop. */
export const onLocation = subscribe;

export function parseRoute(pathWithSearch: string): Route {
  const path = pathWithSearch.split("?")[0] ?? "/";
  if (path === "/" || path === "") return { name: "board" };
  if (path === "/inbox") return { name: "inbox" };
  if (path === "/feed") return { name: "feed" };
  if (path === "/machines") return { name: "machines" };
  if (path === "/usage") return { name: "usage" };
  if (path === "/connect") return { name: "connect" };
  if (path === "/setup") return { name: "setup" };
  if (path === "/themes") return { name: "themes" };
  if (path === "/review") return { name: "review" };
  if (path === "/workflows") return { name: "workflows" };
  const wr = /^\/workflows\/runs\/([^/]+)\/?$/.exec(path);
  if (wr?.[1]) return { name: "workflowRun", id: decodeURIComponent(wr[1]) };
  const wf = /^\/workflows\/([^/]+)\/?$/.exec(path);
  if (wf?.[1]) return { name: "workflow", id: decodeURIComponent(wf[1]) };
  if (path === "/search") return { name: "search" };
  if (path === "/shortcuts") return { name: "shortcuts" };
  if (path === "/add-device") return { name: "add-device" };
  if (path === "/phone") return { name: "phone" };
  const t = /^\/t\/([^/]+)\/?$/.exec(path);
  if (t?.[1]) return { name: "theme", id: decodeURIComponent(t[1]) };
  if (path === "/pair") {
    const q = pathWithSearch.indexOf("?");
    return { name: "pair", code: q >= 0 ? (new URLSearchParams(pathWithSearch.slice(q)).get("code") ?? "") : "" };
  }
  const m = /^\/s\/([^/]+)\/(.+)$/.exec(path);
  if (m?.[1] && m[2]) return { name: "session", harness: decodeURIComponent(m[1]), id: decodeURIComponent(m[2]) };
  return { name: "missing", path };
}

/** The parsed location; the same object while the URL stays, so effects keyed on it stay put. */
export function useRoute(): Route {
  const p = useSyncExternalStore(subscribe, current, current);
  return useMemo(() => parseRoute(p), [p]);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, current, current);
}

/** The query parameters of the side panel: its tabs (`<harness>:<id>,…`) and the active one. */
export const SPLIT_PARAM = "s";
export const SPLIT_ACTIVE_PARAM = "t";

/** The query parameter that opens Settings over the page (`?settings=<section>`; bare, the
 *  first section on a desktop and the section list on a phone). No move keeps it: any
 *  other page, a link inside Settings included, closes it. */
export const SETTINGS_PARAM = "settings";

/** The address of the page `at` with Settings open on `section` over it (its other
 *  parameters kept). Pure. */
export function settingsHref(section?: string | null, at: string = current()): string {
  const [path = "/", query = ""] = (at.split("#")[0] ?? "").split("?");
  const q = new URLSearchParams(query);
  q.set(SETTINGS_PARAM, section ?? "");
  return `${path}?${q.toString().replace(/(^|&)settings=(?=&|$)/, "$1settings")}`;
}

/** Settings' old address (`/settings`, `?section=x` or `#x`: old links, a reload, the
 *  bed, sessionpipe://settings) as the address it is now: the page `openOn` (the device's
 *  "Open on") with Settings over it, the mock flag and the side panel kept. Null for any
 *  other address. Pure. */
export function settingsAlias(at: string, openOn: string): string | null {
  const [beforeHash = "", hash = ""] = at.split("#");
  const [path = "", query = ""] = beforeHash.split("?");
  if (path !== "/settings" && path !== "/settings/") return null;
  const q = new URLSearchParams(query);
  const keep = new URLSearchParams();
  for (const name of ["mock", SPLIT_PARAM, SPLIT_ACTIVE_PARAM]) {
    const v = q.get(name);
    if (v !== null) keep.set(name, v);
  }
  const kept = keep.toString();
  return settingsHref(q.get("section") || hash || null, `${openOn}${kept ? `?${kept}` : ""}`);
}

// An old address of Settings is rewritten before anything reads the location.
if (typeof location !== "undefined") {
  const alias = settingsAlias(location.pathname + location.search + location.hash, getSettings().defaultPage);
  if (alias) {
    history.replaceState(history.state, "", alias);
    shownPath = current();
  }
}

/** The side panel as it goes along to `to`: its tabs and the active one, as `s` and `t`
 *  are written. A session's own page takes that session's tab out of the strip
 *  (`<harness>:<id>`, or the agent's `<harness>:<id>#<agent>` under `?agent=`; its other
 *  tabs stay), and the active index moves as when a tab is closed. Null when no tab is
 *  left. Pure. */
export function panelOnto(to: string, s: string, t: string | null): { s: string; t: string | null } | null {
  const [path = "", query = ""] = (to.split("#")[0] ?? "").split("?");
  const page = parseRoute(path);
  if (page.name !== "session") return { s, t };
  const session = `${page.harness}:${page.id}`;
  const agent = new URLSearchParams(query).get(AGENT_PARAM);
  const state = parseSplit(s, t);
  const own = state.tabs.indexOf(agent ? agentTabKey(session, agent) : session);
  if (own < 0) return { s, t };
  const left = splitParams(dropTab(state, own));
  return left.s === null ? null : { s: left.s, t: left.t };
}

/** Keep `?mock=1` across navigations so a mock session survives a reload on any page, and
 *  the side panel (`?s=`) across every page change; a session's own page takes its tab out
 *  of the strip (panelOnto). Only a move carries the panel onto a session's page
 *  (`panelOntoSession`): the address of one, on a link or copied, leaves the tabs out, so
 *  it reads the same whatever is open beside. */
function keepParams(to: string, opts: { panelOntoSession?: boolean } = {}): string {
  const q = new URLSearchParams(location.search);
  const extra = new URLSearchParams();
  if (q.get("mock") === "1" && !to.includes("mock=1")) extra.set("mock", "1");
  const split = q.get(SPLIT_PARAM);
  if (split && (opts.panelOntoSession || !to.startsWith("/s/")) && !/[?&]s=/.test(to)) {
    const panel = panelOnto(to, split, q.get(SPLIT_ACTIVE_PARAM));
    if (panel) {
      extra.set(SPLIT_PARAM, panel.s);
      if (panel.t) extra.set(SPLIT_ACTIVE_PARAM, panel.t);
    }
  }
  const qs = extra.toString();
  if (!qs) return to;
  return `${to}${to.includes("?") ? "&" : "?"}${qs}`;
}
const keepMock = (to: string): string => keepParams(to);
/** The href a link to `to` carries (the mock flag and the side panel kept; a session's
 *  page without the panel). */
export const hrefFor = keepMock;

/** Pages this app pushed since it loaded; 0 means the page was opened by its URL, so there
 *  is nothing of ours behind it (a dialog closing then goes to its fallback, not away). */
let pushed = 0;
export const hasInAppHistory = (): boolean => pushed > 0;

export function navigate(to: string, opts: { replace?: boolean; back?: boolean } = {}) {
  // Settings' old address opens it over this page.
  const [toPath = "", toHash = ""] = to.split("#");
  if (/^\/settings\/?(\?|$)/.test(toPath)) {
    openSettings(new URLSearchParams(toPath.split("?")[1] ?? "").get("section") || toHash || null);
    return;
  }
  const env = navEnv();
  // Where there is a beside, the panel goes along onto a session's page too; on the phone
  // layout that page is the whole screen.
  const target = keepParams(to, { panelOntoSession: !env.phone });
  if (target === current()) return;
  const from = current();
  const kind: NavKind = opts.replace ? "replace" : opts.back ? "back" : "navigate";
  const dir = navDirection(parseRoute(from).name, parseRoute(target).name, kind, env);
  if (opts.replace) history.replaceState(null, "", target);
  else {
    history.pushState(null, "", target);
    pushed++;
  }
  lastKind = kind;
  transition(dir, from, emit);
}

/** Sets or removes one query parameter on the current URL (a history entry each time, so
 *  back and forward walk through it). */
export function setSearchParam(name: string, value: string | null, opts: { replace?: boolean } = {}) {
  setSearchParams({ [name]: value }, opts);
}

/** Sets or removes several query parameters at once, as one history entry. */
export function setSearchParams(entries: Record<string, string | null>, opts: { replace?: boolean } = {}) {
  const q = new URLSearchParams(location.search);
  for (const [name, value] of Object.entries(entries)) {
    if (value === null) q.delete(name);
    else q.set(name, value);
  }
  const qs = q.toString();
  const target = `${location.pathname}${qs ? `?${qs}` : ""}`;
  if (target === current()) return;
  if (opts.replace) history.replaceState(null, "", target);
  else history.pushState(null, "", target);
  emit();
}

/** The current value of a query parameter, live. */
export function useSearchParam(name: string): string | null {
  const p = useSyncExternalStore(subscribe, current, current);
  const i = p.indexOf("?");
  return i < 0 ? null : new URLSearchParams(p.slice(i)).get(name);
}

/** What a history entry of Settings knows of the way out: `back` entries back is the one
 *  it was opened over; `bare` when that one carries Settings too (it was opened by its
 *  address), so it drops the parameter on arrival; `list` when the phone pushed this
 *  section over the section list. An entry without it was opened by its address. */
interface SettingsMark {
  back: number;
  bare: boolean;
  list?: boolean;
}
const MARK = "__spguiSettings";
const settingsMark = (): SettingsMark => {
  const m = (history.state as Record<string, unknown> | null)?.[MARK] as SettingsMark | undefined;
  return m && typeof m.back === "number" ? m : { back: 0, bare: true };
};
const withMark = (m: SettingsMark) => ({ ...(history.state ?? {}), [MARK]: m });
function withoutSettingsMark(): Record<string, unknown> | null {
  const st = history.state as Record<string, unknown> | null;
  if (!st || !(MARK in st)) return st;
  const { [MARK]: _, ...rest } = st;
  return rest;
}
/** The current address with Settings closed. */
function withoutSettings(): string {
  const q = new URLSearchParams(location.search);
  q.delete(SETTINGS_PARAM);
  const qs = q.toString();
  return `${location.pathname}${qs ? `?${qs}` : ""}`;
}
/** Set while Settings' close goes back onto an entry that still carries it. */
let stripSettings = false;

/** Whether Settings is open over the page. */
export const settingsOpen = (): boolean => new URLSearchParams(location.search).has(SETTINGS_PARAM);

/** Opens Settings over the page (on `section`, else the first one, or on a phone the
 *  list): one history entry, so Back and Esc close it. Already open, it goes to the
 *  section asked for, in place, and takes the focus. */
export function openSettings(section?: string | null): void {
  if (settingsOpen()) {
    const now = new URLSearchParams(location.search).get(SETTINGS_PARAM);
    if (section && section !== now) {
      history.replaceState(history.state, "", settingsHref(section));
      emit();
    }
    document.querySelector<HTMLElement>("[data-settings-window]")?.focus({ preventScroll: true });
    return;
  }
  history.pushState(withMark({ back: 1, bare: false }), "", settingsHref(section));
  pushed++;
  emit();
}

/** Settings moved to another section from inside it: in place, or (the phone's stack, a
 *  section over the list) as one entry more. Null is the list. */
export function showSettingsSection(section: string | null, opts: { push?: boolean } = {}): void {
  const target = settingsHref(section);
  if (target === current()) return;
  if (opts.push) {
    const m = settingsMark();
    history.pushState(withMark({ back: m.back + 1, bare: m.bare, list: true }), "", target);
    pushed++;
  } else history.replaceState(history.state, "", target);
  emit();
}

/** The phone's Back from a section to the list: the entry behind where the list pushed
 *  it, else the list in its place. */
export function settingsBackToList(): void {
  if (settingsMark().list) history.back();
  else showSettingsSection(null);
}

/** Closes Settings: back past every entry of it, to the one it was opened over; opened by
 *  its address, that entry (or this one) is the page without it. */
export function closeSettings(): void {
  if (!settingsOpen()) return;
  const m = settingsMark();
  if (m.back <= 0) {
    history.replaceState(withoutSettingsMark(), "", withoutSettings());
    emit();
    return;
  }
  stripSettings = m.bare;
  history.go(-m.back);
}

/** Our own Back: the entry behind when there is one (its popstate plays as a pop on the
 *  phone), else `fallback` as a pop of its own. */
export function back(fallback = "/") {
  if (history.length > 1) {
    window.clearTimeout(ownBack);
    ownBack = window.setTimeout(() => {
      ownBack = 0;
    }, 1000);
    history.back();
  } else navigate(fallback, { back: true });
}

export const sessionPath = (harness: string, id: string) =>
  `/s/${encodeURIComponent(harness)}/${encodeURIComponent(id)}`;

/** The query parameter that opens a session on one of its subagents (an AgentRun id). */
export const AGENT_PARAM = "agent";
/** A session's page opened on one subagent. */
export const agentPath = (harness: string, id: string, agentId: string) =>
  `${sessionPath(harness, id)}?${AGENT_PARAM}=${encodeURIComponent(agentId)}`;

export function Link({
  to,
  children,
  className,
  title,
  modClick,
  plainClick,
  ...rest
}: {
  to: string;
  children: ReactNode;
  className?: string;
  title?: string;
  "aria-current"?: "page" | undefined;
  "data-cursor"?: string;
  /** Marks the item a list's roving tabindex walks (lib/keys.ts useListNav). */
  "data-nav-item"?: string;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "dialog";
  onKeyDown?: (e: KeyboardEvent<HTMLAnchorElement>) => void;
  style?: CSSProperties;
  tabIndex?: number;
  /** Shift- or Alt-click: open beside (the side panel); ⌘/ctrl-click: beside, as a
   *  background tab. Plain clicks navigate. */
  modClick?: (opts: { background: boolean }) => void;
  /** When set, a plain click runs this instead of navigating (the href stays, so the
   *  browser's own open-in-new-tab and a modifier click work as before). */
  plainClick?: () => void;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey) {
      if (!modClick) return; // the browser's own "open in a new tab"
      e.preventDefault();
      modClick({ background: true });
      return;
    }
    if (e.shiftKey || e.altKey) {
      if (!modClick) return;
      e.preventDefault();
      modClick({ background: false });
      return;
    }
    e.preventDefault();
    if (plainClick) plainClick();
    else navigate(to);
  };
  return (
    <a href={keepMock(to)} onClick={onClick} className={className} title={title} {...rest}>
      {children}
    </a>
  );
}
