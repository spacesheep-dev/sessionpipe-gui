// SPDX-License-Identifier: Apache-2.0
// A session's events grouped by turn, as the timeline and the chat draw them, which of
// those turns a message sent from here became, and an event row's words. A subagent's
// events (`agent_id`) are one group inside the turn that spawned it, wherever they arrive
// (a background agent works on after that turn's Stop); an agent the session asked
// (`delegation.started` / `.ended`, sessionpipe ask or a handoff) is one row in the turn
// the ask began in, and the answer a handoff brought back is told apart from a prompt the
// person typed by the daemon's frame. A message handed to a session at a turn's Stop has
// no `turn.started`: its transcript, marked `injected`, is an exchange of its own after
// that turn. Pure, so all of it is unit-tested.
import type { AgentRun, StoredEvent } from "@shared/api";
import { harnessMark } from "./format";
import { dur } from "./time";

export interface Turn {
  /** Its place among the loaded turns: 0 for what came before the first `turn.started`,
   *  then 1, 2, … as the turns began. An exchange a Stop handed over (`continues`) sits
   *  between its turn and the next (`n` + a thousandth each), so a started turn keeps its
   *  number whatever the tier lens leaves out. */
  n: number;
  start?: StoredEvent;
  items: Item[];
  /** The exchange a message began when it was handed to the session at a turn's Stop
   *  (sessionpipe 0.13.4: a `turn.transcript` marked `injected`, and no `turn.started`):
   *  the `n` of the turn whose Stop took it. The harness counts both as one turn. */
  continues?: number;
}
export type Item =
  | { kind: "tool"; key: string; started?: StoredEvent; ended?: StoredEvent }
  | { kind: "event"; key: string; e: StoredEvent }
  | AgentItem
  | DelegationItem;
export type EventItem = Extract<Item, { kind: "event" }>;
export type ToolItem = Extract<Item, { kind: "tool" }>;

/** One agent this session asked, where the ask began: its delegation.started and, once
 *  the answer is in, its delegation.ended (an end whose start the loaded window lacks
 *  stands alone). The summary's `Delegation` of the same `askId` has the reading. */
export interface DelegationItem {
  kind: "delegation";
  key: string;
  askId: string;
  started?: StoredEvent;
  ended?: StoredEvent;
}

/** One subagent in its spawning turn: the Agent / Task call that launched it (the block's
 *  head), its subagent.started / .ended, and its own tool calls. */
export interface AgentItem {
  kind: "agent";
  key: string;
  id: string;
  launch?: ToolItem;
  started?: StoredEvent;
  ended?: StoredEvent;
  tools: ToolItem[];
}

