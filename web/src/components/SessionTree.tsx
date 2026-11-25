// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The sidebar's sessions, under its pages: New session, then Pinned (only
// while something is pinned) and Sessions, as one tree each (lib/tree.ts, the Board's own
// tree and order, less what this device hid). A row is one line: the agent's mark, the
// title cut at its end, a small computer mark where the session runs on another computer
// than the row above it in the tree (or, at the top level, wherever more than one computer
// is listed), and the state's lamp at the end (the board's glyphs: the turning ring while
// it works, the orange disc while it needs you, the dashed ring while it is quiet; nothing
// for the rest, so a long list stays calm). The open session's row is filled. A parent
// has a disclosure, in the mark's place under the pointer or the keyboard (at the row's
// end on a touch screen), and what it folds is remembered on this device. Thirty top
// rows, then Show more; eight under a parent, then Show N more.
//
// A row is dragged to arrange the tree: past 4 px with a pointer, after 350 ms held still
// with a finger (a tick under it; before that the list scrolls). It follows the pointer as
// a small chip; its place stays as a quiet gap. On a row it goes under it (an inset ring);
// on the line between top-level rows it goes to the top level, or to that place among the
// pinned; on the Pinned heading it is pinned. A row may not go under itself or its own
// sessions: those show no place. A folded parent held under it 600 ms opens; the list
// scrolls near its edges; Esc, or a drop anywhere else, puts it all back. The keys and
// the menu do the same (lib/arrange.ts), and a live region says what a move did. None of
// it reaches a machine: it is how this person sees the tree.
import { isEmptySession, type SessionKey, type SessionSummary } from "@shared/api";
import {
  type CSSProperties,
  type KeyboardEvent,
  memo,
  type ReactElement,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { openNewSession } from "../control/newSessionState";
import { useStore } from "../data/hooks";
import { arrange, onArranged, planMove } from "../lib/arrange";
import { sessionTitle } from "../lib/format";
import { haptic } from "../lib/haptics";
import { isHidden, useHidden } from "../lib/hidden";
import { sessionItems, sessionMenuSubtitle, sessionMenuTitle } from "../lib/menus";
import { type Held, useFlip, useHeldOrder, useListHold } from "../lib/motion";
import { hrefFor, sessionPath } from "../lib/router";
import { howOf, openSession } from "../lib/split";
import { arrangeTree, descendants, type Tree, type TreeNode } from "../lib/tree";
import {
  dragStarts,
  edgeScroll,
  type Group,
  LIFT_MS,
  moveFor,
  OPEN_AFTER_MS,
  type RowBox,
  type Target,
  targetAt,
  touchScrolls,
} from "../lib/treeDrag";
import { HarnessGlyph, StateDot } from "./bits";
import { closeMenu, useContextMenu } from "./ContextMenu";
import "../styles/sidetree.css";

/** Top-level rows shown before Show more, and how many more each press shows. */
export const TREE_SHOWN = 30;
/** Rows under one parent shown before Show N more. */
export const KIDS_SHOWN = 8;

// ----- what this device folded -----

const FOLDED_KEY = "sessionpipe-gui.sidebar.folded";
/** Folded parents remembered at most (the oldest go first). */
const FOLDED_MAX = 500;
const readFolded = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
};
function useFolded(): [ReadonlySet<SessionKey>, (key: SessionKey, fold: boolean) => void] {
  const [folded, set] = useState<ReadonlySet<SessionKey>>(() => new Set(readFolded()));
  const toggle = useCallback((key: SessionKey, fold: boolean) => {
    set((was) => {
      if (was.has(key) === fold) return was;
      const next = new Set(was);
      if (fold) next.add(key);
      else next.delete(key);
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify([...next].slice(-FOLDED_MAX)));
      } catch {
        // a private window: folded for this visit
      }
      return next;
    });
  }, []);
  return [folded, toggle];
}

// ----- the rows as drawn -----

