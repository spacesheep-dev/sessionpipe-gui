// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The sidebar's sessions, under its pages: New session (with Group by
// project toggle and New folder button), then Pinned (only while something is pinned),
// Custom Folders (when any exist or while creating one), and Sessions (flat or grouped
// by project), as one tree each (lib/tree.ts, the Board's own tree and order, less what
// this device hid). A row is one line: the agent's mark, the title cut at its end, a
// small computer mark where the session runs on another computer than the session it
// hangs under (a top-level row has its computer in its tooltip), and the state's lamp at
// the end. A parent, folder, or project group has a disclosure whose fold state is
// remembered on this device, and collapsed groups roll up the loudest status lamp.
//
// A row is dragged to arrange the tree: past 4 px with a pointer, after 500 ms held still
// with a finger. On a row it goes under it; on a folder header it moves into that folder
// (auto-expanding a collapsed folder after 600 ms hover); on the line between top-level
// rows in Pinned it reorders pins; on the Pinned heading or Drop to pin zone it pins; on
// the Sessions heading or a Project heading it returns to unfoldered Sessions.
import {
  ARRANGEMENT_FOLDER_NAME_MAX,
  type Arrangement,
  type ArrangementFolder,
  type ControlActivity,
  isEmptySession,
  type MachineSummary,
  type SessionKey,
  type SessionSummary,
  splitKey,
} from "@shared/api";
import {
  type CSSProperties,
  Fragment,
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
import { useBehind } from "../account/current";
import { usePendingStarts } from "../control/hooks";
import { openNewSession } from "../control/newSessionState";
import { useHideKeys, useStore, useUnreadKeys } from "../data/hooks";
import {
  type ArrangeSource,
  arrange,
  createFolder,
  moveTargets,
  onArranged,
  planMove,
  renameFolder,
  requestFolderPrompt,
  requestMoveFolder,
  requestMoveUnder,
} from "../lib/arrange";
import { useFolded } from "../lib/folded";
import { harnessMark, sessionTitle } from "../lib/format";
import { haptic } from "../lib/haptics";
import { isHidden, useHidden } from "../lib/hidden";
import { isUnread } from "../lib/marks";
import { sessionItems, sessionMenuSubtitle, sessionMenuTitle, sessionRowTip } from "../lib/menus";
import { calmNextCommit, type Held, reducedMotion, useFlip, useHeldOrder, useListHold } from "../lib/motion";
import { groupByProject, type ProjectGroup, projectOf } from "../lib/projects";
import { hrefFor, sessionPath } from "../lib/router";
import { setSettings, useAppSettings } from "../lib/settings";
import { hintFor, useShortcut } from "../lib/shortcuts";
import { howOf, openSession, openSplit } from "../lib/split";
import {
  arrangeTree,
  descendants,
  type FrozenRow,
  type Loud,
  louder,
  loudOf,
  type Rolled,
  rollUp,
  runsElsewhere,
  sidebarBlock,
  sidebarOrder,
  type Tree,
  type TreeNode,
} from "../lib/tree";
import {
  DRAG_SLOP_PX,
  dragStarts,
  edgeScroll,
  type FolderZone,
  type Group,
  LONG_PRESS_MS,
  moveFor,
  OPEN_AFTER_MS,
  type RowBox,
  type Target,
  TOUCH_MOVE_PX,
  targetAt,
  touchScrolls,
} from "../lib/treeDrag";
import { HarnessGlyph, StateDot } from "./bits";
import { closeMenu, type MenuList, openMenu, useContextMenu } from "./ContextMenu";
import { FolderIcon, folderMenuItems, PlusSmallIcon, ProjectIcon } from "./GroupBits";
import {
  ChevronIcon,
  GroupProjectsIcon,
  MachineIcon,
  MoreDotsIcon,
  NewFolderIcon,
  PinIcon,
  PlusCircleIcon,
} from "./Icons";
import { useLabelKeys } from "./LabelDot";
import "../styles/sidetree.css";

/** Top-level rows shown before Show more, and how many more each press shows. */
export const TREE_SHOWN = 30;
/** Rows under one parent shown before Show N more. */
export const KIDS_SHOWN = 8;

// Keep unused constant lint clean if referenced only for docs.
void DRAG_SLOP_PX;

// ----- the rows as drawn -----

/** One session row as drawn, top to bottom (the keys and the drag walk these). */
interface Drawn {
  node: TreeNode;
  group: Group;
  hasKids: boolean;
  folded: boolean;
  /** The row it is drawn under, when it is drawn under one. */
  up?: string;
  /** Custom folder id when drawn inside a folder. */
  folderId?: string;
  /** Project group key when drawn inside a project group. */
  projectKey?: string;
}

interface Drag {
  key: SessionKey;
  title: string;
  harness: string;
  target: Target | null;
  touch: boolean;
  /** Where the pointer was at the lift: the chip's first place. */
  x: number;
  y: number;
}

const chipPos = (x: number, y: number, touch: boolean): string =>
  touch
    ? `translate(${Math.round(x - 24)}px, ${Math.round(y - 64)}px)`
    : `translate(${Math.round(x + 16)}px, ${Math.round(y - 14)}px)`;

/** The lamp at a row's end: the board's glyph where the state asks for one. */
function Lamp({ s, unread, rolled, size }: { s: SessionSummary; unread: boolean; rolled?: Loud; size: number }) {
  // From under a folded row: the loudest there, drawn as its own row would draw it.
  if (rolled === "needs_you" || rolled === "working" || rolled === "stale")
    return <StateDot state={rolled} size={size} decorative />;
  if (rolled === "unread")
    return <StateDot state={s.state === "done" ? "done" : "idle"} size={size} decorative unread />;
  if (s.state === "needs_you" || s.state === "working" || s.state === "stale")
    return <StateDot state={s.state} size={size} decorative />;
  // News unread: the Board's own mark for it, the glyph drawn as an ink disc.
  if (unread) return <StateDot state={s.state} size={size} decorative unread />;
  return null;
}

/** Rolled-up lamp for a collapsed custom folder or project group. */
function GroupLamp({ loud, size }: { loud: Loud; size: number }) {
  if (loud === "needs_you" || loud === "working" || loud === "stale")
    return <StateDot state={loud} size={size} decorative />;
  if (loud === "unread") return <StateDot state="idle" size={size} decorative unread />;
  return null;
}

/** What a screen reader hears after the title. */
const stateWords = (s: SessionSummary, unread: boolean): string =>
  s.state === "needs_you"
    ? ", needs you"
    : s.state === "working"
      ? ", working"
      : s.state === "stale"
        ? ", stale"
        : unread
          ? ", unread"
          : "";

const loudWords = (l: Loud): string =>
  l === "needs_you"
    ? ", needs you"
    : l === "working"
      ? ", working"
      : l === "stale"
        ? ", stale"
        : l === "unread"
          ? ", unread"
          : "";

/** What a folded row holds, in words: how many, and how many of the loudest kind. */
function foldWords(r: Rolled): string {
  if (r.inside === 0) return "";
  const n = r.inside;
  const kind =
    r.loud === "needs_you"
      ? `${r.needs} ${r.needs === 1 ? "needs" : "need"} you`
      : r.loud === "working"
        ? `${r.working} working`
        : r.loud === "stale"
          ? `${r.stale} stale`
          : r.loud === "unread"
            ? `${r.unread} unread`
            : "";
  return `, ${n} inside${kind ? `, ${kind}` : ""}`;
}
const NO_ROWS: readonly SessionSummary[] = [];

/** The Machines page's own mark, small: this session runs on another computer. */
function AwayMark() {
  return (
    <span className="stree-away" aria-hidden="true">
      <MachineIcon size={12} />
    </span>
  );
}

/** A pin, for the place a held row is pinned. */
function PinGlyph() {
  return <PinIcon size={16} className="stree-new-glyph" />;
}

function Chevron() {
  return <ChevronIcon size={12} />;
}

export const SessionTree = memo(function SessionTree({
  open,
  touch,
  between,
  foot,
}: {
  open: SessionKey | null;
  touch: boolean;
  /** Drawn between New session and the list, outside its scroll (the touch sidebar's pages). */
  between?: ReactNode;
  /** Drawn under the list, outside its scroll (the Usage line). */
  foot?: ReactNode;
}) {
  const store = useStore();
  // Only what the tree draws: a control frame, a viewer or the stats redraw nothing here.
  const sessions = useSyncExternalStore(store.subscribe, () => store.get().sessions);
  const machines = useSyncExternalStore(store.subscribe, () => store.get().machines);
  const arrangement = useSyncExternalStore(store.subscribe, () => store.get().arrangement);
  const marks = useSyncExternalStore(store.subscribe, () => store.get().marks);
  const snapshotAt = useSyncExternalStore(store.subscribe, () => store.get().snapshotAt);
  const { sidebarGroup } = useAppSettings();
  const grouped = sidebarGroup === "project";
  const behind = useBehind();
  const hidden = useHidden();
  const hid = useCallback(
    (s: SessionSummary) => isHidden(hidden, s.key, s.stateSince, s.state === "needs_you"),
    [hidden],
  );
  const all = useMemo(() => [...sessions.values()].filter((s) => !isEmptySession(s)), [sessions]);
  // Loaded as the Board is: the first snapshot is in, and an account's history is not
  // still coming into an empty list. Before that the headings stand with no rows and no
  // "None yet"; a reconnect keeps the rows it has (the store keeps them until the next
  // snapshot replaces them).
  const loaded = !!snapshotAt && !(behind && all.length === 0);
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
  // What is under each row, rolled up: a folded row carries the loudest of it, and the
  // sidebar's three-block order reads the same walk (lib/tree.ts).
  const unreadOf = useCallback((x: SessionSummary) => isUnread(x, marks), [marks]);
  const roll = useMemo(() => rollUp(tree.roots, { unread: unreadOf, drawn: (x) => !hid(x) }), [tree, unreadOf, hid]);
  // The open row keeps its starting block while it stays open, so answering a prompt or
  // sending a message never jumps it out from under you.
  const frozenRef = useRef<FrozenRow | null>(null);
  if (!open) {
    frozenRef.current = null;
  } else if (frozenRef.current?.key !== open) {
    const node = tree.nodes.get(open);
    frozenRef.current = node ? { key: open, block: sidebarBlock(node, roll) } : null;
  }
  const frozen = frozenRef.current;

  const pinSet = useMemo(() => new Set(arrangement.pinned), [arrangement.pinned]);
  const folders = useMemo(() => arrangement.folders ?? [], [arrangement.folders]);
  const inFolder = useMemo(() => arrangement.inFolder ?? {}, [arrangement.inFolder]);
  const folderIdSet = useMemo(() => new Set(folders.map((f) => f.id)), [folders]);

  const pinned = useMemo(
    () =>
      arrangement.pinned.map((k) => tree.nodes.get(k)).filter((n): n is TreeNode => !!n && n.level === 0 && !hid(n.s)),
    [arrangement.pinned, tree, hid],
  );

  // Root sessions grouped into each custom folder (sorted by sidebarOrder).
  const folderRoots = useMemo(() => {
    const map = new Map<string, TreeNode[]>();
    for (const f of folders) map.set(f.id, []);
    for (const n of tree.roots) {
      if (pinSet.has(n.s.key) || hid(n.s)) continue;
      const fid = inFolder[n.s.key];
      if (fid && map.has(fid)) map.get(fid)!.push(n);
    }
    for (const [fid, list] of map) map.set(fid, sidebarOrder(list, roll, frozen));
    return map;
  }, [folders, inFolder, tree, pinSet, hid, roll, frozen]);

  // Remaining unpinned, unfoldered roots for the Sessions section.
  const roots = useMemo(
    () =>
      sidebarOrder(
        tree.roots.filter((n) => {
          if (pinSet.has(n.s.key) || hid(n.s)) return false;
          const fid = inFolder[n.s.key];
          return !fid || !folderIdSet.has(fid);
        }),
        roll,
        frozen,
      ),
    [tree, pinSet, hid, inFolder, folderIdSet, roll, frozen],
  );

  // Project groups for Sessions when `sidebarGroup === "project"`.
  const projectGroups = useMemo(
    () => (grouped ? groupByProject(roots, roll, { unread: unreadOf, frozen }) : []),
    [grouped, roots, roll, unreadOf, frozen],
  );

  // Inline create / rename state for custom folders on desktop.
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState("");
  const inlineInputRef = useRef<HTMLInputElement>(null);
  const settledEdit = useRef(false);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const editingFolderRef = useRef(false);
  editingFolderRef.current = creatingFolder || renamingFolderId !== null;

  const focusRowNextFrame = useCallback((key: string, force: boolean) => {
    requestAnimationFrame(() => {
      if (!force) {
        const cur = document.activeElement;
        if (cur && cur !== document.body && !box.current?.contains(cur)) return;
      }
      const el = box.current?.querySelector<HTMLElement>(
        `[data-tree-row="${CSS.escape(key)}"], [data-group-row="${CSS.escape(key)}"]`,
      );
      if (!el) return;
      hadFocus.current = true;
      focusedEl.current = el;
      setFocusKey(key);
      el.focus({ preventScroll: true });
    });
  }, []);

  const cancelFolderEdit = useCallback(() => {
    if (settledEdit.current) return;
    settledEdit.current = true;
    const prev = returnFocusTo.current;
    returnFocusTo.current = null;
    setCreatingFolder(false);
    setRenamingFolderId(null);
    setFolderDraft("");
    requestAnimationFrame(() => {
      if (prev?.isConnected) prev.focus({ preventScroll: true });
    });
  }, []);
  const cancelFolderEditRef = useRef(cancelFolderEdit);
  cancelFolderEditRef.current = cancelFolderEdit;

  // Registered on mount (before Shell's overlayShown listener) so Esc cancels inline folder
  // create/rename without closing a narrow desktop sidebar overlay.
  useEffect(() => {
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || !editingFolderRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancelFolderEditRef.current();
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, []);

  useEffect(() => {
    if (!creatingFolder && !renamingFolderId) return;
    const inp = inlineInputRef.current;
    if (!inp) return;
    inp.focus({ preventScroll: true });
    if (renamingFolderId) inp.select();
  }, [creatingFolder, renamingFolderId]);

  const startCreateFolder = useCallback(() => {
    if (touch) {
      requestFolderPrompt({ mode: "create" });
      return;
    }
    returnFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    settledEdit.current = false;
    setRenamingFolderId(null);
    setFolderDraft("");
    setCreatingFolder(true);
  }, [touch]);

  const startRenameFolder = useCallback(
    (f: ArrangementFolder) => {
      if (touch) {
        requestFolderPrompt({ mode: "rename", folderId: f.id, initialName: f.name });
        return;
      }
      const fk = `f:${f.id}`;
      returnFocusTo.current =
        box.current?.querySelector<HTMLElement>(`[data-group-row="${CSS.escape(fk)}"]`) ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      settledEdit.current = false;
      setCreatingFolder(false);
      setFolderDraft(f.name);
      setRenamingFolderId(f.id);
    },
    [touch],
  );

  const commitFolderCreate = useCallback(
    (fromKey = false) => {
      if (settledEdit.current) return;
      settledEdit.current = true;
      const prev = returnFocusTo.current;
      returnFocusTo.current = null;
      const text = folderDraft.trim();
      setCreatingFolder(false);
      setFolderDraft("");
      if (text) {
        calmNextCommit();
        const created = createFolder(store, text);
        if (created) {
          focusRowNextFrame(`f:${created.id}`, fromKey);
          return;
        }
      }
      if (fromKey) {
        requestAnimationFrame(() => {
          if (prev?.isConnected) prev.focus({ preventScroll: true });
        });
      }
    },
    [folderDraft, store, focusRowNextFrame],
  );

  const commitFolderRename = useCallback(
    (folderId: string, fromKey = false) => {
      if (settledEdit.current) return;
      settledEdit.current = true;
      returnFocusTo.current = null;
      const text = folderDraft.trim();
      setRenamingFolderId(null);
      setFolderDraft("");
      if (text) {
        calmNextCommit();
        renameFolder(store, folderId, text);
      }
      focusRowNextFrame(`f:${folderId}`, fromKey);
    },
    [folderDraft, store, focusRowNextFrame],
  );

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
  const more = grouped ? 0 : heldRoots.length - shownRoots.length;

  const [folded, setFolded, setFoldedMany] = useFolded();
  const latestFolds = useRef(folded);
  latestFolds.current = folded;
  const [allKids, setAllKids] = useState<ReadonlySet<SessionKey>>(new Set());
  const kidsOf = useCallback(
    (n: TreeNode) =>
      sidebarOrder(
        n.kids.filter((k) => !hid(k.s)),
        roll,
        frozen,
      ),
    [hid, roll, frozen],
  );
  const parentKeysIn = useCallback(
    (nodes: readonly TreeNode[]): SessionKey[] => {
      const out: SessionKey[] = [];
      const walk = (n: TreeNode) => {
        const kids = kidsOf(n);
        if (kids.length > 0) out.push(n.s.key);
        for (const k of kids) walk(k);
      };
      for (const n of nodes) walk(n);
      return out;
    },
    [kidsOf],
  );
  /** The sessions a folded row stands for: every one under it this device draws. */
  const underOf = useCallback(
    (key: SessionKey): SessionSummary[] => {
      const out: SessionSummary[] = [];
      const walk = (n: TreeNode | undefined) => {
        for (const k of n ? kidsOf(n) : []) {
          out.push(k.s);
          walk(k);
        }
      };
      walk(tree.nodes.get(key));
      return out;
    },
    [tree, kidsOf],
  );

  // Rolled-up loudness per custom folder.
  const folderLoud = useMemo(() => {
    const out = new Map<string, Loud>();
    for (const f of folders) {
      let l: Loud = "none";
      for (const n of folderRoots.get(f.id) ?? []) {
        l = louder(l, loudOf(n.s, unreadOf));
        l = louder(l, roll.get(n.s.key)?.loud ?? "none");
      }
      out.set(f.id, l);
    }
    return out;
  }, [folders, folderRoots, unreadOf, roll]);

  // The session rows as drawn, for the keys and the drag.
  const drawn = useMemo(() => {
    const out: Drawn[] = [];
    const walk = (n: TreeNode, group: Group, up?: string, folderId?: string, projectKey?: string) => {
      const kids = kidsOf(n);
      const isFolded = kids.length > 0 && folded.has(n.s.key);
      out.push({
        node: n,
        group,
        hasKids: kids.length > 0,
        folded: isFolded,
        ...(up ? { up } : {}),
        ...(folderId ? { folderId } : {}),
        ...(projectKey ? { projectKey } : {}),
      });
      if (isFolded) return;
      const shown = allKids.has(n.s.key) ? kids : kids.slice(0, KIDS_SHOWN);
      for (const k of shown) walk(k, group, n.s.key, folderId, projectKey);
    };
    for (const n of pinned) walk(n, "pinned");
    for (const f of folders) {
      const fk = `f:${f.id}`;
      if (folded.has(fk)) continue;
      for (const n of folderRoots.get(f.id) ?? []) walk(n, "folder", fk, f.id);
    }
    if (grouped) {
      for (const pg of projectGroups) {
        const pk = `p:${pg.key}`;
        if (folded.has(pk)) continue;
        for (const n of pg.roots) walk(n, "sessions", pk, undefined, pg.key);
      }
    } else {
      for (const h of shownRoots) if (!h.gone) walk(h.item, "sessions");
    }
    return out;
  }, [pinned, folders, folderRoots, grouped, projectGroups, shownRoots, kidsOf, folded, allKids]);

  // ----- focus: one row in the tab order, the arrows walk the rest -----
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const navKeys = useMemo(() => {
    const out: string[] = [];
    const byFolder = new Map<string, string[]>();
    const byProject = new Map<string, string[]>();
    const flatSessions: string[] = [];
    for (const d of drawn) {
      const k = d.node.s.key;
      if (d.group === "pinned") {
        out.push(k);
      } else if (d.group === "folder" && d.folderId) {
        let list = byFolder.get(d.folderId);
        if (!list) {
          list = [];
          byFolder.set(d.folderId, list);
        }
        list.push(k);
      } else if (d.projectKey) {
        let list = byProject.get(d.projectKey);
        if (!list) {
          list = [];
          byProject.set(d.projectKey, list);
        }
        list.push(k);
      } else {
        flatSessions.push(k);
      }
    }
    for (const f of folders) {
      out.push(`f:${f.id}`);
      for (const k of byFolder.get(f.id) ?? []) out.push(k);
    }
    if (grouped) {
      for (const pg of projectGroups) {
        out.push(`p:${pg.key}`);
        for (const k of byProject.get(pg.key) ?? []) out.push(k);
      }
    } else {
      for (const k of flatSessions) out.push(k);
    }
    return out;
  }, [drawn, folders, grouped, projectGroups]);
  const navKeySet = useMemo(() => new Set(navKeys), [navKeys]);
  const hasNavKey = (k: string | null | undefined) => !!k && navKeySet.has(k);
  const firstNavKey = navKeys[0];
  const tabKey = hasNavKey(focusKey) ? focusKey : hasNavKey(open) ? open : firstNavKey;
  const rowEl = (key: string) =>
    box.current?.querySelector<HTMLElement>(
      `[data-tree-row="${CSS.escape(key)}"], [data-group-row="${CSS.escape(key)}"]`,
    );
  // A move by the keys or the menu draws the row in another list: the focus goes with it.
  const hadFocus = useRef(false);
  /** The row element that last had the focus: only its leaving the page (a move drew the
   *  row anew) sends the focus after the row; a Tab or a click away leaves it connected. */
  const focusedEl = useRef<HTMLElement | null>(null);
  /** Where the focused row (session, folder, or project header) was in nav order: a row
   *  that leaves the list (hidden, forgotten, deleted folder) hands focus to its neighbor. */
  const lastIndex = useRef(0);
  const focusAt = focusKey ? navKeys.indexOf(focusKey) : -1;
  if (focusAt >= 0) lastIndex.current = focusAt;
  useLayoutEffect(() => {
    if (!focusKey || !hadFocus.current) return;
    if (focusedEl.current?.isConnected) return;
    const a = document.activeElement;
    if (a && a !== document.body) {
      if (!box.current?.contains(a)) hadFocus.current = false;
      return;
    }
    const here = rowEl(focusKey);
    if (here) {
      here.focus({ preventScroll: true });
      return;
    }
    const next = navKeys[Math.min(lastIndex.current, navKeys.length - 1)] ?? firstNavKey;
    if (!next) return;
    setFocusKey(next);
    rowEl(next)?.focus({ preventScroll: true });
  });
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const here = e.target as HTMLElement;
    if (!here.matches?.("[data-tree-nav]")) return;
    // Modified arrows/keys belong to the shortcut dispatcher (⌥←/⌥→, ⌃⌘←/⌃⌘→, ⇧↵, ⌘↵).
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    cancelAnimationFrame(landFrame.current);
    // The rows as drawn, in all lists, including folder/project headers and Show more rows.
    const items = [...(box.current?.querySelectorAll<HTMLElement>("[data-tree-nav]") ?? [])];
    const i = items.indexOf(here);
    const key = here.dataset.treeRow;
    const groupKey = here.dataset.groupRow;
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
        if (groupKey) {
          if (isFolded) {
            calmNextCommit();
            setFolded(groupKey, false);
          } else if (items[i + 1]?.dataset.up === groupKey) to = items[i + 1];
          else return;
        } else if (key && kids && isFolded) {
          calmNextCommit();
          setFolded(key, false);
        } else if (kids) to = items[i + 1];
        else return;
        break;
      case "ArrowLeft":
        if (groupKey) {
          if (!isFolded) {
            calmNextCommit();
            setFolded(groupKey, true);
          } else return;
        } else if (key && kids && !isFolded) {
          calmNextCommit();
          setFolded(key, true);
        } else if (here.dataset.up) to = rowEl(here.dataset.up) ?? undefined;
        else return;
        break;
      case "Enter":
        if (groupKey) {
          calmNextCommit();
          setFolded(groupKey, !isFolded);
          break;
        }
        // A row's ↵, ⇧↵ and ⌘↵ are the Lists keys (below); Show N more presses itself.
        if (key) return;
        here.click();
        break;
      case " ":
        if (groupKey) {
          calmNextCommit();
          setFolded(groupKey, !isFolded);
        } else if (key) openSplit(key, { preview: true });
        else here.click();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (to) {
      const nextKey = to.dataset.treeRow ?? to.dataset.groupRow;
      if (nextKey) setFocusKey(nextKey);
      to.focus();
    }
  };

  // ----- the Lists keys, on the row the focus is on (the tree owns them: data-keys-own) -----
  /** The session of the row with the focus, when the focus is on one of the tree's rows. */
  const focusedRow = (): SessionSummary | undefined => {
    const a = document.activeElement as HTMLElement | null;
    const k = a && box.current?.contains(a) ? a.getAttribute("data-tree-row") : null;
    return k ? store.get().sessions.get(k) : undefined;
  };
  const step = (d: 1 | -1) => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !box.current?.contains(a)) return false;
    cancelAnimationFrame(landFrame.current);
    const items = [...box.current.querySelectorAll<HTMLElement>("[data-tree-nav]")];
    const to = items[items.indexOf(a) + d];
    if (!to) return;
    const nextKey = to.dataset.treeRow ?? to.dataset.groupRow;
    if (nextKey) setFocusKey(nextKey);
    to.focus();
  };
  const own = { within: box };
  useShortcut("list.down", () => step(1), own);
  useShortcut("list.up", () => step(-1), own);
  const openFocused = (how: "primary" | "other" | "background") => {
    const s = focusedRow();
    if (!s) return false;
    openSession(s.key, how);
  };
  useShortcut("list.open", () => openFocused("primary"), own);
  useShortcut("list.beside", () => openFocused("other"), own);
  useShortcut("list.background", () => openFocused("background"), own);
  useShortcut(
    "list.menu",
    () => {
      const a = document.activeElement as HTMLElement | null;
      const el =
        a && box.current?.contains(a) && (a.hasAttribute("data-tree-row") || a.hasAttribute("data-group-row"))
          ? a
          : null;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const ce = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: r.left + 24,
        clientY: r.bottom,
      });
      el.dispatchEvent(Object.assign(ce, { __kbd: true }));
    },
    own,
  );
  useUnreadKeys(() => {
    const s = focusedRow();
    if (!s) return [];
    // A folded row: what its glyph stands for is read or unread with it.
    if (!latestFolds.current.has(s.key)) return [s];
    const marks = store.get().marks;
    // Every one with news, read at once; with no news there, the row's own toggle.
    const news = [s, ...underOf(s.key)].filter((x) => isUnread(x, marks));
    return news.length ? news : [s];
  }, own);
  // The row leaves the list: the focus goes to the one that took its place (below).
  useHideKeys(focusedRow, () => {}, own);
  useLabelKeys(() => {
    const s = focusedRow();
    return s ? [s.key] : [];
  }, own);

  // ----- Session tree outliner chords (lib/shortcuts.ts 'Session tree' group) -----
  const foldSubtree = useCallback(
    (key: SessionKey, fold: boolean, calm: boolean): boolean => {
      const node = live.current.tree.nodes.get(key);
      if (!node) return false;
      const keys = parentKeysIn([node]);
      if (keys.length === 0) return false;
      if (calm) calmNextCommit();
      setFoldedMany(keys, fold);
      return true;
    },
    [parentKeysIn, setFoldedMany],
  );
  useShortcut(
    "tree.moveIn",
    () => {
      const s = focusedRow();
      if (!s) return false;
      const { drawn: rows } = live.current;
      const idx = rows.findIndex((d) => d.node.s.key === s.key);
      if (idx <= 0) return false;
      const cur = rows[idx]!;
      let above: SessionKey | null = null;
      for (let j = idx - 1; j >= 0; j--) {
        const d = rows[j]!;
        if (
          d.group !== cur.group ||
          d.folderId !== cur.folderId ||
          d.projectKey !== cur.projectKey ||
          d.node.level < cur.node.level
        )
          break;
        if (d.node.level === cur.node.level) {
          above = d.node.s.key;
          break;
        }
      }
      if (!above) return false;
      calmNextCommit();
      return arrange(store, s.key, { kind: "under", parent: above }, { source: "key" }) ? undefined : false;
    },
    own,
  );
  useShortcut(
    "tree.moveOut",
    () => {
      const s = focusedRow();
      if (!s) return false;
      const node = live.current.tree.nodes.get(s.key);
      if (!node?.parent) return false;
      const grand = live.current.tree.nodes.get(node.parent)?.parent;
      const move = grand ? ({ kind: "under", parent: grand } as const) : ({ kind: "top" } as const);
      calmNextCommit();
      return arrange(store, s.key, move, { source: "key" }) ? undefined : false;
    },
    own,
  );
  useShortcut(
    "tree.pin",
    () => {
      const s = focusedRow();
      if (!s) return false;
      const isPinned = store.get().arrangement.pinned.includes(s.key);
      calmNextCommit();
      return arrange(store, s.key, { kind: isPinned ? "unpin" : "pin" }, { source: "key" }) ? undefined : false;
    },
    own,
  );
  useShortcut(
    "tree.moveUnder",
    () => {
      const s = focusedRow();
      if (!s) return false;
      if (moveTargets(live.current.tree, s.key).length === 0) return false;
      requestMoveUnder(s.key, { fromTree: true });
    },
    own,
  );
  useShortcut(
    "tree.moveFolder",
    () => {
      const s = focusedRow();
      if (!s) return false;
      requestMoveFolder(s.key, { fromTree: true });
    },
    own,
  );
  useShortcut(
    "tree.newFolder",
    () => {
      startCreateFolder();
    },
    own,
  );
  useShortcut(
    "tree.unfoldAll",
    () => {
      const s = focusedRow();
      return s && foldSubtree(s.key, false, true) ? undefined : false;
    },
    own,
  );
  useShortcut(
    "tree.foldAll",
    () => {
      const s = focusedRow();
      return s && foldSubtree(s.key, true, true) ? undefined : false;
    },
    own,
  );

  // Heading menus: Unfold all / Fold all for Pinned and Sessions, plus Group by project on Sessions.
  const onSectionTouchDown = useTouchMenu(touch);
  const sectionMenu = (nodes: readonly TreeNode[], extraGroupKeys?: readonly string[]): MenuList | null => {
    const keys = [...(extraGroupKeys ?? []), ...parentKeysIn(nodes)];
    if (keys.length === 0) return null;
    const anyFolded = keys.some((k) => latestFolds.current.has(k));
    const anyOpen = keys.some((k) => !latestFolds.current.has(k));
    return [
      { label: "Unfold all", disabled: !anyFolded, run: () => setFoldedMany(keys, false) },
      { label: "Fold all", disabled: !anyOpen, run: () => setFoldedMany(keys, true) },
    ];
  };
  const pinnedHeadingMenu = useContextMenu(() => sectionMenu(pinned), { title: () => "Pinned" });
  const sessionsHeadingMenu = useContextMenu(
    () => {
      const foldItems = sectionMenu(roots, grouped ? projectGroups.map((pg) => `p:${pg.key}`) : undefined);
      return [
        {
          label: grouped ? "Show flat list" : "Group by project",
          run: () => {
            calmNextCommit();
            setSettings({ sidebarGroup: grouped ? "flat" : "project" });
          },
        },
        ...(foldItems ? [{ sep: true as const }, ...foldItems] : []),
      ];
    },
    { title: () => "Sessions" },
  );
  const foldersHeadingMenu = useContextMenu(
    () => [
      { label: "New folder…", action: "tree.newFolder", run: startCreateFolder },
      ...(folders.length > 0
        ? [
            { sep: true as const },
            {
              label: "Unfold all",
              disabled: !folders.some((f) => latestFolds.current.has(`f:${f.id}`)),
              run: () =>
                setFoldedMany(
                  folders.map((f) => `f:${f.id}`),
                  false,
                ),
            },
            {
              label: "Fold all",
              disabled: !folders.some((f) => !latestFolds.current.has(`f:${f.id}`)),
              run: () =>
                setFoldedMany(
                  folders.map((f) => `f:${f.id}`),
                  true,
                ),
            },
          ]
        : []),
    ],
    { title: () => "Folders" },
  );

  // ----- what a move did, said, and where focus and scroll land -----
  const [said, setSaid] = useState("");
  const pendingLand = useRef<{ key: SessionKey; source: ArrangeSource } | null>(null);
  const landFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(landFrame.current), []);
  const focusAfterExpand = useRef<SessionKey | null>(null);
  useLayoutEffect(() => {
    const next = focusAfterExpand.current;
    if (!next) return;
    const el = rowEl(next);
    if (!el) return;
    focusAfterExpand.current = null;
    hadFocus.current = true;
    focusedEl.current = el;
    setFocusKey(next);
    el.focus({ preventScroll: true });
  });
  useEffect(
    () =>
      onArranged((words, what) => {
        // The same words twice are said twice.
        setSaid("");
        requestAnimationFrame(() => setSaid(words));
        // Moved under a parent: the parent opens, and its ancestors, so the row is in sight.
        if (what?.move.kind === "under") revealRef.current(what.move.parent, what.key);
        // Moved into a custom folder: expand that folder so the row is in sight.
        if (what?.move.kind === "folder") setFolded(`f:${what.move.folderId}`, false);
        if (what?.source) pendingLand.current = { key: what.key, source: what.source };
      }),
    [setFolded],
  );
  // After a pointer drop: focus without scrolling, then once FLIP settles scroll once only
  // if the landed row is out of view. After a key, menu or picker move: focus and scroll
  // in the next frame (after the picker's focus trap or menu releases).
  useLayoutEffect(() => {
    const land = pendingLand.current;
    if (!land) return;
    const el = rowEl(land.key);
    if (!el) return;
    pendingLand.current = null;
    if (land.source === "pointer") {
      hadFocus.current = true;
      focusedEl.current = el;
      setFocusKey(land.key);
      el.focus({ preventScroll: true });
      const settle = () => {
        const sc = scroller.current;
        const rowNow = rowEl(land.key);
        if (!sc || !rowNow) return;
        const sr = sc.getBoundingClientRect();
        const rr = rowNow.getBoundingClientRect();
        if (rr.top < sr.top - 0.5 || rr.bottom > sr.bottom + 0.5) {
          rowNow.scrollIntoView({ block: "nearest" });
        }
      };
      const item = el.closest(".stree-item");
      const anims =
        reducedMotion() || !item || typeof item.getAnimations !== "function"
          ? []
          : item.getAnimations().filter((a) => a.playState === "running");
      if (anims.length === 0) settle();
      else void Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(settle);
      return;
    }
    const beforeEl = document.activeElement;
    cancelAnimationFrame(landFrame.current);
    landFrame.current = requestAnimationFrame(() => {
      landFrame.current = 0;
      const cur = document.activeElement;
      if (cur && cur !== beforeEl && box.current?.contains(cur)) return;
      const rowNow = rowEl(land.key);
      if (!rowNow) return;
      hadFocus.current = true;
      focusedEl.current = rowNow;
      setFocusKey(land.key);
      rowNow.focus({ preventScroll: true });
      rowNow.scrollIntoView({ block: "nearest" });
    });
  });

  // ----- a row is never lost: opening or moving one shows it -----
  /** Unfolds `key` and every row above it (plus its custom folder or project group);
   *  with `also`, the row under it is drawn too (past Show N more, past the thirty top rows). */
  const reveal = (key: SessionKey, also?: SessionKey) => {
    const chain: SessionKey[] = [];
    for (let k: SessionKey | undefined = key; k; k = tree.nodes.get(k)?.parent) chain.push(k);
    for (const k of chain) setFolded(k, false);
    const target = also ?? key;
    const parent = tree.nodes.get(target)?.parent;
    if (parent) {
      const at = (tree.nodes.get(parent)?.kids ?? []).findIndex((x) => x.s.key === target);
      if (at >= KIDS_SHOWN) setAllKids((was) => new Set(was).add(parent));
    }
    const top = chain[chain.length - 1] ?? key;
    const fid = inFolder[top];
    if (fid && folderIdSet.has(fid)) {
      setFolded(`f:${fid}`, false);
    } else if (grouped) {
      const topNode = tree.nodes.get(top);
      if (topNode) setFolded(`p:${projectOf(topNode.s).key}`, false);
    } else {
      const i = heldRoots.findIndex((h) => h.key === top);
      if (i >= limit) setLimit(i + 1);
    }
  };
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  // The session opened (from here, the Board, a notification): its row is drawn, filled and
  // in sight. Only on opening: state or arrangement changes never fold, unfold or scroll.
  const toShow = useRef<SessionKey | null>(null);
  useEffect(() => {
    if (!open || !tree.nodes.has(open)) return;
    revealRef.current(open);
    toShow.current = open;
  }, [open]);
  useEffect(() => {
    if (!toShow.current || hold) return;
    const el = rowEl(toShow.current);
    if (!el) return;
    toShow.current = null;
    el.scrollIntoView({ block: "nearest" });
  });

  // ----- the drag -----
  const scroller = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const live = useRef<Live>({ tree, all, arrangement, drawn, folded });
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
  const latest = useRef({ setFocusKey, setFolded, foldSubtree, onRowDown });
  latest.current = { setFocusKey, setFolded, foldSubtree, onRowDown };
  const actions = useMemo<RowActions>(
    () => ({
      down: (e, s) => latest.current.onRowDown(e, s),
      focus: (key) => {
        hadFocus.current = true;
        focusedEl.current = document.activeElement as HTMLElement | null;
        latest.current.setFocusKey(key);
      },
      fold: (key, fold, deep) => {
        if (deep) latest.current.foldSubtree(key, fold, false);
        else latest.current.setFolded(key, fold);
      },
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
  const row = (
    n: TreeNode,
    group: Group,
    pos: number,
    size: number,
    parent?: TreeNode,
    folderId?: string,
    groupUp?: string,
  ): ReactElement => {
    const s = n.s;
    const key = s.key;
    const kids = kidsOf(n);
    const isFolded = kids.length > 0 && folded.has(key);
    const shown = isFolded ? [] : allKids.has(key) ? kids : kids.slice(0, KIDS_SHOWN);
    const hiddenKids = kids.length - (isFolded ? kids.length : shown.length);
    // What the row stands for that is not drawn: all under it when folded, the rows past
    // Show N more when not. Its glyph is the loudest of that and itself.
    const r = roll.get(key);
    let below: Loud = "none";
    if (isFolded) below = r?.loud ?? "none";
    else
      for (const k of kids.slice(shown.length))
        below = louder(louder(below, loudOf(k.s, unreadOf)), roll.get(k.s.key)?.loud ?? "none");
    const own = loudOf(s, unreadOf);
    const rolled = louder(own, below) !== own ? below : undefined;
    const inside = isFolded && r ? foldWords(r) : "";
    // Only a row under a session on another computer is marked (lib/tree.ts runsElsewhere).
    const away = runsElsewhere(tree, key);
    const id = `${groupId}-${group}-${folderId ?? ""}-${key}`;
    const ariaLevel = n.level + (groupUp ? 2 : 1);
    return (
      <TreeRow
        key={key}
        n={n}
        group={group}
        folderId={folderId}
        ariaLevel={ariaLevel}
        pos={pos}
        size={size}
        open={key === open}
        tab={key === tabKey}
        unread={isUnread(s, marks)}
        rolled={rolled}
        inside={inside}
        under={isFolded ? underOf(key) : NO_ROWS}
        away={away}
        hasKids={kids.length > 0}
        folded={isFolded}
        groupId={id}
        target={drag?.target?.kind === "on" && drag.target.key === key}
        lifted={drag?.key === key}
        touch={touch}
        up={parent?.s.key ?? groupUp}
        actions={actions}
      >
        {shown.length > 0 && (
          <KidGroup
            id={id}
            level={n.level}
            label={sessionTitle(s)}
            sig={`${shown.map((k) => k.s.key).join(",")}:${hiddenKids}`}
          >
            {shown.map((k, i) => row(k, group, i + 1, kids.length, n, folderId, groupUp))}
            {hiddenKids > 0 && !isFolded && (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the tree has the keys (Enter and Space press it)
              <div
                role="treeitem"
                aria-level={ariaLevel + 1}
                tabIndex={-1}
                className="stree-more"
                data-tree-nav=""
                data-up={key}
                style={{ "--lvl": n.level + 1 } as CSSProperties}
                onClick={() => {
                  focusAfterExpand.current = kids[KIDS_SHOWN]?.s.key ?? null;
                  setAllKids((was) => new Set(was).add(key));
                }}
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
  // FLIP only needs to measure when the drawn row structure or fold state changes, not on
  // every text-delta SSE tick that leaves every row in place.
  const pinSig = useMemo(
    () =>
      drawn
        .filter((d) => d.group === "pinned")
        .map((d) => `${d.node.s.key}:${d.folded ? 1 : 0}`)
        .join("|"),
    [drawn],
  );
  const listSig = useMemo(
    () =>
      `${grouped ? "p" : "f"};${projectGroups.map((g) => `${g.key}:${folded.has(`p:${g.key}`) ? 1 : 0}`).join(",")};${shownRoots.map((h) => (h.gone ? `~${h.key}` : h.key)).join(",")};${drawn
        .filter((d) => d.group === "sessions")
        .map((d) => `${d.node.s.key}:${d.folded ? 1 : 0}`)
        .join("|")}`,
    [grouped, projectGroups, folded, shownRoots, drawn],
  );
  useFlip(listRef, 80, { move: 150, sig: listSig });
  useFlip(pinRef, 80, { move: 150, sig: pinSig });
  const anyFolderSessions = folders.some((f) => (folderRoots.get(f.id)?.length ?? 0) > 0);
  const empty = drawn.length === 0 && heldRoots.length === 0 && pinned.length === 0 && !anyFolderSessions;
  // A start not listed yet sits at the top of the live block (right after block 0 rows).
  const startAt = shownRoots.findIndex(
    (h) => (frozen?.key === h.key ? frozen.block : sidebarBlock(h.item, roll)) !== 0,
  );
  // While a row is held up, New session's row (fixed, always in view) is where it is pinned:
  // the same height, so nothing in the list moves when a drag starts.
  const pinZone = !!drag;
  const fades = useScrollFades(scroller);
  // Signature of drawn rows (and folded folders/projects) that need you, so the needs-pill refreshes.
  const needsSig = useMemo(() => {
    const keys: string[] = [];
    for (const d of drawn) {
      if (d.node.s.state === "needs_you" || (d.folded && roll.get(d.node.s.key)?.loud === "needs_you")) {
        keys.push(d.node.s.key);
      }
    }
    for (const f of folders) {
      const fk = `f:${f.id}`;
      if (folded.has(fk) && folderLoud.get(f.id) === "needs_you") keys.push(fk);
    }
    if (grouped) {
      for (const pg of projectGroups) {
        const pk = `p:${pg.key}`;
        if (folded.has(pk) && pg.loud === "needs_you") keys.push(pk);
      }
    }
    return keys.join(",");
  }, [drawn, roll, folders, folded, folderLoud, grouped, projectGroups]);
  const needsPill = useNeedsPill(scroller, needsSig);
  const jumpToNeeds = () => {
    if (!needsPill) return;
    const el = rowEl(needsPill.targetKey);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    hadFocus.current = true;
    focusedEl.current = el;
    setFocusKey(needsPill.targetKey);
    el.focus({ preventScroll: true });
  };
  return (
    <div
      className={`stree${touch ? " stree--touch" : ""}`}
      ref={box}
      data-dragging={drag ? "" : undefined}
      data-held={hold ? "" : undefined}
      data-keys-own=""
    >
      <div className="stree-head">
        {pinZone ? (
          <div
            className="stree-new stree-pin-zone"
            data-zone="pin"
            data-target={drag?.target?.kind === "pinned" ? "" : undefined}
          >
            <PinGlyph />
            <span>Drop to pin</span>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="stree-new"
              onClick={() => openNewSession()}
              data-tip={touch ? undefined : "New session"}
              data-tip-keys={touch ? undefined : hintFor("newSession.open") || undefined}
              data-tip-side="right"
            >
              <PlusCircleIcon size={touch ? 20 : 16} className="stree-new-glyph" />
              <span>New session</span>
            </button>
            <button
              type="button"
              className="icon-btn stree-head-btn"
              aria-label={grouped ? "Show flat list" : "Group by project"}
              aria-pressed={grouped}
              data-tree-group-toggle=""
              data-tip={touch ? undefined : grouped ? "Show flat list" : "Group by project"}
              data-tip-side="bottom"
              onClick={() => {
                calmNextCommit();
                setSettings({ sidebarGroup: grouped ? "flat" : "project" });
              }}
            >
              <GroupProjectsIcon size={touch ? 18 : 16} />
            </button>
            <button
              type="button"
              className="icon-btn stree-head-btn"
              aria-label="New folder"
              data-tree-new-folder=""
              data-tip={touch ? undefined : "New folder"}
              data-tip-keys={touch ? undefined : hintFor("tree.newFolder") || undefined}
              data-tip-side="bottom"
              onClick={startCreateFolder}
            >
              <NewFolderIcon size={touch ? 18 : 16} />
            </button>
          </>
        )}
      </div>
      {between}
      <div className="stree-body">
        <div
          className="stree-scroll"
          ref={scroller}
          data-more-above={fades.above ? "" : undefined}
          data-more-below={fades.below ? "" : undefined}
        >
          {pinned.length > 0 && (
            <section className="stree-section" aria-labelledby={`${groupId}-pinned`}>
              <h2
                className="stree-label"
                id={`${groupId}-pinned`}
                data-zone="pinned"
                data-target={drag?.target?.kind === "pinned" ? "" : undefined}
                onPointerDown={onSectionTouchDown}
                {...pinnedHeadingMenu}
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
          {(folders.length > 0 || creatingFolder) && (
            <section className="stree-section" aria-labelledby={`${groupId}-folders`}>
              <h2
                className="stree-label"
                id={`${groupId}-folders`}
                onPointerDown={onSectionTouchDown}
                {...foldersHeadingMenu}
              >
                Folders
              </h2>
              <div className="stree-list" role="tree" aria-labelledby={`${groupId}-folders`} onKeyDown={onKey}>
                {folders.map((f, fi) => {
                  const fk = `f:${f.id}`;
                  const isFolded = folded.has(fk);
                  const fRoots = folderRoots.get(f.id) ?? [];
                  const fLoud = folderLoud.get(f.id) ?? "none";
                  const fGroupId = `${groupId}-folder-${f.id}`;
                  const isRenaming = renamingFolderId === f.id;
                  return (
                    <FolderGroupRow
                      key={f.id}
                      folder={f}
                      index={fi}
                      total={folders.length}
                      foldKey={fk}
                      groupId={fGroupId}
                      folded={isFolded}
                      count={fRoots.length}
                      loud={fLoud}
                      tab={tabKey === fk}
                      target={drag?.target?.kind === "folder" && drag.target.folderId === f.id}
                      touch={touch}
                      renaming={isRenaming}
                      draft={folderDraft}
                      inputRef={isRenaming ? inlineInputRef : undefined}
                      onDraftChange={setFolderDraft}
                      onCommitRename={(fromKey) => commitFolderRename(f.id, fromKey)}
                      onCancelEdit={cancelFolderEdit}
                      onStartRename={() => startRenameFolder(f)}
                      onToggleFold={() => {
                        calmNextCommit();
                        setFolded(fk, !isFolded);
                      }}
                      onFocus={() => actions.focus(fk)}
                      kidsInFolder={() => parentKeysIn(fRoots)}
                      latestFolds={latestFolds}
                      setFoldedMany={setFoldedMany}
                    >
                      {!isFolded && (
                        // biome-ignore lint/a11y/useSemanticElements: a tree's group of treeitems (WAI-ARIA tree pattern), not a form's fieldset
                        <div className="stree-group-body" role="group" id={fGroupId} aria-label={f.name}>
                          {fRoots.length > 0 ? (
                            fRoots.map((n, i) => row(n, "folder", i + 1, fRoots.length, undefined, f.id, fk))
                          ) : (
                            <p
                              className="stree-group-empty"
                              data-zone="folder"
                              data-folder-id={f.id}
                              data-target={
                                drag?.target?.kind === "folder" && drag.target.folderId === f.id ? "" : undefined
                              }
                            >
                              {touch ? "No active sessions" : "Drop sessions here"}
                            </p>
                          )}
                        </div>
                      )}
                    </FolderGroupRow>
                  );
                })}
                {creatingFolder && (
                  <div role="none" className="stree-item">
                    <div className="stree-row stree-group-row stree-folder-row stree-folder-row--editing">
                      <span className="stree-group-chev" aria-hidden="true">
                        <Chevron />
                      </span>
                      <span className="stree-lead">
                        <FolderIcon />
                      </span>
                      <input
                        ref={inlineInputRef}
                        type="text"
                        className="stree-inline-input"
                        value={folderDraft}
                        maxLength={ARRANGEMENT_FOLDER_NAME_MAX}
                        placeholder="Folder name"
                        aria-label="New folder name"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => setFolderDraft(e.target.value)}
                        onBlur={() => commitFolderCreate(false)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitFolderCreate(true);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelFolderEdit();
                          }
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}
          <section className="stree-section" aria-labelledby={`${groupId}-sessions`}>
            <h2
              className="stree-label"
              id={`${groupId}-sessions`}
              data-zone="sessions"
              data-target={drag?.target?.kind === "top" ? "" : undefined}
              onPointerDown={onSectionTouchDown}
              {...sessionsHeadingMenu}
            >
              Sessions
            </h2>
            {empty ? (
              <StartingRows
                touch={touch}
                none={loaded ? (all.length > 0 ? "All hidden on this device" : "None yet") : null}
                label={`${groupId}-sessions`}
              />
            ) : grouped ? (
              <div
                className="stree-list"
                role="tree"
                aria-labelledby={`${groupId}-sessions`}
                onKeyDown={onKey}
                ref={listRef}
              >
                <StartingRows touch={touch} />
                {projectGroups.map((pg, pi) => {
                  const pk = `p:${pg.key}`;
                  const isFolded = folded.has(pk);
                  const pGroupId = `${groupId}-proj-${pi}`;
                  return (
                    <ProjectGroupRow
                      key={pg.key}
                      group={pg}
                      machines={machines}
                      index={pi}
                      total={projectGroups.length}
                      foldKey={pk}
                      groupId={pGroupId}
                      folded={isFolded}
                      tab={tabKey === pk}
                      touch={touch}
                      onToggleFold={() => {
                        calmNextCommit();
                        setFolded(pk, !isFolded);
                      }}
                      onFocus={() => actions.focus(pk)}
                      kidsInProject={() => parentKeysIn(pg.roots)}
                      latestFolds={latestFolds}
                      setFoldedMany={setFoldedMany}
                    >
                      {!isFolded && (
                        // biome-ignore lint/a11y/useSemanticElements: a tree's group of treeitems (WAI-ARIA tree pattern), not a form's fieldset
                        <div className="stree-group-body" role="group" id={pGroupId} aria-label={pg.label}>
                          {pg.roots.map((n, i) => row(n, "sessions", i + 1, pg.roots.length, undefined, undefined, pk))}
                        </div>
                      )}
                    </ProjectGroupRow>
                  );
                })}
              </div>
            ) : (
              <div
                className="stree-list"
                role="tree"
                aria-labelledby={`${groupId}-sessions`}
                onKeyDown={onKey}
                ref={listRef}
              >
                {shownRoots.map((h, i) => (
                  <Fragment key={h.key}>
                    {i === startAt && <StartingRows touch={touch} />}
                    {h.gone ? <GoneRow h={h} /> : row(h.item, "sessions", i + 1, heldRoots.length)}
                  </Fragment>
                ))}
                {startAt === -1 && <StartingRows touch={touch} />}
              </div>
            )}
            {more > 0 && (
              <button
                type="button"
                className="stree-more-btn stree-more-all"
                onClick={() => {
                  focusAfterExpand.current = heldRoots[limit]?.key ?? null;
                  setLimit((n) => n + TREE_SHOWN);
                }}
              >
                Show more
                <span className="stree-more-count num">{more}</span>
              </button>
            )}
          </section>
          <div className="stree-line" ref={line} aria-hidden="true" hidden />
        </div>
        {needsPill && !drag && (
          <button
            type="button"
            className={`stree-needs-pill stree-needs-pill--${needsPill.edge}`}
            onClick={jumpToNeeds}
          >
            <span className="stree-needs-dot" aria-hidden="true" />
            <span>{needsPill.count === 1 ? "1 needs you" : `${needsPill.count} need you`}</span>
            <span className="stree-needs-arrow" aria-hidden="true">
              {needsPill.edge === "top" ? "↑" : "↓"}
            </span>
          </button>
        )}
      </div>
      {foot}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-tree-said="">
        {said}
      </div>
      {drag &&
        createPortal(
          <div
            className="stree-chip"
            ref={chip}
            aria-hidden="true"
            data-touch={drag.touch ? "" : undefined}
            style={{ transform: chipPos(drag.x, drag.y, drag.touch) }}
          >
            <HarnessGlyph name={drag.harness} size="sm" decorative />
            <span className="stree-chip-title">{drag.title}</span>
          </div>,
          document.body,
        )}
    </div>
  );
});

const nodeKey = (n: TreeNode) => n.s.key;

/** Touch long-press menu trigger for folder / project group rows and section headings inside
 *  `.stree` (ContextMenu.tsx skips `.stree` so session rows own their own press/drag gesture). */
function useTouchMenu(touch: boolean) {
  const activeCleanup = useRef<(() => void) | null>(null);
  const activePointerId = useRef<number | null>(null);
  useEffect(() => () => activeCleanup.current?.(), []);
  return useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!touch || e.pointerType === "mouse" || e.button !== 0) return;
      if (activePointerId.current !== null) return;
      activeCleanup.current?.();
      const el = e.currentTarget;
      const pointerId = e.pointerId;
      const start = { x: e.clientX, y: e.clientY };
      let timer = 0;
      let swallowTimer = 0;
      let opened = false;
      activePointerId.current = pointerId;
      el.setAttribute("data-pressed", "");

      const clearSwallow = () => {
        window.clearTimeout(swallowTimer);
        swallowTimer = 0;
        window.removeEventListener("click", swallow, true);
        if (activeCleanup.current === cleanup) activeCleanup.current = null;
      };
      const swallow = (c: Event) => {
        if ((c.target as HTMLElement | null)?.closest?.(".menu-sheet")) return;
        c.preventDefault();
        c.stopPropagation();
        clearSwallow();
      };
      const detachHold = () => {
        window.clearTimeout(timer);
        timer = 0;
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
        window.removeEventListener("contextmenu", noMenu, true);
        if (activePointerId.current === pointerId) activePointerId.current = null;
      };
      const cleanup = () => {
        detachHold();
        clearSwallow();
        el.removeAttribute("data-pressed");
        if (activeCleanup.current === cleanup) activeCleanup.current = null;
      };
      const installSwallow = () => {
        window.addEventListener("click", swallow, true);
        swallowTimer = window.setTimeout(clearSwallow, 400);
      };
      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (touchScrolls(ev.clientX - start.x, ev.clientY - start.y)) cleanup();
      };
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        detachHold();
        if (opened) {
          if (!el.hasAttribute("data-menu-open")) el.removeAttribute("data-pressed");
          installSwallow();
        } else {
          el.removeAttribute("data-pressed");
          if (activeCleanup.current === cleanup) activeCleanup.current = null;
        }
      };
      const onCancel = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        detachHold();
        el.removeAttribute("data-pressed");
        if (opened) {
          installSwallow();
        } else if (activeCleanup.current === cleanup) {
          activeCleanup.current = null;
        }
      };
      const noMenu = (ev: Event) => {
        if ((ev as { __touch?: boolean }).__touch) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
      };

      timer = window.setTimeout(() => {
        timer = 0;
        opened = true;
        window.removeEventListener("pointermove", onMove, true);
        haptic("selection");
        const ce = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: start.x,
          clientY: start.y,
        });
        el.dispatchEvent(Object.assign(ce, { __touch: true }));
        if (!el.hasAttribute("data-menu-open")) el.removeAttribute("data-pressed");
      }, LONG_PRESS_MS);
      activeCleanup.current = cleanup;
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onCancel, true);
      window.addEventListener("contextmenu", noMenu, true);
    },
    [touch],
  );
}

/** One custom folder header + its expanded session tree. */
function FolderGroupRow({
  folder,
  index,
  total,
  foldKey,
  groupId,
  folded,
  count,
  loud,
  tab,
  target,
  touch,
  renaming,
  draft,
  inputRef,
  onDraftChange,
  onCommitRename,
  onCancelEdit,
  onStartRename,
  onToggleFold,
  onFocus,
  kidsInFolder,
  latestFolds,
  setFoldedMany,
  children,
}: {
  folder: ArrangementFolder;
  index: number;
  total: number;
  foldKey: string;
  groupId: string;
  folded: boolean;
  count: number;
  loud: Loud;
  tab: boolean;
  target: boolean;
  touch: boolean;
  renaming: boolean;
  draft: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  onDraftChange: (v: string) => void;
  onCommitRename: (fromKey?: boolean) => void;
  onCancelEdit: () => void;
  onStartRename: () => void;
  onToggleFold: () => void;
  onFocus: () => void;
  kidsInFolder: () => SessionKey[];
  latestFolds: RefObject<ReadonlySet<string>>;
  setFoldedMany: (keys: readonly string[], fold: boolean) => void;
  children?: ReactNode;
}) {
  const store = useStore();
  const folderRowRef = useRef<HTMLDivElement>(null);
  const onTouchDown = useTouchMenu(touch);
  const buildMenu = () =>
    folderMenuItems(store, folder, index, total, {
      onRename: onStartRename,
      kidKeys: kidsInFolder(),
      folded: latestFolds.current,
      setFoldedMany,
    });
  const menu = useContextMenu(buildMenu, { title: () => folder.name });
  const rolled = folded && loud !== "none" ? loud : undefined;
  return (
    <div role="none" className="stree-item stree-group-item">
      <div role="none" className="stree-folder-head">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the tree's onKey handler owns Enter, Space, and arrows */}
        <div
          ref={folderRowRef}
          role="treeitem"
          aria-level={1}
          aria-posinset={index + 1}
          aria-setsize={total}
          aria-expanded={!folded}
          aria-owns={!folded ? groupId : undefined}
          tabIndex={tab ? 0 : -1}
          className={`stree-row stree-group-row stree-folder-row${renaming ? " stree-folder-row--editing" : ""}`}
          data-flip={`fhead:${folder.id}`}
          data-tree-nav=""
          data-group-row={foldKey}
          data-zone="folder"
          data-folder-id={folder.id}
          data-rolled={rolled}
          data-target={target ? "" : undefined}
          onClick={() => {
            if (!renaming) onToggleFold();
          }}
          onDoubleClick={(e) => {
            if (touch || renaming) return;
            e.stopPropagation();
            onStartRename();
          }}
          onPointerDown={renaming ? undefined : onTouchDown}
          onFocus={onFocus}
          {...menu}
        >
          <span className="stree-group-chev" data-folded={folded ? "" : undefined} aria-hidden="true">
            <Chevron />
          </span>
          <span className="stree-lead">
            <FolderIcon open={!folded} />
          </span>
          {folder.color && (
            <span className={`stree-folder-dot label-dot label-dot--${folder.color}`} aria-hidden="true" />
          )}
          {renaming ? (
            <input
              ref={inputRef}
              type="text"
              className="stree-inline-input"
              value={draft}
              maxLength={ARRANGEMENT_FOLDER_NAME_MAX}
              aria-label="Folder name"
              autoComplete="off"
              spellCheck={false}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onChange={(e) => onDraftChange(e.target.value)}
              onBlur={() => onCommitRename(false)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  onCommitRename(true);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onCancelEdit();
                }
              }}
            />
          ) : (
            <span className="stree-title" dir="auto">
              {folder.name}
            </span>
          )}
          <span className="stree-group-count num" aria-hidden="true">
            {count}
          </span>
          <span className="stree-lamp">{rolled && <GroupLamp loud={rolled} size={touch ? 12 : 10} />}</span>
          <span className="sr-only">
            , folder, {count} {count === 1 ? "session" : "sessions"}
            {rolled ? loudWords(rolled) : ""}
          </span>
        </div>
        {touch && !renaming && (
          <button
            type="button"
            className="icon-btn stree-folder-more"
            aria-label={`Folder actions for ${folder.name}`}
            aria-haspopup="menu"
            tabIndex={-1}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              openMenu(buildMenu(), e.currentTarget, {
                source: "touch",
                invoker: e.currentTarget,
                owner: folderRowRef.current ?? e.currentTarget,
                title: folder.name,
              });
            }}
          >
            <MoreDotsIcon size={16} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/** One auto-grouped project header + hover `+` new-session button + its expanded sessions. */
function ProjectGroupRow({
  group,
  machines,
  index,
  total,
  foldKey,
  groupId,
  folded,
  tab,
  touch,
  onToggleFold,
  onFocus,
  kidsInProject,
  latestFolds,
  setFoldedMany,
  children,
}: {
  group: ProjectGroup;
  machines: ReadonlyMap<string, MachineSummary>;
  index: number;
  total: number;
  foldKey: string;
  groupId: string;
  folded: boolean;
  tab: boolean;
  touch: boolean;
  onToggleFold: () => void;
  onFocus: () => void;
  kidsInProject: () => SessionKey[];
  latestFolds: RefObject<ReadonlySet<string>>;
  setFoldedMany: (keys: readonly string[], fold: boolean) => void;
  children?: ReactNode;
}) {
  const onTouchDown = useTouchMenu(touch);
  // Only offer "New session in …" when at least one session in the project runs on a paired machine.
  let pairedLatest: SessionSummary | undefined;
  let pairedTime = -1;
  for (const n of group.roots) {
    const s = n.s;
    if (!s.machine || !machines.get(s.machine)?.control) continue;
    const t = Date.parse(s.lastAt || s.startedAt) || 0;
    if (!pairedLatest || t > pairedTime) {
      pairedLatest = s;
      pairedTime = t;
    }
  }
  const startInProject = () => {
    if (!pairedLatest) return;
    openNewSession({
      machine: pairedLatest.machine,
      ...(pairedLatest.harness ? { harness: pairedLatest.harness } : {}),
      ...(pairedLatest.cwd ? { cwd: pairedLatest.cwd } : {}),
    });
  };
  const menu = useContextMenu(
    () => {
      const kidKeys = kidsInProject();
      if (!pairedLatest && kidKeys.length === 0) return null;
      const anyKidFolded = kidKeys.some((k) => latestFolds.current.has(k));
      const anyKidOpen = kidKeys.some((k) => !latestFolds.current.has(k));
      return [
        pairedLatest && { label: `New session in ${group.label}`, run: startInProject },
        pairedLatest && kidKeys.length > 0 && { sep: true },
        kidKeys.length > 0 && {
          label: "Unfold all",
          disabled: !anyKidFolded,
          run: () => setFoldedMany(kidKeys, false),
        },
        kidKeys.length > 0 && {
          label: "Fold all",
          disabled: !anyKidOpen,
          run: () => setFoldedMany(kidKeys, true),
        },
      ];
    },
    { title: () => group.label, subtitle: () => group.subtitle ?? "" },
  );
  const rolled = folded && group.loud !== "none" ? group.loud : undefined;
  const tip = group.subtitle ? `${group.label}\n${group.subtitle}` : group.label;
  return (
    <div role="none" className="stree-item stree-group-item">
      <div
        role="none"
        className={`stree-project-head${pairedLatest ? " stree-project-head--add" : ""}`}
        data-flip={`phead:${group.key}`}
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the tree's onKey handler owns Enter, Space, and arrows */}
        <div
          role="treeitem"
          aria-level={1}
          aria-posinset={index + 1}
          aria-setsize={total}
          aria-expanded={!folded}
          aria-owns={!folded ? groupId : undefined}
          tabIndex={tab ? 0 : -1}
          className="stree-row stree-group-row stree-project-row"
          data-tree-nav=""
          data-group-row={foldKey}
          data-zone="project"
          data-project-key={group.key}
          data-rolled={rolled}
          data-tip={touch ? undefined : tip}
          data-tip-wrap={touch ? undefined : ""}
          data-tip-side={touch ? undefined : "right"}
          onClick={onToggleFold}
          onPointerDown={onTouchDown}
          onFocus={onFocus}
          {...menu}
        >
          <span className="stree-group-chev" data-folded={folded ? "" : undefined} aria-hidden="true">
            <Chevron />
          </span>
          <span className="stree-lead">
            <ProjectIcon />
          </span>
          <span className="stree-title" dir="auto">
            {group.label}
          </span>
          <span className="stree-group-count num" aria-hidden="true">
            {group.count}
          </span>
          <span className="stree-lamp">{rolled && <GroupLamp loud={rolled} size={touch ? 12 : 10} />}</span>
          <span className="sr-only">
            , project, {group.count} {group.count === 1 ? "session" : "sessions"}
            {rolled ? loudWords(rolled) : ""}
          </span>
        </div>
        {pairedLatest && (
          <button
            type="button"
            className="stree-project-add"
            aria-label={`New session in ${group.label}`}
            data-tip={touch ? undefined : `New session in ${group.label}`}
            data-tip-side="right"
            tabIndex={-1}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              startInProject();
            }}
          >
            <PlusSmallIcon size={touch ? 16 : 13} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/** The starts from here whose session is not listed yet (the Board's starting cards): a
 *  row each, its agent's mark, the start's words or "New session" and the turning ring,
 *  opening its session, never dragged. Keyed by the session's key, as its real row will
 *  be (data-flip), so that row takes the same place with nothing sliding. With no rows to
 *  stand among (`none` set or null), it is the list itself, or the words for an empty one.
 *  Its own component: the control activity it reads redraws only these rows. */
function StartingRows({ touch, none, label }: { touch: boolean; none?: string | null; label?: string }) {
  const { pending } = usePendingStarts();
  const rows = pending.map((a) => <StartingRow key={a.session} a={a} touch={touch} />);
  if (none === undefined) return rows;
  if (pending.length === 0) return none ? <p className="stree-none">{none}</p> : null;
  return (
    <div className="stree-list" role="tree" aria-labelledby={label}>
      {rows}
    </div>
  );
}

function StartingRow({ a, touch }: { a: ControlActivity; touch: boolean }) {
  const key = a.session!;
  const { harness, id } = splitKey(key);
  const title = (a.text ?? "").split("\n")[0]!.trim().slice(0, 120) || "New session";
  const menu = useContextMenu(() => [{ label: "Open", run: () => openSession(key, "primary") }], {
    title: () => title,
  });
  return (
    <div role="none" className="stree-item" data-flip={key}>
      <a
        href={hrefFor(sessionPath(harness, id))}
        role="treeitem"
        aria-level={1}
        aria-busy="true"
        tabIndex={-1}
        className="stree-row"
        data-starting={key}
        data-state="working"
        style={{ "--lvl": 0 } as CSSProperties}
        data-tip={touch ? undefined : `${title}\nStarting`}
        data-tip-wrap={touch ? undefined : ""}
        data-tip-side={touch ? undefined : "right"}
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          openSession(key, "primary");
        }}
        onDragStart={(e) => e.preventDefault()}
        draggable={false}
        {...menu}
      >
        <span className="stree-lead">
          <HarnessGlyph name={harness} size={touch ? "md" : "sm"} decorative />
        </span>
        <span className="stree-title" dir="auto">
          {title}
        </span>
        <span className="stree-lamp">
          <StateDot state="working" decorative size={touch ? 12 : 10} />
        </span>
        <span className="sr-only">, starting</span>
      </a>
    </div>
  );
}

/** Floating pill when every needs-you row (own or rolled, including folded groups) is scrolled out of view. */
interface NeedsPillState {
  count: number;
  edge: "top" | "bottom";
  targetKey: string;
}
function useNeedsPill(ref: RefObject<HTMLElement | null>, sig: string): NeedsPillState | null {
  const [pill, setPill] = useState<NeedsPillState | null>(null);
  useEffect(() => {
    const sc = ref.current;
    if (!sc || !sig || typeof IntersectionObserver !== "function") {
      setPill(null);
      return;
    }
    const rows = Array.from(
      sc.querySelectorAll<HTMLElement>(
        '[data-tree-row]:is([data-state="needs_you"], [data-rolled="needs_you"]), [data-group-row][data-rolled="needs_you"]',
      ),
    );
    if (rows.length === 0) {
      setPill(null);
      return;
    }
    const visible = new Set<Element>();
    const update = () => {
      if (visible.size > 0) {
        setPill((p) => (p ? null : p));
        return;
      }
      const sr = sc.getBoundingClientRect();
      const above: HTMLElement[] = [];
      const below: HTMLElement[] = [];
      for (const r of rows) {
        const rr = r.getBoundingClientRect();
        if (rr.bottom <= sr.top + 1) above.push(r);
        else if (rr.top >= sr.bottom - 1) below.push(r);
      }
      if (above.length === 0 && below.length === 0) {
        setPill((p) => (p ? null : p));
        return;
      }
      let edge: "top" | "bottom";
      let target: HTMLElement;
      if (above.length > 0 && below.length === 0) {
        edge = "top";
        target = above[above.length - 1]!;
      } else if (below.length > 0 && above.length === 0) {
        edge = "bottom";
        target = below[0]!;
      } else {
        const lastAbove = above[above.length - 1]!;
        const firstBelow = below[0]!;
        const dTop = sr.top - lastAbove.getBoundingClientRect().bottom;
        const dBot = firstBelow.getBoundingClientRect().top - sr.bottom;
        if (dTop <= dBot) {
          edge = "top";
          target = lastAbove;
        } else {
          edge = "bottom";
          target = firstBelow;
        }
      }
      const targetKey = target.dataset.treeRow ?? target.dataset.groupRow!;
      const count = rows.length;
      setPill((p) =>
        p && p.count === count && p.edge === edge && p.targetKey === targetKey ? p : { count, edge, targetKey },
      );
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target);
          else visible.delete(e.target);
        }
        update();
      },
      { root: sc, threshold: 0.1 },
    );
    for (const r of rows) io.observe(r);
    return () => io.disconnect();
  }, [ref, sig]);
  return pill;
}

