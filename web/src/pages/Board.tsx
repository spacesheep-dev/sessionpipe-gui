// SPDX-License-Identifier: Apache-2.0
// The board: every session in one grouped list, needs_you first, under sticky section
// headers. Filters by machine, harness and text in the page bar; done sessions folded
// behind a disclosure with a count, and after them, folded the same way, the ones this
// device hid (lib/hidden.ts). A session started from here shows at once, as a
// "starting" row from its signed start, until its first event makes it an ordinary row
// (STEER-SPEC B.5). A right-click on the page's empty space has the view options.
// It holds still under the hand (POLISH-PLAN.md §6 #1): within a section rows keep the
// order they started in; while the pointer is over the list (or the cursor is in it, or
// a row's menu is up) every row keeps its place and section, a row that left stays
// faded, a new one waits; when the hand leaves, the list takes its real order and the
// rows slide there (lib/motion.ts). With nothing on it yet the board is a listening
// state that names this machine and its hooked agents, and dissolves into the first row.
// While the stream is down the rows stay, quiet, their clocks stopped.
import type { ControlActivity, SessionState, SessionSummary } from "@shared/api";
import { SESSION_STATES, splitKey } from "@shared/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChipSelect,
  CommandWell,
  EmptyState,
  HarnessGlyph,
  Listening,
  Notice,
  SearchInput,
  Since,
  StateDot,
} from "../components/bits";
import { type MenuList, MoreButton, useContextMenu } from "../components/ContextMenu";
import { LabelChip, useLabelKeys } from "../components/LabelDot";
import { LensChip, LensNote } from "../components/LensChip";
import { OfflineLine } from "../components/OfflineLine";
import { PageBar } from "../components/PageBar";
import {
  BesideButton,
  cardHides,
  lensMenu,
  SessionCard,
  setShowCounts,
  useBackgroundMenu,
  useShowCounts,
  useStickyTop,
} from "../components/SessionCard";
import { machineHome, tildify } from "../control/folders";
import { useControlActivity } from "../control/hooks";
import { ComposeButton } from "../control/NewSession";
import { ALIAS_WINDOW_MS, aliasHidden, openNewSession, setBoardFilter } from "../control/newSessionState";
import { useStartTitles } from "../control/Starting";
import { isFinal } from "../control/words";
import {
  byStateThenRecent,
  useAppState,
  useFirstLoad,
  useLabels,
  useMachines,
  useSessionTree,
  useStore,
  useStreamDown,
  useUnreadKeys,
} from "../data/hooks";
import { agentMatches } from "../lib/agents";
import { foldsAway, nestDelegated } from "../lib/delegated";
import { harnessMark, repoBranch, STATE_HEADING, STATE_HINT, sessionTitle } from "../lib/format";
import {
  canHideUntilNeeded,
  hiddenNow,
  hiddenRows,
  hide,
  hideUntilNeeded,
  inItsPlace,
  isHidden,
  unhide,
  useHidden,
} from "../lib/hidden";
import { focusSearch, inPanel, useListNav } from "../lib/keys";
import { type LabelFilter, labelName, labelPasses, labelQuery, requestLabelRename } from "../lib/labels";
import { isUnread, setUnread } from "../lib/marks";
import { type Held, useFlip, useHeldOrder, useListHold, usePresence } from "../lib/motion";
import { Link, navigate, sessionPath } from "../lib/router";
import { type Lens, setMode, setSettings, useAppSettings, useLens } from "../lib/settings";
import { useShortcut } from "../lib/shortcuts";
import { openSplit, useSplitKey } from "../lib/split";
import { useNow } from "../lib/time";
import { useSetupStatus } from "../setup/api";

const isStart = (a: ControlActivity) => a.kind === "start";
/** A start still on its way shows as a row for at most this long without an event. */
const PENDING_MAX_MS = 3600_000;

/** Whether a search finds one of a session's agents (their type or what they were asked). */
const agentsMatch = (s: SessionSummary, q: string): boolean => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && (s.agents ?? []).some((a) => words.every((w) => agentMatches(a, w)));
};

