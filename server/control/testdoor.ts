// SPDX-License-Identifier: Apache-2.0
// The loopback test door the conformance runner uses (conformance/README.md: "a control
// scenario's `enqueue` step is the receiver's own test door: the runner signs the
// message with a test key it enrolled there"). Three routes, registered only when the
// app was started with `testDoor: true`, and answering 404 to anything but loopback:
//
//   POST {control}/_test/enroll   { machine, key?, name? }        trust a key for a machine
//                                                                 (the door's own test passkey
//                                                                 when none is given); the row
//                                                                 and its token are made when
//                                                                 missing. → { machine, token, key }
//   POST {control}/_test/enqueue  { machine, message: {...} }    build, sign and queue a command
//                                 or { machine, sign: {...}, expires_in_s }   → { id, machine, expires_at }
//   POST {control}/_test/approve  { code?, as? }                 approve a pending pairing with the
//                                                                 door's passkey as `as` (test-person)
//
// And the native app's signer, played by the door's software device key (TestDeviceKey),
// so the device-key path (CONTROL.md §2, §3.2) runs end to end in a browser test where no
// Secure Enclave exists. They answer what the app's `identity` plugin answers:
//
//   POST {control}/_test/device/key   {}                         → the door's device key
//   POST {control}/_test/device/sign  { cmd, mode }              → { cmd, csig, grant } (mode
//                                                                 "grant") or { cmd, confirm }
//   POST {control}/_test/device/pair  { code }                   → { key, proof } for a pending pairing
//
// The door's keys live in memory for the life of the process and never leave it. The
// enqueue goes through the same verifier as the UI's send, so the door can never queue
// what the verifier refuses. It skips the UI's second look at the hello (precheck.ts) on
// purpose: a delivery scenario sends a start the machine itself must refuse.
import { RECEIVER_MAX_AGE_MS, verifyCommand } from "sessionpipe-core/control";
import type { Ctx, Reply, Router } from "../http/router.js";
import { HttpError } from "../http/router.js";
import { CODE_RE, type Hello, MACHINE_RE } from "./parse.js";
import type { ControlState, MachineRow } from "./state.js";
import { commandStr, signCommand, signWithDevice, TestDayKey, TestDeviceKey, TestPasskey } from "./testkeys.js";
import { readKey } from "./ui.js";

export interface TestDoorDeps {
  state: ControlState;
  rpId: () => string;
  /** ROUTES.control */
  base: string;
  /** Device keys are taken (devicekeys.ts); off, the door has no device key either. */
  device: boolean;
}

const DOOR_FACTS: Hello = {
  name: "conformance",
  harnesses: ["claude-code"],
  modes: ["waiter"],
  keys: [],
  version: "0.0.0",
  waiting: [],
  folders: null,
  mode: null,
  accounts: [],
  files: false,
  promptFiles: false,
  home: null,
  start: null,
  keyTypes: null,
};

