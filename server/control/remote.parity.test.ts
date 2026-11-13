// SPDX-License-Identifier: Apache-2.0
// One definition, two wirings (docs/rfcs/08): the receiver's (ControlState with its queue
// files, the source with its key and its cursor file, wired as app.ts wires them) and a
// page's (MemoryControl, the reader with a keep in memory). Both are driven through the
// same script against a spacesheep of their own that answers the same, on one clock, and
// after every step what each says is compared: the activity row by row, the machines, the
// jobs still pending, the pace, the reader's status, every row that was told to a listener.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isUlid, ulid } from "sessionpipe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlActivity, MachineControl, ProtocolEvent } from "../../shared/api.js";
import { asResponse, type FakeAnswer, FakeSpacesheep } from "../../test/account/fake-spacesheep.js";
import { Session } from "../../test/events.js";
import { type RelayKept, type RelayReader, startRelayReader } from "../sources/relay.js";
import { type SpacesheepSource, startSpacesheepSource } from "../sources/spacesheep.js";
import type { Store } from "../store/store.js";
import {
  forwardRemoteSend,
  type KeptQueues,
  MemoryControl,
  newUlid,
  type RemoteSend,
  SendRefused,
  SPACESHEEP_UNAUTHORIZED,
} from "./remote.js";
import { ControlState, EXPIRES_MAX_MS, type MachineRow, REMOTE_GRACE_MS, toActivity } from "./state.js";
import { coreTakesTilde } from "./tilde.js";

const ORIGIN = "https://spacesheep.test";
const ME = { origin: ORIGIN, email: "me@example.com" };
const OTHER = { origin: ORIGIN, email: "someone@example.com" };
const M1 = "m_0123456789abcdefghij";
const M2 = "m_abcdefghij0123456789";

type Sent = { row: ControlActivity } | { refused: { status: number; body: unknown } };

/** What a wiring says of itself, with nothing in it that two wirings may differ in. */
interface View {
  activity: Omit<ControlActivity, "id">[];
  machines: MachineControl[];
  pending: number[];
  cadence: string;
  status: { state: string; cursor: number; events: number; machines: string[] } | null;
  told: string[];
  asked: string[];
}

interface Side {
  ss: FakeSpacesheep;
  /** As a start with this account linked (or none): the control read from what was kept,
   *  the reader started. */
  start(account: { origin: string; email: string } | null): void;
  stop(): void;
  disconnect(): void;
  send(machineId: string, body: Record<string, unknown>): Promise<Sent>;
  view(): View;
}

const noId = ({ id: _id, ...rest }: ControlActivity) => rest;

/** What a control state does when it is told: the same words on both sides. */
const toldOf = (a: ControlActivity): string =>
  `${a.kind} ${a.session} ${a.outcome ?? "waiting"}${a.code ? ` ${a.code}` : ""}${a.unfollowed ? ` (${a.unfollowed})` : ""}`;

const fetchOf = (ss: FakeSpacesheep) =>
  (async (
    u: string | URL,
    init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ) => {
    const url = new URL(String(u));
    return asResponse(
      await ss.handle({
        method: init?.method ?? "GET",
        path: url.pathname + url.search,
        authorization: init?.headers?.authorization,
        body: init?.body,
        signal: init?.signal,
      }),
    );
  }) as unknown as typeof fetch;

const statusOf = (s: { state: string; cursor: number; events: number; machines: string[] }) => ({
  state: s.state,
  cursor: s.cursor,
  events: s.events,
  machines: s.machines,
});

