// SPDX-License-Identifier: Apache-2.0
// The feed: every event as it arrives, newest first, like `sessionpipe tail`, laid out as
// a log the way Console.app lays one out: time, session, what happened, detail, under
// sticky day headers. What happened is said in words ("Tool finished", "Changed files");
// the raw type is the hover and "Copy event". Consecutive events of one session sit under
// its title once, as Mail threads a conversation. Pages from GET /api/ui/events; live
// rows prepend from the stream, but never under the hand (POLISH-PLAN.md §6 #1): while
// the pointer is on the list, the keyboard cursor is in it, a row's menu is up, or the
// list is scrolled away from its newest rows, they wait behind an "n new" pill and land
// in one step when the hold lets go. Pause holds them until Resume. One Filter menu
// narrows by harness, machine, kind and session. A row's right-click opens its session,
// narrows the feed to it, or copies it.
import type { FeedQuery, StoredEvent } from "@shared/api";
import { memo, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { EmptyState, HarnessGlyph, SearchInput } from "../components/bits";
import { type MenuItem, type MenuList, openMenu, useContextMenu, useMenuOpen } from "../components/ContextMenu";
import { LabelChip, LabelDot, useLabelKeys } from "../components/LabelDot";
import { LensChip, LensNote } from "../components/LensChip";
import { PageBar } from "../components/PageBar";
import { BesideButton, Inline, lensMenu, useBackgroundMenu, useStickyTop } from "../components/SessionCard";
import { useAppState, useLabels, useStore } from "../data/hooks";
import { eventSummary, harnessMark, oneLine, sessionTitle, storedKey, toolLabel } from "../lib/format";
import { useListNav } from "../lib/keys";
import { type LabelFilter, labelPasses, labelQuery } from "../lib/labels";
import { absoluteUrl, copyItem } from "../lib/menus";
import { reducedMotion, tokenMs, useListHold } from "../lib/motion";
import { Link, navigate, sessionPath } from "../lib/router";
import { useAppSettings, useLens } from "../lib/settings";
import { useShortcut } from "../lib/shortcuts";
import { openSplit } from "../lib/split";
import { atTier } from "../lib/tier";
import { clock, dayLabel, durShort, useToday } from "../lib/time";
import { eventWords as turnWords } from "../lib/turns";

const CAP = 1500;
const TYPES = ["session", "turn", "tool", "files", "attention", "subagent", "context"];
/** The kinds as the Filter menu names them. */
const TYPE_WORDS: Record<string, string> = {
  session: "Sessions starting and ending",
  turn: "Turns and replies",
  tool: "Tools",
  files: "File changes",
  attention: "Prompts",
  subagent: "Subagents",
  context: "Compactions",
};

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** The detail beside the words, without saying the kind again: "Bash · git push", not
 *  "permission · Bash · git push"; "From the terminal", not "source=startup"; "Edit ·
 *  0.4 s", not "Edit ok 0.4 s"; the reply's text, not "turn 3 · …". A tool reads as a
 *  person names it ("github · search_issues"). A subagent's own event leaves its kind to
 *  the row's "↳ Explore". Everything else is the shared summary (lib/format.ts). */
export function feedSummary(e: StoredEvent): string {
  const d = e.data ?? {};
  const took = typeof d.ms === "number" && Number.isFinite(d.ms) ? durShort(d.ms) : "";
  switch (e.type) {
    case "session.started": {
      const src = str(d.source);
      return src === "startup"
        ? "New conversation"
        : src === "resume"
          ? "Resumed"
          : src && src !== "unknown"
            ? cap(src)
            : "";
    }
    case "session.ended":
      return str(d.reason) && str(d.reason) !== "other" ? cap(str(d.reason).replace(/_/g, " ")) : "";
    case "attention.needed":
      return [d.tool ? toolLabel(str(d.tool)) : "", oneLine(str(d.message), 100)].filter(Boolean).join(" · ");
    case "attention.cleared": {
      const how = str(d.how);
      return how && how !== "unknown" && how !== "answered" ? cap(how.replace(/_/g, " ")) : "";
    }
    case "session.heartbeat":
    case "limits.observed":
      return "";
    case "turn.started":
      return d.prompt_chars !== undefined ? `${str(d.prompt_chars)} characters` : "";
    case "turn.ended": {
      // How long the turn took; why it stopped only when that is news.
      const why = str(d.reason);
      const said = why && !["stop", "end_turn", "other", "error"].includes(why) ? cap(why.replace(/_/g, " ")) : "";
      return [said, took, d.error ? oneLine(str(d.error), 80) : ""].filter(Boolean).join(" · ");
    }
    case "turn.transcript":
    case "turn.progress":
      return oneLine(str(d.assistant), 160);
    case "tool.started":
      return toolLabel(str(d.tool));
    case "tool.ended":
      return [toolLabel(str(d.tool)), took, d.ok === false && d.error ? oneLine(str(d.error), 80) : ""]
        .filter(Boolean)
        .join(" · ");
    case "subagent.started":
    case "subagent.ended":
      // The row names an agent of its own after the session ("↳ Explore").
      return d.agent_id ? "" : str(d.agent_type);
    case "context.compacted":
      return str(d.trigger) === "manual" ? "Manual" : "Automatic";
    case "delegation.started":
    case "delegation.ended":
      // The ask's state ("running", "answered in 2 m 05 s · answer relayed here"); the kind
      // column names the agent.
      return turnWords(e).detail ?? "";
    default:
      return eventSummary(e);
  }
}
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** What happened, in words: the row's type column. The raw type stays its tooltip. */
export function eventWords(e: StoredEvent): string {
  const d = e.data ?? {};
  switch (e.type) {
    case "session.started":
      return "Session started";
    case "session.ended":
      return "Session ended";
    case "session.backfill":
      return "Backfilled";
    case "session.forgotten":
      return "Forgotten";
    case "session.heartbeat":
      return "Still running";
    case "limits.observed":
      return "Usage limits";
    case "turn.started":
      return "Prompt";
    case "turn.ended":
      return d.reason === "error" ? "Turn failed" : "Turn ended";
    case "turn.transcript":
      return "Reply";
    case "turn.progress":
      return "Writing";
    case "tool.started":
      return "Tool started";
    case "tool.ended":
      return d.ok === false ? "Tool failed" : "Tool finished";
    case "files.changed":
      return "Changed files";
    case "attention.needed":
      return d.kind === "permission" ? "Asks permission" : d.kind === "question" ? "Asks a question" : "Needs you";
    case "attention.cleared":
      return "Answered";
    case "subagent.started":
      return "Subagent started";
    case "subagent.ended":
      return "Subagent ended";
    case "context.compacted":
      return "Compacted";
    case "native":
      return "Native hook";
    case "delegation.started":
    case "delegation.ended":
      // "Asked Codex" / "You asked Codex"; the ask's state is the detail (feedSummary).
      return turnWords(e).text;
    default:
      return e.type;
  }
}

/** Rows are newest first by event time (a backfilled event lands under its own day, not
 *  under today), so a live event goes where its time says, not on top. */
const insertByTime = (rows: StoredEvent[], e: StoredEvent): StoredEvent[] => {
  let i = 0;
  while (i < rows.length && rows[i]!.time > e.time) i++;
  return [...rows.slice(0, i), e, ...rows.slice(i)];
};

const applyFilter = (e: StoredEvent, f: FeedQuery) =>
  (!f.harness || e.harness.name === f.harness) &&
  (!f.machine || e.session.machine === f.machine) &&
  (!f.type || e.type === f.type || e.type.startsWith(`${f.type}.`)) &&
  (!f.session || storedKey(e) === f.session) &&
  (!f.q || JSON.stringify(e).toLowerCase().includes(f.q.toLowerCase()));

/** An event that is an error: a failed tool, a turn that ended in one, an error prompt.
 *  Its type is the one thing in the feed drawn in red. */
const isError = (e: StoredEvent): boolean =>
  (e.type === "tool.ended" && e.data.ok === false) ||
  (e.type === "turn.ended" && e.data.reason === "error") ||
  (e.type === "attention.needed" && e.data.kind === "error");

/** The subagent an event is one of, if any. */
const agentOf = (e: StoredEvent): string | undefined =>
  typeof e.data.agent_id === "string" ? e.data.agent_id : undefined;

const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const desktop = () => typeof matchMedia === "function" && matchMedia("(min-width: 840px)").matches;

/** What a row's menu needs from the page, read when the menu opens. */
interface FeedMenuContext {
  paused: boolean;
  togglePause: () => void;
  setSession: (k: string) => void;
  setMachine: (m: string) => void;
  setHarness: (h: string) => void;
  setType: (t: string) => void;
}

export function Feed() {
  const store = useStore();
  const { sessions } = useAppState();
  const [harness, setHarness] = useState("");
  const [machine, setMachine] = useState("");
  const [type, setType] = useState("");
  const [session, setSession] = useState("");
  const [q, setQ] = useState("");
  const [label, setLabelFilter] = useState<LabelFilter>("");
  const labels = useLabels();
  // `label:` tokens filter here, on the page; the rest of the words go to the server.
  const lq = useMemo(() => labelQuery(labels, q), [labels, q]);
  const [loaded, setRows] = useState<StoredEvent[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  /** The filter the rows on screen were loaded for; until the fetch for the current
   *  filter lands, the list is busy and stale rows are hidden by the client-side filter. */
  const [loadedFor, setLoadedFor] = useState<FeedQuery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const pending = useRef<StoredEvent[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const filter = useMemo<FeedQuery>(
    () => ({ harness, machine, type, session, q: lq.rest }),
    [harness, machine, type, session, lq.rest],
  );
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const page = useRef<HTMLDivElement>(null);
  useStickyTop(page);

  const harnesses = useMemo(() => [...new Set([...sessions.values()].map((s) => s.harness))].sort(), [sessions]);
  const machines = useMemo(
    () => [...new Set([...sessions.values()].map((s) => s.machine).filter((m): m is string => !!m))].sort(),
    [sessions],
  );
  const sessionOptions = useMemo(() => [...sessions.values()].filter((s) => !s.parentId).map((s) => s.key), [sessions]);
  const sessionLabel = (key: string) => {
    const s = sessions.get(key);
    return s ? sessionTitle(s) : key;
  };

  // (Re)load the first page whenever the filter changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    pending.current = [];
    setPendingCount(0);
    const t = setTimeout(() => {
      store.transport
        .feed({ ...filter, limit: 150 })
        .then((p) => {
          if (cancelled) return;
          setRows(p.events);
          setCursor(p.cursor);
          setLoadedFor(filter);
        })
        .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
        .finally(() => !cancelled && setLoading(false));
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [store, filter]);

  // Held still under the hand, or while the newest rows are scrolled out of view: new
  // rows wait (the same queue Pause fills) and land together when the hold lets go.
  const listRef = useRef<HTMLOListElement>(null);
  const hold = useListHold(listRef);
  const away = useScrolledAway(listRef);
  const queueing = paused || hold || away;
  const queueingRef = useRef(queueing);
  queueingRef.current = queueing;

  // Live rows.
  useEffect(
    () =>
      store.onEvent((e) => {
        if (!applyFilter(e, filterRef.current)) return;
        if (queueingRef.current) {
          pending.current.unshift(e);
          if (pending.current.length > CAP) pending.current.length = CAP;
          setPendingCount(pending.current.length);
          return;
        }
        arrived.add(e);
        setRows((prev) => (prev.some((p) => p.id === e.id) ? prev : insertByTime(prev, e).slice(0, CAP)));
      }),
    [store],
  );

  /** The waiting rows land, in one step. */
  const flush = useCallback(() => {
    const p = pending.current;
    if (!p.length) return;
    pending.current = [];
    setPendingCount(0);
    for (const e of p) arrived.add(e);
    setRows((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      return p
        .filter((e) => !seen.has(e.id))
        .reduce(insertByTime, prev)
        .slice(0, CAP);
    });
  }, []);
  // The hold let go (and the feed is not paused): what waited lands.
  useEffect(() => {
    if (!queueing) flush();
  }, [queueing, flush]);
  const resume = useCallback(() => {
    flush();
    setPaused(false);
  }, [flush]);
  const togglePause = useCallback(() => (paused ? resume() : setPaused(true)), [paused, resume]);
  const showNew = () => {
    resume();
    window.scrollTo({ top: 0 });
  };

  const older = useCallback(() => {
    if (!cursor) return;
    setLoading(true);
    store.transport
      .feed({ ...filter, before: cursor, limit: 150 })
      .then((p) => {
        setRows((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...prev, ...p.events.filter((e) => !seen.has(e.id))].slice(0, CAP);
        });
        setCursor(p.cursor);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [store, filter, cursor]);

  // The tier lens: rows a receiver at that tier would not have got leave; the rest lose
  // the fields it would not carry (lib/tier.ts).
  const lens = useLens();
  const { openSessions, mode } = useAppSettings();
  const beside = openSessions === "beside";
  const rows = useMemo(
    () => (lens === null ? loaded : loaded.map((e) => atTier(e, lens)).filter((e): e is StoredEvent => e !== null)),
    [loaded, lens],
  );
  const hiddenByLens = loaded.length - rows.length;
  // Belt and braces: never show a row the current filter would not have loaded, even
  // for the frame between a filter change and its fetch.
  const shown = useMemo(
    () =>
      rows.filter((e) => applyFilter(e, filter) && labelPasses(labels, storedKey(e), label) && lq.test(storedKey(e))),
    [rows, filter, labels, label, lq],
  );
  const busy = loading || loadedFor !== filter;
  const hrefs = useMemo(() => shown.map((e) => sessionPath(e.harness.name, e.session.id)), [shown]);
  const keys = useMemo(() => shown.map(storedKey), [shown]);
  const clearRef = useRef<() => boolean>(() => false);
  // The rows' list-cursor numbers, written after a commit that changed the rows instead of
  // rendered (a live row landing on top would otherwise renumber, and so re-render, every
  // row under it); and the rows on screen glide down to make room for the ones that landed.
  useGlide(listRef, shown);
  const { cursor: cur } = useListNav(hrefs, true, keys, { clear: () => clearRef.current(), store });
  // ⌥⌘1 … ⌥⌘7 label the session of the row under the cursor, ⌥⌘0 clears it.
  useLabelKeys(() => (keys[cur] ? [keys[cur]!] : []));
  useShortcut("feed.pause", () => togglePause());
  useShortcut("feed.new", () => {
    if (!paused) return false;
    showNew();
  });
  // A row's day label changes at midnight, not every second (the page has 1500 rows).
  const now = useToday();

  const filtered = !!(harness || machine || type || session || q || label);
  const narrowed = !!(harness || machine || type || session);
  const clearFilters = () => {
    setLabelFilter("");
    setHarness("");
    setMachine("");
    setType("");
    setSession("");
    setQ("");
  };
  clearRef.current = () => {
    if (!filtered) return false;
    clearFilters();
    return true;
  };
  const ctx = useRef<FeedMenuContext>({ paused, togglePause, setSession, setMachine, setHarness, setType });
  ctx.current = { paused, togglePause, setSession, setMachine, setHarness, setType };
  const bgMenu = useBackgroundMenu(
    () => [
      { label: paused ? "Resume" : "Pause the feed", action: "feed.pause", run: togglePause },
      paused && pendingCount > 0 && { label: `Show ${pendingCount} new`, action: "feed.new", run: showNew },
      filtered && { label: "Clear filters", run: clearFilters },
      { sep: true },
      ...lensMenu(lens, mode === "simple"),
    ],
    { title: () => "Feed" },
  );

  let lastDay = "";
  return (
    <div className="page feed" ref={page} {...bgMenu}>
      <PageBar
        title="Feed"
        tools={
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Search" label="Search events" />
            <FilterMenu
              on={narrowed}
              summary={[
                harness && harnessMark(harness).label,
                machine,
                type && TYPE_WORDS[type],
                session && sessionLabel(session),
              ]
                .filter(Boolean)
                .join(" · ")}
              build={() => [
                { heading: "Harness" },
                ...pick("All harnesses", harness, harnesses, setHarness, (h) => harnessMark(h).label),
                { sep: true },
                { heading: "Machine" },
                ...pick("All machines", machine, machines, setMachine),
                { sep: true },
                { heading: "What happened" },
                ...pick("Everything", type, TYPES, setType, (t) => TYPE_WORDS[t] ?? t),
                { sep: true },
                {
                  label: session ? `Session: ${sessionLabel(session)}` : "Session",
                  items: pick("All sessions", session, sessionOptions, setSession, sessionLabel),
                },
                narrowed && { sep: true },
                narrowed && {
                  label: "Clear filters",
                  run: () => {
                    setHarness("");
                    setMachine("");
                    setType("");
                    setSession("");
                  },
                },
              ]}
            />
            <LabelChip value={label} onChange={setLabelFilter} />
            <LensChip />
          </>
        }
        actions={
          <button
            type="button"
            className={`btn btn--sm feed-pause ${paused ? "btn--on" : "btn--ghost"}`}
            aria-pressed={paused}
            onClick={togglePause}
            title={paused ? "Resume the feed (space)" : "Pause the feed (space)"}
          >
            {paused ? "Resume" : "Pause"}
            {paused && pendingCount > 0 && <span className="pill-new num">{pendingCount} new</span>}
          </button>
        }
      />

      {error && <p className="page-note is-err">{error}</p>}
      <LensNote lens={lens} hidden={hiddenByLens} />

      {/* Rows waiting while the list holds: a pill over the list (it takes no room, so
          its coming and going moves nothing), the way back to the top. Not while paused:
          the Pause button counts those. */}
      <div className="feed-news-anchor" aria-live="polite">
        {!paused && pendingCount > 0 && (
          <button type="button" className="feed-news" onClick={showNew}>
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path
                d="M6 9.5v-7M3 5.5l3-3 3 3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="num">{pendingCount > 99 ? "99+" : pendingCount}</span> new
          </button>
        )}
      </div>
      <ol className="rows" aria-busy={busy} ref={listRef} data-held={queueing ? "" : undefined}>
        {shown.map((e, i) => {
          const day = dayLabel(e.time, now);
          const showDay = day !== lastDay;
          lastDay = day;
          // The same session (and the same subagent of it) as the row above, on the same
          // day: under its title, once.
          const prev = shown[i - 1];
          const more = !showDay && !!prev && storedKey(prev) === storedKey(e) && agentOf(prev) === agentOf(e);
          const s = sessions.get(storedKey(e));
          // A subagent's event: its type after the session's name ("billing ↳ Explore").
          const agentId = agentOf(e);
          const agent = agentId
            ? (s?.agents?.find((a) => a.id === agentId)?.type ??
              (typeof e.data.agent_type === "string" ? e.data.agent_type : "Subagent"))
            : undefined;
          return (
            <FeedRow
              key={e.id}
              e={e}
              current={i === cur}
              day={showDay ? sentence(day) : undefined}
              title={s ? sessionTitle(s) : (e.session.title ?? e.session.id.slice(0, 8))}
              agent={agent}
              beside={beside}
              ctx={ctx}
              more={more}
            />
          );
        })}
      </ol>
      {busy && shown.length === 0 ? (
        <div className="skeleton feed-skeleton" role="status" aria-label="Loading events">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      ) : loading ? (
        <p className="page-note feed-more">Loading…</p>
      ) : null}
      {!busy && shown.length === 0 && (
        <EmptyState
          center
          title={filtered ? (q ? `No events match “${q}”` : "No events match the filter") : "No events yet"}
          actions={
            filtered && (
              <button type="button" className="btn" onClick={clearFilters}>
                {q && !narrowed && !label ? "Clear search" : "Clear filters"}
              </button>
            )
          }
        >
          {filtered ? "Other events are hidden by the filter." : "Events stream here as agents work."}
        </EmptyState>
      )}
      {!loading && cursor && (
        <button type="button" className="btn btn--ghost feed-more" onClick={older}>
          Older events
        </button>
      )}
      {rows.length >= CAP && <p className="page-note">Showing the newest {CAP}; narrow the filter for more.</p>}
    </div>
  );
}

/** Radio items for one filter: "All …", then each option, the current one checked. */
function pick(
  all: string,
  value: string,
  options: string[],
  set: (v: string) => void,
  name: (o: string) => string = (o) => o,
): MenuItem[] {
  return [
    { label: all, radio: true, checked: !value, run: () => set("") },
    ...options.map((o) => ({ label: name(o), radio: true, checked: value === o, run: () => set(o) })),
  ];
}

/** One Filter pop-up in place of five: a menu with a section per filter. While any is
 *  set it reads what it narrows to and takes the selected fill, like the chips do. */
function FilterMenu({ on, summary, build }: { on: boolean; summary: string; build: () => MenuList }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const up = useMenuOpen();
  useEffect(() => {
    if (!up) setOpen(false);
  }, [up]);
  const show = (keyboard: boolean) => {
    if (!btn.current) return;
    openMenu(build(), btn.current, { source: keyboard ? "keyboard" : "mouse", invoker: btn.current, title: "Filter" });
    setOpen(true);
  };
  return (
    <button
      ref={btn}
      type="button"
      className={`feed-filter ${on ? "feed-filter--on" : ""}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={on ? `Filter: ${summary}` : "Filter"}
      title={on ? summary : "Filter by harness, machine, kind or session"}
      onClick={(e) => show(e.detail === 0)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown") return;
        e.preventDefault();
        show(true);
      }}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className="feed-filter-text">{on ? summary : "Filter"}</span>
    </button>
  );
}

/** Rows that came in live (not with a page load), for their entrance. */
const arrived = new WeakSet<StoredEvent>();

/** The vertical translate a row is drawn with right now (a glide still playing). */
function drawnY(el: HTMLElement): number {
  const m = getComputedStyle(el).transform.match(/^matrix(3d)?\((.+)\)$/);
  if (!m) return 0;
  const v = m[2]!.split(",").map(Number);
  return (m[1] ? v[13] : v[5]) ?? 0;
}

/** After a commit that changed the rows: numbers them for the list cursor, and lets the
 *  rows on screen glide from where they were to where the landed rows pushed them (a
 *  translate over --dur, compositor only) instead of jumping. Only the rows in the
 *  viewport are measured, so a 1500-row log costs what a screenful does. Positions are
 *  the list's own, so a scroll is not a move; off under reduced motion. */
function useGlide(ref: RefObject<HTMLOListElement | null>, rows: readonly StoredEvent[]): void {
  const last = useRef<readonly StoredEvent[] | null>(null);
  const tops = useRef(new Map<string, number>());
  const playing = useRef(new WeakMap<HTMLElement, Animation>());
  useLayoutEffect(() => {
    const ol = ref.current;
    if (!ol || last.current === rows) return;
    last.current = rows;
    let i = 0;
    for (const li of ol.children) {
      if (!(li instanceof HTMLElement) || !li.classList.contains("ev")) continue;
      const n = String(i++);
      if (li.dataset.cursor !== n) li.dataset.cursor = n;
    }
    const base = ol.getBoundingClientRect().top;
    const vh = window.innerHeight;
    const motion = !reducedMotion() && typeof Element.prototype.animate === "function";
    const before = tops.current;
    const now = new Map<string, number>();
    const dur = tokenMs("--dur", 200);
    for (const li of ol.children) {
      if (!(li instanceof HTMLElement) || !li.dataset.ev) continue;
      const r = li.getBoundingClientRect();
      if (r.top > vh) break;
      if (r.bottom < 0) continue;
      const a = playing.current.get(li);
      const drawn = a && a.playState === "running" ? drawnY(li) : 0;
      const y = r.top - base - drawn;
      now.set(li.dataset.ev, y);
      const was = before.get(li.dataset.ev);
      if (!motion || was === undefined || Math.abs(was - y) < 0.5) continue;
      a?.cancel();
      playing.current.set(
        li,
        li.animate([{ transform: `translateY(${was + drawn - y}px)` }, { transform: "none" }], {
          duration: dur,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        }),
      );
    }
    tops.current = now;
  });
}

/** Whether the list's newest rows are scrolled up under the page bar: new rows then wait,
 *  so what is being read does not move. Changes state only when it crosses. */
function useScrolledAway(ref: RefObject<HTMLElement | null>): boolean {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const page = el.closest<HTMLElement>(".page");
      const top = Number.parseFloat(page ? getComputedStyle(page).getPropertyValue("--sticky-top") : "") || 48;
      // The day header sticks over the first 28 px: away once the first row is under it.
      setAway(el.getBoundingClientRect().top < top - 24);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", on, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", on);
    };
  }, [ref]);
  return away;
}

const FeedRow = memo(function FeedRow({
  e,
  current,
  day,
  title,
  agent,
  beside,
  ctx,
  more = false,
}: {
  /** The row above is the same session's: its title is not said again. */
  more?: boolean;
  e: StoredEvent;
  current: boolean;
  day?: string;
  title: string;
  /** The subagent's type, when the event is one of its own. */
  agent?: string;
  beside: boolean;
  ctx: { current: FeedMenuContext };
}) {
  const key = storedKey(e);
  const path = sessionPath(e.harness.name, e.session.id);
  const kind = e.type.split(".")[0]!;
  const li = useRef<HTMLLIElement>(null);
  const rect = () => li.current?.getBoundingClientRect();
  const menu = useContextMenu(
    (): MenuList => {
      const c = ctx.current;
      const wide = desktop();
      const openPage = { label: "Open as page", action: beside ? undefined : "list.open", run: () => navigate(path) };
      const openBeside = {
        label: wide ? "Open beside" : "Preview",
        action: beside ? "list.open" : "list.beside",
        run: () => openSplit(key, { from: rect() }),
      };
      return [
        ...(beside ? [openBeside, openPage] : [openPage, openBeside]),
        wide && {
          label: "Open in background tab",
          action: "list.background",
          run: () => openSplit(key, { background: true }),
        },
        wide && { label: "Open in new window", run: () => void window.open(absoluteUrl(path), "_blank", "noopener") },
        { sep: true },
        { label: "Show only this session", run: () => c.setSession(key) },
        e.session.machine && { label: `Show only ${e.session.machine}`, run: () => c.setMachine(e.session.machine!) },
        { label: `Show only ${harnessMark(e.harness.name).label}`, run: () => c.setHarness(e.harness.name) },
        TYPES.includes(kind) && { label: `Show only ${kind} events`, run: () => c.setType(kind) },
        { sep: true },
        {
          label: "Copy",
          items: [
            copyItem("Event as JSON", JSON.stringify(e, null, 2)),
            copyItem("Summary", `${e.type} ${eventSummary(e)}`.trim()),
            copyItem("Event type", e.type),
            copyItem("Time (ISO)", e.time),
            copyItem("Session ID", e.session.id),
          ],
        },
        { sep: true },
        { label: c.paused ? "Resume" : "Pause the feed", action: "feed.pause", run: c.togglePause },
      ];
    },
    { title: () => title, subtitle: () => [eventWords(e), clock(e.time)].join(" · ") },
  );
  const words = eventWords(e);
  return (
    <>
      {day && <li className="ev-day">{day}</li>}
      <li
        ref={li}
        className={`ev ev--${kind}${more ? " ev--more" : ""}`}
        data-ev={e.id}
        data-type={e.type}
        data-arrive={arrived.has(e) ? "" : undefined}
        aria-current={current ? "true" : undefined}
        {...menu}
      >
        <span className="ev-time num" title={`${new Date(e.time).toLocaleString()} · tier ${e.tier} · ${e.source}`}>
          {clock(e.time)}
        </span>
        <HarnessGlyph name={e.harness.name} size="sm" />
        <Link
          to={path}
          className="ev-session ellipsis"
          data-nav-item=""
          title={`${title} · ${e.session.id}`}
          plainClick={beside ? () => openSplit(key, { from: rect() }) : undefined}
          modClick={(o) => openSplit(key, { from: rect(), background: o.background })}
        >
          <LabelDot session={key} />
          <span className="ev-title ellipsis">{title}</span>
          {agent && <span className="ev-agent"> ↳ {agent}</span>}
        </Link>
        {e.session.machine && <span className="ev-machine ellipsis">{e.session.machine}</span>}
        <span className={`ev-type ev-type--${kind}`} title={e.type}>
          {isError(e) && (
            <svg className="ev-err" viewBox="0 0 12 12" width="10" height="10" role="img" aria-label="error">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          )}
          {words}
        </span>
        <span className="ev-sum ellipsis">
          <Inline text={feedSummary(e)} />
        </span>
        <BesideButton className="ev-beside" onClick={() => openSplit(key, { from: rect() })} />
      </li>
    </>
  );
});
