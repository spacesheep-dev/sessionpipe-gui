// SPDX-License-Identifier: Apache-2.0
// The in-page state: a snapshot from the stream, then deltas applied to immutable maps so
// useSyncExternalStore sees one new object per change. Sessions and machines are keyed;
// recent events are a ring (newest first) the Feed page reads; control activity is kept
// for the control engineer's strip. Nothing here goes back: a snapshot after the first is
// the stream come back and counts as one (`resyncs`), so a page reads again what it read
// on its own, and of two copies of a control message the one further along stays.
import {
  type ControlActivity,
  EMPTY_LABELS,
  EMPTY_MARKS,
  type Labels,
  type LabelsPatch,
  type LimitsEntry,
  type MachineSummary,
  type Marks,
  type MarksPatch,
  type SessionKey,
  type SessionSummary,
  type Stats,
  type StoredEvent,
  type StreamMessage,
  type Suggestion,
  type Viewer,
} from "@shared/api";
import { noteMachineControl } from "../control/remoteRp";
import type { Transport } from "./transport";

export type Connection = "connecting" | "live" | "reconnecting" | "offline";

export interface AppState {
  connection: Connection;
  /** When the next reconnect attempt is due (ms epoch), while reconnecting. */
  retryAt: number | null;
  snapshotAt: string | null;
  sessions: ReadonlyMap<SessionKey, SessionSummary>;
  machines: ReadonlyMap<string, MachineSummary>;
  stats: Stats | null;
  /** Newest first, capped at RING. */
  recent: readonly StoredEvent[];
  /** The receiver's control activity as this page knows it, the last one heard of first,
   *  at most CONTROL_KEEP: the stream's `control` frames, over what GET /activity said once
   *  a page asked (`loadControl`), read again after every snapshot that follows the first.
   *  Of two copies of one message the one further along stays (`furthest`). */
  control: readonly ControlActivity[];
  /** The snapshots since the first. Each is the stream come back (a drop, Retry now, a
   *  pull to refresh, the page shown again after a long time away): what a page read on
   *  its own, a session's events, is read again when this moves. */
  resyncs: number;
  /** Browsers on the stream right now, this one marked `current`. */
  viewers: readonly Viewer[];
  /** Plugins' suggested answers to open permissions (shared/plugin-api.ts); one per
   *  attention, kept only while that attention is open. Advice: a person confirms it. */
  suggestions: readonly Suggestion[];
  /** The person's colour labels, the same on every device (server/ui/labels.ts). */
  labels: Labels;
  /** What the person has seen, the same on every device (server/ui/marks.ts). */
  marks: Marks;
  /** Each account's newest usage limits (server/ui/limits.ts), the whole list from the
   *  snapshot and from every `limits` frame. */
  limits: readonly LimitsEntry[];
  /** The newest ETag of each view's server-side state (`viewState` frames), so a mounted
   *  view can re-read what another device wrote. */
  viewStates: ReadonlyMap<string, string>;
  /** Counts every message, so a page can tell "something changed" cheaply. */
  version: number;
}

export const RING = 1500;
/** Control messages kept: the history a page asks for (CONTROL_HISTORY) and the stream's. */
export const CONTROL_KEEP = 500;
export const CONTROL_HISTORY = 300;
/** How many times one read of the history is asked for, and the wait before the second
 *  (the third waits twice as long). */
export const CONTROL_TRIES = 3;
export const CONTROL_RETRY_MS = 1500;
/** How long a stream opened again without a word (`resync`) may take to bring its
 *  snapshot before the page says it is reconnecting. */
export const RESYNC_QUIET_MS = 1500;

const FINAL = new Set<ControlActivity["outcome"]>(["delivered", "expired", "unsupported", "failed", "refused"]);

/** Of two copies of one control message, the one further along its way (server/control/
 *  README.md: queued, then `taken` and the reply so far by `replySeq`, then one final
 *  outcome); `b`, the later read, when neither is. A message only moves forward on the
 *  receiver, so the copy that is behind is the older one, however late it lands: the
 *  answer to a GET that a frame overtook, or a frame an answer overtook. */
