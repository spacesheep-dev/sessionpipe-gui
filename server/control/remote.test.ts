// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlState } from "./state.js";

// Machines paired on a spacesheep account (docs/rfcs/08): rows from the relay's list,
// sends carried there settled by the relay's job status.
describe("remote machines in the control state", () => {
  let dir: string;
  let state: ControlState;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "spgui-remote-"));
    state = new ControlState(path.join(dir, "control"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

  it("another account's sends, or none connected, can't be followed: settled as untracked", () => {
    state.setRemoteAccount(account);
    state.upsertRemoteMachines([listed()], remote);
    const m = state.machine("m_0123456789abcdefghij")!;
    const cmd = startCmd(m.id);
    const row = state.enqueueRemote(m, { cmd: JSON.stringify(cmd) }, cmd, { via: "ui" }, 9);
    state.close();
    const other = new ControlState(path.join(dir, "control"));
    other.setRemoteAccount({ origin: "https://spacesheep.dev", email: "someone@example.com" });
    expect(other.activityById(row.id)).toMatchObject({ outcome: "failed", code: "untracked" });
    expect(other.pendingRemoteJobsFrom()).toBeNull();
    // Job 9 on that account is another job: it changes nothing here.
    expect(other.applyRemoteJobs([{ id: 9, status: "done", note: null, done_at: Date.now(), created_at: 1 }])).toBe(0);
    other.close();
    const none = new ControlState(path.join(dir, "control"));
    const cmd2 = startCmd(m.id, "claude-code:def");
    none.setRemoteAccount(account);
    none.upsertRemoteMachines([listed()], remote);
    const row2 = none.enqueueRemote(none.machine(m.id)!, { cmd: JSON.stringify(cmd2) }, cmd2, { via: "ui" }, 10);
    none.dropRemoteMachines("spacesheep");
    none.setRemoteAccount(null);
    expect(none.activityById(row2.id)).toMatchObject({ outcome: "failed", code: "untracked" });
    none.close();
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
});