/** Whether the list goes on above and below what is in view: its ends fade only where it does. */
function useScrollFades(ref: RefObject<HTMLElement | null>): { above: boolean; below: boolean } {
  const [fades, setFades] = useState({ above: false, below: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const above = el.scrollTop > 1;
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setFades((f) => (f.above === above && f.below === below ? f : { above, below }));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    ro?.observe(el);
    for (const c of el.children) ro?.observe(c);
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", schedule);
      ro?.disconnect();
      mo.disconnect();
    };
  }, [ref]);
  return fades;
}

/** A row that left while the list was held: where it was, quiet and inert, until the hand leaves. */
function GoneRow({ h }: { h: Held<TreeNode> }) {
  return (
    <div role="none" className="stree-item" data-flip={h.key} data-gone="">
      <span className="stree-row" style={{ "--lvl": 0 } as CSSProperties}>
        <span className="stree-lead">
          <HarnessGlyph name={h.item.s.harness} size="sm" decorative />
        </span>
        <span className="stree-title">{sessionTitle(h.item.s)}</span>
      </span>
    </div>
  );
}

/** The rows under a parent, on one rail; its own list for the FLIP. */
function KidGroup({
  id,
  level,
  label,
  sig,
  children,
}: {
  id: string;
  level: number;
  label: string;
  sig: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref, 80, { move: 150, sig });
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
  focus: (key: string) => void;
  fold: (key: SessionKey, fold: boolean, deep?: boolean) => void;
  click: (e: ReactMouseEvent<HTMLAnchorElement>, key: SessionKey) => void;
}

