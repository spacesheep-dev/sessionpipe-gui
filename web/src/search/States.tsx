// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. What the page shows around its results (ux-search.md §8, §9): the
// index status as one quiet line (and its popover), the idle page that teaches the syntax
// with this device's recent searches, the "nothing to search yet" page, and the no-result
// state with the one fix that applies.
import type { SearchHint, SearchIndexStatus, SessionSearchPage } from "@shared/api";
import { useEffect, useRef, useState } from "react";
import { EmptyState, Toggle } from "../components/bits";
import { confirmAction } from "../components/ContextMenu";
import { Link, navigate } from "../lib/router";
import { useNow } from "../lib/time";
import { forgetAnswers, noteStatus } from "./client";
import type { SearchClient } from "./types";
import { bytesWord, harnessName, macWord, plural, statusWords, updatedWord } from "./words";

// ---------- status ----------

/** The 1 px progress hairline under the page bar during a first run (transform only). */
export function ProgressHairline({ status }: { status: SearchIndexStatus | null }) {
  if (status?.state !== "first-run") return null;
  return (
    <div className="sx-progress" aria-hidden="true">
      <span style={{ transform: `scaleX(${Math.max(0.02, status.progress ?? 0)})` }} />
    </div>
  );
}

export function StatusLine({
  status,
  client,
  withResults = false,
  className = "",
}: {
  status: SearchIndexStatus | null;
  client: SearchClient | null;
  withResults?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  if (!status) return <div className={`sx-status ${className}`} aria-hidden="true" />;
  const words = statusWords(status, withResults);
  const err = status.state === "error";
  return (
    <div className={`sx-status num ${err ? "is-err" : ""} ${className}`} role="status">
      <button
        ref={btn}
        type="button"
        className="sx-status-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {words}
      </button>
      {status.state === "off" && (
        <Link to="/settings?section=data" className="sx-status-link">
          off
        </Link>
      )}
      {err && status.local && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void rebuild(client)}>
          Rebuild
        </button>
      )}
      {open && <IndexPopover status={status} client={client} anchor={btn} onClose={() => setOpen(false)} />}
    </div>
  );
}

async function rebuild(client: SearchClient | null): Promise<void> {
  if (!client) return;
  const ok = await confirmAction({
    title: "Rebuild the search index?",
    body: "It reads everything again, about 2 minutes. Search keeps working meanwhile.",
    action: "Rebuild",
  });
  if (!ok) return;
  forgetAnswers();
  noteStatus(await client.reindex(true));
}

async function setHistory(client: SearchClient | null, on: boolean): Promise<void> {
  if (!client) return;
  if (!on) {
    const ok = await confirmAction({
      title: "Stop reading agent history?",
      body: "Sessions from before sessionpipe leave search. The index for them is deleted.",
      action: "Turn off",
    });
    if (!ok) return;
  }
  forgetAnswers();
  noteStatus(await client.settings({ history: on }));
}

/** The index, source by source (ux-search.md §8): a grouped list, hairlines between rows. */
function IndexPopover({
  status,
  client,
  anchor,
  onClose,
}: {
  status: SearchIndexStatus;
  client: SearchClient | null;
  anchor: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow("coarse");
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.focus();
    const onClose = () => close.current();
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        anchor.current?.focus();
      }
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor]);
  const history = status.sources.filter((s) => s.source === "history");
  // What sessionpipe delivered is one row, whatever the harnesses.
  const piped = status.sources.filter((s) => s.source === "sessionpipe").reduce((n, s) => n + s.sessions, 0);
  return (
    <div className="sx-pop" role="dialog" aria-label="Search index" ref={ref} tabIndex={-1}>
      <p className="sx-pop-title">Search index</p>
      <ul className="sx-pop-list">
        {history.map((s) => (
          <li key={`h:${s.harness}`} className="sx-pop-row">
            <span className="sx-pop-name">{harnessName(s.harness)}</span>
            <code className="sx-pop-homes">{s.homes.join(", ")}</code>
            <span className="sx-pop-n num">{s.sessions.toLocaleString()}</span>
          </li>
        ))}
        {piped > 0 && (
          <li className="sx-pop-row">
            <span className="sx-pop-name">sessionpipe</span>
            <span className="sx-pop-homes sx-pop-homes--ui">received</span>
            <span className="sx-pop-n num">{piped.toLocaleString()}</span>
          </li>
        )}
        {status.skipped?.map((s) => (
          <li key={`s:${s.harness}:${s.why}`} className="sx-pop-row sx-pop-row--note">
            <span className="sx-pop-name">{harnessName(s.harness)}</span>
            <span className="sx-pop-homes sx-pop-homes--ui">
              {plural(s.files, "file")} skipped
              {s.why === "zstd" ? ": compressed, and this Node can't read zstd" : ": unreadable"}
            </span>
          </li>
        ))}
      </ul>
      <p className="sx-pop-foot num">
        On disk {bytesWord(status.bytes)}
        {status.updatedAt ? ` · updated ${updatedWord(status.updatedAt, now)}` : ""}
      </p>
      {status.local && (
        <div className="sx-pop-actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void rebuild(client)}>
            Rebuild index…
          </button>
          <span className="sx-pop-switch">
            History search
            <Toggle on={status.history} onChange={(on) => void setHistory(client, on)} label="History search" />
          </span>
        </div>
      )}
    </div>
  );
}