const matches = (s: SessionSummary, q: string) => {
  if (!q) return true;
  const hay = [
    sessionTitle(s),
    s.cwd,
    repoBranch(s),
    s.machine,
    s.model,
    s.harness,
    s.id,
    s.lastAssistant,
    s.progress?.assistant,
    s.openAttentions.map((a) => a.message).join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
};

/** The board's view options: the page's right-click menu, its "⋯" and (Show done) the
 *  Done header's. Built when a menu opens, from the state of the last render. */
function viewItems(o: {
  filtered: boolean;
  clear: () => void;
  showDone: boolean;
  setShowDone: (v: boolean) => void;
  beside: boolean;
  lens: Lens;
  simple: boolean;
  counts: boolean;
  /** What the filters show, folded Done rows included, that has news unseen. */
  unread: SessionSummary[];
  markRead: () => void;
}): MenuList {
  return [
    { label: "Find…", action: "search.focus", run: () => void focusSearch() },
    o.filtered && { label: "Clear filters", run: o.clear },
    { label: "Show done sessions", checked: o.showDone, run: () => o.setShowDone(!o.showDone) },
    !o.simple && { label: "Show counts", checked: o.counts, run: () => setShowCounts(!o.counts) },
    { label: "Edit labels…", run: () => requestLabelRename() },
    { label: "Mark all as read", disabled: o.unread.length === 0 || undefined, run: o.markRead },
    { sep: true },
    {
      label: "Open sessions",
      items: [
        { label: "As a page", radio: true, checked: !o.beside, run: () => setSettings({ openSessions: "page" }) },
        {
          label: "Beside the page",
          radio: true,
          checked: o.beside,
          run: () => setSettings({ openSessions: "beside" }),
        },
      ],
    },
    ...lensMenu(o.lens, o.simple),
    { sep: true },
    {
      label: "Mode",
      items: [
        { label: "Simple", radio: true, checked: o.simple, run: () => setMode("simple") },
        { label: "Advanced", radio: true, checked: !o.simple, run: () => setMode("advanced") },
      ],
    },
  ];
}

/** Done stays open or folded across a visit to a session and back (Mail keeps it). */
let doneOpen = false;
/** Hidden stays open or folded too, and across reloads on this device. */
const HIDDEN_OPEN_KEY = "sessionpipe-gui.board.hiddenOpen";
let hiddenOpen = (() => {
  try {
    return localStorage.getItem(HIDDEN_OPEN_KEY) === "1";
  } catch {
    return false;
  }
})();
/** The once-only line under the first row ever seen on this device. */
const FIRST_ROW_KEY = "sessionpipe-gui.board.firstRow";
const firstRowSeen = () => {
  try {
    return localStorage.getItem(FIRST_ROW_KEY) === "1";
  } catch {
    return true;
  }
};
const markFirstRow = () => {
  try {
    localStorage.setItem(FIRST_ROW_KEY, "1");
  } catch {
    // a private window: it may say it again
  }
};
/** The empty state's exit before the first row comes in (POLISH-PLAN.md §3.3). */
const EMPTY_EXIT_MS = 160;
const isMock = () => !!(window as unknown as { __sessionpipeMock?: unknown }).__sessionpipeMock;

/** "Claude Code, Codex, Gemini CLI or Antigravity". */
const either = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;

export function Board() {
  const store = useStore();
  const tree = useSessionTree();
  const { all } = tree;
  const { snapshotAt } = useAppState();
  const firstLoad = useFirstLoad();
  const [q, setQ] = useState("");
  const [machine, setMachine] = useState("");
  const [harness, setHarness] = useState("");
  const [label, setLabelFilter] = useState<LabelFilter>("");
  const labels = useLabels();
  const lq = useMemo(() => labelQuery(labels, q), [labels, q]);
  const [showDone, setShowDoneState] = useState(doneOpen);
  const setShowDone = useCallback((v: boolean | ((was: boolean) => boolean)) => {
    setShowDoneState((was) => {
      const next = typeof v === "function" ? v(was) : v;
      doneOpen = next;
      return next;
    });
  }, []);
  const lens = useLens();
  const { mode, openSessions } = useAppSettings();
  const simple = mode === "simple";
  const counts = useShowCounts() && !simple;
  const beside = openSessions === "beside";
  const openKey = useSplitKey();
  const started = useStartTitles();
  const page = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useStickyTop(page);
  const hidden = useHidden();
  const downAt = useStreamDown();

  const machines = useMemo(() => [...new Set(all.map((s) => s.machine).filter((m): m is string => !!m))].sort(), [all]);
  const harnesses = useMemo(() => [...new Set(all.map((s) => s.harness))].sort(), [all]);
  // New session takes the board's machine and harness when the filter names one of each.
  useEffect(() => {
    setBoardFilter({ machine, harness });
    return () => setBoardFilter({});
  }, [machine, harness]);

  // Starts from here that have no session yet, and the alias window (newSessionState.ts).
  const paired = useMachines().filter((m) => m.control);
  const starts = useControlActivity(isStart);
  const { sessions } = useAppState();
  const recentStart = starts.some((a) => Date.now() - Date.parse(a.at) < ALIAS_WINDOW_MS);
  const now = useNow(recentStart ? "fine" : "coarse");
  const pending = useMemo(
    () =>
      starts.filter(
        (a) =>
          !!a.session &&
          !sessions.has(a.session) &&
          !(a.ackSession && sessions.has(a.ackSession)) &&
          !isFinal(a) &&
          now - Date.parse(a.at) < PENDING_MAX_MS &&
          (!machine || paired.find((m) => m.control?.machineId === a.machineId)?.name === machine) &&
          (!harness || splitKey(a.session).harness === harness),
      ),
    [starts, sessions, now, machine, harness, paired],
  );
  const aliased = useCallback(
    (s: SessionSummary) =>
      recentStart &&
      aliasHidden(
        s,
        starts,
        (name) => paired.find((m) => m.name === name)?.control?.machineId,
        (id) => machineHome(paired.find((m) => m.control?.machineId === id)?.control),
        now,
      ),
    [recentStart, starts, paired, now],
  );

  // A session another one asked (`delegatedBy`: sessionpipe ask, a handoff) nests under
  // the asking session the way a subagent does, as long as that session is drawn on the
  // board and on the same machine: the daemon only ever asks there, so a child naming a
  // parent elsewhere is a hook's say-so, not lineage. Drawn means every filter the roots
  // go through (machine, harness, label, the query's label part, hidden on this device,
  // an alias of a start) and not folded away in Done while the child still runs; a parent
  // any of those takes off the board leaves the asked one a root of its own. A chain of
  // asks hangs under its top, a loop nests nobody (lib/delegated.ts): nothing leaves the board.
  const { roots, childrenOf } = useMemo(() => {
    const drawn = (p: SessionSummary) =>
      (!machine || p.machine === machine) &&
      (!harness || p.harness === harness) &&
      labelPasses(labels, p.key, label) &&
      lq.test(p.key) &&
      !aliased(p) &&
      !isHidden(hidden, p.key, p.stateSince, p.state === "needs_you");
    const hangs = (s: SessionSummary, p: SessionSummary) =>
      p.machine === s.machine && drawn(p) && !foldsAway(s, p, showDone);
    const { roots, nested } = nestDelegated(tree.roots, all, hangs);
    if (nested.size === 0) return { roots, childrenOf: tree.childrenOf };
    const childrenOf = new Map(tree.childrenOf);
    for (const [key, list] of nested)
      childrenOf.set(key, [...(childrenOf.get(key) ?? []), ...list].sort(byStateThenRecent));
    return { roots, childrenOf };
  }, [tree, all, machine, harness, labels, label, lq, aliased, hidden, showDone]);

  const passes = useCallback(
    (s: SessionSummary) =>
      !aliased(s) &&
      (!machine || s.machine === machine) &&
      (!harness || s.harness === harness) &&
      labelPasses(labels, s.key, label) &&
      lq.test(s.key) &&
      (matches(s, lq.rest) ||
        agentsMatch(s, lq.rest) ||
        (childrenOf.get(s.key) ?? []).some((c) => matches(c, lq.rest))),
    [machine, harness, label, labels, lq, childrenOf, aliased],
  );
  const visible = useMemo(
    () => roots.filter((s) => passes(s) && !isHidden(hidden, s.key, s.stateSince, s.state === "needs_you")),
    [roots, passes, hidden],
  );

  // Held still under the hand: rows keep their place and section; new ones wait.
  const hold = useListHold(listRef, { idle: false });
  const heldAll = useHeldOrder(visible, keyOf, hold, stateOf);
  const known = useRef<Set<string>>(new Set());
  // Held, new rows wait; but a list that has shown nothing yet (a first snapshot, a tree
  // just opened, the very first session) shows what it has at once.
  if (!hold || known.current.size === 0) known.current = new Set(heldAll.map((h) => h.key));
  // A row that leaves the Hidden group (Unhide, or it needs you) takes its place at once.
  const wasHidden = useRef<Set<string>>(new Set());
  for (const h of heldAll) if (wasHidden.current.has(h.key)) known.current.add(h.key);
  // A row the person hid leaves at once, held or not: that was their own hand.
  const held = hold
    ? heldAll.filter(
        (h) =>
          known.current.has(h.key) &&
          !(h.gone && isHidden(hidden, h.key, h.item.stateSince, h.item.state === "needs_you")),
      )
    : heldAll;
  // The Hidden group, under the same filters (lib/hidden.ts), less a row still held in
  // its old place (a prompt answered under the pointer), which joins it when the hold ends.
  const holding = held
    .filter((h) => h.gone)
    .map((h) => h.key)
    .join("\n");
  const hiddenList = useMemo(
    () => hiddenRows(hidden, roots, passes, new Set(holding.split("\n"))),
    [roots, passes, hidden, holding],
  );
  wasHidden.current = new Set(hiddenList.map((s) => s.key));
  useFlip(listRef);

  const groups = useMemo(() => {
    const g = new Map<SessionState, Held<SessionSummary>[]>();
    for (const st of SESSION_STATES) g.set(st, []);
    for (const h of held) g.get(h.group as SessionState)?.push(h);
    return g;
  }, [held]);

  const [showHidden, setShowHiddenState] = useState(hiddenOpen);
  const toggleHidden = useCallback(() => {
    setShowHiddenState((was) => {
      hiddenOpen = !was;
      try {
        localStorage.setItem(HIDDEN_OPEN_KEY, hiddenOpen ? "1" : "0");
      } catch {
        // a private window: it stays as it is for this visit
      }
      return hiddenOpen;
    });
  }, []);
  const hiddenHeld = useMemo(
    () => hiddenList.map((s) => ({ key: s.key, item: s, group: "hidden", gone: false })),
    [hiddenList],
  );

  const ordered = useMemo(() => {
    const list: Held<SessionSummary>[] = [];
    for (const st of SESSION_STATES) if (st !== "done" || showDone) list.push(...groups.get(st)!);
    if (showHidden) list.push(...hiddenHeld);
    return list;
  }, [groups, showDone, showHidden, hiddenHeld]);
  const hrefs = useMemo(() => ordered.map((h) => sessionPath(h.item.harness, h.item.id)), [ordered]);
  const keys = useMemo(() => ordered.map((h) => h.key), [ordered]);

  const filtered = !!(q || machine || harness || label);
  const clear = useCallback(() => {
    setQ("");
    setMachine("");
    setHarness("");
    setLabelFilter("");
  }, []);
  const clearRef = useRef<() => boolean>(() => false);
  clearRef.current = () => {
    if (!filtered) return false;
    clear();
    return true;
  };
  const { cursor, follow } = useListNav(hrefs, true, keys, {
    peek: "board.peek",
    clear: () => clearRef.current(),
    store,
  });
  const cursorKey = ordered[cursor]?.key;
  // ⌥⌘1 … ⌥⌘7 label the row under the cursor, ⌥⌘0 clears it; u marks it read or unread.
  useLabelKeys(() => (cursorKey ? [cursorKey] : []));
  useUnreadKeys(() => (ordered[cursor] ? [ordered[cursor]!.item] : []));
  const marks = useAppState().marks;
  const doneUnread = useMemo(() => groups.get("done")!.filter((h) => isUnread(h.item, marks)).length, [groups, marks]);
  // e hides or unhides it, ⇧E hides it until it needs you; the cursor keeps its place.
  useHideKeys(
    () => ordered[cursor]?.item,
    () => follow(inItsPlace(hrefs, cursor)),
  );
  const hiddenByLens = useMemo(() => ordered.reduce((n, h) => n + cardHides(h.item, lens), 0), [ordered, lens]);

  const view = () => {
    const unread = visible.filter((s) => isUnread(s, store.get().marks));
    const markRead = () => setUnread(store, unread, false);
    return viewItems({ filtered, clear, showDone, setShowDone, beside, lens, simple, counts, unread, markRead });
  };
  const pageMenu = useBackgroundMenu(view, { title: () => "Board" });
  const doneMenu = useContextMenu(() => [
    { label: "Show done sessions", checked: showDone, run: () => setShowDone((v) => !v) },
  ]);
  const hiddenMenu = useContextMenu(() => [{ label: "Show hidden sessions", checked: showHidden, run: toggleHidden }]);

  const doneCount = groups.get("done")!.length;
  const loaded = !!snapshotAt;
  const empty = loaded && all.length === 0 && pending.length === 0;
  // The listening state leaves over 160 ms before the first row comes in.
  const emptyShown = usePresence(empty, EMPTY_EXIT_MS);
  const [witnessed, setWitnessed] = useState(false);
  useEffect(() => {
    if (empty && !firstRowSeen()) setWitnessed(true);
  }, [empty]);
  const firstHint = witnessed && !empty && !emptyShown.mounted && all.length > 0;
  const mac = (useSetupStatus().status?.platform ?? "darwin") === "darwin";
  useEffect(() => {
    if (firstHint) markFirstRow();
  }, [firstHint]);

  const row = (h: Held<SessionSummary>, i: number, hiddenRow?: boolean) => {
    const s = h.item;
    return (
      <SessionCard
        key={h.key}
        s={s}
        children={childrenOf.get(s.key)}
        cursor={s.key === cursorKey ? cursor : undefined}
        lens={lens}
        simple={simple}
        openBeside={beside}
        open={s.key === openKey}
        openTab={s.agents?.length ? openKey : null}
        agentsMatch={!!lq.rest && agentsMatch(s, lq.rest)}
        onlyMachine={setMachine}
        onlyHarness={setHarness}
        gone={h.gone}
        frozenAt={downAt}
        startTitle={started.get(s.key)}
        counts={counts}
        jump={i < 9 ? i + 1 : undefined}
        held={hold}
        hidden={hiddenRow}
      />
    );
  };
  let index = 0;

  const ready = loaded && !emptyShown.mounted;
  // Counts that change after the first paint cross-fade; the first paint just shows them.
  useEffect(() => {
    if (ready) listRef.current?.setAttribute("data-settled", "");
  }, [ready]);
  const noMatch =
    ready && !empty && visible.length === 0 && hiddenList.length === 0 && pending.length === 0 && all.length > 0;

  return (
    <div
      className={`page board${downAt ? " board--down" : ""}`}
      ref={page}
      {...pageMenu}
      data-held={hold ? "" : undefined}
    >
      <PageBar
        title="Board"
        tools={
          // Not before the first snapshot: the filters it decides would push the search
          // over as they arrive (the layout shift the board had on every load).
          !loaded || emptyShown.mounted ? null : (
            <>
              <SearchInput value={q} onChange={setQ} placeholder="Search" label="Search sessions" />
              <LensChip />
              {machines.length > 1 && (
                <ChipSelect
                  value={machine}
                  options={machines}
                  onChange={setMachine}
                  all="All machines"
                  label="Machine"
                />
              )}
              {harnesses.length > 1 && (
                <ChipSelect
                  value={harness}
                  options={harnesses}
                  onChange={setHarness}
                  all="All harnesses"
                  label="Harness"
                  optionLabel={(h) => harnessMark(h).label}
                  icon={(h) => <HarnessGlyph name={h} size="sm" />}
                />
              )}
              <LabelChip value={label} onChange={setLabelFilter} />
              {/* For the chips: a search has its own way out (Esc, the field's ✕, the
                  no-match state's Clear search), and the bar does not shift as one types. */}
              {(machine || harness || label) && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={clear}>
                  Clear
                </button>
              )}
            </>
          )
        }
        actions={
          <>
            <MoreButton build={view} label="View options" title={() => "Board"} />
            <ComposeButton className="compose-btn--phone" />
          </>
        }
      />

      {isMock() && (
        <Notice
          action={
            <a className="btn btn--sm" href="/">
              Leave samples
            </a>
          }
        >
          These are sample sessions, made up in this page.
        </Notice>
      )}
      <LensNote lens={lens} hidden={hiddenByLens} />

      {firstLoad === "loading" ? (
        <div className="skeleton board-skeleton" role="status" aria-label="Loading sessions">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      ) : firstLoad ? (
        <EmptyState
          center
          title={firstLoad === "slow" ? "Still connecting to the receiver…" : "No connection to the receiver"}
          actions={
            <button type="button" className="btn btn--sm" onClick={() => store.reconnect()}>
              Retry now
            </button>
          }
        >
          {firstLoad === "slow"
            ? "Its sessions show up here as soon as the first update arrives."
            : "The board fills in as soon as the stream is back."}
        </EmptyState>
      ) : null}
      {emptyShown.mounted && (
        <div className="board-empty" data-closing={emptyShown.closing ? "" : undefined}>
          <FirstRun paired={paired[0]?.name} />
        </div>
      )}
      {noMatch && (
        <NoMatch
          q={q}
          machine={machine}
          harness={harness}
          label={label ? (label === "none" ? "no label" : labelName(labels, label)) : ""}
          clear={clear}
          clearSearch={() => setQ("")}
        />
      )}

      {/* Always there once loaded, so its place is set before the rows (no shift) and the
          first row of all is a new row to useFlip (its entrance). */}
      <div className="board-list" ref={listRef} hidden={!ready || noMatch || undefined}>
        {ready && <OfflineLine machine={machine} hold={hold} />}
        {ready &&
          SESSION_STATES.filter((st) => st !== "done").map((st) => {
            const list = groups.get(st)!;
            const starting = st === "working" ? pending : [];
            if (list.length === 0 && starting.length === 0) return null;
            const n = list.length + starting.length;
            return (
              <section key={st} className={`group group--${st}`} aria-label={`${n} ${STATE_HEADING[st](n)}`}>
                <h2 className="group-head" title={STATE_HINT[st]}>
                  {STATE_HEADING[st](n)}
                  <span key={n} className="group-count num">
                    {n}
                  </span>
                </h2>
                <div className="grid">
                  {starting.map((a) => (
                    <StartingCard key={a.id} a={a} machine={paired.find((m) => m.control?.machineId === a.machineId)} />
                  ))}
                  {list.map((h) => row(h, index++))}
                </div>
                {firstHint && st === SESSION_STATES.find((x) => x !== "done" && groups.get(x)!.length > 0) && (
                  <p className="board-first">
                    <span>
                      This came from your terminal. Pair this {mac ? "Mac" : "machine"} to answer it from your phone.
                    </span>
                    <button type="button" className="btn btn--sm" onClick={() => navigate("/phone")}>
                      Pair
                    </button>
                  </p>
                )}
              </section>
            );
          })}

        {ready && doneCount > 0 && (
          <section className="group group--done" aria-label={`${doneCount} done`}>
            <h2 className="group-head" {...doneMenu}>
              <button
                type="button"
                className="group-toggle"
                onClick={() => setShowDone((v) => !v)}
                aria-expanded={showDone}
                title={STATE_HINT.done}
              >
                Done
                <span key={doneCount} className="group-count num">
                  {doneCount}
                </span>
                {!showDone && doneUnread > 0 && (
                  <>
                    {" "}
                    <span className="group-note num">{doneUnread} unread</span>
                  </>
                )}
                <svg className="group-caret" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
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
            </h2>
            {showDone && <div className="grid grid--done">{groups.get("done")!.map((h) => row(h, index++))}</div>}
          </section>
        )}

        {/* What this device hid, under the same filters: folded, the fold is the switch. */}
        {ready && hiddenHeld.length > 0 && (
          <section className="group group--hidden" aria-label={`${hiddenHeld.length} hidden`}>
            <h2 className="group-head" {...hiddenMenu}>
              <button type="button" className="group-toggle" onClick={toggleHidden} aria-expanded={showHidden}>
                Hidden
                <span key={hiddenHeld.length} className="group-count num">
                  {hiddenHeld.length}
                </span>
                <svg className="group-caret" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
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
            </h2>
            {showHidden && <div className="grid grid--hidden">{hiddenHeld.map((h) => row(h, index++, true))}</div>}
          </section>
        )}
      </div>
    </div>
  );
}

