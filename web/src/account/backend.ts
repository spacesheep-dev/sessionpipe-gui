// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The backend of a page that shows a spacesheep account (docs/rfcs/08, "The
// phone on an account"). There is no receiver: the page carries its own board. It puts
// together the same parts the receiver does (server/app.ts), each of them the receiver's
// own file: the store's core over a log of the page's own, the labels, the marks and the limits,
// the machines and sends of the account (MemoryControl), and the relay's reader. What is
// the page's own is where they are kept (IndexedDB for the relay's pages, the hub's
// documents for what is the person's) and how spacesheep is reached (the hub's five doors).
//
// It answers the page two ways: as a Transport (data/transport.ts), with its own event bus
// where the receiver has a stream, and as the answer to the page's plain requests of
// /api/ui/* (lib/net.ts apiFetch; routes.ts). Nothing here reaches the network but the
// doors.
import type {
  Info,
  ProtocolEvent,
  SessionKey,
  Snapshot,
  SpacesheepSourceStatus,
  StoredEvent,
  StreamMessage,
} from "@shared/api";
import { sessionKey } from "@shared/api";
import { indexTouches } from "@shared/files";
import { type KeptQueues, MemoryControl, type RemoteJobWord } from "../../../server/control/remote";
import { machineFrame, type RemoteMachine, toActivity } from "../../../server/control/rows";
import {
  cursorFrom,
  type RelayClock,
  type RelayKept,
  type RelayReader,
  type RelayStatus,
  startRelayReader,
} from "../../../server/sources/relay";
import { StoreCore } from "../../../server/store/core";
import { LabelsCore } from "../../../server/ui/labelsCore";
import { LimitsCore } from "../../../server/ui/limitsCore";
import { MarksCore } from "../../../server/ui/marksCore";
import { cutPreview } from "../../../server/ui/preview";
import { snapshotWithControl } from "../../../server/ui/snapshot";
import { HttpError, type StreamHandlers, type Transport } from "../data/transport";
import type { ApiBackend } from "../lib/net";
import { type EventCache, openCache, sweepCaches, withoutSessions } from "./cache";
import { type AccountDocs, openDocs } from "./docs";
import { type AccountDoors, type DoorAnswer, openDoors } from "./doors";
import { PageLog } from "./log";
import { routes } from "./routes";
import { fitSends, readSends } from "./sends";
import {
  type AccountShell,
  type AccountState,
  type AccountStatus,
  type DeviceAsked,
  type Disconnected,
  NEEDS_FEATURE,
  type NeedsSession,
  type ShellCalls,
} from "./shell";

/** Something a person should be told once: the events are not kept between launches
 *  (`cache_memory`), or one of the documents is not (`doc_memory`, with its names). */
export interface AccountNotice {
  kind: "cache_memory" | "doc_memory";
  names?: string[];
}

export interface AccountBackendOptions {
  shell: AccountShell;
  calls: ShellCalls;
  fetch?: typeof fetch;
  /** Where the relay's pages are cached; null: nowhere (memory). Absent: this page's own. */
  idb?: IDBFactory | null;
  /** The cache itself, in place of one opened on `idb` (a test's). */
  cache?: EventCache;
  clock?: RelayClock;
  notice?: (n: AccountNotice) => void;
}

/** How the account stands, for whoever draws it. */
export interface AccountView {
  id: string;
  origin: string;
  email: string;
  /** As the hub last said; `gone` once the account was disconnected. */
  state: AccountState | "gone";
  relay: RelayStatus;
  /** History is still being read: the board fills in. */
  catching: boolean;
  /** Where the relay's pages are kept. */
  cache: EventCache["kind"];
  /** What was read back at the start, when anything was. */
  restored: { events: number; pages: number; readMs: number; bootMs: number } | null;
  /** When the first board was handed to the page, in ms since the backend began. */
  firstBoardMs: number | null;
  /** When history was all read, in ms since the backend began. */
  caughtUpMs: number | null;
  store: { events: number; sessions: number; bytes: number };
}

export interface AccountBackend {
  transport: Transport;
  /** The page's requests of /api/ui/* and the receiver's other paths, answered here. */
  answer: ApiBackend;
  view(): AccountView;
  /** Told whenever `view()` would say something else. */
  subscribe(l: () => void): () => void;
  /** Asks spacesheep to trust this phone's own device key (`acct_device_ask`). */
  deviceAsk(): Promise<DeviceAsked>;
  /** Where that key stands (the device door). */
  device(): Promise<DoorAnswer>;
  /** Forgets the account on this phone, with everything this page kept for it. The hub
   *  asks the person first; a no is thrown as the hub's error. */
  disconnect(): Promise<Disconnected>;
  /** Every request the page made of the backend's routes and what it got: "GET /api/ui/info" → 200. */
  asked: Map<string, number>;
  /** Resolves when what was handed to the cache and the documents so far is kept. */
  flushed(): Promise<void>;
  stop(): void;
}

