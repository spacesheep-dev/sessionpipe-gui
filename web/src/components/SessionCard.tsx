// SPDX-License-Identifier: Apache-2.0
// One session on the board, as a row of a native list: the status glyph in the lead (the
// one signal for its state), the title and one time on the first line, what it is doing
// on the second (the request for a prompt that needs you, else the latest thing it said)
// with the machine and repo trailing. Subagents nest under it as single-line child rows
// on a tree guide. A right-click (a long-press on touch) opens the session's menu.
// The class names are the e2e contract (`article.card`, `.card-status`, `.card-meta`…),
// so they stay even though nothing here is a card any more.
import type { SessionFlag, SessionSummary } from "@shared/api";
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
} from "react";
import { answerState, useSessionSend } from "../control/useSend";
import { useAppState, useStore } from "../data/hooks";
import {
  ATTENTION_LABEL,
  attentionMessage,
  harnessMark,
  oneLine,
  repoShort,
  STATE_LABEL,
  sessionTitle,
} from "../lib/format";
import { sessionItems, sessionMenuSubtitle, sessionMenuTitle } from "../lib/menus";
import { Link, sessionPath } from "../lib/router";
import { LENSES, type Lens, setTierLens } from "../lib/settings";
import { openSplit } from "../lib/split";
import { HarnessGlyph, Redacted, Since, StateDot } from "./bits";
import { type MenuItem, type MenuList, useContextMenu } from "./ContextMenu";

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
  /** The board's filters, for the menu's "Show only …" (stable setters). */
  onlyMachine?: (m: string) => void;
  onlyHarness?: (h: string) => void;
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
  a.onlyMachine === b.onlyMachine &&
  a.onlyHarness === b.onlyHarness &&
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
  onlyMachine,
  onlyHarness,
}: SessionCardProps) {
  const store = useStore();
  const attention = s.openAttentions[0];
  const live = s.state === "working" || s.state === "needs_you";
  const showText = lens === null || lens >= 2;
  const showTools = lens === null || lens >= 1;
  const liveText = showText
    ? s.progress?.assistant?.trim() ||
      s.lastAssistant?.trim() ||
      (s.progress?.user ? `“${s.progress.user}”` : s.lastUser ? `“${s.lastUser}”` : "")
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
  return (
    <article
      ref={ref}
      className={`card card--${s.state}`}
      data-cursor={cursor !== undefined ? String(cursor) : undefined}
      aria-current={cursor !== undefined ? "true" : undefined}
      data-open={open ? "" : undefined}
      {...menu}
    >
      {attention?.kind === "permission" && <CardAnswer s={s} into={answer} />}
      <div className="card-row">
        <Link
          to={sessionPath(s.harness, s.id)}
          className="card-link"
          title={sessionTitle(s)}
          modClick={beside}
          plainClick={openBeside ? () => beside() : undefined}
          data-nav-item=""
        >
          <h3 className="card-title ellipsis">{sessionTitle(s)}</h3>
          {/* The state, the request and the time: one element for e2e, laid out across the
              row's two lines (the glyph in the lead, the time at line 1's end). */}
          <span className="card-status">
            <span className="card-state">
              <StateDot state={s.state} decorative />
              <span className="sr-only">{STATE_LABEL[s.state]}</span>
            </span>
            {attention && (
              <span className={`card-kind ${attnTool ? "sr-only" : ""}`}>
                {attnTool ? " · " : ""}
                {ATTENTION_LABEL[attention.kind] ?? attention.kind}
              </span>
            )}
            {attnTool && <code className="card-tool">{attnTool}</code>}
            {!attention && tool && <code className="card-tool">{tool.tool}</code>}
            <span
              className="card-time"
              title={
                live
                  ? `Started ${new Date(s.startedAt).toLocaleString()}`
                  : `Last event ${new Date(s.lastAt).toLocaleString()}`
              }
            >
              <Since iso={time} coarse />
            </span>
          </span>

          <span className="card-line">
            {attention ? (
              <span className={`card-attn ${attnTool ? "mono" : ""}`}>
                {attention.message && showTools ? (
                  <Redacted text={oneLine((attnTool && attentionMessage(attention)) || attention.message, 240)} />
                ) : (
                  "waiting for you"
                )}
              </span>
            ) : liveText ? (
              <span className="card-text">
                <Redacted text={oneLine(isLiveText ? tail(liveText, 300) : liveText, 300)} />
              </span>
            ) : null}
            <Flags flags={s.flags} />
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

          {!simple && (
            <span className="card-foot num">
              {/* A zero says nothing: its column stays, empty, so the columns still align. */}
              {s.counts.turns > 0 ? <span>{plural(s.counts.turns, "turn")}</span> : <span aria-hidden="true" />}
              {showTools &&
                (s.counts.tools > 0 ? <span>{plural(s.counts.tools, "tool")}</span> : <span aria-hidden="true" />)}
              {/* The errors column keeps its width when there are none, so columns align. */}
              {showTools &&
                (s.counts.toolErrors > 0 ? (
                  <span className="is-err">{plural(s.counts.toolErrors, "error")}</span>
                ) : (
                  <span aria-hidden="true" />
                ))}
            </span>
          )}
        </Link>
        <BesideButton onClick={() => beside()} />
      </div>
      {children && children.length > 0 && (
        <ul className="card-kids">
          {children.map((c) => (
            <KidRow key={c.key} c={c} onlyMachine={onlyMachine} onlyHarness={onlyHarness} />
          ))}
        </ul>
      )}
    </article>
  );
}, sameCard);

/** A subagent: one line under its parent, on the tree guide, with the session menu. */
function KidRow({ c, ...only }: { c: SessionSummary } & Pick<SessionCardProps, "onlyMachine" | "onlyHarness">) {
  const store = useStore();
  const menu = useContextMenu(() => sessionItems(c, { store, surface: "list", extra: onlyItems(c, only) }), {
    title: () => sessionMenuTitle(c),
    subtitle: () => sessionMenuSubtitle(c),
  });
  return (
    <li {...menu}>
      <Link
        to={sessionPath(c.harness, c.id)}
        className="kid"
        title={sessionTitle(c)}
        modClick={(o) => openSplit(c.key, { background: o.background })}
      >
        <StateDot state={c.state} decorative />
        <span className="kid-title ellipsis">{sessionTitle(c)}</span>
        {c.currentTool && c.state === "working" ? (
          <code className="kid-tool">{c.currentTool.tool}</code>
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

/** The store's flags, folded into the end of line 2; only an error streak is coloured. */
function Flags({ flags }: { flags: SessionFlag[] | undefined }) {
  if (!flags?.length) return null;
  return (
    <span className="card-flags">
      {flags.map((f) => (
        <span key={f.kind} className={f.kind === "error_streak" ? "is-err" : undefined}>
          {f.detail}
        </span>
      ))}
    </span>
  );
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
