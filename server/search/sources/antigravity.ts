// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. Antigravity history (sources.md §4), in both layouts of
// `~/.gemini/antigravity{,-cli,-ide}/brain/<id>/`:
//   transcript  `.system_generated/logs/transcript.jsonl` (newer builds; one step a line)
//   artifacts   `task.md` / `implementation_plan.md` / `walkthrough.md` / any `*.md` with
//               a `.metadata.json`, the metadata summaries, and user-visible
//               `.system_generated/messages/*.json` (`hideFromUser` ones are skipped)
// Never `*.pb` (encrypted), never `.resolved*` snapshots, never `steps/N/content.md`
// (a step's tool output, which S2 never indexes).
import { existsSync, readFileSync, statSync } from "node:fs";
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
import { antigravityDirs, list } from "./homes.js";
import { type OnLine, parseLine, readAppend } from "./prefilter.js";
import { cleanPromptBlock, finish, firstAskTitle, ms, toolLine } from "./text.js";

export const HARNESS = "antigravity";
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_ARTIFACTS = new Set(["task.md", "implementation_plan.md", "walkthrough.md"]);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Antigravity tool args use PascalCase (`CommandLine`, `AbsolutePath`): the first useful one. */
const AG_KEYS = [
  "commandline",
  "command",
  "cmd",
  "absolutepath",
  "targetfile",
  "file_path",
  "filepath",
  "path",
  "searchpath",
  "directorypath",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
  "task",
  "summary",
];
export function antigravityToolLine(name: string, args: unknown): string {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {}
  }
  const o = obj(a);
  let arg = typeof a === "string" ? a : "";
  if (o) {
    const lower = new Map<string, unknown>();
    for (const [k, v] of Object.entries(o)) lower.set(k.toLowerCase(), v);
    for (const k of AG_KEYS) {
      const v = lower.get(k);
      if (typeof v === "string" && v.trim()) {
        arg = v;
        break;
      }
    }
  }
  return toolLine(name, arg);
}

/** `<USER_REQUEST>…</USER_REQUEST>` is the person's ask; `<META>` and other wrappers are not. */
export function antigravityRequest(content: string): string {
  const m = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/.exec(content);
  const raw = m ? (m[1] ?? "") : content.replace(/<META>[\s\S]*?<\/META>/g, "");
  return cleanPromptBlock(raw).text;
}

interface Brain {
  id: string;
  dir: string;
}
/** `…/brain/<id>/<rest>` → the brain. */
function brainOf(p: string): Brain | undefined {
  const parts = p.split(path.sep);
  const i = parts.lastIndexOf("brain");
  const id = parts[i + 1];
  if (i < 0 || !id || !ID.test(id)) return undefined;
  return { id: id.toLowerCase(), dir: parts.slice(0, i + 2).join(path.sep) };
}

const transcriptOf = (brainDir: string): string | undefined => {
  for (const p of [
    path.join(brainDir, ".system_generated", "logs", "transcript.jsonl"),
    path.join(brainDir, "logs", "transcript.jsonl"),
  ])
    if (existsSync(p)) return p;
  return undefined;
};

