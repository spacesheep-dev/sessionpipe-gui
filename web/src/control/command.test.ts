// SPDX-License-Identifier: Apache-2.0
// The command string a page signs (command.ts): fields in the spec's order, no field a kind
// does not own, the pool's on its own pseudo-session. And a send a receiver holds for a
// confirm: one fresh tap over the same bytes, sent alone, with either signer and carrier.
import "../native/test-env";
import { type MachineControl, POOL_SESSION } from "@shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendBody } from "./api";
import { b64url, sha256 } from "./bytes";
import { commandString, sendCommand, signAndDeliver } from "./command";
import { noteMachineControl } from "./remoteRp";

const M = "m_testmachine0000000001";

// A browser's passkey (its one prompt) and its day key, with a grant held for the day: a
// send under the grant asks for nothing, so every prompt counted here is a fresh tap.
const passkey = vi.hoisted(() => ({ asked: [] as { rp: string; challenge: Uint8Array }[] }));
vi.mock("./ceremony", () => ({
  assertPasskey: async (rp: string, challenge: Uint8Array) => {
    passkey.asked.push({ rp, challenge });
    return { cred: "pk1", ad: "ad", cd: "cd", sig: "sig" };
  },
}));
vi.mock("./daykey", () => ({
  obtainGrant: async (rp: string) => ({
    rp,
    grant: { str: `{"rp":"${rp}"}`, cred: "pk1", ad: "a", cd: "c", sig: "s" },
  }),
  signWithDayKey: async () => "csig",
  grantExpiry: async () => Date.now() + 3_600_000,
  dropGrant: async () => {},
}));

describe("commandString for a pool command", () => {
  it("names the pool's session and carries only the action's fields", () => {
    const on = JSON.parse(commandString(M, { kind: "pool", action: "on" }));
    expect(Object.keys(on)).toEqual(["v", "t", "machine", "kind", "session", "pool_action", "nonce", "iat"]);
    expect(on).toMatchObject({
      v: 1,
      t: "sessionpipe.control",
      machine: M,
      kind: "pool",
      session: POOL_SESSION,
      pool_action: "on",
    });
    expect(on.nonce).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    const order = JSON.parse(commandString(M, { kind: "pool", action: "order", order: ["b", "a"] }));
    expect(order).toMatchObject({ pool_action: "order", pool_order: ["b", "a"] });
    expect(order.pool_account).toBeUndefined();
    const done = JSON.parse(
      commandString(M, { kind: "pool", action: "login.complete", account: "login_1", code: "abc#state" }),
    );
    expect(done).toMatchObject({ pool_action: "login.complete", pool_account: "login_1", pool_code: "abc#state" });
    const off = JSON.parse(commandString(M, { kind: "pool", action: "off", account: "", code: "" }));
    expect(Object.keys(off)).not.toEqual(expect.arrayContaining(["pool_account", "pool_code"]));
  });
});

