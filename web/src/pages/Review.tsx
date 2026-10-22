// SPDX-License-Identifier: Apache-2.0
// Review: looking back over what the protocol already recorded. A search in the page bar
// over transcripts, tool names, changed paths and titles (GET /api/ui/search; a hit opens
// the session beside at that turn): while it has a query the page is its results, like
// Spotlight's. Otherwise two tabs beside it: the files changed in a range grouped by
// repo, and a day's digest as one table with totals per machine and per repo.
import type { Digest, DigestGroup, FilesPage, SearchHit, SearchPage } from "@shared/api";
import { splitKey } from "@shared/api";
import { type Dispatch, Fragment, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HarnessGlyph, Redacted, SearchInput, Segmented } from "../components/bits";
import { useContextMenu } from "../components/ContextMenu";
import { LabelDot } from "../components/LabelDot";
import { PageBar } from "../components/PageBar";
import { useBackgroundMenu, useStickyTop } from "../components/SessionCard";
import { useStore } from "../data/hooks";
import { focusTab, tablistKey } from "../lib/focus";
import { repoShort } from "../lib/format";
import { focusSearch } from "../lib/keys";
import { absoluteUrl, copyItem } from "../lib/menus";
import { navigate, sessionPath } from "../lib/router";
import { openSplit } from "../lib/split";
import { ago, clock, dayLabel, durCoarse, useNow } from "../lib/time";

const PAGE = 50;
const DAY_MS = 86_400_000;

/** Opens a session beside the page at one of its rows: the panel reads `#seq-N` once
 *  (components/SessionView.tsx) and scrolls there instead of to the latest turn. */