export function antigravityAdapter(): SourceAdapter {
  let dirs: string[] = [];
  return {
    id: "antigravity",
    source: "history",

    roots(env: SourceEnv): string[] {
      return dirs.length ? dirs : antigravityDirs(env).map((d) => path.join(d, "brain"));
    },

    async discover(env: SourceEnv): Promise<SourceFile[]> {
      const out: SourceFile[] = [];
      const roots: string[] = [];
      const add = (p: string, kind: SourceFile["kind"], key: string) => {
        try {
          const st = statSync(p);
          if (st.isFile()) out.push({ path: p, adapter: "antigravity", kind, size: st.size, mtimeMs: st.mtimeMs, key });
        } catch {}
      };
      for (const data of antigravityDirs(env)) {
        const brainRoot = path.join(data, "brain");
        roots.push(brainRoot);
        for (const b of list(brainRoot)) {
          if (!b.isDirectory() || !ID.test(b.name)) continue;
          const dir = path.join(brainRoot, b.name);
          const key = sessionKey(HARNESS, b.name.toLowerCase());
          roots.push(dir);
          const t = transcriptOf(dir);
          if (t) add(t, "append", key);
          const names = new Set(list(dir).map((d) => d.name));
          for (const n of names) {
            if (!n.endsWith(".md")) continue;
            if (KNOWN_ARTIFACTS.has(n) || names.has(`${n}.metadata.json`)) add(path.join(dir, n), "whole", key);
          }
          for (const n of names) if (n.endsWith(".md.metadata.json")) add(path.join(dir, n), "whole", key);
          const msgs = path.join(dir, ".system_generated", "messages");
          for (const m of list(msgs))
            if (m.isFile() && m.name.endsWith(".json")) add(path.join(msgs, m.name), "whole", key);
        }
      }
      dirs = roots;
      return out;
    },

    async read(file: SourceFile, from: ReadCursor, sink: DocSink, opts: ReadOptions = {}): Promise<ReadResult> {
      const brain = brainOf(file.path);
      if (!brain) return { offset: from.offset, state: from.state, skipped: "unreadable" };
      const key = sessionKey(HARNESS, brain.id);
      const f: SessionFacts = { key, harness: HARNESS, id: brain.id };
      const time = (t: number) => {
        if (!t) return;
        if (!f.firstAt || t < f.firstAt) f.firstAt = t;
        if (!f.lastAt || t > f.lastAt) f.lastAt = t;
      };
      const base = path.basename(file.path);
      const hasTranscript = !!transcriptOf(brain.dir);

      if (file.kind === "append") {
        const st = (obj(from.state) ? { ...(from.state as Obj) } : {}) as { [k: string]: AdapterState };
        let bad = 0;
        const onLine: OnLine = (buf, s, e, at) => {
          const j = parseLine(buf, s, e);
          if (!j) {
            bad++;
            return;
          }
          if (j.hideFromUser === true) return;
          const t = ms(j.created_at) || ms(j.timestamp);
          const c = str(j.content);
          if (j.type === "USER_INPUT") {
            time(t);
            const text = finish(antigravityRequest(c));
            if (!text) return;
            sink.doc({ key, field: "prompt", at: t, text, offset: at });
            if (!st.fa) {
              st.fa = true;
              f.title = {
                text: finish(firstAskTitle(text.split("\n").find((l) => l.trim()) ?? text), 200),
                rank: TITLE_RANK.firstAsk,
              };
            }
          } else if (j.type === "PLANNER_RESPONSE") {
            time(t);
            const text = finish(c);
            if (text) sink.doc({ key, field: "reply", at: t, text, offset: at });
            for (const call of Array.isArray(j.tool_calls) ? j.tool_calls : []) {
              const o = obj(call);
              const name = str(o?.name);
              if (!name) continue;
              const line = antigravityToolLine(name, o?.args);
              sink.doc({ key, field: "tool", at: t, text: line, offset: at, tool: name });
              if (!f.cwd) {
                const cwd = str(obj(o?.args)?.Cwd);
                if (cwd && path.isAbsolute(cwd)) f.cwd = cwd;
              }
            }
          }
        };
        const r = readAppend(file.path, from.offset, onLine, opts);
        bad += r.bad;
        f.path = file.path;
        sink.facts(f);
        return { offset: r.offset, state: st, ...(bad ? { bad } : {}) };
      }

      // Whole files: one record each.
      let st: { mtimeMs: number };
      let text: string;
      try {
        st = statSync(file.path);
        text = readFileSync(file.path, "utf8");
      } catch {
        return { offset: 0, skipped: "unreadable" };
      }
      if (!hasTranscript) f.path = brain.dir;
      if (base.endsWith(".md.metadata.json")) {
        let j: Obj | undefined;
        try {
          j = obj(JSON.parse(text));
        } catch {
          return { offset: 1, bad: 1 };
        }
        const t = ms(j?.updatedAt) || st.mtimeMs;
        time(t);
        const summary = finish(str(j?.summary));
        if (summary) sink.doc({ key, field: "reply", at: t, text: summary, offset: 0 });
        if (summary && !hasTranscript)
          f.title = { text: finish(firstAskTitle(summary), 200), rank: TITLE_RANK.firstAsk - 3 };
        sink.facts(f);
        return { offset: 1 };
      }
      if (base.endsWith(".md")) {
        let t = st.mtimeMs;
        try {
          t = ms(obj(JSON.parse(readFileSync(`${file.path}.metadata.json`, "utf8")))?.updatedAt) || t;
        } catch {}
        time(t);
        const body = finish(text);
        if (body) sink.doc({ key, field: "reply", at: t, text: body, offset: 0 });
        const h = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
        if (h && !hasTranscript) {
          // task.md names the conversation best, then the plan, then any other artifact.
          const rank =
            base === "task.md"
              ? TITLE_RANK.firstAsk
              : base === "implementation_plan.md"
                ? TITLE_RANK.firstAsk - 1
                : TITLE_RANK.firstAsk - 2;
          f.title = { text: finish(firstAskTitle(h), 200), rank };
        }
        sink.facts(f);
        return { offset: 1 };
      }
      // .system_generated/messages/<id>.json
      let j: Obj | undefined;
      try {
        j = obj(JSON.parse(text));
      } catch {
        return { offset: 1, bad: 1 };
      }
      if (!j || j.hideFromUser === true) return { offset: 1 };
      const t = ms(j.timestamp) || st.mtimeMs;
      const body = finish(str(j.content));
      if (body) {
        time(t);
        sink.doc({ key, field: str(j.sender) === "user" ? "prompt" : "reply", at: t, text: body, offset: 0 });
        sink.facts(f);
      }
      return { offset: 1 };
    },
  };
}
