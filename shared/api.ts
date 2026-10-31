// SPDX-License-Identifier: Apache-2.0
// The contract between the server (server/) and the web app (web/). Both import from
// here and nowhere else for anything that crosses the wire. Change it deliberately:
// a field added here is a field both sides must handle.
//
// The pool (mp/pool, DESIGN §2.3) changes both sides: `MachineControl.pool` from the
// hello, `SessionSummary.servedBy` from `limits.observed.account_id`, the `pool` control
// kind with `poolAction` / `poolAccount` on its activity, and the constants under "the
// pool" below. Every addition is optional, so a page from before it still reads.
//
// Protocol events themselves are the sessionpipe v1 envelope (spec/PROTOCOL.md §2);
// the shapes below are the GUI's *readings* of them (spec §1: a receiver's readings
// are its own, never part of the protocol).

export type Tier = 0 | 1 | 2 | 3;

/** A protocol event as stored: the envelope, plus when it arrived here. */
export interface StoredEvent extends ProtocolEvent {
  /** Receiver arrival time (HTTP.md §2 "Time"), ISO 8601. */
  arrivedAt: string;
  /** Where it came from: the HTTP events endpoint, the local outbox tailer, or demo mode. */
  source: EventSource;
  /** Present on events from the stream and the feed, which are *slim*: data.input,
   *  data.output, data.user and data.assistant may be cut to a preview; this maps each
   *  cut key to its original length. The session detail route returns the full event. */
  preview?: Record<string, number>;
}

export type EventSource = "http" | "outbox" | "demo";

/** The sessionpipe v1 envelope. Kept structural (not imported from sessionpipe-core) so
 *  the web bundle never pulls the core package in. */
export interface ProtocolEvent {
  protocol: 1;
  id: string;
  type: string;
  time: string;
  tier: Tier;
  harness: { name: string; version?: string; event?: string };
  session: ProtocolSession;
  privacy: { rulesets: string[]; pii: boolean };
  data: Record<string, unknown>;
}

export interface ProtocolSession {
  id: string;
  seq: number;
  machine?: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  model?: string;
  title?: string;
  title_source?: "custom" | "harness" | "first-ask";
  url?: string;
  account_id?: string;
  /** Whether a person attends the session, in the harness's word (sessionpipe 0.10):
   *  `false` for a run nobody watches (a headless run a script started). Absent is unknown,
   *  never `false`. */
  attended?: boolean;
  parent_id?: string | null;
  /** The session that started this one, `<harness>:<id>` (PROTOCOL.md §3); not a subagent. */
  launched_by?: string;
  /** `<harness>:<id>` of the session this one was started or resumed for (sessionpipe
   *  `ask` / a handoff): lineage across harnesses, never authority. Absent otherwise. */
  delegated_by?: string;
}

/** The GUI's reading of a session's state (spec §1: made from the facts, never sent).
 *  needs_you: an attention is open. working: a turn started and nothing ended it, with
 *  an event in the last STALE_AFTER_MS. stale: working, but silent longer than that.
 *  idle: the last turn ended and the session did not. done: session.ended arrived, or
 *  only a backfill is known, or nothing for DONE_AFTER_MS (a day: an open window left
 *  idle for an afternoon is still idle). */
export type SessionState = "needs_you" | "working" | "stale" | "idle" | "done";

export const STALE_AFTER_MS = 10 * 60_000;
export const DONE_AFTER_MS = 24 * 3600_000;

export const SESSION_STATES: SessionState[] = ["needs_you", "working", "stale", "idle", "done"];

export type AttentionKind = "permission" | "question" | "elicitation" | "idle" | "error";

export interface Attention {
  attentionId: string;
  kind: AttentionKind;
  tool?: string;
  message?: string;
  at: string;
  /** True when a control `permission.answer` can reach this prompt: it came from the
   *  harness's permission hook (the one the daemon registers), not from a notification
   *  about it. Claude Code raises both for one prompt; only the first is answerable. */
  answerable?: boolean;
}

/** `${harness}:${id}` — the key everything in the UI API uses for a session. */
export type SessionKey = string;
export const sessionKey = (harness: string, id: string): SessionKey => `${harness}:${id}`;
export const splitKey = (key: SessionKey): { harness: string; id: string } => {
  const i = key.indexOf(":");
  return { harness: key.slice(0, i), id: key.slice(i + 1) };
};

export interface SessionSummary {
  key: SessionKey;
  harness: string;
  harnessVersion?: string;
  id: string;
  /** Session block, COALESCE-merged across events (spec §3). */
  machine?: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  model?: string;
  title?: string;
  titleSource?: "custom" | "harness" | "first-ask";
  url?: string;
  accountId?: string;
  parentId?: string | null;
  /** `session.attended`, the latest value (sessionpipe 0.10). Absent means unknown, never
   *  false: only `false` marks an unattended run. */
  attended?: boolean;
  /** The session that launched this one, as a session key; never read as a subagent. */
  launchedBy?: SessionKey;
  /** The pool is serving this session with another account than its own: the newest
   *  `limits.observed` on it carries an `account_id` other than `accountId`. `since` is the
   *  time of the first such report in a row for that account; a report naming the session's
   *  own account again clears it. Absent when nothing says otherwise. */
  servedBy?: { accountId: string; since: string };
  /** `session.delegated_by`: the session this one was started for (`sessionpipe ask`, or
   *  a handoff). Lineage like `parentId`, across harnesses; never authority. */
  delegatedBy?: SessionKey;

  state: SessionState;
  /** When the current state began (ISO). */
  stateSince: string;
  startedAt: string;
  lastAt: string;
  endedAt?: string;
  /** The highest tier any event of this session arrived at: what the UI can show. */
  maxTier: Tier;
  /** Backfill-only sessions have no live events. */
  backfilled: boolean;
  source: EventSource;

  counts: {
    events: number;
    turns: number;
    tools: number;
    toolErrors: number;
    subagents: number;
    compactions: number;
    filesChanged: number;
    attentions: number;
    /** Agents in `agents` not yet ended (running or stale). `subagents` above counts every
     *  subagent.started ever; this is the live number. */
    agentsRunning: number;
    /** Delegations in `delegations` not yet ended. Always set by this server; optional on
     *  the wire so a page reading an older server (or the mock) still types. */
    delegationsRunning?: number;
  };
  /** The orchestrator's own tool running right now (tool.started without its tool.ended),
   *  if any. A subagent's tool (one with `agent_id`) runs on its AgentRun instead.
   *  `agentId` is kept for older clients and is no longer set. */
  currentTool?: { tool: string; callId?: string; since: string; agentId?: string };
  /** The turn running right now, if any. `submittedBy` is the harness's own word for who
   *  submitted it (`turn.started.submitted_by`, sessionpipe 0.10: `user`, `sdk`, `system`,
   *  `loop_wakeup`, `schedule_wakeup`, …, kept as sent); `injected` that its prompt is a
   *  block the harness wrote, not the person's words. Absent is unknown. */
  currentTurn?: { turnId?: string; since: string; promptChars?: number; submittedBy?: string; injected?: boolean };
  /** The session's last turn ended with background work still in flight
   *  (`turn.ended.background`, sessionpipe 0.10): it is paused on its own work, each piece
   *  of which wakes it, not done. `tasks` is the count, `since` when that turn ended. Cleared
   *  by its next turn, or its end. */
  background?: { tasks: number; since: string };
  openAttentions: Attention[];
  /** Latest turn.progress until its turn.transcript lands (spec §4). */
  progress?: { turn: number; user: string; assistant: string; at: string };
  /** From the latest turn.transcript, each cut to SNIPPET_CHARS. */
  lastUser?: string;
  lastAssistant?: string;
  /** Number of subagent sessions whose parent_id is this session. */
  children: number;
  /** The subagents this session ran, open ones first, then the newest ended, at most
   *  AGENTS_MAX. Read from its own events (subagent.started / .ended, `agent_id` on tools),
   *  which is how Claude Code and Codex report them; a child session with `parent_id` is
   *  merged in by id with `session` set. Empty when it ran none. */
  agents: AgentRun[];
  /** The agents this session asked (`delegation.started` / `.ended`: `sessionpipe ask`, or
   *  a handoff relayed into it), newest last, at most DELEGATIONS_MAX; an open one is
   *  never dropped. Absent when it asked none. An open delegation keeps the session
   *  `working` the way an open agent does. */
  delegations?: Delegation[];
  /** Last tool names, newest last, at most 8 — for a sparkline of activity. */
  recentTools: { tool: string; ok: boolean; ms?: number }[];
  /** The store's smarter readings (ARCHITECTURE.md "The store's readings"): what is
   *  off about the session right now, in a fixed order by kind. Empty when nothing is. */
  flags: SessionFlag[];
  /** From turn.started / turn.ended: completed turns, their durations, tools per turn. */
  turnStats: TurnStats;
  /** When the latest news arrived (ISO, the event's `arrivedAt`) for someone away from
   *  the terminal: a turn's end, unless the person typed that turn there in a session
   *  they attend, or the session's end. What the read marks (Marks) compare against. */
  newsAt?: string;
}

export const SNIPPET_CHARS = 280;

/** At most this many AgentRuns ride on a summary (open ones are never dropped). */
export const AGENTS_MAX = 20;

