// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlState, EXPIRES_MAX_MS, REMOTE_GRACE_MS } from "./state.js";

// Machines paired on a spacesheep account (docs/rfcs/08): rows from the relay's list,
// sends carried there settled by the relay's job status.
describe("remote machines in the control state", () => {
  let dir: string;
  let state: ControlState;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "spgui-remote-"));
    state = new ControlState(path.join(dir, "control"));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const remote = { via: "spacesheep" as const, origin: "https://spacesheep.dev", rpId: "spacesheep.dev" };
  const listed = (over: Record<string, unknown> = {}) => ({
    id: "m_0123456789abcdefghij",
    name: "lab-mac",
    online: true,
    last_seen: Date.now(),
    folders: ["/home/me"],
    mode: "safe",
    agents: ["claude-code"],
    cli_version: "sessionpipe 0.13.0",
    modes: ["waiter"],
    passkey_ids: ["k1", "k2"],
    files: true,
    prompt_files: true,
    key_types: ["passkey", "device"],
    ask: true,
    handoff: true,
    ...over,
  });

  it("keeps the relay's machines as rows, with their keys as ids, online as the relay says, and never on disk", () => {
    state.upsertRemoteMachines([listed()], remote);
    const m = state.machine("m_0123456789abcdefghij")!;
    expect(m.remote).toMatchObject({
      via: "spacesheep",
      origin: "https://spacesheep.dev",
      rpId: "spacesheep.dev",
      online: true,
    });
    expect(m.keys.map((k) => k.id)).toEqual(["k1", "k2"]);
    expect(m.keyTypes).toEqual(["passkey", "device"]);
    expect(m.ask).toBe(true);
    expect(m.handoff).toBe(true);
    const c = state.machineControl(m);
    expect(c.online).toBe(true);
    expect(c.remote).toEqual({ via: "spacesheep", origin: "https://spacesheep.dev", rpId: "spacesheep.dev" });
    // The computer takes files, but no file can be carried through spacesheep: none is offered.
    expect(c.files).toBeUndefined();
    expect(c.promptFiles).toBeUndefined();
    // Offline there, offline here; gone there, gone here. Never written to machines.json.
    state.upsertRemoteMachines([listed({ online: false, passkey_ids: ["k1"] })], remote);
    expect(state.machineControl(state.machine("m_0123456789abcdefghij")!).online).toBe(false);
    expect(state.machine("m_0123456789abcdefghij")!.keys.map((k) => k.id)).toEqual(["k1"]);
    const again = new ControlState(path.join(dir, "control"));
    expect(again.machine("m_0123456789abcdefghij")).toBeUndefined();
    state.upsertRemoteMachines([], remote);
    expect(state.machine("m_0123456789abcdefghij")).toBeUndefined();
  });

  const account = { origin: "https://spacesheep.dev", email: "me@example.com" };
  const startCmd = (machine: string, session = "claude-code:abc") => ({
    v: 1 as const,
    t: "sessionpipe.control" as const,
    machine,
    kind: "start" as const,
    session,
    text: "hi",
    cwd: "/home/me",
    nonce: `n-${session}`,
    iat: Date.now(),
  });

  it("a send carried there settles by the relay's job status", () => {
    state.setRemoteAccount(account);
    state.upsertRemoteMachines([listed()], remote);
    const m = state.machine("m_0123456789abcdefghij")!;
    const cmd = {
      v: 1 as const,
      t: "sessionpipe.control" as const,
      machine: m.id,
      kind: "prompt" as const,
      session: "claude-code:abc",
      text: "hi",
      nonce: "n",
      iat: Date.now(),
    };
    const row = state.enqueueRemote(m, { cmd: JSON.stringify(cmd), csig: "s" }, cmd, { via: "ui" }, 41);
    expect(row.remoteJob).toBe(41);
    expect(row.outcome).toBeUndefined();
    expect(state.pendingRemoteJobsFrom()).toBe(41);
    expect(state.applyRemoteJobs([{ id: 41, status: "queued", note: null, done_at: null, created_at: 1 }])).toBe(0);
    expect(state.applyRemoteJobs([{ id: 41, status: "running", note: null, done_at: null, created_at: 1 }])).toBe(1);
    expect(state.activityById(row.id)?.outcome).toBe("taken");
    expect(
      state.applyRemoteJobs([
        { id: 41, status: "refused", note: "That session's folder isn't allowed.", done_at: Date.now(), created_at: 1 },
      ]),
    ).toBe(1);
    const a = state.activityById(row.id)!;
    expect(a.outcome).toBe("refused");
    expect(a.detail).toBe("That session's folder isn't allowed.");
    expect(state.pendingRemoteJobsFrom()).toBeNull();
    // Settled is settled.
    expect(state.applyRemoteJobs([{ id: 41, status: "done", note: null, done_at: Date.now(), created_at: 1 }])).toBe(0);
    const row2 = state.enqueueRemote(m, { cmd: JSON.stringify(cmd) }, cmd, { via: "ui" }, 42);
    expect(state.applyRemoteJobs([{ id: 42, status: "done", note: null, done_at: Date.now(), created_at: 1 }])).toBe(1);
    expect(state.activityById(row2.id)?.outcome).toBe("delivered");
  });

  it("a send waiting there outlives a restart: kept on disk, matched again by the account", () => {
    state.setRemoteAccount(account);
    state.upsertRemoteMachines([listed()], remote);
    const m = state.machine("m_0123456789abcdefghij")!;
    const cmd = startCmd(m.id);
    const row = state.enqueueRemote(m, { cmd: JSON.stringify(cmd) }, cmd, { via: "ui" }, 7);
    expect(row.remoteAccount).toBe("https://spacesheep.dev me@example.com");
    state.close();
    // The machine is never saved, its queue is: the start is on the page before the list is read.
    const again = new ControlState(path.join(dir, "control"));
    expect(again.machine(m.id)).toBeUndefined();
    expect(again.activityById(row.id)?.kind).toBe("start");
    again.setRemoteAccount(account);
    expect(again.pendingRemoteJobsFrom()).toBe(7);
    again.upsertRemoteMachines([listed({ online: false })], remote);
    expect(again.machine(m.id)).toBeDefined();
    expect(again.applyRemoteJobs([{ id: 7, status: "done", note: null, done_at: Date.now(), created_at: 1 }])).toBe(1);
    expect(again.activityById(row.id)?.outcome).toBe("delivered");
    again.close();
  });

  it("a row of this account whose machine left the list waits for spacesheep's word", () => {
    state.setRemoteAccount(account);
    state.upsertRemoteMachines([listed()], remote);
    const m = state.machine("m_0123456789abcdefghij")!;
    const cmd = startCmd(m.id);
    const row = state.enqueueRemote(m, { cmd: JSON.stringify(cmd) }, cmd, { via: "ui" }, 8);
    state.upsertRemoteMachines([], remote);
    expect(state.activityById(row.id)?.outcome).toBeUndefined();
    expect(state.pendingRemoteJobsFrom()).toBe(8);
    state.applyRemoteJobs([
      { id: 8, status: "refused", note: "the machine was removed", done_at: Date.now(), created_at: 1 },
    ]);
    expect(state.activityById(row.id)).toMatchObject({ outcome: "refused", detail: "the machine was removed" });
  });

  it("another account's sends can't be followed: settled as untracked when that other account connects", () => {
    state.setRemoteAccount(account);
    state.upsertRemoteMachines([listed()], remote);
    const m = state.machine("m_0123456789abcdefghij")!;
    const cmd = startCmd(m.id);
    const row = state.enqueueRemote(m, { cmd: JSON.stringify(cmd) }, cmd, { via: "ui" }, 9);
    state.close();
    const other = new ControlState(path.join(dir, "control"));
    other.setRemoteAccount({ origin: "https://spacesheep.dev", email: "someone@example.com" });
    expect(other.activityById(row.id)).toMatchObject({ outcome: "failed", code: "untracked" });
    expect(other.activityById(row.id)?.unfollowed).toBeUndefined();
    expect(other.pendingRemoteJobsFrom()).toBeNull();
    // Job 9 on that account is another job: it changes nothing here.
    expect(other.applyRemoteJobs([{ id: 9, status: "done", note: null, done_at: Date.now(), created_at: 1 }])).toBe(0);
    other.close();
  });

  it("disconnected, a waiting send stays waiting, not followed; the same account reconnecting settles it", () => {
    state.setRemoteAccount(account);
    state.upsertRemoteMachines([listed()], remote);
    const m = state.machine("m_0123456789abcdefghij")!;
    const cmd = startCmd(m.id);
    const row = state.enqueueRemote(m, { cmd: JSON.stringify(cmd) }, cmd, { via: "ui" }, 10);
    const seen: Array<string | undefined> = [];
    state.onMessage = (r) => seen.push(r.unfollowed ? "unfollowed" : r.outcome);
    state.dropRemoteMachines("spacesheep");
    state.setRemoteAccount(null);
    expect(state.activityById(row.id)).toMatchObject({ unfollowed: true });
    expect(state.activityById(row.id)?.outcome).toBeUndefined();
    expect(state.pendingRemoteJobsFrom()).toBeNull();
    // A restart while disconnected keeps it so.
    state.close();
    const again = new ControlState(path.join(dir, "control"));
    again.setRemoteAccount(null);
    expect(again.activityById(row.id)).toMatchObject({ unfollowed: true });
    again.onMessage = (r) => seen.push(r.unfollowed ? "unfollowed" : (r.outcome ?? "followed"));
    again.setRemoteAccount(account);
    expect(again.activityById(row.id)?.unfollowed).toBeUndefined();
    expect(again.pendingRemoteJobsFrom()).toBe(10);
    again.applyRemoteJobs([{ id: 10, status: "running", note: null, done_at: null, created_at: 1 }]);
    expect(again.activityById(row.id)?.outcome).toBe("taken");
    expect(seen).toEqual(["unfollowed", "followed", "taken"]);
    again.close();
  });

  it("a row from before rows named their account is matched by its machine on the first list", () => {
    const m = "m_0123456789abcdefghij";
    const gone = "m_abcdefghij0123456789";
    const row = (id: string, machineId: string, job: number) => ({
      id,
      machineId,
      remoteJob: job,
      cmd: "{}",
      at: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      kind: "start",
      session: "claude-code:abc",
      via: "ui",
    });
    mkdirSync(path.join(dir, "control", "queue"), { recursive: true });
    writeFileSync(
      path.join(dir, "control", "queue", `${m}.json`),
      JSON.stringify({ v: 1, messages: [row("01A", m, 3)] }),
    );
    writeFileSync(
      path.join(dir, "control", "queue", `${gone}.json`),
      JSON.stringify({ v: 1, messages: [row("01B", gone, 4)] }),
    );
    const s = new ControlState(path.join(dir, "control"));
    s.setRemoteAccount(account);
    expect(s.activityById("01A")?.outcome).toBeUndefined();
    expect(s.activityById("01B")?.outcome).toBeUndefined();
    s.upsertRemoteMachines([listed()], remote);
    expect(s.pendingRemoteJobsFrom()).toBe(3);
    expect(s.activityById("01B")).toMatchObject({ outcome: "failed", code: "untracked" });
    s.close();
  });

  it("only spacesheep's word settles its send: no expiry of this receiver's own", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    state.setRemoteAccount(account);
    state.upsertRemoteMachines([listed({ online: false })], remote);
    const m = state.machine("m_0123456789abcdefghij")!;
    const cmd = startCmd(m.id);
    const row = state.enqueueRemote(m, { cmd: JSON.stringify(cmd) }, cmd, { via: "ui" }, 11);
    // spacesheep's day, not the receiver's hour.
    expect(Date.parse(row.expiresAt) - Date.parse(row.at)).toBe(EXPIRES_MAX_MS);
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    state.sweep();
    expect(state.activityById(row.id)?.outcome).toBeUndefined();
    // Past its day, with spacesheep still saying queued: still spacesheep's to say...
    vi.setSystemTime(Date.parse(row.at) + EXPIRES_MAX_MS + 60_000);
    state.sweep();
    expect(state.applyRemoteJobs([{ id: 11, status: "queued", note: null, done_at: null, created_at: 1 }], 11)).toBe(0);
    expect(state.activityById(row.id)?.outcome).toBeUndefined();
    // ...and it said so after a GUI that was off: done while away is done.
    const later = state.enqueueRemote(
      m,
      { cmd: JSON.stringify(startCmd(m.id, "claude-code:x")) },
      startCmd(m.id, "claude-code:x"),
      { via: "ui" },
      12,
    );
    vi.setSystemTime(Date.parse(later.at) + EXPIRES_MAX_MS + REMOTE_GRACE_MS + 60_000);
    expect(
      state.applyRemoteJobs(
        [
          { id: 11, status: "queued", note: null, done_at: null, created_at: 1 },
          { id: 12, status: "done", note: null, done_at: Date.parse(later.at) + 60_000, created_at: 1 },
        ],
        Number.POSITIVE_INFINITY,
      ),
    ).toBe(2);
    expect(state.activityById(later.id)).toMatchObject({
      outcome: "delivered",
      ackedAt: new Date(Date.parse(later.at) + 60_000).toISOString(),
    });
    // Once spacesheep can no longer hand it out (its day and the grace), queued there is expired here.
    expect(state.activityById(row.id)).toMatchObject({
      outcome: "expired",
      detail: "expired before the machine took it",
    });
  });

  it("a send spacesheep no longer lists is expired only past its day, and only where the read reached", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    state.setRemoteAccount(account);
    state.upsertRemoteMachines([listed({ online: false })], remote);
    const m = state.machine("m_0123456789abcdefghij")!;
    const cmd = startCmd(m.id);
    const row = state.enqueueRemote(m, { cmd: JSON.stringify(cmd) }, cmd, { via: "ui" }, 500);
    expect(state.applyRemoteJobs([], Number.POSITIVE_INFINITY)).toBe(0);
    vi.setSystemTime(Date.parse(row.at) + EXPIRES_MAX_MS + REMOTE_GRACE_MS + 1000);
    // The read stopped short of job 500 (its pages ended at 400): nothing is known of it.
    expect(state.applyRemoteJobs([], 400)).toBe(0);
    expect(state.activityById(row.id)?.outcome).toBeUndefined();
    expect(state.applyRemoteJobs([], Number.POSITIVE_INFINITY)).toBe(1);
    expect(state.activityById(row.id)?.outcome).toBe("expired");
  });

  it("copies spacesheep's code onto the row, and guesses none where it sends none", () => {
    state.setRemoteAccount(account);
    state.upsertRemoteMachines([listed()], remote);
    const m = state.machine("m_0123456789abcdefghij")!;
    const send = (job: number) => {
      const cmd = startCmd(m.id, `claude-code:s${job}`);
      return state.enqueueRemote(m, { cmd: JSON.stringify(cmd) }, cmd, { via: "ui" }, job);
    };
    const rows = [20, 21, 22, 23, 24, 25].map(send);
    const note = (s: string) => ({ note: s, done_at: Date.now(), created_at: 1 });
    state.applyRemoteJobs([
      { id: 20, status: "refused", code: "folder", ...note("That session's folder isn't allowed.") },
      { id: 21, status: "refused", code: "cancelled", ...note("called off by its owner before the machine took it") },
      { id: 22, status: "failed", code: "expired", ...note("expired before the machine took it") },
      { id: 23, status: "failed", code: "model", ...note("no such model") },
      // An older spacesheep: no code, and none is read off the note.
      { id: 24, status: "refused", ...note("called off by its owner before the machine took it") },
      { id: 25, status: "refused", code: "Not A Code!", ...note("x") },
    ]);
    const a = rows.map((r) => state.activityById(r.id)!);
    expect(a[0]).toMatchObject({ outcome: "refused", code: "folder" });
    expect(a[1]).toMatchObject({ outcome: "refused", code: "cancelled" });
    expect(a[2]).toMatchObject({ outcome: "expired", detail: "expired before the machine took it" });
    expect(a[2]!.code).toBeUndefined();
    expect(a[3]).toMatchObject({ outcome: "failed", code: "model", detail: "no such model" });
    expect(a[4]).toMatchObject({ outcome: "refused", detail: "called off by its owner before the machine took it" });
    expect(a[4]!.code).toBeUndefined();
    expect(a[5]!.code).toBeUndefined();
  });
});
