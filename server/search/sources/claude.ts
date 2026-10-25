// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. Claude Code history (sources.md §2): every account home's
// `projects/<slug>/<id>.jsonl`, subagents under `<id>/subagents/**` joined to their
// parent, forks de-duplicated by record uuid, the largest copy winning across homes.
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { sessionKey } from "../../../shared/api.js";
import type {
  AdapterState,
  DocSink,
  ReadCursor,
  ReadOptions,
  ReadResult,
  SearchDoc,
  SessionFacts,
  SourceAdapter,
  SourceEnv,
  SourceFile,
} from "../types.js";
import { TITLE_RANK } from "../types.js";
import { claudeHomes, list } from "./homes.js";
import { Finder, parseLine, readAppend, startsWith } from "./prefilter.js";
import { cleanPromptBlock, finish, firstAskTitle, ms, repoName, toolArg, toolLine } from "./text.js";

export const HARNESS = "claude-code";
/** Lines above this are skipped unless they hold a queued prompt (pasted images). */
const BIG_LINE = 8 << 20;
/** Title records are small; a line under this is also searched for them whatever its key order. */
const SMALL_LINE = 4096;
const TYPE_FIRST = Buffer.from('{"type":"');
/** What a `{"type":"<v>"…` line is: a = assistant, u = user, q = maybe a queued prompt,
 *  t = a title or PR link to parse. Any other value is skipped unparsed. */
const FIRST_KIND: Record<string, string> = {
  assistant: "a",
  user: "u",
  attachment: "q",
  "custom-title": "t",
  "agent-name": "t",
  "ai-title": "t",
  summary: "t",
  "pr-link": "t",
};
const TITLE_PATS = [
  '"type":"custom-title"',
  '"type":"agent-name"',
  '"type":"ai-title"',
  '"type":"summary"',
  '"type":"pr-link"',
].map((p) => Buffer.from(p));
/** A bounded search: does `buf[s, e)` hold any of the patterns? */
function hasAny(buf: Buffer, s: number, e: number, pats: Buffer[]): boolean {
  const line = buf.subarray(s, e);
  for (const p of pats) if (line.indexOf(p) >= 0) return true;
  return false;
}
/** Attached material (IDE selection, pasted content) is indexed at the tool tier, clipped. */
const ATTACHED_MAX = 2048;

interface ClaudePath {
  home: string;
  slugDir: string;
  /** The session the file belongs to (the parent for a subagent). */
  id: string;
  /** Set for a subagent transcript. */
  agentId?: string;
}

/** `<home>/projects/<slug>/<id>.jsonl` or `<home>/projects/<slug>/<id>/subagents/[workflows/<wf>/]agent-<a>.jsonl`. */
export function parseClaudePath(p: string): ClaudePath | undefined {
  const parts = p.split(path.sep);
  const i = parts.lastIndexOf("projects");
  if (i < 1 || parts.length < i + 3) return undefined;
  const home = parts.slice(0, i).join(path.sep);
  const slugDir = parts.slice(0, i + 2).join(path.sep);
  const rest = parts.slice(i + 2);
  if (rest.length === 1 && rest[0]?.endsWith(".jsonl")) return { home, slugDir, id: rest[0].slice(0, -6) };
  const name = rest[rest.length - 1] ?? "";
  if (rest[1] === "subagents" && /^agent-.+\.jsonl$/.test(name) && rest[0])
    return { home, slugDir, id: rest[0], agentId: name.slice(6, -6) };
  return undefined;
}

interface Found {
  file: SourceFile;
  ino: string;
}

function statFile(p: string): { size: number; mtimeMs: number; ino: string } | undefined {
  try {
    const st = statSync(p);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs, ino: `${st.dev}:${st.ino}` } : undefined;
  } catch {
    return undefined;
  }
}