/** A subagent, as the GUI reads it from the protocol (spec: subagent.started / .ended,
 *  `agent_id` on tool events, the Agent / Task tool's input and output at tier 3). Claude
 *  Code and Codex keep a subagent inside its parent's session; a harness that gives it a
 *  session of its own (`parent_id`) is linked through `session`. Nothing here is guessed:
 *  a field the events did not carry is absent. */
export interface AgentRun {
  /** `data.agent_id` (a child session's id when it came as one). */
  id: string;
  /** `data.agent_type`: "Explore", "general-purpose". */
  type?: string;
  /** The launching Agent / Task tool's `input.description` (tier 3): the line a person
   *  recognises, "Find ad-hoc money formatting". */
  description?: string;
  /** The launching tool call: by its `output.agentId` (tier 3), else the newest Agent /
   *  Task call not yet matched to an agent. */
  callId?: string;
  /** The turn that spawned it: the turn open when it started (Claude Code also stamps it
   *  on every one of the agent's tools). */
  turnId?: string;
  /** running: started and not ended, with an event of its own within STALE_AFTER_MS.
   *  stale: not ended and silent longer. done: subagent.ended, or the session ended. */
  state: "running" | "stale" | "done";
  startedAt: string;
  endedAt?: string;
  /** Its newest event. */
  lastAt: string;
  /** Its own tool calls (tool.ended with its `agent_id`); 0 for a harness that does not
   *  stamp them (Codex), see `attributed`. */
  tools: number;
  toolErrors: number;
  /** Whether its tools are told apart from the orchestrator's (they carry `agent_id`).
   *  False for Codex, whose subagent tools arrive unmarked: show no tool facts then. */
  attributed: boolean;
  /** Its tool running right now. */
  currentTool?: { tool: string; callId?: string; since: string };
  /** Its last tools, newest last, at most 4. */
  recentTools: { tool: string; ok: boolean; ms?: number }[];
  /** A synchronous Agent call's output (tier 3), cut to SNIPPET_CHARS. Absent when the
   *  agent ran in the background: the protocol does not carry its result then. */
  result?: string;
  /** The child session, when the harness sent the agent as one (`parent_id`). */
  session?: SessionKey;
}

/** At most this many Delegations ride on a summary (open ones are never dropped). */
export const DELEGATIONS_MAX = 50;

/** One ask this session made of another agent, as the GUI reads it from the events on
 *  the asking session (sessionpipe PROTOCOL.md `delegation.started` / `delegation.ended`):
 *  `via: "ask"` for `sessionpipe ask` from inside the session, `"handoff"` for a signed
 *  `prompt` / `start` with `reply_to` whose answer the daemon relayed into it. Nothing here
 *  is guessed: a field the events did not carry is absent. */
export interface Delegation {
  /** `data.ask_id` (a ULID); the key `delegation.ended` closes it by. */
  askId: string;
  via: "ask" | "handoff";
  /** The agent asked (`data.harness`). */
  harness: string;
  /** `data.to`: the child session, once the harness revealed its id. */
  to?: SessionKey;
  startedAt: string;
  endedAt?: string;
  /** `delegation.ended.ok`. */
  ok?: boolean;
  ms?: number;
  /** The question (tier 1+, ≤ 200 chars as sent). */
  text?: string;
  /** The answer (tier 2+), cut to the index's preview length; the event has it whole. */
  reply?: string;
  /** `delegation.ended.error`, when not ok. */
  error?: string;
  /** A handoff: whether the answer reached `reply_to` (`delegation.ended.relayed`). */
  relayed?: "delivered" | "unsupported" | "failed";
}

/** slow_tool: `currentTool` has run longer than SLOW_TOOL_MS. error_streak: the last
 *  3+ tool.ended were `ok: false`. loop: within the last 10 tool.started the same tool
 *  ran 3+ times on an identical input (tier 3 only). compacting: 2+ context.compacted
 *  within COMPACTING_WINDOW_MS of the last event. gap: seqs are missing behind the
 *  highest one for longer than GAP_AFTER_MS (they clear when they arrive). */
export type SessionFlagKind = "slow_tool" | "error_streak" | "loop" | "compacting" | "gap";

export interface SessionFlag {
  kind: SessionFlagKind;
  /** When the condition began (ISO): the tool's start, the first error of the streak,
   *  the first start of the loop, the second compaction, the moment the hole appeared. */
  since: string;
  /** One short line for a card: "Bash · 4 m", "3 tool errors in a row",
   *  "Read ×3 on the same input", "compacted twice in 20 m", "waiting for 2 events (seq 41–42)". */
  detail: string;
}

export interface TurnStats {
  /** Completed turns (turn.ended seen). */
  count: number;
  /** Median duration of completed turns, from `ms` or the turn's span. */
  medianMs?: number;
  /** Duration of the last completed turn. */
  lastMs?: number;
  /** Tools ended so far per completed turn, to one decimal. */
  toolsPerTurn?: number;
}

export const SLOW_TOOL_MS = 3 * 60_000;
export const GAP_AFTER_MS = 30_000;
export const COMPACTING_WINDOW_MS = 30 * 60_000;

export interface MachineSummary {
  name: string;
  lastAt: string;
  /** harness name → version last seen. */
  harnesses: Record<string, string | undefined>;
  sessions: number;
  working: number;
  needsYou: number;
  /** Present once the machine's control daemon paired with this receiver. */
  control?: MachineControl;
}

/** The kinds of key a machine or a receiver takes (sessionpipe CONTROL.md §2): browser
 *  passkeys, and the device keys the native apps hold in hardware. Absent: passkeys only. */
export type KeyType = "passkey" | "device";

/** A key a machine trusts, as the receiver carries it whole: a passkey (`id`, `alg`,
 *  `spki`), or an app's device key, which adds `type`, `store` and `uv` (CONTROL.md §2
 *  "Device keys"; its id is the SHA-256 of its SPKI). */
export interface TrustedKey {
  id: string;
  alg: number;
  spki: string;
  type?: "device";
  store?: "hardware";
  uv?: "each-use";
}

export interface MachineControl {
  machineId: string;
  online: boolean;
  lastPollAt?: string;
  lastHelloAt?: string;
  mode?: MachineMode;
  folders?: string[];
  harnesses?: string[];
  modes?: string[];
  version?: string;
  accounts?: HarnessAccount[];
  /** `type: "device"` marks an app's device key; absent, a passkey. */
  keys: { id: string; alg: number; type?: "device"; name?: string; addedAt: string }[];
  /** Pairing or hello `key_types`: the kinds of key this machine takes. Absent (an older
   *  daemon) means passkeys only, so the app never offers it a device key. */
  keyTypes?: KeyType[];
  /** Messages queued for it and not yet finally acked. */
  queued: number;
  /** Hello `files: true`: the machine takes `files` on a `start` (CONTROL.md §3.1, §6). */
  files?: boolean;
  /** Hello `prompt_files: true`: it takes `files` on a `prompt` too (sessionpipe 0.10). */
  promptFiles?: boolean;
  /** A start may name its folder as `~/…`, which the machine reads under its daemon user's
   *  home (sessionpipe 0.10, CONTROL.md §3.1: no hello names a home folder; a machine whose
   *  hello has `start` takes one). Set when this receiver's core takes one too; absent, a
   *  start's folder is absolute and a `~/…` one is not offered. */
  tilde?: boolean;
  /** Hello `start`: per harness, what a `start` may ask for there (sessionpipe 0.10). A
   *  harness with no entry takes neither `permission` nor `model`, and nothing offers them. */
  start?: Record<string, HarnessStartOptions>;
  /** Hello `pool` (sessionpipe 0.11, CONTROL.md §2): the machine's pool of Claude accounts
   *  its daemon switches between when one reaches its limit. A daemon that knows the pool
   *  sends it in every hello, `{on: false, accounts: []}` when nothing is set up; absent, the
   *  daemon predates the pool ("needs a newer sessionpipe") and no pool command is offered
   *  for it. Said again in every hello: one without it takes it away. */
  pool?: MachinePool;
  /** Hello `ask`: whether `sessionpipe ask` is on there (a session may ask another agent
   *  through the daemon). Absent: the daemon predates it (0.10), so nothing is said. */
  ask?: boolean;
  /** Hello `handoff: true`: the daemon takes `reply_to` on a `prompt` or a `start` and
   *  relays the answer into that session (CONTROL.md §3.1). Absent: never offered. */
  handoff?: boolean;
}

/** A machine's mode, the person's choice at its own terminal (CONTROL.md §2): `safe`,
 *  nothing that needs approval runs unattended; `auto`, the harness's auto mode; `inherit`
 *  (sessionpipe 0.10), no permission flag, so a session runs as the person's own do there,
 *  with whatever the harness's settings allow, which can include skipping permission checks. */
export type MachineMode = "safe" | "auto" | "inherit";

/** A harness account signed in on a machine, from its pairing and hello (CONTROL.md §2): a
 *  label for `session.account_id`, never checked against anything. `email` when it signs in
 *  with one; `name` instead for one with no email (sessionpipe 0.10: a Claude Code home on
 *  another API, named by its endpoint's host, `api.z.ai`). At least one of the two is set. */
export interface HarnessAccount {
  harness: string;
  id: string;
  email?: string;
  name?: string;
}

/** What an account is called: its email, else its name, else nothing. */
export const accountLabel = (a: HarnessAccount): string => a.email ?? a.name ?? "";

// ---------- the pool (hello `pool`, the `pool` command; DESIGN §2.3) ----------