export function furthest(a: ControlActivity, b: ControlActivity): ControlActivity {
  const fa = FINAL.has(a.outcome);
  if (fa !== FINAL.has(b.outcome)) return fa ? a : b;
  if (fa) return b;
  const seq = (a.replySeq ?? -1) - (b.replySeq ?? -1);
  if (seq !== 0) return seq > 0 ? a : b;
  return (a.takenAt ?? "") > (b.takenAt ?? "") ? a : b;
}

/** The page's activity with an answer of GET /activity folded in: each message it holds
 *  stays where it is, as the copy further along (the very object it held when the answer
 *  says nothing new, so nothing redraws); the ones it had not heard of go after, newest
 *  first. */
export function mergeControl(have: readonly ControlActivity[], read: readonly ControlActivity[]): ControlActivity[] {
  const byId = new Map(read.map((a) => [a.id, a]));
  const out = have.map((a) => {
    const b = byId.get(a.id);
    if (!b) return a;
    byId.delete(a.id);
    const next = furthest(a, b);
    return next === b && JSON.stringify(a) === JSON.stringify(b) ? a : next;
  });
  const rest = [...byId.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return [...out, ...rest].slice(0, CONTROL_KEEP);
}

const initial: AppState = {
  connection: "connecting",
  retryAt: null,
  snapshotAt: null,
  sessions: new Map(),
  machines: new Map(),
  stats: null,
  recent: [],
  control: [],
  viewers: [],
  suggestions: [],
  labels: EMPTY_LABELS,
  marks: EMPTY_MARKS,
  limits: [],
  viewStates: new Map(),
  resyncs: 0,
  version: 0,
};

export type EventListener = (e: StoredEvent, session: SessionSummary) => void;

export class Store {
  private state: AppState = initial;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<EventListener>();
  private frameListeners = new Set<(m: StreamMessage) => void>();
  private stop: (() => void) | null = null;
  private seen = new Set<string>();
  /** The `resyncs` the control activity was last asked for at; null until a page asks. */
  private controlAt: number | null = null;
  private quiet: ReturnType<typeof setTimeout> | null = null;

  constructor(public readonly transport: Transport) {}

  get = (): AppState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  /** Live events as they arrive, for pages that append to their own lists. */
  onEvent = (l: EventListener): (() => void) => {
    this.eventListeners.add(l);
    return () => {
      this.eventListeners.delete(l);
    };
  };

  /** Every stream frame, after `apply` took what it knows: a module that owns a kind of
   *  its own (the workflows' `workflowRun` / `workflows`) reads it from here. */
  onMessage = (l: (m: StreamMessage) => void): (() => void) => {
    this.frameListeners.add(l);
    return () => {
      this.frameListeners.delete(l);
    };
  };

  start() {
    if (this.stop) return;
    this.stop = this.transport.openStream({
      onMessage: (m) => {
        this.apply(m);
        for (const l of this.frameListeners) l(m);
      },
      // An open stream has said nothing yet. Only its snapshot makes the page live: until
      // it lands the rows are the ones from before, and a page that dropped stays dropped.
      onOpen: () =>
        this.set({ connection: this.state.snapshotAt ? this.state.connection : "connecting", retryAt: null }),
      onError: (retryIn) => {
        this.hush();
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        this.set({ connection: offline ? "offline" : "reconnecting", retryAt: Date.now() + retryIn });
      },
    });
  }

  close() {
    this.hush();
    this.stop?.();
    this.stop = null;
  }

  private hush() {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = null;
  }

  private down(): boolean {
    return this.state.connection === "reconnecting" || this.state.connection === "offline";
  }

  /** "Retry now": drop the backoff and open the stream again at once. The rows stay as
   *  they were until the fresh snapshot lands, and a page that knows it dropped goes on
   *  saying so until then. */
  reconnect() {
    this.close();
    this.set({ connection: this.state.snapshotAt && this.down() ? "reconnecting" : "connecting", retryAt: null });
    this.start();
  }

  /** The page came back (data/resume.ts: shown again after a long time hidden, out of the
   *  back/forward cache, awake, online): the stream it holds may be open in name only, so
   *  it is opened again for a fresh snapshot, without a word unless that takes longer than
   *  RESYNC_QUIET_MS. Before the first snapshot it only cuts a backoff short. */
  resync() {
    if (!this.stop || this.quiet) return;
    if (!this.state.snapshotAt) {
      if (this.down()) this.reconnect();
      return;
    }
    this.close();
    if (this.down()) this.set({ retryAt: null });
    this.start();
    this.quiet = setTimeout(() => {
      this.quiet = null;
      if (this.state.connection === "live") this.set({ connection: "reconnecting", retryAt: null });
    }, RESYNC_QUIET_MS);
  }

  /** Read the receiver's control activity under the stream's frames: when a page first
   *  asks, and from then on by the store itself after each snapshot that follows the
   *  first, once. An answer that does not come is asked for again, CONTROL_TRIES times
   *  in all, and after that by the next page that asks. */
  loadControl = (): void => {
    const at = this.state.resyncs;
    if (this.controlAt === at) return;
    this.controlAt = at;
    const ask = (tries: number): void => {
      const read = this.transport.controlActivity?.(CONTROL_HISTORY);
      if (!read) return;
      read.then(
        (list) => this.set({ control: mergeControl(this.state.control, list) }),
        () => {
          // A newer snapshot has asked since: that answer is the one that counts.
          if (this.controlAt !== at) return;
          if (tries >= CONTROL_TRIES) this.controlAt = -1;
          else setTimeout(() => this.controlAt === at && ask(tries + 1), CONTROL_RETRY_MS * tries);
        },
      );
    };
    ask(1);
  };

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    for (const l of this.listeners) l();
  }

  apply(m: StreamMessage) {
    switch (m.kind) {
      case "snapshot": {
        const s = m.snapshot;
        const again = this.state.snapshotAt !== null;
        this.hush();
        this.seen.clear();
        this.set({
          connection: "live",
          retryAt: null,
          resyncs: this.state.resyncs + (again ? 1 : 0),
          snapshotAt: s.at,
          sessions: new Map(s.sessions.map((x) => [x.key, x])),
          machines: new Map(s.machines.map((x) => (noteMachineControl(x.control), [x.name, x]))),
          stats: s.stats,
          viewers: s.viewers ?? [],
          suggestions: s.suggestions ?? [],
          labels: s.labels ?? this.state.labels,
          marks: s.marks ?? this.state.marks,
          limits: s.limits ?? [],
        });
        // The frames of the drop are gone for good: what they said of the messages is asked for.
        if (again && this.controlAt !== null) this.loadControl();
        return;
      }
      case "event": {
        const e = m.event;
        const dedup = `${e.harness.name}:${e.session.id}:${e.session.seq}`;
        if (this.seen.has(dedup)) return;
        this.seen.add(dedup);
        if (this.seen.size > RING * 2) {
          // Forget the oldest half; a replay that old is already out of the ring.
          const keep = [...this.seen].slice(-RING);
          this.seen = new Set(keep);
        }
        const sessions = new Map(this.state.sessions);
        sessions.set(m.session.key, m.session);
        const recent = [e, ...this.state.recent];
        if (recent.length > RING) recent.length = RING;
        this.set({ sessions, recent, suggestions: this.pruneSuggestions(m.session) });
        for (const l of this.eventListeners) l(e, m.session);
        return;
      }
      case "session": {
        const sessions = new Map(this.state.sessions);
        sessions.set(m.session.key, m.session);
        this.set({ sessions, suggestions: this.pruneSuggestions(m.session) });
        return;
      }
      case "forgotten": {
        const sessions = new Map(this.state.sessions);
        sessions.delete(m.key);
        const recent = this.state.recent.filter((e) => `${e.harness.name}:${e.session.id}` !== m.key);
        const suggestions = this.state.suggestions.filter((s) => s.session !== m.key);
        this.set({ sessions, recent, suggestions });
        return;
      }
      case "machine": {
        const machines = new Map(this.state.machines);
        noteMachineControl(m.machine.control);
        machines.set(m.machine.name, m.machine);
        this.set({ machines });
        return;
      }
      case "stats":
        this.set({ stats: m.stats });
        return;
      case "control": {
        const had = this.state.control.find((c) => c.id === m.message.id);
        const control = [
          had ? furthest(had, m.message) : m.message,
          ...this.state.control.filter((c) => c.id !== m.message.id),
        ].slice(0, CONTROL_KEEP);
        this.set({ control });
        return;
      }
      case "viewers":
        this.set({ viewers: m.viewers });
        return;
      case "labels":
        // Whole documents, numbered: one older than what the page has (a frame overtaken by
        // the answer to its own PATCH) changes nothing.
        if (m.labels.rev >= this.state.labels.rev) this.set({ labels: m.labels });
        return;
      case "marks":
        if (m.marks.rev >= this.state.marks.rev) this.set({ marks: m.marks });
        return;
      case "limits":
        this.set({ limits: m.limits });
        return;
      case "viewState": {
        const viewStates = new Map(this.state.viewStates);
        viewStates.set(m.id, m.etag);
        this.set({ viewStates });
        return;
      }
      case "suggestion": {
        const s = m.suggestion;
        const suggestions = [
          ...this.state.suggestions.filter((x) => !(x.session === s.session && x.attentionId === s.attentionId)),
          s,
        ];
        this.set({ suggestions });
        return;
      }
      default:
        return;
    }
  }

  /** Set or clear labels and label names: applied here at once, then the server's answer
   *  (or the frame it sends every page) replaces it; on a refusal the page goes back to
   *  what it had and the promise rejects with the server's reason. */
  async patchLabels(p: LabelsPatch): Promise<Labels> {
    const before = this.state.labels;
    const sessions = { ...before.sessions };
    for (const [k, c] of Object.entries(p.sessions ?? {})) {
      if (c === null) delete sessions[k];
      else sessions[k] = c;
    }
    const names = { ...before.names };
    for (const [c, n] of Object.entries(p.names ?? {}) as [keyof Labels["names"], string | null][]) {
      const t = n?.trim();
      if (t) names[c] = t;
      else delete names[c];
    }
    // The optimistic copy keeps the rev, so the server's answer (rev + 1) always wins.
    this.set({ labels: { rev: before.rev, names, sessions } });
    try {
      const next = await this.transport.patchLabels(p);
      if (next.rev >= this.state.labels.rev) this.set({ labels: next });
      return next;
    } catch (e) {
      if (this.state.labels.rev === before.rev) this.set({ labels: before });
      throw e;
    }
  }

  /** Mark sessions read (up to a `newsAt`) or unread, the way patchLabels sets labels:
   *  shown at once, the server's answer replaces it, a refusal puts it back. */
  async patchMarks(p: MarksPatch): Promise<Marks> {
    const before = this.state.marks;
    const read = { ...before.read };
    for (const [k, at] of Object.entries(p.read ?? {})) {
      if (at === null) delete read[k];
      else read[k] = at;
    }
    const unread = { ...before.unread };
    for (const [k, on] of Object.entries(p.unread ?? {})) {
      if (on === null) delete unread[k];
      else unread[k] = true;
    }
    const notify = { ...before.notify };
    for (const [k, level] of Object.entries(p.notify ?? {})) {
      if (level === null) delete notify[k];
      else notify[k] = level;
    }
    this.set({ marks: { ...before, read, unread, ...(p.notify && { notify }) } });
    try {
      const next = await this.transport.patchMarks(p);
      if (next.rev >= this.state.marks.rev) this.set({ marks: next });
      return next;
    } catch (e) {
      if (this.state.marks.rev === before.rev) this.set({ marks: before });
      throw e;
    }
  }

  /** A suggestion outlives neither its attention nor its session (the server drops it
   *  the same way; this keeps the page right between frames). */
  private pruneSuggestions(session: SessionSummary): readonly Suggestion[] {
    const cur = this.state.suggestions;
    if (!cur.some((s) => s.session === session.key)) return cur;
    return cur.filter(
      (s) => s.session !== session.key || session.openAttentions.some((a) => a.attentionId === s.attentionId),
    );
  }
}