// ---------- idle ----------

const EXAMPLES: { q: string; what: string }[] = [
  { q: "webhook retry", what: "every word" },
  { q: '"rate limiter"', what: "an exact phrase" },
  { q: "deploy -staging", what: "without a word" },
  { q: "migrat*", what: "words that start with it" },
  { q: "agent:codex machine:build-box", what: "one agent, one machine" },
  { q: "since:7d in:prompt", what: "the past week, only what you asked" },
];

const RECENT_KEY = "sp.search.recent";
const RECENT_MAX = 8;
export function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
function writeRecent(list: string[]): void {
  try {
    if (list.length) localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    else localStorage.removeItem(RECENT_KEY);
  } catch {
    // a private window: recent searches last for this page
  }
}
export function rememberSearch(q: string): void {
  const t = q.trim();
  if (!t) return;
  writeRecent([t, ...readRecent().filter((x) => x !== t)]);
}
export function forgetSearch(q: string | null): void {
  writeRecent(q === null ? [] : readRecent().filter((x) => x !== q));
}

export function Idle({
  status,
  client,
  setQuery,
  narrow,
}: {
  status: SearchIndexStatus | null;
  client: SearchClient | null;
  setQuery: (q: string) => void;
  narrow: boolean;
}) {
  const [recent, setRecent] = useState(readRecent);
  const examples = narrow ? EXAMPLES.slice(0, 4) : EXAMPLES;
  return (
    <div className="sx-idle">
      <h2 className="sx-idle-title">Search every session</h2>
      <p className="sx-idle-text">
        Prompts, replies and tool calls from every machine, and this {macWord()}'s own agent history.
      </p>
      <ul className="sx-examples">
        {examples.map((e) => (
          <li key={e.q}>
            <button type="button" className="sx-example" onClick={() => setQuery(e.q)}>
              <code className="sx-example-q">{e.q}</code>
              <span className="sx-example-what">{e.what}</span>
            </button>
          </li>
        ))}
      </ul>
      {recent.length > 0 && (
        <section className="sx-recent" aria-label="Recent">
          <h3 className="sx-recent-title">Recent</h3>
          <ul>
            {recent.map((r) => (
              <li key={r} className="sx-recent-row">
                <button type="button" className="sx-recent-q" onClick={() => setQuery(r)}>
                  {r}
                </button>
                <button
                  type="button"
                  className="icon-btn sx-recent-x"
                  aria-label={`Remove “${r}” from recent searches`}
                  onClick={() => {
                    forgetSearch(r);
                    setRecent(readRecent());
                  }}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path
                      d="M4.5 4.5l7 7M11.5 4.5l-7 7"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <StatusLine status={status} client={client} className="sx-status--idle" />
    </div>
  );
}

/** Nothing indexed and nothing received: say what search reads, and offer to read it. */
export function NothingYet({ status, client }: { status: SearchIndexStatus; client: SearchClient | null }) {
  return (
    <EmptyState
      center
      title="Nothing to search yet"
      actions={
        status.local ? (
          <>
            {!status.history && (
              <button type="button" className="btn btn--primary" onClick={() => void setHistory(client, true)}>
                Search this {macWord()}'s history
              </button>
            )}
            <button type="button" className="btn btn--ghost" onClick={() => navigate("/setup")}>
              Set up sessionpipe
            </button>
          </>
        ) : null
      }
    >
      Sessions show up here as sessionpipe sends them.
      {status.local
        ? ` Search can also read the agent history already on this ${macWord()} (Claude Code, Codex, Antigravity), read-only.`
        : null}
    </EmptyState>
  );
}

// ---------- no results ----------

export function NoResults({
  page,
  setQuery,
  clear,
}: {
  page: SessionSearchPage;
  setQuery: (q: string) => void;
  clear: () => void;
}) {
  const h: SearchHint = page.hint ?? { kind: "none" };
  const fix = (label: string, q: string | undefined) =>
    q !== undefined ? (
      <button type="button" className="sx-fix" onClick={() => setQuery(q)}>
        {label}
      </button>
    ) : null;
  const pct = `${Math.round((page.index.progress ?? 0) * 100)} %`;
  const body =
    h.kind === "filters" ? (
      <>Nothing with these filters. {fix("Search without filters", h.query)}</>
    ) : h.kind === "phrase" ? (
      <>
        No exact phrase. {fix("Search the words: ", h.query)}
        {h.query ? <code className="sx-fix-q">{h.query}</code> : null}
      </>
    ) : h.kind === "spelling" ? (
      <>
        Nothing has “{page.q}”. {fix(`Search ${h.word ?? ""}`, h.query)}
      </>
    ) : h.kind === "exclude" ? (
      <>
        Every match has “{h.word}”. {fix(`Search without -${h.word}`, h.query)}
      </>
    ) : h.kind === "indexing" ? (
      <>
        This {macWord()}'s history is still being read ({pct}). More may turn up.
      </>
    ) : (
      <>Searched prompts, replies, tool calls and titles in {plural(page.index.sessions, "session")}.</>
    );
  return (
    <EmptyState
      center
      className="sx-none"
      title={`No sessions match “${page.q.trim()}”`}
      actions={
        <button type="button" className="btn btn--ghost" onClick={clear}>
          Clear search
        </button>
      }
    >
      {body}
    </EmptyState>
  );
}