/** The accounts a machine's daemon pools for one harness (today only Claude Code), from
 *  its hello. `on`: requests on the machine go through the pool; off, the accounts are kept
 *  but every session runs on its own login. `accounts` are in the machine's order, at most
 *  POOL_ACCOUNTS_MAX; the receiver only reads them, the machine decides. */
export interface MachinePool {
  on: boolean;
  harness: string;
  accounts: MachinePoolAccount[];
}

/** One pooled account. `id` is the same string as `session.account_id` and
 *  `limits.observed.account_id` (Claude Code: the account UUID), so the three join without
 *  a map; the matching `HarnessAccount` on `MachineControl.accounts` has its email. */
export interface MachinePoolAccount {
  id: string;
  email?: string;
  /** What the person called it at the terminal ("Fiction"), when they did. */
  label?: string;
  /** `pool enable` / `disable`: a disabled account is never chosen. */
  enabled: boolean;
  /** ready: has room. limited: a window is used up (`until` says when it has room again,
   *  when known). error: its token is no good ("sign in again"). disabled: turned off. */
  status: PoolAccountStatus;
  /** Serving new sessions right now (the first in the order with room). */
  current: boolean;
  /** limited: RFC 3339, when it has room again, if the machine knows. */
  until?: string;
  /** The account's freshest numbers, even while idle (the daemon polls the usage endpoint),
   *  in the shape `limits.observed` carries, 1–LIMIT_WINDOWS_MAX. The receiver feeds them to
   *  the account's LimitsEntry when they are newer than what it has (server/ui/limits.ts),
   *  so the Usage page draws bars for an account no session went through yet. */
  windows?: LimitWindow[];
  /** limited / error only: what tripped it: a window id ("seven_day"), `rejected` (the
   *  vendor's status) or `error` (the token is no good). */
  limitedBy?: string;
}

export type PoolAccountStatus = "ready" | "limited" | "error" | "disabled";
export const POOL_ACCOUNT_STATUSES: readonly PoolAccountStatus[] = ["ready", "limited", "error", "disabled"];
/** Accounts a hello's `pool` lists at most, and a `pool_order` names at most. */
export const POOL_ACCOUNTS_MAX = 20;

/** The session a `pool` command names: the machine's own pool, not a coding session
 *  (like `sessionpipe:keys` for a `key.add`). */
export const POOL_SESSION = "sessionpipe:pool";

/** What a `pool` command asks for (CONTROL.md, the pool). `on` / `off` switch the pool and
 *  take nothing else, as does `login.begin`, which starts a sign-in (the ack's detail is
 *  "<pending login id> <URL>"); `enable`, `disable`, `remove` take `pool_account`;
 *  `refresh` takes it optionally (every account when absent); `order` takes `pool_order`,
 *  every account id once; `login.complete` takes the pending login id as `pool_account`
 *  and the pasted `code#state` as `pool_code`. `refresh`, `login.begin` and
 *  `login.complete` need the pool on (`pool_off` otherwise); the rest work while it is off. */
export type PoolAction =
  | "on"
  | "off"
  | "enable"
  | "disable"
  | "remove"
  | "order"
  | "refresh"
  | "login.begin"
  | "login.complete";
export const POOL_ACTIONS: readonly PoolAction[] = [
  "on",
  "off",
  "enable",
  "disable",
  "remove",
  "order",
  "refresh",
  "login.begin",
  "login.complete",
];
/** The actions that must name an account (or, login.complete, the pending login) in
 *  `pool_account`; `refresh` may. */
export const POOL_ACCOUNT_REQUIRED: readonly PoolAction[] = ["enable", "disable", "remove", "login.complete"];
export const POOL_ACCOUNT_ACTIONS: readonly PoolAction[] = [...POOL_ACCOUNT_REQUIRED, "refresh"];
/** The actions signed with a fresh confirm (one passkey tap, Touch ID), never under the
 *  day grant: they change what a machine sends to a vendor, which account serves, or
 *  forget a sign-in. The daemon refuses one signed with a grant alone (`confirm_required`),
 *  and so does this receiver's early verify (server/control/pool.ts); the page signs them
 *  with a confirm. The same six the daemon names (sessionpipe POOL_CONFIRM). */
export const POOL_CONFIRM_ACTIONS: readonly PoolAction[] = [
  "on",
  "off",
  "remove",
  "order",
  "disable",
  "login.complete",
];
/** `pool_code`'s longest form (the pasted `code#state`), one line. */
export const POOL_CODE_MAX = 512;
/** An account id or a pending login id in a command (CONTROL.md, the pool). */
export const POOL_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const POOL_ID_MAX = 128;
/** The machine's own refusal and failure codes for a pool command, besides the verifier's:
 *  `pool_account` (unknown account or pending login, or the login expired), `pool_order`
 *  (not every account exactly once), `pool_off` (refresh / login while the pool is off);
 *  `failed` with `login` (the vendor rejected the code) or `pool` (the vendor call did not
 *  go through); `unsupported` when the daemon knows the kind but this machine cannot pool.
 *  This receiver adds `pool_unsupported` before anything is queued (a hello with no `pool`). */
export const POOL_CODES = ["pool_account", "pool_order", "pool_off", "login", "pool", "pool_unsupported"] as const;

// ---------- starting a session (CONTROL.md §6 `start`, its options and files) ----------

/** The levels a `start` may ask for, narrowest first (CONTROL.md §3.1). Closed: nothing is
 *  wider than `auto`, and no level turns a harness's approval off. */
export type StartPermission = "read" | "safe" | "edits" | "auto";
export const START_PERMISSIONS: readonly StartPermission[] = ["read", "safe", "edits", "auto"];

/** What a start runs with: a level, or `inherit` (sessionpipe 0.10): no permission flag, the
 *  harness's own default on an `inherit` machine. `inherit` only ever comes from the machine
 *  (its mode, a harness's default in the hello, an ack's `applied`); a command never names it. */
export type RunLevel = StartPermission | "inherit";

/** The levels a start may name on an `inherit` machine (CONTROL.md §3.1): the harness's own
 *  default there can't be ranked, so nothing wider than `safe` is offered or queued. */
export const INHERIT_LEVELS: readonly StartPermission[] = ["read", "safe"];

/** One harness's entry in the hello's `start`: the levels it starts at here (already capped
 *  by the machine's mode), the one a start gets when it names none, and its models. */
export interface HarnessStartOptions {
  /** At least one, capped by the machine's mode (on an `inherit` machine, `INHERIT_LEVELS`). */
  permissions: StartPermission[];
  /** The default: one of `permissions`, or `inherit` on an `inherit` machine, which a start
   *  gets by naming no level. */
  permission: RunLevel;
  /** At most 50 suggestions, not a promise. */
  models?: string[];
  /** Hello `any_model`: any well-formed id is passed on (the harness may still refuse it). */
  anyModel?: boolean;
}

/** A model id as CONTROL.md §3.1 allows it: 1–100 characters, never a leading `-`. The
 *  same rule as sessionpipe-core's MODEL_RE (0.10); import that once the GUI is on it. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;
export const MODEL_MAX = 100;
export const validModel = (m: unknown): m is string =>
  typeof m === "string" && m.length >= 1 && m.length <= MODEL_MAX && MODEL_RE.test(m);

/** One file a `start` names (CONTROL.md §3.1 `files`): the receiver holds the bytes under
 *  `sha256` (base64url, 43 characters) and the machine fetches them with its token. */
export interface StartFile {
  name: string;
  type: string;
  size: number;
  sha256: string;
}
/** The limits of `files` on one command (CONTROL.md §3.1). */
export const START_FILES_MAX = 10;
export const START_FILE_MAX_BYTES = 26_214_400;
export const START_FILES_TOTAL_BYTES = 52_428_800;

export interface Stats {
  events: number;
  sessions: number;
  machines: number;
  eventsLastMinute: number;
  /** Median event.time → arrivedAt over the last 200 HTTP events, ms. */
  latencyP50Ms?: number;
  storageBytes: number;
  uptimeS: number;
}

export interface Snapshot {
  at: string;
  sessions: SessionSummary[];
  machines: MachineSummary[];
  stats: Stats;
  viewers?: Viewer[];
  /** Plugins' open suggestions (shared/plugin-api.ts); present on the stream's first frame. */
  suggestions?: Suggestion[];
  /** The person's colour labels; present on the stream's first frame. */
  labels?: Labels;
  /** The person's read marks; present on the stream's first frame. */
  marks?: Marks;
  /** Each account's newest usage limits; present on the stream's first frame. */
  limits?: LimitsEntry[];
}

/** A server plugin's suggested answer to an open permission (shared/plugin-api.ts). Advice
 *  only: the receiver holds no key and signs nothing; a person confirms it in the GUI with
 *  their passkey, which sends the ordinary `permission.answer`. Gone when the attention
 *  closes. */
export interface Suggestion {
  session: SessionKey;
  attentionId: string;
  decision: "allow" | "deny";
  /** Who suggested it, as the plugin words it: "Misha on Telegram". */
  by: string;
  /** The plugin that made it. */
  plugin: string;
  note?: string;
  at: string;
}

/** What `GET /api/ui/stream` (SSE) sends. The `event:` field of each SSE frame is the
 *  `kind`; the `data:` field is the JSON of the whole message. The first frame is
 *  always a snapshot. */