/** The tools that launch a subagent (server/store/readings.ts LAUNCH_TOOLS). */
const LAUNCH_TOOLS = new Set(["Agent", "Task"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** How far a transcript's `at` may sit outside a turn's span and still be that turn's. The
 *  sender stamps the exchange with its prompt's time (the sim with its end), and the hook
 *  with when it ran: the two differ by moments, while turns sit seconds apart. */
const TRANSCRIPT_SLACK_MS = 10_000;
/** How long before its `turn.started` a prompt may be stamped: the harness writes it down,
 *  then runs the hook. */
const PROMPT_LEAD_MS = 1000;

const ms = (iso: unknown): number => (typeof iso === "string" ? Date.parse(iso) : Number.NaN);
const isEnd = (i: Item): i is EventItem => i.kind === "event" && i.e.type === "turn.ended";
const isTranscript = (i: Item): i is EventItem => i.kind === "event" && i.e.type === "turn.transcript";
/** When a turn was last heard to end: a Stop that handed a message over is followed by
 *  another, in the turn's own rows or in the exchange that message began. */
const endedAt = (t: Turn, handed: readonly Turn[] = []): number => {
  let end = Number.NaN;
  for (const x of [t, ...handed]) for (const i of x.items) if (isEnd(i) && !(ms(i.e.time) <= end)) end = ms(i.e.time);
  return end;
};

/** The turn a `turn.transcript` describes, by time. Its `turn` number can't say: the sender
 *  counts the exchanges it read from the transcript file (from 0, and from wherever it
 *  first read), never the hook turns, and the loaded window starts mid-session. A late
 *  read hands the last two exchanges over at once, so counting from the newest turn put a
 *  turn's words on the one before it ("the second prompt showed as 'hi'").
 *
 *  The sender stamps an exchange with its prompt's time, and the prompt's hook runs a
 *  moment later (on 1,247 prompts of real sessions: under two tenths of a second on all
 *  but three, never more than a second, never before). So a transcript stamped within a
 *  second before a turn's `turn.started` is that turn's, whatever the turn before it
 *  looks like: one that was stopped has no end of its own (or an `interrupt` stamped by
 *  the very hook that began the next), and its span runs up to the next turn's start, so
 *  it took the next turn's words. Otherwise `at` falls inside the turn's span
 *  (start to end, or to the next turn's start), or within the slack of it. `undefined`
 *  when no loaded turn is close: an exchange from before the window, or the history a
 *  fork copied. `null` when the time can't be read. */
function transcriptHome(turns: Turn[], at: number, handed: ReadonlyMap<Turn, Turn[]>): Turn | null | undefined {
  if (!Number.isFinite(at)) return null;
  let lead: Turn | undefined;
  let leadD = PROMPT_LEAD_MS;
  let best: Turn | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const start = ms(t.start?.time);
    if (!Number.isFinite(start)) continue;
    if (start >= at && start - at <= leadD) {
      lead = t;
      leadD = start - at;
    }
    const next = turns[i + 1];
    const end = endedAt(t, handed.get(t));
    const until = Number.isFinite(end) ? end : next ? ms(next.start?.time) : Number.POSITIVE_INFINITY;
    const d = at < start ? start - at : at > until ? at - until : 0;
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return lead ?? (bestD <= TRANSCRIPT_SLACK_MS ? best : undefined);
}

/** Pairs a tool.ended with its tool.started among `open` (by call id, else by name), or
 *  makes an ended-only item; returns the item when it is new. */
function pairEnd(open: Map<string, ToolItem>, e: StoredEvent): ToolItem | null {
  const id = typeof e.data.call_id === "string" ? e.data.call_id : undefined;
  const item = (id ? open.get(id) : undefined) ?? open.get(`name:${e.data.tool}`);
  if (item && !item.ended) {
    item.ended = e;
    if (id) open.delete(id);
    open.delete(`name:${e.data.tool}`);
    return null;
  }
  return { kind: "tool", key: `e:${e.id}`, ended: e };
}

function openTool(open: Map<string, ToolItem>, e: StoredEvent): ToolItem {
  const id = String(e.data.call_id ?? `${e.data.tool}#${e.session.seq}`);
  const item: ToolItem = { kind: "tool", key: `t:${e.session.seq}`, started: e };
  open.set(id, item);
  if (!e.data.call_id) open.set(`name:${e.data.tool}`, item);
  return item;
}

/** The session's events as turns. `agents` (the summary's) name each subagent's launching
 *  call and spawning turn, so its block sits where it was launched. */
export function groupTurns(events: StoredEvent[], agents: readonly AgentRun[] = []): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn = { n: 0, items: [] };
  turns.push(cur);
  let openTools = new Map<string, Extract<Item, { kind: "tool" }>>();
  const byTurnId = new Map<string, Turn>();
  const runs = new Map(agents.map((a) => [a.id, a]));
  const byCall = new Map(agents.filter((a) => a.callId).map((a) => [a.callId!, a.id]));
  const groups = new Map<string, { item: AgentItem; open: Map<string, ToolItem> }>();
  const asks = new Map<string, DelegationItem>();
  /** The exchanges each turn's Stops handed over, oldest first, and the turn each is of. */
  const handed = new Map<Turn, Turn[]>();
  const turnOf = new Map<Turn, Turn>();
  /** A new exchange for a message handed over at one of `home`'s Stops, at `at`. What the
   *  session did after that Stop is the exchange's: the rows the turn (or the exchange
   *  before this one) gained after it, the transcript that describes those apart. */
  const handover = (home: Turn, at: number): Turn => {
    const list = handed.get(home) ?? [];
    const from = list[list.length - 1] ?? home;
    const x: Turn = { n: home.n + (list.length + 1) / 1000, items: [], continues: home.n };
    // The Stop that took it: the last one before it (the harness writes the message down
    // once that Stop's hook has answered; a hook that is not ours can have held the turn
    // at an earlier Stop), else the first.
    let stop = from.items.findIndex(isEnd);
    from.items.forEach((it, i) => {
      if (isEnd(it) && ms(it.e.time) <= at) stop = i;
    });
    if (stop >= 0) for (const it of from.items.splice(stop + 1)) (isTranscript(it) ? from : x).items.push(it);
    handed.set(home, [...list, x]);
    turnOf.set(x, home);
    if (cur === from) cur = x;
    return x;
  };
  /** An agent's group, made in its spawning turn (the turn its events name, else the one
   *  the summary names, else the current one) the first time it is heard of. */
  const group = (id: string, e: StoredEvent, at?: Turn) => {
    let g = groups.get(id);
    if (!g) {
      const home = at ?? byTurnId.get(str(e.data.turn_id) ?? "") ?? byTurnId.get(runs.get(id)?.turnId ?? "") ?? cur;
      g = { item: { kind: "agent", key: `a:${id}`, id, tools: [] }, open: new Map() };
      home.items.push(g.item);
      groups.set(id, g);
    }
    return g;
  };
  for (const e of events) {
    if (e.type === "turn.started") {
      cur = { n: turns.length, start: e, items: [] };
      turns.push(cur);
      openTools = new Map();
      const tid = str(e.data.turn_id);
      if (tid) byTurnId.set(tid, cur);
      continue;
    }
    if (e.type === "delegation.started" || e.type === "delegation.ended") {
      // Where the ask began; an end alone sits where it arrived.
      const askId = str(e.data.ask_id) ?? e.id;
      let item = asks.get(askId);
      if (!item) {
        item = { kind: "delegation", key: `d:${askId}`, askId };
        asks.set(askId, item);
        cur.items.push(item);
      }
      if (e.type === "delegation.started") item.started ??= e;
      else item.ended = e;
      continue;
    }
    const agentId = str(e.data.agent_id);
    if (agentId && (e.type === "tool.started" || e.type === "tool.ended")) {
      const g = group(agentId, e);
      if (e.type === "tool.started") g.item.tools.push(openTool(g.open, e));
      else {
        const made = pairEnd(g.open, e);
        if (made) g.item.tools.push(made);
      }
      continue;
    }
    if (agentId && (e.type === "subagent.started" || e.type === "subagent.ended")) {
      const g = group(agentId, e);
      if (e.type === "subagent.started") g.item.started ??= e;
      else g.item.ended = e;
      continue;
    }
    // The call that launched a known agent: the agent's block, at the call's place.
    const launched =
      (e.type === "tool.started" || e.type === "tool.ended") && LAUNCH_TOOLS.has(String(e.data.tool))
        ? byCall.get(str(e.data.call_id) ?? "")
        : undefined;
    if (launched && e.type === "tool.started") {
      const g = group(launched, e, groups.has(launched) ? undefined : cur);
      const item = openTool(openTools, e);
      g.item.launch ??= item;
      continue;
    }
    if (launched && e.type === "tool.ended" && !openTools.has(String(e.data.call_id))) {
      const g = group(launched, e, groups.has(launched) ? undefined : cur);
      if (g.item.launch && !g.item.launch.ended) g.item.launch.ended = e;
      else g.item.launch ??= { kind: "tool", key: `e:${e.id}`, ended: e };
      continue;
    }
    if (e.type === "tool.started") {
      cur.items.push(openTool(openTools, e));
      continue;
    }
    if (e.type === "tool.ended") {
      const made = pairEnd(openTools, e);
      if (made) cur.items.push(made);
      continue;
    }
    if (e.type === "turn.transcript") {
      // Attach to the turn it describes; one that is none of the loaded turns is left out.
      const at = ms(e.data.at);
      const home = turns.length > 1 ? transcriptHome(turns, at, handed) : null;
      if (home === undefined) continue;
      // A message handed over at the turn's Stop: the turn has its own exchange already,
      // and this one, the message and its answer, is drawn after it, never instead of it.
      const of = home ?? turnOf.get(cur) ?? cur;
      const to = e.data.injected === true && of.items.some(isTranscript) ? handover(of, at) : (home ?? cur);
      to.items.push({ kind: "event", key: e.id, e });
      continue;
    }
    // A status line's usage report is the account's, not a step of the turn (Usage shows it).
    if (e.type === "limits.observed") continue;
    cur.items.push({ kind: "event", key: e.id, e });
  }
  return turns.flatMap((t) => [t, ...(handed.get(t) ?? [])]).filter((t) => t.start || t.items.length > 0);
}

/** The transcript of an exchange a Stop handed over: the event that made it one. */
const handedBy = (t: Turn): StoredEvent | undefined =>
  t.continues === undefined ? undefined : [...t.items].reverse().find(isTranscript)?.e;

/** When a turn began, on its machine's clock: its `turn.started`, or, for an exchange a
 *  Stop handed over, the moment the message was handed over (its transcript's `at`). */
export function turnBegan(t: Turn): string | undefined {
  if (t.start) return t.start.time;
  const e = handedBy(t);
  return e ? (str(e.data.at) ?? e.time) : undefined;
}

const itemSeq = (i: Item): number | undefined =>
  (i.kind === "event"
    ? i.e
    : i.kind === "tool"
      ? (i.started ?? i.ended)
      : i.kind === "agent"
        ? (i.launch?.started ?? i.launch?.ended ?? i.started ?? i.ended)
        : (i.started ?? i.ended)
  )?.session.seq;

/** The seq a turn's rows begin at: its `turn.started`, or the first row of an exchange a
 *  Stop handed over. Undefined for what came before the first turn. */
export function turnSeq(t: Turn): number | undefined {
  if (t.start) return t.start.session.seq;
  if (t.continues === undefined) return undefined;
  const seqs = t.items.map(itemSeq).filter((n): n is number => n !== undefined);
  return seqs.length ? Math.min(...seqs) : undefined;
}

/** The person's words of a turn: its transcript's, else the running turn's reading. */
export function turnPrompt(turn: Turn): string | undefined {
  let progress: string | undefined;
  for (let i = turn.items.length - 1; i >= 0; i--) {
    const it = turn.items[i]!;
    if (it.kind !== "event") continue;
    if (it.e.type === "turn.transcript" && typeof it.e.data.user === "string") return it.e.data.user;
    if (it.e.type === "turn.progress" && progress === undefined && typeof it.e.data.user === "string")
      progress = it.e.data.user;
  }
  return progress;
}

/** A message sent from here, as far as matching it to a turn goes: its id, when the
 *  receiver queued it (the receiver's clock, like an event's `arrivedAt`), and its words
 *  (without an attachments block). `takenAt`: when the machine took it (its turn can't
 *  start much before). `start`: the `start` that made the session, whose turn is the
 *  session's first. `outcome`, `code`, `ackedAt`: where the machine's acks have brought it
 *  (`ControlActivity`), and when the final one was written. */
export interface SentMessage {
  id: string;
  at: string;
  text: string;
  takenAt?: string;
  start?: boolean;
  outcome?: string;
  code?: string;
  ackedAt?: string;
}

/** The receiver's clock and the machine's need not agree: a turn begins no more than this
 *  before the machine took its message, or after the machine's last word on it. */
const SENT_SKEW_MS = 60_000;
/** A turn dated this long before its message was queued is not its turn, whatever the two
 *  clocks say: it arrived late (a machine sending what it had held). A machine more than
 *  five minutes behind the signing device refuses the command as signed in its future
 *  (CONTROL.md §5), and the receiver's early check holds its own clock within ten of that
 *  device's, so a turn the message did begin is never dated this far back. */
const SENT_STALE_MS = 30 * 60_000;
/** Shorter than this, the words must match exactly ("hi" is in "this"). */
const SENT_PREFIX_MIN = 24;

/** The final outcomes (CONTROL.md §10), and the ones that end a message before the session
 *  had it: refused, expired, no way in; or failed on the way there (a file that did not
 *  arrive, a session that did not take what was put in its inbox, a start stopped before
 *  its process began). Any other failure happened in the turn the message began. */
const FINAL = new Set(["delivered", "expired", "unsupported", "failed", "refused"]);
const UNREACHED = new Set(["refused", "expired", "unsupported"]);
const FAILED_BEFORE = new Set(["file", "held", "cancelled"]);
/** Whether a message can be a turn's prompt: one the session never had is nobody's,
 *  whatever was typed there later in the same words. */
const reached = (m: SentMessage): boolean =>
  !(UNREACHED.has(m.outcome ?? "") || (m.outcome === "failed" && FAILED_BEFORE.has(m.code ?? "")));

// The machine frames what it hands a session (sessionpipe's control/route.ts): a source
// line before a message to a running session, a source note after a new session's first.
const FRAME_HEAD = /^Message via [^\n]*\(sessionpipe control[^\n]*\):\s*/;
const FRAME_TAIL = /\s*\(Sent via [^\n]* with sessionpipe control[^\n]*\)\s*$/;
// The daemon's trailer on the question it hands an agent another session asked
// (`sessionpipe ask`, CONTROL.md §13): the asker's `<harness>:<id>`, in the shape a
// session ref has (control's SESSION_REF), or the trailer is just words in the prompt.
const ASK_TAIL =
  /\s*\(Asked by ([a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}) on this machine with sessionpipe ask\.[^)]*\)\s*$/;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** A prompt as the person wrote it: the machine's framing taken off, and where it was sent
 *  from ("localhost", "studio-mac.local:7373") when the framing said; `askedBy` when it
 *  was another session's question (the `<harness>:<id>` of the asker). */
