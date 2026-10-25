#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. A synthetic history home for session search (SEARCH-SPEC.md §7–§8):
// every format the sources read, written the way each harness writes it, with planted
// needles whose right answers are known, so the gate and the tests can check what is found
// (and what must never be). Deterministic: the same seed and options give the same bytes.
// Invented content only; nothing here comes from a real log.
//
//   node bench/search/gen.mjs --out DIR [--profile gate|real|dense|demo] [--size 60MB]
//                             [--seed 42] [--now ISO] [--zstd auto|off]
//
// Writes DIR/home (the HOME the adapters read: .claude, .claude-work, .codex, .gemini) and
// DIR/state/events (the store's event files), and DIR/manifest.json:
//   { bytes, diskBytes, files, sessions: {harness: n}, messages, textBytes, needles: [
//       { q, keys, kind: "must"|"never"|"soft", why, sources? } ] }
// A "must" needle's query returns exactly `keys`; a "never" needle returns nothing (tool
// output, thinking, notices, guardian copies, redacted secrets, a partial last line, …);
// a "soft" one is a reading of a format rule the sources may word differently.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// ───────────────────────────── options ─────────────────────────────

export function parseArgs(argv) {
  const o = { out: "", profile: "gate", size: 0, seed: 42, now: 0, zstd: "auto" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--out") o.out = v();
    else if (a === "--profile") o.profile = v();
    else if (a === "--demo") o.profile = "demo";
    else if (a === "--size") o.size = parseSize(v());
    else if (a === "--seed") o.seed = Number(v());
    else if (a === "--now") o.now = Date.parse(v());
    else if (a === "--zstd") o.zstd = v();
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.out) throw new Error("--out DIR is required");
  return o;
}

