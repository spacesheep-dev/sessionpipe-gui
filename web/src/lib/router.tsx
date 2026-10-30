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
  | { name: "settings" }
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

const PHONE = "(max-width: 839px)";
/** What the device says of a move right now (lib/transitions.ts decides with it). */
const navEnv = () => ({
  phone: typeof matchMedia === "function" && matchMedia(PHONE).matches,
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
if (typeof window !== "undefined")
  window.addEventListener("popstate", () => {
    const ours = ownBack !== 0;
    window.clearTimeout(ownBack);
    ownBack = 0;
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
  if (path === "/settings") return { name: "settings" };
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

/** Keep `?mock=1` across navigations so a mock session survives a reload on any page, and
 *  the side panel (`?s=`) across page changes, except onto a session page of its own. */
function keepParams(to: string): string {
  const q = new URLSearchParams(location.search);
  const extra = new URLSearchParams();
  if (q.get("mock") === "1" && !to.includes("mock=1")) extra.set("mock", "1");
  const split = q.get(SPLIT_PARAM);
  if (split && !to.startsWith("/s/") && !/[?&]s=/.test(to)) {
    extra.set(SPLIT_PARAM, split);
    const active = q.get(SPLIT_ACTIVE_PARAM);
    if (active) extra.set(SPLIT_ACTIVE_PARAM, active);
  }
  const qs = extra.toString();
  if (!qs) return to;
  return `${to}${to.includes("?") ? "&" : "?"}${qs}`;
}
const keepMock = keepParams;
/** The href a link to `to` carries (the mock flag and the side panel kept). */
export const hrefFor = keepParams;

/** Pages this app pushed since it loaded; 0 means the page was opened by its URL, so there
 *  is nothing of ours behind it (a dialog closing then goes to its fallback, not away). */
let pushed = 0;
export const hasInAppHistory = (): boolean => pushed > 0;

export function navigate(to: string, opts: { replace?: boolean; back?: boolean } = {}) {
  const target = keepParams(to);
  if (target === current()) return;
  const from = current();
  const kind: NavKind = opts.replace ? "replace" : opts.back ? "back" : "navigate";
  const dir = navDirection(parseRoute(from).name, parseRoute(target).name, kind, navEnv());
  if (opts.replace) history.replaceState(null, "", target);
  else {
    history.pushState(null, "", target);
    pushed++;
  }
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
