// SPDX-License-Identifier: Apache-2.0
// Owned by: search lead. The contracts between the search modules (SEARCH-SPEC.md §3):
//   sources (server/search/sources/**)  → SearchDoc / SessionFacts through a DocSink
//   engine  (server/search/engine/**)   → SearchReader (query side) + runIndexer (writer side)
//   service (server/search/service.ts)  → SearchService, the routes and the CLI over both
// Types only (plus a few constants every side must agree on). A change here is a change of
// contract: ask the lead, change it in one commit, tell every owner.
import type {
  ParsedSearch,
  SearchDocField,
  SearchFacets,
  SearchIndexStatus,
  SearchMark,
  SearchRevealRequest,
  SearchSort,
  SearchSource,
  SearchTranscript,
  SessionKey,
  SessionSearchPage,
  SessionSearchQuery,
} from "../../shared/api.js";

export type { ParsedSearch, SearchDocField, SearchMark, SearchSort, SearchSource, SessionKey };

// ───────────────────────────── documents (sources → engine) ─────────────────────────────

/** A message's text is cut to this many UTF-16 units (at a word boundary) before it is emitted. */
export const DOC_TEXT_MAX = 32_768;
/** A tool line (`Bash  pnpm test …`) is cut to this many. */
export const TOOL_LINE_MAX = 300;

/** One searchable message: one prompt, one reply, or one tool call line. */
export interface SearchDoc {
  /** `sessionKey(harness, id)` with the receiver's harness names (`claude-code`, `codex`,
   *  `antigravity`, `gemini-cli`). A subagent's message carries its PARENT's key. */
  key: SessionKey;
  field: SearchDocField;
  /** Epoch ms of the message; 0 when the record has none (the engine keeps file order). */
  at: number;
  /** Already through sessionpipe-core's `redactSecrets`, harness notices and wrappers
   *  removed, at most DOC_TEXT_MAX. Never tool output, never thinking. */
  text: string;
  /** Byte offset of the record's line in its file (append files), or the record's ordinal
   *  (whole files). With the file it is the doc's identity and its jump target. */
  offset: number;
  /** The tool's name (`Bash`, `Read`, `mcp__github__search_issues`) on a `tool` doc. */
  tool?: string;
  /** Set when the message is a subagent's: Claude `agentId`, Codex child thread id. */
  agent?: string;
  /** The subagent's type when known (`Explore`, `general-purpose`). */
  agentType?: string;
  /** A sessionpipe event's seq (events source only). */
  seq?: number;
}

/** Title priority. A higher rank wins; equal ranks: the newer one. */
export const TITLE_RANK = {
  /** A person named it (Claude `custom-title`, the store's `title_source: custom`). */
  custom: 50,
  /** Claude `agent-name`. */
  agentName: 40,
  /** The harness named it (Codex `session_index` thread name, the store's `harness`). */
  harness: 30,
  /** Claude `ai-title`. */
  aiTitle: 25,
  /** Claude `summary`. */
  summary: 15,
  /** The first prompt, cut at 80 chars on a word. */
  firstAsk: 10,
} as const;

/** How to resume a session in a terminal. The service quotes it into one line. Only for a
 *  harness whose resume is verified (Claude Code `claude --resume`, Codex `codex resume`). */