/** One row as drawn, top to bottom (the keys and the drag walk these). */
interface Drawn {
  node: TreeNode;
  group: Group;
  hasKids: boolean;
  folded: boolean;
  /** The row it is drawn under, when it is drawn under one. */
  up?: SessionKey;
}

interface Drag {
  key: SessionKey;
  title: string;
  harness: string;
  target: Target | null;
  /** Where the pointer was at the lift: the chip's first place. */
  x: number;
  y: number;
}

/** The lamp at a row's end: the board's glyph where the state asks for one. */
function Lamp({ s, size }: { s: SessionSummary; size: number }) {
  if (s.state === "needs_you" || s.state === "working" || s.state === "stale")
    return <StateDot state={s.state} size={size} decorative />;
  return null;
}

/** What a screen reader hears after the title. */
const stateWords = (s: SessionSummary): string =>
  s.state === "needs_you" ? ", needs you" : s.state === "working" ? ", working" : s.state === "stale" ? ", quiet" : "";

/** The Machines page's own mark, small: this session runs on another computer. */
function AwayMark({ machine }: { machine: string }) {
  return (
    <span className="stree-away" title={`Runs on ${machine}`}>
      <svg
        viewBox="0 0 20 20"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="2.5" y="4" width="15" height="10" rx="1.5" />
        <path d="M7 17h6" />
      </svg>
    </span>
  );
}

/** A pin, for the place a held row is pinned. */
function PinGlyph() {
  return (
    <svg
      className="stree-new-glyph"
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7.5 3.5h5l-.8 5 2.8 2.5v1h-9v-1l2.8-2.5z" />
      <path d="M10 12v4.5" />
    </svg>
  );
}

function Chevron() {
  return (
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
  );
}