export type StreamMessage =
  | { kind: "snapshot"; snapshot: Snapshot }
  | { kind: "event"; event: StoredEvent; session: SessionSummary }
  | { kind: "session"; session: SessionSummary }
  | { kind: "forgotten"; key: SessionKey }
  | { kind: "machine"; machine: MachineSummary }
  | { kind: "stats"; stats: Stats }
  | { kind: "control"; message: ControlActivity }
  | { kind: "viewers"; viewers: Viewer[] }
  | { kind: "suggestion"; suggestion: Suggestion }
  /** The whole label document after a change (small, idempotent; drop one whose `rev`
   *  is older than what the page has). */
  | { kind: "labels"; labels: Labels }
  /** The whole read-marks document after a change, numbered like `labels`. */
  | { kind: "marks"; marks: Marks }
  /** Every account's usage limits after a change: the whole list (small, idempotent). */
  | { kind: "limits"; limits: LimitsEntry[] }
  /** A view's server-side state (THEME_ROUTES.state) was written; `etag` names the new
   *  version, so the page that wrote it can tell its own write from another device's. */
  | { kind: "viewState"; id: string; etag: string }
  /** The search index's status changed (state, progress, counts). At most one a second. */
  | { kind: "searchIndex"; status: SearchIndexStatus }
  /** A workflow run moved (the whole run, `rev` bumped: drop one older than what the page
   *  has); `deleted` when it was taken away. */
  | { kind: "workflowRun"; run: WorkflowRun; deleted?: true }
  /** The saved workflows after a save or a delete (the whole list). */
  | { kind: "workflows"; workflows: Workflow[] };

// ---------- labels (the person's colour labels; GET / PATCH ROUTES.ui.labels) ----------

/** Seven muted colours, Finder's set. Ids, never hex: the colours are tokens
 *  (`--label-red` …) each skin and scheme tunes. */
export type LabelColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "grey";
export const LABEL_COLORS: readonly LabelColor[] = ["red", "orange", "yellow", "green", "blue", "purple", "grey"];
/** A label's own name when the person gave it none. */
export const LABEL_DEFAULT_NAMES: Readonly<Record<LabelColor, string>> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  grey: "Grey",
};
/** A label name's longest form, in characters. */
export const LABEL_NAME_MAX = 32;
/** Labelled sessions the server keeps at most. */
export const LABELS_MAX = 5000;

/** `<stateDir>/labels.json`, as the server serves it. One label per session. */
export interface Labels {
  /** Bumped on every change: a page drops a frame older than what it has. */
  rev: number;
  /** The names the person gave; a colour without one is called by LABEL_DEFAULT_NAMES. */
  names: Partial<Record<LabelColor, string>>;
  sessions: Record<SessionKey, LabelColor>;
}

/** A merge (PATCH): `null` clears. Several keys at once serve a multi-select "Label ▸". */
export interface LabelsPatch {
  sessions?: Record<SessionKey, LabelColor | null>;
  names?: Partial<Record<LabelColor, string | null>>;
}

export const EMPTY_LABELS: Labels = Object.freeze({ rev: 0, names: {}, sessions: {} }) as Labels;

// ---------- marks (what the person has seen; GET / PATCH ROUTES.ui.marks) ----------

/** Keys the server keeps at most in each map of Marks. */
export const MARKS_MAX = 5000;

/** `<stateDir>/marks.json`, as the server serves it: a session is read up to the
 *  `newsAt` it had when it was seen, and the person may mark one unread by hand. */
export interface Marks {
  /** Bumped on every change: a page drops a frame older than what it has. */
  rev: number;
  /** When the file was first made (ISO). News from before it is read. Absent on an older
   *  server, where nothing is unread. */
  since?: string;
  /** The `newsAt` each session had when it was last seen. */
  read: Record<SessionKey, string>;
  /** Marked unread by hand. */
  unread: Record<SessionKey, true>;
  /** Each session's own "Notify me", when not the default ("needs"). Absent on an older
   *  server, where every session is on the default. */
  notify?: Record<SessionKey, Exclude<NotifyLevel, "needs">>;
}

/** How loud a session is: "needs" (the default) notifies when a prompt needs you,
 *  "finishes" also when it has news and is idle or done, "never" not at all. A parent's
 *  own level caps its children's. */
export type NotifyLevel = "needs" | "finishes" | "never";

/** A merge (PATCH): `null` clears. */
export interface MarksPatch {
  read?: Record<SessionKey, string | null>;
  unread?: Record<SessionKey, true | null>;
  /** `null` puts a session back on the default, "needs". */
  notify?: Record<SessionKey, Exclude<NotifyLevel, "needs"> | null>;
}

export const EMPTY_MARKS: Marks = Object.freeze({ rev: 0, read: {}, unread: {} }) as Marks;

// ---------- usage limits (limits.observed; GET ROUTES.ui.limits) ----------

/** One window of an account's limits, as the harness named it (PROTOCOL.md limits.observed). */
export interface LimitWindow {
  /** "five_hour", "seven_day", "seven_day_fable", "primary", "spend_limit" … */
  id: string;
  /** >= 0; above 100 once a spend limit is passed. */
  usedPercent: number;
  /** RFC 3339. Once it has passed, the window has reset: its usedPercent is no longer current. */
  resetsAt?: string;
  windowMinutes?: number;
}

/** The newest limits.observed for one (harness, account), or (harness, machine) when the
 *  events carry no account id. The receiver keeps the numbers; the page words them. An
 *  account's email or host name is never here: it comes from MachineControl.accounts. */
export interface LimitsEntry {
  /** "claude-code a:<account_id>" or "codex m:<machine>". */
  key: string;
  harness: string;
  accountId?: string;
  /** The machine of the newest report. */
  machine: string;
  /** Every machine that reported it, newest first, at most LIMITS_MACHINES_MAX. */
  machines: string[];
  plan?: string;
  /** 1–LIMIT_WINDOWS_MAX, in the event's order. */
  windows: LimitWindow[];
  /** The event's time, clamped to its arrival like every event's. */
  observedAt: string;
}

/** Windows kept per entry, as the protocol allows. */
export const LIMIT_WINDOWS_MAX = 8;
/** Machines remembered per entry. */
export const LIMITS_MACHINES_MAX = 8;
/** Entries the receiver keeps; past it, the one reported longest ago goes. */
export const LIMITS_MAX = 64;

/** A browser connected to this GUI's stream right now: a phone on the LAN, this
 *  laptop's own tab. The receiver's reading of "devices", from the connection only;
 *  nothing is installed on the device. */
export interface Viewer {
  /** Per connection; stable while the SSE stream stays open. */
  id: string;
  /** Remote address as seen by the server; "this machine" when loopback. */
  ip: string;
  loopback: boolean;
  /** Came through the trusted https proxy (`Info.remote`): from outside the LAN. */
  forwarded?: boolean;
  device: "phone" | "tablet" | "laptop" | "desktop" | "unknown";
  /** Short human label from the user agent, e.g. "iPhone · Safari", "Mac · Chrome". */
  label: string;
  connectedAt: string;
  lastSeenAt: string;
  /** True in the copy sent to that very connection. */
  current?: boolean;
}

export interface SessionDetail {
  session: SessionSummary;
  /** Ordered by seq. Paged forwards (`after` is the last seq the client has) or
   *  backwards (`before` is the first seq it has; `tail=1` for the newest page). With
   *  `slim=1` each event is the index's slim copy (`preview` set where data was cut). */
  events: StoredEvent[];
  total: number;
  /** Subagent sessions of this one. */
  children: SessionSummary[];
  /** The seq of `events[0]`; absent when the page is empty. */
  firstSeq?: number;
  /** Whether the session has events before `firstSeq` (for an "older" affordance). */
  hasOlder?: boolean;
}

/** Query of GET /api/ui/sessions/:harness/:id. */
export interface DetailQuery {
  after?: number;
  before?: number;
  /** The newest `limit` events. */
  tail?: boolean;
  limit?: number;
  /** Slim events (big strings cut to a 2 KB preview) instead of the full lines from disk. */
  slim?: boolean;
  /** With `slim`: a shorter cut, 200–2048 chars, for list pages. */
  preview?: number;
  /** Only this subagent's events (an AgentRun id): its subagent.started / .ended, the
   *  tool calls stamped with its `agent_id`, and the Agent / Task call that launched it.
   *  Paged like the whole session; `total` counts the filtered events. */
  agent?: string;
}

export interface FeedPage {
  events: StoredEvent[];
  /** Pass back as `before` for the next (older) page; absent when exhausted. */
  cursor?: string;
}

export interface FeedQuery {
  limit?: number;
  before?: string;
  harness?: string;
  machine?: string;
  type?: string;
  session?: SessionKey;
  q?: string;
}

// ---------- review (search, files changed, daily digest; GET only, all from the index) ----------

export interface SearchQuery {
  q: string;
  limit?: number;
  /** The `cursor` of a previous page. */
  before?: string;
}

/** Where a search hit was found. */
export type SearchField = "user" | "assistant" | "title" | "tool" | "path" | "message";

export interface SearchHit {
  session: SessionSummary;
  /** The slim event the match is in (the preview may not contain the match itself). */
  event: StoredEvent;
  field: SearchField;
  /** Up to ±80 chars around the first match, with `…` where it was cut. */
  snippet: string;
  /** Offsets of the match within `snippet`: [start, end). */
  match: [number, number];
}

