// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. Codex history (sources.md §3): `$CODEX_HOME/sessions/YYYY/MM/DD/
// rollout-<ts>-<id>.jsonl[.zst]` and `archived_sessions/`. Guardian reviews are skipped,
// spawned subagents join their parent, forks and subagents start after their replay
// boundary, titles come from `session_index.jsonl`.
import { readFileSync, statSync } from "node:fs";
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
import { codexHome, list } from "./homes.js";
import { Finder, LineSplitter, type OnLine, parseLine, readAppend, readStreamLines } from "./prefilter.js";
import {
  codexInjected,
  codexPrompt,
  finish,
  firstAskTitle,
  ms,
  repoName,
  shellJoin,
  toolArg,
  toolLine,
} from "./text.js";
import { ZstdBatcher, zstdChunks, zstdWay } from "./zstd.js";

export const HARNESS = "codex";
const ROLLOUT = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i;

const TYPE_KEY = Buffer.from('"type":"');
const PAYLOAD_TYPE_KEY = Buffer.from('"payload":{"type":"');
const SKIP_PAYLOAD = new Set(["function_call_output", "custom_tool_call_output", "reasoning"]);

/** The string value after `key` within the line's first `within` bytes, or undefined. */
function headValue(buf: Buffer, s: number, e: number, key: Buffer, within: number): string | undefined {
  const end = Math.min(e, s + within);
  const i = buf.subarray(s, end).indexOf(key);
  if (i < 0) return undefined;
  const v0 = s + i + key.length;
  const q = buf.indexOf(34, v0);
  return q > v0 && q < e && q - v0 < 64 ? buf.toString("latin1", v0, q) : undefined;
}

const PAYLOAD_KEY = Buffer.from('"payload":');
/** The envelope's own type, only when it comes before the payload (else undefined: search whole). */
function topType(buf: Buffer, s: number, e: number): string | undefined {
  const head = buf.subarray(s, Math.min(e, s + 240));
  const t = head.indexOf(TYPE_KEY);
  if (t < 0) return undefined;
  const p = head.indexOf(PAYLOAD_KEY);
  if (p >= 0 && p < t) return undefined;
  return headValue(buf, s, e, TYPE_KEY, 240);
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** `*** Update File: a.ts` … → `a.ts b.ts`: the files a patch touches, never its body. */
export function patchFiles(patch: string): string {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) if (m[1]) out.push(m[1].trim());
  for (const m of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) if (m[1]) out.push(m[1].trim());
  return out.join(" ");
}

const parseArgs = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
};

/** One Codex tool call → `name arg` (sources.md §3 "Tool lines by name"). */
export function codexToolLine(name: string, rawArgs: unknown): string {
  const args = parseArgs(rawArgs);
  const o = obj(args);
  let arg = "";
  if (name === "apply_patch") arg = patchFiles(typeof args === "string" ? args : str(o?.input) || str(o?.patch));
  else if (name === "update_plan" && Array.isArray(o?.plan))
    arg = o.plan
      .map((s) => str(obj(s)?.step))
      .filter(Boolean)
      .join("; ");
  else if (/^request_user_input/.test(name) && Array.isArray(o?.questions))
    arg = o.questions
      .map((q) => str(obj(q)?.question) || str(obj(q)?.title) || str(q))
      .filter(Boolean)
      .join(" ");
  else if (o && Array.isArray(o.command)) arg = shellJoin(o.command.map(String));
  else if (o && Array.isArray(o.cmd)) arg = shellJoin(o.cmd.map(String));
  else arg = toolArg(args, ["message", "title", "code", "input"]);
  return toolLine(name, arg);
}

interface IndexCache {
  file: string;
  mtimeMs: number;
  size: number;
  names: Map<string, string>;
}