export function SessionTree({ open, touch }: { open: SessionKey | null; touch: boolean }) {
  const store = useStore();
  // Only what the tree draws: a control frame, a viewer or the stats redraw nothing here.
  const sessions = useSyncExternalStore(store.subscribe, () => store.get().sessions);
  const arrangement = useSyncExternalStore(store.subscribe, () => store.get().arrangement);
  const hidden = useHidden();
  const hid = useCallback(
    (s: SessionSummary) => isHidden(hidden, s.key, s.stateSince, s.state === "needs_you"),
    [hidden],
  );
  const all = useMemo(() => [...sessions.values()].filter((s) => !isEmptySession(s)), [sessions]);
  const tree = useMemo(
    () =>
      arrangeTree({
        all,
        arrangement,
        drawn: (p) => !hid(p),
        needs: (c) => c.state === "needs_you" && !hid(c),
      }),
    [all, arrangement, hid],
  );
  const pinSet = useMemo(() => new Set(arrangement.pinned), [arrangement.pinned]);
  const pinned = useMemo(
    () =>
      arrangement.pinned.map((k) => tree.nodes.get(k)).filter((n): n is TreeNode => !!n && n.level === 0 && !hid(n.s)),
    [arrangement.pinned, tree, hid],
  );
  const roots = useMemo(() => tree.roots.filter((n) => !pinSet.has(n.s.key) && !hid(n.s)), [tree, pinSet, hid]);
  // More than one computer listed: a top-level row names where it runs.
  const many = useMemo(() => new Set(all.filter((s) => !hid(s)).map((s) => s.machine ?? "")).size > 1, [all, hid]);

  // Held still under the hand, as the board is: no row moves while the pointer is over
  // the list, the keyboard is in it or a row's menu is up; the person's own move lands at once.
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const listHold = useListHold(box, { idle: false });
  const heldRev = useRef(arrangement.rev);
  const hold = (listHold || !!drag) && heldRev.current === arrangement.rev;
  heldRev.current = arrangement.rev;
  const heldRoots = useHeldOrder(roots, nodeKey, hold);
  const [limit, setLimit] = useState(TREE_SHOWN);
  const shownRoots = heldRoots.slice(0, limit);
  const more = heldRoots.length - shownRoots.length;

  const [folded, setFolded] = useFolded();
  const [allKids, setAllKids] = useState<ReadonlySet<SessionKey>>(new Set());
  const kidsOf = useCallback((n: TreeNode) => n.kids.filter((k) => !hid(k.s)), [hid]);

  // The rows as drawn, for the keys and the drag.
  const drawn = useMemo(() => {
    const out: Drawn[] = [];
    const walk = (n: TreeNode, group: Group, up?: SessionKey) => {
      const kids = kidsOf(n);
      const isFolded = kids.length > 0 && folded.has(n.s.key);
      out.push({ node: n, group, hasKids: kids.length > 0, folded: isFolded, ...(up ? { up } : {}) });
      if (isFolded) return;
      const shown = allKids.has(n.s.key) ? kids : kids.slice(0, KIDS_SHOWN);
      for (const k of shown) walk(k, group, n.s.key);
    };
    for (const n of pinned) walk(n, "pinned");
    for (const h of shownRoots) if (!h.gone) walk(h.item, "sessions");
    return out;
  }, [pinned, shownRoots, kidsOf, folded, allKids]);

  // ----- focus: one row in the tab order, the arrows walk the rest -----
  const [focusKey, setFocusKey] = useState<SessionKey | null>(null);
  const has = (k: SessionKey | null | undefined) => !!k && drawn.some((d) => d.node.s.key === k);
  const tabKey = has(focusKey) ? focusKey : has(open) ? open : drawn[0]?.node.s.key;
  const rowEl = (key: string) => box.current?.querySelector<HTMLElement>(`[data-tree-row="${CSS.escape(key)}"]`);
  // A move by the keys or the menu draws the row in another list: the focus goes with it.
  const hadFocus = useRef(false);
  useLayoutEffect(() => {
    if (!focusKey || !hadFocus.current) return;
    const a = document.activeElement;
    if (a && a !== document.body) {
      if (!box.current?.contains(a)) hadFocus.current = false;
      return;
    }
    rowEl(focusKey)?.focus();
  });
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const here = e.target as HTMLElement;
    if (!here.matches?.("[data-tree-nav]") || e.altKey || e.metaKey || e.ctrlKey) return;
    // The rows as drawn, in both lists, and the Show more rows among them.
    const items = [...(box.current?.querySelectorAll<HTMLElement>("[data-tree-nav]") ?? [])];
    const i = items.indexOf(here);
    const key = here.dataset.treeRow;
    const kids = here.hasAttribute("data-has-kids");
    const isFolded = here.getAttribute("aria-expanded") === "false";
    let to: HTMLElement | undefined;
    switch (e.key) {
      case "ArrowDown":
        to = items[i + 1];
        break;
      case "ArrowUp":
        to = items[i - 1];
        break;
      case "Home":
        to = items[0];
        break;
      case "End":
        to = items[items.length - 1];
        break;
      case "ArrowRight":
        if (key && kids && isFolded) setFolded(key, false);
        else if (kids) to = items[i + 1];
        else return;
        break;
      case "ArrowLeft":
        if (key && kids && !isFolded) setFolded(key, true);
        else if (here.dataset.up) to = rowEl(here.dataset.up) ?? undefined;
        else return;
        break;
      case "Enter":
      case " ":
        if (key) return;
        here.click();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (to) {
      if (to.dataset.treeRow) setFocusKey(to.dataset.treeRow);
      to.focus();
    }
  };

  // ----- what a move did, said -----
  const [said, setSaid] = useState("");
  useEffect(
    () =>
      onArranged((words) => {
        // The same words twice are said twice.
        setSaid("");
        requestAnimationFrame(() => setSaid(words));
      }),
    [],
  );

  // ----- the drag -----
  const scroller = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const live = useRef({ tree, all, arrangement, drawn, folded });
  live.current = { tree, all, arrangement, drawn, folded };
  /** A click right after a drag is not a click on the row. */
  const justDragged = useRef(false);
  const onRowDown = useDragStart({
    store,
    box,
    scroller,
    chip,
    line,
    live,
    setDrag,
    justDragged,
    unfold: (key) => setFolded(key, false),
  });

  // One set of handlers for every row, stable, so a row redraws only when what it shows does.
  const latest = useRef({ setFocusKey, setFolded, onRowDown });
  latest.current = { setFocusKey, setFolded, onRowDown };
  const actions = useMemo<RowActions>(
    () => ({
      down: (e, s) => latest.current.onRowDown(e, s),
      focus: (key) => {
        hadFocus.current = true;
        latest.current.setFocusKey(key);
      },
      fold: (key, fold) => latest.current.setFolded(key, fold),
      click: (e, key) => {
        if (justDragged.current) {
          e.preventDefault();
          justDragged.current = false;
          return;
        }
        if (e.button !== 0) return;
        e.preventDefault();
        openSession(key, howOf(e));
      },
    }),
    [],
  );

  const groupId = useId();
  const row = (n: TreeNode, group: Group, pos: number, size: number, parent?: TreeNode): ReactElement => {
    const s = n.s;
    const key = s.key;
    const kids = kidsOf(n);
    const isFolded = kids.length > 0 && folded.has(key);
    const shown = isFolded ? [] : allKids.has(key) ? kids : kids.slice(0, KIDS_SHOWN);
    const hiddenKids = kids.length - (isFolded ? kids.length : shown.length);
    // Against the session it really hangs under (a row drawn flat at the last level hangs
    // under the row before it, not the row its list is under).
    const above = n.parent ? (tree.nodes.get(n.parent)?.s ?? parent?.s) : undefined;
    const away = above ? !!s.machine && !!above.machine && s.machine !== above.machine : many && !!s.machine;
    const id = `${groupId}-${group}-${key}`;
    return (
      <TreeRow
        key={key}
        n={n}
        group={group}
        pos={pos}
        size={size}
        open={key === open}
        tab={key === tabKey}
        away={away}
        hasKids={kids.length > 0}
        folded={isFolded}
        groupId={id}
        target={drag?.target?.kind === "on" && drag.target.key === key}
        lifted={drag?.key === key}
        touch={touch}
        up={parent?.s.key}
        actions={actions}
      >
        {shown.length > 0 && (
          <KidGroup id={id} level={n.level} label={sessionTitle(s)}>
            {shown.map((k, i) => row(k, group, i + 1, shown.length, n))}
            {hiddenKids > 0 && !isFolded && (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the tree has the keys (Enter and Space press it)
              <div
                role="treeitem"
                aria-level={n.level + 2}
                tabIndex={-1}
                className="stree-more"
                data-tree-nav=""
                data-up={key}
                style={{ "--lvl": n.level + 1 } as CSSProperties}
                onClick={() => setAllKids((was) => new Set(was).add(key))}
              >
                Show {hiddenKids} more
              </div>
            )}
          </KidGroup>
        )}
      </TreeRow>
    );
  };

  const listRef = useRef<HTMLDivElement>(null);
  const pinRef = useRef<HTMLDivElement>(null);
  useFlip(listRef, 80, { move: 150 });
  useFlip(pinRef, 80, { move: 150 });
  const empty = drawn.length === 0 && heldRoots.length === 0;
  // Nothing pinned yet: while a row is held up, New session's place is where it is pinned
  // (the same height, so no row moves for it).
  const pinZone = !!drag && pinned.length === 0;
  return (
    <div
      className={`stree${touch ? " stree--touch" : ""}`}
      ref={box}
      data-dragging={drag ? "" : undefined}
      data-held={hold ? "" : undefined}
    >
      {pinZone ? (
        <div
          className="stree-new stree-pin-zone"
          data-zone="pinned"
          data-target={drag?.target?.kind === "pinned" ? "" : undefined}
        >
          <PinGlyph />
          <span>Drop here to pin</span>
        </div>
      ) : (
        <button type="button" className="stree-new" onClick={() => openNewSession()}>
          <svg
            className="stree-new-glyph"
            viewBox="0 0 20 20"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="10" cy="10" r="7" />
            <path d="M10 7v6M7 10h6" />
          </svg>
          <span>New session</span>
        </button>
      )}
      <div className="stree-scroll" ref={scroller}>
        {pinned.length > 0 && (
          <section className="stree-section" aria-labelledby={`${groupId}-pinned`}>
            <h2
              className="stree-label"
              id={`${groupId}-pinned`}
              data-zone="pinned"
              data-target={drag?.target?.kind === "pinned" ? "" : undefined}
            >
              Pinned
            </h2>
            <div
              className="stree-list"
              role="tree"
              aria-labelledby={`${groupId}-pinned`}
              onKeyDown={onKey}
              ref={pinRef}
            >
              {pinned.map((n, i) => row(n, "pinned", i + 1, pinned.length))}
            </div>
          </section>
        )}
        <section className="stree-section" aria-labelledby={`${groupId}-sessions`}>
          <h2 className="stree-label" id={`${groupId}-sessions`} data-zone="sessions">
            Sessions
          </h2>
          {empty ? (
            <p className="stree-none">{all.length > 0 ? "All hidden on this device" : "None yet"}</p>
          ) : (
            <div
              className="stree-list"
              role="tree"
              aria-labelledby={`${groupId}-sessions`}
              onKeyDown={onKey}
              ref={listRef}
            >
              {shownRoots.map((h, i) =>
                h.gone ? <GoneRow key={h.key} h={h} /> : row(h.item, "sessions", i + 1, shownRoots.length),
              )}
            </div>
          )}
          {more > 0 && (
            <button
              type="button"
              className="stree-more-btn stree-more-all"
              onClick={() => setLimit((n) => n + TREE_SHOWN)}
            >
              Show more
              <span className="stree-more-count num">{more}</span>
            </button>
          )}
        </section>
        <div className="stree-line" ref={line} aria-hidden="true" hidden />
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-tree-said="">
        {said}
      </div>
      {drag &&
        createPortal(
          <div
            className="stree-chip"
            ref={chip}
            aria-hidden="true"
            style={{ transform: `translate(${Math.round(drag.x + 10)}px, ${Math.round(drag.y + 10)}px)` }}
          >
            <HarnessGlyph name={drag.harness} size="sm" />
            <span className="stree-chip-title">{drag.title}</span>
          </div>,
          document.body,
        )}
    </div>
  );
}