export interface SearchPage {
  q: string;
  /** Newest first. */
  hits: SearchHit[];
  /** Pass back as `before` for the next (older) page; absent when exhausted. */
  cursor?: string;
  /** Events looked at for this page, and how long it took. */
  scanned: number;
  ms: number;
}

// ---------- session search (SEARCH-SPEC.md; GET /api/ui/search/sessions and friends) ----------
// The old GET /api/ui/search (SearchPage, one row per event) stays as it is for older
// clients. Everything below is the session-level search: this machine's own agent history
// plus what sessionpipe delivered, one row per session, ranked. One query language for
// the page, ⌘K, the CLI and the API: shared/searchQuery.ts.

/** Where a session's searchable text came from: this machine's own harness logs, or the
 *  events sessionpipe delivered (at the tier they arrived at, never above). */
export type SearchSource = "history" | "sessionpipe";
/** The field of a message. Titles are session metadata, matched separately (`titleMarks`). */
export type SearchDocField = "prompt" | "reply" | "tool";
export type SearchSort = "best" | "newest";
/** [start, end) in UTF-16 code units of the text it belongs to. Never markup. */
export type SearchMark = [start: number, end: number];

/** Filter keys of the query language. Aliases (`harness:`, `is:`, `after:`, `before:`) are
 *  read as these by the parser. */
export type SearchFilterKey = "agent" | "machine" | "repo" | "label" | "since" | "until" | "in" | "source";

/** One match clause. Clauses are ANDed at the session level; `not` drops every session
 *  that has it anywhere. A `word` the engine's tokenizer splits into several terms
 *  (`src/store/review.ts`, `getUserName`) is matched as a phrase of its parts. */
export interface SearchClause {
  kind: "word" | "phrase" | "prefix";
  /** As typed, without quotes, `-` or `*`. */
  text: string;
  not: boolean;
  /** The last bare word while typing (`live` query): a prefix the person has not finished. */
  live?: boolean;
}

/** What a query string was read as. Pure function of the string (+ `live`): the server, the
 *  CLI and the web all get the same answer from `parseSearch`. */
export interface ParsedSearch {
  clauses: SearchClause[];
  /** Positive filters, values as typed (agent aliases already resolved to harness names). */
  filters: Partial<Record<SearchFilterKey, string[]>>;
  /** `-label:red` and the like. */
  notFilters: Partial<Record<SearchFilterKey, string[]>>;
  /** Keys that are not filters (`foo:` in `foo:bar`); that token was searched as text. */
  unknown: string[];
}

/** Query of GET /api/ui/search/sessions. The whole query, filters included, is `q`. */
export interface SessionSearchQuery {
  q: string;
  /** Default "best". A filter-only query (no clauses) always browses newest first. */
  sort?: SearchSort;
  /** Sessions per page; default 20, at most 100. */
  limit?: number;
  /** The `cursor` of the previous page. */
  cursor?: string;
  /** Typing: the last bare word is a prefix. The page and ⌘K send 1; the CLI does not. */
  live?: boolean;
  /** The viewer's `Date.prototype.getTimezoneOffset()`, for `since:today` and dates. */
  tz?: number;
  /** Hits per session, 0–3; default 3 (⌘K asks 1). */
  hits?: number;
}

/** One moment in a session that matched. */
export interface SessionSearchHit {
  field: SearchDocField;
  /** The tool's name on a tool line (the UI words it with `toolLabel`). */
  tool?: string;
  /** Set when the message is a subagent's (Claude agentId, Codex child thread). */
  agent?: { id: string; type?: string };
  at: string;
  /** A window of at most 240 chars around the hits, whitespace folded, `…` at cuts. */
  text: string;
  /** Into `text`. The UI renders these and never re-matches. */
  marks: SearchMark[];
  /** Opaque, URL-safe, stable while the source file is unchanged: the transcript view's
   *  anchor (`/s/<harness>/<id>?q=…#h-<ref>`) and its `around=`. */
  ref: string;
  /** A sessionpipe event's seq: the live session view's `#seq-N`. */
  seq?: number;
  /** Found in bytes appended since the last index commit (a reading, not a state). */
  live?: true;
}

/** One session in the results. */
export interface SessionMatch {
  /** `sessionKey(harness, id)` with the receiver's harness names: the store's key. */
  key: SessionKey;
  harness: string;
  id: string;
  source: SearchSource | "both";
  /** Never an id: the store's title, else the history's best title, else the first ask cut
   *  on a word, else "Untitled session". */
  title: string;
  titleMarks?: SearchMark[];
  machine?: string;
  /** The session ran on the machine the server runs on. */
  thisMachine: boolean;
  /** Claude account home label (`work` for ~/.claude-work) when this machine has several. */
  account?: string;
  repo?: string;
  cwd?: string;
  branch?: string;
  firstAt: string;
  lastAt: string;
  /** When the store knows the session: live state, counts (labels are keyed by `key`). */
  summary?: SessionSummary;
  /** 1–3, in transcript order (chosen by score, or newest under sort=newest). */
  hits: SessionSearchHit[];
  /** Matching messages beyond `hits`. */
  moreHits: number;
  /** The exact line to paste in a terminal, only for a harness whose resume is verified
   *  (Claude Code, Codex): `cd '<cwd>' && claude --resume <id>`, `codex resume <id>`. */
  resume?: string;
  /** The session's main transcript file. Only to a viewer on this machine. */
  transcriptPath?: string;
  /** A Claude fork: the session it continues. */
  forkOf?: SessionKey;
  score: number;
}

/** When a query has no results: the first fix that applies, decided by the server. */
export interface SearchHint {
  kind: "filters" | "phrase" | "spelling" | "exclude" | "indexing" | "none";
  /** The rewritten query the hint's button runs. */
  query?: string;
  /** The word the hint is about (`spelling`: the near word; `exclude`: the excluded one). */
  word?: string;
}

export type SearchIndexState = "ready" | "updating" | "first-run" | "off" | "error";

export interface SearchIndexStatus {
  state: SearchIndexState;
  sessions: number;
  messages: number;
  /** 0–1 while `first-run` (bytes read over bytes found). */
  progress?: number;
  /** On disk, both indexes. */
  bytes: number;
  updatedAt?: string;
  /** The setting: read this machine's agent history (default on). */
  history: boolean;
  /** Per source, only those present on this machine (no zero rows). */
  sources: { harness: string; source: SearchSource; homes: string[]; sessions: number }[];
  /** Files found but not readable here, said once in the popover (`zstd`: Codex's
   *  compressed rollouts on a Node without zstd and no `zstd` command). */
  skipped?: { harness: string; files: number; why: "zstd" | "unreadable" }[];
  /** A sentence, when `error`. */
  error?: string;
  /** The viewer is on this machine (may toggle history, rebuild, reveal). Only on the
   *  GET /status and POST answers, never in the `searchIndex` stream frame. */
  local?: boolean;
}

export interface SessionSearchPage {
  q: string;
  sort: SearchSort;
  parsed: ParsedSearch;
  sessions: SessionMatch[];
  /** Sessions matching, exact up to 200; `more` past that. */
  total: number;
  more: boolean;
  cursor?: string;
  ms: number;
  index: SearchIndexStatus;
  /** Set when `sessions` is empty. */
  hint?: SearchHint;
}

/** One message of a transcript read from the index (prompts, replies, one line per tool
 *  call; tool output is never indexed, so never shown). */
export interface SearchTranscriptMessage {
  ref: string;
  field: SearchDocField;
  tool?: string;
  agent?: { id: string; type?: string };
  at: string;
  /** The whole message (redacted, at most 32 K chars). */
  text: string;
  seq?: number;
}

/** GET /api/ui/search/transcript/:harness/:id?q=&around=<ref>|before=<ref>|after=<ref>&limit= */
export interface SearchTranscript {
  /** `hits` empty here; the find bar uses `hits` below. */
  session: SessionMatch;
  /** A window in transcript order (60 by default, centred on `around`). */
  messages: SearchTranscriptMessage[];
  /** Every message in the whole session matching `q`'s clauses, in transcript order, with
   *  marks into that message's `text`: the find bar's "2 of 7". */
  hits: { ref: string; marks: SearchMark[] }[];
  /** Cursors for the window before / after this one, when there is more. */
  before?: string;
  after?: string;
}

export interface SearchFacet {
  value: string;
  count: number;
  /** A display name when it differs from the value (`Claude Code`, a label's own name). */
  label?: string;
}

/** GET /api/ui/search/facets: values present in the index, for the chips and completion. */
export interface SearchFacets {
  agents: SearchFacet[];
  machines: SearchFacet[];
  repos: SearchFacet[];
  labels: SearchFacet[];
}

/** POST /api/ui/search/settings (this machine only). */
export interface SearchSettings {
  history: boolean;
}

/** POST /api/ui/search/reveal (this machine only, a session that ran here). */
export interface SearchRevealRequest {
  harness: string;
  id: string;
  what: "folder" | "transcript";
}

// ---------- one session's files (GET ROUTES.ui.session/:harness/:id/files) ----------

/** One tool call on a file, as the index saw it (shared/files.ts `indexTouches`). */
export interface SessionFileTouch {
  /** The end's seq once the tool ended, else the start's. */
  seq: number;
  at: string;
  tool: string;
  kind: "read" | "edit" | "write" | "patch" | "notebook" | "changed";
  /** `tool.ended` with `ok: false`. */
  failed?: true;
  /** A `tool.started` with no end yet. */
  pending?: true;
  /** The event's input or output was cut in the index (the full event is on disk). */
  cut?: true;
}

