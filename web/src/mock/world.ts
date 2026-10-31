// SPDX-License-Identifier: Apache-2.0
// A server in the page. It keeps every session as its StoredEvent history (the wire
// shape, spec PROTOCOL.md §2/§4) and derives SessionSummary / MachineSummary / Stats from
// them with the same readings ARCHITECTURE.md gives the store, so the mock is the contract.
import type {
  AgentRun,
  Attention,
  ControlActivity,
  Delegation,
  DetailQuery,
  FeedPage,
  FeedQuery,
  Info,
  LimitsEntry,
  MachineSummary,
  ProtocolSession,
  SessionDetail,
  SessionFiles,
  SessionKey,
  SessionSummary,
  Stats,
  StoredEvent,
  StreamMessage,
  Tier,
} from "@shared/api";
import { DONE_AFTER_MS, SNIPPET_CHARS, STALE_AFTER_MS, sessionKey } from "@shared/api";
import { indexTouches } from "@shared/files";
import { AgentReading } from "./agents";

// ---------- helpers ----------

/** Each account's usage limits as the server keeps them (server/ui/limits.ts), one per
 *  machine's Claude account so New session shows a single account's number: misha-air's
 *  has none left this 5-hour window, studio-mini's has room, Codex on misha-air has its
 *  plan, and build-box's Codex last reported three hours ago, its 5-hour window reset since. */
