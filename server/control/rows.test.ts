// SPDX-License-Identifier: Apache-2.0
// A permission answer's row says which prompt it answered and how (ControlActivity.answer),
// on a receiver and on a page on an account, for a row kept from before it said so too.
import type { ControlCommand } from "sessionpipe-core/control";
import { describe, expect, it } from "vitest";
import { type KeptQueues, MemoryControl } from "./remote.js";
import { type MachineRow, type MessageRow, messageRow, toActivity } from "./rows.js";

const SESSION = "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e";
const machine = { id: "m_rowsanswer000000001", name: "studio-mac" } as MachineRow;
const answer = (o: Partial<ControlCommand> = {}) =>
  ({
    kind: "permission.answer",
    session: SESSION,
    for: "perm-1",
    decision: "deny",
    note: "not on main",
    ...o,
  }) as ControlCommand;
const at = { via: "ui", id: "01JROWS0000000000000000000", now: Date.parse("2026-11-17T10:00:00Z") };

describe("a permission answer's row", () => {
  it("carries the prompt it answered and the decision; nothing else does", () => {
    const cmd = answer();
    const row = messageRow(machine, { cmd: JSON.stringify(cmd) }, cmd, at);
    expect(toActivity(row).answer).toEqual({ for: "perm-1", decision: "deny" });
    // The words stay as they were.
    expect(toActivity(row).text).toBe("deny: not on main");
    const prompt = { kind: "prompt", session: SESSION, text: "hi" } as ControlCommand;
    expect(toActivity(messageRow(machine, { cmd: JSON.stringify(prompt) }, prompt, at)).answer).toBeUndefined();
  });

  it("a page on an account keeps no command, and still says it", () => {
    const cmd = answer({ decision: "allow" });
    const row = messageRow(machine, { cmd: "" }, cmd, at);
    expect(row.cmd).toBe("");
    expect(toActivity(row).answer).toEqual({ for: "perm-1", decision: "allow" });
  });

  it("a receiver's row kept from before reads it from the signed command; a row that holds neither says nothing", () => {
    const cmd = answer({ decision: "allow" });
    const { answer: _, ...old } = messageRow(machine, { cmd: JSON.stringify(cmd) }, cmd, at);
    expect((old as MessageRow).answer).toBeUndefined();
    expect(toActivity(old as MessageRow).answer).toEqual({ for: "perm-1", decision: "allow" });
    expect(toActivity({ ...(old as MessageRow), cmd: "" }).answer).toBeUndefined();
    expect(toActivity({ ...(old as MessageRow), cmd: "{not json" }).answer).toBeUndefined();
    expect(
      toActivity({ ...(old as MessageRow), cmd: JSON.stringify({ ...cmd, decision: "maybe" }) }).answer,
    ).toBeUndefined();
  });

  it("on a page on an account, survives the app being opened again", () => {
    let kept: KeptQueues = {};
    const page = new MemoryControl({ onSave: (q) => (kept = JSON.parse(JSON.stringify(q)) as KeptQueues) });
    page.remote.setRemoteAccount({ origin: "https://spacesheep.dev", email: "me@example.com" });
    page.remote.upsertRemoteMachines(
      [
        {
          id: "m_0123456789abcdefghij",
          name: "lab-mac",
          online: true,
          last_seen: Date.now(),
          agents: ["claude-code"],
          cli_version: "sessionpipe 0.15.0",
          modes: ["waiter"],
          passkey_ids: ["k1"],
          key_types: ["passkey", "device"],
        },
      ],
      { via: "spacesheep", origin: "https://spacesheep.dev", rpId: "spacesheep.dev" },
    );
    const m = page.machine("m_0123456789abcdefghij")!;
    const cmd = answer({ decision: "allow" });
    const row = page.remote.enqueueRemote(m, { cmd: JSON.stringify(cmd) }, cmd, { via: "ui" }, 41);
    expect(page.activityById(row.id)?.answer).toEqual({ for: "perm-1", decision: "allow" });
    const again = new MemoryControl({ kept });
    expect(again.activityById(row.id)?.answer).toEqual({ for: "perm-1", decision: "allow" });
  });
});

describe("a message row with files", () => {
  it("says its nonce, where the machine saves them, also on a page's row that keeps no command", () => {
    const file = { name: "kiwi.png", type: "image/png", size: 158, sha256: "k".repeat(43) };
    const cmd = { kind: "prompt", session: SESSION, text: "Look", files: [file], nonce: "n0nce-0123456789ab" } as never;
    for (const signed of [{ cmd: JSON.stringify(cmd) }, { cmd: "" }])
      expect(toActivity(messageRow(machine, signed, cmd, at))).toMatchObject({
        files: [file],
        nonce: "n0nce-0123456789ab",
      });
    // Without files there is nothing to find again by it.
    const plain = { kind: "prompt", session: SESSION, text: "Look", nonce: "n0nce-0123456789ab" } as never;
    expect(toActivity(messageRow(machine, { cmd: "" }, plain, at)).nonce).toBeUndefined();
  });
});
