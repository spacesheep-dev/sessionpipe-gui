// SPDX-License-Identifier: Apache-2.0
// One session on the board, as a row of a native list: the status glyph in the lead (the
// one signal for its state), the title and one time on the first line, what it is doing
// on the second (the request for a prompt that needs you, else the latest thing it said,
// its inline Markdown read as text) with the machine and repo trailing: two facts, the
// time and where. Turns and tools are the row's tooltip, or columns when "Show counts" is
// on; a tool that failed last is one small ✕. Subagents nest under it as single-line child
// rows on a tree guide that holds still under the pointer. A right-click (a long-press on
// touch) opens the session's menu; resting on a row warms its transcript (data/prefetch).
// The class names are the e2e contract (`article.card`, `.card-status`, `.card-meta`…),
// so they stay even though nothing here is a card any more.
import type { AgentRun, SessionFlag, SessionKey, SessionSummary } from "@shared/api";
import {
  Fragment,
  type MutableRefObject,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { answerState, useSessionSend } from "../control/useSend";
import { useAppState, useStore } from "../data/hooks";
import { prefetchProps } from "../data/prefetch";
import { agentsChoice, agentsFact, agentsShown, agentTabKey, setAgentsChoice } from "../lib/agents";
import {
  ATTENTION_LABEL,
  attentionMessage,
  harnessMark,
  oneLine,
  repoShort,
  STATE_LABEL,
  sessionTitle,
  toolLabel,
} from "../lib/format";
import { hide } from "../lib/hidden";
import { labelItems } from "../lib/labels";
import { sessionItems, sessionMenuSubtitle, sessionMenuTitle } from "../lib/menus";
import { reducedMotion, tokenMs, useFlip, useHeldOrder, useListHold } from "../lib/motion";
import { Link, sessionPath } from "../lib/router";
import { LENSES, type Lens, setTierLens } from "../lib/settings";
import { openSplit } from "../lib/split";
import { durCoarse, ms } from "../lib/time";
import { AgentRow, useAgentsOpen } from "./AgentRow";
import { HarnessGlyph, Redacted, Since, StateDot } from "./bits";
import { type MenuItem, type MenuList, openMenu, useContextMenu } from "./ContextMenu";
import { LabelDot } from "./LabelDot";

interface SessionCardProps {
  s: SessionSummary;
  children?: SessionSummary[];
  cursor?: number;
  /** The app-wide tier lens (null = everything): no snippet below 2, no tools or counts below 1. */
  lens?: Lens;
  /** Simple mode: no counts. */
  simple?: boolean;
  /** A plain click opens the session beside the page instead of as the page. */
  openBeside?: boolean;
  /** The session is the panel's active tab: the row stays selected. */
  open?: boolean;
  /** The panel's active tab, when it is one of this session's agents (that row is open). */
  openTab?: string | null;
  /** A search found one of its agents: they show, whatever the disclosure says. */
  agentsMatch?: boolean;
  /** The board's filters, for the menu's "Show only …" (stable setters). */
  onlyMachine?: (m: string) => void;
  onlyHarness?: (h: string) => void;
  /** Gone from the data while the list held still (lib/motion.ts useHeldOrder): drawn
   *  quiet and inert until the hold lets go. */
  gone?: boolean;
  /** The stream went down at this instant: the row keeps its place, its time stops. */
  frozenAt?: number | null;
  /** Advanced → "Show counts": turns, tools and errors as columns before the time. */
  counts?: boolean;
  /** Its number for ⌘1–9 (1-based; the hint shows while ⌘ is held in the installed app). */
  jump?: number;
  /** A session started from here with no title of its own yet is called by its first
   *  message (control/Starting.tsx useStartTitles), not by its folder. */
  startTitle?: string;
  /** The board is holding still (the pointer is on it): the tree under this row holds too,
   *  so a subagent that starts or ends never pushes the rows below. */
  held?: boolean;
}

/** What the tier lens takes off a row, for the page's "N hidden" line. */
export const cardHides = (s: SessionSummary, lens: Lens): number => {
  if (lens === null) return 0;
  let n = 0;
  if (lens < 2 && (s.progress?.assistant || s.lastAssistant || s.progress?.user || s.lastUser)) n++;
  if (lens < 1 && (s.currentTool || s.counts.tools > 0 || s.openAttentions.some((a) => a.message || a.tool))) n++;
  return n;
};

/** The same summary object, the same children and the same cursor: nothing to redraw.
 *  Every event rebuilds the sessions map, but only the session it belongs to gets a
 *  new summary, so the other rows keep their last render. */
const sameCard = (a: SessionCardProps, b: SessionCardProps): boolean =>
  a.s === b.s &&
  a.cursor === b.cursor &&
  a.lens === b.lens &&
  a.simple === b.simple &&
  a.openBeside === b.openBeside &&
  a.open === b.open &&
  a.openTab === b.openTab &&
  a.agentsMatch === b.agentsMatch &&
  a.onlyMachine === b.onlyMachine &&
  a.onlyHarness === b.onlyHarness &&
  a.gone === b.gone &&
  a.frozenAt === b.frozenAt &&
  a.counts === b.counts &&
  a.jump === b.jump &&
  a.held === b.held &&
  a.startTitle === b.startTitle &&
  (a.children?.length ?? 0) === (b.children?.length ?? 0) &&
  (a.children ?? []).every((c, i) => c === b.children?.[i]);

/** "Show only <machine>" and "Show only <harness>", for a row's menu. */
const onlyItems = (s: SessionSummary, p: Pick<SessionCardProps, "onlyMachine" | "onlyHarness">): MenuList => [
  s.machine && p.onlyMachine && { label: `Show only ${s.machine}`, run: () => p.onlyMachine!(s.machine!) },
  p.onlyHarness && { label: `Show only ${harnessMark(s.harness).label}`, run: () => p.onlyHarness!(s.harness) },
];

export const SessionCard = memo(function SessionCard({
  s,
  children,
  cursor,
  lens = null,
  simple = false,
  openBeside = false,
  open = false,
  openTab = null,
  agentsMatch = false,
  onlyMachine,
  onlyHarness,
  gone = false,
  frozenAt = null,
  counts = false,
  jump,
  held = false,
  startTitle,
}: SessionCardProps) {
  const store = useStore();
  const title = !s.title?.trim() && startTitle ? startTitle : sessionTitle(s);
  const agents = s.agents ?? [];
  // A child session that is one of its agents shows once, as that agent's row.
  const twins = new Set(agents.map((a) => a.session).filter(Boolean));
  const kids = children?.filter((c) => !twins.has(c.key));
  const chosen = useAgentsOpen(s);
  // A tree that opens by itself (an agent started) waits while the board holds still; one
  // the person opens or folds does it at once.
  const auto = useRef(chosen);
  if (!held || agentsChoice(s.key) !== undefined) auto.current = chosen;
  const showAgents = agents.length > 0 && (auto.current || agentsMatch);
  const [allDone, setAllDone] = useState(false);
  const toggleAgents = (to = !showAgents) => {
    if (agents.length > 0 && to !== showAgents) setAgentsChoice(s.key, to);
  };
  const fact = agentsFact(s);
  const attention = s.openAttentions[0];
  const live = s.state === "working" || s.state === "needs_you";
  const showText = lens === null || lens >= 2;
  const showTools = lens === null || lens >= 1;
  // The prompt as the preview, unless the title already is it (lib/format.ts uncutTitle):
  // then only what follows its first line, never the same sentence twice.
  const ask = (s.progress?.user || s.lastUser || "").trim();
  const askRest = ask && ask.split("\n")[0]!.trim() === title ? ask.split("\n").slice(1).join(" ").trim() : ask;
  const liveText = showText
    ? s.progress?.assistant?.trim() || s.lastAssistant?.trim() || (askRest ? `“${askRest}”` : "")
    : "";
  const isLiveText = !!s.progress?.assistant?.trim();
  const tool = showTools && s.currentTool && s.state === "working" ? s.currentTool : undefined;
  const attnTool = attention?.tool && showTools ? attention.tool : undefined;
  const ref = useRef<HTMLElement>(null);
  const beside = (o: { background: boolean } = { background: false }) =>
    openSplit(s.key, { from: ref.current?.getBoundingClientRect(), background: o.background });
  // Allow / Deny in the menu, through the same signed send as the inbox, while a
  // permission is open (CardAnswer keeps them current).
  const answer = useRef<MenuList>([]);
  const menu = useContextMenu(
    () =>
      sessionItems(s, {
        store,
        surface: "list",
        answer: answer.current,
        children,
        extra: onlyItems(s, { onlyMachine, onlyHarness }),
      }),
    { title: () => sessionMenuTitle(s), subtitle: () => sessionMenuSubtitle(s) },
  );
  const repo = repoShort(s.repo);
  const time = attention ? attention.at : tool ? tool.since : s.stateSince;
  const failed = showTools && lastFailed(s);
  // The counts the row no longer prints are its tooltip: "2 turns · 5 tools · 1 error".
  const tip = [title, countsLine(s, showTools)].filter(Boolean).join("\n");
  const warm = prefetchProps(store, s);
  const rowRef = useRef<HTMLDivElement>(null);
  // A phone's swipes (iOS Mail): trailing hides it (with Undo), leading labels it.
  useSwipe(rowRef, {
    lead: () => openMenu(labelItems(store, [s.key]), rowRef.current!, { source: "touch", title: "Label" }),
    trail: () => hide(s.key, s.stateSince, { title, session: s.key }),
  });
  return (
    <article
      ref={ref}
      className={`card card--${s.state}`}
      data-flip={s.key}
      data-gone={gone ? "" : undefined}
      data-cursor={cursor !== undefined ? String(cursor) : undefined}
      aria-current={cursor !== undefined ? "true" : undefined}
      data-open={open ? "" : undefined}
      {...menu}
    >
      {attention?.kind === "permission" && <CardAnswer s={s} into={answer} />}
      <div className="card-row" ref={rowRef} {...warm}>
        <SwipePanes lead="Label" trail="Hide" />
        {agents.length > 0 && (
          <button
            type="button"
            className="card-disclose"
            aria-expanded={showAgents}
            aria-label={showAgents ? "Hide subagents" : "Show subagents"}
            tabIndex={-1}
            onClick={(e) => {
              e.preventDefault();
              toggleAgents();
            }}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <Link
          to={sessionPath(s.harness, s.id)}
          className="card-link"
          title={tip}
          modClick={beside}
          plainClick={openBeside ? () => beside() : undefined}
          data-nav-item=""
          onKeyDown={
            agents.length > 0
              ? (e) => {
                  // → opens the agents, ← folds them (Finder's list keys).
                  if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
                  if (e.key === "ArrowRight" && !showAgents) toggleAgents(true);
                  else if (e.key === "ArrowLeft" && showAgents) toggleAgents(false);
                  else return;
                  e.preventDefault();
                }
              : undefined
          }
          aria-expanded={agents.length > 0 ? showAgents : undefined}
        >
          <h3 className="card-title ellipsis">{title}</h3>
          {/* The state, the request and the time: one element for e2e, laid out across the
              row's two lines (the glyph in the lead, the time at line 1's end). */}
          <span className="card-status">
            <span className="card-state" data-jump={jump}>
              <StateDot state={s.state} decorative />
              <span className="sr-only">{STATE_LABEL[s.state]}</span>
              <LabelDot session={s.key} />
            </span>
            {attention && (
              <span className={`card-kind ${attnTool ? "sr-only" : ""}`}>
                {attnTool ? " · " : ""}
                {ATTENTION_LABEL[attention.kind] ?? attention.kind}
              </span>
            )}
            {attnTool && <code className="card-tool">{toolLabel(attnTool)}</code>}
            {!attention && tool && <code className="card-tool">{toolLabel(tool.tool)}</code>}
            <span
              className="card-time meta-col"
              title={
                live
                  ? `Started ${new Date(s.startedAt).toLocaleString()}`
                  : `Last event ${new Date(s.lastAt).toLocaleString()}`
              }
            >
              {frozenAt ? <Frozen iso={time} at={frozenAt} /> : <Since iso={time} coarse />}
            </span>
          </span>

          <span className="card-line">
            {attention ? (
              <span className={`card-attn ${literalAsk(attnTool) ? "mono" : ""}`}>
                {attention.message && showTools ? (
                  attnTool ? (
                    <Redacted text={oneLine(attentionMessage(attention) || attention.message, 240)} />
                  ) : (
                    <Inline text={oneLine(attention.message, 240)} />
                  )
                ) : (
                  "waiting for you"
                )}
              </span>
            ) : liveText ? (
              <span className="card-text">
                <Inline text={oneLine(isLiveText ? tail(liveText, 300) : liveText, 300)} />
              </span>
            ) : null}
            {/* The tree under the row says it once it is open: then the words are for a
                screen reader only, and the preview keeps the line. */}
            {fact && <span className={`card-agents num${showAgents ? " sr-only" : ""}`}>{fact}</span>}
            <Flags flags={s.flags} tool={tool?.tool ?? attnTool} />
          </span>

          <span className="card-meta">
            <HarnessGlyph name={s.harness} size="sm" />
            <span className="card-where ellipsis">
              {s.machine}
              {s.machine && repo ? " · " : ""}
              {repo}
              {/* The branch stays for search and the tooltip; the row shows the repo. */}
              {s.branch && <span className="sr-only"> @ {s.branch}</span>}
            </span>
          </span>

          {!simple && counts ? (
            <span className="card-foot num">
              {/* A zero says nothing: its column stays, empty, so the columns still align. */}
              {s.counts.turns > 0 ? <span>{plural(s.counts.turns, "turn")}</span> : <span aria-hidden="true" />}
              {showTools &&
                (s.counts.tools > 0 ? <span>{plural(s.counts.tools, "tool")}</span> : <span aria-hidden="true" />)}
              {/* An error is the glyph, never red words; its column keeps its width. */}
              {showTools && (failed || s.counts.toolErrors > 0 ? <ErrorMark s={s} /> : <span aria-hidden="true" />)}
            </span>
          ) : failed ? (
            <span className="card-foot card-foot--mark">
              <ErrorMark s={s} />
            </span>
          ) : null}
        </Link>
        <BesideButton onClick={() => beside()} />
      </div>
      {(showAgents || (kids && kids.length > 0)) && (
        <KidList
          s={s}
          agents={showAgents}
          kids={kids ?? []}
          openTab={openTab}
          all={allDone}
          onAll={() => setAllDone(true)}
          onlyMachine={onlyMachine}
          onlyHarness={onlyHarness}
          held={held}
        />
      )}
    </article>
  );
}, sameCard);

/** How many finished agents show under a parent before "Show n more". */
const DONE_SHOWN = 3;

type KidItem = { kind: "agent"; a: AgentRun } | { kind: "kid"; c: SessionSummary };
const kidKey = (k: KidItem) => (k.kind === "agent" ? `a:${k.a.id}` : `c:${k.c.key}`);
const kidGroup = (k: KidItem) => (k.kind === "agent" ? (k.a.state === "done" ? "done" : "open") : "kid");

/** A parent's tree: its agents (the open ones, then the newest finished, then "Show n
 *  more") and its child sessions. It holds still under the pointer like the board does:
 *  an agent that finishes stays where it is until the pointer leaves, then slides down
 *  to the finished ones. */
function KidList({
  s,
  agents,
  kids,
  openTab,
  all,
  onAll,
  held = false,
  ...only
}: {
  s: SessionSummary;
  agents: boolean;
  kids: SessionSummary[];
  openTab: string | null;
  all: boolean;
  onAll: () => void;
  held?: boolean;
} & Pick<SessionCardProps, "onlyMachine" | "onlyHarness">) {
  const ref = useRef<HTMLUListElement>(null);
  const hold = useListHold(ref) || held;
  const { shown, more } = agents
    ? agentsShown(s.agents, all ? Number.POSITIVE_INFINITY : DONE_SHOWN)
    : { shown: [], more: 0 };
  const items: KidItem[] = [
    ...shown.map((a): KidItem => ({ kind: "agent", a })),
    ...kids.map((c): KidItem => ({ kind: "kid", c })),
  ];
  const heldAll = useHeldOrder(items, kidKey, hold, kidGroup);
  // While held, a new agent waits with the rest of the news.
  const known = useRef<Set<string>>(new Set());
  // Held, new rows wait; but a list that has shown nothing yet (a first snapshot, a tree
  // just opened, the very first session) shows what it has at once.
  if (!hold || known.current.size === 0) known.current = new Set(heldAll.map((h) => h.key));
  const rows = hold ? heldAll.filter((h) => known.current.has(h.key)) : heldAll;
  useFlip(ref);
  return (
    <ul className="card-kids" ref={ref} aria-label={agents ? "Subagents" : undefined}>
      {rows.map((h) =>
        h.item.kind === "agent" ? (
          <AgentRow
            key={h.key}
            s={s}
            a={h.item.a}
            open={openTab === (h.item.a.session ?? agentTabKey(s.key as SessionKey, h.item.a.id))}
            flip={h.key}
            gone={h.gone}
          />
        ) : (
          <KidRow key={h.key} c={h.item.c} flip={h.key} gone={h.gone} {...only} />
        ),
      )}
      {more > 0 && (
        <li className="kid-more">
          <button type="button" className="kid-more-btn" onClick={onAll}>
            Show {more} more
          </button>
        </li>
      )}
    </ul>
  );
}

/** A subagent: one line under its parent, on the tree guide, with the session menu. */
function KidRow({
  c,
  flip,
  gone = false,
  ...only
}: { c: SessionSummary; flip?: string; gone?: boolean } & Pick<SessionCardProps, "onlyMachine" | "onlyHarness">) {
  const store = useStore();
  const menu = useContextMenu(() => sessionItems(c, { store, surface: "list", extra: onlyItems(c, only) }), {
    title: () => sessionMenuTitle(c),
    subtitle: () => sessionMenuSubtitle(c),
  });
  return (
    <li {...menu} {...prefetchProps(store, c)} data-flip={flip} data-gone={gone ? "" : undefined}>
      <Link
        to={sessionPath(c.harness, c.id)}
        className="kid"
        title={sessionTitle(c)}
        modClick={(o) => openSplit(c.key, { background: o.background })}
      >
        <StateDot state={c.state} decorative />
        <span className="kid-title ellipsis">{sessionTitle(c)}</span>
        {c.currentTool && c.state === "working" ? (
          <code className="kid-tool">{toolLabel(c.currentTool.tool)}</code>
        ) : (
          <span className="kid-state">{STATE_LABEL[c.state]}</span>
        )}
      </Link>
    </li>
  );
}

/** Keeps a row's Allow / Deny menu items current: mounted only while a permission is
 *  open, so the other rows never pay for the send's state. */
function CardAnswer({ s, into }: { s: SessionSummary; into: MutableRefObject<MenuList> }) {
  const { machines } = useAppState();
  const control = s.machine ? machines.get(s.machine)?.control : undefined;
  const a = s.openAttentions.find((x) => x.kind === "permission");
  const send = useSessionSend(s, control, s.openAttentions);
  const st = a ? answerState(s, a, control, send) : null;
  useLayoutEffect(() => {
    into.current =
      a && st && st.status !== "closed"
        ? answerItems(a.tool, st, (allow) =>
            send.onSend({ kind: "permission.answer", attentionId: a.attentionId, allow }).catch(() => {}),
          )
        : [];
  });
  useEffect(
    () => () => {
      into.current = [];
    },
    [into],
  );
  return null;
}

/** Allow and Deny as menu items, disabled with the reason when nothing can go. */
export function answerItems(
  tool: string | undefined,
  st: { off: boolean; reason: string | null },
  answer: (allow: boolean) => unknown,
): MenuItem[] {
  const disabled = st.off ? (st.reason ?? true) : undefined;
  const what = tool ? ` ${tool}` : "";
  return [
    { label: `Allow${what}`, disabled, run: () => void answer(true) },
    { label: `Deny${what}`, disabled, run: () => void answer(false) },
  ];
}

/** The tier lens as a submenu (Advanced only; Simple always shows everything). */
export function lensMenu(lens: Lens, simple: boolean): MenuList {
  if (simple) return [];
  return [
    {
      label: "Tier lens",
      items: LENSES.map((l) => ({
        label: l === null ? "All" : String(l),
        radio: true,
        checked: l === lens,
        run: () => setTierLens(l),
      })),
    },
  ];
}

/** A page's own menu, for a right-click on its empty space (the rows' menus win, being
 *  innermost). The menu is claimed for the page bar, not the page: the menu host moves
 *  the list cursor to the first row inside whatever claimed it, and a click between rows
 *  must not select one. No long-press: a native list has no background sheet. */
export function useBackgroundMenu(build: () => MenuList | null, o: { title?: () => string } = {}) {
  const m = useContextMenu(build, o);
  return {
    onContextMenu: (e: ReactMouseEvent<HTMLElement>) => {
      const bar = e.currentTarget.querySelector<HTMLElement>(":scope > .bar") ?? e.currentTarget;
      m.onContextMenu(Object.assign(Object.create(e), { currentTarget: bar }) as ReactMouseEvent<HTMLElement>);
    },
  };
}

/** Keeps `--sticky-top` on a page equal to its page bar's height, so section headers
 *  stick right under the bar however tall it is (a second tools row in a narrow column,
 *  the safe area on a phone, a larger text size). */
export function useStickyTop(page: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = page.current;
    const bar = el?.querySelector<HTMLElement>(":scope > .bar");
    if (!el || !bar || typeof ResizeObserver !== "function") return;
    const set = () => el.style.setProperty("--sticky-top", `${bar.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [page]);
}

/** The store's flags, folded into the end of line 2 in the muted tier. A slow tool the
 *  row already names is not said again ("Read  Read · 3 m"); an error streak is the ✕ at
 *  the row's end, so it is not words here. */
function Flags({ flags, tool }: { flags: SessionFlag[] | undefined; tool?: string }) {
  const shown = (flags ?? []).filter((f) => f.kind !== "error_streak" && !(f.kind === "slow_tool" && tool));
  if (!shown.length) return null;
  return (
    <span className="card-flags">
      {shown.map((f) => (
        <span key={f.kind}>{f.detail}</span>
      ))}
    </span>
  );
}

/** The last tool failed, or the store reads an error streak: the one red mark a row has. */
const lastFailed = (s: SessionSummary): boolean =>
  s.flags?.some((f) => f.kind === "error_streak") || s.recentTools?.[s.recentTools.length - 1]?.ok === false;

/** "2 turns · 5 tools · 1 error", for the row's tooltip; nothing for a zero. */
function countsLine(s: SessionSummary, tools: boolean): string {
  return [
    s.counts.turns > 0 && plural(s.counts.turns, "turn"),
    tools && s.counts.tools > 0 && plural(s.counts.tools, "tool"),
    tools && s.counts.toolErrors > 0 && plural(s.counts.toolErrors, "error"),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The error mark: a small ✕ in --err, no word; what it means is its name and tooltip. */
function ErrorMark({ s }: { s: SessionSummary }) {
  const streak = s.flags?.find((f) => f.kind === "error_streak")?.detail;
  const name = streak ?? (s.counts.toolErrors > 0 ? plural(s.counts.toolErrors, "tool error") : "The last tool failed");
  return (
    <span className="card-err" role="img" aria-label={name} title={name}>
      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
        <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** A time stopped at the moment the stream went down: the same grammar, no ticking. */
function Frozen({ iso, at }: { iso: string | undefined; at: number }) {
  if (!iso) return null;
  return (
    <time dateTime={iso} className="num" title="Paused while the stream is down">
      {durCoarse(at - ms(iso))}
    </time>
  );
}

// ----- swipe actions on a phone row -----

/** How far a row travels before letting go performs its action. */
const SWIPE_AT = 72;

/** The actions a swipe uncovers, under the row's content: shown only while it moves. */
export function SwipePanes({ lead, trail }: { lead?: string; trail?: string }) {
  return (
    <>
      {lead && (
        <span className="swipe-pane swipe-pane--lead" aria-hidden="true">
          {lead}
        </span>
      )}
      {trail && (
        <span className="swipe-pane swipe-pane--trail" aria-hidden="true">
          {trail}
        </span>
      )}
    </>
  );
}

/** A row's horizontal swipe on touch: its first child (the content) follows the finger,
 *  the pane under it shows what letting go will do, and past SWIPE_AT it is done (a tick
 *  of vibration where there is one). A vertical move is the page's scroll; a long-press
 *  is still the action sheet. Never on the signed answers: a swipe hides or labels. */
export function useSwipe(ref: RefObject<HTMLElement | null>, on: { lead?: () => void; trail?: () => void }): void {
  const act = useRef(on);
  act.current = on;
  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    let start: { x: number; y: number; id: number } | null = null;
    let dx = 0;
    let swiping = false;
    let armed = false;
    const content = () => row.querySelector<HTMLElement>(":scope > .card-link, :scope > .inbox-main");
    const set = (x: number, animate: boolean) => {
      const el = content();
      if (!el) return;
      el.style.transition = animate ? `transform ${tokenMsSafe()}ms cubic-bezier(0.22, 1, 0.36, 1)` : "none";
      el.style.transform = x ? `translateX(${x}px)` : "";
      if (x > 0) row.setAttribute("data-swipe", "lead");
      else if (x < 0) row.setAttribute("data-swipe", "trail");
      if (!x && animate) window.setTimeout(() => row.removeAttribute("data-swipe"), tokenMsSafe());
      const past = Math.abs(x) >= SWIPE_AT;
      if (past !== armed) {
        armed = past;
        row.toggleAttribute("data-swipe-armed", past);
        if (past) navigator.vibrate?.(6);
      }
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      dx = 0;
      swiping = false;
    };
    const move = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return;
      const x = e.clientX - start.x;
      const y = e.clientY - start.y;
      if (!swiping) {
        if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) {
          start = null;
          return;
        }
        if (Math.abs(x) < 12) return;
        if ((x > 0 && !act.current.lead) || (x < 0 && !act.current.trail)) return;
        swiping = true;
      }
      // Rubber past the action's width, nothing the other way when it has no action.
      const max = row.offsetWidth * 0.6;
      dx = Math.max(-max, Math.min(max, x));
      set(dx, false);
    };
    const up = () => {
      if (!start) return;
      start = null;
      if (!swiping) return;
      const go = Math.abs(dx) >= SWIPE_AT;
      const which = dx > 0 ? act.current.lead : act.current.trail;
      set(0, true);
      row.removeAttribute("data-swipe-armed");
      armed = false;
      // The finger lifting is not a tap on the row.
      const swallow = (c: Event) => {
        c.preventDefault();
        c.stopPropagation();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 400);
      if (go) which?.();
    };
    row.addEventListener("pointerdown", down);
    row.addEventListener("pointermove", move);
    row.addEventListener("pointerup", up);
    row.addEventListener("pointercancel", up);
    return () => {
      row.removeEventListener("pointerdown", down);
      row.removeEventListener("pointermove", move);
      row.removeEventListener("pointerup", up);
      row.removeEventListener("pointercancel", up);
    };
  }, [ref]);
}

const tokenMsSafe = () => (reducedMotion() ? 0 : tokenMs("--dur", 200));

// ----- one-line previews: inline Markdown read as text -----

/** One line of an agent's text with its inline Markdown read, not printed: a code span is
 *  mono without its ticks, emphasis and links are their words, a heading or quote mark
 *  goes. Placeholders for removed secrets keep their highlight. */
/** Whether a tool's request is a literal a person might copy (a command, a path), set in
 *  mono; an MCP tool's is a sentence ("Open a pull request on acme/billing"), in the UI
 *  face. */
export const literalAsk = (tool: string | undefined): boolean => !!tool && !tool.startsWith("mcp__");

export function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`)/g);
  if (parts.length === 1) return <Redacted text={plainMarkdown(text)} />;
  return (
    <>
      {parts.map((p, i) =>
        p.length > 2 && p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="inline-code">
            <Redacted text={p.slice(1, -1)} />
          </code>
        ) : (
          <Redacted key={i} text={plainMarkdown(p)} />
        ),
      )}
    </>
  );
}

/** Inline Markdown down to its words: `**b**`, `*i*`, `__b__`, `_i_` (between word edges,
 *  so snake_case stays), `~~s~~`, `[text](url)`, a leading `#`, `>` or list mark. */
export function plainMarkdown(t: string): string {
  return t
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?=\S))/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(?=\S)([^*_]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([^~]*?\S)~~/g, "$1");
}

