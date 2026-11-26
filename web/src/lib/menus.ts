// SPDX-License-Identifier: Apache-2.0
// The context-menu items more than one surface shows, built once so a session's menu
// reads the same on a board row, an inbox row, a panel tab, a toast and the session's own
// "⋯": whatever the surface can answer, first; open (as a page, beside, in the background,
// in a new window), New session here, Ask another agent (the Handoff sheet), its colour
// label, where it sits in the person's tree (Pin, Move under…, Move to top level: display
// only, lib/arrange.ts), go to the parent or a subagent, copy, forget. Only actions that exist, and none
// that would only be refused; a key beside an item only where pressing it there does that
// to this session. A surface adds its own groups around these. Builders run when a menu
// opens, so they read the current URL and settings, never a stale render.
import { type AgentRun, isEmptySession, type SessionSummary, splitKey } from "@shared/api";
import type { MenuItem, MenuList } from "../components/ContextMenu";
import { confirmAction, tidy } from "../components/ContextMenu";
import { openNewSession } from "../control/newSessionState";
import type { Store } from "../data/store";
import { askableSessions, canAskFrom } from "../orchestrate/handoff/handoff";
import { openHandoffFor } from "../orchestrate/handoff/handoffState";
import { agentGlyph, agentLabel, openAgent } from "./agents";
import { arrangeItems } from "./arrange";
import { copyText } from "./clipboard";
import { phoneLayout, wideLayout } from "./device";
import { harnessMark, repoBranch, rowTime, STATE_LABEL, sessionTitle } from "./format";
import { canHideUntilNeeded, hiddenNow, hide, hideUntilNeeded, unhide } from "./hidden";
import { labelMenu } from "./labels";
import { canMark, isUnread, notifyMenu, setUnread } from "./marks";
import { accountMode, accountSessionUrl, receiverOrigin } from "./net";
import { hrefFor, navigate, SPLIT_ACTIVE_PARAM, SPLIT_PARAM, sessionPath } from "./router";
import { getSettings } from "./settings";
import { closeTab, openSplit, openWay, parseSplit } from "./split";
import { since } from "./time";

export { copyText };

/** "Copy x" as an item. */
export const copyItem = (label: string, text: string | undefined | null): MenuItem | null =>
  text ? { label, run: () => copyText(text) } : null;

/** The address of an in-app path, as a person would paste it; null where it has none. On a
 *  spacesheep account the app's pages are in the app only: a session has its page on
 *  spacesheep (`/sessions?s=<id>`), and nothing else has an address to open or copy. */