describe("a send a receiver holds for a confirm (CONTROL.md §3.2: a receiver's second look may ask for one)", () => {
  const g = globalThis as Record<string, unknown>;
  const LOCAL = "m_localmachine000000001";
  const REMOTE = "m_spacesheepmachine0001";
  /** What reached POST /api/ui/control/send, in order. */
  let posted: SendBody[] = [];
  /** The device key's prompts in the app: every sign the shell was asked for, by mode. */
  let native: { rp: string; cmd: string; mode: string }[] = [];
  /** The receiver: a command signed with the day grant is held for a confirm, as spacesheep
   *  answers one its second look holds (ui.ts forwardSend turns its 409 into this 422) and
   *  as a local receiver answers a pool action that takes one (pool.ts); one that carries a
   *  confirm alone is taken. `holdConfirms` holds that one too. */
  let holdConfirms = false;

  beforeEach(() => {
    posted = [];
    native = [];
    holdConfirms = false;
    passkey.asked = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(String(url)).toMatch(/\/api\/ui\/control\/send$/);
      const body = JSON.parse(String(init.body)) as SendBody;
      posted.push(body);
      const alone = !!body.confirm && !body.grant && !body.csig;
      if (!alone || holdConfirms)
        return Response.json({ reason: "this one needs a fresh confirm", code: "confirm_required" }, { status: 422 });
      return Response.json(
        { id: `01K${posted.length}`, machineId: body.machineId, kind: "prompt", at: new Date().toISOString() },
        { status: 201 },
      );
    });
    // A machine paired on spacesheep is signed for spacesheep's rp id (remoteRp.ts).
    noteMachineControl({
      machineId: REMOTE,
      remote: { via: "spacesheep", origin: "https://spacesheep.dev", rpId: "spacesheep.dev" },
    } as MachineControl);
  });
  afterEach(() => {
    delete g.sessionpipeShell;
    delete g.__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
  });

  /** The native app: the shell's flag and a Tauri runtime whose identity plugin signs. */
  function inApp() {
    g.sessionpipeShell = { v: 1, platform: "macos", features: ["signer"], receiver: { id: "rx0123abcd", local: true } };
    g.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === "plugin:identity|status") return { available: true, grantExp: Date.now() + 3_600_000 };
        if (cmd !== "plugin:identity|sign") return null;
        native.push({ rp: String(args.rp), cmd: String(args.cmd), mode: String(args.mode) });
        return args.mode === "confirm"
          ? { cmd: args.cmd, confirm: { cred: "dev1", sig: "dsig" } }
          : { cmd: args.cmd, csig: "dcsig", grant: { cred: "dev1", sig: "gsig", str: "{}" } };
      },
      transformCallback: () => 1,
    };
  }

  const cases = [
    { signer: "passkey", carrier: "a local receiver", machine: LOCAL, rp: "localhost" },
    { signer: "passkey", carrier: "spacesheep", machine: REMOTE, rp: "spacesheep.dev" },
    { signer: "device key", carrier: "a local receiver", machine: LOCAL, rp: "localhost" },
    { signer: "device key", carrier: "spacesheep", machine: REMOTE, rp: "spacesheep.dev" },
  ] as const;

  for (const c of cases) {
    it(`one press with the ${c.signer}, through ${c.carrier}: one fresh tap over the same bytes, sent alone`, async () => {
      if (c.signer === "device key") inApp();
      let taps = 0;
      const carried = await sendCommand(
        "localhost",
        c.machine,
        { kind: "prompt", session: "claude-code:s1", text: "ship it" },
        { onTap: () => taps++, from: "claude-code:s0" },
      );
      expect(carried.machineId).toBe(c.machine);
      expect(posted).toHaveLength(2);
      const [held, confirmed] = posted as [SendBody, SendBody];
      expect(held.grant).toBeDefined();
      expect(held.confirm).toBeUndefined();
      // The same command, signed by one confirm and nothing else (§3.2), the page's note kept.
      expect(confirmed.cmd).toBe(held.cmd);
      expect(Object.keys(confirmed).sort()).toEqual(["cmd", "confirm", "from", "machineId"]);
      expect(confirmed.from).toBe("claude-code:s0");
      expect(taps).toBe(1);
      if (c.signer === "passkey") {
        expect(passkey.asked).toHaveLength(1);
        expect(passkey.asked[0]!.rp).toBe(c.rp);
        expect(b64url(passkey.asked[0]!.challenge)).toBe(b64url(await sha256(held.cmd)));
      } else {
        expect(native.map((n) => n.mode)).toEqual(["grant", "confirm"]);
        expect(native.every((n) => n.rp === c.rp && n.cmd === held.cmd)).toBe(true);
      }
    });
  }

  it("a refused grant, then a hold: the new grant, then the confirm, in one press", async () => {
    const answers = ["bad_grant", "confirm_required"];
    const deliver = vi.fn(async (body: SendBody) => {
      posted.push(body);
      const code = answers.shift();
      if (code) throw Object.assign(new Error(code), { status: 422, code });
      return "taken";
    });
    await expect(
      signAndDeliver("localhost", REMOTE, { kind: "prompt", session: "claude-code:s1", text: "x" }, deliver),
    ).resolves.toBe("taken");
    expect(posted.map((b) => (b.confirm ? "confirm" : "grant"))).toEqual(["grant", "grant", "confirm"]);
    expect(passkey.asked).toHaveLength(1);
  });

  it("a send's expiry goes with its confirm", async () => {
    await sendCommand(
      "localhost",
      LOCAL,
      { kind: "prompt", session: "claude-code:s1", text: "later" },
      { expiresInS: 600 },
    );
    expect(posted.map((b) => b.expires_in_s)).toEqual([600, 600]);
  });

  it("a confirm that is held too is said, not asked for again", async () => {
    holdConfirms = true;
    await expect(
      sendCommand("localhost", REMOTE, { kind: "prompt", session: "claude-code:s1", text: "x" }),
    ).rejects.toMatchObject({ status: 422, code: "confirm_required" });
    expect(posted).toHaveLength(2);
    expect(passkey.asked).toHaveLength(1);
  });

  it("a caller that may not prompt (the workflows runner) is told, and nothing asks", async () => {
    const deliver = vi.fn(async (body: SendBody) => {
      posted.push(body);
      throw Object.assign(new Error("held"), { status: 422, code: "confirm_required" });
    });
    await expect(
      signAndDeliver("localhost", REMOTE, { kind: "prompt", session: "claude-code:s1", text: "x" }, deliver, {
        noPrompt: true,
      }),
    ).rejects.toMatchObject({ code: "confirm_required" });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(passkey.asked).toHaveLength(0);
  });

  it("a send that asked for a confirm itself is not asked for one again", async () => {
    holdConfirms = true;
    await expect(
      sendCommand("localhost", LOCAL, { kind: "pool", action: "on" }, { confirm: true }),
    ).rejects.toMatchObject({ code: "confirm_required" });
    expect(posted).toHaveLength(1);
    expect(passkey.asked).toHaveLength(1);
  });
});