// ----- Advanced → "Show counts", per device -----

const COUNTS_KEY = "sessionpipe-gui.board.counts";
let countsOn: boolean | null = null;
const countsListeners = new Set<() => void>();
const readCounts = (): boolean => {
  if (countsOn !== null) return countsOn;
  try {
    countsOn = localStorage.getItem(COUNTS_KEY) === "1";
  } catch {
    countsOn = false;
  }
  return countsOn;
};

/** Whether the board prints turns, tools and errors as columns (Advanced only). */
export function useShowCounts(): boolean {
  return useSyncExternalStore(
    (l) => {
      countsListeners.add(l);
      return () => {
        countsListeners.delete(l);
      };
    },
    readCounts,
    () => false,
  );
}

export function setShowCounts(on: boolean): void {
  countsOn = on;
  try {
    if (on) localStorage.setItem(COUNTS_KEY, "1");
    else localStorage.removeItem(COUNTS_KEY);
  } catch {
    // a private window: the choice lasts for this page
  }
  for (const l of countsListeners) l();
}

/** The store's flags as one muted line: "· 3 tool errors in a row · waiting for 2 events".
 *  Only an error streak is coloured. Renders nothing when there are none. */
export function FlagLine({ flags, className }: { flags: SessionFlag[] | undefined; className: string }) {
  if (!flags?.length) return null;
  return (
    <p className={className}>
      {flags.map((f, i) => (
        <Fragment key={f.kind}>
          <span className="sep">{i > 0 ? " · " : "· "}</span>
          <span className={f.kind === "error_streak" ? "is-err" : undefined}>{f.detail}</span>
        </Fragment>
      ))}
    </p>
  );
}

/** "Open beside": two panes, in a row's reserved trailing slot, shown on hover. */
export function BesideButton({
  onClick,
  className = "card-beside",
  children,
}: {
  onClick: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${className}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      aria-label="Open beside"
      title="Open beside (shift+click; ⌘/ctrl+click for a background tab)"
      tabIndex={-1}
    >
      {children ?? (
        <svg
          viewBox="0 0 20 20"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2.5" y="4" width="15" height="12" rx="1.5" />
          <path d="M11 4v12" />
        </svg>
      )}
    </button>
  );
}

const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n + 1)}` : s);
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