/** e hides the session `row()` names (the row under a list's cursor) or unhides it, ⇧E
 *  hides it until it needs you; a key with nothing to hide passes. `leave()` runs first,
 *  so the cursor can stay where the row was. */
function useHideKeys(row: () => SessionSummary | undefined, leave: () => void): void {
  // Not from inside the panel beside the board (the list's own menu and ⌘1–9 keep the
  // same rule): e there would hide whatever row the cursor last rested on.
  useShortcut("list.hide", () => {
    const s = row();
    if (!s || inPanel()) return false;
    leave();
    if (hiddenNow(s)) unhide(s.key);
    else hide(s.key, s.stateSince, { title: sessionTitle(s), session: s.key });
  });
  useShortcut("list.hideUntil", () => {
    const s = row();
    if (!s || inPanel() || hiddenNow(s) || !canHideUntilNeeded(s)) return false;
    leave();
    hideUntilNeeded(s.key, { title: sessionTitle(s), session: s.key });
  });
}

const keyOf = (s: SessionSummary) => s.key;
const stateOf = (s: SessionSummary) => s.state;

/** Nothing passes the filter: say what was asked, and the one way back. */
function NoMatch({
  q,
  machine,
  harness,
  label,
  clear,
  clearSearch,
}: {
  q: string;
  machine: string;
  harness: string;
  label: string;
  clear: () => void;
  clearSearch: () => void;
}) {
  const where = [
    harness && `${harnessMark(harness).label} `,
    "sessions",
    machine && ` on ${machine}`,
    label && ` with ${label === "no label" ? "no label" : `the ${label} label`}`,
  ]
    .filter(Boolean)
    .join("");
  const only = !!q && !machine && !harness && !label;
  return (
    <EmptyState
      center
      className="board-nomatch"
      title={q ? `No ${only ? "sessions" : where} match “${q}”` : `No ${where}`}
      actions={
        only ? (
          <>
            {/* The board filters what it holds; Search reads every session, prompts included. */}
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => navigate(`/search?q=${encodeURIComponent(q.trim())}`)}
            >
              Search every session for “{q.trim()}”
            </button>
            <button type="button" className="btn" onClick={clearSearch}>
              Clear search
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={clear}>
            Clear filters
          </button>
        )
      }
    >
      {only
        ? "This box filters the board by title, folder, machine and the latest reply. Search reads every session, what you sent included."
        : "Other sessions are hidden by the filter."}
    </EmptyState>
  );
}