export function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(k|m|g)?b?$/i.exec(String(s).trim());
  if (!m) throw new Error(`bad size ${s}`);
  const mult = { k: 1e3, m: 1e6, g: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

/** Per profile: `turns` = median turns of a Claude / Codex session (gate: longer sessions, so
 *  ~1,000 files hold 60 MB; this Mac averages 4–10 MB a file, so per-file costs are still
 *  over-weighted 25×), words per prompt/reply, tool calls per turn, tool output words, and the
 *  share of bulky non-text records. `real` lands near 1 % indexable text (sources.md §0). */
const PROFILES = {
  gate: {
    size: 60e6,
    prompt: [2, 14],
    reply: [2, 16],
    tools: [0, 1],
    out: [1, 8],
    api: 0,
    blocks: 5,
    big: 0,
    meta: 0.08,
    dup: 0.03,
    turns: [45, 30],
  },
  real: {
    size: 60e6,
    prompt: [6, 60],
    reply: [15, 180],
    tools: [1, 6],
    out: [400, 2600],
    api: 0.25,
    blocks: 2,
    big: 0.002,
    meta: 0.25,
    dup: 0.1,
  },
  dense: {
    size: 30e6,
    prompt: [20, 160],
    reply: [80, 500],
    tools: [0, 1],
    out: [3, 12],
    api: 0,
    blocks: 1,
    big: 0,
    meta: 0.1,
    dup: 0,
  },
  demo: {
    size: 0,
    prompt: [0, 0],
    reply: [0, 0],
    tools: [0, 0],
    out: [0, 0],
    api: 0,
    blocks: 1,
    big: 0,
    meta: 0,
    dup: 0,
  },
};

// ───────────────────────────── randomness and words ─────────────────────────────

function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE = `the of and to a in is that for it as with was on be by this are or from at an but not have
error code test build file server client session index search query token result value function
return import export const type interface async await promise string number array object map set
user message reply tool agent machine repo branch commit merge rebase push pull fix bug feature
config option flag path folder directory read write open close start stop run deploy release
store event stream receiver control daemon hook outbox sink pair key sign verify trust device
phone canvas board feed inbox review label colour theme skin font layout render paint frame
latency throughput memory cache segment posting dictionary prefix phrase ranking recency snippet
webhook retry limiter queue worker timeout schema migration table column row cursor page
please could you would should check look why how what where when which make sure also then`.split(/\s+/);
const SYL = [
  "ka",
  "to",
  "ri",
  "men",
  "sa",
  "lo",
  "vi",
  "dra",
  "qu",
  "el",
  "on",
  "ar",
  "is",
  "ex",
  "pro",
  "tran",
  "log",
  "net",
  "mat",
  "cor",
];
const INTL = [
  "Ошибка сборки при запуске сервера",
  "Café résumé naïve façade",
  "検索インデックスの更新",
  "Größe der Datei überprüfen",
  "한국어 검색 테스트",
];

class Words {
  constructor(r) {
    this.r = r;
    const vocab = [...BASE];
    while (vocab.length < 40000) {
      let w = "";
      const n = 2 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) w += SYL[Math.floor(r() * SYL.length)];
      vocab.push(w);
    }
    this.vocab = vocab;
    const H = new Float64Array(vocab.length);
    let acc = 0;
    for (let i = 0; i < vocab.length; i++) {
      acc += 1 / (i + 1) ** 1.07;
      H[i] = acc;
    }
    this.H = H;
    this.acc = acc;
  }
  pick(a) {
    return a[Math.floor(this.r() * a.length)];
  }
  int(lo, hi) {
    return lo + Math.floor(this.r() * (hi - lo + 1));
  }
  zipf() {
    const x = this.r() * this.acc;
    let lo = 0;
    let hi = this.H.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.H[m] < x) lo = m + 1;
      else hi = m;
    }
    return this.vocab[lo];
  }
  hex(n) {
    let s = "";
    for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(this.r() * 16)];
    return s;
  }
  uuid() {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-a${this.hex(3)}-${this.hex(12)}`;
  }
  ident() {
    const a = this.zipf();
    const b = this.zipf();
    const x = this.r();
    return x < 0.4 ? a + b[0].toUpperCase() + b.slice(1) : x < 0.7 ? `${a}_${b}` : `${a}.${b}()`;
  }
  file() {
    return `src/${this.zipf()}/${this.ident().replace(/[.()]/g, "")}.ts`;
  }
  text(n) {
    const o = [];
    for (let i = 0; i < n; i++) {
      const x = this.r();
      let w =
        x < 0.07
          ? this.ident()
          : x < 0.09
            ? this.file()
            : x < 0.1
              ? this.hex(8)
              : x < 0.105
                ? String(this.int(0, 5000))
                : this.zipf();
      if (this.r() < 0.06) w += ".";
      o.push(w);
    }
    if (this.r() < 0.01) o.push(this.pick(INTL));
    return o.join(" ");
  }
}

// ───────────────────────────── needles ─────────────────────────────

/** Words that occur nowhere else (the vocabulary is lowercase syllables and BASE). */
const N = {
  phrase: "purple elephant migration",
  phraseDecoy: "migration elephant purple",
  camel: "quokkaSerializerFactory",
  path: "src/zanzibar/handshakeProtocol.ts",
  cjk: "検索インデックス再構築",
  diacritic: "Größenänderung",
  queued: "marmaladequeuedprompt",
  queuedStr: "tangerinequeuedstring",
  ide: "kumquatafteride",
  command: "persimmoncommandargs",
  textAndResult: "lycheebesideresult",
  sub: "narwhalsubagentfinding",
  wf: "ocelotworkflowagent",
  forkShared: "pangolinsharedprefix",
  forkOwn: "wombatforkonly",
  work: "capybaraworkhome",
  codexPrompt: "axolotlcodexask",
  codexFiles: "dugongfilesmentioned",
  codexTool: "jerboaexeccommand",
  codexPatchPath: "src/fennec/patchTarget.ts",
  codexSub: "tapirspawnedthread",
  codexReplay: "okapireplayedpart",
  codexForkOwn: "quetzalcodexfork",
  zst: "manateecompressed",
  agyTranscript: "gharialtranscriptask",
  agyTool: "kinkajouplannertool",
  agyArtifact: "saigaartifacttask",
  agyPlan: "binturongplanstep",
  geminiJsonl: "tarsierjsonlchat",
  geminiJson: "civetwholechat",
  geminiTool: "numbatgeminitool",
  events: "aardwolfeventsonly",
  eventsTool: "caracaleventstool",
  eventsAttn: "fossaneedsanswer",
  eventsShadow: "dikdikshadowed",
  title: "ibexrenamedtitle",
  codexTitle: "serowthreadname",
  // never
  toolOut: "xylophonetooloutput",
  think: "thinkingonlyquasar",
  notice: "noticeonlyzephyr",
  taskNote: "tasknotificationonly",
  api: "apirequestblobonly",
  journal: "journalresultonly",
  toolResultsDir: "persistedtoolresult",
  partial: "partiallastlineonly",
  codexOut: "codexfunctionoutput",
  codexDev: "developerroleonly",
  codexEnv: "environmentcontextonly",
  codexReason: "reasoningsummaryonly",
  codexCompact: "compactedhistoryonly",
  codexEventDup: "eventmsgduplicate",
  patchBody: "patchbodyonlyline",
  guardian: "guardianreviewcopy",
  baseInstr: "baseinstructionsonly",
  agyHidden: "hiddensystemmessage",
  agyStep: "stepcontentonly",
  agyResolved: "resolvedsnapshotonly",
  agyToolOut: "antigravitytoolresult",
  geminiThought: "geminithoughtonly",
  geminiResult: "geminitoolresultonly",
  eventsOut: "eventstooloutputonly",
  tierLeak: "tieronetranscriptleak",
  tierInput: "tiertwotoolinput",
};

function makeSecrets(w) {
  const up = (n) => {
    let s = "";
    for (let i = 0; i < n; i++) s += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[Math.floor(w.r() * 32)];
    return s;
  };
  const al = (n) => {
    let s = "";
    for (let i = 0; i < n; i++)
      s += "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(w.r() * 62)];
    return s;
  };
  return {
    aws: `AKIA${up(16)}`,
    github: `ghp_${al(36)}`,
    anthropic: `sk-ant-api03-${al(48)}`,
    slack: `xoxb-${w.int(1e11, 9e11)}-${w.int(1e12, 9e12)}-${al(24)}`,
  };
}

// ───────────────────────────── the writer ─────────────────────────────

class Out {
  constructor(o) {
    this.o = o;
    this.home = path.join(o.out, "home");
    this.state = path.join(o.out, "state");
    this.bytes = 0;
    this.diskBytes = 0;
    this.files = 0;
    this.textBytes = 0;
    this.messages = 0;
    this.sessions = {};
    this.zstdMode =
      o.zstd === "off" ? "off" : typeof zlib.zstdCompressSync === "function" ? "zlib" : hasZstd() ? "cmd" : "off";
    this.zstFiles = 0;
    this.pending = [];
  }
  /** Compresses the pending files with one `zstd` per batch (through files, never a pipe). */
  finish() {
    for (let i = 0; i < this.pending.length; i += 200) {
      const batch = this.pending.slice(i, i + 200);
      const r = spawnSync("zstd", ["-q", "-f", "-3", "--rm", ...batch], { stdio: "ignore", timeout: 300_000 });
      if (r.status !== 0) throw new Error("zstd failed");
      for (const p of batch) this.diskBytes += statSync(`${p}.zst`).size;
    }
    this.pending = [];
  }
  write(p, body, opts = {}) {
    mkdirSync(path.dirname(p), { recursive: true });
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    if (!opts.uncounted) this.bytes += buf.length;
    if (opts.zst && this.zstdMode !== "off") {
      if (this.zstdMode === "zlib") {
        const z = zlib.zstdCompressSync(buf);
        writeFileSync(`${p}.zst`, z);
        this.diskBytes += z.length;
      } else {
        writeFileSync(p, buf);
        this.pending.push(p);
      }
      this.zstFiles++;
    } else {
      writeFileSync(p, buf);
      this.diskBytes += buf.length;
    }
    this.files++;
    return opts.zst && this.zstdMode !== "off" ? `${p}.zst` : p;
  }
  session(h) {
    this.sessions[h] = (this.sessions[h] ?? 0) + 1;
  }
  text(s) {
    this.textBytes += Buffer.byteLength(s);
    this.messages++;
    return s;
  }
}

function hasZstd() {
  try {
    return spawnSync("zstd", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

const iso = (t) => new Date(t).toISOString();
const slugOf = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

// ───────────────────────────── needle bookkeeping ─────────────────────────────

class Needles {
  constructor() {
    this.map = new Map();
  }
  /** `q` must return exactly the keys it was planted in. */
  must(q, key, why, extra = {}) {
    const n = this.map.get(q) ?? { q, keys: [], kind: "must", why, ...extra };
    if (key && !n.keys.includes(key)) n.keys.push(key);
    this.map.set(q, n);
  }
  soft(q, key, why) {
    this.must(q, key, why, { kind: "soft" });
  }
  never(q, why) {
    if (!this.map.has(q)) this.map.set(q, { q, keys: [], kind: "never", why });
  }
  list() {
    return [...this.map.values()].map((n) => ({ ...n, keys: n.keys.sort() }));
  }
}

// ───────────────────────────── Claude Code ─────────────────────────────

class ClaudeFile {
  constructor(g, { sid, cwd, t, agentId, sidechain }) {
    this.g = g;
    this.sid = sid;
    this.cwd = cwd;
    this.t = t;
    this.agentId = agentId;
    this.sidechain = !!sidechain;
    this.lines = [];
    this.prev = null;
    this.records = [];
  }
  tick() {
    this.t += 1500 + Math.floor(this.g.w.r() * 40000);
    return this.t;
  }
  env(type, rest, { msgFirst = false } = {}) {
    const uuid = this.g.w.uuid();
    const base = {
      parentUuid: this.prev,
      isSidechain: this.sidechain,
      userType: "external",
      cwd: this.cwd,
      sessionId: this.sid,
      version: "2.1.296",
      gitBranch: "main",
      ...(this.agentId ? { agentId: this.agentId } : {}),
      entrypoint: "claude-vscode",
    };
    const rec = msgFirst
      ? { ...base, message: rest.message, ...rest, type, uuid, timestamp: iso(this.tick()) }
      : { ...base, type, ...rest, uuid, timestamp: iso(this.tick()) };
    this.prev = uuid;
    this.push(rec);
    return rec;
  }
  push(rec) {
    this.records.push(rec);
    this.lines.push(JSON.stringify(rec));
  }
  raw(obj) {
    this.lines.push(JSON.stringify(obj));
  }
  prompt(text) {
    this.g.out.text(text);
    return this.env("user", { message: { role: "user", content: text } });
  }
  promptBlocks(blocks) {
    return this.env("user", { message: { role: "user", content: blocks } });
  }
  reply(text, msgId) {
    this.g.out.text(text);
    return this.env(
      "assistant",
      {
        message: {
          id: msgId ?? `msg_${this.g.w.hex(24)}`,
          type: "message",
          role: "assistant",
          model: "claude-opus-4-5",
          content: [{ type: "text", text }],
        },
        requestId: `req_${this.g.w.hex(24)}`,
      },
      { msgFirst: this.g.w.r() < 0.5 },
    );
  }
  thinking(text) {
    return this.env("assistant", {
      message: {
        id: `msg_${this.g.w.hex(24)}`,
        type: "message",
        role: "assistant",
        content: [{ type: "thinking", thinking: text, signature: this.g.w.hex(64) }],
      },
    });
  }
  tool(name, input, output) {
    const id = `toolu_${this.g.w.hex(24)}`;
    const line = `${name} ${Object.values(input)[0] ?? ""}`;
    this.g.out.text(line);
    this.env(
      "assistant",
      {
        message: {
          id: `msg_${this.g.w.hex(24)}`,
          type: "message",
          role: "assistant",
          content: [{ type: "tool_use", id, name, input }],
        },
      },
      { msgFirst: this.g.w.r() < 0.5 },
    );
    this.env("user", {
      message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: output }] },
      toolUseResult: { stdout: output.slice(0, 200), stderr: "", interrupted: false },
    });
  }
  body() {
    return `${this.lines.join("\n")}\n`;
  }
}

function claudeSession(g, { home, cwd, t, turns, title, extras, account, sid: given }) {
  const { w, p, out } = g;
  const sid = given ?? w.uuid();
  const f = new ClaudeFile(g, { sid, cwd, t });
  const key = `claude-code:${sid}`;
  for (let turn = 0; turn < turns; turn++) {
    f.prompt(w.text(w.int(...p.prompt)));
    if (w.r() < p.meta)
      f.env("user", {
        isMeta: true,
        message: { role: "user", content: `<system-reminder>${w.text(40)}</system-reminder>` },
      });
    if (w.r() < 0.15) f.thinking(w.text(30));
    const nt = w.int(...p.tools);
    for (let k = 0; k < nt; k++) {
      const x = w.r();
      if (x < 0.5)
        f.tool(
          "Bash",
          { command: `rg ${w.zipf()} ${w.file()} | head -${w.int(5, 50)}`, description: w.text(5) },
          w.text(w.int(...p.out)),
        );
      else if (x < 0.8) f.tool("Read", { file_path: `${cwd}/${w.file()}` }, w.text(w.int(...p.out)));
      else f.tool("Edit", { file_path: `${cwd}/${w.file()}`, old_string: w.text(20), new_string: w.text(20) }, "ok");
      if (p.big && w.r() < p.big) f.tool("Read", { file_path: `${cwd}/big.log` }, "x".repeat(1_200_000));
    }
    if (p.api && w.r() < p.api)
      f.raw({
        type: "api-request",
        requestId: `req_${w.hex(20)}`,
        body: { messages: [{ role: "user", content: w.text(w.int(800, 4000)) }] },
      });
    // Several short replies a turn (each its own message: an agent narrating between steps).
    const blocks = w.int(1, p.blocks);
    for (let b = 0; b < blocks; b++) f.reply(w.text(w.int(...p.reply)));
    if (w.r() < 0.3) f.raw({ type: "last-prompt", lastPrompt: "…", sessionId: sid });
    if (w.r() < 0.2)
      f.raw({ type: "file-history-snapshot", messageId: w.uuid(), snapshot: { trackedFileBackups: {} } });
  }
  extras?.(f, key);
  if (title) f.raw({ type: "ai-title", aiTitle: title, sessionId: sid });
  else if (w.r() < 0.8) f.raw({ type: "ai-title", aiTitle: w.text(w.int(3, 6)), sessionId: sid });
  const dir = path.join(home, "projects", slugOf(cwd));
  const file = path.join(dir, `${sid}.jsonl`);
  out.session("claude-code");
  return { sid, key, f, file, dir, account };
}

// ───────────────────────────── Codex ─────────────────────────────

class CodexFile {
  constructor(g, { id, t, cwd, meta }) {
    this.g = g;
    this.id = id;
    this.t = t;
    this.cwd = cwd;
    this.lines = [];
    this.ordinal = 0;
    this.rec("session_meta", {
      id,
      session_id: meta?.session_id ?? id,
      timestamp: iso(t),
      cwd,
      originator: "codex_vscode",
      cli_version: "0.164.0-alpha",
      source: meta?.source ?? "vscode",
      thread_source: meta?.thread_source ?? "user",
      model_provider: "openai",
      git: {
        branch: "main",
        commit_hash: g.w.hex(40),
        repository_url: `https://github.com/acme/${path.basename(cwd)}.git`,
      },
      base_instructions: { text: `You are Codex. ${N.baseInstr} ${g.w.text(200)}` },
      ...(meta?.extra ?? {}),
    });
    this.rec("turn_context", { cwd, model: "gpt-5-codex", approval_policy: "on-request" });
  }
  tick() {
    this.t += 1000 + Math.floor(this.g.w.r() * 30000);
    return this.t;
  }
  rec(type, payload) {
    this.lines.push(JSON.stringify({ timestamp: iso(this.tick()), ordinal: this.ordinal++, type, payload }));
  }
  user(text, count = true) {
    if (count) this.g.out.text(text);
    this.rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
  }
  assistant(text, phase = "final_answer") {
    this.g.out.text(text);
    this.rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }], phase });
  }
  call(name, args, output) {
    const call_id = `call_${this.g.w.hex(20)}`;
    this.g.out.text(`${name} ${JSON.stringify(args)}`);
    this.rec("response_item", { type: "function_call", name, arguments: JSON.stringify(args), call_id });
    this.rec("response_item", { type: "function_call_output", call_id, output });
  }
  patch(files, body) {
    const call_id = `call_${this.g.w.hex(20)}`;
    this.g.out.text(`apply_patch ${files.join(" ")}`);
    const input = `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}\n@@\n-${body}\n+${body} ok`).join("\n")}\n*** End Patch`;
    this.rec("response_item", { type: "custom_tool_call", name: "apply_patch", input, call_id, status: "completed" });
    this.rec("response_item", { type: "custom_tool_call_output", call_id, output: "Success." });
  }
  body() {
    return `${this.lines.join("\n")}\n`;
  }
}

function codexTurns(g, f, turns) {
  const { w, p } = g;
  for (let t = 0; t < turns; t++) {
    const ask = w.text(w.int(...p.prompt));
    f.user(ask);
    if (w.r() < p.dup) f.rec("event_msg", { type: "user_message", message: ask });
    if (w.r() < 0.3) f.rec("response_item", { type: "reasoning", summary: [], encrypted_content: `gAAAA${w.hex(80)}` });
    const nt = w.int(...p.tools);
    for (let k = 0; k < nt; k++)
      f.call("exec_command", { cmd: `rg -n ${w.zipf()} ${w.file()}`, workdir: f.cwd }, w.text(w.int(...p.out)));
    if (w.r() < 0.3) f.patch([w.file()], w.text(8));
    if (w.r() < 0.5) f.assistant(w.text(w.int(4, 20)), "commentary");
    f.assistant(w.text(w.int(...p.reply)));
    f.rec("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: w.int(100, 9000) } } });
  }
}

function codexPath(home, t, id) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
  return path.join(
    home,
    ".codex",
    "sessions",
    String(d.getUTCFullYear()),
    pad(d.getUTCMonth() + 1),
    pad(d.getUTCDate()),
    `rollout-${ts}-${id}.jsonl`,
  );
}

// ───────────────────────────── the generator ─────────────────────────────

export function generate(opts) {
  const o = { profile: "gate", seed: 42, zstd: "auto", ...opts };
  if (!PROFILES[o.profile]) throw new Error(`unknown profile ${o.profile}`);
  // `turns` overrides the profile's session length (tests that want many small files).
  const p = { ...PROFILES[o.profile], ...(o.turns ? { turns: o.turns } : {}) };
  const target = o.size || p.size;
  const now = o.now || (o.profile === "demo" ? Date.now() : Date.parse("2026-10-25T00:00:00Z"));
  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(o.out, { recursive: true });
  const w = new Words(rng(o.seed));
  const out = new Out(o);
  const needles = new Needles();
  const g = { w, p, out, needles, now };
  const H = out.home;
  const t0 = now - 120 * 86_400_000;
  const when = () => t0 + Math.floor(w.r() * 118 * 86_400_000);
  const cwdOf = () => `/Users/dev/git/${w.zipf()}${w.int(1, 40)}`;
  const secrets = makeSecrets(w);

  if (o.profile === "demo") {
    demo(g);
  } else {
    // ── the fixed set: every format and every rule, once ──
    fixedSet(g, { H, when, cwdOf, secrets });
    // ── bulk until the target ──
    const claudeHome = path.join(H, ".claude");
    while (out.bytes < target) {
      const x = w.r();
      const t = when();
      if (x < 0.3) {
        const s = claudeSession(g, {
          home: claudeHome,
          cwd: cwdOf(),
          t,
          turns: Math.max(2, Math.round(Math.exp(Math.log(p.turns?.[0] ?? 18) + (w.r() * 2 - 1) * 1.1))),
        });
        out.write(s.file, s.f.body());
        if (w.r() < 0.35) {
          const sub = new ClaudeFile(g, {
            sid: s.sid,
            cwd: s.f.cwd,
            t: t + 60_000,
            agentId: w.hex(17),
            sidechain: true,
          });
          sub.prompt(w.text(w.int(20, 80)));
          for (let k = 0; k < w.int(2, 8); k++)
            sub.tool("Grep", { pattern: w.zipf(), path: "src" }, w.text(w.int(...p.out)));
          sub.reply(w.text(w.int(...p.reply)));
          out.write(path.join(s.dir, s.sid, "subagents", `agent-${sub.agentId}.jsonl`), sub.body());
          out.write(
            path.join(s.dir, s.sid, "subagents", `agent-${sub.agentId}.meta.json`),
            JSON.stringify({ agentType: "Explore", description: w.text(4) }),
            { uncounted: true },
          );
        }
      } else if (x < 0.95) {
        const id = w.uuid();
        const f = new CodexFile(g, { id, t, cwd: cwdOf() });
        codexTurns(g, f, Math.max(1, Math.round(Math.exp(Math.log(p.turns?.[1] ?? 10) + (w.r() * 2 - 1) * 1.0))));
        out.write(codexPath(H, t, id), f.body(), { zst: w.r() < 0.85 });
        out.session("codex");
      } else {
        // events from another machine
        eventsSession(g, {
          harness: w.r() < 0.6 ? "claude-code" : "codex",
          id: w.uuid(),
          machine: w.pick(["build-box", "studio-mac"]),
          t,
          turns: w.int(2, 12),
        });
      }
    }
  }

  out.finish();
  const manifest = {
    profile: o.profile,
    seed: o.seed,
    now: iso(now),
    bytes: out.bytes,
    diskBytes: out.diskBytes,
    files: out.files,
    zstd: out.zstdMode,
    zstFiles: out.zstFiles,
    sessions: out.sessions,
    messages: out.messages,
    textBytes: out.textBytes,
    secrets: o.profile === "demo" ? [] : Object.values(secrets),
    needles: needles.list(),
  };
  writeFileSync(path.join(o.out, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}

/** One planted instance of every format rule (sources.md §1–§6). */
function fixedSet(g, { H, when, cwdOf, secrets }) {
  const { w, out, needles } = g;
  const claudeHome = path.join(H, ".claude");
  const workHome = path.join(H, ".claude-work");
  writeFileSync(
    path.join(mkdirp(H), ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: w.uuid(), emailAddress: "dev@example.invalid" } }),
  );
  out.write(path.join(workHome, "settings.json"), "{}\n", { uncounted: true });

  // 1. a Claude session with every user-side shape
  const a = claudeSession(g, {
    home: claudeHome,
    cwd: "/Users/dev/git/harbor",
    t: when(),
    turns: 3,
    title: `Harbor ${N.title} work`,
    extras: (f, key) => {
      f.prompt(`Please fix the ${N.phrase} in the importer, and keep ${N.camel} as is.`);
      needles.must(`"${N.phrase}"`, key, "phrase in a prompt");
      needles.must(N.camel, key, "camelCase in a prompt");
      needles.must("serializer factory", key, "camelCase parts as words", { kind: "soft" });
      needles.never(`"${N.phraseDecoy}"`, "words of a phrase out of order");
      f.reply(`I changed ${N.path} so the handshake waits; ${N.cjk} and ${N.diacritic} handled.`);
      needles.must(N.path, key, "path in a reply");
      needles.must(N.cjk, key, "CJK phrase in a reply");
      needles.must(N.diacritic, key, "diacritics in a reply");
      needles.must("grossenanderung", key, "diacritics folded");
      f.tool(
        "Bash",
        { command: `pnpm test && echo ${N.toolOut.slice(0, 3)}`, description: "run tests" },
        `PASS ${N.toolOut} all good`,
      );
      needles.never(N.toolOut, "tool output");
      f.thinking(`Let me consider ${N.think} first.`);
      needles.never(N.think, "thinking");
      f.env("user", {
        isMeta: true,
        message: { role: "user", content: `<system-reminder>${N.notice}</system-reminder>` },
      });
      needles.never(N.notice, "isMeta harness notice");
      f.env("user", {
        origin: { kind: "task-notification" },
        message: { role: "user", content: `<task-notification>${N.taskNote}</task-notification>` },
      });
      needles.never(N.taskNote, "task-notification origin");
      f.raw({ type: "api-request", requestId: "req_x", body: { messages: [{ role: "user", content: N.api }] } });
      needles.never(N.api, "api-request blob");
      f.env("attachment", {
        attachment: {
          type: "queued_command",
          prompt: [
            { type: "text", text: `also ${N.queued} please` },
            { type: "image", source: { type: "base64", data: "iVBORw0KGgo=" } },
          ],
          commandMode: "prompt",
        },
      });
      needles.must(N.queued, key, "queued_command parts list");
      f.env("attachment", { attachment: { type: "queued_command", prompt: `and ${N.queuedStr}` } });
      needles.must(N.queuedStr, key, "queued_command string");
      f.promptBlocks([
        {
          type: "text",
          text: "<ide_opened_file>The user opened the file /Users/dev/git/harbor/a.ts in the IDE.</ide_opened_file>",
        },
        { type: "text", text: `Now look at ${N.ide} in that file` },
      ]);
      needles.must(N.ide, key, "a prompt after a VS Code ide_* block");
      f.prompt(
        `<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>${N.command}</command-args>`,
      );
      needles.soft(N.command, key, "a slash command's args kept as the prompt");
      f.env("user", {
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_y", content: "ok" },
            { type: "text", text: `wait, ${N.textAndResult} instead` },
          ],
        },
      });
      needles.soft(N.textAndResult, key, "text next to a tool_result (no toolUseResult key)");
      f.prompt(`deploy with ${secrets.aws} and ${secrets.github}`);
      f.tool("Bash", { command: `curl -H "x-api-key: ${secrets.anthropic}" https://api.example.invalid` }, "ok");
      f.reply(`Posted to slack with ${secrets.slack}.`);
      f.raw({ type: "custom-title", customTitle: `Harbor ${N.title} work`, sessionId: f.sid });
      needles.must(N.title, key, "a custom title");
    },
  });
  out.write(a.file, a.f.body());
  // tool-results dir and memory: never read
  out.write(path.join(a.dir, a.sid, "tool-results", "toolu_1.txt"), `${N.toolResultsDir}\n`, { uncounted: true });
  needles.never(N.toolResultsDir, "persisted tool-results folder");
  // subagent + workflow subagent + journal
  const sub = new ClaudeFile(g, {
    sid: a.sid,
    cwd: a.f.cwd,
    t: a.f.t + 1000,
    agentId: "a1b2c3d4e5f6a7b8c",
    sidechain: true,
  });
  sub.prompt("Find where the importer handshakes.");
  sub.reply(`Found it: ${N.sub} in the retry loop.`);
  out.write(path.join(a.dir, a.sid, "subagents", "agent-a1b2c3d4e5f6a7b8c.jsonl"), sub.body());
  out.write(
    path.join(a.dir, a.sid, "subagents", "agent-a1b2c3d4e5f6a7b8c.meta.json"),
    JSON.stringify({ agentType: "Explore", description: "Find the handshake" }),
    { uncounted: true },
  );
  needles.must(N.sub, a.key, "a subagent's reply, under its parent");
  const wf = new ClaudeFile(g, {
    sid: a.sid,
    cwd: a.f.cwd,
    t: a.f.t + 2000,
    agentId: "f00dfacecafe12345",
    sidechain: true,
  });
  wf.prompt("Phase two.");
  wf.reply(`The ${N.wf} is done.`);
  const wfDir = path.join(a.dir, a.sid, "subagents", "workflows", "wf_demo1");
  out.write(path.join(wfDir, "agent-f00dfacecafe12345.jsonl"), wf.body());
  out.write(
    path.join(wfDir, "journal.jsonl"),
    `${JSON.stringify({ type: "result", agentId: "f00dfacecafe12345", result: N.journal })}\n`,
    { uncounted: true },
  );
  needles.must(N.wf, a.key, "a workflow subagent, under its parent");
  needles.never(N.journal, "workflow journal result");
  for (const s of Object.values(secrets)) needles.never(s, "a planted secret (redacted)");

  // 2. a Claude fork: the parent's first records copied under the new id, same uuids
  const parent = claudeSession(g, {
    home: claudeHome,
    cwd: "/Users/dev/git/forkyard",
    t: when(),
    turns: 0,
    extras: (f) => {
      f.prompt(`Start: ${N.forkShared} is the plan.`);
      f.reply("Sounds good.");
    },
  });
  out.write(parent.file, parent.f.body());
  const forkSid = w.uuid();
  const fork = new ClaudeFile(g, { sid: forkSid, cwd: parent.f.cwd, t: parent.f.t + 3_600_000 });
  for (const r of parent.f.records) fork.push({ ...r, sessionId: forkSid });
  fork.prev = parent.f.records.at(-1)?.uuid ?? null;
  fork.prompt(`Branching off: ${N.forkOwn}.`);
  out.write(path.join(parent.dir, `${forkSid}.jsonl`), fork.body());
  out.session("claude-code");
  needles.must(N.forkShared, parent.key, "a fork's copied prefix belongs to the parent only");
  needles.must(N.forkOwn, `claude-code:${forkSid}`, "a fork's own records");

  // 3. the second account home
  const wk = claudeSession(g, {
    home: workHome,
    cwd: "/Users/dev/work/ledger",
    t: when(),
    turns: 1,
    extras: (f) => f.prompt(`Reconcile ${N.work}.`),
  });
  out.write(wk.file, wk.f.body());
  needles.must(N.work, wk.key, "a second Claude home (~/.claude-work)");

  // 4. a live Claude file whose last line is partial
  const live = claudeSession(g, { home: claudeHome, cwd: "/Users/dev/git/livewire", t: g.now - 600_000, turns: 1 });
  out.write(
    live.file,
    `${live.f.body()}${JSON.stringify({ type: "user", message: { role: "user", content: N.partial }, sessionId: live.sid }).slice(0, -3)}`,
  );
  needles.never(N.partial, "a partial last line waits");

  // 5. Codex: a main thread with every shape, plain .jsonl (live)
  const cid = w.uuid();
  const ct = when();
  const c = new CodexFile(g, { id: cid, t: ct, cwd: "/Users/dev/git/otterpond" });
  const ck = `codex:${cid}`;
  c.user(`<environment_context>${N.codexEnv}</environment_context>`, false);
  c.rec("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: N.codexDev }] });
  c.user("# AGENTS.md instructions for /Users/dev/git/otterpond\nbe nice", false);
  c.user(`Why does ${N.codexPrompt} fail?`);
  c.rec("event_msg", { type: "user_message", message: `dup ${N.codexEventDup}` });
  c.rec("response_item", {
    type: "reasoning",
    summary: [{ type: "summary_text", text: N.codexReason }],
    encrypted_content: "gAAAA",
  });
  c.call("exec_command", { cmd: `rg ${N.codexTool} src`, workdir: c.cwd }, `${N.codexOut} 3 matches`);
  c.patch([N.codexPatchPath], N.patchBody);
  c.user(
    `# Files mentioned by the user:\n\n## a.ts: /Users/dev/git/otterpond/a.ts\n\n## My request for Codex:\nplease handle ${N.codexFiles}`,
  );
  c.assistant("Done, it was the cache.");
  c.rec("compacted", {
    message: "",
    replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: N.codexCompact }] }],
  });
  out.write(codexPath(H, ct, cid), c.body());
  out.session("codex");
  needles.must(N.codexPrompt, ck, "a Codex prompt");
  needles.must(N.codexTool, ck, "exec_command's cmd");
  needles.must(N.codexPatchPath, ck, "apply_patch file list");
  needles.must(N.codexFiles, ck, "the request after # Files mentioned by the user");
  for (const [q, why] of [
    [N.codexOut, "function_call_output"],
    [N.codexDev, "developer role"],
    [N.codexEnv, "environment_context"],
    [N.codexReason, "reasoning"],
    [N.codexCompact, "compacted replacement_history"],
    [N.codexEventDup, "event_msg duplicate"],
    [N.patchBody, "apply_patch body"],
    [N.baseInstr, "session_meta base_instructions"],
  ])
    needles.never(q, why);
  // session_index titles (last one per id wins)
  const idx = [
    { id: cid, thread_name: "Otter pond first name", updated_at: iso(ct) },
    { id: cid, thread_name: `Otter pond ${N.codexTitle}`, updated_at: iso(ct + 1000) },
  ];

  // a spawned subagent thread: own meta, the parent's replay, the boundary, its own records
  const subId = w.uuid();
  const s2 = new CodexFile(g, {
    id: subId,
    t: ct + 5000,
    cwd: c.cwd,
    meta: {
      session_id: cid,
      thread_source: "subagent",
      source: { subagent: { thread_spawn: { parent_thread_id: cid, depth: 1, agent_nickname: "scout" } } },
      extra: { parent_thread_id: cid },
    },
  });
  s2.rec("session_meta", { id: cid, session_id: cid, cwd: c.cwd, timestamp: iso(ct) });
  s2.user(`Why does ${N.codexReplay} fail?`, false);
  s2.rec("event_msg", { type: "task_started", thread_id: subId });
  s2.assistant(`Child found ${N.codexSub}.`);
  out.write(codexPath(H, ct + 5000, subId), s2.body(), { zst: true });
  needles.must(N.codexSub, ck, "a thread_spawn subagent, under its parent");
  needles.never(N.codexReplay, "a subagent's replay of its parent (before the boundary)");
  // a guardian review: skipped
  const gid = w.uuid();
  const gr = new CodexFile(g, {
    id: gid,
    t: ct + 9000,
    cwd: c.cwd,
    meta: { session_id: cid, thread_source: "guardian_review", source: { subagent: { other: "guardian" } } },
  });
  gr.user(`Review this transcript: ${N.guardian}`, false);
  gr.assistant("approve", "final_answer");
  out.write(codexPath(H, ct + 9000, gid), gr.body(), { zst: true });
  needles.never(N.guardian, "a guardian review");
  // a fork: replays the parent, then its own
  const fid = w.uuid();
  const fk = new CodexFile(g, { id: fid, t: ct + 86_400_000, cwd: c.cwd, meta: { extra: { forked_from_id: cid } } });
  fk.user(`Why does ${N.codexReplay} fail?`, false);
  fk.rec("event_msg", { type: "task_started", thread_id: fid });
  fk.user(`Fork asks ${N.codexForkOwn}`);
  out.write(codexPath(H, ct + 86_400_000, fid), fk.body(), { zst: true });
  out.session("codex");
  needles.must(N.codexForkOwn, `codex:${fid}`, "a Codex fork's own records");
  idx.push({ id: fid, thread_name: "Fork of otter pond", updated_at: iso(ct + 86_400_000) });
  // a compressed-only finished thread
  const zid = w.uuid();
  const zt = when();
  const z = new CodexFile(g, { id: zid, t: zt, cwd: cwdOf() });
  z.user(`Look at ${N.zst} again`);
  z.assistant("Looked.");
  const zp = out.write(codexPath(H, zt, zid), z.body(), { zst: true });
  out.session("codex");
  if (zp.endsWith(".zst")) needles.must(N.zst, `codex:${zid}`, "a .jsonl.zst rollout");
  else needles.must(N.zst, `codex:${zid}`, "a rollout (no zstd here, so plain)");
  out.write(path.join(H, ".codex", "session_index.jsonl"), `${idx.map((x) => JSON.stringify(x)).join("\n")}\n`, {
    uncounted: true,
  });
  needles.must(N.codexTitle, ck, "a Codex title from session_index.jsonl (last line per id)");

  // 6. Antigravity, transcript layout
  const ag = w.uuid();
  const agt = when();
  const agDir = path.join(H, ".gemini", "antigravity", "brain", ag);
  const agLines = [
    {
      type: "USER_INPUT",
      created_at: iso(agt),
      content: `<USER_REQUEST>\nPlease ${N.agyTranscript} now\n</USER_REQUEST>\n<META>ignored</META>`,
    },
    {
      type: "PLANNER_RESPONSE",
      created_at: iso(agt + 4000),
      content: "On it.",
      tool_calls: [{ name: "run_command", args: { command: `ls ${N.agyTool}` } }],
    },
    { type: "TOOL_RESULT", created_at: iso(agt + 5000), content: N.agyToolOut },
    { type: "PLANNER_RESPONSE", created_at: iso(agt + 9000), content: "Done." },
  ];
  out.write(
    path.join(agDir, ".system_generated", "logs", "transcript.jsonl"),
    `${agLines.map((x) => JSON.stringify(x)).join("\n")}\n`,
  );
  out.session("antigravity");
  needles.must(N.agyTranscript, `antigravity:${ag}`, "Antigravity USER_REQUEST");
  needles.must(N.agyTool, `antigravity:${ag}`, "Antigravity planner tool call");
  needles.never(N.agyToolOut, "Antigravity tool result");
  // Antigravity, artifacts layout (this Mac's version)
  const ab = w.uuid();
  const abt = when();
  const abDir = path.join(H, ".gemini", "antigravity-ide", "brain", ab);
  out.write(path.join(abDir, "task.md"), `# Tidy the ${N.agyArtifact}\n\n- [x] read\n- [ ] write\n`);
  out.write(
    path.join(abDir, "task.md.metadata.json"),
    JSON.stringify({ artifactType: "ARTIFACT_TYPE_TASK", summary: "Tidy task", updatedAt: iso(abt) }),
    { uncounted: true },
  );
  out.write(path.join(abDir, "implementation_plan.md"), `# Plan\n\n1. ${N.agyPlan}\n`);
  out.write(
    path.join(abDir, "implementation_plan.md.metadata.json"),
    JSON.stringify({
      artifactType: "ARTIFACT_TYPE_IMPLEMENTATION_PLAN",
      summary: "The plan",
      updatedAt: iso(abt + 1000),
    }),
    { uncounted: true },
  );
  out.write(path.join(abDir, "task.md.resolved.3"), `# Old ${N.agyResolved}\n`, { uncounted: true });
  out.write(
    path.join(abDir, ".system_generated", "messages", `${w.uuid()}.json`),
    JSON.stringify({
      id: w.uuid(),
      recipient: ab,
      sender: "system",
      priority: 1,
      timestamp: iso(abt),
      hideFromUser: true,
      content: N.agyHidden,
    }),
    { uncounted: true },
  );
  out.write(path.join(abDir, ".system_generated", "steps", "3", "content.md"), `${N.agyStep}\n`, { uncounted: true });
  out.write(
    path.join(abDir, "conversations", `${ab}.pb`),
    Buffer.from(Array.from({ length: 512 }, () => Math.floor(w.r() * 256))),
    { uncounted: true },
  );
  out.session("antigravity");
  needles.must(N.agyArtifact, `antigravity:${ab}`, "Antigravity task.md artifact");
  needles.must(N.agyPlan, `antigravity:${ab}`, "Antigravity implementation plan");
  needles.never(N.agyHidden, "hideFromUser system message");
  needles.never(N.agyStep, "steps/N/content.md");
  needles.never(N.agyResolved, ".resolved.N snapshot");

  // 7. Gemini CLI: current .jsonl and the older whole .json
  const gm = w.uuid();
  const gmt = when();
  const gmDir = path.join(H, ".gemini", "tmp", "lagoon", "chats");
  const gmLines = [
    { sessionId: gm, projectHash: w.hex(64), startTime: iso(gmt), lastUpdated: iso(gmt), kind: "main" },
    { id: w.uuid(), timestamp: iso(gmt + 1000), type: "user", content: [{ text: `Plan the ${N.geminiJsonl}` }] },
    {
      id: w.uuid(),
      timestamp: iso(gmt + 4000),
      type: "gemini",
      content: [{ text: "Here is the plan." }],
      thoughts: [{ subject: "x", description: N.geminiThought }],
      toolCalls: [
        { name: "run_shell_command", args: { command: `make ${N.geminiTool}` }, result: [{ text: N.geminiResult }] },
      ],
    },
    { id: w.uuid(), timestamp: iso(gmt + 5000), type: "info", content: [{ text: "info line" }] },
    { $set: { lastUpdated: iso(gmt + 5000) } },
  ];
  out.write(
    path.join(gmDir, `session-${iso(gmt).slice(0, 16).replace(":", "-")}-${gm.slice(0, 8)}.jsonl`),
    `${gmLines.map((x) => JSON.stringify(x)).join("\n")}\n`,
  );
  writeFileSync(path.join(H, ".gemini", "tmp", "lagoon", ".project_root"), "/Users/dev/git/lagoon\n");
  out.session("gemini-cli");
  needles.must(N.geminiJsonl, `gemini-cli:${gm}`, "Gemini CLI .jsonl prompt");
  needles.must(N.geminiTool, `gemini-cli:${gm}`, "Gemini CLI tool call");
  needles.never(N.geminiThought, "Gemini thoughts");
  needles.never(N.geminiResult, "Gemini tool result");
  const gj = w.uuid();
  const gjt = when();
  const gjBody = {
    sessionId: gj,
    projectHash: w.hex(64),
    startTime: iso(gjt),
    lastUpdated: iso(gjt + 3000),
    messages: [
      { id: w.uuid(), timestamp: iso(gjt + 1000), type: "user", content: [{ text: `Old chat about ${N.geminiJson}` }] },
      { id: w.uuid(), timestamp: iso(gjt + 3000), type: "gemini", content: [{ text: "Sure." }] },
    ],
  };
  out.write(
    path.join(
      H,
      ".gemini",
      "tmp",
      w.hex(64),
      "chats",
      `session-${iso(gjt).slice(0, 16).replace(":", "-")}-${gj.slice(0, 8)}.json`,
    ),
    JSON.stringify(gjBody, null, 2),
  );
  out.session("gemini-cli");
  needles.soft(N.geminiJson, `gemini-cli:${gj}`, "Gemini CLI older whole .json chat (shape unverified)");

  // 8. store events: another machine, a shadowed history key, tier rules
  const ev = eventsSession(g, {
    harness: "claude-code",
    id: w.uuid(),
    machine: "build-box",
    t: when(),
    turns: 2,
    plant: true,
  });
  needles.must(N.events, ev.key, "sessionpipe turn.transcript", { sources: ["sessionpipe"] });
  needles.must(N.eventsTool, ev.key, "sessionpipe tool.ended input", { kind: "soft", sources: ["sessionpipe"] });
  needles.must(N.eventsAttn, ev.key, "sessionpipe attention.needed message", { sources: ["sessionpipe"] });
  needles.never(N.eventsOut, "sessionpipe tool.ended output");
  needles.never(N.tierLeak, "a transcript on a tier-1 event");
  needles.never(N.tierInput, "a tool input on a tier-2 event");
  // the same key as Claude session `a`, events only: history wins (D6)
  eventsSession(g, { harness: "claude-code", id: a.sid, machine: "this", t: a.f.t, turns: 1, shadow: true });
  needles.must(N.eventsShadow, "", "history beats events for one key (D6): absent with history read", {
    kind: "never",
  });
  needles.map.set(`${N.eventsShadow}@sessionpipe`, {
    q: N.eventsShadow,
    keys: [a.key],
    kind: "must",
    why: "the shadowed key's events, reading sessionpipe only",
    sources: ["sessionpipe"],
  });
}

