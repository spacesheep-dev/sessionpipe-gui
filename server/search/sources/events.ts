// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. What sessionpipe delivered, from the store's own files
// `<stateDir>/events/<harness>/<id>.jsonl` (server/store/files.ts), at exactly the tier
// each event arrived at (S2): transcript text only from a tier ≥ 2 event, tool input only
// from tier 3, an attention message from tier ≥ 1. Never the outbox, never ~/.local/state.
import { statSync } from "node:fs";
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
import { list } from "./homes.js";
import { Finder, type OnLine, parseLine, readAppend } from "./prefilter.js";
import { cleanPromptBlock, finish, ms, toolArg, toolLine } from "./text.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Seqs remembered per file for tier upgrades (the store appends the richer copy). */
const SEEN = 96;

const RANK: Record<string, number> = {
  custom: TITLE_RANK.custom,
  harness: TITLE_RANK.harness,
  "first-ask": TITLE_RANK.firstAsk,
};

/** A short fingerprint of a text's start (does a longer progress text continue it?). */
function fp(s: string, upTo = s.length): number {
  let h = 2166136261;
  const n = Math.min(s.length, upTo, 64);
  for (let i = 0; i < n; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Start a continuation at a word boundary a little before `from`, so no word is split. */
function tail(s: string, from: number): string {
  // Already on a word boundary: nothing to repeat.
  if (/\s/.test(s[from] ?? " ") || /\s/.test(s[from - 1] ?? " ")) return s.slice(from);
  let i = from;
  const floor = Math.max(0, from - 40);
  while (i > floor && !/\s/.test(s[i - 1] ?? "")) i--;
  return s.slice(i === floor ? from : i);
}

/** sessionpipe's summary of a tool input (tier 3): the same key list as the history. */
function inputSummary(input: unknown): string {
  if (typeof input === "string") {
    const t = input.trim();
    if (t.startsWith("{")) {
      try {
        return toolArg(JSON.parse(t), ["title", "message", "name"]);
      } catch {}
    }
    return t;
  }
  return toolArg(input, ["title", "message", "name"]);
}

export function eventsAdapter(): SourceAdapter {
  let dirs: string[] = [];
  return {
    id: "events",
    source: "sessionpipe",

    roots(env: SourceEnv): string[] {
      return dirs.length ? dirs : [path.join(env.stateDir, "events")];
    },

    async discover(env: SourceEnv): Promise<SourceFile[]> {
      const root = path.join(env.stateDir, "events");
      const roots = [root];
      const out: SourceFile[] = [];
      for (const h of list(root)) {
        if (!h.isDirectory()) continue;
        const dir = path.join(root, h.name);
        roots.push(dir);
        for (const e of list(dir)) {
          if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
          const p = path.join(dir, e.name);
          try {
            const st = statSync(p);
            out.push({
              path: p,
              adapter: "events",
              kind: "append",
              size: st.size,
              mtimeMs: st.mtimeMs,
              key: sessionKey(h.name, e.name.slice(0, -6)),
            });
          } catch {}
        }
      }
      dirs = roots;
      return out;
    },

    async read(file: SourceFile, from: ReadCursor, sink: DocSink, opts: ReadOptions = {}): Promise<ReadResult> {
      const st = (obj(from.state) ? { ...(from.state as Obj) } : {}) as { [k: string]: AdapterState };
      const seen: number[] = Array.isArray(st.s) ? (st.s as number[]).slice() : [];
      const pg = (obj(st.p) ? { ...(st.p as Obj) } : { n: -1, u: 0, a: 0, h: 0 }) as {
        n: number;
        u: number;
        a: number;
        h: number;
      };
      const facts = new Map<string, SessionFacts>();
      let lastTitle: [string, string] = ["", ""];
      let bad = 0;
      const F = {
        beat: new Finder('"type":"session.heartbeat"'),
        start: new Finder('"type":"tool.started"'),
        native: new Finder('"type":"native"'),
        title: new Finder('"title":"'),
      };

      const factsFor = (key: string, harness: string, id: string): SessionFacts => {
        let f = facts.get(key);
        if (!f) {
          f = { key, harness, id };
          facts.set(key, f);
        }
        return f;
      };

      const onLine: OnLine = (buf, s, e, at, gen) => {
        // Events that never carry words are skipped unless they may rename the session.
        if (
          (F.beat.has(buf, gen, s, e) || F.start.has(buf, gen, s, e) || F.native.has(buf, gen, s, e)) &&
          !F.title.has(buf, gen, s, e)
        )
          return;
        const ev = parseLine(buf, s, e);
        const sess = obj(ev?.session);
        const harness = str(obj(ev?.harness)?.name);
        const sid = str(sess?.id);
        if (!ev || !sess || !harness || !sid) {
          bad++;
          return;
        }
        const type = str(ev.type);
        const tier = typeof ev.tier === "number" ? ev.tier : 0;
        const seq = typeof sess.seq === "number" ? sess.seq : undefined;
        const time = ms(ev.time);
        const data = obj(ev.data) ?? {};
        const parent = str(sess.parent_id);
        // A child session's words belong to its parent's row, as the history's subagents do;
        // its seq names an event in the child's own stream, so it is not carried.
        const key = sessionKey(harness, parent || sid);
        const agentId = parent ? sid : str(data.agent_id) || undefined;

        // Facts: the session block (machine, folder, repo, branch, title) and the times.
        const f = factsFor(key, harness, parent || sid);
        if (time) {
          if (!f.firstAt || time < f.firstAt) f.firstAt = time;
          if (!f.lastAt || time > f.lastAt) f.lastAt = time;
        }
        if (!parent) {
          if (typeof sess.machine === "string" && sess.machine) f.machine = sess.machine;
          if (typeof sess.cwd === "string" && sess.cwd) f.cwd = sess.cwd;
          if (typeof sess.repo === "string" && sess.repo) f.repo = sess.repo;
          if (typeof sess.branch === "string" && sess.branch && sess.branch !== "HEAD") f.branch = sess.branch;
          if (typeof sess.model === "string" && sess.model) f.model = sess.model;
          const title = str(sess.title).trim();
          if (title) {
            const rank = RANK[str(sess.title_source)] ?? TITLE_RANK.firstAsk;
            // Every event repeats the title: redact it once per distinct value.
            if (title !== lastTitle[0]) lastTitle = [title, finish(title.replace(/\s+/g, " "), 200)];
            if (!f.title || rank >= f.title.rank) f.title = { text: lastTitle[1], rank };
          }
        }

        // Tier upgrades: the store appends the richer copy of an event it already holds.
        if (seq !== undefined) {
          let dup = -1;
          for (let i = 0; i < seen.length; i += 2) if (seen[i] === seq) dup = i;
          if (dup >= 0) {
            if (tier <= (seen[dup + 1] ?? 0)) return;
            seen[dup + 1] = tier;
          } else {
            seen.push(seq, tier);
            if (seen.length > SEEN * 2) seen.splice(0, seen.length - SEEN * 2);
          }
        }

        const emit = (d: Omit<SearchDoc, "key">) => {
          const doc: SearchDoc = { key, ...d };
          if (seq !== undefined && !parent) doc.seq = seq;
          if (agentId) doc.agent = agentId;
          sink.doc(doc);
        };
        const prompt = (raw: string, t: number) => {
          const text = finish(cleanPromptBlock(raw).text);
          if (text) emit({ field: "prompt", at: t, text, offset: at });
        };
        const reply = (raw: string, t: number) => {
          const text = finish(raw);
          if (text) emit({ field: "reply", at: t, text, offset: at });
        };

        if ((type === "turn.transcript" || type === "turn.progress") && tier >= 2) {
          const turn = typeof data.turn === "number" ? data.turn : -2;
          const t = ms(data.at) || time;
          const user = str(data.user);
          const asst = str(data.assistant);
          const same = turn === pg.n && !parent;
          if (user && !(same && pg.u)) prompt(user, t);
          if (asst) {
            // The same turn's text grown: only the new part (a word-aligned continuation).
            const cont = same && pg.a > 0 && fp(asst, pg.a) === pg.h;
            if (cont && asst.length > pg.a) reply(tail(asst, pg.a), t);
            else if (!cont) reply(asst, t);
          }
          if (!parent) {
            if (!same) {
              pg.n = turn;
              pg.u = 0;
              pg.a = 0;
              pg.h = 0;
            }
            if (user) pg.u = 1;
            if (asst && asst.length >= pg.a) {
              pg.a = asst.length;
              pg.h = fp(asst);
            }
          }
        } else if (type === "tool.ended" && tier >= 1) {
          const name = str(data.tool);
          if (!name) return;
          const arg = tier >= 3 ? inputSummary(data.input) : "";
          emit({ field: "tool", at: time, text: toolLine(name, arg), offset: at, tool: name });
        } else if (type === "files.changed" && tier >= 1) {
          // The paths a tier-1 session touched: at that tier the only way to find it by file.
          const paths = (Array.isArray(data.paths) ? data.paths : []).filter((p): p is string => typeof p === "string");
          if (paths.length)
            emit({
              field: "tool",
              at: time,
              text: toolLine("Changed", paths.join(" ")),
              offset: at,
              tool: "files.changed",
            });
        } else if (type === "attention.needed" && tier >= 1) {
          const m = str(data.message);
          if (m) prompt(m, time);
        }
      };

      const r = readAppend(file.path, from.offset, onLine, opts);
      bad += r.bad;
      for (const f of facts.values()) sink.facts(f);
      st.s = seen;
      st.p = pg;
      return { offset: r.offset, state: st, ...(bad ? { bad } : {}) };
    },
  };
}