interface RowProps {
  n: TreeNode;
  group: Group;
  folderId?: string;
  ariaLevel: number;
  pos: number;
  size: number;
  open: boolean;
  tab: boolean;
  /** News since the person looked (lib/marks.ts), as the Board reads it. */
  unread: boolean;
  /** The glyph comes from under the row (folded, or past Show N more): the loudest there. */
  rolled?: Loud;
  /** What a folded row holds, in words (", 3 inside, 1 needs you"). */
  inside: string;
  /** The sessions a folded row stands for (Mark as read reads them too). */
  under: readonly SessionSummary[];
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
  up?: string;
  actions: RowActions;
}

function TreeRow({ children, ...p }: RowProps & { children?: ReactNode }) {
  return (
    <div role="none" className="stree-item" data-flip={p.n.s.key} data-lifted={p.lifted ? "" : undefined}>
      <RowLine
        s={p.n.s}
        level={p.n.level}
        ariaLevel={p.ariaLevel}
        placed={p.n.placed}
        group={p.group}
        folderId={p.folderId}
        pos={p.pos}
        size={p.size}
        open={p.open}
        tab={p.tab}
        unread={p.unread}
        rolled={p.rolled}
        inside={p.inside}
        under={p.under}
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
  ariaLevel,
  placed,
  group,
  folderId,
  pos,
  size,
  open,
  tab,
  unread,
  rolled,
  inside,
  under,
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
  const rowRef = useRef<HTMLAnchorElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const title = sessionTitle(s);
  const menu = useContextMenu(() => sessionItems(s, { store, surface: "list", under, inTree: true }), {
    title: () => sessionMenuTitle(s),
    subtitle: () => sessionMenuSubtitle(s),
  });
  // Refresh the app tooltip right before TipHost reads it, so cut-title detection and
  // elapsed time are always live without measuring on render.
  useEffect(() => {
    if (touch) return;
    const el = rowRef.current;
    if (!el) return;
    const prepare = () => {
      const t = titleRef.current;
      const cut = !!t && t.scrollWidth > t.clientWidth + 0.5;
      el.setAttribute("data-tip", sessionRowTip(s, placed, cut));
    };
    el.addEventListener("tip:prepare", prepare);
    return () => el.removeEventListener("tip:prepare", prepare);
  }, [touch, s, placed]);
  const disclose = hasKids && (
    <span
      className="stree-disc"
      aria-hidden="true"
      data-folded={folded ? "" : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        actions.fold(s.key, !folded, e.altKey);
      }}
    >
      <Chevron />
    </span>
  );
  const desc = !away && s.machine ? `Runs on ${s.machine}` : "";
  const agent = harnessMark(s.harness).label;
  const rowName =
    `${title}${stateWords(s, unread)}${inside}` +
    `${agent ? `, ${agent}` : ""}` +
    `${placed ? ", placed by you" : ""}` +
    `${away && s.machine ? `, on ${s.machine}` : ""}`;
  return (
    <a
      ref={rowRef}
      href={hrefFor(sessionPath(s.harness, s.id))}
      role="treeitem"
      aria-label={rowName}
      aria-description={desc || undefined}
      aria-level={ariaLevel}
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
      data-folder-id={folderId}
      data-state={s.state}
      data-unread={unread ? "" : undefined}
      data-rolled={rolled}
      data-open={open ? "" : undefined}
      data-placed={placed ? "" : undefined}
      data-target={target ? "" : undefined}
      data-has-kids={hasKids ? "" : undefined}
      data-tip={touch ? undefined : sessionRowTip(s, placed, false)}
      data-tip-wrap={touch ? undefined : ""}
      data-tip-side={touch ? undefined : "right"}
      style={{ "--lvl": level } as CSSProperties}
      onClick={(e) => actions.click(e, s.key)}
      onFocus={() => actions.focus(s.key)}
      onPointerDown={(e) => actions.down(e, s)}
      onDragStart={(e) => e.preventDefault()}
      draggable={false}
      {...menu}
    >
      <span className="stree-lead">
        <HarnessGlyph name={s.harness} size={touch ? "md" : "sm"} decorative />
        {!touch && disclose}
      </span>
      <span ref={titleRef} className="stree-title" dir="auto" aria-hidden="true">
        {title}
      </span>
      {!touch && away && s.machine && <AwayMark />}
      {touch && disclose}
      <span className="stree-lamp">
        <Lamp s={s} unread={unread} rolled={rolled} size={touch ? 12 : 10} />
      </span>
    </a>
  );
});

