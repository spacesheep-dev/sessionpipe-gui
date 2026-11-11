// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
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

  it("a send carried there settles by the relay's job status", () => {
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
});
