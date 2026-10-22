// SPDX-License-Identifier: Apache-2.0
// The feed: every event as it arrives, newest first, like `sessionpipe tail`, laid out as
// a log the way Console.app lays one out: time, session, type, detail, under sticky day
// headers. Pages from GET /api/ui/events; live rows prepend from the stream unless
// paused. A row's right-click opens its session, narrows the feed to it, or copies it.
import type { FeedQuery, StoredEvent } from "@shared/api";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChipSelect, HarnessGlyph, Redacted, SearchInput } from "../components/bits";
import { type MenuList, useContextMenu } from "../components/ContextMenu";
import { LabelChip, LabelDot, useLabelKeys } from "../components/LabelDot";
import { LensChip, LensNote } from "../components/LensChip";
import { PageBar } from "../components/PageBar";
import { BesideButton, lensMenu, useBackgroundMenu, useStickyTop } from "../components/SessionCard";
import { useAppState, useLabels, useStore } from "../data/hooks";
import { eventSummary, harnessMark, sessionTitle, storedKey } from "../lib/format";
import { useListNav } from "../lib/keys";
import { type LabelFilter, labelPasses, labelQuery } from "../lib/labels";
import { absoluteUrl, copyItem } from "../lib/menus";
import { Link, navigate, sessionPath } from "../lib/router";
import { useAppSettings, useLens } from "../lib/settings";
import { useShortcut } from "../lib/shortcuts";
import { openSplit } from "../lib/split";
import { atTier } from "../lib/tier";
import { clock, dayLabel, useToday } from "../lib/time";

const CAP = 1500;
const TYPES = ["session", "turn", "tool", "files", "attention", "subagent", "context"];

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

  // Live rows.
  useEffect(
    () =>
      store.onEvent((e) => {
        if (!applyFilter(e, filterRef.current)) return;
        if (paused) {
          pending.current.unshift(e);
          if (pending.current.length > CAP) pending.current.length = CAP;
          setPendingCount(pending.current.length);
          return;
        }
        setRows((prev) => (prev.some((p) => p.id === e.id) ? prev : insertByTime(prev, e).slice(0, CAP)));
      }),
    [store, paused],
  );

  const resume = useCallback(() => {
    const p = pending.current;
    pending.current = [];
    setPendingCount(0);
    setRows((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      return p
        .filter((e) => !seen.has(e.id))
        .reduce(insertByTime, prev)
        .slice(0, CAP);
    });
    setPaused(false);
  }, []);
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
  const { cursor: cur } = useListNav(hrefs, true, keys);
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
  const clearFilters = () => {
    setLabelFilter("");
    setHarness("");
    setMachine("");
    setType("");
    setSession("");
    setQ("");
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
            <ChipSelect
              value={harness}
              options={harnesses}
              onChange={setHarness}
              all="All harnesses"
              label="Harness"
              optionLabel={(h) => harnessMark(h).label}
              icon={(h) => <HarnessGlyph name={h} size="sm" />}
            />
            <ChipSelect value={machine} options={machines} onChange={setMachine} all="All machines" label="Machine" />
            <ChipSelect value={type} options={TYPES} onChange={setType} all="All types" label="Type" />
            <ChipSelect
              value={session}
              options={sessionOptions}
              onChange={setSession}
              all="All sessions"
              label="Session"
              optionLabel={sessionLabel}
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

      <ol className="rows" aria-busy={busy}>
        {shown.map((e, i) => {
          const day = dayLabel(e.time, now);
          const showDay = day !== lastDay;
          lastDay = day;
          const s = sessions.get(storedKey(e));
          // A subagent's event: its type after the session's name ("billing ↳ Explore").
          const agentId = typeof e.data.agent_id === "string" ? e.data.agent_id : undefined;
          const agent = agentId
            ? (s?.agents?.find((a) => a.id === agentId)?.type ??
              (typeof e.data.agent_type === "string" ? e.data.agent_type : "Subagent"))
            : undefined;
          return (
            <FeedRow
              key={e.id}
              e={e}
              index={i}
              current={i === cur}
              day={showDay ? sentence(day) : undefined}
              title={s ? sessionTitle(s) : (e.session.title ?? e.session.id.slice(0, 8))}
              agent={agent}
              beside={beside}
              ctx={ctx}
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
        <div className="state">
          <p className="state-title">No events match.</p>
          <p className="state-text">
            {filtered ? "Try another filter, or clear the search." : "Events show up here as agents send them."}
          </p>
          {filtered && (
            <button type="button" className="btn" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
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

const FeedRow = memo(function FeedRow({
  e,
  index,
  current,
  day,
  title,
  agent,
  beside,
  ctx,
}: {
  e: StoredEvent;
  index: number;
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
  const rect = () => document.querySelector(`[data-cursor="${index}"]`)?.getBoundingClientRect();
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
            copyItem("Time (ISO)", e.time),
            copyItem("Session ID", e.session.id),
          ],
        },
        { sep: true },
        { label: c.paused ? "Resume" : "Pause the feed", action: "feed.pause", run: c.togglePause },
      ];
    },
    { title: () => title, subtitle: () => [e.type, clock(e.time)].join(" · ") },
  );
  return (
    <>
      {day && <li className="ev-day">{day}</li>}
      <li
        className={`ev ev--${kind}`}
        data-cursor={String(index)}
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
        <span className={`ev-type mono ev-type--${kind} ${isError(e) ? "is-err" : ""}`}>{e.type}</span>
        <span className="ev-sum ellipsis">
          <Redacted text={eventSummary(e)} />
        </span>
        <BesideButton className="ev-beside" onClick={() => openSplit(key, { from: rect() })} />
      </li>
    </>
  );
});