export function unframe(prompt: string): { text: string; via?: string; askedBy?: string } {
  const asked = ASK_TAIL.exec(prompt);
  if (asked) return { text: prompt.replace(ASK_TAIL, ""), askedBy: asked[1] };
  const head = /^Message via ([^\n(]*?)\s*\(sessionpipe control/.exec(prompt);
  const text = prompt.replace(FRAME_HEAD, "").replace(FRAME_TAIL, "");
  if (text === prompt) return { text };
  const tail = /\(Sent via ([^\n]*?) with sessionpipe control/.exec(prompt);
  return { text, via: head?.[1] || tail?.[1] || undefined };
}

// A handoff's answer as the daemon delivers it into `reply_to` (CONTROL.md §6): the
// asked session by its harness and short id, the receiver it was asked through, the reply.
const ANSWER_HEAD = /^Answer from ([a-z0-9-]+):([^\s]+) \(sessionpipe handoff[^)]*\):\n\n/;

/** A prompt that is an agent's answer brought back by a handoff, not the person's words:
 *  who answered (the harness, and the daemon's short id of its session), through which
 *  receiver it was asked, and the answer itself. Undefined for any other prompt. */
export function handoffAnswer(
  prompt: string,
): { harness: string; shortId: string; via?: string; reply: string } | undefined {
  const m = ANSWER_HEAD.exec(prompt);
  if (!m) return undefined;
  const via = /asked via ([^)]+)\)/.exec(m[0])?.[1];
  return { harness: m[1]!, shortId: m[2]!, ...(via ? { via } : {}), reply: prompt.slice(m[0].length) };
}

