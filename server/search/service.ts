// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service. Session search, orchestrated (SEARCH-SPEC §3.3): one reader over
// the index (engine) with the live tail, one writer (the engine's indexer, in a forked and
// niced child, or in-process when forking fails), the store's titles / machines / labels
// laid over it, and the shapes the routes and the CLI answer with.
//
//   createSearch(deps) → SearchService     the server's (app.ts wires it)
//   runSessionSearch(reader, q, viewer, ctx) the query pipeline, shared with `sessionpipe-gui search`
//
// The server only reads. Everything that writes the index runs in the indexer; the two
// talk over IPC (ToIndexer / FromIndexer). Nothing here blocks the event loop for long:
// every reader call is bounded (engine budget p95 < 50 ms), the rest is bookkeeping.
import { type ChildProcess, fork, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  type Labels,
  type ParsedSearch,
  type SearchFacets,
  type SearchIndexStatus,
  type SearchRevealRequest,
  type SearchSource,
  type SearchTranscript,
  type SessionKey,
  type SessionMatch,
  type SessionSearchHit,
  type SessionSearchPage,
  type SessionSearchQuery,
  type SessionSummary,
  type StreamMessage,
  sessionKey,
} from "../../shared/api.js";
import { isBrowse, isEmptySearch, parseSearch } from "../../shared/searchQuery.js";
import type { Store } from "../store/store.js";
import type { LabelStore } from "../ui/labels.js";
import { computeFacets } from "./facets.js";
import { compileFilters, machineKey } from "./filters.js";
import { decideHint } from "./hints.js";
import { fallbackResume, resumeLine } from "./resume.js";
import {
  type EngineHit,
  type EngineMatch,
  type FromIndexer,
  type IndexedSession,
  type IndexerOptions,
  type IndexerStatus,
  type ReaderOptions,
  type ReaderStats,
  type SearchReader,
  type SearchService,
  type SessionOverlay,
  type SourceAdapter,
  type SourceEnv,
  TITLE_RANK,
  type ToIndexer,
  type Viewer,
} from "./types.js";

// ───────────────────────────── limits (SEARCH-SPEC §3.4) ─────────────────────────────

export const Q_MAX = 1000;
export const LIMIT_DEFAULT = 20;
export const LIMIT_MAX = 100;
export const HITS_DEFAULT = 3;
export const HITS_MAX = 3;
export const TRANSCRIPT_LIMIT_DEFAULT = 60;
export const TRANSCRIPT_LIMIT_MAX = 200;
/** `total` is exact up to here (the engine's promise); the page says `200+` past it. */
export const TOTAL_EXACT = 200;
/** At most one `searchIndex` frame per this. */
export const FRAME_MS = 1000;
/** Boot waits at most this long for the reader to open (it may then finish in the background). */
export const BOOT_WAIT_MS = 300;
/** A pass running longer than this reads as `updating`. */
export const UPDATING_AFTER_MS = 1000;

// ───────────────────────────── the backend: engine + sources ─────────────────────────────

/** What the service needs from the engine and the sources modules. The server loads the
 *  real ones (`loadBackend`); tests hand in their own. */
export interface SearchBackend {
  openReader(o: ReaderOptions): Promise<SearchReader>;
  runIndexer(o: IndexerOptions): Promise<void>;
  removeIndex(dir: string, source: SearchSource): Promise<void>;
  historyAdapters(): SourceAdapter[];
  eventsAdapter(): SourceAdapter;
  eventsPath(stateDir: string, key: SessionKey): string;
  sourceEnv(opts: { home?: string; stateDir: string; hostname: string }): SourceEnv;
  /** Never fork the indexer (the oracle: a child would have nothing to run). */
  inProcessOnly?: boolean;
  /** An in-process indexer that takes the child's messages (hints, commit, forget, …). */
  startIndexer?(o: IndexerOptions): { send(m: ToIndexer): void; done: Promise<void> };
}

/** The engine and the sources, imported on first use (they stay out of the boot path of
 *  anything that never searches). `SPGUI_SEARCH_ENGINE=oracle` (or an engine that does not
 *  load) uses perf's brute-force oracle instead: everything in memory, for small demo homes. */
export async function loadBackend(): Promise<SearchBackend> {
  const sources = await import("./sources/index.js");
  let engine: Pick<SearchBackend, "openReader" | "runIndexer" | "removeIndex" | "inProcessOnly" | "startIndexer">;
  try {
    if (process.env.SPGUI_SEARCH_ENGINE === "oracle") throw new Error("SPGUI_SEARCH_ENGINE=oracle");
    engine = await import("./engine/index.js");
  } catch (e) {
    process.stderr.write(`[sessionpipe-gui] search: using the in-memory oracle (${(e as Error).message})\n`);
    engine = await oracleEngine();
  }
  return {
    openReader: engine.openReader,
    runIndexer: engine.runIndexer,
    removeIndex: engine.removeIndex,
    inProcessOnly: engine.inProcessOnly,
    startIndexer: engine.startIndexer ? (o) => engine.startIndexer!(o) : undefined,
    historyAdapters: sources.historyAdapters,
    eventsAdapter: sources.eventsAdapter,
    eventsPath: sources.eventsPath,
    sourceEnv: sources.sourceEnv,
  };
}