const nodeKey = (n: TreeNode) => n.s.key;

/** A row that left while the list was held: where it was, quiet and inert, until the hand leaves. */
function GoneRow({ h }: { h: Held<TreeNode> }) {
  return (
    <div role="none" className="stree-item" data-flip={h.key} data-gone="">
      <span className="stree-row" style={{ "--lvl": 0 } as CSSProperties}>
        <span className="stree-lead">
          <HarnessGlyph name={h.item.s.harness} size="sm" />
        </span>
        <span className="stree-title">{sessionTitle(h.item.s)}</span>
      </span>
    </div>
  );
}

/** The rows under a parent, on one rail; its own list for the FLIP. */
function KidGroup({ id, level, label, children }: { id: string; level: number; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref, 80, { move: 150 });
  return (
    // biome-ignore lint/a11y/useSemanticElements: a tree's group of treeitems (WAI-ARIA tree pattern), not a form's fieldset
    <div
      className="stree-kids"
      role="group"
      id={id}
      aria-label={`Under ${label}`}
      ref={ref}
      style={{ "--lvl": level } as CSSProperties}
    >
      {children}
    </div>
  );
}

interface RowActions {
  down: (e: ReactPointerEvent<HTMLElement>, s: SessionSummary) => void;
  focus: (key: SessionKey) => void;
  fold: (key: SessionKey, fold: boolean) => void;
  click: (e: ReactMouseEvent<HTMLAnchorElement>, key: SessionKey) => void;
}