export interface SessionFile {
  /** Repo-relative, as `relativePath` gives it. */
  path: string;
  /** As the harness named it. */
  given: string;
  /** Ascending by seq. */
  touches: SessionFileTouch[];
}

/** Every file the session's tools named, from the index alone (no disk read); the page
 *  follows live events after `lastSeq`. */
export interface SessionFiles {
  files: SessionFile[];
  /** The highest seq the index held when this was read; -1 for a session with no events. */
  lastSeq: number;
}

/** Query of GET /api/ui/files. `since` is an ISO time; `repo` an exact `session.repo`. */
export interface FilesQuery {
  since?: string;
  repo?: string;
}

export interface FilesSession {
  key: SessionKey;
  title: string;
  /** files.changed events of this session naming the path. */
  count: number;
  lastAt: string;
}

export interface FilesPath {
  path: string;
  count: number;
  lastAt: string;
  /** Newest first. */
  sessions: FilesSession[];
}

export interface FilesRepo {
  /** `session.repo`, or "" when the session has none (the UI shows the cwd then). */
  repo: string;
  lastAt: string;
  /** Distinct sessions that touched something in this repo. */
  sessions: number;
  /** Newest first. */
  paths: FilesPath[];
}

export interface FilesPage {
  since: string;
  /** Newest first. */
  repos: FilesRepo[];
  /** Distinct paths across all repos. */
  total: number;
}

/** Query of GET /api/ui/digest: a local day and that place's UTC offset in minutes, as
 *  `Date.prototype.getTimezoneOffset` gives it (UTC minus local: -420 for UTC-7). */
export interface DigestQuery {
  /** YYYY-MM-DD; today when absent. */
  day?: string;
  tz?: number;
}

export interface DigestCounts {
  events: number;
  turns: number;
  tools: number;
  errors: number;
  attentions: number;
  compactions: number;
  /** Distinct paths from files.changed. */
  filesTouched: number;
}

export interface DigestSession extends DigestCounts {
  key: SessionKey;
  title: string;
  harness: string;
  machine?: string;
  repo?: string;
  /** First and last event of the session within the day (ISO). */
  startedAt: string;
  endedAt: string;
  /** endedAt − startedAt, ms. */
  activeMs: number;
}

export interface DigestGroup extends DigestCounts {
  name: string;
  sessions: number;
  activeMs: number;
}

export interface Digest {
  day: string;
  tz: number;
  /** The day's bounds in UTC (ISO). */
  from: string;
  to: string;
  /** By first event of the day. */
  sessions: DigestSession[];
  byMachine: DigestGroup[];
  byRepo: DigestGroup[];
  totals: DigestGroup;
}

export interface Info {
  name: "sessionpipe-gui";
  version: string;
  startedAt: string;
  port: number;
  /** `local` and `lan` are plain http (sinks, the daemon, the trust page); `https` is
   *  the secure origin TLS mode serves (`Info.tls`); `public` the one a trusted reverse
   *  proxy on this machine serves from anywhere (`Info.remote`). */
  urls: { local: string; lan: string[]; https?: string; public?: string };
  /** The `sessionpipe sink add …` line for another machine, with the LAN URL and the token. */
  sinkCommand: string;
  sinkToken: string;
  /** Appended as `?k=` to the LAN URL so a phone can open the UI; embedded in the QR. */
  uiKey: string;
  sources: {
    http: true;
    outbox: { path: string; sessions: number; enabled: boolean; events?: number } | null;
    demo: boolean;
  };
  /** `bytes` is everything under `dir`: the event files, plus `attachments` (the images
   *  uploaded from the composer, ROUTES.ui.attachments). Absent on older servers. */
  storage: { dir: string; bytes: number; attachments?: number };
  wellKnown: Record<string, unknown>;
  /** `origins`: the browser origins passkeys made for `rpId` work on, so a visitor on the
   *  wrong address can be sent to the right one: the public url when it set the rp id,
   *  `https://<rpId>:<port>` for the TLS name, `http://localhost:<port>` only when the rp
   *  id is `localhost`. Absent on older servers. */
  control: { enabled: boolean; rpId: string; machines: number; origins?: string[]; keyTypes?: KeyType[] };
  /** TLS mode (`--tls`): the same port also answers https with a certificate from the
   *  GUI's own local CA, so passkeys work from a phone. Absent on older servers. */
  tls?: TlsInfo;
  /** What sessionpipe calls this machine: `os.hostname()` without a `.local` / `.lan` /
   *  `.home` suffix. A session whose `machine` matches runs here, so a file path on this
   *  machine means something to it. Absent on older servers. */
  hostname?: string;
  /** Reached from anywhere (`--public-url`): a trusted https reverse proxy on this machine,
   *  Tailscale's `tailscale serve` for one, forwards to the port. Absent when not set up. */
  remote?: RemoteInfo;
}

/** The GUI from outside the LAN. The proxy terminates https with a certificate browsers
 *  already trust, so no CA to install; it runs on this machine and forwards to the port,
 *  and the server trusts its `X-Forwarded-For` / `-Proto` / `-Host` on connections from
 *  loopback (so a visitor is never mistaken for this machine). The rp id is the url's host,
 *  so passkeys made for the `.local` name must be made again under this one. */
export interface RemoteInfo {
  /** The https origin, e.g. `https://laptop.tail1234.ts.net`; `Info.control.rpId` is its host. */
  url: string;
  host: string;
  /** For a machine elsewhere: push events, and pair control, through the same url. */
  sinkCommand: string;
  connectCommand: string;
}

// ---------- attachments (images sent beside a control prompt; shared/attachments.ts) ----------

export type AttachmentType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** An image uploaded from the composer (POST ROUTES.ui.attachments). The control
 *  protocol carries text only, so the prompt names it instead: by `path` when the
 *  session runs on this machine, by `url` otherwise (shared/attachments.ts). */
export interface Attachment {
  /** A ULID; the file is `<id>.<ext>` under `<stateDir>/attachments`. */
  id: string;
  type: AttachmentType;
  ext: "png" | "jpg" | "gif" | "webp";
  /** Absolute path on the machine the GUI runs on. */
  path: string;
  /** Absolute URL another machine can fetch: the https origin when TLS is on, else the
   *  first LAN URL, with `?k=<ui key>` so no cookie is needed. */
  url: string;
  width: number;
  height: number;
  bytes: number;
}

/** One image at most; the composer refuses a bigger file before uploading. */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
/** Images per message. */
export const ATTACHMENTS_PER_MESSAGE = 6;
export const ATTACHMENT_TYPES: Record<AttachmentType, Attachment["ext"]> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** What a page needs to get a phone onto the https origin (ROUTES.trust explains the steps). */
export interface TlsInfo {
  on: boolean;
  /** The mDNS name the certificate and the rp id are made for: `<machine>.local`. */
  hostname: string;
  /** `https://<hostname>:<port>`, the only origin passkeys work on when TLS is on. */
  httpsUrl: string;
  /** Plain-http `GET /ca.crt` on the first LAN address (the phone downloads the CA here). */
  caUrl: string;
  /** SHA-256 of the CA certificate, `AB:CD:…`, to compare on the phone before trusting. */
  caFingerprint: string;
  /** When the server certificate expires (ISO). */
  expiresAt: string;
}

// ---------- setup (the first-run page; GET /api/ui/setup/status, this machine only) ----------

/** Live facts the /setup page polls every two seconds. Nothing here is cached. */
/** One harness of the protocol registry (sessionpipe's spec/ADAPTERS.md) as the setup page
 *  sees it on this machine (`server/setup/harnesses.ts`). Every registry name is listed,
 *  installed or not; the page shows the installed ones. */
export interface HarnessStatus {
  /** The registry name: `claude-code`, `codex`, `gemini-cli`, `antigravity`, `cursor`, … */
  name: string;
  /** The product's name: "Claude Code", "Gemini CLI". */
  label: string;
  /** The app or CLI is on this machine: its config dir, its app bundle, or its command on the PATH. */
  installed: boolean;
  /** `on`: the harness's hooks config names sessionpipe · `off`: installed, but the hooks are
   *  not written yet (`npx sessionpipe install`) · `unsupported`: sessionpipe has no adapter
   *  for it yet (the registry's M7 rows: cursor, copilot-cli, droid, kiro, opencode). */
  hooks: "on" | "off" | "unsupported";
  /** Where that harness reads its hooks (the file `sessionpipe install` writes). */
  configPath: string;
  /** This machine's sessions in the store for this harness, and their latest event (ISO). */
  sessions: number;
  lastEventAt?: string;
}