/** The oracle as an engine: the reader reads every file at open; the "indexer" only says
 *  it is idle (and asks for a re-open every 10 s in watch mode, so new events show). */
async function oracleEngine(): Promise<
  Pick<SearchBackend, "openReader" | "runIndexer" | "removeIndex" | "inProcessOnly">
> {
  const { loadOracle } = await import("./oracle.js");
  return {
    inProcessOnly: true,
    openReader: async (o) => {
      if (!o.live) throw new Error("the oracle needs the adapters");
      return loadOracle(o.live.env, o.live.adapters, { sources: o.sources });
    },
    runIndexer: async (o) => {
      const status = (): IndexerStatus => ({ phase: "idle", doneBytes: 1, totalBytes: 1, firstRun: false, gen: {} });
      o.onStatus?.(status());
      if (o.mode === "once") return;
      await new Promise<void>((resolve) => {
        const t = setInterval(() => o.onCommit?.("sessionpipe", Date.now()), 10_000);
        o.signal?.addEventListener("abort", () => {
          clearInterval(t);
          resolve();
        });
      });
    },
    removeIndex: async (dir, source) => {
      rmSync(path.join(dir, source), { recursive: true, force: true });
    },
  };
}

/** What sessionpipe calls this machine (Info.hostname). */
export function thisHostname(): string {
  // SPGUI_HOSTNAME names this machine in the search instead (demos and screenshots).
  return (process.env.SPGUI_HOSTNAME?.trim() || os.hostname()).replace(/\.(local|lan|home)$/i, "");
}

/** `home` for sourceEnv: undefined for the real home, so the person's own CLAUDE_CONFIG_DIR,
 *  CODEX_HOME and GEMINI_CLI_HOME still apply (a synthetic home ignores them). */
export function syntheticHome(home: string | undefined): string | undefined {
  if (!home) return undefined;
  return path.resolve(home) === path.resolve(os.homedir()) ? undefined : home;
}

export function searchDir(stateDir: string): string {
  return path.join(stateDir, "search");
}

/** The folder of one index under `<stateDir>/search` (D22). */
export function indexSubdir(source: SearchSource): string {
  return source === "sessionpipe" ? "events" : "history";
}

/** The sources a reader opens: what sessionpipe delivered, plus history when it is on. */
export function readSources(history: boolean): SearchSource[] {
  return history ? ["sessionpipe", "history"] : ["sessionpipe"];
}

// ───────────────────────────── cursors ─────────────────────────────

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString("base64url");
}

/** The offset a cursor stands for, or undefined when it is not one of ours. */
export function decodeCursor(c: string): number | undefined {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(c)) return undefined;
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as { o?: unknown };
    const o = v?.o;
    return typeof o === "number" && Number.isInteger(o) && o >= 0 && o <= 1_000_000 ? o : undefined;
  } catch {
    return undefined;
  }
}

// ───────────────────────────── the query pipeline (server and CLI) ─────────────────────────────

export interface QueryContext {
  hostname: string;
  /** For `~/…` in a resume line. */
  home?: string;
  labels: () => Labels;
  /** The store's view of a session, when the store knows it (absent in the CLI). */
  summary: (key: SessionKey) => SessionSummary | undefined;
  /** The indexes that can be read (history absent when the setting is off). */
  available: () => readonly SearchSource[];
  status: () => SearchIndexStatus;
  /** The first pass over history is still running (the `indexing` hint). */
  firstRun: () => boolean;
  now?: () => number;
}

const iso = (ms: number): string => new Date(Number.isFinite(ms) && ms > 0 ? ms : 0).toISOString();

const EMPTY_LABELS: Labels = { rev: 0, names: {}, sessions: {} };

function shapeHit(h: EngineHit, fallbackAt: number): SessionSearchHit {
  const out: SessionSearchHit = {
    field: h.field,
    at: iso(h.at || fallbackAt),
    text: h.text,
    marks: h.marks,
    ref: h.ref,
  };
  if (h.tool) out.tool = h.tool;
  if (h.agent) out.agent = h.agentType ? { id: h.agent, type: h.agentType } : { id: h.agent };
  if (h.seq !== undefined) out.seq = h.seq;
  if (h.live) out.live = true;
  return out;
}

/** One engine match → the wire's SessionMatch (SEARCH-SPEC §3.3 step 4). */
export function shapeMatch(m: EngineMatch, viewer: Viewer, ctx: QueryContext): SessionMatch {
  const s = m.session;
  const summary = ctx.summary(s.key);
  const machine = s.machine || summary?.machine || (s.sources.includes("history") ? ctx.hostname : undefined);
  const hasHistory = s.sources.includes("history");
  const hasPipe = s.sources.includes("sessionpipe") || summary !== undefined;
  const title = s.title?.trim() || summary?.title?.trim() || "Untitled session";
  const firstAt = s.firstAt || s.lastAt || (summary ? Date.parse(summary.startedAt) : 0);
  const lastAt = s.lastAt || firstAt;
  const out: SessionMatch = {
    key: s.key,
    harness: s.harness,
    id: s.id,
    source: hasHistory && hasPipe ? "both" : hasHistory ? "history" : "sessionpipe",
    title,
    thisMachine: machine !== undefined && machineKey(machine) === machineKey(ctx.hostname),
    firstAt: iso(firstAt),
    lastAt: iso(lastAt),
    hits: m.hits.map((h) => shapeHit(h, lastAt)),
    moreHits: Math.max(0, m.matched - m.hits.length),
    score: Math.round(m.score * 10_000) / 10_000,
  };
  if (m.titleMarks?.length && s.title?.trim() === title) out.titleMarks = m.titleMarks;
  if (machine) out.machine = machine;
  if (s.account) out.account = s.account;
  const repo = s.repo ?? summary?.repo;
  if (repo) out.repo = repo;
  const cwd = s.cwd ?? summary?.cwd;
  if (cwd) out.cwd = cwd;
  const branch = s.branch ?? summary?.branch;
  if (branch) out.branch = branch;
  if (summary) out.summary = summary;
  const resume = resumeLine(s.resume ?? fallbackResume(s.harness, s.id, cwd), ctx.home);
  if (resume) out.resume = resume;
  if (viewer.local && s.path) out.transcriptPath = s.path;
  if (s.forkOf) out.forkOf = s.forkOf;
  return out;
}