/** First record uuid of a file (fork detection): the first `"uuid":"…"` in its first 256 KB. */
function firstUuid(p: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(p, "r");
  } catch {
    return undefined;
  }
  try {
    // 64 KB holds the first record almost always; a first prompt with a pasted image can
    // push its `uuid` (which follows `message`) further, so look once more, deeper.
    for (const size of [64 * 1024, 4 << 20]) {
      const buf = Buffer.allocUnsafe(size);
      const n = readSync(fd, buf, 0, size, 0);
      const i = buf.subarray(0, n).indexOf('"uuid":"');
      if (i >= 0) {
        const end = buf.indexOf(34, i + 8);
        return end > i + 8 && end < n ? buf.toString("latin1", i + 8, end) : undefined;
      }
      if (n < size) return undefined;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Every record uuid in a file, in one byte pass (the fork's owner set). */
function uuidsOf(p: string): Set<string> {
  const out = new Set<string>();
  const f = new Finder('"uuid":"');
  try {
    readAppend(p, 0, (buf, s, e, _at, gen) => {
      const i = f.at(buf, gen, s, e);
      if (i < 0) return;
      const end = buf.indexOf(34, i + 8);
      if (end > i + 8 && end < e) out.add(buf.toString("latin1", i + 8, end));
    });
  } catch {}
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Argument keys tried after the shared ones (sources.md §2 and the M3 smoke's name-only
 *  tools: Workflow `script`, TaskStop `task_id`, SendUserFile `caption`, browser `text`). */
const CLAUDE_EXTRA = [
  "title",
  "message",
  "name",
  "question",
  "summary",
  "caption",
  "scriptPath",
  "script",
  "task_id",
  "taskId",
  "text",
  "action",
];

/** A Claude-shaped tool call's line (`Bash npm test`, `Edit src/a.ts`, `TodoWrite a; b`). */
export function claudeToolLine(name: string, input: unknown): string {
  let arg = toolArg(input, CLAUDE_EXTRA);
  if (!arg && input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (Array.isArray(o.todos))
      arg = o.todos
        .map((t) => (t && typeof t === "object" ? str((t as Record<string, unknown>).content) : ""))
        .filter(Boolean)
        .join("; ");
    else if (Array.isArray(o.questions))
      arg = o.questions
        .map((q) => (q && typeof q === "object" ? str((q as Record<string, unknown>).question) : str(q)))
        .filter(Boolean)
        .join(" ");
  }
  return toolLine(name, arg);
}

interface Acc {
  facts: SessionFacts;
  title?: { text: string; rank: number };
  any: boolean;
}

export function claudeAdapter(): SourceAdapter {
  // Adapter-global knowledge (SEARCH-SPEC.md §3.1): never persisted by the engine.
  const firstUuids = new Map<string, { size: number; uuid: string | undefined }>();
  const ownerSets = new Map<string, Set<string>>();
  let dirs: string[] = [];
  /** Main session files per project folder, from the last discover (fork twins are siblings). */
  let mainsByDir = new Map<string, { path: string; id: string; size: number }[]>();

  /** A file's first record uuid; it never changes in an append-only file once written. */
  const cachedFirst = (p: string, size?: number): string | undefined => {
    const have = firstUuids.get(p);
    if (have?.uuid) return have.uuid;
    const now = size ?? statFile(p)?.size ?? 0;
    if (have && have.size === now) return undefined;
    const uuid = firstUuid(p);
    firstUuids.set(p, { size: now, uuid });
    return uuid;
  };

  /** Files in the same project folder that start with the same record: the earlier ones
   *  (by creation, then first write, then id) own the shared records. */
  function forkOwners(p: string, id: string): { owners: string[]; forkOf?: string } {
    const mine = cachedFirst(p);
    if (!mine) return { owners: [] };
    const birth = (f: string): number => {
      try {
        const st = statSync(f);
        return st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    };
    const dir = path.dirname(p);
    const siblings =
      mainsByDir.get(dir) ??
      list(dir)
        .filter((d) => d.name.endsWith(".jsonl"))
        .map((d) => ({ path: path.join(dir, d.name), id: d.name.slice(0, -6), size: undefined as number | undefined }));
    const twins: { f: string; id: string; t: number }[] = [];
    for (const sib of siblings) {
      if (sib.id === id || cachedFirst(sib.path, sib.size) !== mine) continue;
      twins.push({ f: sib.path, id: sib.id, t: birth(sib.path) });
    }
    if (!twins.length) return { owners: [] };
    const me = { f: p, id, t: birth(p) };
    const before = (a: typeof me, b: typeof me) => a.t < b.t || (a.t === b.t && a.id < b.id);
    const earlier = twins.filter((t) => before(t, me)).sort((a, b) => (before(a, b) ? -1 : 1));
    const last = earlier[earlier.length - 1];
    return { owners: earlier.map((t) => t.f), forkOf: last ? sessionKey(HARNESS, last.id) : undefined };
  }

  const ownerSet = (owners: string[]): Set<string> => {
    const k = owners.join("\n");
    let s = ownerSets.get(k);
    if (!s) {
      s = new Set();
      for (const o of owners) for (const u of uuidsOf(o)) s.add(u);
      if (ownerSets.size > 16) ownerSets.clear();
      ownerSets.set(k, s);
    }
    return s;
  };

  return {
    id: "claude",
    source: "history",

    roots(env: SourceEnv): string[] {
      if (dirs.length) return dirs;
      return claudeHomes(env).map((h) => path.join(h.dir, "projects"));
    },

    async discover(env: SourceEnv): Promise<SourceFile[]> {
      const mains = new Map<string, Found>();
      const subs = new Map<string, Found>();
      const seenIno = new Set<string>();
      const roots: string[] = [];
      const keep = (m: Map<string, Found>, k: string, f: Found) => {
        if (seenIno.has(f.ino)) return; // the same file through a linked home
        seenIno.add(f.ino);
        const prev = m.get(k);
        if (!prev || f.file.size > prev.file.size) m.set(k, f);
      };
      const subagentsIn = (dir: string, parent: string) => {
        roots.push(dir);
        for (const d of list(dir)) {
          if (d.isFile() && d.name.startsWith("agent-") && d.name.endsWith(".jsonl")) {
            const p = path.join(dir, d.name);
            const st = statFile(p);
            if (!st) continue;
            const agent = d.name.slice(6, -6);
            const file: SourceFile = {
              path: p,
              adapter: "claude",
              kind: "append",
              size: st.size,
              mtimeMs: st.mtimeMs,
              key: sessionKey(HARNESS, parent),
            };
            keep(subs, `${parent}/${agent}`, { file, ino: st.ino });
          } else if (d.isDirectory() && d.name === "workflows") {
            const wf = path.join(dir, d.name);
            roots.push(wf);
            for (const w of list(wf)) if (w.isDirectory()) subagentsIn(path.join(wf, w.name), parent);
          }
        }
      };
      for (const home of claudeHomes(env)) {
        const projects = path.join(home.dir, "projects");
        roots.push(projects);
        for (const slug of list(projects)) {
          if (!slug.isDirectory() && !slug.isSymbolicLink()) continue;
          const slugDir = path.join(projects, slug.name);
          roots.push(slugDir);
          for (const e of list(slugDir)) {
            if (e.name.endsWith(".jsonl") && (e.isFile() || e.isSymbolicLink())) {
              const p = path.join(slugDir, e.name);
              const st = statFile(p);
              if (!st) continue;
              const id = e.name.slice(0, -6);
              const file: SourceFile = {
                path: p,
                adapter: "claude",
                kind: "append",
                size: st.size,
                mtimeMs: st.mtimeMs,
                key: sessionKey(HARNESS, id),
              };
              keep(mains, id, { file, ino: st.ino });
            } else if (e.isDirectory() && e.name !== "memory" && e.name !== "tool-results") {
              // `<id>/` moves when its `subagents/` appears; `subagents/` when an agent does.
              roots.push(path.join(slugDir, e.name));
              const sub = path.join(slugDir, e.name, "subagents");
              if (list(sub).length) subagentsIn(sub, e.name);
            }
          }
        }
      }
      dirs = roots;
      const byDir = new Map<string, { path: string; id: string; size: number }[]>();
      for (const [id, m] of mains) {
        const d = path.dirname(m.file.path);
        let a = byDir.get(d);
        if (!a) {
          a = [];
          byDir.set(d, a);
        }
        a.push({ path: m.file.path, id, size: m.file.size });
      }
      mainsByDir = byDir;
      return [...mains.values(), ...subs.values()].map((f) => f.file);
    },

    async read(file: SourceFile, from: ReadCursor, sink: DocSink, opts: ReadOptions = {}): Promise<ReadResult> {
      const where = parseClaudePath(file.path);
      if (!where) return { offset: from.offset, state: from.state, skipped: "unreadable" };
      const st = (
        from.state && typeof from.state === "object" && !Array.isArray(from.state) ? { ...from.state } : {}
      ) as {
        [k: string]: AdapterState;
      };
      const key = sessionKey(HARNESS, where.id);
      const isSub = !!where.agentId;
      const homeDir = where.home;
      const homes = claudeHomesCache(homeDir);
      // Subagent type from its meta.json, once.
      if (isSub && st.at === undefined) {
        st.at = "";
        try {
          const meta = JSON.parse(readFileSync(file.path.replace(/\.jsonl$/, ".meta.json"), "utf8")) as {
            agentType?: unknown;
          };
          if (typeof meta.agentType === "string") st.at = meta.agentType.slice(0, 80);
        } catch {}
      }
      // Fork: decided once per file, from offset 0.
      let skipSet: Set<string> | undefined;
      if (!isSub) {
        if (st.fk === undefined || from.offset === 0) {
          const f = forkOwners(file.path, where.id);
          st.fk = f.forkOf ?? "";
          st.fo = f.owners;
          st.fp = false;
        }
        if (st.fk && !st.fp && Array.isArray(st.fo) && st.fo.length) skipSet = ownerSet(st.fo as string[]);
      }
      const agent = isSub ? where.agentId : undefined;
      const agentType = isSub && typeof st.at === "string" && st.at ? st.at : undefined;
      const acc: Acc = { facts: { key, harness: HARNESS, id: where.id }, any: false };
      const f = acc.facts;
      /** Older Claude Code wrote a Task subagent's records into the main file as sidechain
       *  records: they are the subagent's, never the person's (set per line). */
      let sideAgent: string | undefined;
      const emit = (d: Omit<SearchDoc, "key">) => {
        const doc: SearchDoc = { key, ...d };
        if (agent) {
          doc.agent = agent;
          if (agentType) doc.agentType = agentType;
        } else if (sideAgent) doc.agent = sideAgent;
        sink.doc(doc);
      };
      const title = (text: string, rank: number) => {
        const t = finish(text.replace(/\s+/g, " "), 200);
        if (!t || isSub) return;
        if (!acc.title || rank >= acc.title.rank) acc.title = { text: t, rank };
      };
      const time = (at: number) => {
        if (!at) return;
        if (!f.firstAt || at < f.firstAt) f.firstAt = at;
        if (!f.lastAt || at > f.lastAt) f.lastAt = at;
      };

      const F = {
        tur: new Finder('"toolUseResult":'),
        user: new Finder('"type":"user"'),
        asst: new Finder('"type":"assistant"'),
        queued: new Finder('"queued_command"'),
      };
      let bad = 0;

      const onLine = (buf: Buffer, s: number, e: number, at: number, gen: number) => {
        // Records Claude Code writes with `type` first (titles, last-prompt, queue-operation,
        // api-request, file-history, mode…) are decided by their first bytes alone.
        let kind = "";
        if (startsWith(buf, s, e, TYPE_FIRST)) {
          const v0 = s + TYPE_FIRST.length;
          const q = buf.indexOf(34, v0);
          const v = q > v0 && q - v0 < 40 && q < e ? buf.toString("latin1", v0, q) : "";
          const k = FIRST_KIND[v];
          if (k === undefined) return;
          kind = k;
        }
        if (!kind) {
          if (F.tur.has(buf, gen, s, e)) return;
          kind = F.asst.has(buf, gen, s, e)
            ? "a"
            : F.user.has(buf, gen, s, e)
              ? "u"
              : F.queued.has(buf, gen, s, e)
                ? "q"
                : e - s < SMALL_LINE && hasAny(buf, s, e, TITLE_PATS)
                  ? "t"
                  : "";
        } else if (kind === "u" && F.tur.has(buf, gen, s, e)) return;
        else if (kind === "q" && !F.queued.has(buf, gen, s, e)) return;
        if (!kind) return;
        if (e - s > BIG_LINE && kind !== "q") return;
        const j = parseLine(buf, s, e);
        if (!j) {
          bad++;
          return;
        }
        const type = j.type;
        if (kind === "t") {
          if (type === "custom-title") title(str(j.customTitle), TITLE_RANK.custom);
          else if (type === "agent-name") title(str(j.agentName), TITLE_RANK.agentName);
          else if (type === "ai-title") title(str(j.aiTitle), TITLE_RANK.aiTitle);
          else if (type === "summary") title(str(j.summary), TITLE_RANK.summary);
          else if (type === "pr-link") {
            const r =
              repoName(`https://x/${str(j.prRepository)}`) ?? repoName(str(j.prUrl)?.replace(/\/pull\/\d+.*$/, ""));
            if (r && !isSub) f.repo = r;
          }
          acc.any = true;
          return;
        }
        if (type !== "user" && type !== "assistant" && type !== "attachment") return;
        // A fork's copy of its parent's records: the parent owns them.
        if (skipSet && !st.fp) {
          const u = str(j.uuid);
          if (u && skipSet.has(u)) {
            if (!st.c0 && typeof j.cwd === "string") st.c0 = j.cwd;
            return;
          }
          if (u) st.fp = true;
        }
        sideAgent = !isSub && j.isSidechain === true ? str(j.agentId) || "sidechain" : undefined;
        const t = ms(j.timestamp);
        if (typeof j.cwd === "string" && j.cwd && !sideAgent) {
          if (!st.c0) st.c0 = j.cwd;
          f.cwd = j.cwd;
        }
        if (typeof j.gitBranch === "string" && j.gitBranch && j.gitBranch !== "HEAD") f.branch = j.gitBranch;
        time(t);
        acc.any = true;
        const msg = (j.message ?? {}) as { content?: unknown; model?: unknown };
        if (type === "user") {
          if (j.isMeta || j.isCompactSummary || j.isVisibleInTranscriptOnly) return;
          const origin = j.origin as { kind?: unknown } | undefined;
          if (origin?.kind && origin.kind !== "human") return;
          prompt(msg.content, t, at);
        } else if (type === "assistant") {
          if (msg.model === "<synthetic>" || j.isApiErrorMessage) return;
          if (typeof msg.model === "string" && msg.model) f.model = msg.model;
          const c = msg.content;
          if (!Array.isArray(c)) return;
          const texts: string[] = [];
          for (const b of c) {
            if (!b || typeof b !== "object") continue;
            const blk = b as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
            if (blk.type === "text" && typeof blk.text === "string") texts.push(blk.text);
            else if (blk.type === "tool_use" && typeof blk.name === "string") {
              const line = claudeToolLine(blk.name, blk.input);
              if (line) emit({ field: "tool", at: t, text: line, offset: at, tool: blk.name });
            }
          }
          const text = finish(texts.join("\n\n"));
          if (text) emit({ field: "reply", at: t, text, offset: at });
        } else {
          const a = j.attachment as
            | { type?: unknown; commandMode?: unknown; origin?: { kind?: unknown }; prompt?: unknown }
            | undefined;
          if (a?.type !== "queued_command") return;
          if ((a.commandMode ?? "prompt") !== "prompt") return;
          if (a.origin?.kind && a.origin.kind !== "human") return;
          prompt(a.prompt, t, at);
        }
      };

      const prompt = (content: unknown, t: number, at: number) => {
        const blocks: string[] = [];
        if (typeof content === "string") blocks.push(content);
        else if (Array.isArray(content))
          for (const b of content) {
            if (!b || typeof b !== "object") continue;
            const blk = b as { type?: unknown; text?: unknown };
            if (blk.type === "tool_result") return; // a tool result, not words
            if (blk.type === "text" && typeof blk.text === "string") blocks.push(blk.text);
          }
        const words: string[] = [];
        for (const b of blocks) {
          const c = cleanPromptBlock(b);
          if (c.text) words.push(c.text);
          for (const [label, s] of c.attached) {
            const text = finish(`${label} ${s}`, ATTACHED_MAX);
            if (text) emit({ field: "tool", at: t, text, offset: at, tool: label });
          }
        }
        const text = finish(words.join("\n\n"));
        if (!text) return;
        emit({ field: "prompt", at: t, text, offset: at });
        if (!isSub && !sideAgent && !st.fa) {
          st.fa = true;
          title(firstAskTitle(text), TITLE_RANK.firstAsk);
        }
      };

      const r = readAppend(file.path, from.offset, onLine, opts);
      bad += r.bad;
      if (acc.any || from.offset === 0) {
        if (acc.title) f.title = acc.title;
        if (!isSub) {
          f.path = file.path;
          const home = homes.find((h) => h.dir === homeDir);
          if (home?.account) f.account = home.account;
          if (st.fk) f.forkOf = st.fk as string;
          const cwd = typeof st.c0 === "string" && st.c0 ? st.c0 : undefined;
          f.resume = { argv: ["claude", "--resume", where.id] };
          if (cwd) f.resume.cwd = cwd;
          if (home && !home.isDefault) f.resume.env = { CLAUDE_CONFIG_DIR: home.dir };
        } else {
          // A subagent's own cwd/branch belong to its worktree, not the session.
          delete f.cwd;
          delete f.branch;
          delete f.model;
        }
        if (Object.keys(f).length > 3) sink.facts(f);
      }
      return { offset: r.offset, state: st, ...(bad ? { bad } : {}) };
    },
  };

  /** The homes around one file (account label, default or not), cached per home dir. */
  function claudeHomesCache(homeDir: string): { dir: string; account?: string; isDefault: boolean }[] {
    const base = path.basename(homeDir);
    const isDefault = base === ".claude";
    return [isDefault ? { dir: homeDir, isDefault } : { dir: homeDir, isDefault, account: accountOf(base) }];
  }
}

const accountOf = (base: string): string => base.replace(/^\./, "").replace(/^claude[-_.]?/, "") || base;