export function mockLimits(now: number): LimitsEntry[] {
  const at = (ms: number) => new Date(now + ms).toISOString();
  const H = 3_600_000;
  const M = 60_000;
  const D = 24 * H;
  return [
    {
      key: "claude-code a:a1b2c3",
      harness: "claude-code",
      accountId: "a1b2c3",
      machine: "misha-air",
      machines: ["misha-air"],
      windows: [
        { id: "five_hour", usedPercent: 100, windowMinutes: 300, resetsAt: at(H + 10 * M) },
        { id: "seven_day", usedPercent: 61, windowMinutes: 10_080, resetsAt: at(3 * D + 6 * H) },
      ],
      observedAt: at(-M),
    },
    {
      key: "claude-code a:w4e5f6",
      harness: "claude-code",
      accountId: "w4e5f6",
      machine: "studio-mini",
      machines: ["studio-mini"],
      windows: [
        { id: "five_hour", usedPercent: 38, windowMinutes: 300, resetsAt: at(2 * H + 21 * M) },
        { id: "seven_day", usedPercent: 20, windowMinutes: 10_080, resetsAt: at(2 * D + 18 * H) },
      ],
      observedAt: at(-2 * M),
    },
    {
      key: "codex m:misha-air",
      harness: "codex",
      machine: "misha-air",
      machines: ["misha-air"],
      plan: "plus",
      windows: [
        { id: "primary", usedPercent: 8, windowMinutes: 300, resetsAt: at(3 * H + 43 * M) },
        { id: "secondary", usedPercent: 26, windowMinutes: 10_080, resetsAt: at(4 * D + 2 * H) },
      ],
      observedAt: at(-3 * M),
    },
    {
      key: "codex m:build-box",
      harness: "codex",
      machine: "build-box",
      machines: ["build-box"],
      plan: "pro",
      windows: [
        { id: "primary", usedPercent: 64, windowMinutes: 300, resetsAt: at(-40 * M) },
        { id: "secondary", usedPercent: 91, windowMinutes: 10_080, resetsAt: at(D + 4 * H) },
      ],
      observedAt: at(-3 * H),
    },
  ];
}

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(at = Date.now()): string {
  let t = at;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ULID_CHARS[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (const b of bytes) rand += ULID_CHARS[b % 32];
  return time + rand;
}

const iso = (t: number) => new Date(t).toISOString();

/** The stream and the feed carry slim events: long strings cut to a preview, with the
 *  original lengths in `preview` (ARCHITECTURE.md "Memory"). The detail route is full. */
const PREVIEW_CHARS = 2048;
export function slim(e: StoredEvent, chars = PREVIEW_CHARS): StoredEvent {
  const preview: Record<string, number> = {};
  const data: Record<string, unknown> = { ...e.data };
  for (const k of ["input", "output", "user", "assistant"]) {
    const v = data[k];
    const text = typeof v === "string" ? v : v !== undefined ? JSON.stringify(v) : undefined;
    if (text !== undefined && text.length > chars) {
      preview[k] = text.length;
      data[k] = `${text.slice(0, chars)}…`;
    }
  }
  return Object.keys(preview).length ? { ...e, data, preview } : e;
}
const cut = (s: string) => (s.length > SNIPPET_CHARS ? `${s.slice(0, SNIPPET_CHARS - 1)}…` : s);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

interface MachineSpec {
  name: string;
  harnesses: Record<string, string>;
}

const MACHINES: MachineSpec[] = [
  { name: "misha-air", harnesses: { "claude-code": "2.1.290", codex: "0.157.1", "gemini-cli": "0.14.2" } },
  { name: "studio-mini", harnesses: { "claude-code": "2.1.288", "gemini-cli": "0.14.2", antigravity: "1.4.0" } },
  { name: "build-box", harnesses: { "claude-code": "2.1.270", codex: "0.150.0" } },
];

const TOOLS: Record<string, string[]> = {
  "claude-code": ["Read", "Grep", "Edit", "Bash", "Glob", "Write", "Read", "Edit", "Bash"],
  codex: ["shell", "read_file", "apply_patch", "shell", "list_dir"],
  "gemini-cli": ["read_file", "run_shell_command", "replace", "write_file", "grep_search"],
  antigravity: ["read_file", "edit_file", "run_terminal_cmd"],
};

const PROGRESS_LINES = [
  "Reading the outbox reader to see how a batch is bounded.",
  "The limit is applied per file; a session file over 1 MB is read in slices, so the fix is in `readBatch`.",
  "I'll add a test that writes a 3 MB session file and asserts the batch stops at the boundary.",
  "Running the suite now.",
  "Two tests failed on the cursor arithmetic; the offset was counted twice when a line straddled the slice.",
  "Fixed: the carry-over now keeps the partial line and advances the cursor only past complete lines.",
  "All 84 tests pass. Formatting with biome and typechecking.",
];

const PROMPTS = [
  "Make the outbox read at most 1 MB of a session file per batch, keep the rest for the next one, and add a test.",
  "The receiver POST is 660 ms; profile the worker and tell me where the time goes before changing anything.",
  "Add a `--since` flag to `sessionpipe tail` that accepts 10m, 2h, 1d.",
  "Why does the flood test lose events when the fake receiver answers 429 twice in a row?",
  "Rename `Sink.push` to `Sink.deliver` everywhere, including docs, and keep the old name as a deprecated alias.",
];

const ASSISTANT_REPLIES = [
  "Done. `Outbox.readBatch` now stops at 1 MB of a single session file and carries the partial line into the next call. Added `outbox-read-linear.test.ts` with a 3 MB fixture; 84 tests pass.",
  "The worker spends 610 of the 660 ms in `fetch` waiting on the receiver; the hook itself is 2 ms. Nothing on our side to change: the receiver's write path is the bottleneck.",
  "Added `--since` with a small duration parser (`10m`, `2h`, `1d`), documented in the CLI README, three tests.",
  "The sink's cursor advanced on a 429 because `deliver` treated any non-5xx as settled. It now only advances on 2xx, and waits `retry-after` as told.",
  "Renamed in 14 files. `push` remains as a getter that logs a deprecation once per process.",
];

const TOOL_INPUTS: Record<string, () => Record<string, unknown>> = {
  Bash: () => ({
    command: pick(["npm test -- outbox", "git status --short", "npx biome check --write .", "npm run build"]),
  }),
  Read: () => ({ file_path: pick(["packages/core/src/outbox.ts", "packages/cli/src/tail.ts", "spec/PROTOCOL.md"]) }),
  Grep: () => ({ pattern: pick(["readBatch", "retry-after", "STALE_AFTER"]), path: "packages" }),
  Edit: () => ({
    file_path: "packages/core/src/outbox.ts",
    old_string: "const limit = 1 << 20;",
    new_string: "const limit = MAX_BATCH_BYTES;",
  }),
  Glob: () => ({ pattern: "**/*.test.ts" }),
  Write: () => ({
    file_path: "packages/core/src/outbox-read-linear.test.ts",
    content: "import { test } from 'vitest'; …",
  }),
  shell: () => ({ command: ["bash", "-lc", pick(["npm test", "git diff --stat", "ls -la src"])] }),
  read_file: () => ({ path: pick(["src/app/page.tsx", "README.md", "src/lib/db.ts"]) }),
  apply_patch: () => ({
    patch:
      "*** Begin Patch\n*** Update File: src/lib/db.ts\n@@\n-  const url = process.env.DB;\n+  const url = requireEnv('DB');\n*** End Patch",
  }),
  run_shell_command: () => ({ command: pick(["pnpm test", "pnpm lint", "git log --oneline -5"]) }),
  replace: () => ({
    file_path: "src/app/cancer-type/[slug]/page.tsx",
    old_string: "getSlug(",
    new_string: "getSlugOrThrow(",
  }),
};

const TOOL_OUTPUTS: Record<string, () => string> = {
  Bash: () =>
    pick([
      " ✓ outbox-read-linear.test.ts (6 tests) 212ms\n ✓ outbox.test.ts (18 tests) 340ms\n\n Test Files  2 passed (2)\n      Tests  24 passed (24)",
      "M  packages/core/src/outbox.ts\n?? packages/core/src/outbox-read-linear.test.ts",
      "Checked 142 files in 180ms. No fixes applied.",
      "export DATABASE_URL=postgres://app:[redacted]@db.internal:5432/app\nbuild ok in 1.4s",
    ]),
  Read: () =>
    "     1\t// SPDX-License-Identifier: Apache-2.0\n     2\t// The outbox: append-only JSONL files, one per session, read by sinks by cursor.\n     3\timport { open } from 'node:fs/promises';\n     4\t\n     5\texport const MAX_BATCH_BYTES = 1 << 20;",
  Grep: () =>
    "packages/core/src/outbox.ts:88:  async readBatch(cursor: Cursor): Promise<Batch> {\npackages/core/src/outbox.ts:131:    // readBatch stops at the first file boundary",
  Edit: () => "The file packages/core/src/outbox.ts has been updated.",
  Glob: () =>
    Array.from(
      { length: 90 },
      (_, i) =>
        `packages/${i % 3 === 0 ? "core" : i % 3 === 1 ? "cli" : "receiver"}/src/${["outbox", "sinks/http", "tail", "worker", "hooks", "install"][i % 6]}-${i}.test.ts`,
    ).join("\n"),
  Write: () => "File created successfully.",
  shell: () => "ok",
  read_file: () => "export default async function Page({ params }: { params: { slug: string } }) {\n  …\n}",
  apply_patch: () => "Done!",
  run_shell_command: () => "All checks passed.",
  replace: () => "Successfully modified file.",
};

// ---------- a session ----------

interface SessionRec {
  key: SessionKey;
  harness: string;
  harnessVersion?: string;
  id: string;
  block: ProtocolSession;
  machine: string;
  events: StoredEvent[];
  tier: Tier;
  seq: number;
  turn: number;
  /** Live script state. */
  script: Script;
  /** Background agents that finished and wait for their `<task-notification>` turn. */
  notices: Notice[];
}

/** A background agent's report, as Claude Code hands it to the orchestrator. */
interface Notice {
  agentId: string;
  callId: string;
  description: string;
  result: string;
  followUp: string;
}

/** A subagent working inside its parent's session right now: its tools carry `agent_id`
 *  and the spawning turn's `turn_id`; at `endAt` it stops and (in the background) leaves
 *  a notice for the orchestrator's next turn. */
interface LiveAgent {
  r: SessionRec;
  id: string;
  type: string;
  turnId: string;
  notice?: Notice;
  nextAt: number;
  endAt: number;
  tool?: string;
  toolCallId?: string;
  toolStartedAt?: number;
  toolInput?: Record<string, unknown>;
  toolExtra?: Record<string, unknown>;
}

/** A `sessionpipe ask` on its way: the asking session's open Bash call and turn, and the
 *  session the daemon started to answer it. */
interface OpenAsk {
  parent: SessionRec;
  child: SessionRec;
  askId: string;
  callId: string;
  turnId: string;
  input: Record<string, unknown>;
  prompt: string;
  startedAt: number;
  turnStartedAt: number;
}

/** What the daemon hands an asked agent (sessionpipe control/route.ts): the question, then
 *  who asked and how the answer travels. */
const askFrame = (text: string, from: string) =>
  `${text}\n\n(Asked by ${from} on this machine with sessionpipe ask. Answer here in full: your reply is returned to that session automatically. Don't run a command or call a tool just to send it.)`;
/** A handoff's answer as the daemon delivers it into `reply_to` (CONTROL.md §6). */
const answerFrame = (harness: string, shortId: string, reply: string) =>
  `Answer from ${harness}:${shortId} (sessionpipe handoff, asked via misha-air.local:7373):\n\n${reply}`;

const CODEX_REVIEW =
  "Two things I'd change.\n\n1. Add jitter. Five failed deliveries to the same endpoint now retry in lockstep (1 s, 2 s, 4 s…), which is the thundering herd the backoff was meant to avoid. `delay * (0.5 + Math.random())` is enough.\n2. `job.attempt >= 5` checks the attempt *before* this delivery, so a job gets six tries, not five. Compare against `attempt + 1`.\n\nThe cap at 16 s is fine for a webhook. The dead-letter path reads right.";

/** The orchestrator's prompt when a background agent stops, in the recorded format. */
const taskNotification = (n: Notice): string =>
  [
    "<task-notification>",
    `<task-id>${n.agentId}</task-id>`,
    `<tool-use-id>${n.callId}</tool-use-id>`,
    "<status>completed</status>",
    `<summary>Agent "${n.description}" finished</summary>`,
    `<result>${n.result}</result>`,
    "</task-notification>",
  ].join("\n");

type Script =
  | { kind: "none" }
  | {
      kind: "working";
      nextAt: number;
      toolCallId?: string;
      tool?: string;
      toolStartedAt?: number;
      toolInput?: Record<string, unknown>;
      progressIdx: number;
      lastProgressAt: number;
      turnStartedAt: number;
      prompt: string;
      turnEndsAt: number;
    }
  | { kind: "idle"; nextTurnAt: number }
  | { kind: "attention"; attentionId: string; clearAt: number; resume: Script }
  /** The `<task-notification>` turn: the harness's prompt, then the orchestrator's answer. */
  | { kind: "notice"; endAt: number; startedAt: number; user: string; reply: string };

export class World {
  sessions = new Map<SessionKey, SessionRec>();
  private listeners = new Set<(m: StreamMessage) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  demoOn = false;
  sinkToken = `spg_${ulid().slice(4, 24).toLowerCase()}`;
  startedAt = Date.now() - 4 * 3600_000 - 123_000;
  private controlPollAt = Date.now() - 3000;
  private liveAgents: LiveAgent[] = [];
  /** Asks running now (sessionpipe ask from inside a turn): the parent's open Bash call and
   *  the Codex session answering it; when that session's turn ends, the answer comes back. */
  private asksOpen: OpenAsk[] = [];
  /** Messages the receiver carried (the control activity), newest first. */
  private control: ControlActivity[] = [];
  private attentionDueAt = Date.now() + 25_000;
  private controlKeys = [
    { id: "k_7f3a", alg: -7, name: "Misha’s iPhone", addedAt: iso(Date.now() - 6 * 86_400_000) },
    { id: "k_2c91", alg: -7, name: "MacBook Touch ID", addedAt: iso(Date.now() - 6 * 86_400_000) },
  ];

  /** `empty` gives a receiver that has heard nothing yet (the first-run board). */
  constructor(opts: { empty?: boolean } = {}) {
    if (!opts.empty) this.seed();
  }

  // ----- stream -----

  subscribe(l: (m: StreamMessage) => void): () => void {
    this.listeners.add(l);
    if (!this.timer) this.timer = setInterval(() => this.tick(), 500);
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  private emit(m: StreamMessage) {
    for (const l of this.listeners) l(m);
  }

  snapshot(): StreamMessage {
    const now = Date.now();
    return {
      kind: "snapshot",
      snapshot: {
        at: iso(now),
        sessions: [...this.sessions.values()].map((r) => this.summary(r, now)),
        machines: this.machines(now),
        stats: this.stats(now),
      },
    };
  }

  // ----- readings -----

  private children(r: SessionRec): SessionRec[] {
    const out: SessionRec[] = [];
    for (const s of this.sessions.values()) if (s.harness === r.harness && s.block.parent_id === r.id) out.push(s);
    return out;
  }

  /** A child session (`parent_id`) is also its parent's agent (server/store/store.ts
   *  syncChildAgent): one AgentRun by the child's id with `session` set and its state. */
  private childAgents(r: SessionRec, list: AgentRun[], now: number): AgentRun[] {
    const kids = this.children(r);
    if (kids.length === 0) return list;
    const out = [...list];
    for (const k of kids) {
      const c = this.summary(k, now);
      const have = out.find((a) => a.id === c.id);
      const ended = have?.state === "done" && (have.endedAt ?? "") >= c.lastAt;
      const state: AgentRun["state"] = ended || c.state === "done" ? "done" : c.state === "stale" ? "stale" : "running";
      const next: AgentRun = {
        ...(have ?? {}),
        id: c.id,
        session: c.key,
        state,
        startedAt: have?.startedAt ?? c.startedAt,
        lastAt: c.lastAt > (have?.lastAt ?? "") ? c.lastAt : (have?.lastAt ?? c.lastAt),
        tools: c.counts.tools,
        toolErrors: c.counts.toolErrors,
        attributed: true,
        recentTools: c.recentTools.slice(-4),
        currentTool: c.currentTool
          ? { tool: c.currentTool.tool, callId: c.currentTool.callId, since: c.currentTool.since }
          : undefined,
        endedAt: state === "done" ? (have?.endedAt ?? c.endedAt ?? c.lastAt) : undefined,
      };
      if (have) out.splice(out.indexOf(have), 1, next);
      else out.push(next);
    }
    const open = out.filter((a) => a.state !== "done").sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
    const done = out
      .filter((a) => a.state === "done")
      .sort((a, b) => ((b.endedAt ?? b.lastAt) < (a.endedAt ?? a.lastAt) ? -1 : 1));
    return [...open, ...done];
  }

  summary(r: SessionRec, now: number): SessionSummary {
    const block: ProtocolSession = { id: r.id, seq: 0 };
    const counts = {
      events: 0,
      turns: 0,
      tools: 0,
      toolErrors: 0,
      subagents: 0,
      compactions: 0,
      filesChanged: 0,
      attentions: 0,
      agentsRunning: 0,
      delegationsRunning: 0,
    };
    // The agents it asked (server/store/readings.ts delegations): by ask id, newest last.
    const delegations: Delegation[] = [];
    let maxTier: Tier = 0;
    let live = false;
    let startedAt = "";
    let lastAt = "";
    let endedAt: string | undefined;
    let currentTool: SessionSummary["currentTool"];
    let currentTurn: SessionSummary["currentTurn"];
    let progress: SessionSummary["progress"];
    let lastUser: string | undefined;
    let lastAssistant: string | undefined;
    let lastTurnEnd: string | undefined;
    // News for someone away (readings.ts noteNews); the mock types no turn at a terminal.
    let newsAt: string | undefined;
    const open = new Map<string, Attention>();
    const recentTools: SessionSummary["recentTools"] = [];
    let source: SessionSummary["source"] = "outbox";
    let harnessVersion: string | undefined;
    const agents = new AgentReading();

    for (const e of r.events) {
      for (const [k, v] of Object.entries(e.session) as [keyof ProtocolSession, unknown][]) {
        if (v !== undefined && v !== null && v !== "" && k !== "seq")
          (block as unknown as Record<string, unknown>)[k] = v;
      }
      if (e.harness.version) harnessVersion = e.harness.version;
      if (e.tier > maxTier) maxTier = e.tier;
      source = e.source;
      counts.events++;
      if (!startedAt) startedAt = e.time;
      lastAt = e.time;
      const d = e.data;
      const hook = e.type !== "turn.progress" && e.type !== "turn.transcript" && e.type !== "attention.needed";
      if (hook && e.type !== "attention.cleared") open.clear();
      // A subagent's own tool runs on its agent: never the session's current tool, and it
      // does not reopen the orchestrator's turn (a background agent works on after it).
      if (agents.apply(e)) {
        live = true;
        if (e.type === "tool.ended") {
          counts.tools++;
          if (d.ok === false) counts.toolErrors++;
        }
        continue;
      }
      switch (e.type) {
        case "session.started":
          live = true;
          break;
        case "session.backfill":
          if (typeof d.started_at === "string") startedAt = d.started_at;
          if (typeof d.last_at === "string") lastAt = d.last_at;
          if (typeof d.turns === "number") counts.turns = d.turns;
          break;
        case "session.ended":
          live = true;
          endedAt = e.time;
          if (!newsAt || e.arrivedAt > newsAt) newsAt = e.arrivedAt;
          currentTurn = undefined;
          currentTool = undefined;
          break;
        case "turn.started":
          live = true;
          counts.turns++;
          currentTurn = {
            turnId: typeof d.turn_id === "string" ? d.turn_id : undefined,
            since: e.time,
            promptChars: typeof d.prompt_chars === "number" ? d.prompt_chars : undefined,
          };
          break;
        case "turn.ended":
          live = true;
          currentTurn = undefined;
          currentTool = undefined;
          progress = undefined;
          lastTurnEnd = e.time;
          if (!newsAt || e.arrivedAt > newsAt) newsAt = e.arrivedAt;
          break;
        case "turn.transcript":
          lastUser = cut(String(d.user ?? ""));
          lastAssistant = cut(String(d.assistant ?? ""));
          if (progress && progress.turn === d.turn) progress = undefined;
          break;
        case "turn.progress":
          progress = {
            turn: Number(d.turn ?? 0),
            user: String(d.user ?? ""),
            assistant: String(d.assistant ?? ""),
            at: String(d.at ?? e.time),
          };
          break;
        case "tool.started":
          live = true;
          currentTool = {
            tool: String(d.tool),
            callId: typeof d.call_id === "string" ? d.call_id : undefined,
            since: e.time,
          };
          break;
        case "tool.ended": {
          live = true;
          counts.tools++;
          const ok = d.ok !== false;
          if (!ok) counts.toolErrors++;
          recentTools.push({ tool: String(d.tool), ok, ms: typeof d.ms === "number" ? d.ms : undefined });
          if (recentTools.length > 8) recentTools.shift();
          if (currentTool && (currentTool.callId ? currentTool.callId === d.call_id : currentTool.tool === d.tool))
            currentTool = undefined;
          break;
        }
        case "files.changed":
          counts.filesChanged += Array.isArray(d.paths) ? d.paths.length : 0;
          break;
        case "attention.needed": {
          // The harness's idle notice asks for nothing (server/store/readings.ts idleNotice).
          if (d.kind === "idle") break;
          const a: Attention = {
            attentionId: String(d.attention_id),
            kind: (d.kind as Attention["kind"]) ?? "question",
            tool: typeof d.tool === "string" ? d.tool : undefined,
            message: typeof d.message === "string" ? d.message : undefined,
            at: e.time,
          };
          open.set(a.attentionId, a);
          counts.attentions++;
          break;
        }
        case "attention.cleared":
          open.delete(String(d.attention_id));
          break;
        case "subagent.started":
          counts.subagents++;
          break;
        case "context.compacted":
          counts.compactions++;
          break;
        case "delegation.started":
        case "delegation.ended": {
          const askId = str(d.ask_id);
          if (!askId) break;
          let x = delegations.find((y) => y.askId === askId);
          if (!x) {
            x = {
              askId,
              via:
                d.via === "handoff" || (e.type === "delegation.ended" && d.relayed !== undefined) ? "handoff" : "ask",
              harness: str(d.harness) ?? (str(d.to) ? str(d.to)!.slice(0, str(d.to)!.indexOf(":")) : ""),
              startedAt: e.time,
            };
            delegations.push(x);
          }
          if (str(d.to)) x.to = str(d.to);
          if (e.type === "delegation.started") {
            if (str(d.text)) x.text = str(d.text)!.slice(0, 200);
            break;
          }
          x.endedAt = e.time;
          if (typeof d.ok === "boolean") x.ok = d.ok;
          if (typeof d.ms === "number") x.ms = d.ms;
          if (str(d.error)) x.error = str(d.error)!.slice(0, 200);
          if (str(d.reply)) x.reply = str(d.reply)!.slice(0, PREVIEW_CHARS);
          if (d.relayed === "delivered" || d.relayed === "unsupported" || d.relayed === "failed") x.relayed = d.relayed;
          break;
        }
      }
    }
    // The session ending closes what it asked; the answer is unknown then.
    if (endedAt) for (const x of delegations) if (!x.endedAt) x.endedAt = endedAt;
    counts.delegationsRunning = delegations.filter((x) => !x.endedAt).length;

    const lastMs = Date.parse(lastAt);
    let state: SessionSummary["state"];
    let stateSince: string;
    // A subagent still running keeps its orchestrator working after the turn that
    // launched it ended (readings.ts evaluateState); so does an agent it asked and has no
    // answer from yet.
    const openAgent = agents.agents.find((a) => a.state !== "done");
    const openAsk = delegations.find((x) => !x.endedAt);
    if (open.size > 0) {
      state = "needs_you";
      stateSince = [...open.values()][0]!.at;
    } else if (endedAt) {
      state = "done";
      stateSince = endedAt;
    } else if (!live || now - lastMs > DONE_AFTER_MS) {
      state = "done";
      stateSince = live ? iso(lastMs + DONE_AFTER_MS) : lastAt;
    } else if (currentTurn || openAgent || openAsk) {
      if (now - lastMs > STALE_AFTER_MS) {
        state = "stale";
        stateSince = iso(lastMs + STALE_AFTER_MS);
      } else {
        state = "working";
        const begun = openAgent?.startedAt ?? openAsk?.startedAt ?? "";
        stateSince = currentTurn && (!begun || currentTurn.since < begun) ? currentTurn.since : begun;
      }
    } else {
      state = "idle";
      stateSince = lastTurnEnd ?? lastAt;
    }

    const agentList = this.childAgents(r, agents.settle(now, state === "done", endedAt ?? lastAt), now);
    counts.agentsRunning = agentList.filter((a) => a.state !== "done").length;
    return {
      key: r.key,
      harness: r.harness,
      harnessVersion,
      id: r.id,
      machine: block.machine,
      cwd: block.cwd,
      repo: block.repo,
      branch: block.branch,
      model: block.model,
      title: block.title,
      titleSource: block.title_source,
      url: block.url,
      accountId: block.account_id,
      parentId: block.parent_id ?? null,
      launchedBy: block.launched_by,
      delegatedBy: block.delegated_by,
      state,
      stateSince,
      startedAt,
      lastAt,
      endedAt,
      maxTier,
      backfilled: !live,
      source,
      counts,
      currentTool,
      currentTurn,
      openAttentions: [...open.values()],
      progress,
      lastUser,
      lastAssistant,
      children: this.children(r).length,
      agents: agentList,
      ...(delegations.length ? { delegations } : {}),
      recentTools,
      flags: [],
      turnStats: { count: 0 },
      newsAt,
    };
  }

  machines(now: number): MachineSummary[] {
    return MACHINES.map((m, i) => {
      const mine = [...this.sessions.values()].filter((r) => r.machine === m.name).map((r) => this.summary(r, now));
      const lastAt = mine.reduce((acc, s) => (s.lastAt > acc ? s.lastAt : acc), "");
      const base: MachineSummary = {
        name: m.name,
        lastAt,
        harnesses: m.harnesses,
        sessions: mine.length,
        working: mine.filter((s) => s.state === "working").length,
        needsYou: mine.filter((s) => s.state === "needs_you").length,
      };
      if (!base.lastAt) base.lastAt = iso(this.startedAt);
      // Three daemons, so the New session sheet shows each honestly: one on sessionpipe
      // 0.10 advertising every start option, one in safe mode offering read and safe, and
      // one old one with no start options and no files.
      const common = {
        lastPollAt: iso(this.controlPollAt),
        lastHelloAt: iso(this.startedAt + 2000),
        modes: ["sdk", "waiter", "turn", "resume", "fork"],
        keys: this.controlKeys,
        queued: 0,
      };
      if (i === 0)
        base.control = {
          ...common,
          machineId: "m_01K6Q3H2A9misha-air",
          online: true,
          mode: "auto",
          folders: ["/Users/misha/spacesheep", "/Users/misha/sessionpipe"],
          tilde: true,
          harnesses: ["claude-code", "codex", "gemini-cli"],
          version: "0.10.0",
          files: true,
          promptFiles: true,
          // Its agents ask each other through the daemon, and a prompt or a start may name
          // the session to bring the answer back into (CONTROL.md §13, §3.1).
          ask: true,
          handoff: true,
          start: {
            "claude-code": { permissions: ["read", "safe", "edits", "auto"], permission: "auto", anyModel: true },
            codex: {
              permissions: ["read", "safe", "auto"],
              permission: "auto",
              anyModel: true,
              models: ["gpt-6-astra", "gpt-5.6-sol"],
            },
          },
          accounts: [{ harness: "claude-code", id: "a1b2c3", email: "dev@example.com" }],
        };
      else if (i === 1)
        base.control = {
          ...common,
          machineId: "m_01K6Q3H2A9studio-mini",
          online: true,
          mode: "safe",
          folders: ["/Users/studio/acme"],
          tilde: true,
          harnesses: ["claude-code", "antigravity"],
          version: "0.10.0",
          files: true,
          start: { "claude-code": { permissions: ["read", "safe"], permission: "safe", anyModel: true } },
          accounts: [{ harness: "claude-code", id: "w4e5f6", email: "work@acme.dev" }],
        };
      else
        base.control = {
          ...common,
          machineId: "m_01K6Q3H2A9build-box0",
          online: false,
          lastPollAt: iso(this.startedAt + 60_000),
          mode: "safe",
          folders: ["/srv/build"],
          harnesses: ["claude-code", "codex"],
          version: "0.9.0",
        };
      return base;
    });
  }

  private allEvents(): StoredEvent[] {
    const out: StoredEvent[] = [];
    for (const r of this.sessions.values()) out.push(...r.events);
    return out;
  }

  stats(now: number): Stats {
    const all = this.allEvents();
    const lastMinute = all.filter((e) => now - Date.parse(e.arrivedAt) < 60_000).length;
    return {
      events: all.length,
      sessions: this.sessions.size,
      machines: MACHINES.length,
      eventsLastMinute: lastMinute,
      latencyP50Ms: 640 + Math.round(rnd(-40, 40)),
      storageBytes: all.reduce((n, e) => n + JSON.stringify(e).length + 1, 0),
      uptimeS: Math.floor((now - this.startedAt) / 1000),
    };
  }

  info(): Info {
    const lan = "http://192.168.1.21:5173";
    return {
      name: "sessionpipe-gui",
      version: "0.1.0",
      startedAt: iso(this.startedAt),
      port: 5173,
      urls: { local: "http://localhost:5173", lan: [lan, "http://10.8.0.4:5173"] },
      sinkCommand: `sessionpipe sink add ${lan} --tier 3 --token ${this.sinkToken}`,
      sinkToken: this.sinkToken,
      uiKey: "uik_2f9c1e7a",
      sources: {
        http: true,
        outbox: {
          path: "~/.local/state/sessionpipe/outbox",
          sessions: [...this.sessions.values()].filter((r) => r.machine === "misha-air").length,
          enabled: true,
        },
        demo: this.demoOn,
      },
      storage: { dir: "~/.local/state/sessionpipe-gui/events", bytes: this.stats(Date.now()).storageBytes },
      wellKnown: {
        protocol: [1],
        max_tier: 3,
        capabilities: ["events", "backfill", "forget", "control"],
        auth: ["bearer"],
        batch: { max_events: 50, max_bytes: 262144 },
        control: { wait_max_s: 25, signing: { rp_id: "localhost", algs: [-7, -257] } },
      },
      control: { enabled: true, rpId: "localhost", machines: 1 },
    };
  }

  /** The session files route over the mock's events (the same pairing the server runs). */
  sessionFiles(harness: string, id: string): SessionFiles | null {
    const r = this.sessions.get(sessionKey(harness, id));
    if (!r) return null;
    const sorted = [...r.events].sort((a, b) => a.session.seq - b.session.seq);
    return { files: indexTouches(sorted, r.block.cwd), lastSeq: sorted[sorted.length - 1]?.session.seq ?? -1 };
  }

  detail(harness: string, id: string, q: DetailQuery = {}): SessionDetail | null {
    const r = this.sessions.get(sessionKey(harness, id));
    if (!r) return null;
    const now = Date.now();
    const limit = Math.max(1, Math.min(500, q.limit ?? 500));
    let sorted = [...r.events].sort((a, b) => a.session.seq - b.session.seq);
    // One subagent's events: its own (agent_id) and the call that launched it.
    if (q.agent) {
      const run = this.summary(r, now).agents.find((a) => a.id === q.agent);
      sorted = sorted.filter(
        (e) =>
          e.data.agent_id === q.agent || (!!run?.callId && e.type.startsWith("tool.") && e.data.call_id === run.callId),
      );
    }
    let page: StoredEvent[];
    if (q.tail || q.before !== undefined) {
      const below = q.tail ? Number.POSITIVE_INFINITY : q.before!;
      page = sorted.filter((e) => e.session.seq < below).slice(-limit);
    } else {
      page = (q.after === undefined ? sorted : sorted.filter((e) => e.session.seq > q.after!)).slice(0, limit);
    }
    const firstSeq = page[0]?.session.seq;
    return {
      session: this.summary(r, now),
      events: q.slim ? page.map((e) => slim(e, q.preview)) : page,
      total: sorted.length,
      children: this.children(r).map((c) => this.summary(c, now)),
      firstSeq,
      hasOlder: firstSeq !== undefined && sorted.some((e) => e.session.seq < firstSeq),
    };
  }

  feed(q: FeedQuery): FeedPage {
    let all = this.allEvents().sort((a, b) => b.arrivedAt.localeCompare(a.arrivedAt) || b.id.localeCompare(a.id));
    if (q.harness) all = all.filter((e) => e.harness.name === q.harness);
    if (q.machine) all = all.filter((e) => e.session.machine === q.machine);
    if (q.type) all = all.filter((e) => e.type === q.type || e.type.startsWith(`${q.type}.`));
    if (q.session) all = all.filter((e) => sessionKey(e.harness.name, e.session.id) === q.session);
    if (q.q) {
      const needle = q.q.toLowerCase();
      all = all.filter((e) => JSON.stringify(e).toLowerCase().includes(needle));
    }
    if (q.before) {
      const [at, id] = q.before.split("|");
      all = all.filter((e) => e.arrivedAt < at! || (e.arrivedAt === at && e.id < (id ?? "")));
    }
    const limit = Math.min(500, q.limit ?? 100);
    const events = all.slice(0, limit).map(slim);
    const last = events[events.length - 1];
    return { events, cursor: all.length > limit && last ? `${last.arrivedAt}|${last.id}` : undefined };
  }

  forget(harness: string, id: string): boolean {
    const key = sessionKey(harness, id);
    if (!this.sessions.delete(key)) return false;
    this.emit({ kind: "forgotten", key });
    this.emitStats();
    return true;
  }

  rotate(): string {
    this.sinkToken = `spg_${ulid().slice(4, 24).toLowerCase()}`;
    return this.sinkToken;
  }

  // ----- writing events -----

  private push(r: SessionRec, type: string, data: Record<string, unknown>, at = Date.now(), tier?: Tier): StoredEvent {
    const e: StoredEvent = {
      protocol: 1,
      id: ulid(at),
      type,
      time: iso(at),
      tier: tier ?? r.tier,
      harness: { name: r.harness, version: r.harnessVersion, event: HOOK_NAMES[r.harness]?.[type] },
      session: { ...r.block, seq: r.seq++ },
      privacy: { rulesets: r.tier > 0 ? ["secrets@1"] : [], pii: false },
      data,
      arrivedAt: iso(at + (at > Date.now() - 1000 ? rnd(5, 40) : rnd(400, 900))),
      source: r.machine === "misha-air" ? "outbox" : "http",
    };
    r.events.push(e);
    return e;
  }

  private send(r: SessionRec, type: string, data: Record<string, unknown>, tier?: Tier) {
    const e = this.push(r, type, data, Date.now(), tier);
    this.emit({ kind: "event", event: slim(e), session: this.summary(r, Date.now()) });
  }

  private emitStats() {
    const now = Date.now();
    this.emit({ kind: "stats", stats: this.stats(now) });
    for (const m of this.machines(now)) this.emit({ kind: "machine", machine: m });
  }

  // ----- the simulation -----

  private lastStatsAt = 0;

  private tick() {
    const now = Date.now();
    for (const r of [...this.sessions.values()]) this.step(r, now);
    for (const a of [...this.liveAgents]) if (this.sessions.has(a.r.key)) this.stepAgent(a, now);
    for (const a of [...this.asksOpen]) this.stepAsk(a, now);
    if (now - this.lastStatsAt > 5000) {
      this.lastStatsAt = now;
      this.controlPollAt = now - Math.floor(rnd(500, 4000));
      this.emitStats();
    }
    if (now > this.attentionDueAt) {
      this.attentionDueAt = now + rnd(60_000, 110_000);
      const candidates = [...this.sessions.values()].filter((r) => r.script.kind === "working" && !r.block.parent_id);
      if (candidates.length) this.raiseAttention(pick(candidates), now);
    }
  }

  private raiseAttention(r: SessionRec, now: number) {
    const s = r.script;
    if (s.kind !== "working") return;
    const tool = pick(TOOLS[r.harness] ?? ["Bash"]);
    const attentionId = `att_${ulid(now).slice(-8).toLowerCase()}`;
    const kind = Math.random() < 0.75 ? "permission" : "question";
    const message =
      kind === "permission"
        ? pick([
            "rm -rf dist && npm run build",
            "git push origin mp/outbox-read-linear",
            "curl -X POST http://localhost:7373/api/ui/demo",
          ])
        : pick(["Should the deprecated alias log once or on every call?", "Keep the 1 MB cap configurable?"]);
    this.send(
      r,
      "attention.needed",
      r.tier >= 1 ? { attention_id: attentionId, kind, tool, message } : { attention_id: attentionId, kind },
    );
    r.script = { kind: "attention", attentionId, clearAt: now + rnd(20_000, 45_000), resume: s };
  }

  private step(r: SessionRec, now: number) {
    const s = r.script;
    switch (s.kind) {
      case "none":
        return;
      case "attention":
        if (now >= s.clearAt) {
          this.send(r, "attention.cleared", { attention_id: s.attentionId, how: "answered" });
          r.script = { ...s.resume, nextAt: now + 800 } as Script;
        }
        return;
      case "idle": {
        // A background agent that finished reports back first, in a turn of its own.
        const n = r.notices.shift();
        if (n) this.noticeTurn(r, n, now);
        else if (now >= s.nextTurnAt) this.startTurn(r, now);
        return;
      }
      case "notice":
        if (now >= s.endAt) {
          this.send(r, "turn.ended", { turn_id: `t_${r.turn}`, reason: "stop", ms: now - s.startedAt });
          this.send(r, "turn.transcript", { turn: r.turn, user: s.user, assistant: s.reply, at: iso(now) });
          r.script = { kind: "idle", nextTurnAt: now + rnd(20_000, 50_000) };
        }
        return;
      case "working":
        if (now >= s.turnEndsAt) {
          if (s.tool) this.endTool(r, s, now);
          const ms = now - s.turnStartedAt;
          this.send(r, "turn.ended", { reason: "stop", ms });
          if (r.tier >= 2) {
            this.send(r, "turn.transcript", {
              turn: r.turn,
              user: s.prompt,
              assistant: pick(ASSISTANT_REPLIES),
              at: iso(now),
            });
          }
          r.script = { kind: "idle", nextTurnAt: now + rnd(12_000, 40_000) };
          return;
        }
        if (now >= s.nextAt) {
          if (s.tool) {
            this.endTool(r, s, now);
            s.nextAt = now + rnd(400, 2500);
            if (r.tier >= 2 && now - s.lastProgressAt > 9000 && s.progressIdx < PROGRESS_LINES.length) {
              s.progressIdx++;
              s.lastProgressAt = now;
              this.send(r, "turn.progress", {
                turn: r.turn,
                user: s.prompt,
                assistant: PROGRESS_LINES.slice(0, s.progressIdx).join("\n\n"),
                at: iso(now),
              });
            }
          } else {
            this.startTool(r, s, now);
            s.nextAt = now + rnd(500, 6000);
          }
        }
        return;
    }
  }

  private startTool(
    r: SessionRec,
    s: {
      tool?: string;
      toolCallId?: string;
      toolStartedAt?: number;
      toolInput?: Record<string, unknown>;
      toolExtra?: Record<string, unknown>;
    },
    now: number,
    extra?: Record<string, unknown>,
  ) {
    const tool = pick(TOOLS[r.harness] ?? ["Bash"]);
    const callId = `toolu_${ulid(now).slice(-10)}`;
    const input = TOOL_INPUTS[tool]?.() ?? { arg: "…" };
    s.tool = tool;
    s.toolCallId = callId;
    s.toolStartedAt = now;
    s.toolInput = input;
    s.toolExtra = extra;
    const data: Record<string, unknown> = { tool, call_id: callId, ...extra };
    if (r.tier >= 3) data.input = input;
    this.send(r, "tool.started", data);
  }

  private endTool(
    r: SessionRec,
    s: {
      tool?: string;
      toolCallId?: string;
      toolStartedAt?: number;
      toolInput?: Record<string, unknown>;
      toolExtra?: Record<string, unknown>;
    },
    now: number,
  ) {
    if (!s.tool) return;
    const ok = Math.random() > 0.08;
    const data: Record<string, unknown> = {
      tool: s.tool,
      call_id: s.toolCallId,
      ...s.toolExtra,
      ms: now - (s.toolStartedAt ?? now),
      ok,
    };
    if (!ok) data.error = pick(["exit 1", "ENOENT: no such file", "timeout after 30 s"]);
    if (r.tier >= 3) {
      data.input = s.toolInput;
      data.output = ok ? (TOOL_OUTPUTS[s.tool]?.() ?? "ok") : "command failed";
    }
    this.send(r, "tool.ended", data);
    if (
      (s.tool === "Edit" || s.tool === "Write" || s.tool === "apply_patch" || s.tool === "replace") &&
      r.tier >= 1 &&
      ok
    ) {
      const input = s.toolInput ?? {};
      const p = String(input.file_path ?? input.path ?? "src/lib/db.ts");
      this.send(r, "files.changed", { paths: [p] });
    }
    s.tool = undefined;
    s.toolCallId = undefined;
    s.toolExtra = undefined;
  }

  /** One beat of a live subagent: its next tool, or its end (and a background one's
   *  notice for the orchestrator). */
  private stepAgent(a: LiveAgent, now: number) {
    if (now >= a.endAt) {
      if (a.tool) this.endTool(a.r, a, now);
      this.send(a.r, "subagent.ended", { agent_id: a.id, agent_type: a.type });
      if (a.notice) a.r.notices.push(a.notice);
      this.liveAgents = this.liveAgents.filter((x) => x !== a);
      return;
    }
    if (now < a.nextAt) return;
    if (a.tool) {
      this.endTool(a.r, a, now);
      a.nextAt = now + rnd(1500, 4000);
    } else {
      this.startTool(a.r, a, now, { agent_id: a.id, turn_id: a.turnId });
      a.nextAt = now + rnd(1500, 6000);
    }
  }

  /** An ask comes back once the Codex session answering it ended its turn: the daemon says
   *  so on the asking session, the `sessionpipe ask` call returns the answer on stdout, and
   *  the asking turn ends with it. */
  private stepAsk(a: OpenAsk, now: number) {
    const child = this.sessions.get(a.child.key);
    if (!child || child.script.kind !== "idle") return;
    const last = [...child.events].reverse().find((e) => e.type === "turn.transcript");
    const reply = String(last?.data.assistant ?? "Reviewed; nothing to change.");
    this.asksOpen = this.asksOpen.filter((x) => x !== a);
    this.send(a.parent, "delegation.ended", {
      ask_id: a.askId,
      to: a.child.key,
      ok: true,
      ms: now - a.startedAt,
      reply,
    });
    this.send(a.parent, "tool.ended", {
      tool: "Bash",
      call_id: a.callId,
      turn_id: a.turnId,
      ms: now - a.startedAt,
      ok: true,
      input: a.input,
      output: { stdout: reply, stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
    });
    const said = `Codex is back. ${reply.split("\n")[0]} I've applied what it said.`;
    this.send(a.parent, "turn.ended", { turn_id: a.turnId, reason: "stop", ms: now - a.turnStartedAt });
    this.send(a.parent, "turn.transcript", { turn: a.parent.turn, user: a.prompt, assistant: said, at: iso(now) });
    a.parent.script = { kind: "idle", nextTurnAt: now + rnd(90_000, 150_000) };
  }

  /** The messages the receiver carried, newest first (the control activity). */
  controlActivity(): ControlActivity[] {
    return this.control;
  }

  /** Claude Code's follow-up turn when a background agent stopped. */
  private noticeTurn(r: SessionRec, n: Notice, now: number) {
    r.turn++;
    const user = taskNotification(n);
    this.send(r, "turn.started", { turn_id: `t_${r.turn}`, prompt_chars: user.length });
    if (r.tier >= 2) this.send(r, "turn.progress", { turn: r.turn, user, assistant: "", at: iso(now) });
    r.script = { kind: "notice", endAt: now + rnd(4000, 8000), startedAt: now, user, reply: n.followUp };
  }

  private startTurn(r: SessionRec, now: number) {
    r.turn++;
    const prompt = pick(PROMPTS);
    this.send(
      r,
      "turn.started",
      r.tier >= 1 ? { turn_id: `t_${r.turn}`, prompt_chars: prompt.length } : { turn_id: `t_${r.turn}` },
    );
    if (r.tier >= 2) this.send(r, "turn.progress", { turn: r.turn, user: prompt, assistant: "", at: iso(now) });
    r.script = {
      kind: "working",
      nextAt: now + rnd(500, 2000),
      progressIdx: 0,
      lastProgressAt: now,
      turnStartedAt: now,
      prompt,
      turnEndsAt: now + rnd(45_000, 120_000),
    };
  }

  // ----- seed -----

  private add(spec: {
    harness: string;
    machine: string;
    cwd: string;
    repo?: string;
    branch?: string;
    model?: string;
    title?: string;
    titleSource?: ProtocolSession["title_source"];
    url?: string;
    tier: Tier;
    parent?: SessionRec;
    id?: string;
  }): SessionRec {
    // Deterministic ids so a session URL survives a reload in mock mode.
    const n = this.sessions.size + 1;
    const id =
      spec.id ?? `${(0x8c132906 + n * 0x1f3a7).toString(16)}-${String(n).padStart(4, "0")}-4814-870a-afc3d05e1d2e`;
    const m = MACHINES.find((x) => x.name === spec.machine)!;
    const r: SessionRec = {
      key: sessionKey(spec.harness, id),
      harness: spec.harness,
      harnessVersion: m.harnesses[spec.harness],
      id,
      block: {
        id,
        seq: 0,
        machine: spec.machine,
        cwd: spec.cwd,
        repo: spec.repo,
        branch: spec.branch,
        model: spec.model,
        title: spec.title,
        title_source: spec.title ? (spec.titleSource ?? "harness") : undefined,
        url: spec.url,
        account_id: spec.harness === "claude-code" ? (spec.machine === "studio-mini" ? "w4e5f6" : "a1b2c3") : undefined,
        parent_id: spec.parent ? spec.parent.id : null,
      },
      machine: spec.machine,
      events: [],
      tier: spec.tier,
      seq: 0,
      turn: 0,
      script: { kind: "none" },
      notices: [],
    };
    this.sessions.set(r.key, r);
    return r;
  }

  /** A completed exchange in the past: prompt, a few tools, end, transcript. */
  private pastTurn(r: SessionRec, at: number, prompt: string, reply: string, tools = 4, errorAt?: number): number {
    let t = at;
    r.turn++;
    const turnId = `t_${r.turn}`;
    this.push(
      r,
      "turn.started",
      r.tier >= 1 ? { turn_id: turnId, prompt_chars: prompt.length } : { turn_id: turnId },
      t,
    );
    if (r.tier >= 2) this.push(r, "turn.progress", { turn: r.turn, user: prompt, assistant: "", at: iso(t) }, t);
    for (let i = 0; i < tools && r.tier >= 1; i++) {
      t += rnd(800, 4000);
      const tool = pick(TOOLS[r.harness] ?? ["Bash"]);
      const callId = `toolu_${ulid(t).slice(-10)}`;
      const input = TOOL_INPUTS[tool]?.() ?? {};
      const started: Record<string, unknown> = { tool, call_id: callId, turn_id: turnId };
      if (r.tier >= 3) started.input = input;
      this.push(r, "tool.started", started, t);
      const ms = rnd(120, 6000);
      t += ms;
      const ok = errorAt !== i;
      const ended: Record<string, unknown> = { tool, call_id: callId, turn_id: turnId, ms: Math.round(ms), ok };
      if (!ok) ended.error = "exit 1";
      if (r.tier >= 3) {
        ended.input = input;
        ended.output = ok ? (TOOL_OUTPUTS[tool]?.() ?? "ok") : "npm ERR! Test failed. See above for more details.";
      }
      this.push(r, "tool.ended", ended, t);
      if ((tool === "Edit" || tool === "Write" || tool === "replace" || tool === "apply_patch") && ok) {
        this.push(r, "files.changed", { paths: [String(input.file_path ?? input.path ?? "src/index.ts")] }, t + 5);
      }
    }
    t += rnd(1500, 5000);
    this.push(r, "turn.ended", { turn_id: turnId, reason: "stop", ms: Math.round(t - at) }, t);
    if (r.tier >= 2)
      this.push(r, "turn.transcript", { turn: r.turn, user: prompt, assistant: reply, at: iso(t) }, t + 1200);
    return t + 1200;
  }

  /** An Agent call that launches a subagent: its input (the description a person reads),
   *  and for a background one the immediate "async_launched" output naming the agent. */
  private launch(
    r: SessionRec,
    at: number,
    a: { agentId: string; callId: string; description: string; type: string; turnId: string; background: boolean },
  ) {
    this.push(
      r,
      "tool.started",
      {
        tool: "Agent",
        call_id: a.callId,
        turn_id: a.turnId,
        input: {
          description: a.description,
          subagent_type: a.type,
          prompt: `${a.description}.`,
          run_in_background: a.background,
        },
      },
      at,
    );
    if (a.background)
      this.push(
        r,
        "tool.ended",
        {
          tool: "Agent",
          call_id: a.callId,
          turn_id: a.turnId,
          ms: 600,
          ok: true,
          output: { isAsync: true, status: "async_launched", agentId: a.agentId, description: a.description },
        },
        at + 600,
      );
  }

  /** A subagent's past inside its parent: SubagentStart, its tools (stamped with its
   *  agent_id and the spawning turn's turn_id; `failAt` fails one), and SubagentStop at
   *  `endAt` when it already ended. Returns when it ended (or its last tool). */
  private pastAgent(
    r: SessionRec,
    at: number,
    a: { id: string; type: string; turnId: string; tools: number; failAt?: number; endAt?: number },
  ): number {
    let t = at;
    this.push(r, "subagent.started", { agent_id: a.id, agent_type: a.type }, t);
    for (let i = 0; i < a.tools; i++) {
      t += rnd(2500, 6000);
      const tool = pick(["Grep", "Read", "Glob", "Read"]);
      const callId = `toolu_${a.id}_${i}`;
      const input = TOOL_INPUTS[tool]?.() ?? {};
      const extra = { agent_id: a.id, turn_id: a.turnId };
      this.push(r, "tool.started", { tool, call_id: callId, ...extra, input }, t);
      const ms = Math.round(rnd(80, 1800));
      t += ms;
      const ok = a.failAt !== i;
      this.push(
        r,
        "tool.ended",
        {
          tool,
          call_id: callId,
          ...extra,
          ms,
          ok,
          ...(ok ? {} : { error: "ENOENT: no such file" }),
          input,
          output: ok ? (TOOL_OUTPUTS[tool]?.() ?? "ok") : null,
        },
        t,
      );
    }
    if (a.endAt !== undefined) {
      t = Math.max(t + 500, a.endAt);
      this.push(r, "subagent.ended", { agent_id: a.id, agent_type: a.type }, t);
    }
    return t;
  }

  private seed() {
    const now = Date.now();
    const min = 60_000;

    // 1. working, tier 3, with a subagent
    const s1 = this.add({
      harness: "claude-code",
      machine: "misha-air",
      cwd: "~/spacesheep",
      repo: "github.com/spacesheep-dev/spacesheep",
      branch: "main",
      model: "claude-fable-5-1",
      title: "Open-source session hooks",
      url: "https://claude.ai/code/session_01K6ABCX",
      tier: 3,
    });
    let t = now - 42 * min;
    this.push(s1, "session.started", { source: "startup" }, t);
    t = this.pastTurn(s1, t + 4000, PROMPTS[0]!, ASSISTANT_REPLIES[0]!, 5);
    t = this.pastTurn(s1, t + 90_000, PROMPTS[1]!, ASSISTANT_REPLIES[1]!, 3);
    this.push(s1, "context.compacted", { trigger: "auto" }, t + 2000);
    t = this.pastTurn(s1, t + 60_000, PROMPTS[3]!, ASSISTANT_REPLIES[3]!, 6, 2);
    t = this.pastTurn(s1, t + 30_000, PROMPTS[2]!, ASSISTANT_REPLIES[2]!, 4);
    t = this.pastTurn(s1, t + 20_000, PROMPTS[4]!, ASSISTANT_REPLIES[4]!, 2);
    {
      // The current turn, running: it launched an Explore agent in the background, which
      // works inside this session (its tools carry agent_id) and reports back when done.
      const start = now - 3 * min;
      s1.turn++;
      const turnId = `t_${s1.turn}`;
      this.push(s1, "turn.started", { turn_id: turnId, prompt_chars: PROMPTS[0]!.length }, start);
      this.push(s1, "turn.progress", { turn: s1.turn, user: PROMPTS[0], assistant: "", at: iso(start) }, start);
      const explore = {
        agentId: "ag_explore_1",
        callId: "toolu_explore_1",
        description: "Find where batches are bounded",
        result:
          "Batches are bounded in outbox/read.ts:41 (50 events) and outbox/send.ts:88 (256 KB); nothing else caps them.",
        followUp: "The Explore agent found both bounds: 50 events in read.ts and 256 KB in send.ts.",
      };
      this.launch(s1, start + 5000, { ...explore, type: "Explore", turnId, background: true });
      this.pastAgent(s1, start + 6000, { id: explore.agentId, type: "Explore", turnId, tools: 3 });
      this.push(
        s1,
        "turn.progress",
        {
          turn: s1.turn,
          user: PROMPTS[0],
          assistant: PROGRESS_LINES.slice(0, 2).join("\n\n"),
          at: iso(start + 40_000),
        },
        start + 40_000,
      );
      this.liveAgents.push({
        r: s1,
        id: explore.agentId,
        type: "Explore",
        turnId,
        notice: explore,
        nextAt: now + 1500,
        endAt: now + rnd(35_000, 60_000),
      });
      s1.script = {
        kind: "working",
        nextAt: now + 1000,
        progressIdx: 2,
        lastProgressAt: now - 5000,
        turnStartedAt: start,
        prompt: PROMPTS[0]!,
        turnEndsAt: now + rnd(70_000, 120_000),
      };
    }
    // 3. a finished subagent of s1
    const s3 = this.add({
      harness: "claude-code",
      machine: "misha-air",
      cwd: "~/spacesheep",
      repo: "github.com/spacesheep-dev/spacesheep",
      branch: "main",
      model: "claude-fable-5-1",
      title: "general-purpose: run the suite",
      tier: 3,
      parent: s1,
      id: `${s1.id}-ag_gp_0`,
    });
    {
      const start = now - 30 * min;
      this.push(s3, "session.started", { source: "startup" }, start);
      const end = this.pastTurn(
        s3,
        start + 500,
        "Run the suite and report failures.",
        "84 tests, 2 failing in outbox.test.ts.",
        3,
      );
      this.push(s3, "session.ended", { reason: "other" }, end + 300);
    }

    // The three-agent scene (server/demo's "Search: review the BM25 cache"): one turn
    // launches two agents in the background and one in the foreground. The foreground one
    // (a tool of it failed) answered in the call's output; one background agent already
    // reported back through a <task-notification> turn; the other is still working.
    const sb = this.add({
      harness: "claude-code",
      machine: "studio-mini",
      cwd: "~/code/search-api",
      repo: "github.com/acme/search-api",
      branch: "perf/bm25-cache",
      model: "claude-fable-5-1",
      title: "Search: review the BM25 cache",
      titleSource: "custom",
      tier: 3,
    });
    {
      const start = now - 4 * min;
      this.push(sb, "session.started", { source: "startup" }, start - 2000);
      sb.turn++;
      const turnId = `t_${sb.turn}`;
      const prompt =
        "Before I merge the BM25 cache, review it from three angles at once with subagents: correctness of the invalidation, the hot-path performance, and what the tests miss.";
      this.push(sb, "turn.started", { turn_id: turnId, prompt_chars: prompt.length }, start);
      this.push(sb, "turn.progress", { turn: sb.turn, user: prompt, assistant: "", at: iso(start) }, start);
      const inval = {
        agentId: "ag_inval",
        callId: "toolu_inval",
        description: "Check cache invalidation",
        result:
          "One stale path: bulkIndex() (src/index/bulk.ts:88) writes with skipHooks, so write.ts:52 never clears the cached score.",
        followUp: "The invalidation review found one real hole: bulk indexing skips the hook that clears the cache.",
      };
      const perf = {
        agentId: "ag_perf",
        callId: "toolu_perf",
        description: "Profile the scoring hot path",
        result: "p99 drops from 21 ms to 6.4 ms with the cache warm; query tokenising is now the slowest step.",
        followUp: "Performance holds up: p99 drops from 21 ms to 6.4 ms.",
      };
      this.launch(sb, start + 3000, { ...inval, type: "Explore", turnId, background: true });
      this.pastAgent(sb, start + 4200, { id: inval.agentId, type: "Explore", turnId, tools: 3, endAt: start + 62_000 });
      this.launch(sb, start + 5000, { ...perf, type: "general-purpose", turnId, background: true });
      this.pastAgent(sb, start + 6000, { id: perf.agentId, type: "general-purpose", turnId, tools: 4, failAt: 1 });
      // The foreground agent: its call stays open while it works, and its output is its result.
      this.push(
        sb,
        "tool.started",
        {
          tool: "Agent",
          call_id: "toolu_tests",
          turn_id: turnId,
          input: {
            description: "List untested cache paths",
            subagent_type: "general-purpose",
            prompt: "List the BM25 cache's code paths no test reaches.",
          },
        },
        start + 7000,
      );
      const testsEnd = this.pastAgent(sb, start + 7500, {
        id: "ag_tests",
        type: "general-purpose",
        turnId,
        tools: 3,
        failAt: 1,
        endAt: start + 40_000,
      });
      this.push(
        sb,
        "tool.ended",
        {
          tool: "Agent",
          call_id: "toolu_tests",
          turn_id: turnId,
          ms: testsEnd - start - 7000,
          ok: true,
          output: {
            status: "completed",
            agentId: "ag_tests",
            content: [{ type: "text", text: "Eviction (lines 22–27) and the size cap (line 41) have no tests." }],
          },
        },
        testsEnd + 300,
      );
      const said =
        "The coverage review is back: eviction (lines 22–27) and the size cap (line 41) have no tests. The invalidation and performance reviewers are still running in the background; I'll summarise them as they report.";
      this.push(sb, "turn.ended", { turn_id: turnId, reason: "stop", ms: 50_000 }, start + 50_000);
      this.push(
        sb,
        "turn.transcript",
        { turn: sb.turn, user: prompt, assistant: said, at: iso(start + 50_000) },
        start + 51_000,
      );
      // The invalidation agent reported back in a turn of the harness's own.
      sb.turn++;
      const note = taskNotification(inval);
      const nStart = start + 64_000;
      this.push(sb, "turn.started", { turn_id: `t_${sb.turn}`, prompt_chars: note.length }, nStart);
      this.push(sb, "turn.progress", { turn: sb.turn, user: note, assistant: "", at: iso(nStart) }, nStart);
      this.push(sb, "turn.ended", { turn_id: `t_${sb.turn}`, reason: "stop", ms: 6000 }, nStart + 6000);
      this.push(
        sb,
        "turn.transcript",
        { turn: sb.turn, user: note, assistant: inval.followUp, at: iso(nStart + 6000) },
        nStart + 6500,
      );
      // The performance agent works on.
      this.liveAgents.push({
        r: sb,
        id: perf.agentId,
        type: "general-purpose",
        turnId,
        notice: perf,
        nextAt: now + 2000,
        endAt: now + rnd(60_000, 90_000),
      });
      sb.script = { kind: "idle", nextTurnAt: now + 10 * min };
    }

    // 4. needs you: permission, codex, tier 2
    const s4 = this.add({
      harness: "codex",
      machine: "misha-air",
      cwd: "~/sessionpipe",
      repo: "github.com/spacesheep-dev/sessionpipe",
      branch: "mp/outbox-read-linear",
      model: "gpt-5-codex",
      title: "Outbox: a batch reads 1 MB of a session file",
      titleSource: "first-ask",
      tier: 2,
    });
    {
      t = now - 18 * min;
      this.push(s4, "session.started", { source: "resume" }, t);
      t = this.pastTurn(s4, t + 3000, PROMPTS[0]!, ASSISTANT_REPLIES[0]!, 4);
      const start = now - 2 * min;
      s4.turn++;
      this.push(s4, "turn.started", { turn_id: `t_${s4.turn}`, prompt_chars: 61 }, start);
      this.push(
        s4,
        "turn.progress",
        { turn: s4.turn, user: "Now rebuild and push the branch.", assistant: "", at: iso(start) },
        start,
      );
      this.push(s4, "tool.started", { tool: "shell", call_id: "call_8d1" }, start + 2000);
      this.push(s4, "tool.ended", { tool: "shell", call_id: "call_8d1", ms: 1830, ok: true }, start + 3830);
      this.push(
        s4,
        "attention.needed",
        {
          attention_id: "att_push1",
          kind: "permission",
          tool: "shell",
          message: "git push origin mp/outbox-read-linear",
        },
        now - 48_000,
      );
      s4.script = {
        kind: "attention",
        attentionId: "att_push1",
        clearAt: now + rnd(50_000, 90_000),
        resume: {
          kind: "working",
          nextAt: 0,
          progressIdx: 1,
          lastProgressAt: 0,
          turnStartedAt: start,
          prompt: "Now rebuild and push the branch.",
          turnEndsAt: now + 150_000,
        },
      };
    }

    // 5. working, gemini on the other machine, tier 2
    const s5 = this.add({
      harness: "gemini-cli",
      machine: "studio-mini",
      cwd: "~/charity-site",
      repo: "github.com/acme/charity-site",
      branch: "feat/cancer-type-pages",
      model: "gemini-2.5-pro",
      title: "Cancer type slug pages",
      tier: 2,
    });
    {
      t = now - 25 * min;
      this.push(s5, "session.started", { source: "startup" }, t);
      t = this.pastTurn(
        s5,
        t + 2000,
        "Generate static params for every cancer type slug and add a not-found page.",
        "Added generateStaticParams over the CMS slugs and a not-found.tsx; 28 pages prerender.",
        5,
      );
      const start = now - 50_000;
      s5.turn++;
      this.push(s5, "turn.started", { turn_id: `t_${s5.turn}`, prompt_chars: 72 }, start);
      this.push(
        s5,
        "turn.progress",
        {
          turn: s5.turn,
          user: "The slug lookup throws on unknown slugs; make it return 404 instead.",
          assistant: "",
          at: iso(start),
        },
        start,
      );
      s5.script = {
        kind: "working",
        nextAt: now + 300,
        progressIdx: 0,
        lastProgressAt: now - 8000,
        turnStartedAt: start,
        prompt: "The slug lookup throws on unknown slugs; make it return 404 instead.",
        turnEndsAt: now + rnd(60_000, 100_000),
      };
    }

    // 6. stale: turn started 26 min ago, silent 14 min
    const s6 = this.add({
      harness: "claude-code",
      machine: "studio-mini",
      cwd: "~/brand-kit",
      repo: "github.com/acme/brand-kit",
      branch: "main",
      model: "claude-fable-5-1",
      title: "Brand tokens to CSS",
      tier: 2,
    });
    {
      t = now - 55 * min;
      this.push(s6, "session.started", { source: "startup" }, t);
      t = this.pastTurn(
        s6,
        t + 1000,
        "Export the brand tokens as CSS custom properties with a dark variant.",
        "tokens.css now carries 48 properties in two schemes.",
        4,
      );
      const start = now - 26 * min;
      s6.turn++;
      this.push(s6, "turn.started", { turn_id: `t_${s6.turn}`, prompt_chars: 40 }, start);
      this.push(s6, "tool.started", { tool: "Bash", call_id: "toolu_stale1" }, now - 14 * min);
    }

    // 7. idle, codex
    const s7 = this.add({
      harness: "codex",
      machine: "misha-air",
      cwd: "~/ui-kit",
      repo: "github.com/acme/ui-kit",
      branch: "mp/datatable-density",
      model: "gpt-5-codex",
      title: "DataTable density toggle",
      tier: 1,
    });
    t = now - 70 * min;
    this.push(s7, "session.started", { source: "startup" }, t);
    t = this.pastTurn(s7, t + 1000, "x", "y", 6);
    t = this.pastTurn(s7, now - 9 * min, "x", "y", 3);
    s7.script = { kind: "idle", nextTurnAt: now + rnd(70_000, 140_000) };

    // 8. idle, claude-code, custom title, tier 3
    const s8 = this.add({
      harness: "claude-code",
      machine: "misha-air",
      cwd: "~/doc-extractor",
      repo: "github.com/acme/doc-extractor",
      branch: "main",
      model: "claude-fable-5-1",
      title: "Natives endpoint",
      titleSource: "custom",
      url: "https://claude.ai/code/session_01K6NATIV",
      tier: 3,
    });
    t = now - 3 * 60 * min;
    this.push(s8, "session.started", { source: "resume" }, t);
    t = this.pastTurn(
      s8,
      t + 2000,
      "Add GET /documents/:fileId/natives that streams the original upload.",
      "Streams with a content-disposition header; range requests pass through.",
      7,
    );
    t = this.pastTurn(
      s8,
      now - 62 * min,
      "Add a test for a missing fileId.",
      "Added; returns 404 with the error envelope.",
      3,
    );
    {
      // A handoff from this page: s8 asked Codex for a second opinion (a start signed here
      // with reply_to = s8), the daemon brought the answer back as a framed prompt, and s8
      // answered it. The message itself is in the control activity, `from` and `replyTo` set.
      const askAt = now - 50 * min;
      const question = `Give a second opinion on the reply below. Point out what you'd do differently and why.\n\n---\nAdded; returns 404 with the error envelope.`;
      const sH = this.add({
        harness: "codex",
        machine: "misha-air",
        cwd: "~/doc-extractor",
        repo: "github.com/acme/doc-extractor",
        branch: "main",
        model: "gpt-5-codex",
        title: "Second opinion on the natives test",
        titleSource: "harness",
        tier: 3,
      });
      sH.block.delegated_by = s8.key;
      this.push(
        s8,
        "delegation.started",
        {
          ask_id: "01K8ASK0000000000000MOCK03",
          via: "handoff",
          harness: "codex",
          to: sH.key,
          text: question.slice(0, 200),
        },
        askAt,
      );
      this.push(sH, "session.started", { source: "startup" }, askAt + 3000);
      const reply =
        "One thing: the test asserts the status but not the envelope's `code`. A 404 from the router (no such route) would pass it too. Assert `body.error.code === 'not_found'`, and add the opposite case, a known fileId, so the route is proven to exist.";
      const hEnd = this.pastTurn(
        sH,
        askAt + 4000,
        `${question}\n\n(Sent via misha-air.local:7373 with sessionpipe control, signed on the sender's device.)`,
        reply,
        2,
      );
      this.push(sH, "session.ended", { reason: "exit" }, hEnd + 1000);
      this.push(
        s8,
        "delegation.ended",
        {
          ask_id: "01K8ASK0000000000000MOCK03",
          to: sH.key,
          ok: true,
          ms: hEnd + 1500 - askAt,
          relayed: "delivered",
          reply,
        },
        hEnd + 1500,
      );
      const relayed = answerFrame("codex", sH.id.replace(/-/g, "").slice(0, 8), reply);
      s8.turn++;
      const rt = `t_${s8.turn}`;
      this.push(s8, "turn.started", { turn_id: rt, prompt_chars: relayed.length }, hEnd + 2500);
      this.push(
        s8,
        "turn.progress",
        { turn: s8.turn, user: relayed, assistant: "", at: iso(hEnd + 2500) },
        hEnd + 2500,
      );
      this.push(s8, "turn.ended", { turn_id: rt, reason: "stop", ms: 14_000 }, hEnd + 16_500);
      this.push(
        s8,
        "turn.transcript",
        {
          turn: s8.turn,
          user: relayed,
          assistant:
            "Fair point. The test now asserts `error.code === 'not_found'`, and a second one fetches a known fileId and expects 200.",
          at: iso(hEnd + 16_500),
        },
        hEnd + 17_000,
      );
      this.control.push({
        id: ulid(askAt - 2000),
        machineId: "m_01K6Q3H2A9misha-air",
        kind: "start",
        session: sH.key,
        text: question,
        at: iso(askAt - 2000),
        expiresAt: iso(askAt - 2000 + 3600_000),
        outcome: "delivered",
        mode: "sdk",
        cwd: "/Users/misha/doc-extractor",
        takenAt: iso(askAt - 500),
        ackedAt: iso(askAt + 3500),
        replyTo: s8.key,
        from: s8.key,
      });
    }

    // 9. needs you: question, antigravity, tier 1
    const s9 = this.add({
      harness: "antigravity",
      machine: "studio-mini",
      cwd: "~/playground/seed-scripts",
      model: "gemini-3-pro",
      title: "Seed script for staging",
      tier: 1,
    });
    t = now - 12 * min;
    this.push(s9, "session.started", { source: "startup" }, t);
    s9.turn++;
    this.push(s9, "turn.started", { turn_id: "t_1", prompt_chars: 88 }, t + 500);
    this.push(s9, "tool.started", { tool: "read_file", call_id: "c1" }, t + 2000);
    this.push(s9, "tool.ended", { tool: "read_file", call_id: "c1", ms: 90, ok: true }, t + 2100);
    this.push(
      s9,
      "attention.needed",
      {
        attention_id: "att_q1",
        kind: "question",
        message: "Which database should the seed script target: staging or the local docker one?",
      },
      now - 4 * min,
    );
    s9.script = {
      kind: "attention",
      attentionId: "att_q1",
      clearAt: now + rnd(100_000, 160_000),
      resume: {
        kind: "working",
        nextAt: 0,
        progressIdx: 0,
        lastProgressAt: 0,
        turnStartedAt: t + 500,
        prompt: "Write the seed script.",
        turnEndsAt: now + 200_000,
      },
    };

    // Agents that ask each other. A Claude Code session that asked Codex for a review from
    // inside its turn (sessionpipe ask): once an hour ago, answered (the review folds under
    // its row), and again now, Codex working in a session of its own, delegated_by this one.
    const sA = this.add({
      harness: "claude-code",
      machine: "misha-air",
      cwd: "~/sessionpipe",
      repo: "github.com/spacesheep-dev/sessionpipe",
      branch: "mp/webhook-backoff",
      model: "claude-fable-5-1",
      title: "Webhook retries with backoff",
      url: "https://claude.ai/code/session_01K6ASKCX",
      tier: 3,
    });
    {
      t = now - 66 * min;
      this.push(sA, "session.started", { source: "startup" }, t);
      const askTool = (text: string) => ({
        command: `sessionpipe ask codex "${text}"`,
        description: "Ask Codex to review the diff",
      });
      const question =
        "Review the diff in src/webhooks/send.ts: exponential backoff on webhook retries. Say what you'd do differently.";
      // The first ask, answered: Codex's session came and went an hour ago.
      sA.turn++;
      const turnId = `t_${sA.turn}`;
      const q1 = "Make the webhook sender retry with exponential backoff; ask Codex for a review before you commit.";
      t += 3000;
      this.push(sA, "turn.started", { turn_id: turnId, prompt_chars: q1.length }, t);
      this.push(sA, "turn.progress", { turn: sA.turn, user: q1, assistant: "", at: iso(t) }, t);
      const edit = TOOL_INPUTS.Edit!();
      this.push(sA, "tool.started", { tool: "Edit", call_id: "toolu_bk_edit", turn_id: turnId, input: edit }, t + 4000);
      this.push(
        sA,
        "tool.ended",
        {
          tool: "Edit",
          call_id: "toolu_bk_edit",
          turn_id: turnId,
          ms: 9,
          ok: true,
          input: edit,
          output: TOOL_OUTPUTS.Edit!(),
        },
        t + 4010,
      );
      this.push(sA, "files.changed", { paths: ["src/webhooks/send.ts"] }, t + 4015);
      const askAt = t + 9000;
      const input1 = askTool(question);
      this.push(sA, "tool.started", { tool: "Bash", call_id: "toolu_bk_ask1", turn_id: turnId, input: input1 }, askAt);
      this.push(
        sA,
        "delegation.started",
        { ask_id: "01K8ASK0000000000000MOCK01", via: "ask", harness: "codex", text: question },
        askAt + 400,
      );
      const c1 = this.add({
        harness: "codex",
        machine: "misha-air",
        cwd: "~/sessionpipe",
        repo: "github.com/spacesheep-dev/sessionpipe",
        branch: "mp/webhook-backoff",
        model: "gpt-5-codex",
        title: "Review: backoff on webhook retries",
        titleSource: "harness",
        tier: 3,
      });
      c1.block.delegated_by = sA.key;
      this.push(c1, "session.started", { source: "startup" }, askAt + 2500);
      const c1End = this.pastTurn(c1, askAt + 4000, askFrame(question, sA.key), CODEX_REVIEW, 2);
      this.push(c1, "session.ended", { reason: "exit" }, c1End + 1500);
      const back = c1End + 2000;
      this.push(
        sA,
        "delegation.ended",
        { ask_id: "01K8ASK0000000000000MOCK01", to: c1.key, ok: true, ms: back - askAt, reply: CODEX_REVIEW },
        back,
      );
      this.push(
        sA,
        "tool.ended",
        {
          tool: "Bash",
          call_id: "toolu_bk_ask1",
          turn_id: turnId,
          ms: back - askAt,
          ok: true,
          input: input1,
          output: { stdout: CODEX_REVIEW, stderr: "", interrupted: false, isImage: false, noOutputExpected: false },
        },
        back + 50,
      );
      const a1 =
        "Backoff is in, and Codex reviewed the diff: it wants jitter on the delay so a burst of failures doesn't retry in lockstep, and it caught that the try count was off by one. Both applied. Not committed yet.";
      this.push(sA, "turn.ended", { turn_id: turnId, reason: "stop", ms: back + 20_000 - t }, back + 20_000);
      this.push(
        sA,
        "turn.transcript",
        { turn: sA.turn, user: q1, assistant: a1, at: iso(back + 20_000) },
        back + 21_000,
      );

      // The second ask, running: Codex is at it in a session of its own.
      const start = now - 2 * min;
      sA.turn++;
      const turnId2 = `t_${sA.turn}`;
      const q2 = "Now do the same for the email sender, and have Codex check it too.";
      this.push(sA, "turn.started", { turn_id: turnId2, prompt_chars: q2.length }, start);
      this.push(sA, "turn.progress", { turn: sA.turn, user: q2, assistant: "", at: iso(start) }, start);
      const edit2 = {
        file_path: "src/email/send.ts",
        old_string: "const delay = 30_000;",
        new_string: "const delay = backoff(job.attempt);",
      };
      this.push(
        sA,
        "tool.started",
        { tool: "Edit", call_id: "toolu_bk_edit2", turn_id: turnId2, input: edit2 },
        start + 6000,
      );
      this.push(
        sA,
        "tool.ended",
        {
          tool: "Edit",
          call_id: "toolu_bk_edit2",
          turn_id: turnId2,
          ms: 7,
          ok: true,
          input: edit2,
          output: "The file src/email/send.ts has been updated.",
        },
        start + 6007,
      );
      this.push(sA, "files.changed", { paths: ["src/email/send.ts"] }, start + 6010);
      this.push(
        sA,
        "turn.progress",
        {
          turn: sA.turn,
          user: q2,
          assistant: "Same backoff in the email sender. Asking Codex to look it over.",
          at: iso(start + 8000),
        },
        start + 8000,
      );
      const q2text =
        "Review the diff in src/email/send.ts: the same exponential backoff as the webhook sender. Anything you'd do differently?";
      const ask2At = now - 80_000;
      const input2 = askTool(q2text);
      this.push(
        sA,
        "tool.started",
        { tool: "Bash", call_id: "toolu_bk_ask2", turn_id: turnId2, input: input2 },
        ask2At,
      );
      this.push(
        sA,
        "delegation.started",
        { ask_id: "01K8ASK0000000000000MOCK02", via: "ask", harness: "codex", text: q2text },
        ask2At + 300,
      );
      const c2 = this.add({
        harness: "codex",
        machine: "misha-air",
        cwd: "~/sessionpipe",
        repo: "github.com/spacesheep-dev/sessionpipe",
        branch: "mp/webhook-backoff",
        model: "gpt-5-codex",
        tier: 3,
      });
      c2.block.delegated_by = sA.key;
      this.push(c2, "session.started", { source: "startup" }, ask2At + 2500);
      c2.turn++;
      const prompt2 = askFrame(q2text, sA.key);
      this.push(c2, "turn.started", { turn_id: `t_${c2.turn}`, prompt_chars: prompt2.length }, ask2At + 4000);
      this.push(
        c2,
        "turn.progress",
        { turn: c2.turn, user: prompt2, assistant: "", at: iso(ask2At + 4000) },
        ask2At + 4000,
      );
      this.push(
        c2,
        "tool.started",
        { tool: "shell", call_id: "exec-bk-1", input: { command: ["bash", "-lc", "git diff -- src/email/send.ts"] } },
        ask2At + 7000,
      );
      this.push(
        c2,
        "tool.ended",
        {
          tool: "shell",
          call_id: "exec-bk-1",
          ms: 120,
          ok: true,
          input: { command: ["bash", "-lc", "git diff -- src/email/send.ts"] },
          output: "ok",
        },
        ask2At + 7120,
      );
      c2.script = {
        kind: "working",
        nextAt: now + 1500,
        progressIdx: 0,
        lastProgressAt: now,
        turnStartedAt: ask2At + 4000,
        prompt: prompt2,
        turnEndsAt: now + rnd(60_000, 110_000),
      };
      sA.script = { kind: "none" };
      this.asksOpen.push({
        parent: sA,
        child: c2,
        askId: "01K8ASK0000000000000MOCK02",
        callId: "toolu_bk_ask2",
        turnId: turnId2,
        input: input2,
        prompt: q2,
        startedAt: ask2At,
        turnStartedAt: start,
      });
    }

    // 10. done: ended cleanly 3 h ago
    const s10 = this.add({
      harness: "claude-code",
      machine: "misha-air",
      cwd: "~/sessionpipe",
      repo: "github.com/spacesheep-dev/sessionpipe",
      branch: "mp/flaky-worker-test",
      model: "claude-fable-5-1",
      title: "Fix flaky worker test",
      tier: 2,
    });
    t = now - 200 * min;
    this.push(s10, "session.started", { source: "startup" }, t);
    t = this.pastTurn(
      s10,
      t + 1000,
      "worker.test.ts fails one run in five on CI; find out why.",
      "The test raced the detached worker's exit; it now waits on the job file's rename.",
      8,
    );
    this.push(s10, "session.ended", { reason: "exit" }, now - 180 * min);

    // 11. done: backfill only, two days ago
    const s11 = this.add({
      harness: "codex",
      machine: "studio-mini",
      cwd: "~/marketing-site",
      repo: "github.com/acme/marketing-site",
      branch: "main",
      model: "gpt-5-codex",
      title: "Migrate hero component to CloudCannon editable regions",
      titleSource: "first-ask",
      tier: 1,
    });
    this.push(
      s11,
      "session.backfill",
      { started_at: iso(now - 2 * 86_400_000 - 40 * min), last_at: iso(now - 2 * 86_400_000), turns: 7 },
      now - 2 * 86_400_000,
    );

    // 12. done: ended on a turn error
    const s12 = this.add({
      harness: "gemini-cli",
      machine: "misha-air",
      cwd: "~/ibs-workflow-ads",
      model: "gemini-2.5-flash",
      title: "Ad copy variants",
      tier: 1,
    });
    t = now - 9 * 60 * min;
    this.push(s12, "session.started", { source: "startup" }, t);
    s12.turn++;
    this.push(s12, "turn.started", { turn_id: "t_1", prompt_chars: 120 }, t + 500);
    this.push(s12, "tool.started", { tool: "run_shell_command", call_id: "g1" }, t + 3000);
    this.push(
      s12,
      "tool.ended",
      { tool: "run_shell_command", call_id: "g1", ms: 12000, ok: false, error: "exit 137" },
      t + 15_000,
    );
    this.push(s12, "turn.ended", { turn_id: "t_1", reason: "error", error: "rate_limit", ms: 16_000 }, t + 16_500);
    this.push(s12, "session.ended", { reason: "exit" }, t + 20_000);
  }
}

const HOOK_NAMES: Record<string, Record<string, string>> = {
  "claude-code": {
    "session.started": "SessionStart",
    "session.ended": "SessionEnd",
    "turn.started": "UserPromptSubmit",
    "turn.ended": "Stop",
    "tool.started": "PreToolUse",
    "tool.ended": "PostToolUse",
    "attention.needed": "PermissionRequest",
    "subagent.started": "SubagentStart",
    "subagent.ended": "SubagentStop",
    "context.compacted": "PreCompact",
  },
  codex: {
    "session.started": "SessionStart",
    "tool.started": "PreToolUse",
    "tool.ended": "PostToolUse",
    "turn.ended": "Stop",
  },
  "gemini-cli": {
    "session.started": "SessionStart",
    "tool.started": "BeforeTool",
    "tool.ended": "AfterTool",
    "turn.ended": "AfterAgent",
  },
  antigravity: { "session.started": "PreInvocation", "tool.ended": "PostToolUse", "turn.ended": "Stop" },
};
