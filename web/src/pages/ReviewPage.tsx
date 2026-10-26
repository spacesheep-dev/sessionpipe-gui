// SPDX-License-Identifier: Apache-2.0
// Review: looking back over what the protocol already recorded, in two tabs: the files
// changed in a range grouped by repo, and a day's digest as one table with totals per
// machine and per repo. Searching what was said lives on the Search page (`/` goes there).
import type { Digest, DigestGroup, FilesPage } from "@shared/api";
import { splitKey } from "@shared/api";
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, HarnessGlyph, Segmented } from "../components/bits";
import { useContextMenu } from "../components/ContextMenu";
import { LabelDot } from "../components/LabelDot";
import { PageBar } from "../components/PageBar";
import { useBackgroundMenu, useStickyTop } from "../components/SessionCard";
import { useStore } from "../data/hooks";
import { focusTab, tablistKey } from "../lib/focus";
import { cleanTitle, repoShort } from "../lib/format";
import { absoluteUrl, copyItem } from "../lib/menus";
import { navigate, sessionPath } from "../lib/router";
import { useShortcut } from "../lib/shortcuts";
import { openSplit } from "../lib/split";
import { ago, clock, durCoarse, useNow } from "../lib/time";

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
  const [tab, setTab] = useState<"files" | "day">("files");
  const [range, setRange] = useState<Range>("today");
  const [day, setDay] = useState(() => localDay(Date.now()));
  // `/` here is the Search page's, where every session's words are searched.
  useShortcut("search.focus", () => navigate("/search"), { priority: 1 });
  const page = useRef<HTMLDivElement>(null);
  useStickyTop(page);
  const today = localDay(Date.now());
  const bgMenu = useBackgroundMenu(
    () => [
      tab === "files" && {
        label: "Range",
        items: RANGES.map((r) => ({
          label: r.label,
          radio: true,
          checked: r.value === range,
          run: () => setRange(r.value),
        })),
      },
      tab === "day" && { label: "Previous day", run: () => setDay((d) => shiftDay(d, -1)) },
      tab === "day" && {
        label: "Next day",
        disabled: day >= today ? "Today is the last day there is" : undefined,
        run: () => setDay((d) => shiftDay(d, 1)),
      },
      tab === "day" && day !== today && { label: "Today", run: () => setDay(today) },
      { sep: true },
      { label: "Find…", action: "search.focus", run: () => navigate("/search") },
    ],
    { title: () => "Review" },
  );
  return (
    <div className="page review" ref={page} {...bgMenu}>
      <PageBar
        title="Review"
        tools={
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
        }
      />
      {
        <div id="rv-panel" role="tabpanel" aria-labelledby={tab === "files" ? "rv-tab-files" : "rv-tab-day"}>
          {tab === "files" ? <FilesView range={range} setRange={setRange} /> : <DayView day={day} setDay={setDay} />}
        </div>
      }
    </div>
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
        <EmptyState
          center
          title={`No files changed ${range === "today" ? "today" : `in the last ${range === "7d" ? "7" : "30"} days`}`}
          actions={
            range !== "30d" && (
              <button type="button" className="btn" onClick={() => setRange("30d")}>
                Show 30 days
              </button>
            )
          }
        >
          Paths come from the sessions' file changes, or from a write tool's input at tier 3.
        </EmptyState>
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
          label: s.count > 1 ? `${cleanTitle(s.title)} ×${s.count}` : cleanTitle(s.title),
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
            title={`Open ${cleanTitle(s.title)} beside`}
            onClick={() => openAt(s.key, undefined)}
          >
            <LabelDot session={s.key} />
            {cleanTitle(s.title)}
            {s.count > 1 && <span className="num"> ×{s.count}</span>}
          </button>
        ))}
        {p.sessions.length > TOUCHED && (
          <span className="rv-more num" title="Every session is in the row's menu">
            +{p.sessions.length - TOUCHED}
          </span>
        )}
      </span>
      <span
        className="rv-when num"
        title={`${new Date(p.lastAt).toLocaleString()}${p.count > 1 ? ` · changed ${p.count} times` : ""}`}
      >
        {ago(p.lastAt, now)}
        {p.count > 1 && <span className="rv-count"> · ×{p.count}</span>}
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
            <TotalRow kind="all" g={shown.totals} label="" all />
          </tfoot>
        </table>
      )}
    </div>
  );
}

function DayRow({ s }: { s: Digest["sessions"][number] }) {
  const { harness, id } = splitKey(s.key);
  const title = cleanTitle(s.title);
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
    { title: () => title, subtitle: () => s.machine ?? "" },
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
            title={`Open ${title} beside`}
            onClick={() => openAt(s.key, undefined)}
          >
            {title}
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
      {/* The body's columns, one cell each (not a colspan): on a phone the machine and repo
          columns go, and a spanning cell would push the numbers out from under their heads. */}
      <td>
        <span className="rv-kind">{kind}</span>
        {label ?? (g.name || "no machine")}
        <span className="rv-span num">
          {g.sessions} {g.sessions === 1 ? "session" : "sessions"}
          {g.filesTouched ? ` · ${g.filesTouched} ${g.filesTouched === 1 ? "file" : "files"}` : ""}
        </span>
      </td>
      <td className="rv-col-opt" />
      <td className="rv-col-wide" />
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