// ----- the drag's hook -----

interface Live {
  tree: Tree;
  all: SessionSummary[];
  arrangement: Arrangement;
  drawn: Drawn[];
  folded: ReadonlySet<string>;
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
  unfold: (key: string) => void;
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
    const downAt = performance.now();
    const id = e.pointerId;
    let at = { ...start };
    let lifted = false;
    let pressed = false;
    let held = false;
    let hadTarget = false;
    let target: Target | null = null;
    let pressedAt = { ...start };
    let lastEvent: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean } = {
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    };
    let openTimer = 0;
    let liftTimer = 0;
    let frame = 0;
    const key = session.key;

    /** Where the rows are now, and the headings, folders, and projects. */
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
          ...(r.dataset.folderId ? { folderId: r.dataset.folderId } : {}),
        });
      }
      const zone = (sel: string) => {
        const z = root.querySelector<HTMLElement>(sel)?.getBoundingClientRect();
        return z ? { top: z.top, bottom: z.bottom } : undefined;
      };
      const folders: FolderZone[] = [];
      for (const f of root.querySelectorAll<HTMLElement>('[data-zone="folder"]')) {
        const fid = f.dataset.folderId;
        if (!fid) continue;
        const b = f.getBoundingClientRect();
        folders.push({ folderId: fid, top: b.top, bottom: b.bottom });
      }
      const projects: { top: number; bottom: number }[] = [];
      for (const p of root.querySelectorAll<HTMLElement>('[data-zone="project"]')) {
        const b = p.getBoundingClientRect();
        projects.push({ top: b.top, bottom: b.bottom });
      }
      // New session's row (Drop to pin) AND Pinned's own heading both accept drops to pin.
      const pinnedZones = [zone('[data-zone="pin"]'), zone('[data-zone="pinned"]')].filter(
        (z): z is { top: number; bottom: number } => !!z,
      );
      return {
        rows,
        zones: {
          pinned: pinnedZones.length ? pinnedZones : undefined,
          sessions: zone('[data-zone="sessions"]'),
          folders,
          projects,
          bottom: ref.current.scroller.current?.getBoundingClientRect().bottom,
        },
      };
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
      if (t) hadTarget = true;
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
      } else if (t?.kind === "folder") {
        const fk = `f:${t.folderId}`;
        if (ref.current.live.current!.folded.has(fk))
          openTimer = window.setTimeout(() => ref.current.unfold(fk), OPEN_AFTER_MS);
      }
    };

    const place = () => {
      const c = ref.current.chip.current;
      if (c) c.style.transform = chipPos(at.x, at.y, touch);
    };

    const scrollLoop = () => {
      const sc = ref.current.scroller.current;
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
      if (!touch) {
        try {
          el.setPointerCapture(id);
        } catch {
          // the pointer is already gone
        }
      }
      closeMenu(false, { immediate: true });
      const s = session;
      ref.current.setDrag({ key, title: sessionTitle(s), harness: s.harness, target: null, touch, x: at.x, y: at.y });
      if (touch) haptic("selection");
      requestAnimationFrame(() => {
        place();
        aim();
      });
      frame = requestAnimationFrame(scrollLoop);
    };

    const end = (drop: boolean, keepMenu = false) => {
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
      if (!keepMenu) el.removeAttribute("data-pressed");
      if (!lifted) return;
      // A sloppy click: never found a target, stayed inside its own row, under 500 ms.
      if (!touch && drop && !hadTarget && performance.now() - downAt < 500) {
        const r = el.getBoundingClientRect();
        if (at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom) {
          // Swallow a synthetic click from the same release so openSession runs once.
          ref.current.justDragged.current = true;
          window.setTimeout(() => {
            ref.current.justDragged.current = false;
          }, 0);
          ref.current.setDrag(null);
          openSession(key, howOf(lastEvent));
          return;
        }
      }
      ref.current.justDragged.current = true;
      // A click that never comes (a drop elsewhere) leaves no mark on the next one.
      window.setTimeout(() => {
        ref.current.justDragged.current = false;
      }, 400);
      ref.current.setDrag(null);
      if (drop && target) arrange(store, key, moveFor(target), { source: "pointer" });
    };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      at = { x: ev.clientX, y: ev.clientY };
      if (!lifted) {
        if (touch) {
          if (!pressed) {
            if (touchScrolls(at.x - start.x, at.y - start.y)) end(false);
            return;
          }
          if (Math.hypot(at.x - pressedAt.x, at.y - pressedAt.y) >= TOUCH_MOVE_PX) {
            pressed = false;
            el.removeAttribute("data-pressed");
            lift();
          }
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
      at = { x: ev.clientX, y: ev.clientY };
      lastEvent = { metaKey: ev.metaKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, altKey: ev.altKey };
      // Released after a long-press without moving: leave the menu sheet open (data-pressed clears when it closes).
      if (touch && pressed && !lifted) {
        end(false, true);
        return;
      }
      end(true);
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      if (pressed && !lifted) closeMenu(false, { immediate: true });
      end(false);
    };
    const esc = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (pressed && !lifted) closeMenu(false, { immediate: true });
      end(false);
    };
    // While pressed or lifted on touch, suppress the browser's own contextmenu; let our own __touch through.
    const noMenu = (ev: Event) => {
      if ((ev as { __touch?: boolean }).__touch) return;
      if (!lifted && !pressed) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    };
    const noScroll = (ev: TouchEvent) => {
      if ((lifted || pressed) && ev.cancelable) ev.preventDefault();
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
        pressed = true;
        pressedAt = { ...at };
        el.setAttribute("data-pressed", "");
        haptic("selection");
        const menuEv = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: at.x,
          clientY: at.y,
        });
        el.dispatchEvent(Object.assign(menuEv, { __touch: true }));
        // Lifting the finger after a long-press is not a tap on the row.
        const swallow = (c: Event) => {
          c.preventDefault();
          c.stopPropagation();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 800);
      }, LONG_PRESS_MS);
    active.current = () => {
      if (pressed && !lifted) closeMenu(false, { immediate: true });
      end(false);
    };
  }, []);
}