export const absoluteUrl = (path: string): string | null => {
  if (!accountMode()) return new URL(hrefFor(path), receiverOrigin()).href;
  const session = /^\/s\/[^/?#]+\/([^/?#]+)/.exec(path);
  if (!session) return null;
  try {
    return accountSessionUrl(decodeURIComponent(session[1]!));
  } catch {
    return null;
  }
};

/** Opens the page of `path` in a new window, where it has an address. */
export const openOutside = (path: string): void => {
  const url = absoluteUrl(path);
  if (url) window.open(url, "_blank", "noopener");
};

/** Open in a new window and Copy link, for anything that is a page of the app. */
export function linkItems(path: string): MenuList {
  const url = absoluteUrl(path);
  if (!url) return [];
  return [
    wideLayout() && { label: "Open in new window", run: () => openOutside(path) },
    { label: "Copy link", run: () => copyText(url) },
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
  /** The surface's own answer items (Allow / Deny with its signed send), put first. */
  answer?: MenuList;
  /** More items for the surface, before Copy (Follow, Close panel, Show only…). */
  extra?: MenuList;
  /** The session's subagents, when the surface knows them. */
  children?: readonly SessionSummary[];
  /** Sessions a folded row stands for (its glyph rolled up from under it): Mark as read
   *  acts on them too (components/SessionTree.tsx). */
  under?: readonly SessionSummary[];
  /** Opened from the sidebar session tree: arrangement moves return focus to the row. */
  inTree?: boolean;
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
  const hideHere = list && !onItsPage;
  const hidden = hideHere && hiddenNow(s);
  // e and ⇧E are the board's (useHideKeys); another list shows Hide without them.
  const onBoard = location.pathname === "/";
  const phone = phoneLayout();
  // On a list ↵ and ⇧↵ go the two ways (lib/split.ts openWay): the item ↵ does comes first
  // and carries ↵, the other ⇧↵. The phone keeps the order Settings says.
  const primary = openWay("primary");
  const other = openWay("other");
  const keyFor = (way: "page" | "beside") =>
    !list ? undefined : primary === way ? "list.open" : other === way ? "list.beside" : undefined;
  const besideFirst = phone ? getSettings().openSessions === "beside" : primary === "beside";
  const openPage: MenuItem | null = onItsPage
    ? null
    : { label: "Open as page", action: keyFor("page"), run: () => navigate(path) };
  const openBeside: MenuItem | null =
    isActiveTab || onItsPage
      ? null
      : {
          label: phone ? "Preview" : "Open beside",
          action: keyFor("beside"),
          run: () => openSplit(s.key),
        };
  const open: MenuList = besideFirst ? [openBeside, openPage] : [openPage, openBeside];
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
  // A computer's menu leads with the answer; the phone's sheet keeps it after Ask, as it was.
  const answer = ctx.answer ?? [];
  const items: MenuList = [
    ...(phone ? [] : answer),
    { sep: true },
    ...open,
    !phone &&
      tabIndex < 0 &&
      !onItsPage && {
        label: "Open in background tab",
        action: list ? "list.background" : undefined,
        run: () => openSplit(s.key, { background: true }),
      },
    !phone && !!absoluteUrl(path) && { label: "Open in new window", run: () => openOutside(path) },
    { sep: true },
    // No key beside it: C opens New session for the board's machine, never for this one's.
    paired && {
      label: "New session here",
      run: () => openNewSession({ machine: s.machine, harness: s.harness, ...(s.cwd ? { cwd: s.cwd } : {}) }),
    },
    // ⇧A is the session view's: it shows where that view is this session's.
    askItem(s, ctx.store, { hint: ctx.surface === "page" || ctx.surface === "panel" }),
    { sep: true },
    ...(phone ? answer : []),
    { sep: true },
    labelMenu(ctx.store, [s.key]),
    notifyMenu(ctx.store, s),
    { sep: true },
    ...arrangeItems(s, ctx.store, { inTree: ctx.inTree }),
    { sep: true },
    s.parentId && {
      label: "Open parent session",
      run: () => navigate(sessionPath(s.harness, s.parentId!)),
    },
    // Started by another session's ask (`delegated_by`): the two never both apply.
    s.delegatedBy && {
      label: "Open the asking session",
      run: () => navigate(sessionPath(splitKey(s.delegatedBy!).harness, splitKey(s.delegatedBy!).id)),
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
    // Hidden, it waits in the board's Hidden group, where Unhide brings it straight back.
    hideHere &&
      !hidden && {
        label: "Hide",
        action: onBoard ? "list.hide" : undefined,
        run: () => hide(s.key, s.stateSince, { title: sessionTitle(s), session: s.key }),
      },
    hideHere &&
      !hidden &&
      canHideUntilNeeded(s) && {
        label: "Hide until it needs you",
        action: onBoard ? "list.hideUntil" : undefined,
        run: () => hideUntilNeeded(s.key, { title: sessionTitle(s), session: s.key }),
      },
    hideHere && hidden && { label: "Unhide", action: onBoard ? "list.hide" : undefined, run: () => unhide(s.key) },
    unreadItem(ctx.store, s, list, ctx.under),
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
    // A spacesheep account holds the session, and the app's key has no door that forgets one.
    !accountMode() && { label: "Forget…", danger: true, run: forget },
  ];
  return tidy(items);
}

/** "Mark as read" on an unread session, else "Mark as unread" (lib/marks.ts), on a row
 *  that can draw unread. Its key, `u`, works on a list's cursor, so a list shows it. */
function unreadItem(
  store: Store,
  s: SessionSummary,
  list: boolean,
  under: readonly SessionSummary[] = [],
): MenuItem | null {
  const marks = store.get().marks;
  // A folded row's news below it is read with it; nothing below is ever marked unread by it.
  const below = under.filter((x) => canMark(x) && isUnread(x, marks));
  if (!canMark(s) && below.length === 0) return null;
  const unread = (canMark(s) && isUnread(s, marks)) || below.length > 0;
  return {
    label: unread ? "Mark as read" : "Mark as unread",
    action: list ? "list.unread" : undefined,
    run: () => setUnread(store, unread ? [...(canMark(s) ? [s] : []), ...below] : [s], !unread),
  };
}

/** "Ask another agent…": the Handoff sheet for this session (orchestrate/handoff), where
 *  the session's strip has the button (`canAskFrom`): hidden, never disabled, where its
 *  machine is not paired, its daemon predates asking or there is nobody to ask. `hint`:
 *  ⇧A beside it, for a menu of the session view the key presses the strip's button in. A
 *  reply's own menu passes that reply (`reply`, `turnSeq`) and its own words ("Ask another
 *  agent about this…"); the sheet is then prefilled with that turn, not the last one. */
export function askItem(
  s: SessionSummary,
  store: Store,
  o: { label?: string; reply?: string; turnSeq?: number; hint?: boolean } = {},
): MenuItem | null {
  const { machines, sessions } = store.get();
  const control = s.machine ? machines.get(s.machine)?.control : undefined;
  if (!canAskFrom(s, control, sessions.values(), Date.now())) return null;
  return {
    label: o.label ?? "Ask another agent…",
    action: o.hint ? "session.ask" : undefined,
    run: () =>
      openHandoffFor(s, {
        ...(o.reply !== undefined ? { reply: o.reply } : {}),
        ...(o.turnSeq !== undefined ? { turnSeq: o.turnSeq } : {}),
      }),
  };
}

/** "Message…" on a parent's list of the sessions it asked: the same Handoff sheet, aimed
 *  at that one, with the answer brought back. Only where the sheet could ask it (the
 *  parent's machine is paired, asking is on, the child is a session it may ask); never
 *  disabled. */
export function messageItem(parent: SessionSummary, child: SessionSummary, store: Store): MenuItem | null {
  if (!canMessage(parent, child, store)) return null;
  return { label: "Message…", run: () => openMessage(parent, child, store) };
}

/** Opens the parent's sheet aimed at `child` when it may still be asked now: a row drawn
 *  a moment ago may hold a child that has since ended or moved. */
export function openMessage(parent: SessionSummary, child: SessionSummary, store: Store): void {
  const { sessions } = store.get();
  const p = sessions.get(parent.key) ?? parent;
  const k = sessions.get(child.key) ?? child;
  if (canMessage(p, k, store)) openHandoffFor(p, { to: k.key });
}

/** Whether the parent's sheet may ask that child (messageItem). */
export function canMessage(parent: SessionSummary, child: SessionSummary, store: Store): boolean {
  const { machines, sessions } = store.get();
  const control = parent.machine ? machines.get(parent.machine)?.control : undefined;
  const now = Date.now();
  // The sheet lists the sessions the board does: one nothing has happened in yet is not.
  return (
    !isEmptySession(child) &&
    canAskFrom(parent, control, sessions.values(), now) &&
    askableSessions([child], parent, now).some((s) => s.key === child.key)
  );
}

/** The sheet head for a session: its title, and where it runs. */
export const sessionMenuTitle = (s: SessionSummary) => sessionTitle(s);
export const sessionMenuSubtitle = (s: SessionSummary) =>
  [s.machine, repoBranch(s)].filter(Boolean).slice(0, 2).join(" · ");

const TIP_LINE_MAX = 60;
const clipTip = (line: string): string =>
  line.length > TIP_LINE_MAX ? `${line.slice(0, TIP_LINE_MAX - 1).trimEnd()}…` : line;

/** Multi-line sidebar row tooltip (data-tip-wrap, right side): full title only when cut,
 *  "<State> · <since>", where it runs, and "Placed by you". Each line at most 60 chars. */
export function sessionRowTip(s: SessionSummary, placed: boolean, cut: boolean, now = Date.now()): string {
  const lbl = STATE_LABEL[s.state];
  const state = lbl.charAt(0).toUpperCase() + lbl.slice(1);
  const elapsed = since(rowTime(s, now).iso, now);
  const lines = [
    cut ? sessionTitle(s) : "",
    elapsed ? `${state} · ${elapsed}` : state,
    sessionMenuSubtitle(s),
    placed ? "Placed by you" : "",
  ];
  return lines.filter(Boolean).map(clipTip).join("\n");
}

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
    wideLayout() && { label: "Open beside", run: () => openAgent(s, a, "beside") },
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