function openAt(key: string, seq: number | undefined, from?: DOMRect) {
  openSplit(key, { from });
  if (seq === undefined) return;
  history.replaceState(null, "", `${location.pathname}${location.search}#seq-${seq}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

/** The browser's local day as YYYY-MM-DD, and its UTC offset in minutes (getTimezoneOffset's sign). */
const tzOffset = () => new Date().getTimezoneOffset();
const localDay = (ms: number) => new Date(ms - tzOffset() * 60_000).toISOString().slice(0, 10);
const shiftDay = (day: string, days: number) => localDay(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS);
const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const desktop = () => typeof matchMedia === "function" && matchMedia("(min-width: 840px)").matches;

type Range = "today" | "7d" | "30d";
const RANGES: { value: Range; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];
const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const RANGE_SINCE: Record<Range, () => number> = {
  today: startOfToday,
  "7d": () => Date.now() - 7 * DAY_MS,
  "30d": () => Date.now() - 30 * DAY_MS,
};

export function Review() {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"files" | "day">("files");
  const [range, setRange] = useState<Range>("today");
  const [day, setDay] = useState(() => localDay(Date.now()));
  const needle = q.trim();
  const page = useRef<HTMLDivElement>(null);
  useStickyTop(page);
  const today = localDay(Date.now());
  const bgMenu = useBackgroundMenu(
    () => [
      !needle &&
        tab === "files" && {
          label: "Range",
          items: RANGES.map((r) => ({
            label: r.label,
            radio: true,
            checked: r.value === range,
            run: () => setRange(r.value),
          })),
        },
      !needle && tab === "day" && { label: "Previous day", run: () => setDay((d) => shiftDay(d, -1)) },
      !needle &&
        tab === "day" && {
          label: "Next day",
          disabled: day >= today ? "Today is the last day there is" : undefined,
          run: () => setDay((d) => shiftDay(d, 1)),
        },
      !needle && tab === "day" && day !== today && { label: "Today", run: () => setDay(today) },
      { sep: true },
      { label: "Find…", action: "search.focus", run: () => void focusSearch() },
    ],
    { title: () => "Review" },
  );
  return (
    <div className="page review" ref={page} {...bgMenu}>
      <PageBar
        title="Review"
        tools={
          <>
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Search"
              label="Search transcripts, tools and file paths"
            />
            {!needle && (
              <div
                className="seg rv-tabs"
                role="tablist"
                aria-label="Review"
                onKeyDown={(e) => {
                  const tabs = ["files", "day"] as const;
                  tablistKey(e, tabs.length, tabs.indexOf(tab), {
                    activate: (i) => {
                      setTab(tabs[i]!);
                      focusTab(e.currentTarget, i);
                    },
                  });
                }}
              >
                {(["files", "day"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    id={`rv-tab-${t}`}
                    className={`seg-opt rv-tab ${tab === t ? "seg-on" : ""}`}
                    aria-selected={tab === t}
                    aria-controls="rv-panel"
                    tabIndex={tab === t ? 0 : -1}
                    onClick={() => setTab(t)}
                  >
                    {t === "files" ? "Files" : "Day"}
                  </button>
                ))}
              </div>
            )}
          </>
        }
      />
      {needle ? (
        <Hits q={needle} />
      ) : (
        <div id="rv-panel" role="tabpanel" aria-labelledby={tab === "files" ? "rv-tab-files" : "rv-tab-day"}>
          {tab === "files" ? <FilesView range={range} setRange={setRange} /> : <DayView day={day} setDay={setDay} />}
        </div>
      )}
    </div>
  );
}

// ---------- search ----------

function Hits({ q }: { q: string }) {
  const store = useStore();
  const [page, setPage] = useState<SearchPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    const t = setTimeout(() => {
      store.transport
        .search({ q, limit: PAGE })
        .then((p) => !cancelled && setPage(p))
        .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)))
        .finally(() => !cancelled && setBusy(false));
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [store, q]);

  const more = useCallback(() => {
    if (!page?.cursor) return;
    setBusy(true);
    store.transport
      .search({ q, limit: PAGE, before: page.cursor })
      .then((p) =>
        setPage((prev) => (prev ? { ...p, hits: [...prev.hits, ...p.hits], scanned: prev.scanned + p.scanned } : p)),
      )
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  }, [store, q, page]);

  const now = useNow("coarse");
  const shown = page && page.q === q ? page : null;
  let lastDay = "";
  return (
    <section className="review-search" aria-label="Search results">
      {error && <p className="page-note is-err">{error}</p>}
      <ol className="rows review-hits" aria-busy={busy}>
        {shown?.hits.map((h, i) => {
          const day = dayLabel(h.event.time, now);
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <Fragment key={h.event.id}>
              {showDay && <li className="ev-day">{sentence(day)}</li>}
              <li className="ev-row" data-cursor={String(i)}>
                <HitRow hit={h} index={i} now={now} />
              </li>
            </Fragment>
          );
        })}
      </ol>
      {!shown && busy && (
        <div className="skeleton" role="status" aria-label="Searching">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      )}
      {shown && !busy && shown.hits.length === 0 && (
        <div className="state">
          <p className="state-title">Nothing matches “{q}”.</p>
          <p className="state-text">The search reads prompts, replies, tool names, changed paths and titles.</p>
        </div>
      )}
      {shown && (
        <p className="page-note review-foot">
          <span className="review-meta num">
            {shown.hits.length} {shown.hits.length === 1 ? "hit" : "hits"} · {shown.scanned.toLocaleString()} events
            looked at · {shown.ms} ms
          </span>
          {busy && shown.hits.length > 0 && <span>Searching…</span>}
          {shown.cursor && !busy && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={more}>
              Older hits
            </button>
          )}
        </p>
      )}
    </section>
  );
}

const FIELD_NAME: Record<string, string> = {
  user: "Prompt",
  assistant: "Reply",
  title: "Title",
  tool: "Tool",
  path: "File",
  message: "Message",
};

/** Where a hit matched, as a 16 px line glyph: a prompt, a reply, a tool, a file, a
 *  title, a prompt's message. */
function FieldGlyph({ field }: { field: string }) {
  const p = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg className="hit-glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      {field === "user" ? (
        <path {...p} d="M3 4.5h10v6H7.5L5 13v-2.5H3z" />
      ) : field === "assistant" ? (
        <path {...p} d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3z" />
      ) : field === "tool" ? (
        <path {...p} d="M10.5 2.8a3 3 0 0 0-3.4 3.9L3 10.8 5.2 13l4.1-4.1a3 3 0 0 0 3.9-3.4l-1.8 1.8-1.7-.4-.4-1.7z" />
      ) : field === "path" ? (
        <path {...p} d="M4 2.5h5l3 3v8H4zM9 2.5v3h3" />
      ) : field === "title" ? (
        <path {...p} d="M3.5 4h9M8 4v8.5" />
      ) : (
        <path {...p} d="M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3zM8 5.5v3M8 10.5v.01" />
      )}
    </svg>
  );
}

/** One hit: where it matched (the glyph), the session and its age, then the snippet
 *  with the match in the text's own colour and weight. */
function HitRow({ hit, index, now }: { hit: SearchHit; index: number; now: number }) {
  const { session: s, event: e, snippet, match } = hit;
  const title = s.title?.trim() || (s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined) || s.id.slice(0, 8);
  const seq = e.session.seq;
  const path = sessionPath(s.harness, s.id);
  const atTurn = seq !== undefined ? `${path}#seq-${seq}` : path;
  const rect = () => document.querySelector(`[data-cursor="${index}"]`)?.getBoundingClientRect();
  const menu = useContextMenu(
    () => [
      { label: "Open beside at this turn", run: () => openAt(s.key, seq, rect()) },
      { label: "Open as page at this turn", run: () => navigate(atTurn) },
      { label: "Open beside at the latest", run: () => openSplit(s.key, { from: rect() }) },
      { sep: true },
      {
        label: "Copy",
        items: [
          copyItem("Snippet", snippet),
          copyItem("Link to this turn", absoluteUrl(atTurn)),
          copyItem("Session ID", s.id),
        ],
      },
    ],
    { title: () => title, subtitle: () => FIELD_NAME[hit.field] ?? hit.field },
  );
  return (
    <button
      type="button"
      className="hit"
      title={`Open ${title} beside, at this ${hit.field === "title" ? "session" : "turn"}`}
      onClick={() => openAt(s.key, seq, rect())}
      {...menu}
    >
      <span className="hit-field" title={FIELD_NAME[hit.field] ?? hit.field}>
        <FieldGlyph field={hit.field} />
        <span className="sr-only">{FIELD_NAME[hit.field] ?? hit.field}</span>
      </span>
      <span className="hit-session ellipsis">
        <LabelDot session={s.key} />
        {title}
      </span>
      <span className="hit-time num" title={new Date(e.time).toLocaleString()}>
        {ago(e.time, now)}
      </span>
      <span className="hit-snippet ellipsis">
        <Redacted text={snippet.slice(0, match[0])} />
        <mark>{snippet.slice(match[0], match[1])}</mark>
        <Redacted text={snippet.slice(match[1])} />
      </span>
      <span className="hit-where">
        <HarnessGlyph name={e.harness.name} size="sm" />
        {s.machine}
      </span>
    </button>
  );
}

// ---------- files ----------

function FilesView({ range, setRange }: { range: Range; setRange: (r: Range) => void }) {
  const store = useStore();
  const [page, setPage] = useState<FilesPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const now = useNow("coarse");

  // A files.changed on the stream refreshes the view (a moment later, so a burst is one fetch).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = store.onEvent((e) => {
      if (e.type !== "files.changed") return;
      if (t) clearTimeout(t);
      t = setTimeout(() => setTick((n) => n + 1), 1500);
    });
    return () => {
      unsub();
      if (t) clearTimeout(t);
    };
  }, [store]);

  useEffect(() => {
    let cancelled = false;
    const since = new Date(RANGE_SINCE[range]()).toISOString();
    store.transport
      .files({ since })
      .then((p) => !cancelled && setPage(p))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [store, range, tick]);

  return (
    <div className="rv-files">
      <div className="rv-head">
        <Segmented<Range> value={range} onChange={setRange} label="Range" options={RANGES} />
        {page && (
          <span className="page-note num">
            {page.total} {page.total === 1 ? "path" : "paths"} in {page.repos.length}{" "}
            {page.repos.length === 1 ? "repo" : "repos"}
          </span>
        )}
      </div>
      {error && <p className="page-note is-err">{error}</p>}
      {!page && !error && (
        <div className="skeleton" role="status" aria-label="Loading files">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      )}
      {page && page.repos.length === 0 && (
        <div className="state">
          <p className="state-title">Search transcripts, tools and file paths</p>
          <p className="state-text">
            No files changed {range === "today" ? "today" : `in the last ${range === "7d" ? "7" : "30"} days`}. Paths
            come from files.changed events, or from a write tool's input at tier 3.
          </p>
        </div>
      )}
      <div className="rv-list">
        {page?.repos.map((r) => {
          const name = r.repo ? repoShort(r.repo) : "no repo";
          return (
            <section key={r.repo || "(none)"} className="group rv-repo" aria-label={name}>
              <h2 className="group-head">
                {name}
                <span className="group-count num">
                  {r.paths.length} {r.paths.length === 1 ? "file" : "files"}
                </span>
              </h2>
              <ul className="rv-paths">
                {r.paths.map((p) => (
                  <PathRow key={p.path} p={p} repo={r.repo} now={now} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** The sessions a path row names before "+n" (the row's menu has them all). */
const TOUCHED = 2;

function PathRow({ p, repo, now }: { p: FilesPage["repos"][number]["paths"][number]; repo: string; now: number }) {
  const menu = useContextMenu(
    () => [
      copyItem("Copy path", p.path),
      repo && copyItem("Copy repo", repoShort(repo)),
      { sep: true },
      {
        label: "Open session",
        items: p.sessions.map((s) => ({
          label: s.count > 1 ? `${s.title} ×${s.count}` : s.title,
          run: () => openAt(s.key, undefined),
        })),
      },
    ],
    { title: () => p.path.split("/").pop() ?? p.path, subtitle: () => (repo ? repoShort(repo) : "") },
  );
  return (
    <li className="rv-path" {...menu}>
      {/* Clipped at the start (the file name matters most); the inner span keeps the
          path's own order inside the right-to-left box. */}
      <code className="rv-file" title={p.path}>
        <span className="rv-file-text">{p.path}</span>
      </code>
      <span className="rv-touched">
        {p.sessions.slice(0, TOUCHED).map((s) => (
          <button
            key={s.key}
            type="button"
            className="rv-sess"
            title={`Open ${s.title} beside`}
            onClick={() => openAt(s.key, undefined)}
          >
            <LabelDot session={s.key} />
            {s.title}
            {s.count > 1 && <span className="num"> ×{s.count}</span>}
          </button>
        ))}
        {p.sessions.length > TOUCHED && (
          <span className="rv-more num" title="Every session is in the row's menu">
            +{p.sessions.length - TOUCHED}
          </span>
        )}
      </span>
      <span className="rv-when num" title={new Date(p.lastAt).toLocaleString()}>
        {ago(p.lastAt, now)}
        {p.count > 1 ? ` · ×${p.count}` : ""}
      </span>
    </li>
  );
}

// ---------- day ----------

function DayView({ day, setDay }: { day: string; setDay: Dispatch<SetStateAction<string>> }) {
  const store = useStore();
  const [digest, setDigest] = useState<Digest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const today = localDay(Date.now());
  const isToday = day === today;

  // Today's digest follows the stream, a few seconds behind.
  useEffect(() => {
    if (!isToday) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const unsub = store.onEvent(() => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        setTick((n) => n + 1);
      }, 3000);
    });
    return () => {
      unsub();
      if (t) clearTimeout(t);
    };
  }, [store, isToday]);

  useEffect(() => {
    let cancelled = false;
    store.transport
      .digest({ day, tz: tzOffset() })
      .then((d) => !cancelled && setDigest(d))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [store, day, tick]);

  const label = useMemo(() => {
    const d = new Date(`${day}T12:00:00`);
    if (isToday) return "Today";
    if (day === shiftDay(today, -1)) return "Yesterday";
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  }, [day, isToday, today]);

  const shown = digest && digest.day === day ? digest : null;
  return (
    <div className="rv-day-view">
      <div className="rv-head">
        <span className="rv-stepper">
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous day"
            title="Previous day"
            onClick={() => setDay((d) => shiftDay(d, -1))}
          >
            <Chevron d="M10 4 6 8l4 4" />
          </button>
          <span className="rv-day" aria-live="polite">
            {label}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Next day"
            title="Next day"
            disabled={isToday}
            onClick={() => setDay((d) => shiftDay(d, 1))}
          >
            <Chevron d="M6 4l4 4-4 4" />
          </button>
        </span>
        {!isToday && (
          <button type="button" className="btn btn--sm" onClick={() => setDay(today)}>
            Today
          </button>
        )}
        {shown && (
          <span className="page-note num">
            {shown.totals.sessions} {shown.totals.sessions === 1 ? "session" : "sessions"} ·{" "}
            {shown.totals.events.toLocaleString()} events
          </span>
        )}
      </div>
      {error && <p className="page-note is-err">{error}</p>}
      {shown && shown.sessions.length === 0 && (
        <div className="state">
          <p className="state-title">
            Nothing happened {isToday || label === "Yesterday" ? label.toLowerCase() : `on ${label}`}
          </p>
          <p className="state-text">A day's digest lists every session that sent an event that day.</p>
        </div>
      )}
      {shown && shown.sessions.length > 0 && (
        <table className="rv-table">
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col" className="rv-col-opt">
                Machine
              </th>
              <th scope="col" className="rv-col-wide">
                Repo
              </th>
              <th scope="col" className="num">
                Turns
              </th>
              <th scope="col" className="num">
                Tools
              </th>
              <th scope="col" className="num rv-col-opt">
                Errors
              </th>
              <th scope="col" className="num rv-col-opt">
                Duration
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.sessions.map((s) => (
              <DayRow key={s.key} s={s} />
            ))}
          </tbody>
          <tfoot>
            {shown.byMachine.map((g) => (
              <TotalRow key={`m:${g.name}`} kind="machine" g={g} />
            ))}
            {shown.byRepo.map((g) => (
              <TotalRow key={`r:${g.name}`} kind="repo" g={g} label={g.name ? repoShort(g.name) : "no repo"} />
            ))}
            <TotalRow kind="all" g={shown.totals} label="all" all />
          </tfoot>
        </table>
      )}
    </div>
  );
}

function DayRow({ s }: { s: Digest["sessions"][number] }) {
  const { harness, id } = splitKey(s.key);
  const path = sessionPath(harness, id);
  const menu = useContextMenu(
    () => [
      { label: "Open beside", run: () => openAt(s.key, undefined) },
      { label: "Open as page", run: () => navigate(path) },
      desktop() && {
        label: "Open in new window",
        run: () => void window.open(absoluteUrl(path), "_blank", "noopener"),
      },
      { sep: true },
      {
        label: "Copy",
        items: [
          copyItem("Title", s.title),
          copyItem("Session ID", id),
          copyItem("Repo", s.repo ? repoShort(s.repo) : ""),
        ],
      },
    ],
    { title: () => s.title, subtitle: () => s.machine ?? "" },
  );
  return (
    <tr {...menu}>
      <td>
        <span className="rv-cell">
          <HarnessGlyph name={s.harness} size="sm" />
          <LabelDot session={s.key} />
          <button
            type="button"
            className="rv-link"
            title={`Open ${s.title} beside`}
            onClick={() => openAt(s.key, undefined)}
          >
            {s.title}
          </button>
          <span className="rv-span num">
            {clock(s.startedAt).slice(0, 5)}–{clock(s.endedAt).slice(0, 5)}
          </span>
        </span>
      </td>
      <td className="muted rv-col-opt">{s.machine ?? ""}</td>
      <td className="muted rv-col-wide">{repoShort(s.repo)}</td>
      <td className="num">{s.turns}</td>
      <td className="num">{s.tools}</td>
      <td className={`num rv-col-opt ${s.errors ? "is-err" : "muted"}`}>{s.errors || "–"}</td>
      <td className="num rv-col-opt">{durCoarse(s.activeMs)}</td>
    </tr>
  );
}

function TotalRow({ kind, g, label, all = false }: { kind: string; g: DigestGroup; label?: string; all?: boolean }) {
  return (
    <tr className={all ? "rv-all" : ""}>
      <td colSpan={3}>
        <span className="rv-kind">{kind}</span>
        {label ?? (g.name || "no machine")}
        <span className="rv-span num">
          {g.sessions} {g.sessions === 1 ? "session" : "sessions"}
          {g.filesTouched ? ` · ${g.filesTouched} ${g.filesTouched === 1 ? "file" : "files"}` : ""}
        </span>
      </td>
      <td className="num">{g.turns}</td>
      <td className="num">{g.tools}</td>
      <td className={`num rv-col-opt ${g.errors ? "is-err" : ""}`}>{g.errors || "–"}</td>
      <td className="num rv-col-opt">{durCoarse(g.activeMs)}</td>
    </tr>
  );
}

function Chevron({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
