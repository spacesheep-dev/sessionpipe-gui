// SPDX-License-Identifier: Apache-2.0
// The store's readings (ARCHITECTURE.md "The store's readings"): a pure reducer from
// protocol events to a SessionSummary, and the state machine over it. Nothing here
// touches a file or a timer; store.ts drives it.
import {
  AGENTS_MAX,
  type AgentRun,
  type Attention,
  type AttentionKind,
  COMPACTING_WINDOW_MS,
  DELEGATIONS_MAX,
  type Delegation,
  DONE_AFTER_MS,
  type EventSource,
  GAP_AFTER_MS,
  type ProtocolEvent,
  type SessionFlag,
  type SessionState,
  type SessionSummary,
  SLOW_TOOL_MS,
  SNIPPET_CHARS,
  STALE_AFTER_MS,
  sessionKey,
  type Tier,
  type TurnStats,
} from "../../shared/api.js";
import { SESSION_REF } from "../control/parse.js";
import { changedPaths } from "./paths.js";
import { detach, PREVIEW_CHARS } from "./slim.js";

const TITLE_RANK: Record<string, number> = { custom: 3, harness: 2, "first-ask": 1 };
/** `<harness>:<id>` in the protocol's own shapes (schemas/v1/event.json): a harness name is
 *  `^[a-z][a-z0-9-]{0,39}$`, a session id up to 128 of `[A-Za-z0-9._:-]`. */
const LAUNCHER_KEY_RE = /^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$/;
const ATTENTION_KINDS = new Set<string>(["permission", "question", "elicitation", "idle", "error"]);

/** Events a worker derives from files or clocks rather than a harness hook. Only a
 *  hook event proves the harness moved on, so only a hook event closes an attention
 *  (CONTROL.md §7). A status line redraws on its own clock, prompt open or not, so the
 *  usage limits it reports (limits.observed) are not one either. */
const NOT_HOOK = new Set([
  "turn.progress",
  "turn.transcript",
  "session.heartbeat",
  "session.backfill",
  "limits.observed",
]);

/** `turn.started.submitted_by`: a bare word (PROTOCOL.md §4), kept as the harness sent it. */
const SUBMITTED_BY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

/** tool.started kept for the loop reading. */
const LOOP_WINDOW = 10;
/** Identical starts within the window that make a loop. */
const LOOP_MIN = 3;
/** Consecutive tool errors that make a streak. */
const STREAK_MIN = 3;
/** A hole wider than this is a sink that joined mid-session, not events on their way. */
const GAP_MAX_HOLE = 100;
/** Turn durations kept for the median. */
const TURN_SAMPLES = 64;

/** What the flags and turnStats are read from; rebuilt with the summary. */
export interface Tracking {
  /** Consecutive tool.ended with ok: false, and the time of the first. */
  errStreak: number;
  errSince?: string;
  /** The last LOOP_WINDOW tool.started; `hash` only at tier 3 with an input. */
  starts: { tool: string; at: string; hash?: string }[];
  /** context.compacted times (ISO), pruned to COMPACTING_WINDOW_MS behind the last event. */
  compactions: string[];
  /** turn.ended seen, and the durations known of them, newest last, at most TURN_SAMPLES. */
  turnsEnded: number;
  turnMs: number[];
  /** The span of seqs seen (-1 before the first) and the holes in it. */
  seqLo: number;
  seqHi: number;
  missing: Set<number>;
  /** Arrival time of the event that opened the first open hole. */
  missingSince?: string;
  /** Agent / Task tool calls (the tools that launch a subagent), newest last, at most
   *  AGENTS_MAX: what an AgentRun's description and launch call are read from. */
  launches: Launch[];
  /** The last turn's prompt is a block the harness wrote (`turn.started.injected`): its
   *  progress and transcript never become the session's last ask. */
  injected?: boolean;
}

/** One call of a tool that launches a subagent. */
interface Launch {
  callId?: string;
  turnId?: string;
  description?: string;
  agentType?: string;
  /** `output.agentId` once the call ended (tier 3), or the agent it was matched to. */
  agentId?: string;
}

/** The tools that launch a subagent: Claude Code's Agent (Task before 2.1), Cursor's Task. */
const LAUNCH_TOOLS = new Set(["Agent", "Task"]);
/** An agent's own recent tools kept. */
const AGENT_RECENT = 4;

/** What the store keeps per session beyond the summary it serves. */
export interface SessionRecord {
  summary: SessionSummary;
  /** Whether a `session.ended` arrived. */
  ended: boolean;
  /** Whether anything but a backfill arrived. */
  live: boolean;
  /** Distinct repo-relative paths the session changed: from files.changed, and from the
   *  file a successful write tool named in its input (paths.ts). */
  files: Set<string>;
  /** Keys of subagent sessions whose parent_id is this one. */
  childKeys: Set<string>;
  track: Tracking;
}