/** The first run, as a listening state at the content's optical centre: what to do (one
 *  line naming this machine and the agents whose hooks are on), the command, and the
 *  live wait itself. When nothing is hooked yet, the install command instead. */
function FirstRun({ paired }: { paired?: string }) {
  const setup = useSetupStatus();
  const st = setup.status;
  const hooked = (st?.harnesses ?? []).filter((h) => h.installed && h.hooks === "on").map((h) => shortName(h.label));
  const here = st?.daemon.name ?? st?.tls.hostname?.replace(/\.local\.?$/, "");
  const sp = st?.sessionpipe.installed;
  const names = hooked.length ? hooked : ["Claude Code", "Codex", "Gemini", "Antigravity"];
  const samples = () => {
    location.assign("/?mock=1");
  };
  return (
    <EmptyState
      center
      title="Waiting for your first session"
      actions={
        <>
          {paired ? (
            <button type="button" className="btn" onClick={() => openNewSession({ machine: paired })}>
              Start a session on {paired}
            </button>
          ) : (
            <Link to="/connect" className="btn">
              Pair another machine
            </Link>
          )}
          <button type="button" className="btn btn--ghost" onClick={samples}>
            See it with sample sessions
          </button>
        </>
      }
    >
      {st && sp === false ? (
        <>
          <p>Install sessionpipe's hooks on this machine, then start an agent in any terminal.</p>
          <CommandWell command="npx sessionpipe install" />
        </>
      ) : (
        <>
          <p>
            Start {either(names)} in any terminal on {here ? <strong>{here}</strong> : "this machine"} and it appears
            here.
          </p>
          <CommandWell command="claude" />
        </>
      )}
      <Listening>{(hooked.length ? hooked : names).join(", ")}</Listening>
    </EmptyState>
  );
}