function mkdirp(d) {
  mkdirSync(d, { recursive: true });
  return d;
}

/** A store events file `<state>/events/<harness>/<id>.jsonl` (StoredEvent lines). */
function eventsSession(g, { harness, id, machine, t, turns, plant, shadow }) {
  const { w, p, out } = g;
  const lines = [];
  let seq = 0;
  let clock = t;
  const cwd = `/home/dev/src/${w.zipf()}`;
  const ev = (type, data, tier = 3) => {
    clock += 2000 + Math.floor(w.r() * 20000);
    const e = {
      protocol: 1,
      id: `01${w.hex(24).toUpperCase()}`,
      type,
      time: iso(clock),
      tier,
      harness: { name: harness, version: "2.1.296", event: "Hook" },
      session: { id, seq: seq++, machine, cwd, repo: `acme/${path.basename(cwd)}` },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
      arrivedAt: iso(clock + 300),
      source: "http",
    };
    lines.push(JSON.stringify(e));
  };
  ev("session.started", { model: "claude-opus-4-5" }, 0);
  for (let turn = 1; turn <= turns; turn++) {
    const user =
      shadow && turn === 1
        ? `shadow copy ${N.eventsShadow}`
        : plant && turn === 1
          ? `remote ask ${N.events}`
          : w.text(w.int(...p.prompt));
    const assistant = w.text(w.int(...p.reply));
    ev("turn.started", { turn }, 0);
    ev("turn.progress", { turn, user, assistant: assistant.slice(0, 40), at: iso(clock) }, 2);
    const nt = w.int(0, 2);
    for (let k = 0; k < nt; k++)
      ev(
        "tool.ended",
        {
          tool: "Bash",
          ok: true,
          ms: w.int(5, 900),
          input: { command: `ls ${w.zipf()}` },
          output: w.text(w.int(...p.out)),
        },
        3,
      );
    if (plant && turn === 1) {
      ev(
        "tool.ended",
        { tool: "Bash", ok: true, input: { command: `make ${N.eventsTool}` }, output: `${N.eventsOut} done` },
        3,
      );
      ev("attention.needed", { attention_id: "att1", kind: "question", message: `Should I ${N.eventsAttn}?` }, 1);
      ev("turn.transcript", { turn: 99, user: `leaked ${N.tierLeak}`, assistant: "x", at: iso(clock) }, 1);
      ev("tool.ended", { tool: "Bash", ok: true, input: { command: `echo ${N.tierInput}` } }, 2);
    }
    ev("turn.transcript", { turn, user, assistant, at: iso(clock) }, 2);
    out.text(user);
    out.text(assistant);
  }
  ev("session.ended", { reason: "exit" }, 0);
  out.write(path.join(out.state, "events", harness, `${id}.jsonl`), `${lines.join("\n")}\n`);
  if (!shadow) out.session(`${harness}@events`);
  return { key: `${harness}:${id}` };
}

