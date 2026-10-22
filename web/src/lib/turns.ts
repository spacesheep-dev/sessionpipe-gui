// SPDX-License-Identifier: Apache-2.0
// A session's events grouped by turn, as the timeline and the chat draw them, and which
// of those turns a message sent from here became. Pure, so both are unit-tested.
import type { StoredEvent } from "@shared/api";

export interface Turn {
  n: number;
  start?: StoredEvent;
  items: Item[];
}
export type Item =
  | { kind: "tool"; key: string; started?: StoredEvent; ended?: StoredEvent }
  | { kind: "event"; key: string; e: StoredEvent };
export type EventItem = Extract<Item, { kind: "event" }>;
export type ToolItem = Extract<Item, { kind: "tool" }>;

/** How far a transcript's `at` may sit outside a turn's span and still be that turn's. The
 *  sender stamps the exchange with its prompt's time (the sim with its end), and the hook
 *  with when it ran: the two differ by moments, while turns sit seconds apart. */
const TRANSCRIPT_SLACK_MS = 10_000;

const ms = (iso: unknown): number => (typeof iso === "string" ? Date.parse(iso) : Number.NaN);
const endedAt = (t: Turn): number => {
  const end = t.items.find((i) => i.kind === "event" && i.e.type === "turn.ended") as EventItem | undefined;
  return end ? ms(end.e.time) : Number.NaN;
};

/** The turn a `turn.transcript` describes, by time: its `at` falls inside the turn's span
 *  (start to end, or to the next turn's start). Its `turn` number can't say: the sender
 *  counts the exchanges it read from the transcript file (from 0, and from wherever it
 *  first read), never the hook turns, and the loaded window starts mid-session. A late
 *  read hands the last two exchanges over at once, so counting from the newest turn put a
 *  turn's words on the one before it ("the second prompt showed as 'hi'"). `undefined`
 *  when no loaded turn is close: an exchange from before the window, or the history a
 *  fork copied. `null` when the time can't be read. */
function transcriptHome(turns: Turn[], at: number): Turn | null | undefined {
  if (!Number.isFinite(at)) return null;
  let best: Turn | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const start = ms(t.start?.time);
    if (!Number.isFinite(start)) continue;
    const next = turns[i + 1];
    const end = endedAt(t);
    const until = Number.isFinite(end) ? end : next ? ms(next.start?.time) : Number.POSITIVE_INFINITY;
    const d = at < start ? start - at : at > until ? at - until : 0;
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return bestD <= TRANSCRIPT_SLACK_MS ? best : undefined;
}

export function groupTurns(events: StoredEvent[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn = { n: 0, items: [] };
  turns.push(cur);
  let openTools = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const e of events) {
    if (e.type === "turn.started") {
      cur = { n: turns.length, start: e, items: [] };
      turns.push(cur);
      openTools = new Map();
      continue;
    }
    if (e.type === "tool.started") {
      const id = String(e.data.call_id ?? `${e.data.tool}#${e.session.seq}`);
      const item: Extract<Item, { kind: "tool" }> = { kind: "tool", key: `t:${e.session.seq}`, started: e };
      cur.items.push(item);
      openTools.set(id, item);
      if (!e.data.call_id) openTools.set(`name:${e.data.tool}`, item);
      continue;
    }
    if (e.type === "tool.ended") {
      const id = typeof e.data.call_id === "string" ? e.data.call_id : undefined;
      const open = (id ? openTools.get(id) : undefined) ?? openTools.get(`name:${e.data.tool}`);
      if (open && !open.ended) {
        open.ended = e;
        if (id) openTools.delete(id);
        openTools.delete(`name:${e.data.tool}`);
      } else {
        cur.items.push({ kind: "tool", key: `e:${e.id}`, ended: e });
      }
      continue;
    }
    if (e.type === "turn.transcript" && turns.length > 1) {
      // Attach to the turn it describes; one that is none of the loaded turns is left out.
      const home = transcriptHome(turns, ms(e.data.at));
      if (home === undefined) continue;
      (home ?? cur).items.push({ kind: "event", key: e.id, e });
      continue;
    }
    cur.items.push({ kind: "event", key: e.id, e });
  }
  return turns.filter((t) => t.start || t.items.length > 0);
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
 *  receiver queued it, and its words (without an attachments block). */
export interface SentMessage {
  id: string;
  at: string;
  text: string;
}

/** The receiver's clock and the machine's need not agree; a turn can't start before its
 *  message was queued by more than this. */
const SENT_SKEW_MS = 60_000;
/** Shorter than this, the words must match exactly ("hi" is in "this"). */
const SENT_PREFIX_MIN = 24;

// The machine frames what it hands a session (sessionpipe's control/route.ts): a source
// line before a message to a running session, a source note after a new session's first.
const FRAME_HEAD = /^Message via [^\n]*\(sessionpipe control[^\n]*\):\s*/;
const FRAME_TAIL = /\s*\(Sent via [^\n]* with sessionpipe control[^\n]*\)\s*$/;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** A prompt as the person wrote it: the machine's framing taken off, and where it was sent
 *  from ("localhost", "studio-mac.local:7373") when the framing said. */
export function unframe(prompt: string): { text: string; via?: string } {
  const head = /^Message via ([^\n(]*?)\s*\(sessionpipe control/.exec(prompt);
  const text = prompt.replace(FRAME_HEAD, "").replace(FRAME_TAIL, "");
  if (text === prompt) return { text };
  const tail = /\(Sent via ([^\n]*?) with sessionpipe control/.exec(prompt);
  return { text, via: head?.[1] || tail?.[1] || undefined };
}

/** Whether a turn's prompt is this message's words, once the machine's framing is off. */
function sameWords(sent: string, prompt: string): boolean {
  const b = norm(sent);
  if (!b) return false;
  const u = norm(prompt.replace(FRAME_HEAD, "").replace(FRAME_TAIL, ""));
  if (u === b) return true;
  return b.length >= SENT_PREFIX_MIN && u.startsWith(b.slice(0, 200));
}

/** Which turn each sent message became: oldest message first, each takes the first turn
 *  not yet taken that started after it was queued and whose prompt is its words. Two
 *  messages in a row each find their own turn, even with the same words. `bodyOf` takes
 *  a prompt's attachments block off, the way the message's own text had it taken off.
 *  Returns message id → the turn's `n`. */
export function sentTurns(
  messages: readonly SentMessage[],
  turns: readonly Turn[],
  bodyOf: (text: string) => string = (t) => t,
): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  const sorted = [...messages].sort((a, b) => ms(a.at) - ms(b.at) || (a.id < b.id ? -1 : 1));
  for (const m of sorted) {
    const since = ms(m.at) - SENT_SKEW_MS;
    for (const t of turns) {
      if (!t.start || taken.has(t.n)) continue;
      if (Number.isFinite(since) && ms(t.start.time) < since) continue;
      const prompt = turnPrompt(t);
      if (prompt === undefined || !sameWords(m.text, bodyOf(prompt))) continue;
      out.set(m.id, t.n);
      taken.add(t.n);
      break;
    }
  }
  return out;
}
