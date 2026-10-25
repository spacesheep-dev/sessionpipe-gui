// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service. The terminal side of session search (S4, SEARCH-SPEC §3.3, UX §14):
// it works with no server, no browser and no network.
//
//   sessionpipe-gui search "<q>" [--agent a] [--machine m] [--repo r] [--since 7d] [--until d]
//                         [--in f] [--source s] [--label l] [--newest] [--limit n] [--json]
//   sessionpipe-gui index [--rebuild] [--status] [--verify]      (--ipc: the server's child)
//
// `search` opens the index read-only in this process (with the live tail) and prints the
// same page the API answers. `index` asks a running server to do it (one writer: the
// server's child holds the LOCK), else indexes in the foreground.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PORT,
  type Labels,
  ROUTES,
  type SearchIndexStatus,
  type SessionMatch,
  type SessionSearchPage,
} from "../../shared/api.js";
import { isEmptySearch, parseSearch } from "../../shared/searchQuery.js";
import { HARNESS_LABELS } from "./facets.js";
import { homePath } from "./resume.js";
import {
  emptyReader,
  LIMIT_MAX,
  loadBackend,
  type QueryContext,
  readSources,
  runSessionSearch,
  type SearchBackend,
  searchDir,
  syntheticHome,
  TOTAL_EXACT,
  thisHostname,
} from "./service.js";
import type { IndexerStatus, SearchReader } from "./types.js";

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** The GUI's state dir (--state, else the default). */
  stateDir: string;
  /** --search-home / SPGUI_SEARCH_HOME, else os.homedir(). */
  home?: string;
  /** Tests: the engine and sources. */
  backend?: SearchBackend;
  /** Tests: how `index` reaches a running server. */
  fetch?: typeof fetch;
  now?: () => number;
}

const SEARCH_USAGE = `usage: sessionpipe-gui search "<query>" [options]

  Words are ANDed; "a phrase"; -word without it; pre* a prefix;
  filters in the query or as flags: agent machine repo label since until in source.

  --agent A       claude, codex, antigravity, gemini (agent:A)
  --machine M     a machine, or "this" (machine:M)
  --repo R        a repo or folder name prefix (repo:R)
  --label L       a label colour or name (label:L)
  --since D       7d 12h 2w today yesterday 2026-10-01 (since:D)
  --until D       (until:D)
  --in F          prompt reply tool title (in:F)
  --source S      history or sessionpipe (source:S)
  --newest        newest first instead of best match
  --limit N       sessions to print (default 10, at most ${LIMIT_MAX})
  --json          print the SessionSearchPage the API answers
  --state DIR     the GUI's state dir
  --search-home D read agent history under D instead of your home (demos, tests)

  exit 0 with results, 1 with none, 2 on a usage error
`;

const INDEX_USAGE = `usage: sessionpipe-gui index [--rebuild] [--status] [--verify]

  Brings the search index up to date. When the GUI is running it asks it to (one writer);
  otherwise it indexes here, in the foreground.

  --rebuild       read everything again into a fresh index
  --status        print the index status and exit
  --verify        open the index and check that it reads
  --state DIR     the GUI's state dir
  --search-home D read agent history under D instead of your home
`;

const FLAG_KEYS: Readonly<Record<string, string>> = {
  "--agent": "agent",
  "--machine": "machine",
  "--repo": "repo",
  "--label": "label",
  "--since": "since",
  "--until": "until",
  "--in": "in",
  "--source": "source",
};

class UsageError extends Error {}

const quoteTok = (v: string): string => (/[\s"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v);

interface SearchArgs {
  q: string;
  newest: boolean;
  limit: number;
  json: boolean;
}

export function parseSearchArgs(argv: string[]): SearchArgs | "help" {
  const words: string[] = [];
  const filters: string[] = [];
  const a: SearchArgs = { q: "", newest: false, limit: 10, json: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined || v === "") throw new UsageError(`${f} needs a value`);
      return v;
    };
    if (f === "--") {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (FLAG_KEYS[f]) {
      filters.push(`${FLAG_KEYS[f]}:${quoteTok(next())}`);
      continue;
    }
    switch (f) {
      case "--help":
      case "-h":
        return "help";
      case "--newest":
        a.newest = true;
        break;
      case "--json":
        a.json = true;
        break;
      case "--limit": {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1 || n > LIMIT_MAX)
          throw new UsageError(`--limit needs a number 1–${LIMIT_MAX}`);
        a.limit = n;
        break;
      }
      case "--state":
      case "--search-home":
        next();
        break;
      default:
        if (f.startsWith("--")) throw new UsageError(`unknown option ${f} (try search --help)`);
        words.push(f);
    }
  }
  a.q = [...words, ...filters].join(" ").trim();
  if (!a.q || isEmptySearch(parseSearch(a.q))) throw new UsageError("search needs a query (try search --help)");
  return a;
}