export interface ResumeSpec {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** Session metadata a source learned. The engine folds facts per key in commit order: the
 *  newest value wins per field, `title` by TITLE_RANK, `firstAt` min, `lastAt` max. */
export interface SessionFacts {
  key: SessionKey;
  harness: string;
  id: string;
  title?: { text: string; rank: number };
  cwd?: string;
  branch?: string;
  /** `owner/name` when the source knows it (sessionpipe sends it; history: from git remote
   *  if cheap, else absent — the service falls back to the folder). */
  repo?: string;
  model?: string;
  /** sessionpipe events: the session block's machine. History: absent (= this machine). */
  machine?: string;
  /** Claude account home label (`work` for ~/.claude-work); absent for the default home. */
  account?: string;
  firstAt?: number;
  lastAt?: number;
  forkOf?: SessionKey;
  resume?: ResumeSpec;
  /** The session's main transcript file, absolute (history only). */
  path?: string;
}

/** Where adapters look. Built once by the service (or the CLI) from the real process. */
export interface SourceEnv {
  /** os.homedir(). Tests and the bench point it at a fixture home. */
  home: string;
  /** The GUI's state dir (the events source reads `<stateDir>/events/**`). */
  stateDir: string;
  /** Info.hostname: what sessionpipe calls this machine. */
  hostname: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
}

export type SourceId = "claude" | "codex" | "antigravity" | "gemini" | "events";

export interface SourceFile {
  /** Absolute, the identity of the file in the manifest. */
  path: string;
  adapter: SourceId;
  /** append: JSONL read by byte offset (a partial last line waits). whole: re-read
   *  completely whenever (size, mtime) changes (JSON chats, markdown steps, `.jsonl.zst`). */
  kind: "append" | "whole";
  size: number;
  mtimeMs: number;
  /** When the path alone names the session (most files); else the adapter's facts do. */
  key?: SessionKey;
}

/** JSON-serialisable state an adapter keeps per file between reads (≤ 4 KB, persisted in
 *  the manifest with the offset): title candidates, the Codex replay boundary, cwd seen. */
export type AdapterState = string | number | boolean | null | AdapterState[] | { [k: string]: AdapterState };

export interface ReadCursor {
  /** append: the byte after the last complete line read. whole: always 0. */
  offset: number;
  state?: AdapterState;
}

export interface ReadResult {
  /** append: the byte after the last complete line consumed (a partial line is not). */
  offset: number;
  state?: AdapterState;
  /** Lines that did not parse or were cut: counted, never fatal. */
  bad?: number;
  /** The file could not be read here at all (no zstd); the engine counts it in the status
   *  and tries again on the next sweep only if its (size, mtime) changes. */
  skipped?: "zstd" | "unreadable";
}

export interface DocSink {
  doc(d: SearchDoc): void;
  facts(f: SessionFacts): void;
}

export interface ReadOptions {
  /** Stop after about this many bytes (the engine reads big files in slices and yields). */
  maxBytes?: number;
  /** The live tail reads only up to here (the file may still grow). */
  endOffset?: number;
  signal?: AbortSignal;
}

/** One harness's history format (or sessionpipe's own event files). */
export interface SourceAdapter {
  id: SourceId;
  source: SearchSource;
  /** Walk + stat. Newest first is not required (the engine sorts). Must be cheap: ≤ 20 ms
   *  warm for ~800 files. Missing folders are an empty list, never an error. */
  discover(env: SourceEnv): Promise<SourceFile[]>;
  /** Folders whose mtime moving means "discover again" (new sessions, new subagents). */
  roots(env: SourceEnv): string[];
  /** Emit the docs and facts in `file` from `from`. The engine has already decided the file
   *  is unchanged-but-grown (append from `from.offset`) or new/replaced (offset 0, its old
   *  docs tombstoned). Never throws for bad content; throws only for IO it cannot recover. */
  read(file: SourceFile, from: ReadCursor, sink: DocSink, opts?: ReadOptions): Promise<ReadResult>;
}

// ───────────────────────────── the query side (engine → service) ─────────────────────────────

/** What the engine knows of one session: its folded facts plus the service's overlay. */
export interface IndexedSession {
  key: SessionKey;
  harness: string;
  id: string;
  /** Which indexes hold docs for it. */
  sources: SearchSource[];
  title?: string;
  titleRank: number;
  cwd?: string;
  branch?: string;
  repo?: string;
  machine?: string;
  account?: string;
  /** Epoch ms. */
  firstAt: number;
  lastAt: number;
  /** Docs (messages) indexed, both sources, after de-duplication. */
  messages: number;
  forkOf?: SessionKey;
  resume?: ResumeSpec;
  path?: string;
}

/** What the store knows better than the logs: set by the service on store `session` frames. */
export interface SessionOverlay {
  title?: string;
  titleRank?: number;
  machine?: string;
  repo?: string;
  cwd?: string;
  lastAt?: number;
}

export interface EngineQuery {
  parsed: ParsedSearch;
  /** Which indexes to read (history is left out when the setting is off or `source:` says). */
  sources: readonly SearchSource[];
  /** `in:` — restrict clauses to these fields ("title" = the title index only). */
  fields?: readonly (SearchDocField | "title")[];
  /** The service's filters (agent, machine, repo, label, since, until), asked once per
   *  session per query before any posting is read. */
  allow?: (s: IndexedSession) => boolean;
  sort: SearchSort;
  offset: number;
  limit: number;
  /** Hits with text per session, 0–3. */
  hits: number;
  /** Snippet window, default 160, at most 240. */
  snippetChars?: number;
}

export interface EngineHit {
  field: SearchDocField;
  tool?: string;
  agent?: string;
  agentType?: string;
  /** Epoch ms. */
  at: number;
  text: string;
  marks: SearchMark[];
  /** Opaque and URL-safe (`[A-Za-z0-9_-]`), stable while the file is unchanged. */
  ref: string;
  seq?: number;
  live?: boolean;
}

export interface EngineMatch {
  session: IndexedSession;
  score: number;
  titleMarks?: SearchMark[];
  /** ≤ EngineQuery.hits, in transcript order. */
  hits: EngineHit[];
  /** Matching docs in the session (for "N more matches"). */
  matched: number;
}

export interface EngineResult {
  matches: EngineMatch[];
  /** Sessions matching, exact up to 200. */
  total: number;
  more: boolean;
  /** Positive word clauses with no document at all (for the "spelling" hint). */
  unknownWords: string[];
  /** A near dictionary term for the first unknown word (edit distance ≤ 1–2, df ≥ 3). */
  suggestion?: { word: string; instead: string };
  ms: number;
}

export interface TranscriptWindow {
  messages: EngineHit[];
  before?: string;
  after?: string;
}

export interface ReaderStats {
  /** Committed manifest generation per index. */
  gen: Partial<Record<SearchSource, number>>;
  sessions: number;
  messages: number;
  /** Bytes on disk, both indexes. */
  bytes: number;
  /** Per harness and source, only non-zero. */
  bySource: { harness: string; source: SearchSource; homes: string[]; sessions: number }[];
  /** Epoch ms of the newest commit. */
  updatedAt?: number;
}

/** The read side: in the server and in `sessionpipe-gui search`. Lock-free; never writes
 *  the index. Every call is synchronous and bounded (p95 < 50 ms on 100k+ messages). */
export interface SearchReader {
  search(q: EngineQuery): EngineResult;
  /** A window of one session's messages in transcript order, from the index's text store. */
  transcript(
    key: SessionKey,
    opts: { around?: string; before?: string; after?: string; limit: number },
  ): TranscriptWindow | undefined;
  /** Every message of one session matching the clauses, in transcript order. */
  hitsIn(key: SessionKey, parsed: ParsedSearch): { ref: string; marks: SearchMark[] }[];
  session(key: SessionKey): IndexedSession | undefined;
  sessions(): Iterable<IndexedSession>;
  setOverlay(key: SessionKey, overlay: SessionOverlay | null): void;
  /** Drop a session from results now (store `forgotten`); the writer tombstones it later. */
  forget(key: SessionKey): void;
  stats(): ReaderStats;
  /** Re-open when a manifest generation moved (one stat each); true when it did. */
  refresh(): boolean;
  /** The live tail: index complete lines past the committed offsets of the hot files now. */
  tick(): void;
  /** A file just changed (fs.watch, the store's ingest): tick it soon. */
  hint(path: string): void;
  close(): void;
}

export interface ReaderOptions {
  /** `<stateDir>/search`: holds `history/` and `events/`. */
  dir: string;
  /** Indexes to open (history absent when the setting is off). */
  sources: readonly SearchSource[];
  /** For the live tail; without it the reader serves committed segments only. */
  live?: { env: SourceEnv; adapters: readonly SourceAdapter[] };
}

// ───────────────────────────── the write side (engine's indexer) ─────────────────────────────

export interface IndexerStatus {
  phase: "scanning" | "building" | "merging" | "idle" | "error";
  /** Bytes read over bytes found in this pass (first build: the progress bar). */
  doneBytes: number;
  totalBytes: number;
  /** True until the first full pass over history has committed once. */
  firstRun: boolean;
  /** Files an adapter could not read here (see SearchIndexStatus.skipped). */
  skipped?: { harness: string; files: number; why: "zstd" | "unreadable" }[];
  gen: Partial<Record<SearchSource, number>>;
  error?: string;
}

export interface IndexerOptions {
  dir: string;
  env: SourceEnv;
  adapters: readonly SourceAdapter[];
  /** Index history sources. Off: `history/` is deleted and never written. */
  history: boolean;
  /** Write a fresh generation beside the old one and switch in one commit. */
  rebuild?: boolean;
  /** once: one pass, commit, merge, return (`sessionpipe-gui index`). watch: keep ticking
   *  (1 s hot set, 30 s sweep) until `signal` aborts or 2 min idle (the server's child). */
  mode: "once" | "watch";
  onStatus?: (s: IndexerStatus) => void;
  onCommit?: (source: SearchSource, gen: number) => void;
  signal?: AbortSignal;
}

/** server → indexer child (process.send, serialization "advanced"). */
export type ToIndexer =
  | { t: "hint"; path: string }
  | { t: "commit" }
  | { t: "rebuild" }
  | { t: "history"; on: boolean }
  | { t: "forget"; key: SessionKey }
  | { t: "stop" };

/** indexer child → server. */
export type FromIndexer =
  | { t: "status"; status: IndexerStatus }
  | { t: "committed"; source: SearchSource; gen: number }
  | { t: "error"; message: string };

// ───────────────────────────── the service (routes, CLI, app.ts) ─────────────────────────────

export interface Viewer {
  /** The request came from this machine (loopback, not through the proxy). */
  local: boolean;
}

/** `createSearch(deps)` in server/search/service.ts; wired in server/app.ts. */
export interface SearchService {
  search(q: SessionSearchQuery, viewer: Viewer): SessionSearchPage;
  transcript(
    harness: string,
    id: string,
    q: { q?: string; around?: string; before?: string; after?: string; limit?: number },
    viewer: Viewer,
  ): SearchTranscript | undefined;
  facets(): SearchFacets;
  status(viewer?: Viewer): SearchIndexStatus;
  reindex(rebuild: boolean): SearchIndexStatus;
  setHistory(on: boolean): Promise<SearchIndexStatus>;
  reveal(r: SearchRevealRequest): Promise<"ok" | "gone" | "not_here">;
  close(): Promise<void>;
}
