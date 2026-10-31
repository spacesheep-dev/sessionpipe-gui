// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The Files drawer beside a session's timeline: every file the session
// read or changed, from its own events (nothing is asked of the machine): the receiver's
// index of the whole session (`GET …/files`, shared/files.ts) plus the live events since.
// A file opens on its changes, or its whole text, as the agent last saw it, with every
// version it went through here one step away; the full events behind it are fetched as
// it opens. Click a line number (shift-click, or ⇧↓, for a range) to comment on it, as a
// code review does, or suggest the lines it should become; the comments gather at the
// foot and go to the session as one signed message (the same `prompt` the composer
// sends), or into the composer to finish by hand. A second tab lists the session's
// problems (a tool that failed, an error raised), each a jump to its row. Where the
// session runs on this machine, a file opens in the editor of your choice. On a wide
// page it is a column at the right of the session; in the side panel it takes the panel;
// on a phone the screen. Esc steps back (the comment, the file, the drawer), wherever
// focus is; ↑ ↓ (j k) move in the list and over the lines, n and p between changes.
import type { MachineControl, SessionFiles, SessionSummary, StoredEvent } from "@shared/api";
import { indexTouches } from "@shared/files";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Segmented } from "../components/bits";
import { type MenuList, MoreButton, useContextMenu } from "../components/ContextMenu";
import { isThisMachine } from "../control/Attachments";
import { lastInfo, rpId } from "../control/api";
import { nonce } from "../control/bytes";
import { useSessionSend } from "../control/useSend";
import { useStore } from "../data/hooks";
import { toolLabel } from "../lib/format";
import { fuzzy } from "../lib/fuzzy";
import { copyText } from "../lib/menus";
import { clockTime } from "../lib/pool";
import { hintFor } from "../lib/shortcuts";
import { ago, useNow } from "../lib/time";
import {
  type DiffRow,
  diffRows,
  EDITORS,
  type EventsBySeq,
  editorHref,
  type FileEntry,
  fileText,
  firstLines,
  type Hunk,
  type LineComment,
  mergeFiles,
  type Problem,
  problemsOf,
  reviewPrompt,
  versionsOf,
} from "./model";
import {
  addComment,
  closeDrawer,
  type DrawerMode,
  type DrawerTab,
  removeComment,
  reviewed,
  setDrawer,
  setEditor,
  setViewed,
  useDrawer,
  useEditor,
} from "./state";
import "../styles/files.css";

/** Lines drawn at once; past it a long file offers the rest on a click. */
const LINES_FIRST = 2000;
/** The drawer stands beside the timeline from this width; under it, it covers the view. */
export const BESIDE = "(min-width: 1000px)";

export interface FilesDrawerProps {
  session: SessionSummary;
  control?: MachineControl;
  mode: DrawerMode;
  /** The session's loaded events at the lens: the touches since the index, the problems,
   *  and the full events the index's touches already have here. */
  events: readonly StoredEvent[];
  /** Scrolls the timeline to a row (SessionBody's jumpTo); false when it is not loaded. */
  onJump: (seq: number) => boolean;
  /** Simple mode: the timeline folds its tools, so no jumps and no Problems tab. */
  chat?: boolean;
}

/** This machine's name (Info.hostname), from the Info the control API already reads once
 *  per page, so a path can be said to be here. */
function useHostname(): string | undefined {
  const [name, setName] = useState(() => lastInfo()?.hostname);
  useEffect(() => {
    if (name) return;
    let on = true;
    rpId()
      .then(() => on && setName(lastInfo()?.hostname))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [name]);
  return name;
}

/** The receiver's index of the session's files, read when the drawer opens (and again
 *  on a retry); null while it is on its way or failed, with the error apart. */
function useIndex(session: SessionSummary): { index: SessionFiles | null; error: string | null; retry: () => void } {
  const store = useStore();
  const [index, setIndex] = useState<SessionFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let on = true;
    setError(null);
    store.transport
      .sessionFiles(session.harness, session.id)
      .then((i) => on && setIndex(i))
      .catch((e: unknown) => on && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      on = false;
    };
  }, [store, session.harness, session.id, attempt]);
  return { index, error, retry: () => setAttempt((n) => n + 1) };
}

