// SPDX-License-Identifier: Apache-2.0
// Owned by: demo. The simulation: a small team's agents on a virtual clock. Every
// session is a generator that yields how long to wait (virtual ms) between the events
// it emits; `advance(to)` runs whatever is due and hands back the events in order. The
// runner in index.ts maps virtual time onto the wall clock; the tests drive it directly.
// Every event is a tier-3 sessionpipe event exactly as the client would send it:
// the harness's own hook names, a session block that grows as the worker learns facts,
// seq monotonic per session, ids in each harness's shape.
import { createHash } from "node:crypto";
import { ulid } from "sessionpipe-core";
import type { ProtocolEvent, ProtocolSession } from "../../shared/api.js";
import {
  ANTIGRAVITY_TURNS,
  ASK_TURN,
  type AskScript,
  BACKFILL_TITLES,
  BACKGROUND_TURNS,
  CLAUDE_TURNS,
  CODEX_TURNS,
  CURSOR_TURNS,
  GEMINI_TURNS,
  HANDOFF,
  HANDOFF_PARENT_TURN,
  HARNESS_VERSION,
  type HandoffScript,
  type HarnessName,
  MACHINE_NAMES,
  MODELS,
  PARALLEL_TURN,
  REPOS,
  RESUME_TURN,
  type Repo,
  SCHEDULED_TURNS,
  SILENT_TURN,
  type SubagentScript,
  type TurnScript,
  UNATTENDED_TURN,
  V010_MACHINE,
} from "./content.js";
import { Rng } from "./rng.js";

export interface SimOptions {
  machines?: number;
  seed?: number;
  /** Wall-clock ms that virtual 0 maps to. */
  startAt?: number;
  /** Virtual ms per wall ms: the event times are startAt + virtual / speed. */
  speed?: number;
  /** A session the demo says was started from this receiver (server/demo/machine.ts makes
   *  its `start`), told when its first event goes out. */
  onStart?: (s: DemoStarted) => void;
}

/** A demo session started through control: what its `start` carried. */
export interface DemoStarted {
  harness: HarnessName;
  id: string;
  machine: string;
  cwd: string;
  text: string;
  at: number;
  /** A handoff: the session the answer comes back into (`reply_to`), which also sent it. */
  replyTo?: string;
  from?: string;
}

/** The account id sessionpipe 0.10 gives a Claude Code home on another API (#75):
 *  `api-` and 16 hex of the endpoint's hash; the demo's names api.z.ai. */
export const DEMO_API_ACCOUNT = "api-3f9c1e0b7d2a4c68";

/** The accounts the demo's pools name besides lab-mac's own login (DESIGN §3, UX-SPEC §13):
 *  fixed ids, never drawn from the cast's stream, so the cast plays as it always did. The
 *  own login (dev@example.com, `account(lab, "claude-code")`) is "Misha" in the pool. */
export const DEMO_POOL = {
  fiction: { id: "7c2a9e41-3b6d-4f08-9a5e-1d4c8b2f6e03", email: "fiction@example.com", label: "Fiction" },
  spacesheep: { id: "e19b4d07-6a3c-4e52-8f71-0c9d5b3a2e84", email: "spacesheep@example.com", label: "Spacesheep" },
  work: { id: "4d8f1c23-9e6b-4a07-b5d2-7f3e0a1c9b46", email: "work@example.com", label: "Work" },
  old: { id: "b3e7a052-1f4c-4d9e-a86b-5c2d9f0e7a13", email: "old@example.com", label: "Old" },
} as const;
/** When Spacesheep's 5-hour window has room again, from the demo's start (its `until`). */
export const DEMO_POOL_UNTIL_MS = 2 * 3_600_000 + 10 * 60_000;

