// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. /search (ux-search.md §2–§12): every session, every machine and this
// Mac's own agent history, one row per session, ranked as you type. The query is the page's
// whole state and lives in the URL (`?q=`, `&sort=newest`), replaced per keystroke and
// pushed when a result opens, so Back returns to the same results with the cursor where it
// was. The field leads; under it the filter chips (which edit the query text: one state) and
// the result line; then the rows. Keys: ↑↓ in the field and j/k in the list walk the results,
// ⏎ opens, ⇧⏎ beside, ⌘⏎ beside keeping focus here, Space peeks, `.` the menu, ⌘C the
// resume line, `/` the field, Esc steps back.
import type { SearchFilterKey, SearchSort, SessionMatch } from "@shared/api";
import { filterValue, isEmptySearch, parseSearch, setFilter, withoutFilters } from "@shared/searchQuery";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChipSelect, HarnessGlyph, Segmented } from "../components/bits";
import { LabelSwatch } from "../components/LabelDot";
import { PageBar } from "../components/PageBar";
import { useBackgroundMenu } from "../components/SessionCard";
import { useStore } from "../data/hooks";
import { focusSearch } from "../lib/keys";
import { parseRoute, SPLIT_ACTIVE_PARAM, SPLIT_PARAM } from "../lib/router";
import { useShortcut } from "../lib/shortcuts";
import { closeTab, parseSplit } from "../lib/split";
import { useNow } from "../lib/time";
import { markTyped, PAGE_SIZE, useFacets, useSearchClient, useSearchStatus, useSessionSearch } from "../search/client";
import { DateRange, rangeLabel } from "../search/DateRange";
import { type FieldHandle, SearchField } from "../search/Field";
import { copyResume, type RowMenuContext } from "../search/menu";
import { type OpenMode, openResult } from "../search/open";
import { Row } from "../search/Row";
import {
  forgetSearch,
  Idle,
  NoResults,
  NothingYet,
  ProgressHairline,
  rememberSearch,
  StatusLine,
} from "../search/States";
import { macWord, resultLine } from "../search/words";
import "../styles/search.css";

const PHONE = "(max-width: 839px)";
function useMedia(q: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const up = () => setOn(mq.matches);
    up();
    mq.addEventListener("change", up);
    return () => mq.removeEventListener("change", up);
  }, [q]);
  return on;
}

const readUrl = () => {
  const p = new URLSearchParams(location.search);
  return { q: p.get("q") ?? "", sort: (p.get("sort") === "newest" ? "newest" : "best") as SearchSort };
};

/** The URL follows the query without a history entry per letter, and without telling the
 *  router (nothing else reads `q`, and the shell need not re-render per keystroke). */
function writeUrl(q: string, sort: SearchSort): void {
  const p = new URLSearchParams(location.search);
  if (q) p.set("q", q);
  else p.delete("q");
  if (sort === "newest") p.set("sort", "newest");
  else p.delete("sort");
  const qs = p.toString();
  const next = `${location.pathname}${qs ? `?${qs}` : ""}`;
  if (next !== location.pathname + location.search) history.replaceState(history.state, "", next);
}

const DATE_PRESETS = [
  { v: "today", label: "Today" },
  { v: "7d", label: "Past 7 days" },
  { v: "30d", label: "Past 30 days" },
  { v: "1y", label: "Past year" },
];
const AGENT_SHORT: Record<string, string> = { "claude-code": "claude", "gemini-cli": "gemini" };
const AGENT_FULL: Record<string, string> = { claude: "claude-code", gemini: "gemini-cli" };

/** The tab the peek opened, so the next peek replaces it and Esc closes it. */
let peeked: string | null = null;
const splitTabs = () => {
  const p = new URLSearchParams(location.search);
  return parseSplit(p.get(SPLIT_PARAM), p.get(SPLIT_ACTIVE_PARAM)).tabs;
};
function closePeek(): boolean {
  if (!peeked) return false;
  const i = splitTabs().indexOf(peeked);
  peeked = null;
  if (i >= 0) closeTab(i);
  return i >= 0;
}