export interface SetupStatus {
  sessionpipe: {
    /** A `sessionpipe` CLI on the PATH or at ~/.local/bin. */
    installed: boolean;
    path?: string;
    version?: string;
    outbox: { path: string; present: boolean; sessions: number };
  };
  events: { total: number; lastAt?: string };
  /** The registry's harnesses on this machine, in registry order (disk probed every 10 s). */
  harnesses: HarnessStatus[];
  tls: {
    on: boolean;
    hostname: string;
    httpsUrl: string;
    /** The rp id passkeys are made for right now (`localhost`, or the hostname with TLS mode). */
    rpId: string;
    caFingerprint?: string;
    /** macOS: the system trusts the CA for SSL (`security verify-cert`); null where we cannot tell. */
    caTrusted: boolean | null;
    opensslPresent: boolean;
    /** Whether this machine resolves its own `.local` name (dns.lookup, 1.5 s). */
    mdns: { resolves: boolean; address?: string };
  };
  daemon: {
    /** The daemon's control socket exists and answers a status request. */
    running: boolean;
    /** What the daemon calls this machine, when it answered. */
    name?: string;
    /** Control has a paired machine with this machine's name. */
    pairedHere: boolean;
    online: boolean;
    machineId?: string;
    /** A pairing for this machine waiting for approval (from control, or from the child `control pair` started here). */
    pendingPairing?: { code: string; check: string; expiresAt: string };
    /** The `sessionpipe control pair` child this server started, if any. */
    pairing: { active: boolean; exitCode?: number | null; error?: string };
    /** Folders this machine's sessions ran in, for the pairing's allowlist (`~` expanded). */
    suggestedFolders: string[];
  };
  viewers: { phones: number };
  /** Control messages that reached `delivered` (step 5 turns green after the first one). */
  tried: { delivered: number };
  /** Step 6, optional: the GUI from anywhere through a trusted https proxy (`Info.remote`). */
  remote: {
    /** `--public-url`, when set (also remembered in config.json). */
    publicUrl?: string;
    /** Tailscale on this machine, the proxy the setup page recommends: `tailscale status`
     *  answered (`running`), this node's MagicDNS name without the trailing dot, and whether
     *  `tailscale serve` already forwards to this port (null when it could not tell). */
    tailscale: { installed: boolean; running: boolean; dnsName?: string; ips?: string[]; serving: boolean | null };
    /** Browsers on the stream that came through the proxy (a forwarded address). */
    viewers: number;
  };
  platform: string | string;
  uiKey: string;
}

// ---------- phone (connecting a phone; GET /api/ui/phone, server/phone) ----------

/** Everything the "connect a phone" flow needs in one read, polled while the page is open.
 *  `lan` is "see it on your phone": the plain-http LAN url with the UI key (the trust page
 *  first when TLS is on), as a QR. The rest is "send from your phone": a passkey on a real
 *  https origin, through Tailscale (`tailscale serve` → `publicUrl`) or the local CA
 *  (`tls`), and the devices the paired machines trust or that wait to be. */
export interface PhoneInfo {
  lan: {
    url: string;
    /** A `data:image/png;base64,…` URI of the url, for an <img>. */
    qr: string;
  };
  /** The rp id passkeys are made for right now (`Info.control.rpId`). */
  rpId: string;
  /** TLS mode is on (the local CA path is available). */
  tls: boolean;
  /** `--public-url`, when set: the https origin a phone opens from anywhere. */
  publicUrl: string | null;
  tailscale: {
    installed: boolean;
    running: boolean;
    /** This node's MagicDNS host (`laptop.tail1234.ts.net`), when connected. */
    name: string | null;
    /** `tailscale serve` already forwards to this port. */
    serving: boolean;
  };
  /** The passkeys the paired machine(s) trust, as the GUI sees them: one row per key id. */
  trusted: PhoneTrustedKey[];
  /** Device requests waiting for a trusted device's approval, newest first. */
  pending: PhonePendingDevice[];
}

export interface PhoneTrustedKey {
  id: string;
  /** The name given at enrolment; "" when none was. */
  name: string;
  addedAt: string;
}

export interface PhonePendingDevice {
  /** The device request id (ROUTES.ui.phone + `/device/:id` reads it back). */
  id: string;
  name: string;
  /** The six digits shown on both ends. */
  digits: string;
  since: string;
}

/** GET /api/ui/phone/device/:id: what the phone polls after making its passkey. `pending`
 *  until a trusted device's `key.add` is delivered (`trusted`), refused by the machine or
 *  rejected on the approving device (`refused`), or ten minutes pass (`expired`). An id
 *  the server does not know reads `refused`. `machine` is the name of the machine that
 *  trusts it, once one does. */
export interface PhoneDeviceState {
  state: "pending" | "trusted" | "refused" | "expired";
  digits: string;
  machine: string | null;
}

/** POST /api/ui/phone/trust-check: `https` is true when the request itself arrived over
 *  TLS (or through the trusted https proxy), which is the proof that the phone's trust of
 *  the CA, or its Tailscale route, works. */
export interface PhoneTrustCheck {
  https: boolean;
  rpId: string;
}

// ---------- control (phase 2; shapes fixed now so both sides can plan) ----------

/** An ack's `applied` (control-ack.json): what a start ran with. */
export interface Applied {
  permission?: RunLevel;
  model?: string;
}

/** `pool` (sessionpipe 0.11): a machine-level command on `POOL_SESSION`, verified like a
 *  `key.add` (server/control/pool.ts); its fields are `pool_action`, `pool_account`,
 *  `pool_order` and `pool_code`. */
export type ControlKind = "prompt" | "permission.answer" | "cancel" | "start" | "key.add" | "pool";
export type ControlOutcome = "progress" | "taken" | "delivered" | "expired" | "unsupported" | "failed" | "refused";

/** A control message the receiver carries, as the UI sees it (never the raw signature). */
export interface ControlActivity {
  id: string;
  machineId: string;
  kind: ControlKind;
  session?: SessionKey;
  text?: string;
  at: string;
  expiresAt: string;
  outcome?: ControlOutcome;
  mode?: string;
  code?: string;
  detail?: string;
  reply?: string;
  replySeq?: number;
  /** The session the final ack named (a fork, or the session a start created), when it differs. */
  ackSession?: string;
  takenAt?: string;
  ackedAt?: string;
  /** A start's folder, as signed: the starting page shows it and "Edit and start again" puts it back. */
  cwd?: string;
  /** A start's level and model, as signed (what was asked, never what ran). */
  permission?: StartPermission;
  model?: string;
  /** A start's files, as signed. */
  files?: StartFile[];
  /** What the machine ran it with, from its `taken` / `delivered` ack (sessionpipe 0.10);
   *  `inherit` when it ran with no permission flag. */
  applied?: Applied;
  /** A `pool` command's action and, when it names one, its account (or pending login id),
   *  as signed. The machine's answer is `detail`: the pool's summary line once delivered
   *  ("on · 3 accounts · 2 with room · serving Fiction"), or, for `login.begin`,
   *  "<pending login id> <URL>" (web/src/lib/pool.ts `loginFromDetail` reads it). */
  poolAction?: PoolAction;
  poolAccount?: string;
  /** A handoff: the session the answer is relayed into, as signed (`reply_to` on a
   *  `prompt` or a `start`, CONTROL.md §3.1). */
  replyTo?: SessionKey;
  /** The GUI's own unsigned note of which session's page sent it (`SendBody.from`): the
   *  lineage shown while the events are on their way. Never part of the command. */
  from?: SessionKey;
}

/** POST ROUTES.ui.control + `/send`: the signed command and how it was signed (a day key
 *  under a passkey grant, or one passkey confirm), as `server/control/README.md` lays it
 *  out. `from` is the UI's note of the session whose page sent it: unsigned, stored on
 *  the activity (`ControlActivity.from`), never carried to the machine. */
export interface SendBody {
  machineId: string;
  cmd: string;
  csig?: string;
  grant?: Record<string, unknown>;
  confirm?: Record<string, unknown>;
  expires_in_s?: number;
  from?: SessionKey;
}

// ---------- orchestrate (workflows across agents and machines; server/orchestrate) ----------

/** Who a step asks: a new session of a harness on the step's machine (the browser signs a
 *  `start`), or an existing session there (a `prompt`). */
export type StepAgent = { harness: string } | { session: SessionKey };

export interface WorkflowStep {
  /** Unique within the workflow: letters, digits, `_`, `-`, at most 40. */
  id: string;
  name?: string;
  machineId: string;
  agent: StepAgent;
  /** A new session's folder; absent, the runner takes the machine's first folder. */
  cwd?: string;
  /** The prompt, with `{{input}}` (the run's input), `{{prev}}` (the reply of the step(s)
   *  it runs after, joined by a blank line) and `{{step.<id>}}` (a named earlier step's
   *  reply). Any other placeholder, or one with nothing to fill it, fails at save. */
  text: string;
  permission?: StartPermission;
  model?: string;
  /** The steps it runs after: absent, the step before it in the list; `[]`, a root. Only
   *  earlier steps may be named, so a workflow is always a DAG. */
  after?: string[];
}

export interface Workflow {
  id: string;
  name: string;
  /** Set, Run asks for an input first (`{{input}}`). */
  input?: { label: string };
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
  /** The template it was made from, when one was. */
  template?: string;
}

/** The most steps a workflow has, and the longest a step's text may be. */
export const WORKFLOW_STEPS_MAX = 20;
export const WORKFLOW_TEXT_MAX = 20_000;

export type RunStatus = "running" | "waiting" | "done" | "failed" | "cancelled";
/** pending: waiting on the steps before it. ready: the signer may claim it. sending: a tab
 *  claimed it and is signing. sent: its command is queued (`commandId`). done / failed:
 *  the command's final ack. skipped: a step before it failed, or the run was cancelled. */
export type StepStatus = "pending" | "ready" | "sending" | "sent" | "done" | "failed" | "skipped";