// ───────────────────────────── demo: ~40 human-plausible sessions ─────────────────────────────

const DEMO = [
  {
    title: "Webhook retries return 409 after deploy",
    repo: "acme/payments",
    ask: [
      "The Stripe webhook handler returns 409 on every retry since yesterday's deploy. Can you find out why?",
      "Can we make the retry idempotent instead of rejecting it?",
    ],
    reply: [
      "The handler rejects a retry because the idempotency key is stored before the charge commits, so the second delivery sees a half-written row and answers 409 Conflict.",
      "Done: the key is written in the same transaction as the charge, and a retry now returns the stored response with 200.",
    ],
    tools: [
      ["Bash", { command: "rg -n 'idempotency' src/webhooks" }],
      ["Read", { file_path: "src/webhooks/stripeHandler.ts" }],
      ["Edit", { file_path: "src/webhooks/stripeHandler.ts" }],
    ],
  },
  {
    title: "Rate limiter drops bursts from the mobile app",
    repo: "acme/gateway",
    ask: [
      "Mobile clients get 429s when they reconnect after being offline. Is the token bucket too small?",
      "Let's allow a burst of 20 and keep the steady rate.",
    ],
    reply: [
      "Yes: the bucket holds 5 tokens and the app replays up to 14 queued requests on reconnect, so most of them are rejected.",
      "Raised the burst to 20 in rateLimiter.ts and added a test that replays a reconnect.",
    ],
    tools: [
      ["Grep", { pattern: "tokensPerInterval", path: "src" }],
      ["Edit", { file_path: "src/middleware/rateLimiter.ts" }],
      ["Bash", { command: "pnpm vitest run rateLimiter" }],
    ],
  },
  {
    title: "CSV export shifts dates by one day",
    repo: "acme/reports",
    ask: [
      "Exported CSVs show every date one day early for customers in America/Los_Angeles.",
      "Use the account's time zone, not the server's.",
    ],
    reply: [
      "The export formats dates with toISOString(), which is UTC, so an evening timestamp in Los Angeles lands on the next day and is then truncated.",
      "The exporter now formats with the account time zone via Intl.DateTimeFormat, and the snapshot tests cover three zones.",
    ],
    tools: [
      ["Read", { file_path: "src/export/csv.ts" }],
      ["Bash", { command: "TZ=America/Los_Angeles pnpm test export" }],
    ],
  },
  {
    title: "Flaky e2e: checkout times out on CI",
    repo: "acme/storefront",
    ask: [
      "checkout.spec.ts times out about one run in five on CI but never locally.",
      "Wait for the network request instead of a fixed sleep.",
    ],
    reply: [
      "The test clicks Pay before the payment iframe finishes loading; on the slower CI runners the click lands on the placeholder.",
      "Replaced the 2 s sleep with waitForResponse on /api/payment-intent; 50 CI runs passed.",
    ],
    tools: [
      ["Bash", { command: "npx playwright test checkout.spec.ts --repeat-each 20" }],
      ["Edit", { file_path: "test/e2e/checkout.spec.ts" }],
    ],
  },
  {
    title: "Migrate the worker to Node 22",
    repo: "acme/jobs",
    ask: ["Bump the queue worker to Node 22 and fix whatever breaks.", "Keep the Dockerfile on the slim image."],
    reply: [
      "Two things broke: the fetch polyfill conflicts with the built-in fetch, and an assert import needs the node: prefix.",
      "Removed the polyfill, fixed the import, and the Dockerfile now uses node:22-slim. All 214 tests pass.",
    ],
    tools: [
      ["Bash", { command: "nvm use 22 && npm test" }],
      ["Edit", { file_path: "Dockerfile" }],
    ],
  },
  {
    title: "Dark mode tokens for the settings sheet",
    repo: "acme/design-system",
    ask: [
      "The settings sheet is unreadable in dark mode: grey text on grey.",
      "Use the existing surface tokens rather than new colours.",
    ],
    reply: [
      "The sheet hard-codes #666 for secondary text. The token --text-secondary already has a dark value.",
      "Switched the sheet to --surface-raised and --text-secondary; contrast is 7.1:1 in dark and 8.4:1 in light.",
    ],
    tools: [
      ["Grep", { pattern: "#666", path: "src/components" }],
      ["Edit", { file_path: "src/components/SettingsSheet.css" }],
    ],
  },
  {
    title: "Slow search on the orders table",
    repo: "acme/backoffice",
    ask: ["Searching orders by email takes 4 seconds. Can we add an index?", "Make the migration safe to run online."],
    reply: [
      "The query uses lower(email) LIKE, which can't use the btree index. A trigram index on lower(email) makes it 12 ms.",
      "Added a migration with CREATE INDEX CONCURRENTLY and a down step.",
    ],
    tools: [
      ["Bash", { command: "psql -c 'EXPLAIN ANALYZE SELECT …'" }],
      ["Write", { file_path: "migrations/20261021_orders_email_trgm.sql" }],
    ],
  },
  {
    title: "Release notes for 2.4",
    repo: "acme/app",
    ask: ["Draft the release notes for 2.4 from the merged PRs since 2.3.", "Shorter, and group by what users notice."],
    reply: [
      "Here is a draft with 14 changes: faster exports, offline drafts, the new share sheet, and 11 fixes.",
      "Grouped into New, Better and Fixed, five lines each at most.",
    ],
    tools: [["Bash", { command: "gh pr list --state merged --search 'merged:>2026-10-01'" }]],
  },
  {
    title: "Memory leak in the image resizer",
    repo: "acme/media",
    ask: ["The resizer's RSS grows by about 200 MB an hour under load.", "Can we reuse the buffers?"],
    reply: [
      "Each request allocates a new sharp pipeline and never destroys it on the error path, so failed resizes keep their buffers.",
      "Added a finally that destroys the pipeline and a pool for the output buffers; RSS is flat over a 2-hour soak.",
    ],
    tools: [
      ["Bash", { command: "node --heapsnapshot-signal=SIGUSR2 dist/server.js" }],
      ["Edit", { file_path: "src/resize/pipeline.ts" }],
    ],
  },
  {
    title: "Onboarding email goes out twice",
    repo: "acme/growth",
    ask: ["New users get the welcome email twice. Started this week.", "Dedupe on the user id."],
    reply: [
      "The signup handler and the new CRM sync both enqueue the welcome job.",
      "The job now carries a dedupe key of welcome:<userId>, and the queue drops a second one within 24 h.",
    ],
    tools: [
      ["Grep", { pattern: "enqueueWelcome", path: "src" }],
      ["Edit", { file_path: "src/jobs/welcome.ts" }],
    ],
  },
  {
    title: "Translate the empty states to German",
    repo: "acme/app",
    ask: ["Translate the empty-state copy to German; keep it short.", "Use du, not Sie."],
    reply: [
      "Translated 18 strings. Größenangaben and Datumsformate follow the de-DE locale.",
      "Switched to du throughout and shortened three strings that overflowed on the phone.",
    ],
    tools: [["Edit", { file_path: "locales/de.json" }]],
  },
  {
    title: "Search index rebuild for Japanese titles",
    repo: "acme/catalog",
    ask: [
      "Japanese product titles like 検索インデックス don't show up in search.",
      "Index each CJK character separately.",
    ],
    reply: [
      "The tokenizer splits on spaces only, so a Japanese title is one long token that no query matches.",
      "CJK runs are now indexed one character per token and queried as phrases; 検索 finds the title.",
    ],
    tools: [
      ["Read", { file_path: "src/search/tokenizer.ts" }],
      ["Bash", { command: "pnpm test tokenizer" }],
    ],
  },
];

