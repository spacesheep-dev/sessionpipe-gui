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
  ControlActivity,
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
import { cleanReason } from "@shared/reason";
import type { ControlCommand } from "sessionpipe-core/control";
import {
  type KeptQueues,
  MemoryControl,
  newUlid,
  type RemoteJobWord,
  SendRefused,
} from "../../../server/control/remote";
import { type MachineRow, machineFrame, type RemoteMachine, toActivity } from "../../../server/control/rows";
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
import { type EventCache, openCache, withoutSessions } from "./cache";
import { type AccountDocs, type DocName, openDocs } from "./docs";
import { type AccountDoors, type DoorAnswer, openDoors, SEND_UNKNOWN_CODE, type Sent } from "./doors";
import { listed } from "./gone";
import { forgetLocal, readLocal, readsKey, wipeAccount, writeLocal } from "./local";
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
import { openUnheard, readUnheard, type Unheard } from "./unheard";

/** Something a person should be told once: the events are not kept between launches
 *  (`cache_memory`), or some of the documents could not be read (`doc_unread`, with their
 *  names): what is kept of those is left as it is, and what changes in this launch is not kept. */
export interface AccountNotice {
  kind: "cache_memory" | "doc_unread";
  names?: DocName[];
}

export interface AccountBackendOptions {
  shell: AccountShell;
  calls: ShellCalls;
  fetch?: typeof fetch;
  /** Where the relay's pages are cached; null: nowhere (memory). Absent: this page's own. */
  idb?: IDBFactory | null;
  /** The cache itself, in place of one opened on `idb` (a test's). */
  cache?: EventCache;
  /** The page's own storage (local.ts): what it keeps of a session goes when the account
   *  forgets the session (`forget`), and what it keeps of the account's sessions and under
   *  its id when the account goes (`wipe`; `conveniences` when the person disconnected it
   *  here); and where the reader's read times are written (`write` says whether it was
   *  kept). Absent: this page's. */
  local?: {
    forget(sessions: string[]): void;
    wipe(id: string, sessions: string[], o: { conveniences: boolean }): void;
    read(key: string): string | null;
    write(key: string, value: string): boolean;
  };
  /** The account is gone from this phone (disconnected here, or the hub says it is no
   *  longer listed) and nothing of it is kept by this page any more: whoever draws the
   *  window leaves it. With the hub's answer when it was this page's own disconnect. */
  onGone?: (disconnected: Disconnected | null) => void;
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
/** How long after one answer of the hub's that leaves the account out it is asked again. */
export const GONE_AGAIN_MS = 3000;
/** A stream opened while spacesheep cannot be reached reads the relay at once, this often at most. */
export const RETRY_EVERY_MS = 3000;
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
  // Opening this window removes nothing of anybody's: the storage is every window's, and
  // another account, or a GUI server, may be connected beside this one. (What an account
  // that is gone left behind is swept by every window as it opens: gone.ts.)
  const local = o.local ?? {
    forget: (sessions: string[]) => void forgetLocal(sessions),
    wipe: (id: string, sessions: string[], w: { conveniences: boolean }) => void wipeAccount(id, sessions, w),
    read: (key: string) => readLocal(key),
    write: (key: string, value: string) => writeLocal(key, value),
  };

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
  /** The highest spacesheep job id among the rows this page keeps (doors.ts `lastJob`). */
  let lastJob = 0;
  const noteJobs = (queues: KeptQueues | null | undefined): void => {
    for (const rows of Object.values(queues ?? {}))
      for (const row of rows) if (typeof row.remoteJob === "number" && row.remoteJob > lastJob) lastJob = row.remoteJob;
  };
  const keptDoc = sends.load();
  const keptSends = readSends(keptDoc);
  noteJobs(keptSends);
  /** The sends nobody heard the answer to (unheard.ts), kept in the same document. */
  let unheard: Unheard | null = null;
  let queuesNow: KeptQueues = keptSends ?? {};
  const saveSends = (): void => sends.save({ ...fitSends(queuesNow), unheard: unheard?.kept() ?? [] });
  /** The id the next row is made under: a send that was unknown keeps its row's when it turns out sent. */
  let nextId: string | null = null;
  const control = new MemoryControl({
    kept: keptSends,
    newId: (now) => nextId ?? newUlid(now),
    onSave: (queues: KeptQueues) => {
      noteJobs(queues);
      queuesNow = queues;
      saveSends();
    },
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

  const snapshot = (): Snapshot => {
    const s = snapshotWithControl(store, control);
    // Gone, there is no board: an empty one, with nothing of the person's on it.
    if (gone) return { ...s, sessions: [], machines: [] };
    return { ...s, labels: labels.get(), marks: marks.get(), limits: limits.list() };
  };
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
    lastJob: () => lastJob,
  });
  let gone = false;
  unheard = openUnheard({
    kept: readUnheard(keptDoc),
    doors,
    machine: (id) => control.machine(id),
    newId: (now) => newUlid(now),
    mayAsk: () => !gone && state === "ok",
    adopt(u, cmd, job) {
      const m = control.machine(u.row.machineId);
      if (!m) return;
      // The same row, now a send like any other: followed by its job, or closed as one
      // spacesheep took and nobody can follow.
      nextId = u.row.id;
      try {
        control.remote.enqueueRemote(
          m,
          { cmd: "" },
          cmd,
          { via: "ui", ...(u.row.from ? { from: u.row.from } : {}) },
          job ?? 0,
        );
      } finally {
        nextId = null;
      }
    },
    // The refusal as a send answers it (forwardRemoteSend's reading of spacesheep's): its
    // words, its code when it is written as one, and a hold under the word the page knows.
    refused(_u, status, json) {
      const reason = cleanReason(json.error) || "spacesheep did not take it";
      const code = typeof json.code === "string" ? json.code : undefined;
      if (status === 409 && code === "confirm") {
        const why = cleanReason(json.why);
        return { status: 422, reason, code: "confirm_required", ...(why ? { detail: why } : {}) };
      }
      return { status: status >= 500 ? 502 : status, reason, ...(code ? { code } : {}) };
    },
    changed(a) {
      if (a) emit({ kind: "control", message: a });
      saveSends();
    },
  });
  /** Every row the page is shown, newest first: the sends spacesheep carried, and the ones nobody heard the answer to. */
  const activity = (limit = 100): ControlActivity[] => {
    const own = unheard?.activity() ?? [];
    if (!own.length) return control.activity(limit);
    return [...control.activity(limit), ...own].sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, limit);
  };
  /** A send for one of the account's machines: its row. One nobody heard the answer to is
   *  a row too, said to be unknown and followed until it is known (unheard.ts); while it
   *  is, the same send again is held with the same words. */
  const send = async (m: MachineRow, b: Record<string, unknown>): Promise<ControlActivity> => {
    let cmd: ControlCommand | null = null;
    try {
      const c = JSON.parse(String(b.cmd)) as ControlCommand | null;
      if (c && typeof c === "object" && !Array.isArray(c)) cmd = c;
    } catch {
      // not a command: the forward says so
    }
    const held = cmd ? unheard?.holding(m.id, cmd) : undefined;
    if (held) throw new SendRefused(504, { reason: cleanReason(held.why), code: SEND_UNKNOWN_CODE });
    const askedAt = Date.now();
    let said: Sent | null = null;
    let asked: Record<string, unknown> | null = null;
    try {
      const row = await control.send(m, b, async (mm, body) => {
        asked = body;
        const s = await doors.ask(mm, body, { askedAt });
        said = s;
        if (s.kind === "sent") return { status: 202, json: s.job === null ? {} : { job: s.job } };
        if (s.kind === "refused") return { status: s.status, json: s.json };
        return { status: 504, json: { code: SEND_UNKNOWN_CODE, error: s.why } };
      });
      return toActivity(row);
    } catch (e) {
      const s = said as Sent | null;
      if (s?.kind === "unknown" && asked && cmd && unheard && e instanceof SendRefused)
        return unheard.add(m, asked, cmd, s, askedAt, typeof b.from === "string" ? b.from : undefined);
      throw e;
    }
  };
  const kept = new Map<RelayKept, unknown>(Object.entries(loaded.kept) as [RelayKept, unknown][]);
  // The read times are kept in the page's own storage, whatever the events are kept in: it
  // is there when IndexedDB is not, and a write to it is done when it returns, so a page
  // reloaded or killed in the middle of a backlog has not lost what it spent. (What
  // IndexedDB holds of them is from a page that had nowhere else, and is read only then.)
  try {
    const text = local.read(readsKey(shell.id));
    if (text) kept.set("reads", JSON.parse(text) as unknown);
  } catch {
    // Not readable: as with none kept, a third of the budget is taken as spent.
  }
  let pending: StoredEvent[] = [];
  const me = first?.accounts.find((a) => a.id === shell.id);
  const connectedAt = me?.connectedAt ? Date.parse(me.connectedAt) : Number.NaN;
  // Nothing kept and the key made a moment ago: nobody read with it before this page.
  const fresh =
    kept.get("cursor") === undefined &&
    kept.get("reads") === undefined &&
    Number.isFinite(connectedAt) &&
    Math.abs(Date.now() - connectedAt) < FRESH_MS;
  /** spacesheep could not be reached at the last read (the reader's `offline`). */
  let unreachable = false;
  /** The streams the page holds open: told when spacesheep cannot be reached. */
  const streams = new Set<StreamHandlers>();
  /** When the reader was last started again because somebody asked (RETRY_EVERY_MS). */
  let retriedAt = Number.NEGATIVE_INFINITY;
  /** The relay is read from its start (nothing was kept): all of it is history. */
  let cold = cursorFrom(kept.get("cursor"), shell.origin, shell.email) === 0;
  /** History is in: a page came back that was not full. Only that ends it. A read that
   *  failed, or that spacesheep asked to wait for, has brought nothing: history is still to
   *  come, and when it does it is still history (held back as one board, none of it unread). */
  const caughtUp = (): void => {
    // A session's news is dated by when it arrived here, and history arrived just now: none
    // of it is news. What arrives from here on is.
    if (cold) {
      cold = false;
      marks.sinceAtLeast(new Date().toISOString());
    }
    if (!catching) return;
    catching = false;
    store.setLoading(false);
    if (caughtUpMs === null) caughtUpMs = performance.now() - t0;
    board();
  };
  /** Nothing more will be read (the key is refused): what is here is all there is. Not the
   *  end of history: a relay never read from its start is still unread when a new key reads it. */
  const giveUp = (): void => {
    if (!catching) return;
    catching = false;
    store.setLoading(false);
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
          if (name === "reads") {
            if (!local.write(readsKey(shell.id), JSON.stringify(value))) cache.put(name, value);
            return;
          }
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
              // And its draft, and its place in the page's own lists.
              local.forget([...gone]);
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
        // Every read spent is written down as it is spent (a few kilobytes, at once): a
        // backlog is a hundred reads in a few seconds, and the next launch must know of them.
        reader?.flush();
        if (!p.more) return caughtUp();
        if (!catching) {
          catching = true;
          store.setLoading(true);
        }
        // The first page is a board at once; after it, one every second and a half.
        if (performance.now() - lastBoard > BOARD_EVERY_MS) board();
      },
      onState(s) {
        // It cannot be read just now: what is here is the board, shown as it is. History is
        // not over for that: it is still held back, and comes as one board when it comes.
        // (Once history is in, the board is on the page already and only its state changes.)
        if ((s === "offline" || s === "limited") && catching) board();
        else if (s === "unauthorized") giveUp();
        // spacesheep cannot be reached: every open stream says so, as a receiver's dropped
        // stream does (the page reads "Reconnecting…", not "live"). Reached again, a board
        // says it is live.
        if (s === "offline") {
          unreachable = true;
          for (const h of [...streams]) h.onError(0);
        } else if (unreachable) {
          unreachable = false;
          if (s !== "unauthorized") board();
        }
        // spacesheep answers again: a send nobody heard the answer to is asked for now.
        if (s === "ok") unheard?.kick();
        changed();
      },
      onMachines(list, _origin, rpId) {
        rp = rpId;
        control.remote.upsertRemoteMachines(list as RemoteMachine[], {
          via: "spacesheep",
          origin: shell.origin,
          rpId,
        });
        // The machines are listed: a send kept from before can be asked for.
        unheard?.kick();
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
  // The read times are written with every page taken (above) and by the reader's own timer.
  // A read that brought no page (a failure, spacesheep's limit) is written by that timer,
  // within fifteen seconds; when the page leaves the screen they are written at once, so a
  // launch after the app was put away goes on from the same budget.
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
  if (docs.unread().length) o.notice?.({ kind: "doc_unread", names: docs.unread() });

  // ---------- the hub's word on the account ----------
  /** Everything this page holds of the account goes: the reader stops, the machines and
   *  the board leave the screen, the cached sessions are deleted, and what the page's own
   *  storage keeps of the account's sessions and under its id is removed (with what
   *  belongs to no session, when the person disconnected it here). Then whoever draws the
   *  window is told. */
  const drop = async (disconnected: Disconnected | null = null): Promise<void> => {
    if (gone) return;
    const sessions = store.snapshot().sessions.map((s) => s.key);
    gone = true;
    state = "gone";
    reader?.stop();
    unheard?.stop();
    needs.stop();
    offAccount?.();
    control.remote.dropRemoteMachines("spacesheep");
    control.remote.setRemoteAccount(null);
    // The board leaves the screen as an empty one (`snapshot`). Its sessions are not
    // forgotten one by one: the labels and the marks follow a forgotten session, and would
    // write themselves empty at the hub, where they are the hub's to keep or to delete.
    local.wipe(shell.id, sessions, { conveniences: disconnected !== null });
    await cache.destroy();
    emit({ kind: "snapshot", snapshot: snapshot() });
    changed();
    o.onGone?.(disconnected);
  };
  /** This page's own disconnect is with the hub: its answer says what became of the account. */
  let disconnecting = false;
  /** An event that leaves the account out changes nothing by its own word (a hub that
   *  spoke too soon would cost the phone everything it keeps): the hub is asked, twice, a
   *  few seconds apart, and the account is gone when both answers are lists without it. */
  let confirming = false;
  const confirmGone = async (): Promise<void> => {
    if (confirming || gone) return;
    confirming = true;
    try {
      for (let i = 0; i < 2; i++) {
        if (i) await new Promise<void>((r) => setTimeout(r, GONE_AGAIN_MS));
        const here = listed(await calls.status().catch(() => null));
        if (!here || here.includes(shell.id)) return;
      }
      if (!disconnecting) await drop();
    } finally {
      confirming = false;
    }
  };
  const onAccount = (s: AccountStatus): void => {
    const row = listed(s) ? s.accounts.find((a) => a.id === shell.id) : undefined;
    // Gone by this page's own asking: the hub's answer is on its way and is handed on with it.
    if (!row && disconnecting) return;
    if (!row) return void confirmGone();
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
    sources: { http: true, outbox: null, demo: false, spacesheep: gone ? null : relayStatus() },
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
        for (const message of activity(100).reverse()) send({ kind: "control", message });
        listeners.add(send);
        streams.add(h);
        if (!unreachable || gone) return;
        // The rows are what was last read, and spacesheep cannot be reached: said, not "live".
        h.onError(0);
        // A stream opened while it cannot be reached is somebody asking again ("Retry now",
        // the app back in front): the relay is read now, not at the end of the reader's own
        // growing pause. The reader is started anew from what was kept (its cursor, its read
        // times), so there is never a second read beside one already out.
        const now = performance.now();
        if (reader?.status().state === "offline" && now - retriedAt >= RETRY_EVERY_MS) {
          retriedAt = now;
          reader.stop();
          reader = open();
        }
      });
      return () => {
        closed = true;
        listeners.delete(send);
        streams.delete(h);
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
    controlActivity: async (limit) => activity(limit),
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
      store: gone
        ? { events: 0, sessions: 0, bytes: 0 }
        : { events: s.events, sessions: s.sessions, bytes: s.storageBytes },
    };
  };
  const deviceAsk = (): Promise<DeviceAsked> => calls.deviceAsk(shell.id);
  const disconnect = async (): Promise<Disconnected> => {
    disconnecting = true;
    let d: Disconnected;
    try {
      d = await calls.disconnect(shell.id);
    } catch (e) {
      disconnecting = false;
      // Refused, or failed part of the way: the hub's list says whether the account is still here.
      const now = await calls.status().catch(() => null);
      if (now && !now.accounts.some((a) => a.id === shell.id)) await drop();
      throw e;
    }
    disconnecting = false;
    await drop(d);
    return d;
  };

  const answer = routes({
    shell,
    info,
    snapshot,
    control,
    send,
    activity,
    limits: () => limits.list(),
    doors,
    // Gone, there is no account to speak of: Settings reads "not connected", not the last state.
    relay: () => (gone ? null : relayStatus()),
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
      unheard?.stop();
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
