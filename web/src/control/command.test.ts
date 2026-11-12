// SPDX-License-Identifier: Apache-2.0
// The command string a page signs (command.ts): fields in the spec's order, no field a kind
// does not own, the pool's on its own pseudo-session. And a send a receiver holds for a
// confirm: never confirmed on its own; its caller gets the hold and the receiver's reason,
// and a confirm from a press is a new command, signed once with a confirm and sent alone.
import "../native/test-env";
import { type MachineControl, POOL_SESSION } from "@shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlError, type SendBody } from "./api";
import { b64url, sha256 } from "./bytes";
import { commandString, HeldForConfirm, sendCommand, signAndDeliver } from "./command";
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
  const WHY = "it reads like an instruction to delete files";
  /** What reached POST /api/ui/control/send, in order. */
  let posted: SendBody[] = [];
  /** The device key's prompts in the app: every sign the shell was asked for. */
  let native: { rp: string; cmd: string; mode: string }[] = [];
  /** The receiver holds what is signed with the day grant, the way the GUI server answers
   *  spacesheep's 409 (ui.ts forwardSend: its error as `reason`, its `why` as `detail`) and
   *  a local receiver a confirm-only pool action (pool.ts: its words as `reason`); it takes a
   *  confirm alone. `holdConfirms` holds that one too. */
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
        return Response.json(
          body.machineId === REMOTE
            ? { reason: `Confirm with your passkey to send this: ${WHY}.`, code: "confirm_required", detail: WHY }
            : { reason: "pool order needs a fresh confirm, not a day grant", code: "confirm_required" },
          { status: 422 },
        );
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
    vi.useRealTimers();
  });

  /** The native app on this Mac's receiver (rp id localhost): its identity plugin signs
   *  only for that receiver's rp id, as Rust's answer::target does, and refuses another
   *  with `rp_mismatch` (sp-identity answer.rs). */
  function inApp() {
    g.sessionpipeShell = { v: 1, platform: "macos", features: ["signer"], receiver: { id: "rx0123abcd", local: true } };
    g.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === "plugin:identity|status") return { available: true, grantExp: Date.now() + 3_600_000 };
        if (cmd !== "plugin:identity|sign") return null;
        if (args.rp !== "localhost")
          throw { code: "rp_mismatch", message: `http://127.0.0.1:7819 signs for localhost, not ${String(args.rp)}` };
        native.push({ rp: String(args.rp), cmd: String(args.cmd), mode: String(args.mode) });
        return args.mode === "confirm"
          ? { cmd: args.cmd, confirm: { cred: "dev1", sig: "dsig" } }
          : { cmd: args.cmd, csig: "dcsig", grant: { cred: "dev1", sig: "gsig", str: "{}" } };
      },
      transformCallback: () => 1,
    };
  }

  /** One press, held: the hold, nothing confirmed, nothing asked. */
  async function pressHeld(machine: string, o: Parameters<typeof sendCommand>[3] = {}) {
    const press = sendCommand("localhost", machine, { kind: "prompt", session: "claude-code:s1", text: "ship it" }, o);
    const e = (await press.catch((x: unknown) => x)) as HeldForConfirm<unknown>;
    expect(e).toBeInstanceOf(HeldForConfirm);
    expect(e).toBeInstanceOf(ControlError);
    expect(e).toMatchObject({ status: 422, code: "confirm_required" });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.grant).toBeDefined();
    expect(passkey.asked).toHaveLength(0);
    expect(native.filter((n) => n.mode === "confirm")).toHaveLength(0);
    return e;
  }

  const cases = [
    { signer: "passkey", carrier: "spacesheep", machine: REMOTE, rp: "spacesheep.dev", why: WHY },
    {
      signer: "passkey",
      carrier: "a local receiver",
      machine: LOCAL,
      rp: "localhost",
      why: "pool order needs a fresh confirm, not a day grant",
    },
    {
      signer: "device key",
      carrier: "a local receiver",
      machine: LOCAL,
      rp: "localhost",
      why: "pool order needs a fresh confirm, not a day grant",
    },
  ] as const;

  for (const c of cases) {
    it(`with the ${c.signer}, through ${c.carrier}: the press is held with the receiver's reason; the confirm is a new command, signed once, sent alone`, async () => {
      if (c.signer === "device key") inApp();
      vi.useFakeTimers({ now: Date.parse("2026-11-12T12:00:00Z"), toFake: ["Date"] });
      const held = await pressHeld(c.machine, { from: "claude-code:s0" });
      expect(held.why).toBe(c.why);
      expect(held.fields).toEqual({ kind: "prompt", session: "claude-code:s1", text: "ship it" });
      // The person reads it, then presses Confirm: later, so the command is signed now.
      vi.setSystemTime(Date.parse("2026-11-12T12:03:00Z"));
      let taps = 0;
      const carried = (await held.confirm({ onTap: () => taps++ })) as { machineId: string };
      expect(carried.machineId).toBe(c.machine);
      expect(posted).toHaveLength(2);
      const [first, second] = posted as [SendBody, SendBody];
      const a = JSON.parse(first.cmd);
      const b = JSON.parse(second.cmd);
      // The same send, built again: a new nonce, the time of the confirm.
      expect({ ...b, nonce: 0, iat: 0 }).toEqual({ ...a, nonce: 0, iat: 0 });
      expect(b.nonce).not.toBe(a.nonce);
      expect(b.iat).toBe(Date.parse("2026-11-12T12:03:00Z"));
      // Signed by one confirm and nothing else (§3.2), the page's own note kept.
      expect(Object.keys(second).sort()).toEqual(["cmd", "confirm", "from", "machineId"]);
      expect(taps).toBe(1);
      if (c.signer === "passkey") {
        expect(passkey.asked).toHaveLength(1);
        expect(passkey.asked[0]!.rp).toBe(c.rp);
        expect(b64url(passkey.asked[0]!.challenge)).toBe(b64url(await sha256(second.cmd)));
      } else {
        expect(native.map((n) => [n.mode, n.rp])).toEqual([
          ["grant", c.rp],
          ["confirm", c.rp],
        ]);
        expect(native[1]!.cmd).toBe(second.cmd);
      }
    });
  }

  it("the app's device key, to a machine paired on spacesheep through this Mac's receiver: the signer refuses it, nothing is sent, no hold", async () => {
    inApp();
    const e = await sendCommand("localhost", REMOTE, { kind: "prompt", session: "claude-code:s1", text: "x" }).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ code: "rp_mismatch" });
    expect(e).not.toBeInstanceOf(HeldForConfirm);
    expect(posted).toHaveLength(0);
  });

  it("a send's expiry goes with its confirm", async () => {
    const held = await pressHeld(LOCAL, { expiresInS: 600 });
    await held.confirm();
    expect(posted.map((b) => b.expires_in_s)).toEqual([600, 600]);
  });

  it("a confirm that is held too is a refusal, not another hold", async () => {
    const held = await pressHeld(REMOTE);
    holdConfirms = true;
    const e = await held.confirm().catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 422, code: "confirm_required" });
    expect(e).not.toBeInstanceOf(HeldForConfirm);
    expect(posted).toHaveLength(2);
    expect(passkey.asked).toHaveLength(1);
  });

  it("a refused grant, then a hold: the new grant once, then the hold", async () => {
    const answers = ["bad_grant", "confirm_required"];
    const deliver = vi.fn(async (body: SendBody) => {
      posted.push(body);
      const code = answers.shift();
      if (code) throw Object.assign(new Error(code), { status: 422, code, reason: code });
      return "taken";
    });
    const e = await signAndDeliver(
      "localhost",
      REMOTE,
      { kind: "prompt", session: "claude-code:s1", text: "x" },
      deliver,
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HeldForConfirm);
    expect(posted.map((b) => (b.confirm ? "confirm" : "grant"))).toEqual(["grant", "grant"]);
    expect(passkey.asked).toHaveLength(0);
    await expect((e as HeldForConfirm<string>).confirm()).resolves.toBe("taken");
    expect(posted.map((b) => (b.confirm ? "confirm" : "grant"))).toEqual(["grant", "grant", "confirm"]);
  });

  it("a caller that may not prompt (the workflows runner) gets the refusal itself, and nothing asks", async () => {
    const refusal = Object.assign(new Error("held"), { status: 422, code: "confirm_required" });
    const deliver = vi.fn(async (body: SendBody) => {
      posted.push(body);
      throw refusal;
    });
    await expect(
      signAndDeliver("localhost", REMOTE, { kind: "prompt", session: "claude-code:s1", text: "x" }, deliver, {
        noPrompt: true,
      }),
    ).rejects.toBe(refusal);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(passkey.asked).toHaveLength(0);
  });

  it("a theme's send (no onTap, no noPrompt) is held like any other: no prompt nobody pressed for", async () => {
    await pressHeld(REMOTE);
  });

  it("a send that was a confirm already is refused, not held", async () => {
    holdConfirms = true;
    const e = await sendCommand("localhost", LOCAL, { kind: "pool", action: "on" }, { confirm: true }).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ code: "confirm_required" });
    expect(e).not.toBeInstanceOf(HeldForConfirm);
    expect(posted).toHaveLength(1);
    expect(passkey.asked).toHaveLength(1);
  });
});