function demo(g) {
  const { w, out, now } = g;
  const H = out.home;
  const harnesses = ["claude-code", "claude-code", "codex", "claude-code", "codex", "antigravity", "gemini-cli"];
  let n = 0;
  for (let round = 0; round < 4; round++) {
    for (const s of DEMO) {
      if (n >= 42) break;
      const harness = harnesses[n % harnesses.length];
      const t = now - Math.floor((n * 7.3 + w.r() * 5) * 3_600_000) - 60_000 * n;
      const repoName = s.repo.split("/")[1];
      const cwd = `/Users/dev/code/${repoName}`;
      const variant = round === 0 ? "" : [" (follow-up)", " again", " on staging"][round - 1];
      const title = `${s.title}${variant}`;
      if (harness === "claude-code") {
        const cs = claudeSession(g, {
          home: path.join(H, round === 3 ? ".claude-work" : ".claude"),
          cwd,
          t,
          turns: 0,
          title,
          extras: (f) => {
            s.ask.forEach((ask, i) => {
              f.prompt(ask);
              const tool = s.tools[i % s.tools.length];
              if (tool) f.tool(tool[0], tool[1], "ok");
              f.reply(s.reply[i] ?? "Done.");
            });
          },
        });
        out.write(cs.file, cs.f.body());
        if (n % 5 === 0) {
          const sub = new ClaudeFile(g, { sid: cs.sid, cwd, t: t + 30_000, agentId: w.hex(17), sidechain: true });
          sub.prompt(`Look through the code for anything related to: ${s.ask[0]}`);
          sub.tool("Grep", { pattern: s.title.split(" ")[0].toLowerCase(), path: "src" }, "3 files");
          sub.reply(`Found the relevant code; the main entry is ${s.tools[0]?.[1].file_path ?? "src/index.ts"}.`);
          out.write(path.join(cs.dir, cs.sid, "subagents", `agent-${sub.agentId}.jsonl`), sub.body());
          out.write(
            path.join(cs.dir, cs.sid, "subagents", `agent-${sub.agentId}.meta.json`),
            JSON.stringify({ agentType: "Explore", description: "Find the code" }),
            { uncounted: true },
          );
        }
      } else if (harness === "codex") {
        const id = w.uuid();
        const f = new CodexFile(g, { id, t, cwd });
        s.ask.forEach((ask, i) => {
          f.user(ask);
          const tool = s.tools[i % s.tools.length];
          if (tool)
            f.call(
              "exec_command",
              { cmd: tool[1].command ?? `sed -n 1,80p ${tool[1].file_path ?? tool[1].pattern}` },
              "ok",
            );
          f.assistant(s.reply[i] ?? "Done.");
        });
        out.write(codexPath(H, t, id), f.body(), { zst: n % 3 === 0 });
        out.session("codex");
      } else if (harness === "antigravity") {
        const id = w.uuid();
        const lines = s.ask.flatMap((ask, i) => [
          { type: "USER_INPUT", created_at: iso(t + i * 60_000), content: `<USER_REQUEST>\n${ask}\n</USER_REQUEST>` },
          { type: "PLANNER_RESPONSE", created_at: iso(t + i * 60_000 + 5000), content: s.reply[i] ?? "Done." },
        ]);
        out.write(
          path.join(H, ".gemini", "antigravity", "brain", id, ".system_generated", "logs", "transcript.jsonl"),
          `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`,
        );
        out.session("antigravity");
      } else {
        const id = w.uuid();
        const lines = [
          { sessionId: id, projectHash: w.hex(64), startTime: iso(t), lastUpdated: iso(t + 60_000), kind: "main" },
          ...s.ask.flatMap((ask, i) => [
            { id: w.uuid(), timestamp: iso(t + i * 60_000), type: "user", content: [{ text: ask }] },
            {
              id: w.uuid(),
              timestamp: iso(t + i * 60_000 + 4000),
              type: "gemini",
              content: [{ text: s.reply[i] ?? "Done." }],
            },
          ]),
        ];
        out.write(
          path.join(
            H,
            ".gemini",
            "tmp",
            repoName,
            "chats",
            `session-${iso(t).slice(0, 16).replace(":", "-")}-${id.slice(0, 8)}.jsonl`,
          ),
          `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`,
        );
        out.session("gemini-cli");
      }
      n++;
    }
  }
  // A few sessions from other machines, through sessionpipe.
  for (const [i, s] of DEMO.slice(0, 6).entries()) {
    const id = w.uuid();
    const lines = [];
    let seq = 0;
    let clock = now - (i + 1) * 5_400_000;
    const machine = i % 2 ? "build-box" : "studio-mac";
    const e = (type, data, tier) => {
      clock += 20_000;
      lines.push(
        JSON.stringify({
          protocol: 1,
          id: `01${w.hex(24).toUpperCase()}`,
          type,
          time: iso(clock),
          tier,
          harness: { name: i % 3 ? "claude-code" : "codex", version: "2.1.296", event: "Hook" },
          session: { id, seq: seq++, machine, cwd: `/home/dev/${s.repo.split("/")[1]}`, repo: s.repo, title: s.title },
          privacy: { rulesets: ["secrets@1"], pii: false },
          data,
          arrivedAt: iso(clock + 200),
          source: "http",
        }),
      );
    };
    e("session.started", {}, 0);
    s.ask.forEach((ask, k) => {
      e("turn.started", { turn: k + 1 }, 0);
      e("turn.transcript", { turn: k + 1, user: ask, assistant: s.reply[k] ?? "Done.", at: iso(clock) }, 2);
    });
    out.write(path.join(out.state, "events", i % 3 ? "claude-code" : "codex", `${id}.jsonl`), `${lines.join("\n")}\n`);
    out.session("events");
  }
}

// ───────────────────────────── main ─────────────────────────────

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  const t = Date.now();
  const m = generate(o);
  const { needles, secrets, ...rest } = m;
  console.log(JSON.stringify({ ...rest, needles: needles.length, ms: Date.now() - t, out: o.out }, null, 1));
}