interface RowProps {
  n: TreeNode;
  group: Group;
  pos: number;
  size: number;
  open: boolean;
  tab: boolean;
  away: boolean;
  hasKids: boolean;
  folded: boolean;
  groupId: string;
  /** A held row would go under this one. */
  target: boolean;
  /** This row is the one held up. */
  lifted: boolean;
  touch: boolean;
  /** The row it is drawn under (← goes there). */
  up?: SessionKey;
  actions: RowActions;
}

function TreeRow({ children, ...p }: RowProps & { children?: ReactNode }) {
  return (
    <div role="none" className="stree-item" data-flip={p.n.s.key} data-lifted={p.lifted ? "" : undefined}>
      <RowLine
        s={p.n.s}
        level={p.n.level}
        placed={p.n.placed}
        group={p.group}
        pos={p.pos}
        size={p.size}
        open={p.open}
        tab={p.tab}
        away={p.away}
        hasKids={p.hasKids}
        folded={p.folded}
        groupId={p.groupId}
        target={p.target}
        touch={p.touch}
        up={p.up}
        actions={p.actions}
      />
      {children}
    </div>
  );
}

/** The row itself: drawn again only when one of these changes (memo). */
const RowLine = memo(function RowLine({
  s,
  level,
  placed,
  group,
  pos,
  size,
  open,
  tab,
  away,
  hasKids,
  folded,
  groupId,
  target,
  touch,
  up,
  actions,
}: Omit<RowProps, "n" | "lifted"> & { s: SessionSummary; level: number; placed: boolean }) {
  const store = useStore();
  const title = sessionTitle(s);
  const menu = useContextMenu(() => sessionItems(s, { store, surface: "list" }), {
    title: () => sessionMenuTitle(s),
    subtitle: () => sessionMenuSubtitle(s),
  });
  const tip = [title, placed ? "Placed here by you" : "", away && s.machine ? `Runs on ${s.machine}` : ""]
    .filter(Boolean)
    .join("\n");
  const disclose = hasKids && (
    <span
      className="stree-disc"
      aria-hidden="true"
      data-folded={folded ? "" : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        actions.fold(s.key, !folded);
      }}
    >
      <Chevron />
    </span>
  );
  return (
    <a
      href={hrefFor(sessionPath(s.harness, s.id))}
      role="treeitem"
      aria-level={level + 1}
      aria-posinset={pos}
      aria-setsize={size}
      aria-expanded={hasKids ? !folded : undefined}
      aria-owns={hasKids && !folded ? groupId : undefined}
      aria-current={open ? "page" : undefined}
      aria-selected={open}
      tabIndex={tab ? 0 : -1}
      className="stree-row"
      data-tree-row={s.key}
      data-tree-nav=""
      data-up={up}
      data-level={level}
      data-group={group}
      data-state={s.state}
      data-open={open ? "" : undefined}
      data-placed={placed ? "" : undefined}
      data-target={target ? "" : undefined}
      data-has-kids={hasKids ? "" : undefined}
      style={{ "--lvl": level } as CSSProperties}
      title={tip}
      onClick={(e) => actions.click(e, s.key)}
      onFocus={() => actions.focus(s.key)}
      onPointerDown={(e) => actions.down(e, s)}
      onDragStart={(e) => e.preventDefault()}
      draggable={false}
      {...menu}
    >
      <span className="stree-lead">
        <HarnessGlyph name={s.harness} size={touch ? "md" : "sm"} />
        {!touch && disclose}
      </span>
      <span className="stree-title" dir="auto">
        {title}
      </span>
      {away && s.machine && <AwayMark machine={s.machine} />}
      <span className="stree-lamp">
        <Lamp s={s} size={touch ? 12 : 10} />
      </span>
      {touch && disclose}
      <span className="sr-only">
        {stateWords(s)}
        {placed ? ", placed here by you" : ""}
        {away && s.machine ? `, on ${s.machine}` : ""}
      </span>
    </a>
  );
});

