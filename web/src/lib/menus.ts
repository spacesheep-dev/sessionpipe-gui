// SPDX-License-Identifier: Apache-2.0
// The context-menu items more than one surface shows, built once so a session's menu
// reads the same on a board row, an inbox row, a panel tab, a toast and the session's own
// "⋯": open (as a page, beside, in the background, in a new window), New session here,
// whatever the surface can answer, its colour label, go to the parent or a subagent, copy,
// forget. Only actions that exist; a surface adds its own groups around these. Builders run when a menu opens, so
// they read the current URL and settings, never a stale render.
import type { AgentRun, SessionSummary } from "@shared/api";
import type { MenuItem, MenuList } from "../components/ContextMenu";
import { confirmAction, tidy } from "../components/ContextMenu";
import { openNewSession } from "../control/newSessionState";
import type { Store } from "../data/store";
import { agentGlyph, agentLabel, openAgent } from "./agents";
import { copyText } from "./clipboard";
import { harnessMark, repoBranch, sessionTitle } from "./format";
import { hide } from "./hidden";
import { labelMenu } from "./labels";
import { receiverOrigin } from "./net";
import { hrefFor, navigate, SPLIT_ACTIVE_PARAM, SPLIT_PARAM, sessionPath } from "./router";
import { getSettings } from "./settings";
import { closeTab, openSplit, parseSplit } from "./split";

export { copyText };

/** "Copy x" as an item. */
export const copyItem = (label: string, text: string | undefined | null): MenuItem | null =>
  text ? { label, run: () => copyText(text) } : null;

/** The address of an in-app path, as a person would paste it. */
export const absoluteUrl = (path: string): string => new URL(hrefFor(path), receiverOrigin()).href;

const desktop = () => typeof matchMedia === "function" && matchMedia("(min-width: 840px)").matches;

/** Open in a new window and Copy link, for anything that is a page of the app. */
export function linkItems(path: string): MenuList {
  return [
    desktop() && { label: "Open in new window", run: () => void window.open(absoluteUrl(path), "_blank", "noopener") },
    { label: "Copy link", run: () => copyText(absoluteUrl(path)) },
  ];
}

/** The panel's tabs right now, read from the URL (a builder runs outside render). */
const splitNow = () => {
  const q = new URLSearchParams(location.search);
  return parseSplit(q.get(SPLIT_PARAM), q.get(SPLIT_ACTIVE_PARAM));
};

export interface SessionMenuContext {
  store: Store;
  /** Where the menu is: decides the shortcuts shown and what "here" means. */
  surface: "list" | "panel" | "page" | "tab" | "toast" | "palette";
  /** The surface's own answer items (Allow / Deny with its signed send), put after Open. */
  answer?: MenuList;
  /** More items for the surface, before Copy (Follow, Close panel, Show only…). */
  extra?: MenuList;
  /** The session's subagents, when the surface knows them. */
  children?: readonly SessionSummary[];
  /** After a successful forget, beyond the default (close its tab, leave its page). */
  onForgotten?: () => void;
}