export function FilesDrawer({ session, control, mode, events, onJump, chat = false }: FilesDrawerProps) {
  const key = session.key;
  const d = useDrawer(key, mode);
  const store = useStore();
  const { index, error: indexError, retry } = useIndex(session);
  // The whole session from the index, and what the live events added since it was read.
  // Before the index lands, the loaded events alone (something to show at once).
  const files = useMemo(() => {
    const since = index ? events.filter((e) => e.session.seq > index.lastSeq) : events;
    return mergeFiles(index?.files ?? [], indexTouches(since, session.cwd));
  }, [index, events, session.cwd]);
  const problems = useMemo(() => problemsOf(events, session.cwd), [events, session.cwd]);
  const hostname = useHostname();
  const local = isThisMachine(session.machine, hostname);
  const entry = d.path ? files.find((f) => f.path === d.path) : undefined;
  const rootRef = useRef<HTMLElement>(null);
  const [status, setStatus] = useState("");
  const announce = useCallback((text: string) => setStatus(text), []);

  // The full events behind a file's touches: from the loaded window when whole there,
  // else the detail route, one at a time, kept for the drawer's life.
  const cache = useRef(new Map<number, StoredEvent>());
  const [cacheRev, setCacheRev] = useState(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const eventAt = useCallback(
    async (seq: number): Promise<StoredEvent | null> => {
      const have = cache.current.get(seq);
      if (have) return have;
      const whole = (e: StoredEvent | undefined) =>
        e && e.preview?.input === undefined && e.preview?.output === undefined ? e : undefined;
      let e = whole(eventsRef.current.find((x) => x.session.seq === seq));
      if (!e) {
        const page = await store.transport.session(session.harness, session.id, { after: seq - 1, limit: 1 });
        e = page.events.find((x) => x.session.seq === seq);
      }
      if (!e) return null;
      cache.current.set(seq, e);
      setCacheRev((n) => n + 1);
      return e;
    },
    [store, session.harness, session.id],
  );
  const cached: EventsBySeq = useMemo(() => new Map(cache.current), [cacheRev]);

  // Opened on a path the events do not name (a stale URL): back to the list, once the
  // index has had its say.
  useEffect(() => {
    if (d.path && index && !entry) setDrawer(key, { path: null }, mode);
  }, [d.path, index, entry, key, mode]);

  // Focus follows the step: into the file's head when one opens, back to its row on the
  // way out, into the filter when the list opens from the keyboard.
  const lastPath = useRef<string | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const was = lastPath.current;
    lastPath.current = d.path;
    if (d.path && !was) root.querySelector<HTMLElement>(".files-title")?.focus({ preventScroll: true });
    else if (!d.path && was) {
      const row = root.querySelector<HTMLElement>(`.files-row[data-path="${CSS.escape(was)}"]`);
      (row ?? root.querySelector<HTMLElement>(".files-filter input"))?.focus({ preventScroll: true });
    }
  }, [d.path]);
  // On open: focus comes in, to the filter or the first row, unless it is already here.
  // The list may still be on its way when the drawer mounts (the events, the index), so
  // this tries again as it fills, until something took it.
  const focused = useRef(false);
  useEffect(() => {
    const root = rootRef.current;
    if (focused.current || !root || d.path) return;
    if (root.contains(document.activeElement)) {
      focused.current = true;
      return;
    }
    const el = root.querySelector<HTMLElement>(".files-filter input, .files-row, .files-problem");
    if (!el) return;
    el.focus({ preventScroll: true });
    focused.current = true;
  }, [d.path, files.length, problems.length]);

  const setTab = (tab: DrawerTab) => setDrawer(key, { tab, path: null }, mode);
  /** One step back, from anywhere: the file to the list, the list away. Esc reaches it
   *  through the app's own dismiss rule (lib/keys.ts) via the hidden button below. */
  const stepBack = () => {
    if (entry) setDrawer(key, { path: null }, mode);
    else closeDrawer(key, mode);
  };
  const onKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && (t as HTMLInputElement).value)) return;
    e.preventDefault();
    e.stopPropagation();
    stepBack();
  };
  const title = entry ? entry.name : d.tab === "problems" ? "Problems" : "Files";
  const Root = mode === "panel" ? "section" : "aside";
  const changedSince =
    d.reviewedSeq === null
      ? 0
      : files.filter((f) => f.touches.some((t) => t.seq > d.reviewedSeq! && t.kind !== "read")).length;
  return (
    <Root
      className={`files files--${mode} ${entry ? "files--file" : ""}`}
      aria-label="Files"
      ref={rootRef as never}
      onKeyDown={onKey}
      data-files-open
    >
      {/* Esc's target (lib/keys.ts clicks the first drawn [data-dismiss]): one step back. */}
      <button type="button" className="sr-only" tabIndex={-1} aria-hidden="true" data-dismiss onClick={stepBack}>
        {entry ? "Back to the files" : "Close files"}
      </button>
      <header className="files-head">
        {entry ? (
          <>
            <button
              type="button"
              className="icon-btn files-back"
              aria-label="Back to the files"
              onClick={() => setDrawer(key, { path: null }, mode)}
            >
              <svg
                viewBox="0 0 20 20"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="M12 5l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {/* The name stays in view however long the folder: the path reads right to left. */}
            <h2 className="files-title" title={entry.path} tabIndex={-1}>
              <span className="files-title-path">
                <span className="files-title-text">
                  {entry.dir ? <span className="files-title-dir">{entry.dir}/</span> : null}
                  {entry.name}
                </span>
              </span>
            </h2>
          </>
        ) : (
          <Segmented
            value={d.tab}
            onChange={setTab}
            label="Files or problems"
            options={[
              { value: "files", label: files.length ? `Files · ${files.length}` : "Files" },
              ...(chat
                ? []
                : [
                    {
                      value: "problems" as const,
                      label: problems.length ? `Problems · ${problems.length}` : "Problems",
                    },
                  ]),
            ]}
          />
        )}
        <span className="files-actions">
          {entry && (
            <FileMenu
              entry={entry}
              session={session}
              local={local}
              chat={chat}
              onJump={onJump}
              viewed={d.viewed.has(entry.path)}
              onViewed={(on) => setViewed(key, entry.path, on, mode)}
              announce={announce}
            />
          )}
          {mode === "page" && (
            <button
              type="button"
              className="icon-btn files-close"
              onClick={() => closeDrawer(key, mode)}
              aria-label="Close files"
              data-tip="Close files"
              data-tip-keys={hintFor("session.files") || undefined}
              data-tip-side="bottom"
            >
              <svg
                viewBox="0 0 20 20"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
              <span className="files-done" aria-hidden="true">
                Done
              </span>
            </button>
          )}
        </span>
      </header>
      <div className="files-body">
        {entry ? (
          <FileView
            key={entry.path}
            entry={entry}
            session={session}
            mode={mode}
            events={cached}
            eventAt={eventAt}
            onJump={chat ? undefined : onJump}
            local={local}
            reviewedSeq={d.reviewedSeq}
            announce={announce}
          />
        ) : d.tab === "problems" && !chat ? (
          <ProblemList problems={problems} onJump={onJump} />
        ) : (
          <FileList
            files={files}
            viewed={d.viewed}
            reviewedSeq={d.reviewedSeq}
            changedSince={changedSince}
            loading={!index && !indexError}
            error={indexError}
            retry={retry}
            onOpen={(p) => setDrawer(key, { path: p }, mode)}
          />
        )}
      </div>
      {d.comments.length > 0 && (
        <Review
          session={session}
          control={control}
          mode={mode}
          comments={d.comments}
          lastSeq={Math.max(index?.lastSeq ?? -1, events[events.length - 1]?.session.seq ?? -1)}
          announce={announce}
        />
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      <span className="sr-only" aria-live="polite">
        {title}
      </span>
    </Root>
  );
}

/** The file's "⋯": viewed, copy its path or a link to it, open it in the timeline, open
 *  it in an editor (and which editor). */
function FileMenu({
  entry,
  session,
  local,
  chat,
  onJump,
  viewed,
  onViewed,
  announce,
}: {
  entry: FileEntry;
  session: SessionSummary;
  local: boolean;
  chat: boolean;
  onJump: (seq: number) => boolean;
  viewed: boolean;
  onViewed: (on: boolean) => void;
  announce: (text: string) => void;
}) {
  const editor = useEditor();
  const href = editor ? editorHref(editor, entry.given, session.cwd) : null;
  const editorName = EDITORS.find((e) => e.id === editor)?.label;
  const link = () => {
    const u = new URL(location.href);
    u.search = `?file=${encodeURIComponent(entry.path)}`;
    u.hash = "";
    return u.href;
  };
  const build = (): MenuList => [
    { label: "Viewed", checked: viewed, run: () => onViewed(!viewed) },
    { sep: true },
    { label: "Copy path", keys: "", run: () => void copyText(entry.path).then(() => announce("Path copied")) },
    entry.given !== entry.path && { label: "Copy full path", run: () => void copyText(entry.given) },
    { label: "Copy link to this file", run: () => void copyText(link()).then(() => announce("Link copied")) },
    !chat && entry.lastSeq >= 0 && { label: "Show in timeline", run: () => void onJump(entry.lastSeq) },
    { sep: true },
    local && {
      label: editorName ? `Open in ${editorName}` : "Open in editor",
      disabled: !editor ? "choose an editor below" : !href ? "the path is not absolute" : undefined,
      run: () => {
        if (href) location.assign(href);
      },
    },
    local && {
      label: "Editor",
      items: [
        ...EDITORS.map((e) => ({ label: e.label, radio: true, checked: editor === e.id, run: () => setEditor(e.id) })),
        { label: "None", radio: true, checked: editor === null, run: () => setEditor(null) },
      ],
    },
  ];
  return (
    <>
      <button
        type="button"
        className="icon-btn files-copy"
        onClick={() => void copyText(entry.path).then(() => announce("Path copied"))}
        aria-label="Copy path"
        data-tip="Copy path"
        data-tip-side="bottom"
      >
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
          <rect x="7" y="7" width="9" height="9" rx="1.5" />
          <path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" />
        </svg>
      </button>
      {local && href && editorName && (
        <a className="icon-btn files-editor" href={href} data-tip={`Open in ${editorName}`} data-tip-side="bottom">
          <span className="sr-only">Open in {editorName}</span>
          <svg
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
            <path d="M8 4H4.5A1.5 1.5 0 0 0 3 5.5v10A1.5 1.5 0 0 0 4.5 17h10a1.5 1.5 0 0 0 1.5-1.5V12" />
            <path d="M11 3h6v6" />
            <path d="M17 3l-7.5 7.5" />
          </svg>
        </a>
      )}
      <MoreButton build={build} title={() => entry.path} className="files-more" />
    </>
  );
}

// ---------- the list ----------

/** What a row says of a file: new, edited n×, read; a failed tool; when. */
function fileFact(f: FileEntry, now: number): { text: string; err: boolean } {
  const bits: string[] = [];
  if (f.created) bits.push("new");
  else if (f.edits + f.writes > 0) bits.push(`edited${f.edits + f.writes > 1 ? ` ×${f.edits + f.writes}` : ""}`);
  if (f.reads > 0 && !f.created) bits.push(`read${f.reads > 1 ? ` ×${f.reads}` : ""}`);
  if (f.pending) bits.push("running");
  if (f.failed > 0) bits.push(`${f.failed} failed`);
  if (f.lastAt) bits.push(ago(f.lastAt, now));
  return { text: bits.join(" · "), err: f.failed > 0 };
}

/** Arrow keys (and j / k) move among a container's focusable rows; Home and End to the
 *  ends. The row focused keeps tabindex 0, the rest -1, so Tab leaves the list in one. */
function roving(e: ReactKeyboardEvent<HTMLElement>, selector: string): HTMLElement | null {
  const keys: Record<string, number> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 };
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const t = e.target as HTMLElement;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return null;
  const step = keys[e.key];
  if (step === undefined && e.key !== "Home" && e.key !== "End") return null;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)];
  if (rows.length === 0) return null;
  const at = rows.indexOf(t.closest(selector) as HTMLElement);
  const next =
    e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (step ?? 0)));
  e.preventDefault();
  e.stopPropagation();
  for (const r of rows) r.tabIndex = -1;
  rows[next]!.tabIndex = 0;
  rows[next]!.focus();
  rows[next]!.scrollIntoView({ block: "nearest" });
  return rows[next]!;
}

