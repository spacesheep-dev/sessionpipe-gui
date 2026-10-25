// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. Gemini CLI history (sources.md §5): `~/.gemini/tmp/<slug>/chats/
// session-*.jsonl` (current: a header line, message records, `$set` patches) and the older
// whole-file `session-*.json` (`{sessionId, messages: […]}`, read whole when it changes).
// User text → prompt, `gemini` text → reply, `toolCalls[]` → tool lines; thoughts, tool
// results, info/error/warning never. No resume line (not verified; SEARCH-SPEC.md D10).
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { sessionKey } from "../../../shared/api.js";
import type {
  AdapterState,
  DocSink,
  ReadCursor,
  ReadOptions,
  ReadResult,
  SessionFacts,
  SourceAdapter,
  SourceEnv,
  SourceFile,
} from "../types.js";
import { TITLE_RANK } from "../types.js";
import { geminiHome, list } from "./homes.js";
import { type OnLine, parseLine, readAppend } from "./prefilter.js";
import { cleanPromptBlock, finish, firstAskTitle, ms, toolArg, toolLine } from "./text.js";

export const HARNESS = "gemini-cli";
const CHAT = /^session-.*\.jsonl?$/;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A message's text: a string, a part list `[{text}]`, or a single part. */
function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((p) => (typeof p === "string" ? p : str(obj(p)?.text)))
      .filter(Boolean)
      .join("\n");
  return str(obj(c)?.text);
}

/** `tmp/<slug>/.project_root` names the project folder. */
function projectRoot(chatFile: string): string | undefined {
  try {
    const r = readFileSync(path.join(path.dirname(path.dirname(chatFile)), ".project_root"), "utf8").trim();
    return r && path.isAbsolute(r) ? r : undefined;
  } catch {
    return undefined;
  }
}