export function newRecord(harness: string, id: string, at: string, source: EventSource): SessionRecord {
  return {
    summary: {
      key: sessionKey(harness, id),
      harness,
      id,
      state: "idle",
      stateSince: at,
      startedAt: at,
      lastAt: at,
      maxTier: 0,
      backfilled: false,
      source,
      counts: {
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
      },
      openAttentions: [],
      children: 0,
      agents: [],
      recentTools: [],
      flags: [],
      turnStats: { count: 0 },
    },
    ended: false,
    live: false,
    files: new Set(),
    childKeys: new Set(),
    track: {
      errStreak: 0,
      starts: [],
      compactions: [],
      turnsEnded: 0,
      turnMs: [],
      seqLo: -1,
      seqHi: -1,
      missing: new Set(),
      launches: [],
    },
  };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const cut = (v: unknown, n: number): string =>
  detach((typeof v === "string" ? v : v == null ? "" : JSON.stringify(v)).slice(0, n));

/** FNV-1a over a string, as 8 hex digits: a stable key for "the same input". */
function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** "45 s", "4 m", "2 h 5 m". */
function span(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
}

/** Note a seq: a hole behind the highest seq (or behind a late older one) is a gap
 *  until its seqs arrive. A hole in front of the first seq seen is never one: that
 *  is where the session began for this receiver. */
function noteSeq(t: Tracking, seq: number, arrivedAt: string): void {
  if (t.seqHi < 0) {
    t.seqLo = seq;
    t.seqHi = seq;
    return;
  }
  if (t.missing.delete(seq)) {
    if (!t.missing.size) t.missingSince = undefined;
    return;
  }
  let from = 0;
  let to = -1;
  if (seq > t.seqHi) {
    from = t.seqHi + 1;
    to = seq - 1;
    t.seqHi = seq;
  } else if (seq < t.seqLo) {
    from = seq + 1;
    to = t.seqLo - 1;
    t.seqLo = seq;
  } else return;
  if (to < from || to - from + 1 > GAP_MAX_HOLE) return;
  for (let i = from; i <= to; i++) t.missing.add(i);
  t.missingSince ??= arrivedAt;
}

function turnStats(t: Tracking, tools: number): TurnStats {
  const out: TurnStats = { count: t.turnsEnded };
  if (t.turnsEnded) out.toolsPerTurn = Math.round((10 * tools) / t.turnsEnded) / 10;
  if (!t.turnMs.length) return out;
  const sorted = [...t.turnMs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  out.medianMs = Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
  out.lastMs = t.turnMs[t.turnMs.length - 1]!;
  return out;
}

/** A sender's clock may run ahead; an outbox flush is history. Clamp to arrival. */
function clampTime(time: string, arrivedAt: string): string {
  const t = Date.parse(time);
  const a = Date.parse(arrivedAt);
  if (!Number.isFinite(t)) return arrivedAt;
  return t > a ? arrivedAt : new Date(t).toISOString();
}

/** COALESCE the session block (spec §3): a later empty field never blanks a full one;
 *  a title only moves to a better or equal source. */
export function coalesceSession(s: SessionSummary, ev: ProtocolEvent): void {
  const b = ev.session;
  const put = (k: "machine" | "cwd" | "repo" | "branch" | "model" | "url", v: unknown) => {
    const t = str(v);
    if (t) s[k] = t;
  };
  put("machine", b.machine);
  put("cwd", b.cwd);
  put("repo", b.repo);
  put("branch", b.branch);
  put("model", b.model);
  put("url", b.url);
  const acc = str(b.account_id);
  if (acc) s.accountId = acc;
  // Latest wins (a headless run resumed in a terminal); absent leaves what is known.
  if (typeof b.attended === "boolean") s.attended = b.attended;
  if (typeof b.parent_id === "string" && b.parent_id) s.parentId = b.parent_id;
  else if (b.parent_id === null && s.parentId === undefined) s.parentId = null;
  // A launcher is a session key (CONTROL.md); anything else is dropped.
  const launcher = str(b.launched_by)?.trim();
  if (launcher && LAUNCHER_KEY_RE.test(launcher)) s.launchedBy = launcher;
  // The session this one was started for (sessionpipe ask, a handoff): a `<harness>:<id>`
  // ref, kept like parent_id, across harnesses; the shape control reads, nothing looser.
  const by = str(b.delegated_by);
  if (by && SESSION_REF.test(by)) s.delegatedBy = by;
  const title = str(b.title);
  if (title) {
    const src = b.title_source && TITLE_RANK[b.title_source] ? b.title_source : undefined;
    const rank = src ? TITLE_RANK[src]! : 0;
    const have = s.titleSource ? TITLE_RANK[s.titleSource]! : s.title ? 0 : -1;
    if (rank >= have) {
      s.title = title;
      s.titleSource = src;
    }
  }
  const v = str(ev.harness.version);
  if (v) s.harnessVersion = v;
}

/** Apply one accepted event to its session record. `now` is the arrival time. */
/** Whether a permission attention came from the harness's permission hook (the one a
 *  control daemon registers and can answer): Claude Code / Codex `PermissionRequest`,
 *  or the client's `perm-` id. A `Notification` about the same prompt is not. */
export function answerableAttention(ev: ProtocolEvent): boolean {
  const id = String((ev.data as Record<string, unknown>).attention_id ?? "");
  return ev.harness.event === "PermissionRequest" || id.startsWith("perm-");
}

/** Whether an attention is the harness's idle notice rather than a prompt: Claude Code's
 *  `idle_prompt` Notification ("Claude is waiting for your input"), `kind: idle`, or the
 *  same words from a Claude Code that names no notification type. The session ended its
 *  turn and waits for the next one: idle, never "needs you". Only a real prompt (a
 *  permission, a question, an elicitation, an error) opens an attention. */
export function idleNotice(ev: ProtocolEvent): boolean {
  const d = ev.data as Record<string, unknown>;
  if (d.kind === "idle") return true;
  return (
    ev.harness.event === "Notification" &&
    !d.tool &&
    typeof d.message === "string" &&
    /\bwaiting for your input\b/i.test(d.message)
  );
}

/** One tool call for the loop reading (evaluateFlags): its name, when, and at tier 3 a
 *  hash of its input. The same input is judged on what the index keeps of it (slim.ts),
 *  so a reboot reads the same loop from the slim copies. */
function noteStart(t: Tracking, tool: string, at: string, ev: ProtocolEvent): void {
  const input = (ev.data as Record<string, unknown>).input;
  const text =
    ev.tier >= 3 && input !== undefined && input !== null
      ? typeof input === "string"
        ? input
        : JSON.stringify(input)
      : undefined;
  t.starts.push({ tool, at, ...(text !== undefined ? { hash: fnv(text.slice(0, PREVIEW_CHARS)) } : {}) });
  if (t.starts.length > LOOP_WINDOW) t.starts.splice(0, t.starts.length - LOOP_WINDOW);
}

/** The text of a synchronous Agent call's output: a string, `result`, or the text parts
 *  of `content`. Undefined for anything else (an async launch carries no result). */
function agentResult(output: unknown): string | undefined {
  if (typeof output === "string") return str(output);
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  if (o.isAsync === true || o.status === "async_launched") return undefined;
  if (typeof o.result === "string") return str(o.result);
  if (Array.isArray(o.content)) {
    const text = o.content
      .map((c) =>
        c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : "",
      )
      .join("\n");
    return str(text);
  }
  return undefined;
}

/** The agent with this id, made (running, from `at`) when this is the first word of it. */
function agentFor(s: SessionSummary, id: string, at: string): AgentRun {
  let a = s.agents.find((x) => x.id === id);
  if (!a) {
    a = {
      id,
      state: "running",
      startedAt: at,
      lastAt: at,
      tools: 0,
      toolErrors: 0,
      attributed: false,
      recentTools: [],
    };
    s.agents = [...s.agents, a];
  }
  return a;
}

/** Open agents first (oldest start first), then ended ones newest first; at most AGENTS_MAX,
 *  never dropping an open one. Also the live count. */
export function settleAgents(s: SessionSummary): void {
  const open = s.agents.filter((a) => a.state !== "done").sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  const ended = s.agents
    .filter((a) => a.state === "done")
    .sort((a, b) => ((b.endedAt ?? b.lastAt) < (a.endedAt ?? a.lastAt) ? -1 : 1));
  s.agents = [...open, ...ended.slice(0, Math.max(0, AGENTS_MAX - open.length))];
  s.counts.agentsRunning = open.length;
}

/** Match a launch call and an agent both ways: the description and call id onto the
 *  agent, the agent id onto the call. */
function link(a: AgentRun, l: Launch): void {
  l.agentId = a.id;
  if (l.callId && !a.callId) a.callId = l.callId;
  if (l.description && !a.description) a.description = l.description;
  if (l.agentType && !a.type) a.type = l.agentType;
  if (l.turnId && !a.turnId) a.turnId = l.turnId;
}

/** Claude Code tells the orchestrator a background agent finished with a prompt of its
 *  own (`<task-notification>` … `<task-id>` … `<result>`), which reaches us as that turn's
 *  user text at tier 2+. Its result is the agent's: the one place the protocol carries
 *  it for an agent that ran in the background. */
const TASK_NOTIFICATION = /^\s*<task-notification>[\s\S]*?<task-id>([^<\s]+)<\/task-id>/;
const TASK_RESULT = /<result>([\s\S]*?)(?:<\/result>|$)/;
function noteTaskNotification(s: SessionSummary, user: unknown): void {
  if (typeof user !== "string") return;
  const m = TASK_NOTIFICATION.exec(user);
  if (!m) return;
  const a = s.agents.find((x) => x.id === m[1]);
  const result = str(TASK_RESULT.exec(user)?.[1]?.trim());
  if (!a || !result || a.result) return;
  s.agents = s.agents.map((x) => (x === a ? { ...a, result: cut(result, SNIPPET_CHARS) } : x));
}

/** Close every open agent: its session ended (or went silent for good). */
function closeAgents(s: SessionSummary, at: string): void {
  if (!s.agents.some((a) => a.state !== "done")) return;
  s.agents = s.agents.map((a) =>
    a.state === "done" ? a : { ...a, state: "done", endedAt: at, currentTool: undefined },
  );
  settleAgents(s);
}

/** SessionSummary.newsAt: the latest arrival that is news, never moved back. */
function noteNews(s: SessionSummary, arrivedAt: string): void {
  if (!s.newsAt || arrivedAt > s.newsAt) s.newsAt = arrivedAt;
}

/** The harness a `<harness>:<id>` ref names. */
const harnessOf = (ref: string | undefined): string => (ref ? ref.slice(0, Math.max(0, ref.indexOf(":"))) : "");

/** The delegation with this ask id, or a fresh open one from `at` when this is the first
 *  word of it (a sink that joined after the start saw only the end). */
function delegationFor(s: SessionSummary, askId: string, at: string, d: Record<string, unknown>): Delegation {
  const have = s.delegations?.find((x) => x.askId === askId);
  if (have) return { ...have };
  // Only a handoff reports how it was relayed; the asked harness is the one `to` names.
  return {
    askId,
    via: d.relayed !== undefined ? "handoff" : "ask",
    harness: str(d.harness) ?? harnessOf(str(d.to)),
    startedAt: at,
  };
}

/** Put one delegation back (by ask id), keep at most DELEGATIONS_MAX by dropping the oldest
 *  ended ones (never an open one), and count the open ones. */
export function settleDelegations(s: SessionSummary, next?: Delegation): void {
  let list = s.delegations ?? [];
  if (next)
    list = list.some((x) => x.askId === next.askId)
      ? list.map((x) => (x.askId === next.askId ? next : x))
      : [...list, next];
  for (let i = 0; list.length > DELEGATIONS_MAX && i < list.length; ) {
    if (list[i]!.endedAt) list = [...list.slice(0, i), ...list.slice(i + 1)];
    else i++;
  }
  s.delegations = list;
  s.counts.delegationsRunning = list.filter((x) => !x.endedAt).length;
}

/** Close every open delegation: its session ended (or went silent for good). The answer
 *  is unknown then, so `ok` stays unset. True when any was open. */
function closeDelegations(s: SessionSummary, at: string): boolean {
  if (!s.delegations?.some((x) => !x.endedAt)) return false;
  s.delegations = s.delegations.map((x) => (x.endedAt ? x : { ...x, endedAt: at }));
  s.counts.delegationsRunning = 0;
  return true;
}

export function applyEvent(rec: SessionRecord, ev: ProtocolEvent, arrivedAt: string, source: EventSource): void {
  const s = rec.summary;
  const t = rec.track;
  const at = clampTime(ev.time, arrivedAt);
  const d = ev.data;
  coalesceSession(s, ev);
  noteSeq(t, ev.session.seq, arrivedAt);
  const first = s.counts.events === 0;
  s.counts.events++;
  s.source = source;
  if (ev.tier > s.maxTier) s.maxTier = ev.tier as Tier;

  if (ev.type === "session.backfill") {
    // A backfill's own time is when it was found; started_at / last_at are the facts.
    const started = str(d.started_at) ?? at;
    const last = str(d.last_at) ?? at;
    if (first || !rec.live) {
      s.startedAt = started < last ? started : last;
      s.lastAt = started < last ? last : started;
    } else {
      if (started < s.startedAt) s.startedAt = started;
      if (last > s.lastAt) s.lastAt = last;
    }
    const turns = num(d.turns);
    if (turns !== undefined && turns > s.counts.turns) s.counts.turns = turns;
  } else if (ev.type === "limits.observed" && !first) {
    // The account's numbers, not the session's activity (server/ui/limits.ts keeps them):
    // they never move lastAt, so they never wake a session or keep it working. One thing
    // is the session's: `data.account_id` (the pool, DESIGN §2.3) names the account that
    // served the request. Another than the session's own means the pool moved it there;
    // `since` is the first such report in a row for that account. Its own account again
    // clears it; a report with no account id says nothing either way.
    const served = str(d.account_id);
    if (served && served !== s.accountId) {
      if (s.servedBy?.accountId !== served) s.servedBy = { accountId: served, since: at };
    } else if (served) delete s.servedBy;
  } else {
    if (first || !rec.live) {
      // The first live event: a backfill's span, if any, is history before it.
      s.startedAt = rec.live || first ? at : s.startedAt < at ? s.startedAt : at;
      s.lastAt = at;
    } else {
      if (at < s.startedAt) s.startedAt = at;
      if (at > s.lastAt) s.lastAt = at;
    }
    rec.live = true;
  }
  s.backfilled = !rec.live;

  // A notification *about* a permission prompt (Claude Code's Notification hook,
  // `notif-…`, no tool, no message) arriving while the prompt itself is open: the
  // same prompt, not a new one. It neither closes nor duplicates the answerable one.
  const twin =
    ev.type === "attention.needed" &&
    d.kind === "permission" &&
    !answerableAttention(ev) &&
    s.openAttentions.some((x) => x.kind === "permission" && x.answerable);
  // CONTROL.md §7: the session's next hook event closes whatever attention was open.
  if (!twin && !NOT_HOOK.has(ev.type) && ev.type !== "attention.cleared" && s.openAttentions.length) {
    if (
      ev.type !== "attention.needed" ||
      str(d.attention_id) !== s.openAttentions[s.openAttentions.length - 1]?.attentionId
    )
      s.openAttentions = [];
  }

  switch (ev.type) {
    case "session.started":
      // A session that ended and came back (Claude Code's resume, a compaction restart,
      // a harness reopened after a reboot) is live again, not done for good.
      rec.ended = false;
      s.endedAt = undefined;
      s.background = undefined;
      break;
    case "session.ended":
      noteNews(s, arrivedAt);
      rec.ended = true;
      s.endedAt = at;
      s.background = undefined;
      s.currentTurn = undefined;
      s.currentTool = undefined;
      s.progress = undefined;
      s.openAttentions = [];
      closeAgents(s, at);
      closeDelegations(s, at);
      break;
    case "turn.started": {
      const turnId = str(d.turn_id);
      // A harness may fire turn.started again for a turn it absorbed a message into
      // (PROTOCOL.md §4): the same turn, never reclassified by a later `injected`.
      if (turnId && s.currentTurn?.turnId === turnId) break;
      s.counts.turns++;
      const promptChars = num(d.prompt_chars);
      const by = typeof d.submitted_by === "string" && SUBMITTED_BY.test(d.submitted_by) ? d.submitted_by : undefined;
      t.injected = d.injected === true;
      s.currentTurn = {
        turnId,
        since: at,
        ...(promptChars !== undefined ? { promptChars } : {}),
        ...(by ? { submittedBy: by } : {}),
        ...(t.injected ? { injected: true } : {}),
      };
      s.currentTool = undefined;
      // Woken: whatever it was waiting on is this turn's now; its Stop says what is left.
      s.background = undefined;
      break;
    }
    case "turn.ended": {
      // A turn the person typed at the terminal of a session they attend, they read
      // there; any other turn's end is news to someone away from it.
      if (!(s.currentTurn?.submittedBy === "user" && s.attended === true)) noteNews(s, arrivedAt);
      const ms = num(d.ms) ?? (s.currentTurn ? Date.parse(at) - Date.parse(s.currentTurn.since) : undefined);
      t.turnsEnded++;
      if (ms !== undefined && ms >= 0) {
        t.turnMs.push(Math.round(ms));
        if (t.turnMs.length > TURN_SAMPLES) t.turnMs.splice(0, t.turnMs.length - TURN_SAMPLES);
      }
      s.turnStats = turnStats(t, s.counts.tools);
      s.currentTurn = undefined;
      s.currentTool = undefined;
      s.progress = undefined;
      const tasks = num(d.background);
      s.background = tasks !== undefined && tasks > 0 ? { tasks: Math.floor(tasks), since: at } : undefined;
      break;
    }
    case "turn.progress": {
      const turn = num(d.turn);
      if (turn !== undefined) {
        s.progress = {
          turn,
          // An injected prompt (a task notification, a peer's message) is not the ask.
          user: t.injected ? "" : cut(d.user, PREVIEW_CHARS),
          assistant: detach(cut(d.assistant, 2 * PREVIEW_CHARS).slice(-PREVIEW_CHARS)),
          at: str(d.at) ?? at,
        };
      }
      s.currentTurn ??= { since: at };
      break;
    }
    case "turn.transcript": {
      noteTaskNotification(s, d.user);
      const turn = num(d.turn);
      if (s.progress && (turn === undefined || turn >= s.progress.turn)) s.progress = undefined;
      // The last ask stays the last one that wasn't a block the harness wrote.
      if (!t.injected) s.lastUser = cut(d.user, SNIPPET_CHARS);
      s.lastAssistant = cut(d.assistant, SNIPPET_CHARS);
      break;
    }
    case "tool.started": {
      const tool = str(d.tool);
      const agentId = str(d.agent_id);
      if (agentId) {
        // A subagent's call: it runs on its agent, never as the orchestrator's tool, and
        // it does not reopen the orchestrator's turn (an async agent works on after the
        // turn that launched it ended).
        const a = { ...agentFor(s, agentId, at) };
        a.attributed = true;
        a.lastAt = at;
        if (a.state === "stale") a.state = "running";
        if (tool) a.currentTool = { tool, callId: str(d.call_id), since: at };
        a.turnId ??= str(d.turn_id);
        s.agents = s.agents.map((x) => (x.id === agentId ? a : x));
        settleAgents(s);
        if (tool) noteStart(t, tool, at, ev);
        break;
      }
      if (tool) {
        s.currentTool = { tool, callId: str(d.call_id), since: at };
        noteStart(t, tool, at, ev);
        if (LAUNCH_TOOLS.has(tool)) {
          const input = (d.input && typeof d.input === "object" ? d.input : {}) as Record<string, unknown>;
          t.launches.push({
            callId: str(d.call_id),
            turnId: str(d.turn_id) ?? s.currentTurn?.turnId,
            description: str(input.description),
            agentType: str(input.subagent_type),
          });
          if (t.launches.length > AGENTS_MAX) t.launches.splice(0, t.launches.length - AGENTS_MAX);
        }
      }
      s.currentTurn ??= { turnId: str(d.turn_id), since: at };
      break;
    }
    case "tool.ended": {
      const agentId = str(d.agent_id);
      if (agentId) {
        s.counts.tools++;
        const ok = d.ok !== false;
        if (!ok) s.counts.toolErrors++;
        const a = { ...agentFor(s, agentId, at) };
        a.attributed = true;
        a.lastAt = at;
        if (a.state === "stale") a.state = "running";
        a.tools++;
        if (!ok) a.toolErrors++;
        const tool = str(d.tool) ?? "?";
        const ms = num(d.ms);
        a.recentTools = [...a.recentTools, { tool, ok, ...(ms !== undefined ? { ms } : {}) }].slice(-AGENT_RECENT);
        const callId = str(d.call_id);
        if (a.currentTool && ((callId && a.currentTool.callId === callId) || a.currentTool.tool === tool))
          a.currentTool = undefined;
        s.agents = s.agents.map((x) => (x.id === agentId ? a : x));
        settleAgents(s);
        for (const p of changedPaths(ev, s.cwd)) rec.files.add(p);
        s.counts.filesChanged = rec.files.size;
        break;
      }
      s.counts.tools++;
      const ok = d.ok !== false;
      if (!ok) s.counts.toolErrors++;
      if (ok) {
        t.errStreak = 0;
        t.errSince = undefined;
      } else {
        if (!t.errStreak) t.errSince = at;
        t.errStreak++;
      }
      const tool = str(d.tool) ?? "?";
      const ms = num(d.ms);
      s.recentTools.push({ tool, ok, ...(ms !== undefined ? { ms } : {}) });
      if (s.recentTools.length > 8) s.recentTools.splice(0, s.recentTools.length - 8);
      const cur = s.currentTool;
      let matched = false;
      if (cur) {
        const callId = str(d.call_id);
        matched = !!(
          (callId && cur.callId === callId) ||
          (!callId && cur.tool === tool) ||
          (!cur.callId && cur.tool === tool)
        );
        if (matched) s.currentTool = undefined;
      }
      // A harness with no pre-tool hook (Antigravity's PostToolUse is its only tool
      // event) never sent the start: the loop reading takes the end's input instead, so
      // "the same call over and over" is read for it too.
      if (!matched && tool !== "?") noteStart(t, tool, at, ev);
      if (LAUNCH_TOOLS.has(tool)) {
        // The launch call ended: its output names the agent (tier 3), and a synchronous
        // call's output is the agent's result.
        const callId = str(d.call_id);
        const l = callId ? t.launches.find((x) => x.callId === callId) : undefined;
        const out = d.output && typeof d.output === "object" ? (d.output as Record<string, unknown>) : undefined;
        const named = str(out?.agentId) ?? l?.agentId;
        if (l && named) l.agentId = named;
        const a = named ? s.agents.find((x) => x.id === named) : undefined;
        if (a) {
          const next = { ...a };
          if (l) link(next, l);
          else if (callId) next.callId ??= callId;
          const result = agentResult(d.output);
          if (result) next.result = cut(result, SNIPPET_CHARS);
          s.agents = s.agents.map((x) => (x.id === a.id ? next : x));
        }
      }
      s.currentTurn ??= { turnId: str(d.turn_id), since: at };
      // A write tool that succeeded changed the file its input names (the adapter sends
      // no files.changed for it); the same set as below, so the two never double-count.
      for (const p of changedPaths(ev, s.cwd)) rec.files.add(p);
      s.counts.filesChanged = rec.files.size;
      break;
    }
    case "files.changed": {
      for (const p of changedPaths(ev, s.cwd)) rec.files.add(p);
      s.counts.filesChanged = rec.files.size;
      break;
    }
    case "attention.needed": {
      // The idle notice is a hook event like any (it closed what was open above) and
      // stays in the timeline, but it asks for nothing: no attention opens.
      if (idleNotice(ev)) break;
      const attentionId = str(d.attention_id) ?? ev.id;
      const kind = (ATTENTION_KINDS.has(String(d.kind)) ? d.kind : "question") as AttentionKind;
      const a: Attention = { attentionId, kind, at };
      const tool = str(d.tool);
      const message = str(d.message);
      if (tool) a.tool = tool;
      if (message) a.message = message.slice(0, 200);
      if (kind === "permission" && answerableAttention(ev)) a.answerable = true;
      if (twin) break; // folded into the open, answerable prompt
      s.openAttentions = [...s.openAttentions.filter((x) => x.attentionId !== attentionId), a];
      s.counts.attentions++;
      break;
    }
    case "attention.cleared": {
      const attentionId = str(d.attention_id);
      s.openAttentions = attentionId ? s.openAttentions.filter((x) => x.attentionId !== attentionId) : [];
      break;
    }
    case "subagent.started": {
      s.counts.subagents++;
      const id = str(d.agent_id);
      if (id) {
        const a: AgentRun = {
          ...agentFor(s, id, at),
          state: "running",
          startedAt: at,
          lastAt: at,
          endedAt: undefined,
        };
        const type = str(d.agent_type);
        if (type) a.type = type;
        a.turnId ??= s.currentTurn?.turnId;
        // Its launch: the call whose output named it, else the newest one not matched yet
        // (of its type when the call said one).
        const open = t.launches.filter((l) => !l.agentId);
        const l =
          t.launches.find((x) => x.agentId === id) ??
          [...open].reverse().find((x) => !x.agentType || !type || x.agentType === type) ??
          open[open.length - 1];
        if (l) link(a, l);
        s.agents = s.agents.map((x) => (x.id === id ? a : x));
        settleAgents(s);
      }
      s.currentTurn ??= { since: at };
      break;
    }
    case "subagent.ended": {
      const id = str(d.agent_id);
      if (id) {
        const a: AgentRun = { ...agentFor(s, id, at), state: "done", endedAt: at, lastAt: at, currentTool: undefined };
        const type = str(d.agent_type);
        if (type) a.type ??= type;
        s.agents = s.agents.map((x) => (x.id === id ? a : x));
        settleAgents(s);
      }
      break;
    }
    case "delegation.started": {
      // This session asked another agent (sessionpipe ask from inside it, or a handoff
      // relayed into it): an open delegation, like an open agent, keeps it working; unlike
      // a subagent it opens no turn of its own.
      const askId = str(d.ask_id);
      if (!askId) break;
      const x = delegationFor(s, askId, at, d);
      if (d.via === "ask" || d.via === "handoff") x.via = d.via;
      const harness = str(d.harness);
      if (harness) x.harness = harness;
      const to = str(d.to);
      if (to && SESSION_REF.test(to)) x.to = to;
      const text = str(d.text);
      if (text) x.text = cut(text, 200);
      settleDelegations(s, x);
      break;
    }
    case "delegation.ended": {
      const askId = str(d.ask_id);
      if (!askId) break;
      const x = delegationFor(s, askId, at, d);
      x.endedAt = at;
      if (typeof d.ok === "boolean") x.ok = d.ok;
      const ms = num(d.ms);
      if (ms !== undefined) x.ms = ms;
      const to = str(d.to);
      if (to && SESSION_REF.test(to)) x.to = to;
      const error = str(d.error);
      if (error) x.error = cut(error, 200);
      // The answer (tier 2+) as the index keeps it; the event on disk has it whole.
      const reply = str(d.reply);
      if (reply) x.reply = cut(reply, PREVIEW_CHARS);
      if (d.relayed === "delivered" || d.relayed === "unsupported" || d.relayed === "failed") x.relayed = d.relayed;
      settleDelegations(s, x);
      break;
    }
    case "session.heartbeat":
      s.currentTurn ??= { since: at };
      break;
    case "context.compacted":
      s.counts.compactions++;
      t.compactions.push(at);
      break;
    default:
      break;
  }
}

/** The state machine (shared/api.ts SessionState) read at `now`. Returns the state
 *  and when it began. */
export function evaluateState(rec: SessionRecord, now: number): { state: SessionState; since: string } {
  const s = rec.summary;
  const last = Date.parse(s.lastAt);
  const silent = now - last;
  if (s.openAttentions.length && silent < DONE_AFTER_MS) {
    return { state: "needs_you", since: s.openAttentions[s.openAttentions.length - 1]!.at };
  }
  if (rec.ended) return { state: "done", since: s.endedAt ?? s.lastAt };
  if (!rec.live) return { state: "done", since: s.lastAt };
  if (silent >= DONE_AFTER_MS) return { state: "done", since: new Date(last + DONE_AFTER_MS).toISOString() };
  // A subagent still running keeps its orchestrator working, even after the turn that
  // launched it ended (Claude Code's background agents report after the Stop); so does
  // background work the last turn's Stop said is still in flight (`turn.ended.background`),
  // and so does an agent it asked and has no answer from yet (an open delegation).
  const open = s.agents.find((a) => a.state !== "done");
  const asked = s.delegations?.find((x) => !x.endedAt);
  if (s.currentTurn || open || s.background || asked) {
    // Since the earliest of what keeps it busy (all ISO, so they sort as text).
    const since = [s.currentTurn?.since, open?.startedAt, s.background?.since, asked?.startedAt]
      .filter((x): x is string => x !== undefined)
      .sort()[0]!;
    if (silent < STALE_AFTER_MS) return { state: "working", since };
    return { state: "stale", since: new Date(last + STALE_AFTER_MS).toISOString() };
  }
  return { state: "idle", since: s.lastAt };
}

/** Write the evaluated state into the summary; true when it changed. */
export function refreshState(rec: SessionRecord, now: number): boolean {
  const { state, since } = evaluateState(rec, now);
  const s = rec.summary;
  if (state === "done" && !rec.ended && s.openAttentions.length) {
    // Silent for DONE_AFTER_MS: the hook's window closed long ago.
    s.openAttentions = [];
    s.currentTurn = undefined;
    s.currentTool = undefined;
  }
  const agents = refreshAgents(s, state, now);
  // Read done (silent a day): what it asked is closed with it, answer unknown.
  const asked = state === "done" && closeDelegations(s, s.endedAt ?? s.lastAt);
  if (s.state === state && s.stateSince === since) return agents || asked;
  s.state = state;
  s.stateSince = since;
  return true;
}

/** An open agent silent for STALE_AFTER_MS reads stale (and running again when it next
 *  speaks, in applyEvent); a session read done closes them all. True when any moved. A
 *  child session's agent (`session` set) takes its state from the child (store.ts). */
function refreshAgents(s: SessionSummary, state: SessionState, now: number): boolean {
  if (!s.agents.some((a) => a.state !== "done" && !a.session)) return false;
  if (state === "done") {
    closeAgents(s, s.endedAt ?? s.lastAt);
    return true;
  }
  let changed = false;
  const next = s.agents.map((a) => {
    if (a.state === "done" || a.session) return a;
    const want = now - Date.parse(a.lastAt) >= STALE_AFTER_MS ? "stale" : "running";
    if (want === a.state) return a;
    changed = true;
    return { ...a, state: want } as AgentRun;
  });
  if (changed) s.agents = next;
  return changed;
}

/** The flags (shared/api.ts SessionFlag) read at `now`, in a fixed order by kind.
 *  Runs after refreshState (slow_tool looks at the state). */
export function evaluateFlags(rec: SessionRecord, now: number): SessionFlag[] {
  const s = rec.summary;
  const t = rec.track;
  const flags: SessionFlag[] = [];
  if (s.currentTool && (s.state === "working" || s.state === "stale")) {
    const ran = now - Date.parse(s.currentTool.since);
    if (ran > SLOW_TOOL_MS)
      flags.push({ kind: "slow_tool", since: s.currentTool.since, detail: `${s.currentTool.tool} · ${span(ran)}` });
  }
  if (t.errStreak >= STREAK_MIN && t.errSince)
    flags.push({ kind: "error_streak", since: t.errSince, detail: `${t.errStreak} tool errors in a row` });
  const groups = new Map<string, { n: number; at: string; tool: string }>();
  for (const x of t.starts) {
    if (!x.hash) continue;
    const k = `${x.tool}\0${x.hash}`;
    const g = groups.get(k);
    if (g) g.n++;
    else groups.set(k, { n: 1, at: x.at, tool: x.tool });
  }
  let loop: { n: number; at: string; tool: string } | undefined;
  for (const g of groups.values()) if (g.n >= LOOP_MIN && (!loop || g.n > loop.n)) loop = g;
  if (loop) flags.push({ kind: "loop", since: loop.at, detail: `${loop.tool} ×${loop.n} on the same input` });
  const cutoff = Date.parse(s.lastAt) - COMPACTING_WINDOW_MS;
  while (t.compactions.length && Date.parse(t.compactions[0]!) < cutoff) t.compactions.shift();
  if (t.compactions.length >= 2) {
    const n = t.compactions.length;
    const first = Date.parse(t.compactions[0]!);
    const last = Date.parse(t.compactions[n - 1]!);
    flags.push({
      kind: "compacting",
      since: t.compactions[1]!,
      detail: `compacted ${n === 2 ? "twice" : `${n}×`} in ${span(last - first)}`,
    });
  }
  if (t.missing.size && t.missingSince && now - Date.parse(t.missingSince) > GAP_AFTER_MS) {
    const seqs = [...t.missing].sort((a, b) => a - b);
    const n = seqs.length;
    const range = n === 1 ? `seq ${seqs[0]}` : `seq ${seqs[0]}–${seqs[n - 1]}`;
    flags.push({
      kind: "gap",
      since: t.missingSince,
      detail: `waiting for ${n} event${n === 1 ? "" : "s"} (${range})`,
    });
  }
  return flags;
}

/** Write the evaluated flags into the summary; true when the set changed (a detail
 *  that moved with the clock counts). */
export function refreshFlags(rec: SessionRecord, now: number): boolean {
  const flags = evaluateFlags(rec, now);
  const have = rec.summary.flags;
  if (
    have.length === flags.length &&
    have.every((f, i) => f.kind === flags[i]!.kind && f.since === flags[i]!.since && f.detail === flags[i]!.detail)
  )
    return false;
  rec.summary.flags = flags;
  return true;
}