/** A page of sessions for `q` (SEARCH-SPEC §3.3 steps 1–6). Throws a RangeError for a bad
 *  cursor (the route answers 400 `bad_cursor`). */
export function runSessionSearch(
  reader: SearchReader,
  q: SessionSearchQuery,
  viewer: Viewer,
  ctx: QueryContext,
): SessionSearchPage {
  const t0 = performance.now();
  const text = (q.q ?? "").slice(0, Q_MAX);
  const parsed = parseSearch(text, { live: q.live === true });
  const limit = clampInt(q.limit, 1, LIMIT_MAX, LIMIT_DEFAULT);
  const hits = clampInt(q.hits, 0, HITS_MAX, HITS_DEFAULT);
  let offset = 0;
  if (q.cursor) {
    const o = decodeCursor(q.cursor);
    if (o === undefined) throw new RangeError("bad_cursor");
    offset = o;
  }
  const browse = isBrowse(parsed);
  const sort = browse ? "newest" : q.sort === "newest" ? "newest" : "best";
  const page: SessionSearchPage = {
    q: text,
    sort,
    parsed,
    sessions: [],
    total: 0,
    more: false,
    ms: 0,
    index: ctx.status(),
  };
  if (isEmptySearch(parsed)) {
    page.ms = elapsed(t0);
    return page;
  }
  const labels = ctx.labels();
  const now = ctx.now?.() ?? Date.now();
  const f = compileFilters(parsed, {
    hostname: ctx.hostname,
    labels,
    now,
    tz: q.tz ?? 0,
    available: ctx.available(),
  });
  if (f.bad.length)
    page.parsed = { ...parsed, unknown: [...parsed.unknown, ...f.bad.filter((k) => !parsed.unknown.includes(k))] };
  const engineQuery = {
    parsed,
    sources: f.sources,
    fields: f.fields,
    allow: f.allow,
    sort,
    offset,
    limit,
    hits,
  } as const;
  const res = f.sources.length ? reader.search(engineQuery) : { matches: [], total: 0, more: false, unknownWords: [] };
  page.sessions = res.matches.map((m) => shapeMatch(m, viewer, ctx));
  page.total = res.total;
  // The engine's `more` is "another page exists"; the wire's is "past the exact count"
  // (the page then says 200+). The cursor follows the engine's.
  page.more = res.total >= TOTAL_EXACT;
  if (res.more || offset + res.matches.length < res.total) page.cursor = encodeCursor(offset + res.matches.length);
  if (page.sessions.length === 0 && offset === 0) {
    page.hint = decideHint({
      q: text,
      parsed,
      suggestion: "suggestion" in res ? res.suggestion : undefined,
      firstRun: ctx.firstRun(),
      rerun: (next) => {
        const p2 = parseSearch(next, { live: q.live === true });
        const f2 = compileFilters(p2, {
          hostname: ctx.hostname,
          labels,
          now,
          tz: q.tz ?? 0,
          available: ctx.available(),
        });
        if (!f2.sources.length || isEmptySearch(p2)) return false;
        return (
          reader.search({
            parsed: p2,
            sources: f2.sources,
            fields: f2.fields,
            allow: f2.allow,
            sort,
            offset: 0,
            limit: 1,
            hits: 0,
          }).matches.length > 0
        );
      },
    });
  }
  page.ms = elapsed(t0);
  return page;
}

function elapsed(t0: number): number {
  return Math.round((performance.now() - t0) * 10) / 10;
}