/** "Gemini CLI" reads as "Gemini" in a sentence. */
const shortName = (label: string) => label.replace(/ CLI$/, "");

/** A start on its way: the board's row grammar, from the signed start alone (its first
 *  line, the machine, the folder), "starting" where a session's state would be. */
function StartingCard({
  a,
  machine,
}: {
  a: ControlActivity;
  machine: { name: string; control?: { online: boolean; tilde?: boolean } } | undefined;
}) {
  const { harness, id } = splitKey(a.session!);
  const title = (a.text ?? "").split("\n")[0]!.trim().slice(0, 120) || "New session";
  const name = machine?.name ?? "the machine";
  const line =
    a.outcome === "taken" || a.outcome === "progress"
      ? `Starting on ${name}`
      : machine?.control?.online
        ? `Sent to ${name}`
        : `Waiting for ${name}`;
  return (
    <article className="card card--working card--starting" data-starting={a.session}>
      <div className="card-row">
        <Link to={sessionPath(harness, id)} className="card-link" title={title} data-nav-item="">
          <h3 className="card-title ellipsis">{title}</h3>
          <span className="card-status">
            <span className="card-state">
              <StateDot state="working" decorative />
              <span className="sr-only">starting</span>
            </span>
            <span className="card-kind">starting</span>
            <span className="card-time">
              <Since iso={a.at} coarse />
            </span>
          </span>
          <span className="card-line">
            <span className="card-text">{a.reply ? a.reply.split("\n").pop() : line}</span>
          </span>
          <span className="card-meta">
            <HarnessGlyph name={harness} size="sm" />
            <span className="card-where ellipsis">
              {name}
              {a.cwd ? ` · ${tildify(a.cwd, machineHome(machine?.control))}` : ""}
            </span>
          </span>
          <span className="card-foot num" aria-hidden="true">
            <span />
          </span>
        </Link>
        <BesideButton onClick={() => openSplit(a.session!)} />
      </div>
    </article>
  );
}