/** What sessionpipe's privacy filter leaves where it took something out of a prompt: a
 *  secret, an email address, a phone number. */
const SCRUBBED = /\[(?:redacted|email|phone)\]/;

/** Whether a prompt the machine scrubbed is this message: what is left of it runs through
 *  the message in order, from its first word to its last. Other words between the marks
 *  are another prompt. */
function scrubbed(prompt: string, sent: string): boolean {
  const parts = prompt.split(SCRUBBED);
  if (parts.length < 2) return false;
  let at = 0;
  let kept = 0;
  for (const [i, part] of parts.entries()) {
    const p = part.trim();
    if (!p) continue;
    const hit = sent.indexOf(p, at);
    if (hit < 0 || (i === 0 && hit !== 0)) return false;
    at = hit + p.length;
    kept += p.length;
  }
  const last = parts[parts.length - 1]!.trim();
  return kept >= 8 && (!last || at === sent.length);
}

/** Whether a turn's prompt is this message's words, once the machine's framing is off:
 *  the same words, the words with what the machine scrubbed taken out, or the head of a
 *  prompt the transcript cut short. */
function sameWords(sent: string, prompt: string): boolean {
  const b = norm(sent);
  if (!b) return false;
  const u = norm(prompt.replace(FRAME_HEAD, "").replace(FRAME_TAIL, ""));
  if (u === b || scrubbed(u, b)) return true;
  return b.length >= SENT_PREFIX_MIN && u.startsWith(b.slice(0, 200));
}