export function Search() {
  const store = useStore();
  const client = useSearchClient();
  const status = useSearchStatus(client);
  const phone = useMedia(PHONE);
  const narrow = useMedia("(max-width: 759px)");
  const [{ q, sort }, setState] = useState(readUrl);
  const setQuery = useCallback((next: string) => {
    setState((s) => ({ ...s, q: next }));
  }, []);
  /** A query a button wrote (an example, a hint): measured like a keystroke. */
  const typeQuery = useCallback((next: string) => {
    markTyped();
    setState((s) => ({ ...s, q: next }));
  }, []);
  const setSort = useCallback((next: SearchSort) => setState((s) => ({ ...s, sort: next })), []);
  useEffect(() => writeUrl(q, sort), [q, sort]);
  // Back / Forward between two searches of this page.
  useEffect(() => {
    const on = () => {
      if (parseRoute(location.pathname).name === "search") setState(readUrl());
    };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  useEffect(() => {
    document.title = q.trim() ? `“${q.trim()}” · Search · sessionpipe gui` : "Search · sessionpipe gui";
  });

  const parsed = useMemo(() => parseSearch(q, { live: true }), [q]);
  const empty = isEmptySearch(parsed);
  const res = useSessionSearch(client, q, sort, status?.messages);
  const page = res.page;
  const facets = useFacets(client, status?.sessions);
  const sessions = page?.sessions ?? NONE;
  const now = useNow("coarse");

  // ----- the cursor -----
  const [cursor, setCursor] = useState(-1);
  const [rangeOpen, setRangeOpen] = useState(false);
  const onRow = useRef<string | null>(null);
  const field = useRef<FieldHandle>(null);
  const listRef = useRef<HTMLOListElement>(null);
  // New results: the cursor stays on its session if it is still there, else the first
  // row is the soft selection (⏎ in the field opens the top hit).
  const keyList = useMemo(() => sessions.map((s) => s.key), [sessions]);
  const [seenList, setSeenList] = useState(keyList);
  if (seenList !== keyList) {
    setSeenList(keyList);
    const i = onRow.current ? keyList.indexOf(onRow.current) : -1;
    const next = i >= 0 && !res.fresh ? i : keyList.length ? 0 : -1;
    if (next !== cursor) setCursor(next);
  }
  onRow.current = cursor >= 0 ? (keyList[cursor] ?? null) : null;
  const focusRow = useCallback((i: number) => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cursor="${i}"] .sx-row`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, []);
  const inField = () => document.activeElement === field.current?.input();
  const move = useCallback(
    (d: 1 | -1) => {
      if (!keyList.length) return false;
      const next = cursor < 0 ? 0 : Math.max(0, Math.min(keyList.length - 1, cursor + d));
      setCursor(next);
      if (inField()) listRef.current?.querySelector(`[data-cursor="${next}"]`)?.scrollIntoView({ block: "nearest" });
      else focusRow(next);
      if (peeked) peek(sessions[next], true);
      if (next >= keyList.length - 5) res.loadMore();
      return true;
    },
    [cursor, keyList, focusRow, sessions, res.loadMore],
  );
  const open = useCallback(
    (mode: OpenMode, i = cursor) => {
      const m = sessions[i < 0 ? 0 : i];
      if (!m) return false;
      rememberSearch(q);
      const rect = listRef.current?.querySelector(`[data-cursor="${i}"]`)?.getBoundingClientRect();
      if (mode !== "page") peeked = null;
      openResult(m, m.hits[0], q, mode, rect);
      return true;
    },
    [cursor, sessions, q],
  );
  function peek(m: SessionMatch | undefined, replace = false): boolean {
    if (!m) return false;
    const before = peeked;
    if (!replace && before === m.key) {
      closePeek();
      return true;
    }
    const had = splitTabs().includes(m.key);
    openResult(m, m.hits[0], q, "beside", undefined);
    if (before && before !== m.key) {
      const i = splitTabs().indexOf(before);
      if (i >= 0) closeTab(i);
    }
    peeked = had ? null : m.key;
    // The list keeps the keys (Quick Look).
    requestAnimationFrame(() => {
      if (!inField()) focusRow(cursor < 0 ? 0 : cursor);
    });
    return true;
  }
  useEffect(
    () => () => {
      peeked = null;
    },
    [],
  );
  // The phone: scrolling the list puts the keyboard away (iOS); the Search tab tapped
  // again on this page goes to the top (the shell) and into the field.
  useEffect(() => {
    if (!phone) return;
    const blur = () => {
      const el = field.current?.input();
      if (el && document.activeElement === el) el.blur();
    };
    window.addEventListener("touchmove", blur, { passive: true });
    return () => window.removeEventListener("touchmove", blur);
  }, [phone]);
  useEffect(() => {
    const on = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.("a[data-nav='search']"))
        requestAnimationFrame(() => field.current?.focus(true));
    };
    document.addEventListener("click", on);
    return () => document.removeEventListener("click", on);
  }, []);

  const listOn = sessions.length > 0;
  useShortcut("list.down", () => move(1), { enabled: listOn });
  useShortcut("list.up", () => move(-1), { enabled: listOn });
  useShortcut("list.open", () => open("page"), { enabled: listOn });
  useShortcut("list.beside", () => open("beside"), { enabled: listOn });
  useShortcut("list.background", () => open("background"), { enabled: listOn });
  useShortcut("search.peek", () => peek(sessions[cursor < 0 ? 0 : cursor]), { enabled: listOn });
  useShortcut(
    "search.copyResume",
    () => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return false;
      const m = sessions[cursor];
      if (!m) return false;
      return copyResume(m);
    },
    { enabled: listOn },
  );
  useShortcut(
    "list.menu",
    () => {
      const el = listRef.current?.querySelector<HTMLElement>(`[data-cursor="${cursor}"] .sx-row`);
      if (!el) return false;
      el.focus({ preventScroll: true });
      const r = el.getBoundingClientRect();
      const ce = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: r.left + 32,
        clientY: r.top + 24,
      }) as MouseEvent & { __kbd?: boolean };
      ce.__kbd = true;
      el.dispatchEvent(ce);
    },
    { enabled: listOn },
  );
  useShortcut(
    "back",
    (e) => {
      if (inField()) return false;
      if (closePeek()) return;
      if ((e.target as HTMLElement | null)?.closest?.("aside.panel")) return false;
      if (document.querySelector("[data-dismiss]:not([data-closing])")?.checkVisibility?.()) return false;
      field.current?.focus(true);
    },
    { priority: 2 },
  );
  // `/` on this page: the field, its text selected (the global search.focus does it).

  // A search counts as made when it was held for 2 s with results (or a result opened).
  useEffect(() => {
    if (!page?.sessions.length || !res.fresh) return;
    const t = window.setTimeout(() => rememberSearch(q), 2000);
    return () => window.clearTimeout(t);
  }, [page, res.fresh, q]);

  // ----- the row context, read when a menu opens or a row is clicked -----
  const ctxRef = useRef<RowMenuContext>(null as unknown as RowMenuContext);
  ctxRef.current = {
    store,
    client,
    status,
    q,
    setQuery: (next) => {
      markTyped();
      setQuery(next);
    },
    find: (m) => {
      rememberSearch(q);
      openResult(m, m.hits[0], q, "page");
    },
    from: () => undefined,
  };
  const ctx = useCallback(() => ctxRef.current, []);
  const onCursor = useCallback((i: number) => setCursor(i), []);

  // ----- the filters -----
  const setF = (key: SearchFilterKey, v: string) => {
    markTyped();
    setQuery(setFilter(q, key, v || null));
  };
  const agents = facets?.agents ?? [];
  const machines = facets?.machines ?? [];
  const repos = (facets?.repos ?? []).slice(0, 30);
  const labels = facets?.labels ?? [];
  const agentNow = filterValue(parsed, "agent");
  const since = filterValue(parsed, "since");
  const until = filterValue(parsed, "until");
  const range = rangeLabel(since, until);
  const dateValue = range ? "range" : !since ? "" : DATE_PRESETS.some((d) => d.v === since) ? since : "other";
  const hasFilters = Object.keys(parsed.filters).length > 0 || Object.keys(parsed.notFilters).length > 0;
  const piped = status?.sources.some((s) => s.source === "sessionpipe") ?? false;
  const sourceNow = filterValue(parsed, "source");
  const chips = (
    <>
      {phone && (
        <ChipSelect
          value={sort === "newest" ? "newest" : ""}
          options={["newest"]}
          all="Best match"
          label="Sort"
          optionLabel={() => "Newest"}
          onChange={(v) => setSort(v === "newest" ? "newest" : "best")}
        />
      )}
      {agents.length >= 2 && (
        <ChipSelect
          value={agentNow ? (AGENT_SHORT[agentNow] ?? agentNow) : ""}
          options={agents.map((a) => AGENT_SHORT[a.value] ?? a.value)}
          all="All agents"
          label="Agent"
          optionLabel={(o) => agents.find((a) => a.value === (AGENT_FULL[o] ?? o))?.label ?? o}
          icon={(o) => <HarnessGlyph name={AGENT_FULL[o] ?? o} size="sm" />}
          onChange={(v) => setF("agent", v)}
        />
      )}
      {machines.length >= 2 && (
        <ChipSelect
          value={filterValue(parsed, "machine") ?? ""}
          options={machines.map((m) => m.value.toLowerCase())}
          all="All machines"
          label="Machine"
          optionLabel={(o) => machines.find((m) => m.value.toLowerCase() === o)?.value ?? o}
          onChange={(v) => setF("machine", v)}
        />
      )}
      {repos.length >= 2 && (
        <ChipSelect
          value={filterValue(parsed, "repo") ?? ""}
          options={repos.map((r) => r.value.toLowerCase())}
          all="All repos"
          label="Repo"
          optionLabel={(o) => repos.find((r) => r.value.toLowerCase() === o)?.value ?? o}
          onChange={(v) => setF("repo", v)}
        />
      )}
      <ChipSelect
        value={dateValue}
        options={[...DATE_PRESETS.map((d) => d.v), ...(dateValue === "other" ? ["other"] : []), "range"]}
        all="Any time"
        label="Date"
        optionLabel={(o) =>
          DATE_PRESETS.find((d) => d.v === o)?.label ??
          (o === "range" ? (range ?? "Custom range…") : `Since ${since ?? ""}`)
        }
        onChange={(v) => {
          if (v === "range") {
            setRangeOpen(true);
            return;
          }
          if (v === "other") return;
          markTyped();
          setQuery(setFilter(setFilter(q, "until", null), "since", v || null));
        }}
      />
      {status?.history && piped && (
        <ChipSelect
          value={sourceNow ?? ""}
          options={["sessionpipe", "history"]}
          all="All sources"
          label="Source"
          optionLabel={(o) => (o === "history" ? `This ${macWord()}'s history` : "From sessionpipe")}
          onChange={(v) => setF("source", v)}
        />
      )}
      {labels.length > 0 && (
        <ChipSelect
          value={filterValue(parsed, "label") ?? ""}
          options={labels.map((l) => l.value)}
          all="All labels"
          label="Label"
          optionLabel={(o) => labels.find((l) => l.value === o)?.label ?? o}
          icon={(o) => <LabelSwatch color={o as never} />}
          onChange={(v) => setF("label", v)}
        />
      )}
      {hasFilters && (
        <button
          type="button"
          className="btn btn--ghost btn--sm sx-clearf"
          onClick={() => {
            markTyped();
            setQuery(withoutFilters(q));
          }}
        >
          Clear
        </button>
      )}
    </>
  );

  const bgMenu = useBackgroundMenu(
    () => [
      {
        label: "Sort",
        items: [
          { label: "Best match", radio: true, checked: sort === "best", run: () => setSort("best") },
          { label: "Newest", radio: true, checked: sort === "newest", run: () => setSort("newest") },
        ],
      },
      hasFilters && { label: "Clear filters", run: () => setQuery(withoutFilters(q)) },
      { label: "Find…", action: "search.focus", run: () => void focusSearch() },
      {
        label: "Index status…",
        run: () => document.querySelector<HTMLButtonElement>(".sx-status-btn")?.click(),
      },
      { sep: true },
      { label: "Clear recent searches", run: () => forgetSearch(null) },
    ],
    { title: () => "Search" },
  );

  const keys = useMemo(
    () => ({
      move: (d: 1 | -1) => void move(d),
      open: (mode: OpenMode) => void open(mode),
      leave: () => {
        if (sessions.length) {
          const i = cursor < 0 ? 0 : cursor;
          setCursor(i);
          focusRow(i);
        } else field.current?.input()?.blur();
      },
    }),
    [move, open, sessions.length, cursor, focusRow],
  );

  const showRows = !empty && sessions.length > 0;
  const idle = empty;
  const nothing =
    idle && status && status.sessions === 0 && status.state !== "first-run" && status.state !== "updating";
  const unknown = page?.parsed.unknown ?? [];
  let lastDay = "";
  const byDay = sort === "newest" || (page?.sort === "newest" && !page.parsed.clauses.some((c) => !c.not));

  const fieldEl = (
    <SearchField
      ref={field}
      value={q}
      onChange={setQuery}
      facets={facets}
      keys={keys}
      phone={phone}
      autoFocus={!phone}
    />
  );
  return (
    <div className={`page sx ${phone ? "sx--phone" : ""}`} {...bgMenu}>
      <PageBar
        title="Search"
        className="sx-bar"
        tools={
          phone ? undefined : (
            <>
              {fieldEl}
              <Segmented<SearchSort>
                value={sort}
                onChange={setSort}
                label="Sort"
                options={[
                  { value: "best", label: "Best match" },
                  { value: "newest", label: "Newest" },
                ]}
              />
            </>
          )
        }
      />
      <ProgressHairline status={status} />
      {phone && <div className="sx-phonefield">{fieldEl}</div>}
      <div className="sx-filters" data-empty={idle ? "" : undefined}>
        {/* The chips arrive together, with the facets, into a row already their height. */}
        <div className="sx-chips">{facets ? chips : null}</div>
        {rangeOpen && (
          <DateRange
            since={since}
            until={until}
            onClose={() => setRangeOpen(false)}
            onApply={(a, b) => {
              markTyped();
              setQuery(setFilter(setFilter(q, "since", a), "until", b));
            }}
          />
        )}
        {!idle && page && (
          <span className="sx-resline num" aria-live="polite">
            {resultLine(page.total, page.more, page.ms)}
            {res.newer && (
              <>
                {" · "}
                <button type="button" className="sx-fix sx-newer" onClick={res.showNewer}>
                  New matches
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {unknown.length > 0 && !idle && (
        <p className="sx-note">
          “{unknown[0]}:” isn't a filter, so it was searched as text. Filters: agent machine repo label since until in
          source
        </p>
      )}
      {res.error && !idle && (
        <p className="sx-note sx-note--fail">
          Search didn't answer.{" "}
          <button type="button" className="sx-fix" onClick={res.retry}>
            Try again
          </button>
        </p>
      )}
      {nothing ? (
        <NothingYet status={status} client={client} />
      ) : idle ? (
        <Idle status={status} client={client} setQuery={typeQuery} narrow={narrow || phone} />
      ) : res.skeleton && !page ? (
        <div className="skeleton sx-skeleton" role="status" aria-label="Searching">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      ) : page && sessions.length === 0 && res.fresh && !res.busy ? (
        <NoResults page={page} setQuery={typeQuery} clear={() => typeQuery("")} />
      ) : null}
      {showRows && (
        <ol className="sx-list" ref={listRef} aria-label="Search results" aria-busy={res.busy}>
          {sessions.map((m, i) => {
            const day = byDay ? dayHead(m.lastAt, now) : "";
            const head = byDay && day !== lastDay;
            lastDay = day;
            return (
              <Fragment key={m.key}>
                {head && <li className="sx-day">{day}</li>}
                <li className="sx-item" data-cursor={String(i)}>
                  <Row m={m} index={i} active={i === cursor && !phone} now={now} ctx={ctx} onCursor={onCursor} />
                </li>
              </Fragment>
            );
          })}
        </ol>
      )}
      {showRows && (page?.cursor || res.loadingMore) && (
        <div className="sx-loadmore">
          <button type="button" className="btn btn--ghost btn--sm" onClick={res.loadMore} disabled={res.loadingMore}>
            {res.loadingMore ? "Loading…" : `${Math.min(PAGE_SIZE, (page?.total ?? 0) - sessions.length)} more`}
          </button>
        </div>
      )}
      {showRows && <StatusLine status={status} client={client} withResults className="sx-status--foot" />}
      <AutoLoad onNear={res.loadMore} on={showRows && !!page?.cursor} />
    </div>
  );
}

const NONE: SessionMatch[] = [];

/** "Today", "Yesterday", "Wed, Oct 21": the Newest sort's day headers (Review's). */
function dayHead(iso: string, now: number): string {
  const d = new Date(iso);
  const n = new Date(now);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, n)) return "Today";
  if (same(d, new Date(now - 86_400_000))) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/** Loads the next page as the end of the list nears (no button press needed). */
function AutoLoad({ onNear, on }: { onNear: () => void; on: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onNear);
  cb.current = onNear;
  useEffect(() => {
    const el = ref.current;
    if (!on || !el || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && cb.current(), { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [on]);
  return <div ref={ref} aria-hidden="true" className="sx-sentinel" />;
}