/** The receiver's wiring: app.ts, with the control state in place of createControl's facade. */
function receiverSide(dir: string): Side {
  const ss = new FakeSpacesheep();
  let state: ControlState | null = null;
  let source: SpacesheepSource | null = null;
  let link: { origin: string; email: string } | null = null;
  const told: string[] = [];
  const store = {
    dir: path.join(dir, "events"),
    ingest: (events: unknown[]) => ({ accepted: events.length }),
    setLoading: () => {},
  } as unknown as Store;
  const remoteSend: RemoteSend = async (m, body) => {
    if (!link || m.remote?.origin !== link.origin)
      return { status: 503, json: { code: "no_relay", error: "Not connected to spacesheep any more." } };
    const res = await fetchOf(ss)(`${link.origin}/api/machines/${encodeURIComponent(m.id)}/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${ss.key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401 && json.code !== "unlock") source?.unauthorized();
    return { status: res.status, json };
  };
  return {
    ss,
    start(account) {
      link = account;
      state = new ControlState(path.join(dir, "control"));
      const s = state;
      // As createControl sets it: this receiver's core takes a start's `~/…` folder.
      s.takesTilde = coreTakesTilde();
      s.onMessage = (row) => told.push(toldOf(toActivity(row)));
      s.onRemoteKick = () => source?.kickJobs();
      s.setRemoteAccount(account);
      if (!account) return;
      source = startSpacesheepSource(store, {
        ...account,
        key: ss.key,
        connectedAt: "",
        fetch: fetchOf(ss),
        onMachines: (list, origin, rpId) => s.upsertRemoteMachines(list as never, { via: "spacesheep", origin, rpId }),
        pendingJobs: () => s.pendingRemoteJobs(),
        jobsCadence: () => s.remoteJobsCadence(),
        onEvents: (keys) => s.remoteEventsSeen(keys),
        onUnauthorized: () => s.setRemoteRevoked(true),
        onJobs: (jobs, through, serverNow) => s.applyRemoteJobs(jobs, through, serverNow),
      });
    },
    stop() {
      source?.stop();
      source = null;
      state?.close();
    },
    disconnect() {
      source?.stop();
      source = null;
      link = null;
      state!.dropRemoteMachines("spacesheep");
      state!.setRemoteAccount(null);
    },
    async send(machineId, body) {
      const m = state!.machine(machineId);
      if (!m) return { refused: { status: 404, body: { reason: "not_found" } } };
      try {
        return { row: toActivity(await forwardRemoteSend(state!, m, body, remoteSend)) };
      } catch (e) {
        if (e instanceof SendRefused) return { refused: { status: e.status, body: e.body } };
        throw e;
      }
    },
    view: () => ({
      activity: state!.activity(1000).map(noId),
      machines: state!
        .allMachines()
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((m) => state!.machineControl(m)),
      pending: state!.pendingRemoteJobs(),
      cadence: state!.remoteJobsCadence(),
      status: source ? statusOf(source.status()) : null,
      told: [...told],
      asked: ss.log.filter((l) => !l.includes("/relay?")),
    }),
  };
}

/** A page's wiring: no files, no key of its own (the doors here stand for the hub, which adds it). */
function memorySide(): Side {
  const ss = new FakeSpacesheep();
  let control: MemoryControl | null = null;
  let reader: RelayReader | null = null;
  let link: { origin: string; email: string } | null = null;
  let saved: KeptQueues | null = null;
  const kept = new Map<RelayKept, unknown>();
  const told: string[] = [];
  const door = async (method: string, p: string, body?: string, signal?: AbortSignal): Promise<Response> =>
    asResponse(await ss.handle({ method, path: p, authorization: `Bearer ${ss.key}`, body, signal }));
  const remoteSend: RemoteSend = async (m, body) => {
    if (!link) return { status: 503, json: { code: "no_relay", error: "Not connected to spacesheep any more." } };
    const res = await door("POST", `/api/machines/${encodeURIComponent(m.id)}/jobs`, JSON.stringify(body));
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401 && json.code !== "unlock") reader?.unauthorized();
    return { status: res.status, json };
  };
  return {
    ss,
    start(account) {
      link = account;
      // What was saved is read as it would be from where it was kept: a copy, never the rows.
      control = new MemoryControl({
        kept: saved ? (JSON.parse(JSON.stringify(saved)) as KeptQueues) : null,
        onSave: (queues) => {
          saved = JSON.parse(JSON.stringify(queues)) as KeptQueues;
        },
      });
      const c = control;
      c.onMessage = (row) => told.push(toldOf(toActivity(row)));
      c.onRemoteKick = () => reader?.kickJobs();
      c.remote.setRemoteAccount(account);
      if (!account) return;
      reader = startRelayReader({
        ...account,
        doors: (p, init) => door("GET", p, undefined, init?.signal),
        keep: { read: (name) => kept.get(name), write: (name, value) => void kept.set(name, value) },
        sink: { ingest: (events) => events.length, setLoading: () => {} },
        onMachines: (list, origin, rpId) =>
          c.remote.upsertRemoteMachines(list as never, { via: "spacesheep", origin, rpId }),
        pendingJobs: () => c.remote.pendingRemoteJobs(),
        jobsCadence: () => c.remote.remoteJobsCadence(),
        onEvents: (keys) => c.remote.remoteEventsSeen(keys),
        onUnauthorized: () => c.remote.setRemoteRevoked(true),
        onJobs: (jobs, through, serverNow) => c.remote.applyRemoteJobs(jobs, through, serverNow),
      });
    },
    stop() {
      reader?.stop();
      reader = null;
    },
    disconnect() {
      reader?.stop();
      reader = null;
      link = null;
      control!.remote.dropRemoteMachines("spacesheep");
      control!.remote.setRemoteAccount(null);
    },
    async send(machineId, body) {
      const m = control!.machine(machineId);
      if (!m) return { refused: { status: 404, body: { reason: "not_found" } } };
      try {
        return { row: toActivity(await control!.send(m, body, remoteSend)) };
      } catch (e) {
        if (e instanceof SendRefused) return { refused: { status: e.status, body: e.body } };
        throw e;
      }
    },
    view: () => ({
      activity: control!.activity(1000).map(noId),
      machines: control!
        .allMachines()
        .sort((a: MachineRow, b: MachineRow) => (a.id < b.id ? -1 : 1))
        .map((m) => control!.machineControl(m)),
      pending: control!.remote.pendingRemoteJobs(),
      cadence: control!.remote.remoteJobsCadence(),
      status: reader ? statusOf(reader.status()) : null,
      told: [...told],
      asked: ss.log.filter((l) => !l.includes("/relay?")),
    }),
  };
}

const listed = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  name,
  online: true,
  last_seen: Date.now(),
  folders: ["/home/me"],
  mode: "safe",
  agents: ["claude-code"],
  cli_version: "sessionpipe 0.14.2",
  modes: ["waiter"],
  passkey_ids: ["k1"],
  files: true,
  prompt_files: true,
  key_types: ["passkey", "device"],
  ask: true,
  handoff: true,
  start: { "claude-code": { permissions: ["default"] } },
  ...over,
});

const command = (machine: string, kind: "prompt" | "start", session: string, extra: Record<string, unknown> = {}) => ({
  cmd: JSON.stringify({
    v: 1,
    t: "sessionpipe.control",
    machine,
    kind,
    session,
    text: `${kind} for ${session}`,
    ...(kind === "start" ? { cwd: "/home/me" } : {}),
    ...extra,
    nonce: `n-${session}-${Date.now()}`,
    iat: Date.now(),
  }),
  csig: "sig",
  grant: { str: "g", cred: "k1", sig: "s" },
});

const answer = (status: number, body: Record<string, unknown>): FakeAnswer => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("the receiver's wiring and a page's, through one script", () => {
  let dir: string;
  let sides: Side[];
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    dir = mkdtempSync(path.join(tmpdir(), "spgui-parity-"));
    sides = [receiverSide(dir), memorySide()];
  });
  afterEach(() => {
    for (const s of sides) s.stop();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  /** Both say the same; what they say is handed back for the script's own checks. */
  const same = (step: string): View => {
    const [a, b] = sides.map((s) => s.view()) as [View, View];
    expect(b, `after: ${step}`).toEqual(a);
    return a;
  };
  /** The same thing done to each side's spacesheep. */
  const both = (f: (ss: FakeSpacesheep) => void) => {
    for (const s of sides) f(s.ss);
  };
  /** The same send on each side: the same answer, and it is handed back. */
  const send = async (machineId: string, body: Record<string, unknown>): Promise<Sent> => {
    const [a, b] = (await Promise.all(sides.map((s) => s.send(machineId, body)))) as [Sent, Sent];
    const plain = (x: Sent) => ("row" in x ? { row: noId(x.row) } : x);
    expect(plain(b), "the send's answer").toEqual(plain(a));
    return a;
  };
  const sessionEvents = (id: string): ProtocolEvent[] => {
    const s = new Session(id);
    return [s.ev("session.started", { source: "startup" }), s.ev("turn.started", { turn_id: "t1" })];
  };

  it("machines, sends, refusals, jobs, a restart, a revoked key, a disconnect and another account: row for row", async () => {
    both((ss) => {
      ss.machines = [listed(M1, "lab-mac"), listed(M2, "attic-linux", { online: false, passkey_ids: ["k1", "k2"] })];
    });
    for (const s of sides) s.start(ME);
    await tick(50);
    let v = same("the first read of the relay and the machine list");
    expect(v.machines.map((m) => [m.machineId, m.online, m.files, m.remote?.rpId])).toEqual([
      [M1, true, undefined, "spacesheep.test"],
      [M2, false, undefined, "spacesheep.test"],
    ]);
    expect(v.status).toMatchObject({ state: "ok", machines: ["lab-mac", "attic-linux"] });

    // A prompt to the computer that is on, a start to the one that is off.
    await tick(5);
    const first = await send(M1, command(M1, "prompt", "claude-code:s-1"));
    expect("row" in first && first.row).toMatchObject({
      kind: "prompt",
      machineId: M1,
      text: "prompt for claude-code:s-1",
    });
    await tick(5);
    await send(M2, command(M2, "start", "claude-code:s-2", { permission: "default", model: "opus" }));
    v = same("two sends");
    expect(v.pending).toEqual([1, 2]);
    expect(v.cadence).toBe("fast");
    expect(v.activity.map((a) => [a.kind, a.outcome, a.cwd, a.model])).toEqual([
      ["start", undefined, "/home/me", "opus"],
      ["prompt", undefined, undefined, undefined],
    ]);

    // What spacesheep refuses, in the words and codes the page reads.
    const refusals: Array<[FakeAnswer, number, string]> = [
      [
        answer(409, {
          error: "Confirm with your passkey to send this: it deletes a folder.",
          code: "confirm",
          why: "it deletes a folder",
        }),
        422,
        "confirm_required",
      ],
      [answer(401, { error: "Unlock again.", code: "unlock" }), 422, "bad_grant"],
      [
        answer(400, { error: "That key isn't trusted there.", code: "bad", refusal: "untrusted_key" }),
        422,
        "untrusted_key",
      ],
      [answer(403, { error: "This device was added less than an hour ago.", code: "cooling" }), 403, "cooling"],
      [answer(429, { error: "That's a lot of messages in a short time.", code: "rate_limited" }), 429, "rate_limited"],
      [answer(500, { error: "boom" }), 502, "refused"],
    ];
    for (const [a, status, code] of refusals) {
      both((ss) => ss.sendAnswers.push(() => a));
      const r = await send(M1, command(M1, "prompt", "claude-code:s-1"));
      expect(r).toMatchObject({ refused: { status, body: { code } } });
    }
    // A file is refused before spacesheep is asked at all.
    const withFile = await send(
      M1,
      command(M1, "start", "claude-code:s-9", {
        files: [{ name: "a.txt", type: "text/plain", size: 1, sha256: "A".repeat(43) }],
      }),
    );
    expect(withFile).toMatchObject({ refused: { status: 422, body: { code: "relay_files" } } });
    same("refused sends leave no row");

    // The jobs door: taken, then done; the one for the computer that is off waits.
    both((ss) => ss.settle(1, "running"));
    await tick(3100);
    v = same("job 1 taken");
    expect(v.activity.find((a) => a.kind === "prompt")).toMatchObject({ outcome: "taken" });
    both((ss) => ss.settle(1, "done"));
    await tick(3100);
    v = same("job 1 done");
    expect(v.activity.find((a) => a.kind === "prompt")).toMatchObject({ outcome: "delivered" });
    expect(v.pending).toEqual([2]);
    // Every send that waits is for a computer shown offline, and a minute old: the slow pace.
    await tick(60_000);
    expect(same("a minute on").cadence).toBe("slow");

    // A restart with the start still waiting: each side reads what it kept.
    for (const s of sides) s.stop();
    for (const s of sides) s.start(ME);
    await tick(50);
    v = same("after a restart");
    expect(v.pending).toEqual([2]);
    expect(v.activity.map((a) => [a.kind, a.outcome])).toEqual([
      ["start", undefined],
      ["prompt", "delivered"],
    ]);

    // Its computer comes back: read at once, and the computer refuses it with a code.
    both((ss) => {
      ss.machines = [listed(M1, "lab-mac"), listed(M2, "attic-linux", { passkey_ids: ["k1", "k2"] })];
      ss.settle(2, "refused", { code: "folder", note: "That folder isn't allowed." });
    });
    await tick(61_000);
    v = same("the computer back, the start refused");
    expect(v.activity.find((a) => a.kind === "start")).toMatchObject({
      outcome: "refused",
      code: "folder",
      detail: "That folder isn't allowed.",
    });
    expect(v.cadence).toBe("none");

    // A start the computer takes and never finishes: past spacesheep's day it is unconfirmed;
    // a prompt nobody took is expired. Events for the start's session then read it once more.
    await tick(5);
    await send(M1, command(M1, "start", "claude-code:s-3"));
    await tick(5);
    await send(M1, command(M1, "prompt", "claude-code:s-1"));
    both((ss) => ss.settle(3, "running"));
    await tick(3100);
    same("job 3 taken, job 4 waiting");
    await tick(EXPIRES_MAX_MS + REMOTE_GRACE_MS + 60_000);
    v = same("a day and an hour on");
    expect(v.activity.slice(0, 2).map((a) => [a.kind, a.outcome])).toEqual([
      ["prompt", "expired"],
      ["start", "unconfirmed"],
    ]);
    expect(v.pending).toEqual([]);
    both((ss) => {
      ss.settle(3, "done");
      ss.push(sessionEvents("s-3"));
    });
    await tick(30_000);
    v = same("events for the unconfirmed start's session");
    expect(v.activity.find((a) => a.session === "claude-code:s-3")).toMatchObject({ outcome: "delivered" });

    // The key is revoked while a send waits: found by the next send, said on the row.
    await tick(5);
    await send(M1, command(M1, "prompt", "claude-code:s-3"));
    both((ss) => {
      ss.revoked = true;
    });
    const refused = await send(M1, command(M1, "prompt", "claude-code:s-3"));
    expect(refused).toMatchObject({ refused: { status: 502, body: { code: SPACESHEEP_UNAUTHORIZED } } });
    v = same("the key revoked");
    expect(v.status).toMatchObject({ state: "unauthorized" });
    expect(v.activity[0]).toMatchObject({ unfollowed: "revoked" });
    expect(v.pending).toEqual([5]);

    // Disconnected: the row waits, not followed. Another account connects: it can't speak for it.
    for (const s of sides) s.disconnect();
    v = same("disconnected");
    expect(v.activity[0]).toMatchObject({ unfollowed: "disconnected" });
    expect(v.machines).toEqual([]);
    for (const s of sides) s.stop();
    both((ss) => {
      ss.revoked = false;
    });
    for (const s of sides) s.start(OTHER);
    await tick(50);
    v = same("another account");
    expect(v.activity[0]).toMatchObject({ outcome: "failed", code: "untracked" });
    expect(v.pending).toEqual([]);

    // Its own account again: it waits once more, and spacesheep's list settles it.
    for (const s of sides) s.stop();
    both((ss) => ss.settle(5, "failed", { note: "the session ended" }));
    for (const s of sides) s.start(ME);
    await tick(3200);
    v = same("its own account again");
    expect(v.activity[0]).toMatchObject({ outcome: "failed", detail: "the session ended" });
    expect(v.activity[0]!.code).toBeUndefined();

    // Everything that was told to a listener, in order, was the same on both sides.
    expect(v.told.length).toBeGreaterThan(15);
  });
});

describe("the receiver's wiring and a page's: a send confirmed afresh, and one that says which page sent it", () => {
  let dir: string;
  let sides: Side[];
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    dir = mkdtempSync(path.join(tmpdir(), "spgui-parity-"));
    sides = [receiverSide(dir), memorySide()];
  });
  afterEach(() => {
    for (const s of sides) s.stop();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("goes to spacesheep with the confirm alone, and both keep the same row of it", async () => {
    for (const s of sides) s.ss.machines = [listed(M1, "lab-mac")];
    for (const s of sides) s.start(ME);
    await vi.advanceTimersByTimeAsync(50);
    // A held send's second go (`{ cmd, confirm }`: nothing else signs it), from a session's page.
    const { cmd } = command(M1, "prompt", "claude-code:s-1");
    const confirm = { cred: "k1", sig: "confirm-signature" };
    const body = { cmd, confirm, from: "claude-code:s-1" };
    const answers = (await Promise.all(sides.map((s) => s.send(M1, body)))) as [Sent, Sent];
    for (const a of answers)
      expect("row" in a && a.row).toMatchObject({ kind: "prompt", machineId: M1, from: "claude-code:s-1" });
    for (const s of sides) expect(s.ss.jobs.map((j) => j.sent)).toEqual([{ cmd, csig: null, grant: null, confirm }]);
    const [a, b] = sides.map((s) => s.view()) as [View, View];
    expect(b).toEqual(a);
    expect(a.activity).toHaveLength(1);
    expect(a.activity[0]).toMatchObject({ from: "claude-code:s-1", kind: "prompt" });
    // The same after the job's word and a restart from what each kept.
    for (const s of sides) s.ss.settle(1, "done");
    await vi.advanceTimersByTimeAsync(3100);
    for (const s of sides) s.stop();
    for (const s of sides) s.start(ME);
    await vi.advanceTimersByTimeAsync(50);
    const [c, d] = sides.map((s) => s.view()) as [View, View];
    expect(d.activity).toEqual(c.activity);
    expect(c.activity[0]).toMatchObject({ from: "claude-code:s-1", outcome: "delivered" });
  });
});

describe("the control state of a page", () => {
  afterEach(() => vi.useRealTimers());
  const remote = { via: "spacesheep" as const, origin: ORIGIN, rpId: "spacesheep.test" };

  it("keeps a row of what it sent and nothing of what signed it", async () => {
    let saved: KeptQueues = {};
    const control = new MemoryControl({
      onSave: (q) => {
        saved = q;
      },
    });
    control.remote.setRemoteAccount(ME);
    control.remote.upsertRemoteMachines([listed(M1, "lab-mac")] as never, remote);
    const body = command(M1, "prompt", "claude-code:s-1");
    const sent: Record<string, unknown>[] = [];
    const row = await control.send(control.machine(M1)!, body, async (_m, b) => {
      sent.push(b);
      return { status: 202, json: { job: 11 } };
    });
    // spacesheep got the signed bytes as they came, and the four names it reads.
    expect(sent).toEqual([{ cmd: body.cmd, csig: "sig", grant: body.grant, confirm: null }]);
    expect(row).toMatchObject({
      remoteJob: 11,
      remoteAccount: `${ORIGIN} me@example.com`,
      text: "prompt for claude-code:s-1",
    });
    const kept = JSON.stringify(saved);
    expect(kept).toContain('"remoteJob":11');
    for (const secret of ["sig", '"grant"', '"csig"', '"confirm"', "nonce"]) expect(kept).not.toContain(secret);
    expect(saved[M1]![0]!.cmd).toBe("");

    // A send confirmed afresh: spacesheep gets the confirm, the row keeps none of it, and
    // the page it came from is kept.
    const again = command(M1, "prompt", "claude-code:s-2");
    const confirm = { cred: "k1", sig: "fresh-tap" };
    const second = await control.send(
      control.machine(M1)!,
      { cmd: again.cmd, confirm, from: "claude-code:s-2" },
      async (_m, b) => {
        sent.push(b);
        return { status: 202, json: { job: 12 } };
      },
    );
    expect(sent[1]).toEqual({ cmd: again.cmd, csig: null, grant: null, confirm });
    expect(second).toMatchObject({ remoteJob: 12, from: "claude-code:s-2" });
    for (const row of [second, ...saved[M1]!]) {
      expect(row.cmd).toBe("");
      expect(row.csig).toBeUndefined();
      expect(row.grant).toBeUndefined();
      expect(row.confirm).toBeUndefined();
    }
    const keptAfter = JSON.stringify(saved);
    for (const secret of ["fresh-tap", '"confirm"', '"cred"']) expect(keptAfter).not.toContain(secret);
    // (By session: two rows made in one millisecond are in no promised order.)
    expect(Object.fromEntries(saved[M1]!.map((r) => [r.session, r.from]))).toEqual({
      "claude-code:s-1": undefined,
      "claude-code:s-2": "claude-code:s-2",
    });
  });

  it("trims a queue each time it is saved: what is settled goes after a week, what waits stays", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    let saved: KeptQueues = {};
    let saves = 0;
    const control = new MemoryControl({
      onSave: (q) => {
        saves++;
        saved = q;
      },
    });
    control.remote.setRemoteAccount(ME);
    control.remote.upsertRemoteMachines([listed(M1, "lab-mac")] as never, remote);
    let job = 0;
    const go = (session: string) =>
      control.send(control.machine(M1)!, command(M1, "prompt", session), async () => ({
        status: 202,
        json: { job: ++job },
      }));
    await go("claude-code:s-1");
    await vi.advanceTimersByTimeAsync(5);
    await go("claude-code:s-2");
    await vi.advanceTimersByTimeAsync(5);
    await go("claude-code:s-3");
    // The first two are settled by spacesheep's word; the third still waits.
    const done = (id: number) => ({ id, status: "done", note: null, done_at: Date.now(), created_at: Date.now() });
    control.remote.applyRemoteJobs([done(1), done(2)], 2, Date.now());
    expect(saved[M1]!.map((r) => r.outcome)).toEqual(["delivered", "delivered", undefined]);
    // Eight days on, the next save (a new send) keeps the one that waits and the new one.
    await vi.advanceTimersByTimeAsync(8 * 86_400_000);
    const before = saves;
    await go("claude-code:s-4");
    expect(saves).toBeGreaterThan(before);
    expect(saved[M1]!.map((r) => r.session)).toEqual(["claude-code:s-3", "claude-code:s-4"]);
    expect(control.activity().map((a) => a.session)).toEqual(["claude-code:s-4", "claude-code:s-3"]);
  });

  it("reads back only queues of machines with a row spacesheep carried, trimmed as a queue is kept", () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const at = (ago: number) => new Date(Date.now() - ago).toISOString();
    const row = (id: string, machineId: string, over: Record<string, unknown> = {}) => ({
      id,
      machineId,
      cmd: "",
      at: at(1000),
      expiresAt: at(-1000),
      kind: "prompt" as const,
      session: "claude-code:s-1",
      via: "ui",
      remoteJob: 1,
      remoteAccount: `${ORIGIN} me@example.com`,
      ...over,
    });
    const control = new MemoryControl({
      kept: {
        [M1]: [
          row("01A", M1),
          row("01B", M1, { outcome: "delivered", ackedAt: at(8 * 86_400_000) }),
          row("01C", M2),
          null as never,
        ],
        // No row spacesheep carried, and a name that is no machine id: neither is a queue here.
        [M2]: [row("01D", M2, { remoteJob: undefined })],
        "../etc": [row("01E", "../etc")],
      },
    });
    expect(control.activity().map((a) => a.id)).toEqual(["01A"]);
  });

  it("makes ids the core takes for ULIDs, in the order of their time", () => {
    const a = newUlid(1_800_000_000_000);
    const b = newUlid(1_800_000_000_001);
    expect(isUlid(a) && isUlid(b)).toBe(true);
    expect(a < b).toBe(true);
    // The same ten characters of time the core writes for that millisecond.
    expect(a.slice(0, 10)).toBe(ulid(1_800_000_000_000).slice(0, 10));
    expect(new Set(Array.from({ length: 200 }, () => newUlid(5))).size).toBe(200);
  });
});