// ----- the drag's hook -----

interface Live {
  tree: Tree;
  all: SessionSummary[];
  arrangement: { placed: Record<string, string | null>; pinned: string[]; rev: number };
  drawn: Drawn[];
  folded: ReadonlySet<SessionKey>;
}

function useDragStart(o: {
  store: ReturnType<typeof useStore>;
  box: RefObject<HTMLDivElement | null>;
  scroller: RefObject<HTMLDivElement | null>;
  chip: RefObject<HTMLDivElement | null>;
  line: RefObject<HTMLDivElement | null>;
  live: RefObject<Live>;
  setDrag: (d: Drag | null | ((was: Drag | null) => Drag | null)) => void;
  justDragged: RefObject<boolean>;
  unfold: (key: SessionKey) => void;
}) {
  const ref = useRef(o);
  ref.current = o;
  const active = useRef<(() => void) | null>(null);
  useEffect(() => () => active.current?.(), []);
  return useCallback((e: ReactPointerEvent<HTMLElement>, session: SessionSummary) => {
    const { store } = ref.current;
    if (e.button !== 0 || active.current || e.ctrlKey) return;
    const touch = e.pointerType === "touch";
    const el = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    const id = e.pointerId;
    let at = { ...start };
    let lifted = false;
    let held = false;
    let target: Target | null = null;
    let liftedAt = { ...start };
    let openTimer = 0;
    let liftTimer = 0;
    let frame = 0;
    const key = session.key;

    /** Where the rows are now, and the headings. */
    const measure = () => {
      const root = ref.current.box.current;
      const rows: RowBox[] = [];
      if (!root) return { rows, zones: {} };
      for (const r of root.querySelectorAll<HTMLElement>("[data-tree-row]")) {
        const b = r.getBoundingClientRect();
        rows.push({
          key: r.dataset.treeRow!,
          top: b.top,
          bottom: b.bottom,
          level: Number(r.dataset.level),
          group: r.dataset.group as Group,
        });
      }
      const zone = (sel: string) => {
        const z = root.querySelector<HTMLElement>(sel)?.getBoundingClientRect();
        return z ? { top: z.top, bottom: z.bottom } : undefined;
      };
      return { rows, zones: { pinned: zone('[data-zone="pinned"]'), sessions: zone('[data-zone="sessions"]') } };
    };

    const title = (k: SessionKey) => {
      const s = store.get().sessions.get(k);
      return s ? sessionTitle(s) : "a session";
    };

    const aim = () => {
      const { tree, all, arrangement } = ref.current.live.current!;
      const root = ref.current.box.current;
      const rect = root?.getBoundingClientRect();
      const inside = !!rect && at.x >= rect.left && at.x <= rect.right && at.y >= rect.top && at.y <= rect.bottom;
      const { rows, zones } = measure();
      let t = inside ? targetAt(rows, at.y, key, descendants(tree, key), zones) : null;
      if (t && !planMove(arrangement, tree, all, key, moveFor(t), title)) t = null;
      const same = JSON.stringify(t) === JSON.stringify(target);
      target = t;
      // The insertion line, drawn straight onto the list.
      const ln = ref.current.line.current;
      const sc = ref.current.scroller.current;
      if (ln && sc) {
        if (t?.kind === "line") {
          const top = t.y - sc.getBoundingClientRect().top + sc.scrollTop;
          ln.hidden = false;
          ln.style.transform = `translateY(${Math.round(top - 1)}px)`;
        } else ln.hidden = true;
      }
      if (same) return;
      ref.current.setDrag((d) => (d ? { ...d, target: t } : d));
      if (t && touch) haptic("selection");
      window.clearTimeout(openTimer);
      if (t?.kind === "on") {
        const row = ref.current.live.current!.drawn.find((d) => d.node.s.key === t.key);
        if (row?.folded) openTimer = window.setTimeout(() => ref.current.unfold(t.key), OPEN_AFTER_MS);
      }
    };

    const place = () => {
      const c = ref.current.chip.current;
      if (c) c.style.transform = `translate(${Math.round(at.x + 10)}px, ${Math.round(at.y + 10)}px)`;
    };

    const scrollLoop = () => {
      // The sidebar's own scroll (Shell.tsx .rail-scroll), which the pages share.
      const sc = ref.current.box.current?.closest<HTMLElement>(".rail-scroll") ?? ref.current.scroller.current;
      if (!sc || !lifted) return;
      const r = sc.getBoundingClientRect();
      const dy = edgeScroll(at.y, r.top, r.bottom);
      if (dy) {
        const was = sc.scrollTop;
        sc.scrollTop += dy;
        if (sc.scrollTop !== was) aim();
      }
      frame = requestAnimationFrame(scrollLoop);
    };

    const lift = () => {
      lifted = true;
      liftedAt = { ...at };
      if (!touch) {
        try {
          el.setPointerCapture(id);
        } catch {
          // the pointer is already gone
        }
      }
      closeMenu(false);
      const s = session;
      ref.current.setDrag({ key, title: sessionTitle(s), harness: s.harness, target: null, x: at.x, y: at.y });
      if (touch) haptic("selection");
      requestAnimationFrame(() => {
        place();
        aim();
      });
      frame = requestAnimationFrame(scrollLoop);
    };

    const end = (drop: boolean) => {
      window.clearTimeout(liftTimer);
      window.clearTimeout(openTimer);
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("keydown", esc, true);
      window.removeEventListener("contextmenu", noMenu, true);
      document.removeEventListener("touchmove", noScroll);
      active.current = null;
      const ln = ref.current.line.current;
      if (ln) ln.hidden = true;
      if (!lifted) return;
      ref.current.justDragged.current = true;
      // A click that never comes (a drop elsewhere) leaves no mark on the next one.
      window.setTimeout(() => {
        ref.current.justDragged.current = false;
      }, 400);
      ref.current.setDrag(null);
      if (drop && target) arrange(store, key, moveFor(target));
    };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      at = { x: ev.clientX, y: ev.clientY };
      if (!lifted) {
        if (touch) {
          if (touchScrolls(at.x - start.x, at.y - start.y)) end(false);
          return;
        }
        if (!dragStarts({ touch, dx: at.x - start.x, dy: at.y - start.y, held })) return;
        lift();
        return;
      }
      ev.preventDefault();
      place();
      aim();
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      // A finger lifted where it was lifted: the row's menu, as a long-press gives it.
      if (touch && lifted && !target && Math.hypot(at.x - liftedAt.x, at.y - liftedAt.y) < 8) {
        end(false);
        // Marked as a finger's, as ContextMenu.tsx marks its own long-press: the sheet opens.
        const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
        el.dispatchEvent(Object.assign(menu, { __touch: true }));
        return;
      }
      end(true);
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId === id) end(false);
    };
    const esc = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      end(false);
    };
    // While a finger holds a row up, the long-press menu waits for it to come down.
    const noMenu = (ev: Event) => {
      if (!lifted) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };
    const noScroll = (ev: TouchEvent) => {
      if (lifted && ev.cancelable) ev.preventDefault();
    };

    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("contextmenu", noMenu, true);
    document.addEventListener("touchmove", noScroll, { passive: false });
    if (touch)
      liftTimer = window.setTimeout(() => {
        held = true;
        lift();
      }, LIFT_MS);
    active.current = () => end(false);
  }, []);
}