/** What the machine's framing adds to a message at most, as `prompt_chars` counts it. */
const FRAME_MAX = 400;

/** Whether a turn whose prompt can't be read (tier 2 sends its length only) could be this
 *  message: its length is the message's, give or take the machine's framing. */
function hiddenFits(m: SentMessage, t: Turn): boolean {
  const chars = t.start?.data.prompt_chars;
  if (typeof chars !== "number") return true;
  const n = m.text.trim().length;
  return chars >= n && chars <= n + FRAME_MAX;
}

/** Which turn each sent message became: oldest message first, each takes the first turn
 *  not yet taken that began after it was queued and whose prompt is its words. Two
 *  messages in a row each find their own turn, even with the same words. The turn is one
 *  that began with a `turn.started`, or the exchange a Stop handed the message over to.
 *
 *  "After it was queued" is read on one clock: the receiver stamps both the message and
 *  the turn's first event as it arrives, so a machine whose clock is minutes behind loses
 *  nothing. The machine's own times only rule a turn out: one dated long before the
 *  message (it arrived late), or after the machine's last word on the message (a message
 *  whose own turn is not loaded never takes a later one that says the same). A message
 *  the session never had (`reached`) takes none.
 *
 *  A turn whose prompt arrived as a length only (tier 2) is the first such message's when
 *  it started after the machine took it and the length fits; a `start` takes the session's
 *  first turn when `fromStart` (the loaded window begins at the session's beginning).
 *  `bodyOf` takes a prompt's attachments block off, the way the message's own text had it
 *  taken off. Returns message id → the turn's `n`. */