/** The GUI's own settings, read without creating anything (the CLI never writes config). */
function readHistorySetting(stateDir: string): boolean {
  try {
    const c = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8")) as { searchHistory?: unknown };
    return c.searchHistory !== false;
  } catch {
    return true;
  }
}

function readLabels(stateDir: string): Labels {
  try {
    const raw = JSON.parse(readFileSync(path.join(stateDir, "labels.json"), "utf8")) as Partial<Labels>;
    return { rev: 0, names: raw.names ?? {}, sessions: raw.sessions ?? {} };
  } catch {
    return { rev: 0, names: {}, sessions: {} };
  }
}

/** `<stateDir>/search/server.json` when its pid is alive. */
export function runningServer(stateDir: string): { pid: number; port: number } | undefined {
  try {
    const s = JSON.parse(readFileSync(path.join(searchDir(stateDir), "server.json"), "utf8")) as {
      pid?: unknown;
      port?: unknown;
    };
    if (typeof s.pid !== "number" || typeof s.port !== "number" || s.port <= 0) return undefined;
    if (s.pid === process.pid) return undefined;
    process.kill(s.pid, 0);
    return { pid: s.pid, port: s.port };
  } catch (e) {
    // EPERM: alive, someone else's; anything else: gone.
    if ((e as NodeJS.ErrnoException)?.code === "EPERM") return undefined;
    return undefined;
  }
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
function localTime(isoTime: string): string {
  const d = new Date(isoTime);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `text` with «» around each mark. */
export function markText(text: string, marks: readonly [number, number][]): string {
  let out = "";
  let at = 0;
  for (const [s, e] of [...marks].sort((a, b) => a[0] - b[0])) {
    if (s < at || e > text.length || e <= s) continue;
    out += `${text.slice(at, s)}«${text.slice(s, e)}»`;
    at = e;
  }
  return (out + text.slice(at)).replace(/\s+/g, " ");
}

const FIELD_WORD: Readonly<Record<string, string>> = { prompt: "you", reply: "agent", tool: "tool" };

function formatSession(s: SessionMatch, home: string): string[] {
  const lines: string[] = [];
  lines.push(`■ ${s.titleMarks?.length ? markText(s.title, s.titleMarks) : s.title}`);
  const meta = [
    HARNESS_LABELS[s.harness] ?? s.harness,
    s.account ? `${s.machine ?? ""} (${s.account})`.trim() : (s.machine ?? ""),
    s.cwd ? homePath(s.cwd, home).replace(/^'(.*)'$/, "$1") : (s.repo ?? ""),
    localTime(s.lastAt),
  ].filter(Boolean);
  lines.push(`  ${meta.join(" · ")}`);
  if (s.resume) lines.push(`  ${s.resume}`);
  else if (s.harness === "antigravity") lines.push(`  conversation ${s.id}`);
  else lines.push(`  session ${s.id}`);
  for (const h of s.hits) {
    const who = h.agent ? `${h.agent.type ?? "subagent"}` : (FIELD_WORD[h.field] ?? h.field);
    // A tool line's text already starts with the tool's name (`Bash pnpm test`).
    lines.push(`    ${who.padEnd(6)} ${localTime(h.at)}${h.live ? " live" : ""}  ${markText(h.text, h.marks)}`);
  }
  if (s.moreHits > 0) lines.push(`    ${s.moreHits === 1 ? "1 more match" : `${s.moreHits} more matches`}`);
  return lines;
}

function hintLine(page: SessionSearchPage): string | undefined {
  const h = page.hint;
  if (!h) return undefined;
  const again = (q: string) => `sessionpipe-gui search ${JSON.stringify(q)}`;
  switch (h.kind) {
    case "filters":
      return `Nothing with these filters. Without them: ${again(h.query ?? "")}`;
    case "phrase":
      return `No exact phrase. The words: ${again(h.query ?? "")}`;
    case "spelling":
      return `Nothing has that word. Did you mean: ${again(h.query ?? "")}`;
    case "exclude":
      return `Every match has “${h.word}”. Without -${h.word}: ${again(h.query ?? "")}`;
    case "indexing":
      return "This Mac's history is still being read. More may turn up (sessionpipe-gui index --status).";
    default:
      return `Searched prompts, replies, tool calls and titles in ${page.index.sessions.toLocaleString("en-US")} sessions.`;
  }
}

function statusLine(s: SearchIndexStatus): string {
  const n = s.sessions.toLocaleString("en-US");
  switch (s.state) {
    case "first-run":
      return `Reading this Mac's agent history · ${Math.round((s.progress ?? 0) * 100)} %`;
    case "updating":
      return `${n} sessions · updating…`;
    case "off":
      return `${n} sessions from sessionpipe · history search is off`;
    case "error":
      return `The index needs rebuilding (${s.error ?? "error"}). sessionpipe-gui index --rebuild`;
    default:
      return `${n} sessions · up to date`;
  }
}

const mb = (b: number): string =>
  b >= 1e9
    ? `${(b / 1e9).toFixed(1)} GB`
    : b >= 1e6
      ? `${Math.round(b / 1e6)} MB`
      : `${Math.max(1, Math.round(b / 1e3))} KB`;

interface Opened {
  reader: SearchReader;
  backend: SearchBackend;
  history: boolean;
  home: string;
}

async function openForCli(io: CliIo): Promise<Opened> {
  const backend = io.backend ?? (await loadBackend());
  const home = io.home ?? os.homedir();
  const history = readHistorySetting(io.stateDir);
  const env = backend.sourceEnv({ home: syntheticHome(home), stateDir: io.stateDir, hostname: thisHostname() });
  const adapters = [backend.eventsAdapter(), ...(history ? backend.historyAdapters() : [])];
  const reader = await backend.openReader({
    dir: searchDir(io.stateDir),
    sources: readSources(history),
    live: { env, adapters },
  });
  return { reader, backend, history, home };
}

/** `sessionpipe-gui search …`: 0 with results, 1 with none, 2 on a usage error. */
export async function runSearchCli(argv: string[], io: CliIo): Promise<number> {
  const out = (s: string) => io.stdout.write(`${s}\n`);
  let args: SearchArgs | "help";
  try {
    args = parseSearchArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.stderr.write(`sessionpipe-gui: ${e.message}\n`);
    return 2;
  }
  if (args === "help") {
    io.stdout.write(SEARCH_USAGE);
    return 0;
  }
  let opened: Opened;
  try {
    opened = await openForCli(io);
  } catch (e) {
    io.stderr.write(`sessionpipe-gui: the search index could not be opened: ${(e as Error).message}\n`);
    return 1;
  }
  const { reader } = opened;
  try {
    // Nothing indexed yet and nobody indexing: build it here first (it is the first run).
    const st = reader.stats();
    const server = runningServer(io.stateDir);
    if (!server && st.gen.history === undefined && st.gen.sessionpipe === undefined) {
      reader.close();
      io.stderr.write("No search index yet: building it now (sessionpipe-gui index does the same).\n");
      const code = await indexForeground(io, false, opened);
      if (code !== 0) return code;
      opened.reader = await openForCli(io).then((o) => o.reader);
    }
    const labels = readLabels(io.stateDir);
    const status = (): SearchIndexStatus => {
      const s = opened.reader.stats();
      return {
        state: opened.history ? "ready" : "off",
        sessions: s.sessions,
        messages: s.messages,
        bytes: s.bytes,
        history: opened.history,
        sources: s.bySource,
        ...(s.updatedAt ? { updatedAt: new Date(s.updatedAt).toISOString() } : {}),
      };
    };
    const ctx: QueryContext = {
      hostname: thisHostname(),
      home: opened.home,
      labels: () => labels,
      summary: () => undefined,
      available: () => readSources(opened.history),
      status,
      firstRun: () => false,
      now: io.now,
    };
    const page = runSessionSearch(
      opened.reader,
      {
        q: args.q,
        sort: args.newest ? "newest" : "best",
        limit: args.limit,
        tz: new Date().getTimezoneOffset(),
        hits: 3,
      },
      { local: true },
      ctx,
    );
    if (args.json) {
      out(JSON.stringify(page, null, 2));
      return page.sessions.length ? 0 : 1;
    }
    const port = server?.port ?? DEFAULT_PORT;
    const url = `http://localhost:${port}/search?q=${encodeURIComponent(args.q)}${args.newest ? "&sort=newest" : ""}`;
    if (!page.sessions.length) {
      out(`No sessions match “${args.q}”.`);
      const h = hintLine(page);
      if (h) out(h);
      out("");
      out(url);
      return 1;
    }
    const n = page.more ? `${TOTAL_EXACT}+` : String(page.total);
    out(`${n} ${page.total === 1 ? "session" : "sessions"} · ${page.ms} ms · ${statusLine(page.index)}`);
    out("");
    for (const s of page.sessions) {
      for (const l of formatSession(s, opened.home)) out(l);
      out("");
    }
    if (page.parsed.unknown.length)
      out(
        `“${page.parsed.unknown[0]}:” isn't a filter, so it was searched as text. Filters: agent machine repo label since until in source`,
      );
    out(url);
    return 0;
  } finally {
    try {
      opened.reader.close();
    } catch {}
  }
}

function progressText(s: IndexerStatus): string {
  const pct = s.totalBytes > 0 ? Math.min(100, Math.floor((s.doneBytes / s.totalBytes) * 100)) : 0;
  return `${s.phase === "merging" ? "Merging" : "Reading agent history"} · ${pct} % · ${mb(s.doneBytes)} of ${mb(s.totalBytes)}`;
}

async function indexForeground(io: CliIo, rebuild: boolean, opened?: Opened): Promise<number> {
  const backend = opened?.backend ?? io.backend ?? (await loadBackend());
  const home = opened?.home ?? io.home ?? os.homedir();
  const history = readHistorySetting(io.stateDir);
  const env = backend.sourceEnv({ home: syntheticHome(home), stateDir: io.stateDir, hostname: thisHostname() });
  const tty = (io.stderr as NodeJS.WriteStream).isTTY === true;
  const t0 = Date.now();
  let lastLine = 0;
  let last: IndexerStatus | undefined;
  try {
    await backend.runIndexer({
      dir: searchDir(io.stateDir),
      env,
      adapters: [backend.eventsAdapter(), ...(history ? backend.historyAdapters() : [])],
      history,
      rebuild,
      mode: "once",
      onStatus: (s) => {
        last = s;
        const now = Date.now();
        if (tty) io.stderr.write(`\r\x1b[2K${progressText(s)}`);
        else if (now - lastLine > 2000) {
          lastLine = now;
          io.stderr.write(`${progressText(s)}\n`);
        }
      },
    });
  } catch (e) {
    if (tty) io.stderr.write("\n");
    const msg = (e as Error).message;
    io.stderr.write(
      /lock/i.test(msg)
        ? `sessionpipe-gui: another indexer holds the index (${msg}). Is the GUI running?\n`
        : `sessionpipe-gui: indexing failed: ${msg}\n`,
    );
    return 1;
  }
  if (tty) io.stderr.write("\r\x1b[2K");
  const r = await backend
    .openReader({ dir: searchDir(io.stateDir), sources: readSources(history) })
    .catch(() => emptyReader());
  const st = r.stats();
  r.close();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  io.stderr.write(
    `Indexed ${st.sessions.toLocaleString("en-US")} sessions (${st.messages.toLocaleString("en-US")} messages) in ${secs} s · ${mb(st.bytes)} on disk${last?.skipped?.length ? ` · ${last.skipped.reduce((n, k) => n + k.files, 0)} files skipped` : ""}\n`,
  );
  return 0;
}

/** `sessionpipe-gui index …`. `--ipc`: the server's indexer child (engine.indexerChildMain). */
export async function runIndexCli(argv: string[], io: CliIo): Promise<number> {
  if (argv.includes("--ipc")) {
    const { indexerChildMain } = await import("./engine/index.js");
    await indexerChildMain(argv);
    return 0;
  }
  let rebuild = false;
  let status = false;
  let verify = false;
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    switch (f) {
      case "--help":
      case "-h":
        io.stdout.write(INDEX_USAGE);
        return 0;
      case "--rebuild":
        rebuild = true;
        break;
      case "--status":
        status = true;
        break;
      case "--verify":
        verify = true;
        break;
      case "--state":
      case "--search-home":
        if (argv[++i] === undefined) {
          io.stderr.write(`sessionpipe-gui: ${f} needs a value\n`);
          return 2;
        }
        break;
      default:
        io.stderr.write(`sessionpipe-gui: unknown option ${f} (try index --help)\n`);
        return 2;
    }
  }
  const server = runningServer(io.stateDir);
  const http = io.fetch ?? fetch;
  const base = server ? `http://127.0.0.1:${server.port}` : undefined;
  const getStatus = async (): Promise<SearchIndexStatus> => {
    const r = await http(`${base}${ROUTES.ui.searchStatus}`);
    if (!r.ok) throw new Error(`status ${r.status}`);
    return (await r.json()) as SearchIndexStatus;
  };

  if (status || verify) {
    if (base && status) {
      try {
        const s = await getStatus();
        io.stdout.write(`${statusLine(s)} · ${mb(s.bytes)} on disk (the GUI on :${server!.port})\n`);
        for (const src of s.sources)
          io.stdout.write(`  ${src.harness.padEnd(12)} ${src.source.padEnd(11)} ${src.sessions}\n`);
        for (const k of s.skipped ?? []) io.stdout.write(`  skipped ${k.files} ${k.harness} files (${k.why})\n`);
        return 0;
      } catch {}
    }
    try {
      const o = await openForCli(io);
      const st = o.reader.stats();
      o.reader.close();
      if (st.gen.history === undefined && st.gen.sessionpipe === undefined) {
        io.stdout.write("No search index yet (sessionpipe-gui index builds it).\n");
        return verify ? 1 : 0;
      }
      io.stdout.write(
        `${st.sessions.toLocaleString("en-US")} sessions · ${st.messages.toLocaleString("en-US")} messages · ${mb(st.bytes)} on disk${verify ? " · reads fine" : ""}\n`,
      );
      for (const src of st.bySource)
        io.stdout.write(`  ${src.harness.padEnd(12)} ${src.source.padEnd(11)} ${src.sessions}\n`);
      return 0;
    } catch (e) {
      io.stderr.write(`sessionpipe-gui: the index does not read: ${(e as Error).message}\n`);
      return 1;
    }
  }

  if (base) {
    // One writer: the running GUI's indexer does it; we watch.
    try {
      const r = await http(`${base}${ROUTES.ui.searchReindex}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rebuild }),
      });
      if (r.status !== 202) throw new Error(`reindex answered ${r.status}`);
      const tty = (io.stderr as NodeJS.WriteStream).isTTY === true;
      io.stderr.write(`Asked the GUI on :${server!.port} to ${rebuild ? "rebuild" : "update"} the index.\n`);
      const t0 = Date.now();
      let s = (await r.json()) as SearchIndexStatus;
      // Give the indexer a moment to pick it up before reading "ready" as "done".
      await new Promise((res) => setTimeout(res, 600));
      for (;;) {
        s = await getStatus();
        if (s.state === "ready" || s.state === "off" || s.state === "error") break;
        if (tty) io.stderr.write(`\r\x1b[2K${statusLine(s)}`);
        if (Date.now() - t0 > 30 * 60_000) break;
        await new Promise((res) => setTimeout(res, 500));
      }
      if (tty) io.stderr.write("\r\x1b[2K");
      io.stdout.write(`${statusLine(s)}\n`);
      return s.state === "error" ? 1 : 0;
    } catch (e) {
      io.stderr.write(`sessionpipe-gui: the GUI did not answer (${(e as Error).message}); indexing here instead.\n`);
    }
  }
  return indexForeground(io, rebuild);
}