/** An account whose key was made this recently has had no reader before this one. */
export const FRESH_MS = 120_000;
/** While history is read, the board is handed over again this often. */
export const BOARD_EVERY_MS = 1500;
/** A page of this many events or more is history, whenever it comes: one board, not a frame an event. */
export const BURST_EVENTS = 50;
const MACHINES_FRAME_MS = 300;

const json = (body: unknown, status = 200): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export async function startAccountBackend(o: AccountBackendOptions): Promise<AccountBackend> {
  const { shell, calls } = o;
  const t0 = performance.now();
  const startedAt = new Date().toISOString();
  const [cache, docs, first] = await Promise.all([
    o.cache ?? openCache(shell.id, o.idb === null ? undefined : (o.idb ?? globalThis.indexedDB)),
    openDocs(calls, shell.id),
    calls.status().catch(() => null),
  ]);
  const loaded = await cache.load();
  // An account disconnected while no window showed it left its pages behind: they go now.
  if (first && o.idb !== null)
    void sweepCaches(
      first.accounts.map((a) => a.id),
      o.idb ?? globalThis.indexedDB,
    );

  // ---------- the parts, as the receiver puts them together ----------
  // The index keeps its previews whole, so its copy of an event it did not cut is the
  // event, and the log keeps only the ones it did (log.ts).
  const b0 = performance.now();
  const store = new StoreCore("account", { keepDays: 0 }, new PageLog(loaded.events));
  const restored = loaded.events.length
    ? { events: loaded.events.length, pages: loaded.pages, readMs: loaded.ms, bootMs: performance.now() - b0 }
    : null;
  const known = (key: string): boolean => store.sessionExists(key);
  const labels = new LabelsCore(docs.keep("labels"), known);
  labels.follow(store);
  const marks = new MarksCore(docs.keep("marks"), known);
  marks.follow(store);
  const limits = new LimitsCore(docs.keep("limits"));
  limits.follow(store);
  const sends = docs.keep("sends");
  const control = new MemoryControl({
    kept: readSends(sends.load()),
    onSave: (queues: KeptQueues) => sends.save(fitSends(queues)),
  });

  // ---------- the bus ----------
  const listeners = new Set<(m: StreamMessage) => void>();
  const emit = (m: StreamMessage): void => {
    for (const l of [...listeners]) {
      try {
        l(m);
      } catch (e) {
        console.error("[account] listener: %s", (e as Error).message);
      }
    }
  };
  const watchers = new Set<() => void>();
  const changed = (): void => {
    for (const l of [...watchers]) l();
  };
  /** History is being read (or one big page of it is being taken): frames are held back,
   *  and the board goes out whole instead. */
  let catching = true;
  let holding = false;
  let boarded = false;
  let lastBoard = Number.NEGATIVE_INFINITY;
  let firstBoardMs: number | null = null;
  let caughtUpMs: number | null = null;
  let state: AccountView["state"] = shell.state;
  let rp = "";

  const snapshot = (): Snapshot => ({
    ...snapshotWithControl(store, control),
    labels: labels.get(),
    marks: marks.get(),
    limits: limits.list(),
  });
  const board = (): void => {
    boarded = true;
    lastBoard = performance.now();
    if (firstBoardMs === null) firstBoardMs = lastBoard - t0;
    emit({ kind: "snapshot", snapshot: snapshot() });
    needs.tell();
    changed();
  };
  store.subscribe((m) => {
    if (catching || holding) return;
    if (m.kind === "machine") {
      const c = control.machines().get(m.machine.name);
      emit({ kind: "machine", machine: c ? { ...m.machine, control: c } : m.machine });
    } else emit(m);
    if (m.kind === "event" || m.kind === "session" || m.kind === "forgotten") needs.tell();
  });
  control.onMessage = (row) => emit({ kind: "control", message: toActivity(row) });
  // A machine frame from control carries only what the relay's list said; the store's
  // reading of that machine (sessions, versions) wins when it has one (ui/stream.ts).
  let machinesTimer: ReturnType<typeof setTimeout> | null = null;
  control.onMachines = () => {
    if (machinesTimer) return;
    machinesTimer = setTimeout(() => {
      machinesTimer = null;
      const snap = catching ? null : snapshot();
      for (const [name, c] of control.machines()) {
        const frame = machineFrame(name, c);
        // A pooled account's windows ride on the machine's facts (limitsCore observeMachine).
        limits.observeMachine(frame);
        if (snap) emit({ kind: "machine", machine: snap.machines.find((x) => x.name === name) ?? frame });
      }
      changed();
    }, MACHINES_FRAME_MS);
  };
  labels.subscribe(emit);
  marks.subscribe(emit);
  limits.subscribe(emit);

  // ---------- needs-you, handed to the shell where it takes it ----------
  const needs = (() => {
    let said = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const list = (): NeedsSession[] =>
      store
        .snapshot()
        .sessions.filter((s) => s.state === "needs_you")
        .slice(0, 200)
        .map((s) => ({
          key: s.key,
          harness: s.harness,
          id: s.id,
          ...(s.title ? { title: s.title } : {}),
          ...(s.machine ? { machine: s.machine } : {}),
          ...(s.cwd ? { cwd: s.cwd } : {}),
          state: "needs_you" as const,
          stateSince: s.stateSince,
          openAttentions: s.openAttentions.map((a) => ({
            attentionId: a.attentionId,
            kind: a.kind,
            ...(a.tool ? { tool: a.tool } : {}),
            ...(a.message ? { message: a.message.slice(0, 300) } : {}),
            at: a.at,
            answerable: !!a.answerable,
          })),
        }));
    const send = (): void => {
      timer = null;
      const sessions = list();
      const now = JSON.stringify(sessions);
      if (now === said) return;
      said = now;
      void calls.needs(shell.id, sessions).catch(() => {
        // Not said after all: the next change tries again.
        said = "";
      });
    };
    return {
      /** The list may have changed: said to the shell shortly, once, when it did. */
      tell(): void {
        if (!shell.features.includes(NEEDS_FEATURE) || !boarded || timer) return;
        timer = setTimeout(send, 400);
      },
      stop(): void {
        if (timer) clearTimeout(timer);
      },
    };
  })();

  // ---------- the doors and the reader ----------
  let reader: RelayReader | null = null;
  const doors: AccountDoors = openDoors({
    rxBase: shell.rxBase,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    onUnauthorized: () => reader?.unauthorized(),
  });
  const kept = new Map<RelayKept, unknown>(Object.entries(loaded.kept) as [RelayKept, unknown][]);
  let pending: StoredEvent[] = [];
  const me = first?.accounts.find((a) => a.id === shell.id);
  const connectedAt = me?.connectedAt ? Date.parse(me.connectedAt) : Number.NaN;
  // Nothing kept and the key made a moment ago: nobody read with it before this page.
  const fresh =
    kept.get("cursor") === undefined &&
    kept.get("reads") === undefined &&
    Number.isFinite(connectedAt) &&
    Math.abs(Date.now() - connectedAt) < FRESH_MS;
  /** The relay is read from its start (nothing was kept): all of it is history. */
  let cold = cursorFrom(kept.get("cursor"), shell.origin, shell.email) === 0;
  const caughtUp = (): void => {
    if (!catching) return;
    catching = false;
    store.setLoading(false);
    if (caughtUpMs === null) caughtUpMs = performance.now() - t0;
    // A session's news is dated by when it arrived here, and history arrived just now: none
    // of it is news. What arrives from here on is.
    if (cold && reader?.status().state !== "offline") {
      cold = false;
      marks.sinceAtLeast(new Date().toISOString());
    }
    board();
  };
  const open = (): RelayReader =>
    startRelayReader({
      origin: shell.origin,
      email: shell.email,
      doors: doors.read,
      keep: {
        read: (name) => kept.get(name),
        write(name, value) {
          kept.set(name, value);
          if (name !== "cursor") return cache.put(name, value);
          // The page and the cursor after it, as one write.
          cache.page((value as { cursor: number }).cursor, pending, value);
          pending = [];
        },
      },
      sink: {
        ingest(events: ProtocolEvent[]) {
          // A page this large is history whenever it comes: the board says it, not a frame an event.
          holding = events.length >= BURST_EVENTS;
          try {
            const r = store.ingest(events, "spacesheep");
            // A session the account forgot is gone from the store; it goes from what is
            // kept too: from this page (its earlier events came with it) and from every
            // page before it, so nothing of it stays here or comes back at the next start.
            const gone = new Set<SessionKey>();
            for (const e of events)
              if (e.type === "session.forgotten") gone.add(sessionKey(e.harness.name, e.session.id));
            for (const e of withoutSessions(r.stored, gone)) pending.push(e);
            if (gone.size) {
              pending = [...withoutSessions(pending, gone)];
              cache.forget([...gone]);
            }
            return r.accepted;
          } finally {
            if (holding && !catching) {
              holding = false;
              board();
            }
            holding = false;
          }
        },
        // History here is the whole backlog, not the first read alone: `onPage` says when it is in.
        setLoading: () => {},
      },
      ...(o.clock ? { clock: o.clock } : {}),
      hub: true,
      backlog: true,
      fresh,
      onPage(p) {
        if (!p.more) return caughtUp();
        if (!catching) {
          catching = true;
          store.setLoading(true);
        }
        // The first page is a board at once; after it, one every second and a half.
        if (performance.now() - lastBoard > BOARD_EVERY_MS) board();
      },
      onState(s) {
        // It cannot be read just now: what is here is the board, said as it is.
        if (s === "offline" || s === "limited" || s === "unauthorized") caughtUp();
        changed();
      },
      onMachines(list, _origin, rpId) {
        rp = rpId;
        control.remote.upsertRemoteMachines(list as RemoteMachine[], {
          via: "spacesheep",
          origin: shell.origin,
          rpId,
        });
      },
      pendingJobs: () => control.remote.pendingRemoteJobs(),
      jobsCadence: () => control.remote.remoteJobsCadence(),
      onEvents: (keys) => control.remote.remoteEventsSeen(keys),
      onUnauthorized() {
        control.remote.setRemoteRevoked(true);
        if (state === "ok") state = "unauthorized";
        changed();
      },
      onJobs: (jobs, through, serverNow) => control.remote.applyRemoteJobs(jobs as RemoteJobWord[], through, serverNow),
    });
  control.onRemoteKick = () => reader?.kickJobs();
  // A page is closed without a word (the app goes to the background, the window reloads):
  // the read times are written down when it leaves the screen, so the next launch goes on
  // from the same budget and not from a third taken as spent.
  const onHide = (): void => {
    if (typeof document === "undefined" || document.visibilityState === "hidden") reader?.flush();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onHide);
  if (typeof addEventListener === "function") addEventListener("pagehide", () => reader?.flush());
  control.remote.setRemoteAccount({ origin: shell.origin, email: shell.email });
  if (shell.state === "unauthorized") control.remote.setRemoteRevoked(true);
  store.setLoading(true);
  reader = open();
  // What was kept is a board already: it is on the page before the relay says a word.
  if (loaded.events.length) boarded = true;

  if (cache.kind === "memory") o.notice?.({ kind: "cache_memory" });
  if (docs.failed().length) o.notice?.({ kind: "doc_memory", names: docs.failed() });

  // ---------- the hub's word on the account ----------
  let gone = false;
  const drop = async (): Promise<void> => {
    if (gone) return;
    gone = true;
    state = "gone";
    reader?.stop();
    needs.stop();
    control.remote.dropRemoteMachines("spacesheep");
    control.remote.setRemoteAccount(null);
    await cache.destroy();
    changed();
  };
  const onAccount = (s: AccountStatus): void => {
    const row = s.accounts.find((a) => a.id === shell.id);
    if (!row) return void drop();
    if (gone || row.state === state) return;
    const was = state;
    state = row.state;
    if (row.state === "ok" && was !== "ok") {
      // Connected again under the same id: a new key, so what the last was refused for is
      // over, and a reader that stopped on a refusal starts again from the kept cursor.
      control.remote.setRemoteAccount({ origin: shell.origin, email: shell.email });
      if (reader?.status().state === "unauthorized") {
        reader.stop();
        reader = open();
      }
    } else if (row.state === "unauthorized") control.remote.setRemoteRevoked(true);
    changed();
  };
  let offAccount: (() => void) | null = null;
  void calls.onAccount(onAccount).then(
    (off) => {
      offAccount = off;
    },
    () => {},
  );

  const relayStatus = (): SpacesheepSourceStatus => ({
    origin: shell.origin,
    email: shell.email,
    connectedAt: me?.connectedAt ?? startedAt,
    ...(reader?.status() ?? { events: 0, cursor: 0, state: "starting", machines: [] }),
  });
  const info = (): Info => ({
    name: "sessionpipe-gui",
    version: shell.appVersion,
    startedAt,
    port: 0,
    urls: { local: shell.origin, lan: [] },
    sinkCommand: "",
    sinkToken: "",
    uiKey: "",
    sources: { http: true, outbox: null, demo: false, spacesheep: relayStatus() },
    storage: { dir: "", bytes: store.stats().storageBytes },
    wellKnown: {},
    control: {
      enabled: true,
      rpId: rp || new URL(shell.origin).hostname,
      machines: control.machines().size,
      origins: [],
      keyTypes: ["passkey", "device"],
    },
  });

  // ---------- the Transport ----------
  const transport: Transport = {
    openStream(h: StreamHandlers) {
      let closed = false;
      const send = (m: StreamMessage): void => {
        if (!closed) h.onMessage(m);
      };
      queueMicrotask(() => {
        if (closed) return;
        h.onOpen();
        // A board to show now: the kept one, or what history has brought so far. An empty
        // one is not shown while the first read is still out: `board()` brings it.
        if (boarded) send({ kind: "snapshot", snapshot: snapshot() });
        // The messages carried so far, as a stream would have brought them.
        for (const message of control.activity(100).reverse()) send({ kind: "control", message });
        listeners.add(send);
      });
      return () => {
        closed = true;
        listeners.delete(send);
      };
    },
    info: async () => info(),
    session: async (harness, id, q) => {
      const d = store.sessionDetail(sessionKey(harness, id), q.after, q.limit, {
        before: q.before,
        tail: q.tail,
        slim: q.slim,
        agent: q.agent,
      });
      if (!d) throw new HttpError(404, "not_found");
      if (q.slim && q.preview !== undefined) d.events = d.events.map((e) => cutPreview(e, q.preview!));
      return d;
    },
    sessionFiles: async (harness, id) => {
      const events = store.slimEvents(sessionKey(harness, id));
      if (!events) throw new HttpError(404, "not_found");
      const cwd = events[events.length - 1]?.session.cwd;
      return { files: indexTouches(events, cwd), lastSeq: events.length ? events[events.length - 1]!.session.seq : -1 };
    },
    feed: async (q) => store.feed(q),
    files: async (q) => store.filesChanged(q),
    digest: async (q) => store.digest(q),
    // The account holds the session, and this key has no door that forgets one.
    forget: async () => {
      throw new HttpError(405, "account_holds_it");
    },
    rotateToken: async () => {
      throw new HttpError(405, "no_sink_token");
    },
    demo: async () => ({ on: false }),
    qrUrl: () => null,
    labels: async () => labels.get(),
    patchLabels: async (p) => refusing(() => labels.patch(p)),
    marks: async () => marks.get(),
    patchMarks: async (p) => refusing(() => marks.patch(p)),
    forgetLimits: async (key) => {
      if (!limits.forget(key)) throw new HttpError(404, "not_found");
    },
    sessionSearch: () => import("./search").then((m) => m.accountSearch(store, () => labels.get())),
    controlActivity: async (limit) => control.activity(limit),
  };

  const asked = new Map<string, number>();
  const view = (): AccountView => {
    const s = store.stats();
    return {
      id: shell.id,
      origin: shell.origin,
      email: shell.email,
      state,
      relay: reader?.status() ?? { events: 0, cursor: 0, state: "starting", machines: [] },
      catching,
      cache: cache.kind,
      restored,
      firstBoardMs,
      caughtUpMs,
      store: { events: s.events, sessions: s.sessions, bytes: s.storageBytes },
    };
  };
  const deviceAsk = (): Promise<DeviceAsked> => calls.deviceAsk(shell.id);
  const disconnect = async (): Promise<Disconnected> => {
    const d = await calls.disconnect(shell.id);
    await drop();
    return d;
  };

  const answer = routes({
    shell,
    info,
    snapshot,
    control,
    limits: () => limits.list(),
    doors,
    relay: relayStatus,
    deviceAsk,
    disconnect,
    asked,
    json,
  });

  return {
    transport,
    answer,
    view,
    subscribe(l) {
      watchers.add(l);
      return () => void watchers.delete(l);
    },
    deviceAsk,
    device: () => doors.device(),
    disconnect,
    asked,
    async flushed() {
      await Promise.all([cache.flushed(), docs.flushed()]);
    },
    stop() {
      reader?.stop();
      needs.stop();
      offAccount?.();
      if (machinesTimer) clearTimeout(machinesTimer);
      void store.close();
    },
  };
}

/** A patch the document refused, as the route's refusal: its status and its reason. */
function refusing<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    const x = e as { status?: unknown; reason?: unknown };
    if (typeof x.status === "number" && typeof x.reason === "string") throw new HttpError(x.status, x.reason);
    throw e;
  }
}

export type { AccountDocs };