export function codexAdapter(): SourceAdapter & { zstdStats: () => { hits: number; runs: number } } {
  let dirs: string[] = [];
  let titles: IndexCache | undefined;
  let seen: SourceEnv | undefined;
  const zstd = new ZstdBatcher();
  let index_: SourceFile | undefined;

  /** `session_index.jsonl`: `{id, thread_name}`, the last line per id wins. Re-read on change. */
  const threadName = (env: SourceEnv, id: string): string | undefined => {
    const file = path.join(codexHome(env), "session_index.jsonl");
    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(file);
    } catch {
      return undefined;
    }
    if (!titles || titles.file !== file || titles.mtimeMs !== st.mtimeMs || titles.size !== st.size) {
      const names = new Map<string, string>();
      try {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          if (!line) continue;
          try {
            const j = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
            if (typeof j.id === "string" && typeof j.thread_name === "string" && j.thread_name.trim())
              names.set(j.id, j.thread_name.trim());
          } catch {}
        }
      } catch {}
      titles = { file, mtimeMs: st.mtimeMs, size: st.size, names };
    }
    return titles.names.get(id);
  };

  return {
    id: "codex",
    source: "history",
    zstdStats: () => zstd.stats,

    roots(env: SourceEnv): string[] {
      if (dirs.length) return dirs;
      const h = codexHome(env);
      return [path.join(h, "sessions"), path.join(h, "archived_sessions")];
    },

    async discover(env: SourceEnv): Promise<SourceFile[]> {
      seen = env;
      const h = codexHome(env);
      const best = new Map<string, SourceFile>();
      const roots: string[] = [];
      const consider = (dir: string, name: string) => {
        const m = ROLLOUT.exec(name);
        if (!m?.[1]) return;
        const p = path.join(dir, name);
        let st: { size: number; mtimeMs: number; isFile: () => boolean };
        try {
          st = statSync(p);
        } catch {
          return;
        }
        if (!st.isFile()) return;
        const zst = !!m[2];
        const f: SourceFile = {
          path: p,
          adapter: "codex",
          kind: zst ? "whole" : "append",
          size: st.size,
          mtimeMs: st.mtimeMs,
        };
        const id = m[1].toLowerCase();
        const prev = best.get(id);
        // The plain .jsonl is the live one; among the same kind the larger copy wins.
        if (
          !prev ||
          (prev.kind === "whole" && !zst) ||
          (prev.kind === (zst ? "whole" : "append") && f.size > prev.size)
        )
          best.set(id, f);
      };
      const walk = (dir: string, depth: number) => {
        roots.push(dir);
        for (const d of list(dir)) {
          if (d.isDirectory() && depth > 0) walk(path.join(dir, d.name), depth - 1);
          else if (d.isFile() || d.isSymbolicLink()) consider(dir, d.name);
        }
      };
      walk(path.join(h, "sessions"), 3);
      walk(path.join(h, "archived_sessions"), 3);
      // Thread names live beside the rollouts; read as a source of its own, a rename shows
      // even for a finished (archived) session whose rollout is never read again.
      const index = path.join(h, "session_index.jsonl");
      try {
        const st = statSync(index);
        if (st.isFile()) index_ = { path: index, adapter: "codex", kind: "append", size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        index_ = undefined;
      }
      dirs = roots.length ? roots : dirs;
      const out = [...best.values()];
      zstd.setPlan(out.filter((f) => f.kind === "whole"));
      if (index_) out.push(index_);
      return out;
    },

    async read(file: SourceFile, from: ReadCursor, sink: DocSink, opts: ReadOptions = {}): Promise<ReadResult> {
      if (path.basename(file.path) === "session_index.jsonl") return readIndex(file, from, sink, opts);
      const env = seen && file.path.startsWith(codexHome(seen)) ? seen : envFromPath(file);
      const st = (obj(from.state) ? { ...(from.state as Obj) } : {}) as { [k: string]: AdapterState };
      if (file.kind === "whole") for (const k of Object.keys(st)) delete st[k]; // a whole file is read from scratch
      const fileId = (ROLLOUT.exec(path.basename(file.path))?.[1] ?? "").toLowerCase();
      let bad = 0;
      let key = typeof st.key === "string" ? st.key : "";
      let facts: SessionFacts | undefined;
      const F = {
        resp: new Finder('"type":"response_item"'),
        ctx: new Finder('"type":"turn_context"'),
        evt: new Finder('"type":"event_msg"'),
        out: new Finder('"type":"function_call_output"'),
        cout: new Finder('"type":"custom_tool_call_output"'),
        reas: new Finder('"type":"reasoning"'),
        thread: undefined as Finder | undefined,
      };
      if (typeof st.mid === "string" && st.b === false) F.thread = new Finder(`"thread_id":"${st.mid}"`);

      const fx = (): SessionFacts | undefined => {
        if (!key || st.k === "guard") return undefined;
        if (!facts) {
          const id = key.slice(HARNESS.length + 1);
          facts = { key, harness: HARNESS, id };
        }
        return facts;
      };
      const time = (t: number) => {
        const f = fx();
        if (!f || !t) return;
        if (!f.firstAt || t < f.firstAt) f.firstAt = t;
        if (!f.lastAt || t > f.lastAt) f.lastAt = t;
      };
      const emit = (d: Omit<SearchDoc, "key">) => {
        const doc: SearchDoc = { key, ...d };
        if (st.k === "sub" && typeof st.agent === "string") {
          doc.agent = st.agent;
          if (typeof st.at === "string" && st.at) doc.agentType = st.at;
        }
        sink.doc(doc);
      };

      const onMeta = (j: Obj) => {
        const p = obj(j.payload) ?? {};
        const id = str(p.id) || fileId;
        const src = obj(p.source);
        const sub = obj(src?.subagent);
        st.mid = id;
        if (sub && (str(sub.other) === "guardian" || p.thread_source === "guardian_review")) {
          st.k = "guard";
          return;
        }
        const spawn = obj(sub?.thread_spawn);
        const parent = str(spawn?.parent_thread_id) || str(p.parent_thread_id);
        if (sub && parent) {
          st.k = "sub";
          st.agent = id;
          if (typeof p.agent_role === "string") st.at = p.agent_role;
          key = sessionKey(HARNESS, parent);
        } else {
          st.k = p.forked_from_id ? "fork" : "main";
          key = sessionKey(HARNESS, id);
        }
        st.key = key;
        // Subagents and forks replay their parent first; their own records start at the
        // first event naming this thread (sessionpipe's codexReplayBoundary).
        st.b = !(sub || p.forked_from_id);
        if (!st.b) F.thread = new Finder(`"thread_id":"${id}"`);
        if (st.k === "sub") return;
        const f = fx()!;
        const cwd = str(p.cwd);
        if (cwd) {
          f.cwd = cwd;
          st.c0 = cwd;
        }
        const git = obj(p.git);
        if (git) {
          const br = str(git.branch);
          if (br && br !== "HEAD") f.branch = br;
          const repo = repoName(git.repository_url);
          if (repo) f.repo = repo;
        }
        if (typeof p.forked_from_id === "string" && p.forked_from_id) f.forkOf = sessionKey(HARNESS, p.forked_from_id);
        time(ms(p.timestamp) || ms(j.timestamp));
      };

      const onItem = (p: Obj, t: number, at: number) => {
        const type = p.type;
        if (type === "message") {
          const role = p.role;
          if (role !== "user" && role !== "assistant") return;
          const parts: string[] = [];
          for (const c of Array.isArray(p.content) ? p.content : []) {
            const o = obj(c);
            if (!o || typeof o.text !== "string") continue;
            if (role === "user" && o.type === "input_text") {
              const s = o.text.trim();
              if (!s || codexInjected(s)) continue;
              const cleaned = codexPrompt(s);
              if (cleaned) parts.push(cleaned);
            } else if (role === "assistant" && (o.type === "output_text" || o.type === "text"))
              // Plan mode wraps the plan in <proposed_plan>…</proposed_plan>: the words stay.
              parts.push(o.text.replace(/<\/?proposed_plan>/g, ""));
          }
          const text = finish(parts.join("\n\n"));
          if (!text) return;
          emit({ field: role === "user" ? "prompt" : "reply", at: t, text, offset: at });
          if (role === "user" && !st.fa && st.k !== "sub") {
            st.fa = true;
            const f = fx();
            if (f) f.title = { text: finish(firstAskTitle(text), 200), rank: TITLE_RANK.firstAsk };
          }
        } else if (type === "function_call" || type === "custom_tool_call") {
          const name = str(p.name) || String(type);
          const line = codexToolLine(name, type === "function_call" ? p.arguments : p.input);
          if (line) emit({ field: "tool", at: t, text: line, offset: at, tool: name });
        } else if (type === "local_shell_call") {
          const action = obj(p.action);
          const cmd = Array.isArray(action?.command) ? shellJoin(action.command.map(String)) : "";
          const line = toolLine("shell", cmd);
          emit({ field: "tool", at: t, text: line, offset: at, tool: "shell" });
        } else if (type === "web_search_call") {
          const q = str(obj(p.action)?.query);
          if (q) emit({ field: "tool", at: t, text: toolLine("web_search", q), offset: at, tool: "web_search" });
        }
      };

      const onLine: OnLine = (buf, s, e, at, gen) => {
        if (st.k === "guard") return;
        if (!st.mid) {
          // The first record is the session's own metadata (and the only one we use).
          const j = parseLine(buf, s, e);
          if (!j) {
            bad++;
            return;
          }
          if (j.type === "session_meta") onMeta(j);
          else {
            // A rollout from before the envelope (2025 H1): a bare `{id, timestamp,
            // instructions, git}` header, then bare response items. A main session.
            st.mid = str(j.id) || fileId;
            st.lg = j.type === undefined;
            key = sessionKey(HARNESS, st.mid);
            const f = fx();
            if (f) {
              time(ms(j.timestamp));
              const git = obj(j.git);
              const br = str(git?.branch);
              if (br && br !== "HEAD") f.branch = br;
              const repo = repoName(git?.repository_url);
              if (repo) f.repo = repo;
            }
          }
          if (!key && st.k !== "guard") key = sessionKey(HARNESS, fileId);
          if (st.k === undefined) {
            st.k = "main";
            st.b = true;
          }
          st.key = key;
          return;
        }
        if (st.lg) {
          const j = parseLine(buf, s, e);
          if (!j) {
            bad++;
            return;
          }
          if (typeof j.type === "string" && j.record_type === undefined) onItem(j, ms(j.timestamp), at);
          return;
        }
        // The envelope's `type` sits in the first ~120 bytes (`{"timestamp":…,"ordinal":n,"type":…`):
        // read it there; only a line that does not say it early is searched whole.
        const top = topType(buf, s, e);
        if (!st.b) {
          if (top !== undefined ? top !== "event_msg" : !F.evt.has(buf, gen, s, e)) return;
          if (!F.thread?.has(buf, gen, s, e)) return;
          const j = parseLine(buf, s, e);
          const tid = str(obj(j?.payload)?.thread_id);
          if (j?.type === "event_msg" && tid === st.mid) st.b = true;
          return;
        }
        const isResp = top !== undefined ? top === "response_item" : F.resp.has(buf, gen, s, e);
        if (!isResp) {
          if (top !== undefined ? top !== "turn_context" : !F.ctx.has(buf, gen, s, e)) return;
          const j = parseLine(buf, s, e);
          if (!j) {
            bad++;
            return;
          }
          const p = obj(j.payload);
          if (j.type !== "turn_context" || !p || st.k === "sub") return;
          const f = fx();
          if (f && typeof p.cwd === "string" && p.cwd) f.cwd = p.cwd;
          if (f && typeof p.model === "string" && p.model) f.model = p.model;
          return;
        }
        // Outputs and reasoning are most of the bytes: skipped by the payload's own type.
        const pt = headValue(buf, s, e, PAYLOAD_TYPE_KEY, 400);
        if (pt !== undefined) {
          if (SKIP_PAYLOAD.has(pt)) return;
        } else if (F.out.has(buf, gen, s, e) || F.cout.has(buf, gen, s, e) || F.reas.has(buf, gen, s, e)) {
          const head = buf.toString("latin1", s, Math.min(e, s + 400));
          if (/"payload":\{"type":"(?:function_call_output|custom_tool_call_output|reasoning)"/.test(head)) return;
        }
        const j = parseLine(buf, s, e);
        if (!j) {
          bad++;
          return;
        }
        const p = obj(j.payload);
        if (j.type !== "response_item" || !p) return;
        const t = ms(j.timestamp);
        time(t);
        onItem(p, t, at);
      };

      let offset = from.offset;
      let skipped: ReadResult["skipped"];
      if (file.kind === "whole") {
        const way = zstdWay(env);
        if (way.kind === "none") return { offset: 0, skipped: "zstd" };
        const data = await zstd.whole(file, way);
        if (data) {
          const split = new LineSplitter(0, onLine, true);
          split.push(data, false);
          split.end();
          offset = split.lines;
          bad += split.bad;
        } else
          try {
            const r = await readStreamLines(zstdChunks(file.path, way, opts.signal), onLine, opts.signal);
            offset = r.records;
            bad += r.bad;
          } catch {
            skipped = "unreadable";
          }
      } else {
        const r = readAppend(file.path, from.offset, onLine, opts);
        offset = r.offset;
        bad += r.bad;
      }

      const f = fx();
      if (f && st.k !== "sub") {
        const name = threadName(env, str(st.mid));
        if (name && name !== st.ti) {
          st.ti = name;
          f.title = { text: finish(name, 200), rank: TITLE_RANK.harness };
        }
        f.path = file.path;
        // D10: exactly `codex resume <id>` (Codex finds the thread by id from any folder).
        f.resume = { argv: ["codex", "resume", str(st.mid)] };
      }
      if (f && (f.lastAt || f.title || from.offset === 0)) sink.facts(f);
      return { offset, state: st, ...(bad ? { bad } : {}), ...(skipped ? { skipped } : {}) };
    },
  };
}

/** `session_index.jsonl`: `{id, thread_name, updated_at}` per line, the newest line winning.
 *  Titles only (facts, never docs): an id that is no session (a guardian review) stays a
 *  facts-only key, which the engine never lists. */
function readIndex(file: SourceFile, from: ReadCursor, sink: DocSink, opts: ReadOptions): ReadResult {
  let bad = 0;
  const r = readAppend(
    file.path,
    from.offset,
    (buf, s, e) => {
      const j = parseLine(buf, s, e);
      const id = str(j?.id);
      const name = str(j?.thread_name).trim();
      if (!j || !id) {
        bad++;
        return;
      }
      if (name)
        sink.facts({
          key: sessionKey(HARNESS, id),
          harness: HARNESS,
          id,
          title: { text: finish(name, 200), rank: TITLE_RANK.harness },
        });
    },
    opts,
  );
  bad += r.bad;
  return { offset: r.offset, ...(bad ? { bad } : {}) };
}

/** The env a read runs in when it came before any discover (a resumed engine): the
 *  Codex home is the folder above `sessions/`. */
function envFromPath(file: SourceFile): SourceEnv {
  const i = file.path.lastIndexOf(`${path.sep}sessions${path.sep}`);
  const j = file.path.lastIndexOf(`${path.sep}archived_sessions${path.sep}`);
  const home = file.path.slice(0, Math.max(i, j));
  return {
    home: path.dirname(home),
    stateDir: "",
    hostname: "",
    env: { ...process.env, CODEX_HOME: home },
    platform: process.platform,
  };
}
