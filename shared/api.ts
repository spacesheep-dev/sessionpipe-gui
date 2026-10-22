// SPDX-License-Identifier: Apache-2.0
// The contract between the server (server/) and the web app (web/). Both import from
// here and nowhere else for anything that crosses the wire. Change it deliberately:
// a field added here is a field both sides must handle.
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
  parent_id?: string | null;
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
  };
  /** The orchestrator's own tool running right now (tool.started without its tool.ended),
   *  if any. A subagent's tool (one with `agent_id`) runs on its AgentRun instead.
   *  `agentId` is kept for older clients and is no longer set. */
  currentTool?: { tool: string; callId?: string; since: string; agentId?: string };
  /** The turn running right now, if any. */
  currentTurn?: { turnId?: string; since: string; promptChars?: number };
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
  /** Last tool names, newest last, at most 8 — for a sparkline of activity. */
  recentTools: { tool: string; ok: boolean; ms?: number }[];
  /** The store's smarter readings (ARCHITECTURE.md "The store's readings"): what is
   *  off about the session right now, in a fixed order by kind. Empty when nothing is. */
  flags: SessionFlag[];
  /** From turn.started / turn.ended: completed turns, their durations, tools per turn. */
  turnStats: TurnStats;
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

export interface MachineControl {
  machineId: string;
  online: boolean;
  lastPollAt?: string;
  lastHelloAt?: string;
  mode?: "safe" | "auto";
  folders?: string[];
  harnesses?: string[];
  modes?: string[];
  version?: string;
  accounts?: { harness: string; id: string; email: string }[];
  keys: { id: string; alg: number; name?: string; addedAt: string }[];
  /** Messages queued for it and not yet finally acked. */
  queued: number;
}

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
  /** A view's server-side state (THEME_ROUTES.state) was written; `etag` names the new
   *  version, so the page that wrote it can tell its own write from another device's. */
  | { kind: "viewState"; id: string; etag: string };

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
  control: { enabled: boolean; rpId: string; machines: number; origins?: string[] };
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

export type ControlKind = "prompt" | "permission.answer" | "cancel" | "start" | "key.add";
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
    /** GET /api/ui/sessions/:harness/:id?after=|before=<seq>&tail=1&limit=<n>&slim=1 → SessionDetail */
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
    control: "/api/ui/control",
    /** GET → { viewers: Viewer[] } */
    viewers: "/api/ui/viewers",
    /** GET /api/ui/search?q=&limit=&before= → SearchPage */
    search: "/api/ui/search",
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
  },
  /** GET / DELETE /attachments/<id>.<ext>, UI key: the uploaded image itself (served
   *  `private, immutable`), and taking it back. */
  attachments: "/attachments",
} as const;

export const DEFAULT_PORT = 7373;
export const UI_KEY_COOKIE = "spgui";
export const UI_KEY_PARAM = "k";