/** The menu of a session, on any surface. */
export function sessionItems(s: SessionSummary, ctx: SessionMenuContext): MenuItem[] {
  const path = sessionPath(s.harness, s.id);
  const split = splitNow();
  const tabIndex = split.tabs.indexOf(s.key);
  const isActiveTab = tabIndex >= 0 && tabIndex === split.active;
  const onItsPage = location.pathname === path;
  const list = ctx.surface === "list";
  const phone = !desktop();
  const beside = getSettings().openSessions === "beside";
  const openPage: MenuItem | null = onItsPage
    ? null
    : { label: "Open as page", action: list && !beside ? "list.open" : undefined, run: () => navigate(path) };
  const openBeside: MenuItem | null =
    isActiveTab || onItsPage
      ? null
      : {
          label: phone ? "Preview" : "Open beside",
          action: list ? (beside ? "list.open" : "list.beside") : undefined,
          run: () => openSplit(s.key),
        };
  const open: MenuList = beside ? [openBeside, openPage] : [openPage, openBeside];
  const kids = ctx.children ?? [];
  const repo = repoBranch(s);
  const forget = async () => {
    if (getSettings().confirmForget) {
      const ok = await confirmAction({
        title: `Forget “${sessionTitle(s)}”?`,
        body: "It leaves the board and the feed here. The agent keeps running; new events bring it back.",
        action: "Forget",
        danger: true,
      });
      if (!ok) return;
    }
    await ctx.store.transport.forget(s.harness, s.id);
    const i = splitNow().tabs.indexOf(s.key);
    if (i >= 0) closeTab(i);
    if (location.pathname === path) navigate("/");
    ctx.onForgotten?.();
  };
  // "New session here": its machine, agent and folder, when that machine is paired here.
  const paired = !!(s.machine && ctx.store.get().machines.get(s.machine)?.control);
  const items: MenuList = [
    ...open,
    !phone &&
      tabIndex < 0 &&
      !onItsPage && {
        label: "Open in background tab",
        action: list ? "list.background" : undefined,
        run: () => openSplit(s.key, { background: true }),
      },
    !phone && { label: "Open in new window", run: () => void window.open(absoluteUrl(path), "_blank", "noopener") },
    { sep: true },
    paired && {
      label: "New session here",
      action: "newSession.open",
      run: () => openNewSession({ machine: s.machine, harness: s.harness, ...(s.cwd ? { cwd: s.cwd } : {}) }),
    },
    { sep: true },
    ...(ctx.answer ?? []),
    { sep: true },
    labelMenu(ctx.store, [s.key]),
    { sep: true },
    s.parentId && {
      label: "Open parent session",
      run: () => navigate(sessionPath(s.harness, s.parentId!)),
    },
    // Its subagents, read from its events (running first), each opening beside; a session
    // whose summary carries none falls back to the child sessions the surface knows.
    (s.agents?.length ?? 0) > 0
      ? {
          label: "Subagents",
          items: s.agents.map((a) => ({
            label: agentLabel(a),
            checked: agentGlyph(a) === "working",
            radio: true,
            run: () => openAgent(s, a),
          })),
        }
      : kids.length > 0 && {
          label: "Subagents",
          items: kids.map((c) => ({ label: sessionTitle(c), run: () => navigate(sessionPath(c.harness, c.id)) })),
        },
    s.url && {
      label: `Open in ${harnessMark(s.harness).label}`,
      run: () => void window.open(s.url, "_blank", "noopener"),
    },
    { sep: true },
    ...(ctx.extra ?? []),
    // Hide (Mail's archive): off this device's lists until it has news; "Hidden · Undo".
    list &&
      !onItsPage && {
        label: "Hide",
        run: () => hide(s.key, s.stateSince, { title: sessionTitle(s), session: s.key }),
      },
    { sep: true },
    {
      label: "Copy",
      items: [
        copyItem("Title", sessionTitle(s)),
        copyItem("Link", absoluteUrl(path)),
        copyItem("Session ID", s.id),
        copyItem("Folder", s.cwd),
        copyItem("Repo and branch", repo || null),
      ],
    },
    { sep: true },
    { label: "Forget…", danger: true, run: forget },
  ];
  return tidy(items);
}

/** The sheet head for a session: its title, and where it runs. */
export const sessionMenuTitle = (s: SessionSummary) => sessionTitle(s);
export const sessionMenuSubtitle = (s: SessionSummary) =>
  [s.machine, repoBranch(s)].filter(Boolean).slice(0, 2).join(" · ");

/** The menu of one subagent (a board's agent row, a session view's agent block, the
 *  palette): open it beside or as a page, its parent when the surface is elsewhere, and
 *  what can be copied. Only what the agent carries. */
export function agentItems(
  s: SessionSummary,
  a: AgentRun,
  opts: { parent?: boolean; extra?: MenuList } = {},
): MenuItem[] {
  return tidy([
    // A phone opens an agent as the page on it: one item, not two that do the same.
    desktop() && { label: "Open beside", run: () => openAgent(s, a, "beside") },
    { label: "Open as page", run: () => openAgent(s, a, "page") },
    { sep: true },
    opts.parent && { label: "Open parent session", run: () => navigate(sessionPath(s.harness, s.id)) },
    { sep: true },
    ...(opts.extra ?? []),
    { sep: true },
    {
      label: "Copy",
      items: [
        copyItem("Agent ID", a.id),
        copyItem("Description", a.description ?? null),
        copyItem("Result", a.result ?? null),
      ],
    },
  ]);
}