function FileList({
  files,
  viewed,
  reviewedSeq,
  changedSince,
  loading,
  error,
  retry,
  onOpen,
}: {
  files: FileEntry[];
  viewed: ReadonlySet<string>;
  reviewedSeq: number | null;
  changedSince: number;
  loading: boolean;
  error: string | null;
  retry: () => void;
  onOpen: (path: string) => void;
}) {
  const [q, setQ] = useState("");
  const now = useNow("coarse");
  const shown = useMemo(() => {
    const query = q.trim();
    if (!query) return files;
    return files
      .map((f) => ({ f, m: fuzzy(query, f.path) }))
      .filter((x) => x.m)
      .sort((a, b) => b.m!.score - a.m!.score)
      .map((x) => x.f);
  }, [files, q]);
  // By folder, folders and files alike in path order (the tree an editor shows), viewed
  // files last in theirs.
  const groups = useMemo(() => {
    if (q.trim()) return [{ dir: null as string | null, files: shown }];
    const by = new Map<string, FileEntry[]>();
    for (const f of shown) by.set(f.dir, [...(by.get(f.dir) ?? []), f]);
    return [...by.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, fs]) => ({ dir, files: fs.sort((a, b) => Number(viewed.has(a.path)) - Number(viewed.has(b.path))) }));
  }, [shown, q, viewed]);
  const changedSinceReview = (f: FileEntry) =>
    reviewedSeq !== null && f.touches.some((t) => t.seq > reviewedSeq && t.kind !== "read");
  const nViewed = files.filter((f) => viewed.has(f.path)).length;
  if (files.length === 0)
    return (
      <div className="state files-empty">
        <h3 className="state-title">{loading ? "Reading the session's files…" : "No files yet"}</h3>
        {!loading && (
          <p className="state-text">
            The files this session reads and changes show here as its tools name them. Tier 3 carries the tool inputs;
            at a lower tier or lens, only a <code>files.changed</code> names one.
          </p>
        )}
        {error && (
          <p className="state-text is-err">
            The receiver's list didn't load.{" "}
            <button type="button" className="fv-link" onClick={retry}>
              Try again
            </button>
          </p>
        )}
      </div>
    );
  return (
    <>
      <div className="files-tools">
        <label className="search files-filter">
          <svg className="search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter files"
            aria-label="Filter files"
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === "Enter" && shown[0]) onOpen(shown[0].path);
              if (e.key === "ArrowDown") {
                e.preventDefault();
                (e.currentTarget.closest(".files-body")?.querySelector(".files-row") as HTMLElement | null)?.focus();
              }
            }}
          />
        </label>
        {(nViewed > 0 || changedSince > 0) && (
          <p className="files-tools-note page-note">
            {changedSince > 0 && (
              <span>
                {changedSince} {changedSince === 1 ? "file" : "files"} changed since your review
              </span>
            )}
            {nViewed > 0 && (
              <span className="num">
                {nViewed} of {files.length} viewed
              </span>
            )}
          </p>
        )}
      </div>
      {error && (
        <p className="page-note files-note is-err">
          Only the loaded turns are listed: the receiver's list didn't load.{" "}
          <button type="button" className="fv-link" onClick={retry}>
            Try again
          </button>
        </p>
      )}
      <ul className="files-list" onKeyDown={(e) => void roving(e, ".files-row")}>
        {groups.map((g) => (
          <li key={g.dir ?? "*"} className="files-group">
            {g.dir !== null && <div className="files-dir ellipsis">{g.dir || "repo root"}</div>}
            <ul>
              {g.files.map((f, i) => {
                const fact = fileFact(f, now);
                const seen = viewed.has(f.path);
                const fresh = changedSinceReview(f);
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      className={`files-row ${seen ? "is-viewed" : ""}`}
                      onClick={() => onOpen(f.path)}
                      data-path={f.path}
                      tabIndex={i === 0 && g === groups[0] ? 0 : -1}
                      aria-label={`${f.path}, ${fact.text}${seen ? ", viewed" : ""}${fresh ? ", changed since your review" : ""}`}
                    >
                      <FileGlyph f={f} viewed={seen} fresh={fresh} />
                      <span className="files-row-name ellipsis mono" title={f.path}>
                        {g.dir === null && f.dir ? <span className="files-row-dir">{f.dir}/</span> : null}
                        {f.name}
                      </span>
                      <span className={`files-row-fact ${fact.err ? "is-err" : ""}`}>{fact.text}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}

/** One glyph per file: a filled dot for a change, a ring for a read only, red for a
 *  failure, a check once viewed, the tint while changed since the review. */
function FileGlyph({ f, viewed, fresh }: { f: FileEntry; viewed: boolean; fresh: boolean }) {
  const changed = f.edits + f.writes > 0;
  const cls = viewed ? "is-viewed" : f.failed > 0 && !changed ? "is-err" : changed ? "is-changed" : "is-read";
  return (
    <span className={`files-glyph ${cls} ${fresh ? "is-fresh" : ""}`} aria-hidden="true">
      {viewed && (
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path
            d="M2 5.2l2 2 4-4.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

// ---------- one file ----------

type View = "changes" | "text";
interface Sel {
  from: number;
  to: number;
}

function FileView({
  entry,
  session,
  mode,
  events,
  eventAt,
  onJump,
  local,
  reviewedSeq,
  announce,
}: {
  entry: FileEntry;
  session: SessionSummary;
  mode: DrawerMode;
  events: EventsBySeq;
  eventAt: (seq: number) => Promise<StoredEvent | null>;
  onJump?: (seq: number) => boolean;
  local: boolean;
  reviewedSeq: number | null;
  announce: (text: string) => void;
}) {
  // The full events behind the touches, fetched once each; a fetch that failed is asked
  // again the next time the file opens.
  const asked = useRef(new Set<number>());
  const [loading, setLoading] = useState(0);
  const [lost, setLost] = useState(0);
  useEffect(() => {
    const todo = entry.touches.filter(
      (t) => !t.pending && t.kind !== "changed" && !events.has(t.seq) && !asked.current.has(t.seq),
    );
    if (todo.length === 0) return;
    for (const t of todo) asked.current.add(t.seq);
    setLoading((n) => n + todo.length);
    for (const t of todo)
      void eventAt(t.seq)
        .then((e) => {
          if (!e) setLost((n) => n + 1);
        })
        .catch(() => {
          asked.current.delete(t.seq);
          setLost((n) => n + 1);
        })
        .finally(() => setLoading((n) => n - 1));
  }, [entry, events, eventAt]);

  const versions = useMemo(() => versionsOf(entry, events), [entry, events]);
  const [version, setVersion] = useState<number | null>(null);
  const vi = version ?? versions.length - 1;
  const current = vi === versions.length - 1;
  const text = useMemo(
    () => fileText(entry, events, current ? undefined : versions[vi]?.until),
    [entry, events, current, versions, vi],
  );
  // Changes first when there are any: edits applied to a read, or a write over a known text.
  const hasDiff =
    !!text.lines &&
    !!text.base &&
    (text.hunks.some((h) => h.applied) || (text.basis?.kind === "write" && text.base.length > 0));
  const [view, setView] = useState<View | null>(null);
  const shownView: View = view ?? (hasDiff ? "changes" : "text");
  const [all, setAll] = useState(false);
  const [sel, setSel] = useState<Sel | null>(null);
  const [wholeFile, setWholeFile] = useState(false);
  const codeRef = useRef<HTMLDivElement>(null);
  const editor = useEditor();
  const lines = text.lines;
  const start = text.start;
  // A selection outlives nothing: the lines change under it, it goes.
  const linesKey = lines ? `${lines.length}:${start}` : "";
  useEffect(() => setSel(null), [linesKey]);

  const excerpt = (from: number, to: number) => (lines ? lines.slice(from - start, to - start + 1).join("\n") : "");
  const pick = (n: number, extend: boolean) =>
    setSel((cur) => {
      if (extend && cur) return { from: Math.min(cur.from, n), to: Math.max(cur.to, n) };
      if (cur && cur.from === n && cur.to === n) return null;
      return { from: n, to: n };
    });
  const hunkAt = (n: number): Hunk | undefined =>
    text.hunks.find((h) => h.applied && h.from !== undefined && h.to !== undefined && n >= h.from && n <= h.to);

  // The keys over the lines: ↑ ↓ move, ⇧ with them extends the comment's range, Enter or
  // c opens the comment, n / p go to the next or previous change.
  const onCodeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
    const focusedLine = Number(t.closest<HTMLElement>("[data-line]")?.dataset.line);
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.shiftKey && sel && focusedLine) {
      const next = roving(e, ".fv-gutter");
      const n = Number(next?.closest<HTMLElement>("[data-line]")?.dataset.line);
      if (n) setSel({ from: Math.min(sel.from, n), to: Math.max(sel.to, n) });
      return;
    }
    if (e.key === "n" || e.key === "p") {
      const marks = [
        ...e.currentTarget.querySelectorAll<HTMLElement>(".fv-line.is-changed, .fv-line.is-add, .fv-line.is-del"),
      ];
      if (!marks.length) return;
      const here = t.closest<HTMLElement>(".fv-line");
      const idx = here ? marks.indexOf(here) : -1;
      // The next run of marks, not the next line of this one.
      let target: HTMLElement | undefined;
      if (e.key === "n") {
        target = marks.find(
          (m, i) =>
            i > idx &&
            (!here || m.compareDocumentPosition(here) & Node.DOCUMENT_POSITION_PRECEDING) &&
            !adjacent(marks, i, -1, here),
        );
        target ??= marks.find((m) => !here || m.compareDocumentPosition(here) & Node.DOCUMENT_POSITION_PRECEDING);
      } else {
        for (let i = marks.length - 1; i >= 0; i--) {
          const m = marks[i]!;
          if (here && !(m.compareDocumentPosition(here) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
          if (adjacent(marks, i, 1, here)) continue;
          target = m;
          break;
        }
      }
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      (target.querySelector<HTMLElement>(".fv-gutter") ?? target).focus();
      target.scrollIntoView({ block: "center" });
      return;
    }
    if ((e.key === "Enter" || e.key === "c") && focusedLine && t.classList.contains("fv-gutter")) {
      e.preventDefault();
      e.stopPropagation();
      pick(focusedLine, false);
      return;
    }
    roving(e, ".fv-gutter");
  };

  const basisWords = (() => {
    if (!text.basis)
      return text.hunks.length ? "No whole text here: the agent edited it without reading it whole." : "";
    const applied = text.hunks.filter((h) => h.applied).length;
    const page = start > 1 ? `, from line ${start}` : "";
    const edits = applied ? `, with ${applied} edit${applied > 1 ? "s" : ""} after it` : "";
    return {
      verb: text.basis.kind === "read" ? "As read at" : "As written at",
      seq: text.basis.seq,
      at: text.basis.at,
      rest: `${page}${edits}.`,
    };
  })();
  const unapplied = text.hunks.filter((h) => !h.applied);
  const fresh = reviewedSeq !== null && entry.touches.some((t) => t.seq > reviewedSeq && t.kind !== "read");
  return (
    <div className="fv">
      <div className="fv-bar">
        {lines && text.base && (
          <Segmented
            value={shownView}
            onChange={setView}
            label="Changes or the whole text"
            options={[
              { value: "changes", label: "Changes" },
              { value: "text", label: "Text" },
            ]}
          />
        )}
        {versions.length > 1 && (
          <fieldset className="fv-versions">
            <legend className="sr-only">Versions</legend>
            <button
              type="button"
              className="icon-btn"
              aria-label="Earlier version"
              disabled={vi <= 0}
              onClick={() => setVersion(vi - 1)}
            >
              <svg
                viewBox="0 0 20 20"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="M12 5l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="num">
              {vi + 1} of {versions.length}
            </span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Later version"
              disabled={current}
              onClick={() => setVersion(vi + 1 >= versions.length - 1 ? null : vi + 1)}
            >
              <svg
                viewBox="0 0 20 20"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="M8 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </fieldset>
        )}
      </div>
      <p className="fv-note page-note">
        {loading > 0 ? (
          <span>Loading the whole text…</span>
        ) : typeof basisWords === "string" ? (
          <span>{basisWords}</span>
        ) : (
          <span>
            {basisWords.verb}{" "}
            {onJump ? (
              <button
                type="button"
                className="fv-link num"
                onClick={() => void onJump(basisWords.seq)}
                title="Show in the timeline"
              >
                {clockTime(basisWords.at)}
              </button>
            ) : (
              <span className="num">{clockTime(basisWords.at)}</span>
            )}
            {basisWords.rest}
            {!current && " An earlier version."}
            {text.failed && <span className="is-err"> The last edit failed.</span>}
            {fresh && <span className="fv-fresh"> Changed since your review.</span>}
          </span>
        )}
        {loading === 0 && (text.missing > 0 || lost > 0) && (
          <span className="is-err">
            Part of the text is still a preview: {text.missing} event{text.missing === 1 ? "" : "s"} did not load.
          </span>
        )}
      </p>
      {lines && shownView === "changes" && text.base && (
        <Changes
          base={text.base}
          lines={lines}
          start={start}
          sel={sel}
          pick={pick}
          hunkAt={hunkAt}
          onKey={onCodeKey}
          codeRef={codeRef}
          form={
            sel && (
              <CommentForm
                session={session}
                mode={mode}
                path={entry.path}
                from={sel.from}
                to={sel.to}
                excerpt={excerpt(sel.from, sel.to)}
                onDone={() => setSel(null)}
                announce={announce}
              />
            )
          }
        />
      )}
      {lines && shownView === "text" && (
        // biome-ignore lint/a11y/noStaticElementInteractions: the keys move focus among the line buttons inside
        <div className="fv-scroll" ref={codeRef} onKeyDown={onCodeKey}>
          <ol
            className="fv-code mono"
            start={start}
            aria-label={`${entry.path}: ${lines.length} lines${lines.length > LINES_FIRST && !all ? `, ${LINES_FIRST} shown` : ""}`}
          >
            {(all ? lines : lines.slice(0, LINES_FIRST)).map((l, i) => {
              const n = start + i;
              const inSel = !!sel && n >= sel.from && n <= sel.to;
              const h = text.changed.has(n) ? hunkAt(n) : undefined;
              return (
                <li
                  key={n}
                  className={`fv-line ${text.changed.has(n) ? "is-changed" : ""} ${inSel ? "is-sel" : ""}`}
                  data-line={n}
                >
                  <button
                    type="button"
                    className="fv-gutter num"
                    onClick={(e) => pick(n, e.shiftKey)}
                    aria-label={`Line ${n}${inSel ? ", selected" : ""}`}
                    tabIndex={i === 0 ? 0 : -1}
                    title={h ? `${toolLabel(h.tool)} at ${clockTime(h.at)}` : undefined}
                  >
                    {n}
                  </button>
                  <span className="fv-text">{l || "​"}</span>
                  {sel && sel.to === n && (
                    <CommentForm
                      session={session}
                      mode={mode}
                      path={entry.path}
                      from={sel.from}
                      to={sel.to}
                      excerpt={excerpt(sel.from, sel.to)}
                      onDone={() => setSel(null)}
                      announce={announce}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {lines && shownView === "text" && !all && lines.length > LINES_FIRST && (
        <button type="button" className="btn btn--sm btn--ghost fv-more" onClick={() => setAll(true)}>
          Show all {lines.length.toLocaleString()} lines
        </button>
      )}
      {unapplied.length > 0 && (
        <section className="fv-hunks">
          <h3 className="fv-hunks-title">
            {lines
              ? `${unapplied.length} edit${unapplied.length > 1 ? "s" : ""} not in this text`
              : `${unapplied.length} edit${unapplied.length > 1 ? "s" : ""}`}
          </h3>
          {unapplied.map((h) => (
            <HunkView key={h.seq} h={h} onJump={onJump} />
          ))}
        </section>
      )}
      {!lines && unapplied.length === 0 && loading === 0 && (
        <div className="state files-empty">
          <h3 className="state-title">Nothing to show yet</h3>
          <p className="state-text">
            {entry.pending
              ? "A tool is still running on this file."
              : "The events name this file but carry none of its text at this lens."}
          </p>
        </div>
      )}
      <p className="page-note fv-foot">
        {!wholeFile && !sel && (
          <button type="button" className="fv-link" onClick={() => setWholeFile(true)}>
            Comment on the whole file
          </button>
        )}
        {local && editor && editorHref(editor, entry.given, session.cwd) && (
          <a href={editorHref(editor, entry.given, session.cwd, sel?.from) ?? undefined}>
            Open {sel ? `line ${sel.from} ` : ""}in {EDITORS.find((e) => e.id === editor)?.label}
          </a>
        )}
      </p>
      {wholeFile && (
        <CommentForm
          session={session}
          mode={mode}
          path={entry.path}
          excerpt=""
          onDone={() => setWholeFile(false)}
          announce={announce}
        />
      )}
    </div>
  );
}

/** Whether `marks[i]` continues the run its neighbour at `i + dir` belongs to (two marked
 *  lines in a row are one change to step over). */
function adjacent(marks: HTMLElement[], i: number, dir: 1 | -1, here: HTMLElement | null): boolean {
  const m = marks[i]!;
  const next = marks[i + dir];
  if (!next || m === here) return false;
  return dir === -1 ? next.nextElementSibling === m : m.nextElementSibling === next;
}

/** The Changes view: the base and the result as one listing, lines taken out in red
 *  with their old number, lines put in with their new one and a comment gutter, the
 *  rest folded past the context and opened in place. */
function Changes({
  base,
  lines,
  start,
  sel,
  pick,
  hunkAt,
  onKey,
  codeRef,
  form,
}: {
  base: string[];
  lines: string[];
  start: number;
  sel: Sel | null;
  pick: (n: number, extend: boolean) => void;
  hunkAt: (n: number) => Hunk | undefined;
  onKey: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  codeRef: RefObject<HTMLDivElement>;
  form: ReactNode;
}) {
  const rows = useMemo(() => diffRows(base, lines, start), [base, lines, start]);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const shown = useMemo(() => {
    const out: DiffRow[] = [];
    for (const r of rows) {
      if (r.kind === "fold" && open.has(r.oldNo)) out.push(...r.lines);
      else out.push(r);
    }
    return out;
  }, [rows, open]);
  const changes = rows.filter((r) => r.kind === "add" || r.kind === "del").length;
  let first = true;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys move focus among the line buttons inside
    <div className="fv-scroll" ref={codeRef} onKeyDown={onKey}>
      <ol className="fv-code fv-code--diff mono" aria-label={`Changes: ${changes} line${changes === 1 ? "" : "s"}`}>
        {shown.map((r, i) => {
          if (r.kind === "fold")
            return (
              <li key={`f${r.oldNo}`} className="fv-fold">
                <button type="button" className="fv-fold-btn" onClick={() => setOpen((s) => new Set(s).add(r.oldNo))}>
                  {r.count} unchanged line{r.count === 1 ? "" : "s"}
                </button>
              </li>
            );
          if (r.kind === "del")
            return (
              <li key={`d${r.oldNo}`} className="fv-line is-del">
                <span className="fv-gutter num" aria-hidden="true">
                  {r.oldNo}
                </span>
                <span className="fv-text">
                  <span className="sr-only">Removed: </span>
                  {r.text || "​"}
                </span>
              </li>
            );
          const n = r.newNo;
          const inSel = !!sel && n >= sel.from && n <= sel.to;
          const tab = first ? 0 : -1;
          first = false;
          const h = r.kind === "add" ? hunkAt(n) : undefined;
          return (
            <li
              key={`n${n}:${i}`}
              className={`fv-line ${r.kind === "add" ? "is-add" : ""} ${inSel ? "is-sel" : ""}`}
              data-line={n}
            >
              <button
                type="button"
                className="fv-gutter num"
                onClick={(e) => pick(n, e.shiftKey)}
                aria-label={`Line ${n}${r.kind === "add" ? ", added" : ""}${inSel ? ", selected" : ""}`}
                tabIndex={tab}
                title={h ? `${toolLabel(h.tool)} at ${clockTime(h.at)}` : undefined}
              >
                {n}
              </button>
              <span className="fv-text">{r.text || "​"}</span>
              {sel && sel.to === n && form}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** One edit the text does not hold (or the only view of one, with no base): what it
 *  replaced and what it wrote, or the patch as sent, or the cell a notebook edit named. */
function HunkView({ h, onJump }: { h: Hunk; onJump?: (seq: number) => boolean }) {
  const menu = useContextMenu(() => [
    h.old !== undefined && { label: "Copy old text", run: () => void copyText(h.old ?? "") },
    h.new !== undefined && { label: "Copy new text", run: () => void copyText(h.new ?? "") },
    h.patch !== undefined && { label: "Copy patch", run: () => void copyText(h.patch ?? "") },
    !!onJump && { label: "Show in timeline", run: () => void onJump(h.seq) },
  ]);
  const block = (text: string | undefined, kind: "del" | "add" | "ctx") =>
    text === undefined || (text === "" && kind !== "add") ? null : (
      <pre className={`fv-diff fv-diff--${kind}`}>
        {text.split("\n").map((l, i) => (
          <span
            key={`${kind}${i}:${l}`}
            className={
              kind === "ctx" ? (l.startsWith("+") ? "is-add" : l.startsWith("-") ? "is-del" : "") : `is-${kind}`
            }
          >
            {l}
            {"\n"}
          </span>
        ))}
      </pre>
    );
  return (
    <div className={`fv-hunk ${h.failed ? "is-failed" : ""}`} {...menu}>
      <div className="fv-hunk-head">
        <span>
          {toolLabel(h.tool)} · <span className="num">{clockTime(h.at)}</span>
          {h.failed ? <span className="is-err"> · failed</span> : null}
          {h.cell ? ` · cell ${h.cell}` : h.tool === "NotebookEdit" ? " · a cell (not shown)" : null}
        </span>
        {onJump && (
          <button type="button" className="fv-link" onClick={() => void onJump(h.seq)}>
            show
          </button>
        )}
      </div>
      {h.patch !== undefined ? block(h.patch, "ctx") : null}
      {h.patch === undefined && (
        <>
          {block(h.old, "del")}
          {block(h.new, "add")}
        </>
      )}
    </div>
  );
}

/** The comment under the selected lines (or on the whole file): what should change, or
 *  what the lines should become. ⌘↵ adds, Esc lets go. */
function CommentForm({
  session,
  mode,
  path,
  from,
  to,
  excerpt,
  onDone,
  announce,
}: {
  session: SessionSummary;
  mode: DrawerMode;
  path: string;
  from?: number;
  to?: number;
  excerpt: string;
  onDone: () => void;
  announce: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [suggest, setSuggest] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const can = !!text.trim() || (suggest !== null && suggest !== excerpt);
  const add = () => {
    if (!can) return;
    addComment(
      session.key,
      {
        id: nonce(),
        path,
        from,
        to,
        excerpt,
        text: text.trim(),
        ...(suggest !== null && suggest !== excerpt ? { suggestion: suggest } : {}),
      },
      mode,
    );
    announce("Comment added");
    onDone();
  };
  const keys = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onDone();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      add();
    }
  };
  return (
    <form
      className="fv-form"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <span className="fv-form-where">
        {from === undefined ? "Whole file" : from === to ? `Line ${from}` : `Lines ${from}–${to}`}
        {from !== undefined && <span className="fv-form-hint"> · shift-click or ⇧↓ to extend</span>}
      </span>
      <textarea
        ref={ref}
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={suggest !== null ? "Why (optional)" : "What should change here?"}
        aria-label="Comment"
        onKeyDown={keys}
      />
      {suggest !== null && (
        <label className="fv-form-suggest">
          <span className="fv-form-suggest-label">Replace with</span>
          <textarea
            className="mono"
            rows={Math.min(12, Math.max(2, suggest.split("\n").length))}
            value={suggest}
            onChange={(e) => setSuggest(e.target.value)}
            aria-label="Replacement"
            spellCheck={false}
            onKeyDown={keys}
          />
        </label>
      )}
      <span className="fv-form-btns">
        {from !== undefined && suggest === null && (
          <button type="button" className="btn btn--sm btn--ghost fv-form-left" onClick={() => setSuggest(excerpt)}>
            Suggest a replacement
          </button>
        )}
        <button type="button" className="btn btn--sm btn--ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn--sm btn--primary" disabled={!can}>
          Add comment
        </button>
      </span>
    </form>
  );
}

// ---------- the review: comments on their way ----------

function Review({
  session,
  control,
  mode,
  comments,
  lastSeq,
  announce,
}: {
  session: SessionSummary;
  control: MachineControl | undefined;
  mode: DrawerMode;
  comments: LineComment[];
  /** The newest event seq here: where "since your review" starts once this goes. */
  lastSeq: number;
  announce: (text: string) => void;
}) {
  const key = session.key;
  const send = useSessionSend(session, control, session.openAttentions);
  const [busy, setBusy] = useState(false);
  const prompt = useMemo(() => reviewPrompt(comments), [comments]);
  const can = !!control && send.secure && !!send.rp;
  const working = session.state === "working" || session.state === "stale";
  const why = !control
    ? `Pair ${session.machine ?? "the machine"} to send from here.`
    : !send.secure || !send.rp
      ? "Sending needs a passkey on this page: add the comments to the message instead."
      : null;
  const n = comments.length;
  const noun = n === 1 ? "comment" : `${n} comments`;
  const sendAll = async () => {
    setBusy(true);
    try {
      await send.onSend({ kind: "prompt", text: prompt });
      reviewed(key, lastSeq, mode);
      announce(`Sent ${noun}`);
    } catch {
      // send.error says why, under the buttons
    } finally {
      setBusy(false);
    }
  };
  const toComposer = () => {
    window.dispatchEvent(new CustomEvent("sp:compose", { detail: { key, text: prompt, append: true } }));
    reviewed(key, lastSeq, mode);
    announce("Added to the message");
    // Words put in the composer want the composer in view: over it (the panel, a narrow
    // page) the drawer steps aside; beside it, it stays.
    if (mode === "panel" || !window.matchMedia(BESIDE).matches) closeDrawer(key, mode);
  };
  return (
    <section className="files-review" aria-label="Review comments">
      <ul className="files-review-list">
        {comments.map((c) => (
          <li key={c.id} className="files-review-item">
            <span className="files-review-where mono" title={c.from === undefined ? c.path : `${c.path}:${c.from}`}>
              {c.path.split("/").pop()}
              {c.from !== undefined && `:${c.from === c.to ? c.from : `${c.from}–${c.to}`}`}
            </span>
            <span className="files-review-text ellipsis">
              {c.suggestion !== undefined && <span className="files-review-kind">suggestion</span>}
              {firstLines(c.text, 1) || (c.suggestion !== undefined ? "Replace the lines" : "")}
            </span>
            <button
              type="button"
              className="icon-btn files-review-x"
              aria-label={`Remove the comment on ${c.path}${c.from !== undefined ? ` line ${c.from}` : ""}`}
              onClick={() => removeComment(key, c.id, mode)}
            >
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
      <div className="files-review-btns">
        <button
          type="button"
          className={`btn btn--sm ${can ? "btn--ghost" : "btn--primary"}`}
          onClick={toComposer}
          title="Add the comments to the message field, to finish by hand"
        >
          Add to message
        </button>
        {can && (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void sendAll()}
          >
            {busy ? "Sending…" : working ? `Send ${noun} after this turn` : `Send ${noun}`}
          </button>
        )}
      </div>
      {(send.error || why || send.tap || (can && working)) && (
        <p className={`page-note files-review-note ${send.error ? "is-err" : ""}`}>
          {send.error ??
            (send.tap
              ? "Confirm with your passkey…"
              : (why ?? "The agent is mid-turn: it reads the review when this turn ends."))}
        </p>
      )}
    </section>
  );
}

// ---------- problems ----------

function ProblemList({ problems, onJump }: { problems: Problem[]; onJump: (seq: number) => boolean }) {
  const now = useNow("coarse");
  if (problems.length === 0)
    return (
      <div className="state files-empty">
        <h3 className="state-title">No problems</h3>
        <p className="state-text">Every tool so far did what it was asked.</p>
      </div>
    );
  return (
    <ul className="files-problems" onKeyDown={(e) => void roving(e, ".files-problem")}>
      {[...problems].reverse().map((p, i) => (
        <li key={p.seq}>
          <button
            type="button"
            className="files-problem"
            onClick={() => void onJump(p.seq)}
            title="Show in the timeline"
            tabIndex={i === 0 ? 0 : -1}
          >
            <span className="files-problem-glyph" aria-hidden="true">
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
                <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
            <span className="files-problem-main">
              <span className="files-problem-head">
                <span className="files-problem-tool">{p.kind === "tool" ? toolLabel(p.tool ?? "tool") : "Error"}</span>
                {p.subject && <span className="files-problem-subject mono ellipsis">{p.subject}</span>}
                <span className="files-problem-when num">{ago(p.at, now)}</span>
              </span>
              <span className="files-problem-text">{p.text}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