export interface StepRun {
  status: StepStatus;
  /** The prompt with its placeholders filled, once the step is ready. */
  text?: string;
  /** The queued command (`ControlActivity.id`), once sent. */
  commandId?: string;
  /** The session the ack named (the one a start made, a fork), else the one the command named. */
  session?: SessionKey;
  reply?: string;
  /** `failed`: the machine's `code: detail`, or the receiver's word. */
  error?: string;
  /** When it became ready, was claimed and was sent (ISO); the server's clocks for the
   *  signer rule and for a claim that never came back. */
  readyAt?: string;
  claimedAt?: string;
  sentAt?: string;
  endedAt?: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  /** The workflow's name when the run started. */
  name: string;
  /** Bumped on every change; a claim names it in `If-Match`. */
  rev: number;
  status: RunStatus;
  input?: string;
  startedAt: string;
  endedAt?: string;
  /** The steps as they were when the run started: what the server resolves and the
   *  browser signs from, so an edit or a delete of the workflow never changes a run. */
  plan: WorkflowStep[];
  steps: Record<string, StepRun>;
  /** `waiting`: for a device that can sign (a step ready for over WAITING_SIGNER_MS and
   *  nobody claimed it), or for the step's machine to come online. */
  waitingFor?: "signer" | "machine";
}

/** A `ready` step nobody claimed for this long reads `waiting` for a signer. */
export const WAITING_SIGNER_MS = 2_000;

/** Query of POST ROUTES.ui.workflows + `/:id/run`. */
export interface RunBody {
  input?: string;
}

// ---------- extras (the curated catalogue; server/extensions/catalog.ts) ----------

export type ExtraKind = "view" | "skin" | "plugin";

export interface ExtraEntry {
  /** The manifest id the installed folder gets. */
  id: string;
  kind: ExtraKind;
  name: string;
  /** The npm package name it would install from, kept for the day the packages are
   *  published; today every entry ships inside the GUI and nothing installs from npm. */
  npm: string;
  /** One line. */
  line: string;
  /** What it weighs as packed, rounded ("59 kB"). */
  size: string;
  /** Ships inside the GUI's package: nothing to install. */
  bundled?: boolean;
}

export interface ExtrasResponse {
  extras: (ExtraEntry & { installed: boolean })[];
}

// ---------- routes ----------

export const ROUTES = {
  wellKnown: "/.well-known/sessionpipe",
  events: "/api/sessionpipe/v1/events",
  control: "/api/sessionpipe/v1/control",
  native: "/api/sessionpipe/v1/native",
  /** GET, plain http, UI key: the steps that get a phone to trust the local CA (TLS mode). */
  trust: "/trust",
  /** GET, UI key: the CA certificate as a download (`application/x-x509-ca-cert`). */
  caCert: "/ca.crt",
  ui: {
    info: "/api/ui/info",
    snapshot: "/api/ui/snapshot",
    stream: "/api/ui/stream",
    /** GET /api/ui/sessions/:harness/:id?after=|before=<seq>&tail=1&limit=<n>&slim=1 → SessionDetail;
     *  GET /api/ui/sessions/:harness/:id/files → SessionFiles (the whole session's files, from the index) */
    session: "/api/ui/sessions",
    /** GET /api/ui/events?<FeedQuery> → FeedPage */
    feed: "/api/ui/events",
    /** POST /api/ui/sessions/:harness/:id/forget */
    forget: "/api/ui/sessions",
    /** POST → { sinkToken } */
    rotateToken: "/api/ui/token/rotate",
    /** POST { on: boolean } → Info.sources.demo */
    demo: "/api/ui/demo",
    /** GET → image/svg+xml: the LAN URL with the UI key, for a phone camera. */
    qr: "/api/ui/qr.svg",
    /** Everything under it is the control channel's UI side (server/control/README.md),
     *  POST /files among it: one file a start will carry, as the raw body → StartFile. */
    control: "/api/ui/control",
    /** GET → { viewers: Viewer[] } */
    viewers: "/api/ui/viewers",
    /** GET /api/ui/search?q=&limit=&before= → SearchPage */
    search: "/api/ui/search",
    /** Session search (SEARCH-SPEC.md). UI key like every /api/ui route; the POSTs are
     *  this machine only (403 `local_only` otherwise).
     *  GET  /sessions?<SessionSearchQuery> → SessionSearchPage
     *  GET  /transcript/:harness/:id?q=&around=|before=|after=&limit= → SearchTranscript (404 `not_found`)
     *  GET  /facets → SearchFacets
     *  GET  /status → SearchIndexStatus (also `searchIndex` stream frames)
     *  POST /reindex { rebuild?: boolean } → 202 SearchIndexStatus
     *  POST /settings SearchSettings → SearchIndexStatus
     *  POST /reveal SearchRevealRequest → 204; 404 `gone` (the folder is no longer here) */
    searchSessions: "/api/ui/search/sessions",
    searchTranscript: "/api/ui/search/transcript",
    searchFacets: "/api/ui/search/facets",
    searchStatus: "/api/ui/search/status",
    searchReindex: "/api/ui/search/reindex",
    searchSettings: "/api/ui/search/settings",
    searchReveal: "/api/ui/search/reveal",
    /** GET /api/ui/files?since=<iso>&repo= → FilesPage */
    files: "/api/ui/files",
    /** GET /api/ui/digest?day=YYYY-MM-DD&tz=<minutes> → Digest */
    digest: "/api/ui/digest",
    /** GET → ColorThemesResponse: the JSON files under <stateDir>/color-themes. */
    colorThemes: "/api/ui/color-themes",
    /** First-run setup, this machine only (loopback or one of its own addresses; 403 otherwise):
     *  GET /status → SetupStatus; POST /tls/on, /tls/trust, /pair, /pair/cancel. */
    setup: "/api/ui/setup",
    /** POST, UI key: an image as the raw body (`content-type: image/png|jpeg|gif|webp`) or
     *  as multipart/form-data file parts → Attachment (one file), or { attachments } (several).
     *  413 `too_large` over ATTACHMENT_MAX_BYTES, 415 `unsupported_type`, 400 `not_an_image`. */
    attachments: "/api/ui/attachments",
    /** GET → ExtrasResponse: the curated catalogue of official views, skins and plugins
     *  with what is installed. POST /api/ui/extras/:id/install (loopback): install one
     *  from npm; streams text/plain and ends with a line `ok` or `failed`. */
    extras: "/api/ui/extras",
    /** Connecting a phone (server/phone): GET → PhoneInfo; POST /tailscale (loopback:
     *  `tailscale serve --bg <port>`, then the public url, → PhoneInfo, or { error });
     *  GET /device/:id → PhoneDeviceState; POST /trust-check → PhoneTrustCheck. */
    phone: "/api/ui/phone",
    /** GET → Labels; PATCH LabelsPatch (application/json) → Labels. 400 `malformed` /
     *  `bad_label` / `bad_name`, 404 `not_found` (a session the store does not know), 413
     *  `too_many` / `too_large`, 415 `json_only`. Every change is a `labels` stream frame. */
    labels: "/api/ui/labels",
    /** GET → Marks; PATCH MarksPatch (application/json) → Marks. 400 `malformed` /
     *  `bad_read` / `bad_unread` / `bad_notify`, 413 `too_large`, 415 `json_only`. A key
     *  the store does not know is skipped. Every change is a `marks` stream frame. */
    marks: "/api/ui/marks",
    /** GET → { limits: LimitsEntry[] }, each account's newest limits.observed. Every change
     *  is a `limits` stream frame. */
    limits: "/api/ui/limits",
    /** POST { key } (application/json) → 204: forget one entry's numbers (its next report
     *  brings it back), and a `limits` frame. 400 `malformed`, 404 `not_found`, 415 `json_only`. */
    limitsForget: "/api/ui/limits/forget",
    /** Workflows (server/orchestrate; ARCHITECTURE.md "UI API"), UI key like the rest.
     *  Every write takes JSON only, an empty POST too (415 `json_only`), and 403
     *  `cross_site` when the browser marks it from another site: a write here sets a
     *  signer to work. GET → { workflows, runs } · PUT /:id (the whole Workflow) →
     *  Workflow; 400 `malformed` / `bad_step`, 413 `too_large` (WORKFLOW_STEPS_MAX,
     *  WORKFLOW_TEXT_MAX; a step's resolved text is cut to fit, never refused) · DELETE
     *  /:id → 204 · POST /:id/run RunBody → 201 WorkflowRun · PATCH /runs/:id with
     *  `If-Match: <rev>`: { step, status: "sending" } (a claim), { step, send: SendBody }
     *  (the signed command: verified as /send does, queued and the step marked sent in one
     *  move, or nothing queued: 412 when the step is no longer this claim's, 422 with the
     *  verifier's `code` for a signer's fault; a refusal of the command itself fails the
     *  step and answers with the run) or { step, commandId } (a command queued through
     *  /send: the test door) → WorkflowRun; 412 `conflict` with the current run when the
     *  rev moved or the step is not where the patch expects it · POST /runs/:id/cancel
     *  `{}` → WorkflowRun · DELETE /runs/:id → 204. Every change is a `workflowRun` or
     *  `workflows` stream frame. */
    workflows: "/api/ui/workflows",
  },
  /** GET / DELETE /attachments/<id>.<ext>, UI key: the uploaded image itself (served
   *  `private, immutable`), and taking it back. */
  attachments: "/attachments",
} as const;

export const DEFAULT_PORT = 7373;
export const UI_KEY_COOKIE = "spgui";
export const UI_KEY_PARAM = "k";
