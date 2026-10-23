// SPDX-License-Identifier: Apache-2.0
// The in-page state: a snapshot from the stream, then deltas applied to immutable maps so
// useSyncExternalStore sees one new object per change. Sessions and machines are keyed;
// recent events are a ring (newest first) the Feed page reads; control activity is kept
// for the control engineer's strip.
import {
  type ControlActivity,
  EMPTY_LABELS,
  type Labels,
  type LabelsPatch,
  type MachineSummary,
  type SessionKey,
  type SessionSummary,
  type Stats,
  type StoredEvent,
  type StreamMessage,
  type Suggestion,
  type Viewer,
} from "@shared/api";
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
  /** Newest first, capped at 200. */
  control: readonly ControlActivity[];
  /** Browsers on the stream right now, this one marked `current`. */
  viewers: readonly Viewer[];
  /** Plugins' suggested answers to open permissions (shared/plugin-api.ts); one per
   *  attention, kept only while that attention is open. Advice: a person confirms it. */
  suggestions: readonly Suggestion[];
  /** The person's colour labels, the same on every device (server/ui/labels.ts). */
  labels: Labels;
  /** The newest ETag of each view's server-side state (`viewState` frames), so a mounted
   *  view can re-read what another device wrote. */
  viewStates: ReadonlyMap<string, string>;
  /** Counts every message, so a page can tell "something changed" cheaply. */
  version: number;
}

export const RING = 1500;

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
  viewStates: new Map(),
  version: 0,
};

export type EventListener = (e: StoredEvent, session: SessionSummary) => void;

export class Store {
  private state: AppState = initial;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<EventListener>();
  private stop: (() => void) | null = null;
  private seen = new Set<string>();

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

  start() {
    if (this.stop) return;
    this.stop = this.transport.openStream({
      onMessage: (m) => this.apply(m),
      onOpen: () => this.set({ connection: this.state.snapshotAt ? "live" : "connecting", retryAt: null }),
      onError: (retryIn) => {
        const offline = typeof navigator !== "undefined" && navigator.onLine === false;
        this.set({ connection: offline ? "offline" : "reconnecting", retryAt: Date.now() + retryIn });
      },
    });
  }

  close() {
    this.stop?.();
    this.stop = null;
  }

  /** "Retry now": drop the backoff and open the stream again at once. The rows stay as
   *  they were until the fresh snapshot lands. */
  reconnect() {
    this.close();
    this.set({ connection: "connecting", retryAt: null });
    this.start();
  }

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    for (const l of this.listeners) l();
  }

  apply(m: StreamMessage) {
    switch (m.kind) {
      case "snapshot": {
        const s = m.snapshot;
        this.seen.clear();
        this.set({
          connection: "live",
          retryAt: null,
          snapshotAt: s.at,
          sessions: new Map(s.sessions.map((x) => [x.key, x])),
          machines: new Map(s.machines.map((x) => [x.name, x])),
          stats: s.stats,
          viewers: s.viewers ?? [],
          suggestions: s.suggestions ?? [],
          labels: s.labels ?? this.state.labels,
        });
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
        machines.set(m.machine.name, m.machine);
        this.set({ machines });
        return;
      }
      case "stats":
        this.set({ stats: m.stats });
        return;
      case "control": {
        const control = [m.message, ...this.state.control.filter((c) => c.id !== m.message.id)].slice(0, 200);
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