function clampInt(v: number | undefined, lo: number, hi: number, dflt: number): number {
  if (v === undefined || !Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}

/** A reader with nothing in it: the service's answer while the real one is missing or broken. */
export function emptyReader(): SearchReader {
  return {
    search: () => ({ matches: [], total: 0, more: false, unknownWords: [], ms: 0 }),
    transcript: () => undefined,
    hitsIn: () => [],
    session: () => undefined,
    sessions: () => [],
    setOverlay: () => {},
    forget: () => {},
    stats: () => ({ gen: {}, sessions: 0, messages: 0, bytes: 0, bySource: [] }),
    refresh: () => false,
    tick: () => {},
    hint: () => {},
    close: () => {},
  };
}

// ───────────────────────────── the service ─────────────────────────────

export interface SearchDeps {
  stateDir: string;
  store: Store;
  labels: LabelStore;
  hostname: string;
  /** --search-home / SPGUI_SEARCH_HOME, else os.homedir(). */
  home?: string;
  /** config.json `searchHistory`. */
  history: () => boolean;
  setHistory: (on: boolean) => void;
  /** The UI stream (Broadcast). */
  broadcast: (m: StreamMessage) => void;
  port: () => number;
  /** dist/cli.js to fork as the indexer; absent → the indexer runs in-process. */
  cliPath?: string;
  quiet?: boolean;
  /** Tests: the engine and sources (default: loadBackend()). */
  backend?: SearchBackend;
  /** Tests: how a folder is shown (default: open -R / explorer /select, / xdg-open). */
  reveal?: (cmd: string, args: string[]) => void;
  /** Tests: the live-tail period (default 1 s; 0 = never on a timer). */
  tickMs?: number;
  /** How long boot waits for the reader before going on without it (default BOOT_WAIT_MS). */
  bootWaitMs?: number;
}

interface IndexerHandle {
  send(m: ToIndexer): void;
  stop(): Promise<void>;
  readonly kind: "child" | "inproc";
}

/** The service. Never throws at boot: a missing or broken index is the `error` state, and
 *  search then answers empty pages until a rebuild. */
export async function createSearch(deps: SearchDeps): Promise<SearchService> {
  const dir = searchDir(deps.stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = (s: string) => {
    if (!deps.quiet) process.stderr.write(`[sessionpipe-gui] search: ${s}\n`);
  };
  const home = deps.home ?? os.homedir();
  let backend: SearchBackend | null = null;
  let backendError: string | undefined;
  try {
    backend = deps.backend ?? (await loadBackend());
  } catch (e) {
    backendError = `The search engine did not load: ${(e as Error).message}`;
    log(backendError);
  }
  const env: SourceEnv | null = backend
    ? backend.sourceEnv({ home: syntheticHome(deps.home), stateDir: deps.stateDir, hostname: deps.hostname })
    : null;
  const adapters = (): SourceAdapter[] =>
    backend ? [backend.eventsAdapter(), ...(deps.history() ? backend.historyAdapters() : [])] : [];
  const allAdapters = (): SourceAdapter[] => (backend ? [backend.eventsAdapter(), ...backend.historyAdapters()] : []);

  let reader: SearchReader = emptyReader();
  /** Whether the open reader runs the live tail (see openOnce). */
  let liveOn = false;
  /** The tail is cheap once history (the big one) has been committed by a finished first run;
   *  what sessionpipe delivered is small, so it never waits for that. */
  const canLive = (): boolean =>
    !firstRun() && (!deps.history() || existsSync(path.join(dir, indexSubdir("history"), "MANIFEST")));
  let readerError: string | undefined;
  let readerGen = 0;
  let closed = false;

  // ── overlays from the store ──
  const overlaySig = new Map<SessionKey, string>();
  let storeVersion = 0;
  const overlayOf = (s: SessionSummary): SessionOverlay => {
    const o: SessionOverlay = {};
    if (s.title) {
      o.title = s.title;
      o.titleRank =
        s.titleSource === "custom"
          ? TITLE_RANK.custom
          : s.titleSource === "harness"
            ? TITLE_RANK.harness
            : TITLE_RANK.firstAsk;
    }
    if (s.machine) o.machine = s.machine;
    if (s.repo) o.repo = s.repo;
    if (s.cwd) o.cwd = s.cwd;
    const last = Date.parse(s.lastAt);
    if (Number.isFinite(last)) o.lastAt = last;
    return o;
  };
  const applyOverlay = (s: SessionSummary, force = false): void => {
    const o = overlayOf(s);
    const sig = `${o.title ?? ""}\u0000${o.titleRank ?? ""}\u0000${o.machine ?? ""}\u0000${o.repo ?? ""}\u0000${o.cwd ?? ""}\u0000${o.lastAt ?? ""}`;
    if (!force && overlaySig.get(s.key) === sig) return;
    overlaySig.set(s.key, sig);
    storeVersion++;
    try {
      reader.setOverlay(s.key, o);
    } catch (e) {
      log(`overlay: ${(e as Error).message}`);
    }
  };
  const applyAllOverlays = (): void => {
    for (const key of deps.store.keys()) {
      const s = deps.store.session(key);
      if (s) applyOverlay(s, true);
    }
  };

  // Opens run one at a time (boot, the history switch), in order.
  let openChain: Promise<void> = Promise.resolve();
  const openNow = (): Promise<void> => {
    const next = openChain.then(openOnce);
    openChain = next.catch(() => {});
    return next;
  };
  const openOnce = async (): Promise<void> => {
    if (closed) return;
    if (!backend || !env) {
      reader = emptyReader();
      readerError = backendError;
      return;
    }
    const old = reader;
    try {
      // onCommitWanted: the live tail grew past its bound, so the writer should commit it.
      const sources = readSources(deps.history());
      // The live tail reads what the writer has not committed yet. With no index at all
      // (a first run) that is everything, read again in this process while the child
      // indexes it: so the tail comes on once each read index has a MANIFEST and the
      // first run is over, and until then the reader serves what the child commits.
      if (!liveOn && canLive()) liveOn = true;
      const o: ReaderOptions & { onCommitWanted?: () => void } = {
        dir,
        sources,
        ...(liveOn ? { live: { env, adapters: adapters() } } : {}),
        onCommitWanted: () => indexer?.send({ t: "commit" }),
      };
      const next = await backend.openReader(o);
      if (closed) {
        next.close();
        return;
      }
      reader = next;
      readerError = undefined;
    } catch (e) {
      reader = emptyReader();
      readerError = `The search index could not be opened: ${(e as Error).message}`;
      log(readerError);
    }
    readerGen++;
    dropStats();
    try {
      old.close();
    } catch {}
    applyAllOverlays();
  };

  // ── the indexer (child or in-process) and its status ──
  let ixStatus: IndexerStatus | undefined;
  let ixError: string | undefined;
  let busySince: number | undefined;
  let indexer: IndexerHandle | null = null;
  let respawnTimer: NodeJS.Timeout | undefined;
  let busyTimer: NodeJS.Timeout | undefined;

  let crashes = 0;
  let firstRunPendingUntil = 0;
  const backoff = (): number => Math.min(300_000, 5_000 * 2 ** Math.max(0, crashes - 1));
  const onIndexerMessage = (m: FromIndexer): void => {
    if (closed || !m || typeof m !== "object") return;
    if (m.t === "status") {
      if (m.status.phase !== "error") crashes = 0;
      // After history is turned on, a status the indexer sent before it heard is stale:
      // hold "first run" until it reports one itself (or 10 s pass).
      if (firstRunPendingUntil) {
        if (m.status.firstRun || Date.now() > firstRunPendingUntil) firstRunPendingUntil = 0;
        else m = { t: "status", status: { ...m.status, firstRun: true } };
      }
      ixStatus = m.status;
      // The first run is over: now the tail is cheap, so the reader gets it.
      if (!liveOn && m.status.phase === "idle" && canLive()) void openNow().then(scheduleFrame);
      ixError = m.status.phase === "error" ? (m.status.error ?? "The indexer stopped with an error.") : undefined;
      const busy = m.status.phase !== "idle" && m.status.phase !== "error";
      if (busy && busySince === undefined) {
        busySince = Date.now();
        clearTimeout(busyTimer);
        busyTimer = setTimeout(scheduleFrame, UPDATING_AFTER_MS + 5);
        busyTimer.unref?.();
      } else if (!busy) busySince = undefined;
      scheduleFrame();
    } else if (m.t === "committed") {
      // The oracle holds everything in memory: "committed" means read it all again.
      if (backend?.inProcessOnly) {
        void openNow().then(scheduleFrame);
        return;
      }
      try {
        reader.refresh();
        dropStats();
      } catch (e) {
        log(`refresh: ${(e as Error).message}`);
      }
      scheduleFrame();
    } else if (m.t === "error") {
      ixError = m.message;
      scheduleFrame();
    }
  };

  /** The child's argv (engine.indexerChildMain reads it): the real home is left implicit so
   *  CLAUDE_CONFIG_DIR / CODEX_HOME still apply there. */
  const childArgs = (): string[] => {
    const synthetic = syntheticHome(deps.home);
    return [
      "index",
      "--ipc",
      "--state",
      deps.stateDir,
      ...(synthetic ? ["--search-home", synthetic] : []),
      ...(deps.history() ? [] : ["--no-history"]),
      "--hostname",
      deps.hostname,
    ];
  };

  const startChild = (cliPath: string): IndexerHandle | null => {
    let child: ChildProcess;
    try {
      child = fork(cliPath, childArgs(), {
        serialization: "advanced",
        stdio: ["ignore", "ignore", deps.quiet ? "ignore" : "inherit", "ipc"],
        env: { ...process.env, SPGUI_SEARCH_CHILD: "1" },
      });
    } catch (e) {
      log(`indexer fork failed (${(e as Error).message}); indexing in-process`);
      return null;
    }
    if (child.pid !== undefined) {
      try {
        os.setPriority(child.pid, 10);
      } catch {}
    }
    let exited = false;
    const exitedP = new Promise<void>((resolve) => {
      child.once("exit", (code, signal) => {
        exited = true;
        if (indexer === handle) indexer = null;
        if (!closed) {
          // Idle exit (2 min): back for the next sweep, or sooner on a hint. A crash: back
          // after a pause that doubles each time (5 s … 5 min), so a broken index never spins.
          if (code === 0) scheduleRespawn(30_000);
          else {
            crashes++;
            log(`indexer exited (${signal ?? code}); retrying in ${Math.round(backoff() / 1000)} s`);
            if (crashes >= 3) ixError = "The indexer keeps stopping. Search still covers what is already indexed.";
            scheduleRespawn(backoff());
          }
        }
        resolve();
      });
    });
    child.on("message", (m) => onIndexerMessage(m as FromIndexer));
    child.on("error", (e) => {
      log(`indexer: ${e.message}`);
    });
    const handle: IndexerHandle = {
      kind: "child",
      send: (m) => {
        if (exited || !child.connected) return;
        try {
          child.send(m);
        } catch {}
      },
      stop: async () => {
        if (exited) return;
        handle.send({ t: "stop" });
        const kill = setTimeout(() => child.kill("SIGTERM"), 3000);
        const hard = setTimeout(() => child.kill("SIGKILL"), 6000);
        await exitedP;
        clearTimeout(kill);
        clearTimeout(hard);
      },
    };
    return handle;
  };

  /** The same indexer in this process (tests, or a platform where forking fails). It takes
   *  no hints; it finds changes by its own 1 s hot set and 30 s sweep. */
  const startInProcess = (rebuild = false): IndexerHandle | null => {
    if (!backend || !env) return null;
    if (backend.startIndexer) {
      const ix = backend.startIndexer({
        dir,
        env,
        adapters: allAdapters(),
        history: deps.history(),
        rebuild,
        mode: "watch",
        onStatus: (status) => onIndexerMessage({ t: "status", status }),
        onCommit: (source, gen) => onIndexerMessage({ t: "committed", source, gen }),
      });
      let done = false;
      const finished = ix.done
        .catch((e: Error) => {
          if (!closed) onIndexerMessage({ t: "error", message: e.message });
        })
        .then(() => {
          done = true;
          if (indexer === h) indexer = null;
          if (!closed) scheduleRespawn(30_000);
        });
      const h: IndexerHandle = {
        kind: "inproc",
        send: (m) => {
          if (!done) ix.send(m);
        },
        stop: async () => {
          if (!done) ix.send({ t: "stop" });
          await finished;
        },
      };
      return h;
    }
    const ac = new AbortController();
    const b = backend;
    const e = env;
    const run = (opts: { rebuild?: boolean; history: boolean }): Promise<void> =>
      b
        .runIndexer({
          dir,
          env: e,
          adapters: opts.history ? allAdapters() : [b.eventsAdapter()],
          history: opts.history,
          rebuild: opts.rebuild,
          mode: "watch",
          signal: ac.signal,
          onStatus: (status) => onIndexerMessage({ t: "status", status }),
          onCommit: (source, gen) => onIndexerMessage({ t: "committed", source, gen }),
        })
        .catch((e: Error) => {
          if (!ac.signal.aborted) onIndexerMessage({ t: "error", message: e.message });
        });
    const running = run({ rebuild, history: deps.history() }).then(() => {
      if (indexer === handle) indexer = null;
      if (!closed && !ac.signal.aborted) scheduleRespawn(30_000);
    });
    const handle: IndexerHandle = {
      kind: "inproc",
      send: (m) => {
        // Rebuild and history are restarts; hints, commits and forgets it finds by itself.
        if (m.t === "rebuild" || m.t === "history" || m.t === "stop") {
          ac.abort();
          if (m.t !== "stop") {
            void running.then(() => {
              if (closed) return;
              indexer = startInProcess(m.t === "rebuild");
            });
          }
        }
      },
      stop: async () => {
        ac.abort();
        await running;
      },
    };
    return handle;
  };

  const startIndexer = (rebuild = false): void => {
    if (closed || indexer || !backend) return;
    clearTimeout(respawnTimer);
    respawnTimer = undefined;
    indexer = (deps.cliPath && !backend.inProcessOnly ? startChild(deps.cliPath) : null) ?? startInProcess(rebuild);
    if (rebuild && indexer?.kind === "child") indexer.send({ t: "rebuild" });
  };
  const scheduleRespawn = (ms: number): void => {
    if (closed || respawnTimer) return;
    respawnTimer = setTimeout(() => {
      respawnTimer = undefined;
      startIndexer();
    }, ms);
    respawnTimer.unref?.();
  };

  // ── status and its frames ──
  const firstRun = (): boolean => {
    if (!deps.history()) return false;
    if (ixStatus) return ixStatus.firstRun;
    // Before the indexer has said anything: a first run when history was never committed.
    return backend !== null && !existsSync(path.join(dir, indexSubdir("history"), "MANIFEST"));
  };
  // Every answer carries the status; the reader's stats are cached for a moment (and
  // dropped whenever the index moves), so a keystroke never pays for counting.
  let statsVal: ReaderStats | undefined;
  let statsAt = 0;
  const STATS_MS = 500;
  const stats = (): ReaderStats => {
    const now = Date.now();
    if (statsVal && now - statsAt < STATS_MS) return statsVal;
    try {
      statsVal = reader.stats();
    } catch {
      statsVal = { gen: {}, sessions: 0, messages: 0, bytes: 0, bySource: [] };
    }
    statsAt = now;
    return statsVal;
  };
  const dropStats = (): void => {
    statsVal = undefined;
  };
  const computeStatus = (): SearchIndexStatus => {
    const st = stats();
    const history = deps.history();
    const out: SearchIndexStatus = {
      state: "ready",
      sessions: st.sessions,
      messages: st.messages,
      bytes: st.bytes,
      history,
      sources: st.bySource.filter((b) => b.sessions > 0 && (history || b.source !== "history")),
    };
    if (st.updatedAt) out.updatedAt = iso(st.updatedAt);
    const error = readerError ?? ixError;
    if (error) {
      out.state = "error";
      out.error = error;
    } else if (!history) out.state = "off";
    else if (firstRun()) {
      out.state = "first-run";
      const total = ixStatus?.totalBytes ?? 0;
      out.progress = total > 0 ? Math.min(1, Math.round(((ixStatus?.doneBytes ?? 0) / total) * 1000) / 1000) : 0;
    } else if (busySince !== undefined && Date.now() - busySince > UPDATING_AFTER_MS) out.state = "updating";
    if (ixStatus?.skipped?.length) out.skipped = ixStatus.skipped;
    return out;
  };

  let lastFrame = "";
  let lastFrameAt = 0;
  let frameTimer: NodeJS.Timeout | undefined;
  function scheduleFrame(): void {
    if (closed || frameTimer) return;
    const wait = Math.max(0, lastFrameAt + FRAME_MS - Date.now());
    const fire = (): void => {
      frameTimer = undefined;
      if (closed) return;
      const status = computeStatus();
      const text = JSON.stringify(status);
      if (text === lastFrame) return;
      lastFrame = text;
      lastFrameAt = Date.now();
      writeServerJson();
      deps.broadcast({ kind: "searchIndex", status });
    };
    if (wait === 0) fire();
    else {
      frameTimer = setTimeout(fire, wait);
      frameTimer.unref?.();
    }
  }

  // ── server.json: how `sessionpipe-gui index` finds us ──
  const serverJson = path.join(dir, "server.json");
  let writtenPort = -1;
  function writeServerJson(): void {
    const port = deps.port();
    if (closed || !port || port === writtenPort) return;
    try {
      const tmp = `${serverJson}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, port })}\n`, { mode: 0o600 });
      renameSync(tmp, serverJson);
      writtenPort = port;
    } catch (e) {
      log(`server.json: ${(e as Error).message}`);
    }
  }

  // ── boot ──
  // Opening awaits the live tail's first pass. With an index that is quick (≈ 0.1 s); with
  // none yet and a big history it is seconds, and the server must not wait for it: after
  // BOOT_WAIT_MS the app starts and the reader comes in when ready (status: first-run).
  const opened = openNow().then(() => {
    // One throwaway query, so the first real one does not pay the JIT.
    try {
      reader.search({
        parsed: parseSearch("warmup"),
        sources: readSources(deps.history()),
        sort: "best",
        offset: 0,
        limit: 1,
        hits: 1,
      });
    } catch {}
    lastFrame = "";
    scheduleFrame();
  });
  await Promise.race([opened, sleep(deps.bootWaitMs ?? BOOT_WAIT_MS)]);
  startIndexer();
  writeServerJson();

  // ── the store and labels ──
  let hinted = false;
  const pendingHints = new Set<string>();
  let hintTimer: NodeJS.Timeout | undefined;
  const flushHints = (): void => {
    hintTimer = undefined;
    if (!pendingHints.size) return;
    if (!indexer && crashes === 0) startIndexer();
    for (const p of pendingHints) indexer?.send({ t: "hint", path: p });
    pendingHints.clear();
  };
  const unsubStore = deps.store.subscribe((m) => {
    if (closed) return;
    if (m.kind === "session") applyOverlay(m.session);
    else if (m.kind === "event") {
      if (overlaySig.get(m.session.key) === undefined) applyOverlay(m.session);
      if (!backend) return;
      const p = backend.eventsPath(deps.stateDir, m.session.key);
      try {
        reader.hint(p);
      } catch {}
      hinted = true;
      pendingHints.add(p);
      if (!hintTimer) {
        hintTimer = setTimeout(flushHints, 200);
        hintTimer.unref?.();
      }
    } else if (m.kind === "forgotten") {
      overlaySig.delete(m.key);
      storeVersion++;
      try {
        reader.forget(m.key);
        dropStats();
      } catch {}
      indexer?.send({ t: "forget", key: m.key });
    }
  });
  const unsubLabels = deps.labels.subscribe(() => {
    storeVersion++;
  });

  // The live tail: complete lines past the committed offsets of the hot files.
  const tickMs = deps.tickMs ?? 1000;
  const tick = (): void => {
    hinted = false;
    try {
      reader.tick();
    } catch (e) {
      log(`tick: ${(e as Error).message}`);
    }
  };
  const tickTimer = tickMs > 0 ? setInterval(tick, tickMs) : undefined;
  tickTimer?.unref?.();

  const ctx: QueryContext = {
    hostname: deps.hostname,
    home,
    labels: () => deps.labels.get() ?? EMPTY_LABELS,
    summary: (key) => deps.store.session(key),
    available: () => readSources(deps.history()),
    status: () => computeStatus(),
    firstRun,
  };

  // ── facets, cached per (generations, store/labels version, reader) ──
  let facetsKey = "";
  let facetsVal: SearchFacets = { agents: [], machines: [], repos: [], labels: [] };

  const sessionFor = (key: SessionKey): IndexedSession | undefined => {
    try {
      return reader.session(key);
    } catch {
      return undefined;
    }
  };

  const svc: SearchService = {
    search(q, viewer) {
      if (hinted) tick();
      return runSessionSearch(reader, q, viewer, ctx);
    },

    transcript(harness, id, q, viewer) {
      if (hinted) tick();
      const key = sessionKey(harness, id);
      const s = sessionFor(key);
      if (!s) return undefined;
      const limit = clampInt(q.limit, 1, TRANSCRIPT_LIMIT_MAX, TRANSCRIPT_LIMIT_DEFAULT);
      const win = reader.transcript(key, { around: q.around, before: q.before, after: q.after, limit });
      if (!win) return undefined;
      let parsed: ParsedSearch | undefined;
      const text = (q.q ?? "").slice(0, Q_MAX);
      if (text.trim()) parsed = parseSearch(text, { live: true });
      const out: SearchTranscript = {
        session: shapeMatch({ session: s, score: 0, hits: [], matched: 0 }, viewer, ctx),
        messages: win.messages.map((h) => {
          const m: SearchTranscript["messages"][number] = {
            ref: h.ref,
            field: h.field,
            at: iso(h.at || s.lastAt),
            text: h.text,
          };
          if (h.tool) m.tool = h.tool;
          if (h.agent) m.agent = h.agentType ? { id: h.agent, type: h.agentType } : { id: h.agent };
          if (h.seq !== undefined) m.seq = h.seq;
          return m;
        }),
        hits: parsed?.clauses.some((c) => !c.not) ? reader.hitsIn(key, parsed) : [],
      };
      if (win.before) out.before = win.before;
      if (win.after) out.after = win.after;
      return out;
    },

    facets() {
      const st = stats();
      const key = `${readerGen}|${JSON.stringify(st.gen)}|${st.sessions}|${storeVersion}|${deps.labels.get().rev}|${deps.history()}`;
      if (key !== facetsKey) {
        facetsVal = computeFacets(reader.sessions(), deps.labels.get(), deps.hostname);
        facetsKey = key;
      }
      return facetsVal;
    },

    status(viewer) {
      writeServerJson();
      const s = computeStatus();
      if (viewer) s.local = viewer.local;
      return s;
    },

    reindex(rebuild) {
      if (closed) return computeStatus();
      ixError = undefined;
      crashes = 0;
      if (rebuild) {
        if (indexer) indexer.send({ t: "rebuild" });
        else startIndexer(true);
        busySince = Date.now();
      } else if (indexer) indexer.send({ t: "commit" });
      else startIndexer();
      scheduleFrame();
      return computeStatus();
    },

    async setHistory(on) {
      if (closed) return computeStatus();
      if (on === deps.history()) return computeStatus();
      if (!on) {
        // The writer deletes history/ (it holds the LOCK); wait for that, then read without it.
        const histDir = path.join(dir, "history");
        if (indexer?.kind === "child") {
          indexer.send({ t: "history", on: false });
          const t0 = Date.now();
          while (existsSync(histDir) && Date.now() - t0 < 3000 && indexer?.kind === "child") await sleep(50);
        } else {
          await indexer?.stop();
          indexer = null;
        }
        deps.setHistory(false);
        if (existsSync(histDir) && backend) {
          // No child to do it (in-process, or it did not answer): stop it and remove it here.
          await indexer?.stop();
          indexer = null;
          try {
            await backend.removeIndex(dir, "history");
          } catch (e) {
            log(`remove history: ${(e as Error).message}`);
            rmSync(histDir, { recursive: true, force: true });
          }
        }
        ixStatus = ixStatus ? { ...ixStatus, firstRun: false, skipped: undefined } : undefined;
        await openNow();
        if (!indexer) startIndexer();
      } else {
        deps.setHistory(true);
        liveOn = false;
        // A first run until the indexer says otherwise (it starts from nothing: history/ is gone).
        ixStatus = { phase: "scanning", doneBytes: 0, totalBytes: 0, firstRun: true, gen: {} };
        firstRunPendingUntil = Date.now() + 10_000;
        await openNow();
        if (indexer?.kind === "child") indexer.send({ t: "history", on: true });
        else {
          await indexer?.stop();
          indexer = null;
          startIndexer();
        }
      }
      lastFrame = "";
      scheduleFrame();
      return computeStatus();
    },

    async reveal(r: SearchRevealRequest) {
      const key = sessionKey(r.harness, r.id);
      const s = sessionFor(key);
      const summary = deps.store.session(key);
      if (!s && !summary) return "gone";
      const machine = s?.machine || summary?.machine || (s?.sources.includes("history") ? deps.hostname : undefined);
      if (!machine || machineKey(machine) !== machineKey(deps.hostname)) return "not_here";
      const target = r.what === "transcript" ? s?.path : (s?.cwd ?? summary?.cwd);
      if (!target || !path.isAbsolute(target)) return "gone";
      try {
        statSync(target);
      } catch {
        return "gone";
      }
      // Reveal = show it selected in its parent folder (UX §5.2); Linux has no "select", so
      // the parent folder opens.
      const [cmd, args] =
        process.platform === "darwin"
          ? ["open", ["-R", target]]
          : process.platform === "win32"
            ? ["explorer", [`/select,${target}`]]
            : ["xdg-open", [path.dirname(target)]];
      (deps.reveal ?? openDetached)(cmd, args);
      return "ok";
    },

    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(respawnTimer);
      clearTimeout(busyTimer);
      clearTimeout(frameTimer);
      clearTimeout(hintTimer);
      if (tickTimer) clearInterval(tickTimer);
      unsubStore();
      unsubLabels();
      await indexer?.stop();
      indexer = null;
      try {
        reader.close();
      } catch {}
      try {
        const cur = JSON.parse(readFileSync(serverJson, "utf8")) as { pid?: number };
        if (cur.pid === process.pid) rmSync(serverJson, { force: true });
      } catch {}
    },
  };
  return svc;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function openDetached(cmd: string, args: string[]): void {
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {}
}