export function sentTurns(
  messages: readonly SentMessage[],
  turns: readonly Turn[],
  bodyOf: (text: string) => string = (t) => t,
  o: { fromStart?: boolean } = {},
): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  const sorted = [...messages].sort((a, b) => ms(a.at) - ms(b.at) || (a.id < b.id ? -1 : 1));
  const first = turns.find((t) => t.start);
  for (const m of sorted) {
    if (!reached(m)) continue;
    if (m.start) {
      if (!o.fromStart || !first || taken.has(first.n)) continue;
      const prompt = turnPrompt(first);
      if (prompt !== undefined ? !sameWords(m.text, bodyOf(prompt)) : !hiddenFits(m, first)) continue;
      out.set(m.id, first.n);
      taken.add(first.n);
      continue;
    }
    const queued = ms(m.at);
    const took = ms(m.takenAt) - SENT_SKEW_MS;
    const done = FINAL.has(m.outcome ?? "") ? ms(m.ackedAt) + SENT_SKEW_MS : Number.NaN;
    for (const t of turns) {
      if ((!t.start && t.continues === undefined) || taken.has(t.n)) continue;
      if (ms((t.start ?? handedBy(t))?.arrivedAt) < queued) continue;
      const at = ms(turnBegan(t));
      if (at < queued - SENT_STALE_MS || at > done) continue;
      const prompt = turnPrompt(t);
      if (prompt === undefined) {
        // Its words are hidden: only a turn the machine could have run for this message.
        if (!Number.isFinite(took) || at < took || !hiddenFits(m, t)) continue;
      } else if (!sameWords(m.text, bodyOf(prompt))) continue;
      out.set(m.id, t.n);
      taken.add(t.n);
      break;
    }
  }
  return out;
}

// ----- an event row's words -----