export function geminiAdapter(): SourceAdapter {
  let dirs: string[] = [];
  return {
    id: "gemini",
    source: "history",

    roots(env: SourceEnv): string[] {
      return dirs.length ? dirs : [path.join(geminiHome(env), "tmp")];
    },

    async discover(env: SourceEnv): Promise<SourceFile[]> {
      const tmp = path.join(geminiHome(env), "tmp");
      const roots = [tmp];
      const out: SourceFile[] = [];
      for (const slug of list(tmp)) {
        if (!slug.isDirectory()) continue;
        const chats = path.join(tmp, slug.name, "chats");
        const names = list(chats);
        if (!names.length) {
          // Before chat recording, Gemini CLI kept only the person's prompts in logs.json.
          const logs = path.join(tmp, slug.name, "logs.json");
          try {
            const st = statSync(logs);
            if (st.isFile())
              out.push({ path: logs, adapter: "gemini", kind: "whole", size: st.size, mtimeMs: st.mtimeMs });
          } catch {}
          continue;
        }
        roots.push(chats);
        for (const e of names) {
          if (!e.isFile() || !CHAT.test(e.name)) continue;
          const p = path.join(chats, e.name);
          try {
            const st = statSync(p);
            out.push({
              path: p,
              adapter: "gemini",
              kind: e.name.endsWith(".jsonl") ? "append" : "whole",
              size: st.size,
              mtimeMs: st.mtimeMs,
            });
          } catch {}
        }
      }
      dirs = roots;
      return out;
    },

    async read(file: SourceFile, from: ReadCursor, sink: DocSink, opts: ReadOptions = {}): Promise<ReadResult> {
      if (path.basename(file.path) === "logs.json") return readLogs(file, sink);
      const st = (file.kind === "append" && obj(from.state) ? { ...(from.state as Obj) } : {}) as {
        [k: string]: AdapterState;
      };
      let bad = 0;
      let f: SessionFacts | undefined;
      const facts = (): SessionFacts | undefined => {
        if (typeof st.sid !== "string" || !st.sid) return undefined;
        f ??= { key: sessionKey(HARNESS, st.sid), harness: HARNESS, id: st.sid };
        return f;
      };
      const time = (t: number) => {
        const x = facts();
        if (!x || !t) return;
        if (!x.firstAt || t < x.firstAt) x.firstAt = t;
        if (!x.lastAt || t > x.lastAt) x.lastAt = t;
      };
      const header = (j: Obj) => {
        st.sid = str(j.sessionId);
        if (j.kind !== undefined && j.kind !== "main") st.skip = true;
        time(ms(j.startTime));
        time(ms(j.lastUpdated));
      };
      const message = (m: Obj, at: number) => {
        const x = facts();
        if (!x || st.skip) return;
        const key = x.key;
        const t = ms(m.timestamp);
        const type = m.type;
        if (type === "user") {
          time(t);
          const text = finish(cleanPromptBlock(textOf(m.content ?? m.message ?? m.text)).text);
          if (!text) return;
          sink.doc({ key, field: "prompt", at: t, text, offset: at });
          if (!st.fa) {
            st.fa = true;
            x.title = { text: finish(firstAskTitle(text), 200), rank: TITLE_RANK.firstAsk };
          }
        } else if (type === "gemini" || type === "model") {
          time(t);
          const text = finish(textOf(m.content ?? m.message ?? m.text));
          if (text) sink.doc({ key, field: "reply", at: t, text, offset: at });
          for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
            const o = obj(c);
            const name = str(o?.name);
            if (name)
              sink.doc({
                key,
                field: "tool",
                at: t,
                text: toolLine(name, toolArg(o?.args, ["absolute_path", "dir_path", "file_paths"])),
                offset: at,
                tool: name,
              });
          }
        }
      };

      let offset = from.offset;
      if (file.kind === "append") {
        const onLine: OnLine = (buf, s, e, at) => {
          const j = parseLine(buf, s, e);
          if (!j) {
            bad++;
            return;
          }
          if (typeof j.sessionId === "string" && j.type === undefined && !j.$set) header(j);
          else if (j.$set) time(ms(obj(j.$set)?.lastUpdated));
          else message(j, at);
        };
        const r = readAppend(file.path, from.offset, onLine, opts);
        offset = r.offset;
        bad += r.bad;
      } else {
        let j: Obj | undefined;
        try {
          j = obj(JSON.parse(readFileSync(file.path, "utf8")));
        } catch {
          return { offset: 0, bad: 1 };
        }
        if (!j) return { offset: 0, bad: 1 };
        header(j);
        const msgs = Array.isArray(j.messages) ? j.messages : [];
        msgs.forEach((m, i) => {
          const o = obj(m);
          if (o) message(o, i);
        });
        offset = msgs.length;
      }
      const x = facts();
      if (x && !st.skip) {
        x.path = file.path;
        const root = projectRoot(file.path);
        if (root) x.cwd = root;
        sink.facts(x);
      }
      return { offset, state: st, ...(bad ? { bad } : {}) };
    },
  };
}

/** Older Gemini CLI's `tmp/<project>/logs.json`: `[{sessionId, messageId, type: "user",
 *  message, timestamp}]`, the person's prompts only (no replies were kept there). */
function readLogs(file: SourceFile, sink: DocSink): ReadResult {
  let list: unknown;
  try {
    list = JSON.parse(readFileSync(file.path, "utf8"));
  } catch {
    return { offset: 0, bad: 1 };
  }
  if (!Array.isArray(list)) return { offset: 0, bad: 1 };
  const facts = new Map<string, SessionFacts>();
  const root = projectRoot(path.join(path.dirname(file.path), "chats", "x"));
  list.forEach((e, i) => {
    const o = obj(e);
    const sid = str(o?.sessionId);
    if (!o || !sid || o.type !== "user") return;
    const key = sessionKey(HARNESS, sid);
    const t = ms(o.timestamp);
    const text = finish(cleanPromptBlock(str(o.message)).text);
    let f = facts.get(key);
    if (!f) {
      f = { key, harness: HARNESS, id: sid, path: file.path };
      if (root) f.cwd = root;
      facts.set(key, f);
    }
    if (t) {
      if (!f.firstAt || t < f.firstAt) f.firstAt = t;
      if (!f.lastAt || t > f.lastAt) f.lastAt = t;
    }
    if (!text) return;
    sink.doc({ key, field: "prompt", at: t, text, offset: i });
    if (!f.title) f.title = { text: finish(firstAskTitle(text), 200), rank: TITLE_RANK.firstAsk };
  });
  for (const f of facts.values()) sink.facts(f);
  return { offset: list.length };
}