export function registerTestDoor(router: Router, d: TestDoorDeps): void {
  const { state, base } = d;
  let keys: Promise<{ passkey: TestPasskey; day: TestDayKey }> | null = null;
  const doorKeys = () => {
    keys ??= Promise.all([TestPasskey.create({ rpId: d.rpId() }), TestDayKey.create()]).then(([passkey, day]) => ({
      passkey,
      day,
    }));
    return keys;
  };
  let device: Promise<{ key: TestDeviceKey; day: TestDayKey }> | null = null;
  const deviceKeys = () => {
    device ??= Promise.all([TestDeviceKey.create({ rpId: d.rpId() }), TestDayKey.create()]).then(([key, day]) => ({
      key,
      day,
    }));
    return device;
  };
  const fence = (ctx: Ctx) => {
    if (!ctx.remote.loopback) throw new HttpError(404, { reason: "not_found" });
  };
  const machineOf = (v: unknown, create: boolean): MachineRow => {
    if (typeof v !== "string" || !MACHINE_RE.test(v))
      throw new HttpError(400, { reason: "bad_request", error: "Which machine?" });
    const m = state.machine(v);
    if (m) return m;
    if (!create) throw new HttpError(404, { reason: "not_found" });
    return state.createMachine(v, DOOR_FACTS);
  };

  router.post(`${base}/_test/enroll`, async (ctx): Promise<Reply> => {
    fence(ctx);
    const body = await ctx.json<{ machine?: unknown; key?: unknown; name?: unknown }>(64 * 1024);
    const m = machineOf(body.machine, true);
    const key = readKey(body.key, d.device) ?? (await doorKeys()).passkey.key;
    state.addKey(m, key, typeof body.name === "string" ? body.name : "test door");
    const token = state.mintToken(m);
    return { status: 201, json: { machine: m.id, token, key } };
  });

  router.post(`${base}/_test/enqueue`, async (ctx): Promise<Reply> => {
    fence(ctx);
    const body = await ctx.json<{ machine?: unknown; message?: unknown; sign?: unknown; expires_in_s?: unknown }>(
      256 * 1024,
    );
    const m = machineOf(body.machine, true);
    const msg = ((body.message ?? body.sign) as Record<string, unknown> | undefined) ?? {};
    if (typeof msg !== "object") throw new HttpError(400, { reason: "bad_request", error: "message is an object" });
    const { passkey, day } = await doorKeys();
    if (!m.keys.some((k) => k.id === passkey.key.id)) state.addKey(m, passkey.key, "test door");
    if (!m.tokenHash) state.mintToken(m);
    const cmd = commandStr(m.id, {
      kind: msg.kind,
      session: msg.session,
      text: msg.text,
      for: msg.for,
      decision: msg.decision,
      note: msg.note,
      cwd: msg.cwd,
      key: msg.key,
      name: msg.name,
      files: msg.files,
      permission: msg.permission,
      model: msg.model,
      ...(typeof msg.nonce === "string" ? { nonce: msg.nonce } : {}),
      ...(typeof msg.iat === "number" ? { iat: msg.iat } : {}),
    });
    const signed = await signCommand(passkey, day, cmd, { confirm: msg.confirm === true });
    const verdict = await verifyCommand(signed, {
      machine: m.id,
      rpId: d.rpId(),
      trusted: m.keys,
      now: Date.now(),
      maxAgeMs: RECEIVER_MAX_AGE_MS,
    });
    if (!verdict.ok) throw new HttpError(422, { reason: verdict.why, code: verdict.code });
    const ttlS = [msg.expires_in_s, body.expires_in_s].find((v) => typeof v === "number" && v > 0) as
      | number
      | undefined;
    const row = state.enqueue(m, signed, verdict.cmd, {
      via: "test-door",
      ...(ttlS ? { expiresInMs: ttlS * 1000 } : {}),
    });
    return { status: 201, json: { id: row.id, machine: m.id, expires_at: row.expiresAt } };
  });

  router.post(`${base}/_test/device/key`, async (ctx): Promise<Reply> => {
    fence(ctx);
    if (!d.device) throw new HttpError(404, { reason: "not_found" });
    return { status: 200, json: { key: (await deviceKeys()).key.key } };
  });

  router.post(`${base}/_test/device/sign`, async (ctx): Promise<Reply> => {
    fence(ctx);
    if (!d.device) throw new HttpError(404, { reason: "not_found" });
    const body = await ctx.json<{ cmd?: unknown; mode?: unknown }>(256 * 1024);
    if (typeof body.cmd !== "string" || (body.mode !== "grant" && body.mode !== "confirm"))
      throw new HttpError(400, { reason: "bad_request", error: "Send { cmd, mode: grant | confirm }." });
    const { key, day } = await deviceKeys();
    // The app signs the very bytes it was handed (it writes no command of its own).
    const signed = await signWithDevice(key, day, body.cmd, { confirm: body.mode === "confirm" });
    return { status: 200, json: signed };
  });

  router.post(`${base}/_test/device/pair`, async (ctx): Promise<Reply> => {
    fence(ctx);
    if (!d.device) throw new HttpError(404, { reason: "not_found" });
    const body = await ctx.json<{ code?: unknown }>(16 * 1024);
    const found = typeof body.code === "string" && CODE_RE.test(body.code) ? state.findPairing(body.code) : undefined;
    if (!found) throw new HttpError(404, { reason: "not_found" });
    const { key } = await deviceKeys();
    return { status: 200, json: { key: key.key, proof: await key.enroll(found.machine.id, found.pairing.code) } };
  });

  router.post(`${base}/_test/approve`, async (ctx): Promise<Reply> => {
    fence(ctx);
    const body = await ctx.json<{ code?: unknown; as?: unknown }>(16 * 1024);
    const found =
      typeof body.code === "string" && CODE_RE.test(body.code)
        ? state.findPairing(body.code)
        : state.pendingPairings()[0];
    if (!found) throw new HttpError(404, { reason: "not_found", error: "No pending pairing." });
    const { machine, pairing } = found;
    if (!state.pairingPending(pairing)) throw new HttpError(409, { reason: "not_pending" });
    const as = typeof body.as === "string" && body.as.trim() ? body.as.trim().slice(0, 200) : "test-person";
    const { passkey } = await doorKeys();
    const proof = await passkey.enroll(machine.id, pairing.code);
    state.approvePairing(machine, pairing, { ...passkey.key, addedAt: new Date().toISOString(), name: as }, proof, as);
    return { status: 200, json: { machine: machine.id, code: pairing.code, as } };
  });
}