const base = (p: string): string => {
  const clean = p.replace(/[\\/]+$/, "");
  const i = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return i >= 0 ? clean.slice(i + 1) || clean : clean;
};
const word = (v: unknown): string => (typeof v === "string" ? v.replace(/_/g, " ") : "");
/** A harness as a sentence names it ("Claude Code", "Codex"). */
const harnessWord = (v: unknown): string => (typeof v === "string" && v ? harnessMark(v).label : "another agent");

/** Why a session ended, as a person says it (word() has already turned `_` into spaces). */
const ENDED_WHY: Record<string, string> = {
  exit: "left at the terminal",
  "prompt input exit": "left at the terminal",
  clear: "cleared",
  logout: "logged out",
};

/** An event the timeline shows as its own row, in words ("Session started", "Changed
 *  handler.ts and 2 more"), and the detail after them when it says something. The raw
 *  type stays in the row's tooltip and in "Copy event". */
export function eventWords(e: Pick<StoredEvent, "type" | "data">): { text: string; detail?: string } {
  const d = e.data ?? {};
  switch (e.type) {
    case "session.started": {
      const src = word(d.source);
      const text =
        src === "resume"
          ? "Session resumed"
          : src === "clear"
            ? "Session cleared"
            : src === "compact"
              ? "Session continued after compacting"
              : "Session started";
      return { text, ...(src && !["startup", "resume", "clear", "compact"].includes(src) ? { detail: src } : {}) };
    }
    case "session.ended": {
      // Claude Code's reasons in words ("exit" is the person leaving the prompt).
      const why = word(d.reason);
      const said = ENDED_WHY[why] ?? why;
      return { text: "Session ended", ...(said && why !== "other" ? { detail: said } : {}) };
    }
    case "session.backfill":
      return { text: "Earlier history read from the transcript" };
    case "session.heartbeat":
      return { text: "Still running" };
    case "files.changed": {
      const paths = Array.isArray(d.paths)
        ? (d.paths as unknown[]).filter((p): p is string => typeof p === "string")
        : [];
      if (paths.length === 0) return { text: "Changed files" };
      const more = paths.length - 1;
      // The folder after the name, so the name is never said twice.
      const dir = paths[0]!.slice(0, paths[0]!.length - base(paths[0]!).length).replace(/[\\/]+$/, "");
      return {
        text: `Changed ${base(paths[0]!)}${more > 0 ? ` and ${more} more` : ""}`,
        ...(dir ? { detail: dir } : {}),
      };
    }
    case "attention.cleared": {
      const how = word(d.how);
      if (!how || how === "answered" || how === "unknown") return { text: "Answered" };
      return { text: how === "timeout" || how === "expired" ? "The prompt expired" : `Cleared: ${how}` };
    }
    case "context.compacted":
      return { text: "Context compacted", ...(word(d.trigger) === "manual" ? { detail: "by hand" } : {}) };
    case "native":
      return { text: "A hook payload sessionpipe passed through as it came" };
    // An agent this session asked (sessionpipe ask, or a handoff relayed into it): the
    // harness's own name is the words' subject; the chat draws the row from the reading.
    case "delegation.started":
      return { text: `${d.via === "handoff" ? "You asked" : "Asked"} ${harnessWord(d.harness)}`, detail: "running" };
    case "delegation.ended": {
      const who = harnessWord(d.harness ?? (typeof d.to === "string" ? d.to.slice(0, d.to.indexOf(":")) : ""));
      const took = typeof d.ms === "number" ? dur(d.ms) : "";
      const detail =
        d.ok === false
          ? `failed${took ? ` after ${took}` : ""}${typeof d.error === "string" && d.error ? ` · ${d.error}` : ""}`
          : `answered${took ? ` in ${took}` : ""}${d.relayed === "delivered" ? " · answer relayed here" : ""}`;
      return { text: `Asked ${who}`, detail };
    }
    default: {
      const [noun, verb] = e.type.split(".");
      const t = [noun, verb].filter(Boolean).join(" ").replace(/_/g, " ");
      return { text: t.charAt(0).toUpperCase() + t.slice(1) };
    }
  }
}