type Script = Generator<number, void, undefined>;
interface Actor {
  at: number;
  order: number;
  gen: Script;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const PROGRESS_EVERY_MS = 20_000;
const TITLE_RANK = { "first-ask": 0, harness: 1, custom: 2 } as const;
/** The curated opening scenes get this long before random sessions join in. */
const OPENING_MS = 150_000;

/** What the daemon calls the receiver in a handoff's frame (`asked via <host>`). */
const RECEIVER_HOST = "studio-mac.local:7373";

/** A session's short id as sessionpipe-core prints it (`short-id.ts`): eight hex of a hash
 *  of its ref, so the frame names the session without quoting a 36-character id. */
const shortId = (harness: string, id: string): string =>
  createHash("sha256").update(`sessionpipe.session:${harness}:${id}`).digest("hex").slice(0, 8);

/** The daemon's framing of the question it hands an asked agent (control/route.ts). */
const askFrame = (text: string, from: string): string =>
  `${text}\n\n(Asked by ${from} on this machine with sessionpipe ask. Answer here in full: your reply is returned to that session automatically. Don't run a command or call a tool just to send it.)`;
/** A `start`'s first message as the daemon frames it (control/route.ts). */
const startFrame = (text: string): string =>
  `${text}\n\n(Sent via ${RECEIVER_HOST} with sessionpipe control, signed on the sender's device.)`;
/** The relayed answer as the daemon delivers it into `reply_to` (CONTROL.md §6). */
const answerFrame = (harness: string, id: string, reply: string): string =>
  `Answer from ${harness}:${shortId(harness, id)} (sessionpipe handoff, asked via ${RECEIVER_HOST}):\n\n${reply}`;

type HookKey =
  | "start"
  | "prompt"
  | "preTool"
  | "postTool"
  | "postToolFail"
  | "permission"
  | "stop"
  | "stopFail"
  | "subStart"
  | "subStop"
  | "compact"
  | "end";

/** How one harness names its hooks and shapes its ids (ADAPTERS.md). */
interface Profile {
  name: HarnessName;
  ev: Record<HookKey, string>;
  callId?: (rng: Rng) => string;
  turnId?: (rng: Rng, wall: number) => string;
  /** Absent: the harness raises no attention here (Cursor's mapping is not recorded yet). */
  attentionId?: (rng: Rng, wall: number) => string;
  /** Emits turn.progress (optional for senders; the Claude Code client does). */
  progress: boolean;
  /** Knows the model at session start (the Codex, Antigravity and Cursor payloads carry it). */
  modelAtStart: boolean;
  /** No session-end hook exists: the session goes silent after its last Stop and the
   *  receiver infers done (PROTOCOL.md §4). */
  noSessionEnd?: boolean;
  /** Every turn opens with the hook that also announces the session (Antigravity's
   *  PreInvocation with invocationNum 0): session.started { source: unknown } right
   *  before each turn.started, the git facts and first ask already read. */
  startsEveryTurn?: boolean;
  /** No pre-tool hook: a tool is a tool.ended alone (no call_id, ms or output), a
   *  post-tool payload that names no tool is a session.heartbeat, and so is the hook
   *  before every later model call (`heartbeat` is its name). */
  toolsEndedOnly?: boolean;
  heartbeat?: string;
  /** turn.started / turn.ended carry no turn_id, prompt_chars or ms: the hook has none. */
  bareTurns?: boolean;
  /** The hook that reports an edit as files.changed (Cursor's afterFileEdit); otherwise
   *  the post-tool hook stands for it. */
  filesChangedEvent?: string;
  /** A subagent runs inside the parent's session, its tools stamped with `agent_id` and
   *  the spawning turn's `turn_id` (Claude Code, as recorded). Otherwise it runs as a
   *  child session with `parent_id` (the spec's other shape; Cursor here). */
  agentsInParent?: boolean;
}

const PROFILES: Record<HarnessName, Profile> = {
  "claude-code": {
    name: "claude-code",
    ev: {
      start: "SessionStart",
      prompt: "UserPromptSubmit",
      preTool: "PreToolUse",
      postTool: "PostToolUse",
      postToolFail: "PostToolUseFailure",
      permission: "PermissionRequest",
      stop: "Stop",
      stopFail: "StopFailure",
      subStart: "SubagentStart",
      subStop: "SubagentStop",
      compact: "PreCompact",
      end: "SessionEnd",
    },
    callId: (r) => r.toolu(),
    turnId: (r) => r.uuid(),
    attentionId: (r) => r.perm(),
    progress: true,
    modelAtStart: false,
    agentsInParent: true,
  },
  codex: {
    name: "codex",
    ev: {
      start: "SessionStart",
      prompt: "UserPromptSubmit",
      preTool: "PreToolUse",
      postTool: "PostToolUse",
      postToolFail: "PostToolUse",
      permission: "PermissionRequest",
      stop: "Stop",
      stopFail: "Stop",
      subStart: "SubagentStart",
      subStop: "SubagentStop",
      compact: "PreCompact",
      end: "SessionEnd",
    },
    callId: (r) => `exec-${r.uuid()}`,
    turnId: (r, wall) => r.uuid7(wall),
    attentionId: (r) => `exec-${r.uuid()}`,
    progress: false,
    modelAtStart: true,
  },
  "gemini-cli": {
    name: "gemini-cli",
    ev: {
      start: "SessionStart",
      prompt: "BeforeAgent",
      preTool: "BeforeTool",
      postTool: "AfterTool",
      postToolFail: "AfterTool",
      permission: "Notification",
      stop: "AfterAgent",
      stopFail: "AfterAgent",
      subStart: "",
      subStop: "",
      compact: "PreCompress",
      end: "SessionEnd",
    },
    attentionId: (_r, wall) => `notif-${wall}`,
    progress: false,
    modelAtStart: false,
  },
  antigravity: {
    name: "antigravity",
    // The hook name rides in argv, not stdin; `harness.event` carries it. There is no
    // PreToolUse (its answer would deny) and no session end.
    ev: {
      start: "PreInvocation",
      prompt: "PreInvocation",
      preTool: "",
      postTool: "PostToolUse",
      postToolFail: "PostToolUse",
      permission: "",
      stop: "Stop",
      stopFail: "Stop",
      subStart: "",
      subStop: "",
      compact: "",
      end: "",
    },
    progress: false,
    modelAtStart: true,
    noSessionEnd: true,
    startsEveryTurn: true,
    toolsEndedOnly: true,
    heartbeat: "PreInvocation",
    bareTurns: true,
  },
  cursor: {
    name: "cursor",
    ev: {
      start: "sessionStart",
      prompt: "beforeSubmitPrompt",
      preTool: "preToolUse",
      postTool: "postToolUse",
      postToolFail: "postToolUseFailure",
      permission: "",
      stop: "stop",
      stopFail: "stop",
      subStart: "subagentStart",
      subStop: "subagentStop",
      compact: "preCompact",
      end: "sessionEnd",
    },
    callId: (r) => r.uuid(),
    // turn_id is the generation_id.
    turnId: (r) => r.uuid(),
    progress: false,
    modelAtStart: true,
    filesChangedEvent: "afterFileEdit",
  },
};

/** The scripts and repos each harness draws from once the opening scenes are over. */
const POOL: Record<HarnessName, { turns: readonly TurnScript[]; repos: number[] }> = {
  "claude-code": { turns: CLAUDE_TURNS, repos: [0, 3, 4, 5] },
  codex: { turns: CODEX_TURNS, repos: [1, 5] },
  "gemini-cli": { turns: GEMINI_TURNS, repos: [2] },
  antigravity: { turns: ANTIGRAVITY_TURNS, repos: [6] },
  cursor: { turns: CURSOR_TURNS, repos: [7] },
};

type Block = Omit<ProtocolSession, "id" | "seq">;

const prune = (o: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
};

/** An Agent / Task call's `input.description`, when it has one. */
const describe = (input: unknown): string | undefined => {
  const d = (input as { description?: unknown } | null)?.description;
  return typeof d === "string" && d ? d : undefined;
};

/** The first line of a prompt, cut the way the harness readers cut a first-ask title. */
export function firstAsk(prompt: string, max = 50): string {
  const line =
    prompt
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max).replace(/\s+\S*$/, "")}…` : line;
}

/** One session as the sender knows it: its seq counter and the facts learned so far. */
export class Sess {
  seq: number;
  readonly block: Block;
  /** Background subagents still running, and the ones that finished and wait for the
   *  orchestrator's `<task-notification>` turn. */
  agentsOpen = 0;
  readonly notices: { agentId: string; callId?: string; description?: string; sub: SubagentScript }[] = [];
  constructor(
    readonly sim: Simulation,
    readonly profile: Profile,
    readonly id: string,
    block: Block,
    seq = 0,
  ) {
    this.block = { ...block };
    this.seq = seq;
  }
  /** Adds facts as the worker learns them. A title never replaces one from a better
   *  source (custom > harness > first-ask), as the harness readers rank them. */
  learn(fields: Partial<Block>): void {
    const { title, title_source, ...rest } = fields;
    Object.assign(this.block, prune(rest as Record<string, unknown>));
    if (title && title_source && TITLE_RANK[title_source] >= TITLE_RANK[this.block.title_source ?? "first-ask"]) {
      this.block.title = title;
      this.block.title_source = title_source;
    }
  }
  /** `at`: a wall-clock time other than now (an earlier session's, limitsScene). */
  emit(type: string, data: Record<string, unknown>, event: string, version = true, at?: number): ProtocolEvent {
    const harness: ProtocolEvent["harness"] = { name: this.profile.name };
    if (version) harness.version = HARNESS_VERSION[this.profile.name];
    if (event) harness.event = event;
    return this.sim.emit(type, harness, { id: this.id, seq: this.seq++, ...this.block }, prune(data), at);
  }
}

export class Simulation {
  /** Virtual ms since start. */
  now = 0;
  readonly rng: Rng;
  readonly machines: string[];
  /** Where sessionpipe 0.10's scenes run: their own machine, or the only one when asked for one. */
  readonly v010Machine: string;
  readonly startAt: number;
  readonly speed: number;
  /** Sessions that are running right now (the director keeps the board from overflowing). */
  live = 0;
  private actors: Actor[] = [];
  private out: ProtocolEvent[] = [];
  private order = 0;
  private accounts = new Map<string, string>();
  private ended: Sess[] = [];
  private readonly onStart?: (s: DemoStarted) => void;
  /** The ids of limitsScene's earlier sessions: a stream of its own, so the cast draws
   *  what it always drew. */
  private readonly sideRng: Rng;
  private readonly seed: number;
  /** lab-mac's 5-hour window (limitsScene): used, when it resets, replies since it moved. */
  private fiveHour = { used: 38, resetsAt: 0, replies: 0, bumps: 0 };

  constructor(opts: SimOptions = {}) {
    this.onStart = opts.onStart;
    this.seed = opts.seed ?? 20261014;
    this.rng = new Rng(this.seed);
    this.sideRng = new Rng(this.seed + 1);
    const n = Math.min(MACHINE_NAMES.length, Math.max(1, Math.floor(opts.machines ?? 2)));
    this.machines = MACHINE_NAMES.slice(0, n);
    this.v010Machine = n === 1 ? (this.machines[0] as string) : V010_MACHINE;
    this.startAt = opts.startAt ?? Date.now();
    this.speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
    this.spawn(this.director());
  }

  /** Wall-clock ms of a virtual instant. */
  wall(v = this.now): number {
    return Math.round(this.startAt + v / this.speed);
  }

  spawn(gen: Script, delay = 0): void {
    this.actors.push({ at: this.now + delay, order: this.order++, gen });
  }

  /** The virtual time of the next event, or null when nothing is scheduled. */
  nextDue(): number | null {
    let min: number | null = null;
    for (const a of this.actors) if (min === null || a.at < min) min = a.at;
    return min;
  }

  /** Run everything due up to `to` (virtual ms) and return the events, in emit order. */
  advance(to: number): ProtocolEvent[] {
    for (;;) {
      let next: Actor | undefined;
      for (const a of this.actors)
        if (a.at <= to && (!next || a.at < next.at || (a.at === next.at && a.order < next.order))) next = a;
      if (!next) break;
      this.now = Math.max(this.now, next.at);
      const r = next.gen.next();
      if (r.done) this.actors = this.actors.filter((a) => a !== next);
      else next.at = this.now + Math.max(0, r.value);
    }
    this.now = Math.max(this.now, to);
    const out = this.out;
    this.out = [];
    return out;
  }

  emit(
    type: string,
    harness: ProtocolEvent["harness"],
    session: ProtocolSession,
    data: Record<string, unknown>,
    at = this.wall(),
  ): ProtocolEvent {
    const e: ProtocolEvent = {
      protocol: 1,
      id: ulid(at),
      type,
      time: new Date(at).toISOString(),
      tier: 3,
      harness,
      session,
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
    this.out.push(e);
    return e;
  }

  /** An opaque, stable account id per machine and harness (never an email). */
  account(machine: string, harness: HarnessName): string {
    const k = `${machine}/${harness}`;
    let id = this.accounts.get(k);
    if (!id) {
      id = this.rng.uuid();
      this.accounts.set(k, id);
    }
    return id;
  }

  newSessionId(harness: HarnessName): string {
    return harness === "codex" ? this.rng.uuid7(this.wall()) : this.rng.uuid();
  }

  // ---------- the cast ----------

  private *director(): Script {
    const rng = this.rng;
    const m = (i: number) => this.machines[i % this.machines.length] as string;
    const resumable = this.backfill();

    // The showcase: one Claude Code session that plays every scenario, and keeps coming back.
    const showcase = () =>
      this.session({
        harness: "claude-code",
        machine: m(0),
        repo: REPOS[0] as Repo,
        branch: "fix/webhook-retry",
        turns: [...CLAUDE_TURNS],
        source: "startup",
        end: "exit",
        pause: 20_000,
      });
    this.spawn(showcase());
    this.spawn(
      this.session({
        harness: "codex",
        machine: m(1),
        repo: REPOS[1] as Repo,
        branch: "chore/pnpm-cache",
        turns: CODEX_TURNS.slice(0, 2),
        source: "startup",
        end: "exit",
      }),
      15_000,
    );
    this.spawn(
      this.session({
        harness: "claude-code",
        machine: m(1),
        repo: REPOS[3] as Repo,
        branch: "feat/offline-cart",
        turns: [SILENT_TURN],
        source: "startup",
        end: "exit",
      }),
      20_000,
    );
    this.spawn(
      this.session({
        harness: "gemini-cli",
        machine: m(0),
        repo: REPOS[2] as Repo,
        branch: "main",
        turns: GEMINI_TURNS.slice(0, 2),
        source: "startup",
        end: "exit",
      }),
      40_000,
    );
    // Antigravity in its IDE workspace: no session end, so after its last Stop the board
    // reads done from silence. Cursor's edits arrive as files.changed from afterFileEdit.
    this.spawn(
      this.session({
        harness: "antigravity",
        machine: m(1),
        repo: REPOS[6] as Repo,
        branch: "feat/tokens-v2",
        turns: [...ANTIGRAVITY_TURNS],
        source: "startup",
        end: "other",
      }),
      30_000,
    );
    this.spawn(
      this.session({
        harness: "cursor",
        machine: m(0),
        repo: REPOS[7] as Repo,
        branch: "fix/digest-dedupe",
        turns: [...CURSOR_TURNS],
        source: "startup",
        end: "exit",
      }),
      55_000,
    );
    this.spawn(
      this.session({
        harness: "claude-code",
        machine: resumable.block.machine as string,
        repo: REPOS[4] as Repo,
        branch: "main",
        turns: [RESUME_TURN, CLAUDE_TURNS[7] as TurnScript],
        source: "resume",
        end: "exit",
        resume: resumable,
      }),
      90_000,
    );

    // sessionpipe 0.10 on its own machine: a run started from here that waits on its own
    // background work, a turn the harness's schedule submitted, and a script's unattended
    // one-shot on a Claude Code home that runs on another API.
    const waiting = () =>
      this.session({
        harness: "claude-code",
        machine: this.v010Machine,
        repo: REPOS[0] as Repo,
        branch: "main",
        turns: BACKGROUND_TURNS,
        source: "startup",
        end: "exit",
        attended: true,
        viaControl: true,
      });
    const scheduled = () =>
      this.session({
        harness: "claude-code",
        machine: this.v010Machine,
        repo: REPOS[0] as Repo,
        branch: "main",
        turns: SCHEDULED_TURNS,
        source: "startup",
        end: "exit",
        attended: true,
      });
    this.spawn(waiting(), 25_000);
    this.spawn(scheduled(), 35_000);
    const unattended = () =>
      this.session({
        harness: "claude-code",
        machine: this.v010Machine,
        repo: REPOS[0] as Repo,
        branch: "main",
        turns: [UNATTENDED_TURN],
        source: "startup",
        end: "exit",
        attended: false,
        account: DEMO_API_ACCOUNT,
        pause: 1500,
      });
    this.spawn(unattended(), 5_000);

    // Agents that ask each other, on the paired machine: a Claude Code session that asks
    // Codex for a review from inside its turn (sessionpipe ask), and one that a handoff
    // from here asks Codex about, the answer coming back into it as a message.
    const asking = () =>
      this.session({
        harness: "claude-code",
        machine: this.v010Machine,
        repo: REPOS[0] as Repo,
        branch: "fix/webhook-retry",
        turns: [ASK_TURN],
        source: "startup",
        end: "exit",
        attended: true,
        pause: 240_000,
      });
    const handed = () =>
      this.session({
        harness: "claude-code",
        machine: this.v010Machine,
        repo: REPOS[0] as Repo,
        branch: "fix/webhook-retry",
        turns: [HANDOFF_PARENT_TURN],
        source: "startup",
        end: "exit",
        attended: true,
        viaControl: true,
        handoff: HANDOFF,
        pause: 20_000,
      });
    this.spawn(asking(), 12_000);
    this.spawn(handed(), 45_000);

    // Three reviewers at once, two of them outliving the turn that launched them.
    const parallel = () =>
      this.session({
        harness: "claude-code",
        machine: m(1),
        repo: REPOS[4] as Repo,
        branch: "perf/bm25-cache",
        turns: [PARALLEL_TURN],
        source: "startup",
        end: "exit",
      });
    this.spawn(parallel(), 10_000);
    this.spawn(this.limitsScene());
    this.spawn(this.poolScene(), 45_000);

    let lastShowcase = this.now;
    yield OPENING_MS;
    for (;;) {
      yield rng.int(45_000, 120_000);
      if (this.now - lastShowcase > 7 * 60_000) {
        lastShowcase = this.now;
        this.spawn(showcase());
        this.spawn(parallel(), 30_000);
        this.spawn(unattended(), 50_000);
        this.spawn(waiting(), 20_000);
        this.spawn(scheduled(), 40_000);
        this.spawn(asking(), 60_000);
        this.spawn(handed(), 100_000);
        continue;
      }
      if (this.live >= 6) continue;
      const harness: HarnessName = rng.pick([
        "claude-code",
        "claude-code",
        "claude-code",
        "codex",
        "gemini-cli",
        "antigravity",
        "cursor",
      ]);
      const pool = POOL[harness].turns;
      const repo = REPOS[rng.pick(POOL[harness].repos)] as Repo;
      const from = rng.int(0, pool.length - 1);
      const n = rng.int(1, Math.min(3, pool.length));
      const turns = Array.from({ length: n }, (_, i) => pool[(from + i) % pool.length] as TurnScript);
      const prior = this.ended.filter((s) => s.profile.name === harness);
      const resume = prior.length && rng.chance(0.2) ? (rng.pick(prior) as Sess) : undefined;
      this.spawn(
        this.session({
          harness,
          machine: resume ? (resume.block.machine as string) : rng.pick(this.machines),
          repo,
          branch: rng.pick(repo.branches),
          turns,
          source: resume ? "resume" : "startup",
          end: rng.chance(0.8) ? "exit" : rng.chance(0.5) ? "other" : "clear",
          resume,
        }),
      );
    }
  }

  /** ~15 historical sessions over the last 30 days, oldest first; returns one a later
   *  session resumes. */
  private backfill(): Sess {
    const rng = this.rng;
    const items: { sess: Sess; startedAt: number; lastAt: number; turns: number }[] = [];
    const count = BACKFILL_TITLES.length - 1;
    for (let i = 0; i < count; i++) {
      // Antigravity keeps transcripts under its brain dir, so it backfills too; Cursor has no reader yet.
      const harness: HarnessName =
        i % 5 === 3 ? "codex" : i % 7 === 6 ? "gemini-cli" : i % 11 === 10 ? "antigravity" : "claude-code";
      const title = BACKFILL_TITLES[i] as (typeof BACKFILL_TITLES)[number];
      const repo = (i === 0 ? REPOS[4] : rng.pick(REPOS)) as Repo;
      const machine = rng.pick(this.machines);
      const startedAt = this.wall() - Math.round(((i + 0.5 + rng.next() * 0.8) / count) * 30 * DAY);
      const lastAt = startedAt + rng.int(5, 180) * 60_000;
      const sess = new Sess(this, PROFILES[harness], this.newSessionId(harness), {
        machine,
        cwd: repo.cwd,
        repo: repo.repo,
        branch: rng.pick(repo.branches),
        model: rng.pick(MODELS[harness]),
        title: title.text,
        title_source: title.source,
        account_id: this.account(machine, harness),
      });
      items.push({ sess, startedAt, lastAt, turns: rng.int(1, 40) });
    }
    items.sort((a, b) => a.lastAt - b.lastAt);
    for (const it of items) {
      const data = {
        started_at: new Date(it.startedAt).toISOString(),
        last_at: new Date(it.lastAt).toISOString(),
        turns: it.turns,
      };
      this.emit(
        "session.backfill",
        { name: it.sess.profile.name, event: "backfill" },
        { id: it.sess.id, seq: it.sess.seq++, ...it.sess.block },
        data,
        it.lastAt,
      );
    }
    const resumable =
      items.find((it) => it.sess.block.title === BACKFILL_TITLES[0]?.text) ?? (items[0] as (typeof items)[number]);
    return resumable.sess;
  }

  private *session(p: {
    harness: HarnessName;
    machine: string;
    repo: Repo;
    branch: string;
    turns: readonly TurnScript[];
    source: "startup" | "resume";
    end: "exit" | "other" | "clear";
    pause?: number;
    resume?: Sess;
    /** sessionpipe 0.10 `session.attended`; absent, the harness doesn't say. */
    attended?: boolean;
    /** Another account id than the machine's (a home on another API). */
    account?: string;
    /** Started from this receiver: the demo machine has its `start` (onStart). */
    viaControl?: boolean;
    /** After its turns, a handoff from here asks another agent and its answer comes back
     *  into this session (CONTROL.md §3.1 `reply_to`). */
    handoff?: HandoffScript;
  }): Script {
    const rng = this.rng;
    const profile = PROFILES[p.harness];
    const sess =
      p.resume ??
      new Sess(this, profile, this.newSessionId(p.harness), {
        machine: p.machine,
        cwd: p.repo.cwd,
        account_id: p.account ?? this.account(p.machine, p.harness),
        ...(p.attended !== undefined ? { attended: p.attended } : {}),
        ...(profile.modelAtStart ? { model: rng.pick(MODELS[p.harness]) } : {}),
      });
    if (p.viaControl && this.onStart)
      this.onStart({
        harness: p.harness,
        id: sess.id,
        machine: p.machine,
        cwd: p.repo.cwd,
        text: (p.turns[0] as TurnScript).prompt,
        at: this.wall(),
      });
    this.live++;
    const facts = (script: TurnScript) =>
      sess.learn({ repo: p.repo.repo, branch: p.branch, title: firstAsk(script.prompt), title_source: "first-ask" });
    if (profile.startsEveryTurn) {
      // One hook announces the session and the turn (playTurn emits both); the worker
      // has read the git facts and the first ask from the transcript by then.
      if (!p.resume) facts(p.turns[0] as TurnScript);
    } else {
      sess.emit("session.started", { source: p.source }, profile.ev.start);
      yield rng.ms(8000, 2000);
    }
    let turn = p.resume ? rng.int(3, 12) : 0;
    for (const [i, script] of p.turns.entries()) {
      // The worker reads git facts and the first ask between the start hook and the first prompt.
      if (i === 0 && !p.resume && !profile.startsEveryTurn) facts(script);
      yield* this.playTurn(sess, script, turn++);
      if (script.abandon) {
        this.live--;
        return;
      }
      // Background agents report back, each in a turn of its own, before the next prompt.
      while (sess.agentsOpen > 0 || sess.notices.length) {
        const n = sess.notices.shift();
        if (!n) {
          yield 2000;
          continue;
        }
        yield rng.ms(1500, 400);
        yield* this.notificationTurn(sess, n, turn++);
      }
      yield script.waitAfter ?? p.pause ?? rng.ms(30_000, 5000);
    }
    if (p.handoff) {
      yield* this.handoff(sess, p.handoff, turn++);
      yield p.pause ?? rng.ms(30_000, 5000);
    }
    // No session-end hook: the session just goes quiet after its last Stop.
    if (!profile.noSessionEnd) sess.emit("session.ended", { reason: p.end }, profile.ev.end);
    this.live--;
    this.ended.push(sess);
  }

  private *playTurn(sess: Sess, script: TurnScript, turn: number): Script {
    const rng = this.rng;
    const profile = sess.profile;
    const ev = profile.ev;
    const turnId = profile.turnId?.(rng, this.wall());
    const user = script.prompt;
    const startedAt = this.now;
    let said = "";
    let lastProgress = -Infinity;
    const progress = (event: string) => {
      sess.emit("turn.progress", { turn, user, assistant: said, at: new Date(this.wall()).toISOString() }, event);
      lastProgress = this.now;
    };

    // Antigravity: the first PreInvocation of an execution is the session and the turn at once.
    if (profile.startsEveryTurn) sess.emit("session.started", { source: "unknown" }, ev.start);
    sess.emit(
      "turn.started",
      profile.bareTurns
        ? {}
        : {
            turn_id: turnId,
            prompt_chars: [...user].length,
            submitted_by: script.submittedBy,
            injected: script.injected || undefined,
          },
      ev.prompt,
    );
    if (profile.progress) progress(ev.prompt);
    yield rng.ms(4000, 800);

    for (const [i, step] of script.steps.entries()) {
      // Antigravity: a model call precedes every tool but the first; its hook is a heartbeat.
      if (profile.toolsEndedOnly && i > 0 && profile.heartbeat) {
        sess.emit("session.heartbeat", {}, profile.heartbeat);
        yield rng.ms(2500, 600);
      }
      if (step.permission && profile.attentionId) {
        const attentionId = profile.attentionId(rng, this.wall());
        sess.emit(
          "attention.needed",
          {
            attention_id: attentionId,
            kind: "permission",
            tool: step.tool,
            message: `${step.tool} ${step.permission}`.slice(0, 200),
          },
          ev.permission,
        );
        yield rng.int(32_000, 48_000);
        sess.emit("attention.cleared", { attention_id: attentionId, how: "answered" }, ev.preTool);
      }
      const callId = profile.callId?.(rng);
      if (!profile.toolsEndedOnly)
        sess.emit("tool.started", { tool: step.tool, call_id: callId, turn_id: turnId, input: step.input }, ev.preTool);
      const ok = step.ok ?? true;
      let output = step.output;
      const sub = step.subagent;
      const agentId = sub ? rng.agent() : undefined;
      const background = !!sub && (output as { isAsync?: unknown } | undefined)?.isAsync === true;
      const inParent = !!sub && !!profile.agentsInParent;
      let tookMs = step.ms;
      if (sub && agentId && inParent && !background) {
        // A synchronous agent: it runs while the call is open, and its last message is
        // the call's output.
        yield* this.agentInParent(sess, sub, agentId, turnId);
        output = { status: "completed", agentId, content: [{ type: "text", text: sub.result ?? "" }] };
      } else if (step.ask) {
        // `sessionpipe ask`: the daemon runs the asked agent while the call is open, and
        // the answer is the command's stdout.
        const begun = this.now;
        const reply = yield* this.asked(sess, step.ask);
        tookMs = this.now - begun;
        output = { stdout: reply, stderr: "", interrupted: false, isImage: false, noOutputExpected: false };
      } else {
        yield step.ms;
        if (sub && agentId)
          output = typeof output === "string" ? `${output}\nagentId: ${agentId}` : { ...(output as object), agentId };
      }
      const postEvent = ok ? ev.postTool : ev.postToolFail;
      if (profile.toolsEndedOnly) {
        // Antigravity's PostToolUse: stepIdx and error, and the tool call when it names one.
        if (step.unnamed) sess.emit("session.heartbeat", {}, postEvent);
        else
          sess.emit(
            "tool.ended",
            { tool: step.tool, ok, error: ok ? undefined : step.error, input: step.input },
            postEvent,
          );
      } else
        sess.emit(
          "tool.ended",
          {
            tool: step.tool,
            call_id: callId,
            turn_id: turnId,
            ms: tookMs,
            ok,
            error: ok ? undefined : step.error,
            input: step.input,
            output: output === undefined ? null : output,
          },
          postEvent,
        );
      if (step.paths) sess.emit("files.changed", { paths: step.paths }, profile.filesChangedEvent ?? postEvent);
      if (i === 0 && !sess.block.model) {
        sess.learn({ model: rng.pick(MODELS[profile.name]) });
        if (profile.name === "claude-code") sess.learn({ url: `https://claude.ai/code/session_01${rng.base62(22)}` });
      }
      if (i === 1 && script.title) sess.learn({ title: script.title.text, title_source: script.title.source });
      if (step.say && step.say !== said) {
        said = step.say;
        if (profile.progress && this.now - lastProgress >= PROGRESS_EVERY_MS)
          progress(ok ? ev.postTool : ev.postToolFail);
      }
      if (sub && agentId && !inParent) yield* this.subagent(sess, sub, agentId);
      // A background agent: SubagentStart right after the call returned, then it works
      // on its own clock while the orchestrator's turn goes on and ends.
      if (sub && agentId && inParent && background) {
        sess.agentsOpen++;
        this.spawn(this.agentInParent(sess, sub, agentId, turnId, { callId, description: describe(step.input) }));
      }
      if (step.compactAfter) {
        yield rng.ms(2000, 500);
        sess.emit("context.compacted", { trigger: "auto" }, ev.compact);
        yield rng.ms(6000, 2000);
        sess.emit("session.started", { source: "compact" }, ev.start);
      }
      yield rng.ms(5000, 1200);
    }

    if (script.abandon) return;
    if (profile.toolsEndedOnly && profile.heartbeat) {
      // The model call that writes the answer, then the Stop.
      sess.emit("session.heartbeat", {}, profile.heartbeat);
      yield rng.ms(6000, 1500);
    }
    const ms = this.now - startedAt;
    const endEvent = script.error ? ev.stopFail : ev.stop;
    const reason = script.error ? "error" : "stop";
    sess.emit(
      "turn.ended",
      profile.bareTurns
        ? { reason }
        : script.error
          ? { turn_id: turnId, reason, error: script.error, ms }
          : { turn_id: turnId, reason, ms, background: script.background },
      endEvent,
    );
    sess.emit(
      "turn.transcript",
      { turn, user, assistant: script.final, at: new Date(this.wall()).toISOString() },
      endEvent,
    );
    this.statusLine(sess);
  }

  /** sessionpipe 0.10's usage limits (limits.observed), every state the Usage page has:
   *  each account's last report, left by an earlier session that ended before the demo
   *  began, then lab-mac's status line as its replies move the 5-hour window. Only an
   *  account id the cast has drawn is read (the runner's paired machine draws lab-mac's at
   *  once), never drawn here, so the cast plays as it always did. Codex sends no account
   *  id: its numbers are the machine's. */
  private *limitsScene(): Script {
    const t0 = this.startAt;
    const lab = this.v010Machine;
    const studio = this.machines[0] as string;
    const build = this.machines[1 % this.machines.length] as string;
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    this.fiveHour.resetsAt = t0 + 2 * HOUR + 21 * MINUTE;
    // Studio-mac's Claude Code account, which no paired machine names: none left, three hours ago.
    while (!this.accounts.has(`${studio}/claude-code`)) yield 1000;
    this.earlier({
      harness: "claude-code",
      machine: studio,
      account: this.accounts.get(`${studio}/claude-code`),
      repo: REPOS[2] as Repo,
      reportAt: t0 - 3 * HOUR,
      prompt: "Which pages still link to the 2.3 changelog?",
      reply: "Four: the install guide, the upgrade notes and two API pages. The changelog index already points at 2.4.",
      windows: [
        { id: "five_hour", used_percent: 100, window_minutes: 300, resets_at: at(70 * MINUTE) },
        { id: "seven_day", used_percent: 42, window_minutes: 10_080, resets_at: at(5 * DAY + HOUR) },
      ],
    });
    // A Claude Code home on api.z.ai: the gateway's spend limit, passed.
    this.earlier({
      harness: "claude-code",
      machine: lab,
      account: DEMO_API_ACCOUNT,
      repo: REPOS[0] as Repo,
      reportAt: t0 - MINUTE,
      prompt: "Summarise yesterday's failed invoice runs.",
      reply: "Three runs failed, all on the EU shard, all with the same expired card token.",
      windows: [{ id: "spend_limit", used_percent: 112, resets_at: at(12 * DAY) }],
    });
    // Codex on lab-mac, fresh, and on build-box two hours ago, its 5-hour window reset since.
    this.earlier({
      harness: "codex",
      machine: lab,
      repo: REPOS[1] as Repo,
      reportAt: t0 - 2 * MINUTE,
      prompt: "Is the pnpm store cached between CI jobs?",
      reply: "Yes, keyed on the lockfile's hash; the cache step runs before install in both workflows.",
      windows: [
        { id: "primary", used_percent: 8, window_minutes: 300, resets_at: at(3 * HOUR + 43 * MINUTE) },
        { id: "secondary", used_percent: 26, window_minutes: 10_080, resets_at: at(4 * DAY + 2 * HOUR) },
      ],
      plan: "plus",
    });
    this.earlier({
      harness: "codex",
      machine: build,
      repo: REPOS[5] as Repo,
      reportAt: t0 - 2 * HOUR,
      prompt: "List the jobs that still read the late-events table.",
      reply: "Two: nightly-rollup and backfill-reconcile. Both read it through the v1 view.",
      windows: [
        { id: "primary", used_percent: 64, window_minutes: 300, resets_at: at(-40 * MINUTE) },
        { id: "secondary", used_percent: 91, window_minutes: 10_080, resets_at: at(DAY + 4 * HOUR) },
      ],
      plan: "pro",
    });
    // lab-mac's own Claude Code account (dev@example.com): fresh, with this week's Fable
    // window beside the week across all models. Its replies move it on (statusLine).
    while (!this.accounts.has(`${lab}/claude-code`)) yield 1000;
    this.earlier({
      harness: "claude-code",
      machine: lab,
      account: this.accounts.get(`${lab}/claude-code`),
      repo: REPOS[0] as Repo,
      reportAt: t0 - MINUTE,
      prompt: "Which webhook retries are still on the old backoff?",
      reply:
        "Two: invoice.paid and customer.updated still wait a fixed 30 s; the rest moved to exponential backoff in #418.",
      windows: this.labWindows(t0 - MINUTE),
    });
  }

  /** The pool at work (DESIGN §3, UX-SPEC §13 #6), on lab-mac: a session on Spacesheep's
   *  own login whose 5 hours run out after its first turn. The pool sets the account aside
   *  and sends the next request on Misha's (lab-mac's own, the pool's current account), so
   *  the session's `limits.observed` first names Spacesheep (99.2 % of its 5 hours, the
   *  `until` the hello carries) and then Misha, with Misha's windows: "Served by Misha since
   *  …" on the page, "Switched to Misha: Spacesheep's 5 hours are used up" in the chat. It
   *  keeps taking a turn every few minutes on Misha's account, and never ends. Its ids
   *  come from a stream of its own, so the cast and limitsScene draw what they always drew. */
  private *poolScene(): Script {
    const lab = this.v010Machine;
    const rng = new Rng(this.seed + 2);
    while (!this.accounts.has(`${lab}/claude-code`)) yield 1000;
    const own = this.accounts.get(`${lab}/claude-code`) as string;
    const repo = REPOS[2] as Repo;
    const sess = new Sess(this, PROFILES["claude-code"], rng.uuid(), {
      machine: lab,
      cwd: repo.cwd,
      repo: repo.repo,
      branch: "main",
      model: MODELS["claude-code"][0],
      account_id: DEMO_POOL.spacesheep.id,
      attended: true,
    });
    const ev = sess.profile.ev;
    const until = new Date(this.startAt + DEMO_POOL_UNTIL_MS).toISOString();
    const week = new Date(this.startAt + 4 * DAY + 6 * HOUR).toISOString();
    const turns = [
      [
        "Which docs pages still mention the old `--sink` flag?",
        "Three: the install guide, the CLI reference and the FAQ's last answer. The flag is `sink add` since 0.8.",
      ],
      [
        "Rewrite those three to say `sink add`, keeping each page's own tone.",
        "Done: the install guide's step 3, the CLI reference's row, and the FAQ answer now say `sessionpipe sink add`. The examples' hosts are unchanged.",
      ],
      [
        "Is anything else in docs/ still on 0.7 wording?",
        "Two mentions of `--tail` in docs/troubleshooting.md; everything else reads 0.8 or later.",
      ],
    ] as const;
    sess.emit("session.started", { source: "startup" }, ev.start);
    sess.learn({ title: firstAsk(turns[0][0]), title_source: "first-ask" });
    for (let i = 0; ; i++) {
      const [prompt, reply] = turns[i % turns.length] as readonly [string, string];
      const turnId = rng.uuid();
      const ms = 24_000 + 3000 * (i % 3);
      sess.emit("turn.started", { turn_id: turnId, prompt_chars: [...prompt].length }, ev.prompt);
      yield ms;
      sess.emit("turn.ended", { turn_id: turnId, reason: "stop", ms }, ev.stop);
      sess.emit(
        "turn.transcript",
        { turn: i, user: prompt, assistant: reply, at: new Date(this.wall()).toISOString() },
        ev.stop,
      );
      if (i === 0) {
        // The first turn's last request: Spacesheep's 5 hours are at the switch point.
        sess.emit(
          "limits.observed",
          {
            account_id: DEMO_POOL.spacesheep.id,
            windows: [
              { id: "five_hour", used_percent: 99.2, window_minutes: 300, resets_at: until },
              { id: "seven_day", used_percent: 3, window_minutes: 10_080, resets_at: week },
            ],
          },
          "StatusLine",
        );
        yield 1500;
      }
      // Served by Misha from here on: every report names the account that answered.
      sess.emit("limits.observed", { account_id: own, windows: this.labWindows(this.wall()) }, "StatusLine");
      yield i === 0 ? 20_000 : 4 * MINUTE + 20_000 * (i % 2);
    }
  }

  /** lab-mac's Claude Code windows as its status line reports them at `now`. */
  private labWindows(now: number): Record<string, unknown>[] {
    const f = this.fiveHour;
    // Past its reset the window starts again, as the harness's own would.
    while (f.resetsAt && f.resetsAt <= now) {
      f.resetsAt += 5 * HOUR;
      f.used = 3;
    }
    const week = new Date(this.startAt + 2 * DAY + 18 * HOUR).toISOString();
    return [
      { id: "five_hour", used_percent: f.used, window_minutes: 300, resets_at: new Date(f.resetsAt).toISOString() },
      { id: "seven_day", used_percent: 20, window_minutes: 10_080, resets_at: week },
      { id: "seven_day_fable", used_percent: 29, resets_at: week },
    ];
  }

  /** lab-mac's status line after a reply on its own account: every third one moves the
   *  5-hour window a point or two, and the hook reports only what changed. */
  private statusLine(sess: Sess): void {
    const lab = this.v010Machine;
    const account = this.accounts.get(`${lab}/claude-code`);
    if (sess.profile.name !== "claude-code" || sess.block.machine !== lab || sess.block.account_id !== account) return;
    const f = this.fiveHour;
    if (!f.resetsAt || ++f.replies % 3 !== 0) return;
    f.used = Math.min(99, f.used + (f.bumps++ % 2 ? 2 : 1));
    sess.emit("limits.observed", { windows: this.labWindows(this.wall()) }, "StatusLine");
  }

  /** A short session that ended before the demo began and left its account's limits:
   *  one turn, the report after its reply (Claude Code's status line, Codex's Stop), the end. */
  private earlier(p: {
    harness: "claude-code" | "codex";
    machine: string;
    account?: string;
    repo: Repo;
    reportAt: number;
    prompt: string;
    reply: string;
    windows: Record<string, unknown>[];
    plan?: string;
  }): void {
    const rng = this.sideRng;
    const codex = p.harness === "codex";
    const start = p.reportAt - 4 * MINUTE;
    const sess = new Sess(this, PROFILES[p.harness], codex ? rng.uuid7(start) : rng.uuid(), {
      machine: p.machine,
      cwd: p.repo.cwd,
      repo: p.repo.repo,
      branch: "main",
      model: MODELS[p.harness][0],
      title: firstAsk(p.prompt),
      title_source: "first-ask",
      ...(p.account ? { account_id: p.account } : {}),
    });
    const ev = sess.profile.ev;
    const turnId = codex ? rng.uuid7(start) : rng.uuid();
    const ms = 3 * MINUTE + 40_000;
    sess.emit("session.started", { source: "startup" }, ev.start, true, start);
    sess.emit("turn.started", { turn_id: turnId, prompt_chars: [...p.prompt].length }, ev.prompt, true, start + 5000);
    sess.emit("turn.ended", { turn_id: turnId, reason: "stop", ms }, ev.stop, true, start + 5000 + ms);
    sess.emit(
      "turn.transcript",
      { turn: 0, user: p.prompt, assistant: p.reply, at: new Date(start + 5000 + ms).toISOString() },
      ev.stop,
      true,
      start + 5000 + ms,
    );
    sess.emit(
      "limits.observed",
      { windows: p.windows, plan: p.plan },
      codex ? ev.stop : "StatusLine",
      true,
      p.reportAt,
    );
    sess.emit("session.ended", { reason: "exit" }, ev.end, true, p.reportAt + 20_000);
  }

  /** The session the daemon starts for an ask or a handoff: the asked harness, on the
   *  asking session's machine and in its folder, `delegated_by` on every event (the hook
   *  reads it from the env the daemon set). */
  private child(from: Sess, harness: HarnessName): Sess {
    const rng = this.rng;
    const profile = PROFILES[harness];
    const machine = from.block.machine as string;
    return new Sess(this, profile, this.newSessionId(harness), {
      machine,
      cwd: from.block.cwd,
      repo: from.block.repo,
      branch: from.block.branch,
      account_id: this.account(machine, harness),
      delegated_by: `${from.profile.name}:${from.id}`,
      ...(profile.modelAtStart ? { model: rng.pick(MODELS[harness]) } : {}),
    });
  }

  /** `sessionpipe ask` from inside `from`'s turn (CONTROL.md §13): delegation.started on
   *  the asking session, the asked agent's session with the framed question as its first
   *  prompt, then delegation.ended with the answer. Returns the answer. */
  private *asked(from: Sess, ask: AskScript): Generator<number, string, undefined> {
    const rng = this.rng;
    const askId = this.rng.ulid(this.wall());
    const child = this.child(from, ask.harness);
    const to = `${ask.harness}:${child.id}`;
    const begun = this.now;
    // The daemon learns the new session's id when the harness reveals it: `to` comes
    // with the end, not the start.
    from.emit(
      "delegation.started",
      { ask_id: askId, via: "ask", harness: ask.harness, text: ask.text.slice(0, 200) },
      "",
    );
    yield rng.ms(2500, 600);
    const reply = yield* this.childRun(
      child,
      ask.turns,
      askFrame(ask.turns[0]?.prompt ?? ask.text, `${from.profile.name}:${from.id}`),
    );
    from.emit("delegation.ended", { ask_id: askId, to, ok: true, ms: this.now - begun, reply }, "");
    return reply;
  }

  /** A handoff (CONTROL.md §3.1 `reply_to`): a `start` signed here named `from` as the
   *  session to answer into. The daemon starts the asked agent (the demo machine records
   *  the start), says so on `from` with `via: "handoff"`, and when the child answers,
   *  delivers the reply into `from` as a framed prompt and closes the delegation with
   *  `relayed: "delivered"`; `from` then answers that message as any other. */
  private *handoff(from: Sess, h: HandoffScript, turn: number): Script {
    const rng = this.rng;
    const askId = this.rng.ulid(this.wall());
    const child = this.child(from, h.harness);
    const to = `${h.harness}:${child.id}`;
    const begun = this.now;
    const first = h.turns[0] as TurnScript;
    const prompt = startFrame(h.text);
    this.onStart?.({
      harness: h.harness,
      id: child.id,
      machine: from.block.machine as string,
      cwd: from.block.cwd as string,
      text: h.text,
      at: this.wall(),
      replyTo: `${from.profile.name}:${from.id}`,
      from: `${from.profile.name}:${from.id}`,
    });
    from.emit(
      "delegation.started",
      { ask_id: askId, via: "handoff", harness: h.harness, to, text: h.text.slice(0, 200) },
      "",
    );
    yield rng.ms(3000, 800);
    const reply = yield* this.childRun(child, [{ ...first, prompt }, ...h.turns.slice(1)], prompt);
    yield rng.ms(1500, 400);
    from.emit(
      "delegation.ended",
      { ask_id: askId, to, ok: true, ms: this.now - begun, relayed: "delivered", reply },
      "",
    );
    yield rng.ms(1200, 300);
    // The answer arrives as a prompt of its own, framed; the session answers it.
    yield* this.playTurn(from, { prompt: answerFrame(h.harness, child.id, reply), steps: [], final: h.followUp }, turn);
  }

  /** The asked agent's session, start to end: its first prompt is the framed question
   *  (`firstPrompt`), and its last turn's `final` is the answer. */
  private *childRun(
    child: Sess,
    turns: readonly TurnScript[],
    firstPrompt: string,
  ): Generator<number, string, undefined> {
    const rng = this.rng;
    const profile = child.profile;
    this.live++;
    child.emit("session.started", { source: "startup" }, profile.ev.start);
    yield rng.ms(4000, 1000);
    let reply = "";
    for (const [i, script] of turns.entries()) {
      const s = i === 0 ? { ...script, prompt: firstPrompt } : script;
      if (i === 0) child.learn({ title: firstAsk(s.prompt), title_source: "first-ask" });
      yield* this.playTurn(child, s, i);
      reply = script.final;
      if (i < turns.length - 1) yield rng.ms(8000, 2000);
    }
    yield rng.ms(2000, 500);
    child.emit("session.ended", { reason: "exit" }, profile.ev.end);
    this.live--;
    this.ended.push(child);
    return reply;
  }

  /** A subagent as Claude Code sends it: inside the parent's session, every tool stamped
   *  with its `agent_id` and the spawning turn's `turn_id`, bracketed by SubagentStart and
   *  SubagentStop. `background`: it was launched async; when it ends it leaves a notice
   *  for the orchestrator's `<task-notification>` turn. */
  private *agentInParent(
    sess: Sess,
    sub: SubagentScript,
    agentId: string,
    turnId: string | undefined,
    background?: { callId?: string; description?: string },
  ): Script {
    const rng = this.rng;
    const profile = sess.profile;
    const ev = profile.ev;
    const [think, spread] = sub.think ?? [3000, 800];
    sess.emit("subagent.started", { agent_id: agentId, agent_type: sub.type }, ev.subStart);
    yield rng.ms(4000, 1000);
    for (const step of sub.steps) {
      const callId = profile.callId?.(rng);
      sess.emit(
        "tool.started",
        { tool: step.tool, call_id: callId, agent_id: agentId, turn_id: turnId, input: step.input },
        ev.preTool,
      );
      yield step.ms;
      const ok = step.ok ?? true;
      sess.emit(
        "tool.ended",
        {
          tool: step.tool,
          call_id: callId,
          agent_id: agentId,
          turn_id: turnId,
          ms: step.ms,
          ok,
          error: ok ? undefined : step.error,
          input: step.input,
          output: step.output ?? null,
        },
        ok ? ev.postTool : ev.postToolFail,
      );
      yield rng.ms(think, spread);
    }
    sess.emit("subagent.ended", { agent_id: agentId, agent_type: sub.type }, ev.subStop);
    if (background) {
      sess.notices.push({ agentId, callId: background.callId, description: background.description, sub });
      sess.agentsOpen--;
    }
  }

  /** Claude Code's follow-up when a background agent stops: a prompt of the harness's own,
   *  worded as the recording has it, and the orchestrator's answer to it. */
  private *notificationTurn(sess: Sess, n: Sess["notices"][number], turn: number): Script {
    const rng = this.rng;
    const ev = sess.profile.ev;
    const turnId = sess.profile.turnId?.(rng, this.wall());
    const user = [
      "<task-notification>",
      `<task-id>${n.agentId}</task-id>`,
      ...(n.callId ? [`<tool-use-id>${n.callId}</tool-use-id>`] : []),
      "<status>completed</status>",
      `<summary>Agent "${n.description ?? n.sub.type}" finished</summary>`,
      `<result>${n.sub.result ?? ""}</result>`,
      "</task-notification>",
    ].join("\n");
    const startedAt = this.now;
    sess.emit("turn.started", { turn_id: turnId, prompt_chars: [...user].length }, ev.prompt);
    if (sess.profile.progress)
      sess.emit("turn.progress", { turn, user, assistant: "", at: new Date(this.wall()).toISOString() }, ev.prompt);
    yield rng.ms(7000, 2000);
    const assistant = n.sub.followUp ?? `The ${n.sub.type} agent reported back.`;
    sess.emit("turn.ended", { turn_id: turnId, reason: "stop", ms: this.now - startedAt }, ev.stop);
    sess.emit("turn.transcript", { turn, user, assistant, at: new Date(this.wall()).toISOString() }, ev.stop);
  }

  /** A subagent: the parent announces it, the child runs as its own session with
   *  parent_id and agent_id on every tool, then the parent closes it. */
  private *subagent(parent: Sess, sub: SubagentScript, agentId: string): Script {
    const rng = this.rng;
    const ev = parent.profile.ev;
    parent.emit("subagent.started", { agent_id: agentId, agent_type: sub.type }, ev.subStart);
    const { title: _t, title_source: _ts, url: _u, ...inherited } = parent.block;
    const child = new Sess(this, parent.profile, agentId, { ...inherited, parent_id: parent.id });
    child.emit("session.started", { source: "fork" }, ev.subStart);
    yield rng.ms(1500, 300);
    for (const step of sub.steps) {
      const callId = parent.profile.callId?.(rng);
      child.emit(
        "tool.started",
        { tool: step.tool, call_id: callId, agent_id: agentId, input: step.input },
        ev.preTool,
      );
      yield step.ms;
      child.emit(
        "tool.ended",
        {
          tool: step.tool,
          call_id: callId,
          agent_id: agentId,
          ms: step.ms,
          ok: step.ok ?? true,
          input: step.input,
          output: step.output ?? null,
        },
        ev.postTool,
      );
      yield rng.ms(3000, 800);
    }
    child.emit("session.ended", { reason: "other" }, ev.subStop);
    parent.emit("subagent.ended", { agent_id: agentId, agent_type: sub.type }, ev.subStop);
  }
}
