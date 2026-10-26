// SPDX-License-Identifier: Apache-2.0
// The receiver side of CONTROL.md, over real HTTP and real signatures: pairing (keyed,
// open, renewal, expiry, wrong poll key), machine-token isolation, the long-poll,
// redelivery, the `taken` pause, acks, expiry, off, the early verification against
// every control vector, the approval proof, persistence and the stream.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RECEIVER_MAX_AGE_MS, sha256 } from "sessionpipe-core/control";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ROUTES, type StreamMessage } from "../../shared/api.js";
import { Router } from "../http/router.js";
import { coreTakesDevice, receiverKeyTypes } from "./devicekeys.js";
import { fileHash } from "./files.js";
import { type Control, createControl } from "./index.js";
import { parseAcks, parseHello } from "./parse.js";
import { commandStr, signCommand, signWithDevice, TestDayKey, TestDeviceKey, TestPasskey } from "./testkeys.js";
import { readKey, readProof } from "./ui.js";

const SINK = "spg_test_sink_token_0123456789";
const CONTROL = ROUTES.control;
const UI = ROUTES.ui.control;

interface Booted {
  url: string;
  control: Control;
  stateDir: string;
  close(): Promise<void>;
}

async function boot(
  o: { stateDir?: string; rpId?: string; testDoor?: boolean; uiAuth?: boolean; deviceKeys?: boolean } = {},
): Promise<Booted> {
  const stateDir = o.stateDir ?? mkdtempSync(path.join(os.tmpdir(), "spgui-control-"));
  const control = createControl({
    stateDir,
    sinkToken: () => SINK,
    rpId: o.rpId ?? "localhost",
    testDoor: o.testDoor ?? true,
    uiAuth: (ctx) => (o.uiAuth ?? true) && ctx.remote.loopback,
    ...(o.deviceKeys !== undefined ? { deviceKeys: o.deviceKeys } : {}),
  });
  const router = new Router();
  control.register(router);
  const server = http.createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${a.port}`,
    control,
    stateDir,
    close: async () => {
      control.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

type Res = { status: number; body: Record<string, unknown> & { messages?: Record<string, unknown>[] } };
async function call(url: string, method: string, p: string, o: { bearer?: string; body?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (o.bearer !== undefined) headers.authorization = `Bearer ${o.bearer}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${url}${p}`, {
    method,
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  let body: Res["body"] = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: r.status, body };
}

const facts = { name: "mac-mini", harnesses: ["claude-code"], modes: ["waiter", "turn"], version: "0.9.0" };

/** A machine with one trusted passkey and its token, through the test door. */
async function enrolled(b: Booted, passkey: TestPasskey, machine = "m_testmachine0000000001") {
  const r = await call(b.url, "POST", `${CONTROL}/_test/enroll`, { body: { machine, key: passkey.key } });
  expect(r.status).toBe(201);
  return { machine, token: r.body.token as string };
}

async function signedPrompt(pk: TestPasskey, day: TestDayKey, machine: string, fields: Record<string, unknown> = {}) {
  return signCommand(pk, day, commandStr(machine, { iat: Date.now(), ...fields }));
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => vi.useRealTimers());

describe("pairing with the sink token", () => {
  it("starts, waits, is approved with a proof, hands over key, proof and token once", async () => {
    const b = await boot();
    tmpDirs.push(b.stateDir);
    try {
      const started = await call(b.url, "POST", `${CONTROL}/pair`, { bearer: SINK, body: facts });
      expect(started.status).toBe(201);
      expect(started.body.machine).toMatch(/^m_[A-Za-z0-9_-]{16,40}$/);
      expect(started.body.code).toMatch(/^[A-Za-z0-9_-]{6,32}$/);
      expect(started.body.check).toMatch(/^\d{6}$/);
      expect(started.body.url).toBe(`${b.url}/pair?code=${started.body.code}`);
      expect(Date.parse(started.body.expires_at as string)).toBeGreaterThan(Date.now() + 9 * 60_000);
      const machine = started.body.machine as string;
      const code = started.body.code as string;

      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${code}`)).status).toBe(401);
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${code}`, { bearer: "nope" })).status).toBe(401);
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=unknown00`, { bearer: SINK })).status).toBe(404);
      const pending = await call(b.url, "GET", `${CONTROL}/pair?code=${code}`, { bearer: SINK });
      expect(pending).toMatchObject({ status: 200, body: { status: "pending" } });

      // The approval page lists it and knows what the passkey must sign.
      const list = await call(b.url, "GET", `${UI}/pairings`);
      expect(list.status).toBe(200);
      const pairings = list.body.pairings as Record<string, unknown>[];
      expect(pairings).toHaveLength(1);
      expect(pairings[0]).toMatchObject({ code, check: started.body.check, status: "pending", open: false });
      expect((pairings[0]!.machine as { name: string; firstPairing: boolean }).name).toBe("mac-mini");
      expect((pairings[0]!.machine as { firstPairing: boolean }).firstPairing).toBe(true);
      const page = await call(b.url, "GET", `${UI}/pair/${code}`);
      expect(page.body.challenge).toBeTypeOf("string");

      const pk = await TestPasskey.create({ rpId: "localhost" });
      const proof = await pk.enroll(machine, code);
      const ok = await call(b.url, "POST", `${UI}/pair/${code}/approve`, {
        body: { key: pk.key, proof, name: "MacBook" },
      });
      expect(ok).toMatchObject({ status: 200, body: { ok: true, machineId: machine, firstPairing: true } });
      expect((await call(b.url, "POST", `${UI}/pair/${code}/approve`, { body: { key: pk.key, proof } })).status).toBe(
        409,
      );

      const paired = await call(b.url, "GET", `${CONTROL}/pair?code=${code}`, { bearer: SINK });
      expect(paired.status).toBe(200);
      expect(paired.body).toMatchObject({ status: "paired", key: pk.key, proof });
      expect(paired.body.token).toMatch(/^mt_/);
      expect(paired.body.sink_token).toBeUndefined();
      // Handed over once: the code answers nothing after that.
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${code}`, { bearer: SINK })).status).toBe(404);

      const token = paired.body.token as string;
      expect(
        (
          await call(b.url, "POST", `${CONTROL}/hello`, {
            bearer: token,
            body: { ...facts, keys: [pk.key.id], waiting: [] },
          })
        ).status,
      ).toBe(204);
      const m = b.control.machines().get("mac-mini");
      expect(m).toBeDefined();
      expect(m!.keys.map((k) => k.id)).toEqual([pk.key.id]);
      expect(m!.keys[0]!.name).toBe("MacBook");
      expect(m!.lastHelloAt).toBeDefined();
      expect(m!.queued).toBe(0);
      expect(b.control.wellKnown()).toMatchObject({
        wait_max_s: 25,
        open_pairing: true,
        signing: { rp_id: "localhost" },
      });
    } finally {
      await b.close();
    }
  });

  it("adding a second key is the same pairing with the machine id, and no second token", async () => {
    const b = await boot();
    tmpDirs.push(b.stateDir);
    try {
      const pk1 = await TestPasskey.create();
      const { machine } = await enrolled(b, pk1, "m_secondkey00000000001");
      const again = await call(b.url, "POST", `${CONTROL}/pair`, { bearer: SINK, body: { ...facts, machine } });
      expect(again.status).toBe(201);
      expect(again.body.machine).toBe(machine);
      const code = again.body.code as string;
      const pk2 = await TestPasskey.create();
      const ok = await call(b.url, "POST", `${UI}/pair/${code}/approve`, {
        body: { key: pk2.key, proof: await pk2.enroll(machine, code) },
      });
      expect(ok.body.firstPairing).toBe(false);
      const paired = await call(b.url, "GET", `${CONTROL}/pair?code=${code}`, { bearer: SINK });
      expect(paired.body.status).toBe("paired");
      expect(paired.body.token).toBeUndefined();
      const keys = [...b.control.machines().values()][0]!.keys.map((k) => k.id);
      expect(keys).toEqual([pk1.key.id, pk2.key.id]);
      // A forgotten machine id can't be renewed.
      expect(
        (
          await call(b.url, "POST", `${CONTROL}/pair`, {
            bearer: SINK,
            body: { ...facts, machine: "m_neverseen00000000001" },
          })
        ).status,
      ).toBe(404);
    } finally {
      await b.close();
    }
  });

  it("refuses a bad body and a wrong bearer", async () => {
    const b = await boot();
    tmpDirs.push(b.stateDir);
    try {
      expect((await call(b.url, "POST", `${CONTROL}/pair`, { bearer: SINK, body: { name: "x" } })).status).toBe(400);
      expect((await call(b.url, "POST", `${CONTROL}/pair`, { bearer: "wrong", body: facts })).status).toBe(401);
    } finally {
      await b.close();
    }
  });
});

describe("open pairing", () => {
  it("needs a poll_key, hands over sink_token and account, then 404", async () => {
    const b = await boot();
    tmpDirs.push(b.stateDir);
    try {
      expect((await call(b.url, "POST", `${CONTROL}/pair`, { body: facts })).status).toBe(401);
      const pollKey = "p".repeat(32);
      const started = await call(b.url, "POST", `${CONTROL}/pair`, { body: { ...facts, poll_key: pollKey } });
      expect(started.status).toBe(201);
      const code = started.body.code as string;
      const machine = started.body.machine as string;
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${code}`)).status).toBe(401);
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${code}`, { bearer: "q".repeat(32) })).status).toBe(401);
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${code}`, { bearer: pollKey })).body.status).toBe(
        "pending",
      );
      // The list shows where it came from.
      const list = await call(b.url, "GET", `${UI}/pairings`);
      expect((list.body.pairings as Record<string, unknown>[])[0]).toMatchObject({ open: true, fromIp: "127.0.0.1" });
      const pk = await TestPasskey.create();
      const ok = await call(b.url, "POST", `${UI}/pair/${code}/approve`, {
        body: { key: pk.key, proof: await pk.enroll(machine, code), by: "misha" },
      });
      expect(ok.status).toBe(200);
      const paired = await call(b.url, "GET", `${CONTROL}/pair?code=${code}`, { bearer: pollKey });
      expect(paired.body).toMatchObject({ status: "paired", key: pk.key, sink_token: SINK, account: "misha" });
      expect(paired.body.token).toMatch(/^mt_/);
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${code}`, { bearer: pollKey })).status).toBe(404);
    } finally {
      await b.close();
    }
  });
});

describe("renewal and expiry", () => {
  it("a renewal keeps one row and kills the old code; an unapproved code expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const b = await boot();
    tmpDirs.push(b.stateDir);
    try {
      const first = await call(b.url, "POST", `${CONTROL}/pair`, { bearer: SINK, body: facts });
      const machine = first.body.machine as string;
      const second = await call(b.url, "POST", `${CONTROL}/pair`, { bearer: SINK, body: { ...facts, machine } });
      expect(second.status).toBe(201);
      expect(second.body.machine).toBe(machine);
      expect(second.body.code).not.toBe(first.body.code);
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${first.body.code}`, { bearer: SINK })).body.status).toBe(
        "expired",
      );
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${second.body.code}`, { bearer: SINK })).body.status).toBe(
        "pending",
      );
      expect((await call(b.url, "GET", `${UI}/pairings`)).body.pairings).toHaveLength(1);
      expect(b.control.machines().size).toBe(0); // not paired yet

      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${second.body.code}`, { bearer: SINK })).body.status).toBe(
        "expired",
      );
      const pk = await TestPasskey.create();
      const late = await call(b.url, "POST", `${UI}/pair/${second.body.code}/approve`, {
        body: { key: pk.key, proof: await pk.enroll(machine, second.body.code as string) },
      });
      expect(late.status).toBe(410);
      // Renewed again from the same terminal, approved in time.
      const third = await call(b.url, "POST", `${CONTROL}/pair`, { bearer: SINK, body: { ...facts, machine } });
      const code = third.body.code as string;
      expect(
        (
          await call(b.url, "POST", `${UI}/pair/${code}/approve`, {
            body: { key: pk.key, proof: await pk.enroll(machine, code) },
          })
        ).status,
      ).toBe(200);
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${code}`, { bearer: SINK })).body.status).toBe("paired");
      expect(b.control.machines().size).toBe(1);
    } finally {
      await b.close();
    }
  });

  it("a rejected pairing answers 404 so the terminal stops", async () => {
    const b = await boot();
    tmpDirs.push(b.stateDir);
    try {
      const started = await call(b.url, "POST", `${CONTROL}/pair`, { bearer: SINK, body: facts });
      expect((await call(b.url, "POST", `${UI}/pair/${started.body.code}/reject`)).status).toBe(204);
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${started.body.code}`, { bearer: SINK })).status).toBe(
        404,
      );
    } finally {
      await b.close();
    }
  });
});

describe("the approval proof", () => {
  it("refuses a proof for another code, another machine, or another key", async () => {
    const b = await boot();
    tmpDirs.push(b.stateDir);
    try {
      const started = await call(b.url, "POST", `${CONTROL}/pair`, { bearer: SINK, body: facts });
      const machine = started.body.machine as string;
      const code = started.body.code as string;
      const pk = await TestPasskey.create();
      const other = await TestPasskey.create();
      const approve = (body: unknown) => call(b.url, "POST", `${UI}/pair/${code}/approve`, { body });
      expect((await approve({ key: pk.key, proof: await pk.enroll(machine, "AAAA-BBBB") })).status).toBe(422);
      expect((await approve({ key: pk.key, proof: await pk.enroll("m_anothermachine00000001", code) })).status).toBe(
        422,
      );
      expect((await approve({ key: other.key, proof: await pk.enroll(machine, code) })).status).toBe(422);
      expect((await approve({ key: pk.key, proof: await pk.enroll(machine, code, { flags: 0x01 }) })).status).toBe(422);
      expect(
        (await approve({ key: pk.key, proof: await pk.enroll(machine, code, { origin: "https://evil.example" }) }))
          .status,
      ).toBe(422);
      expect((await approve({ key: pk.key })).status).toBe(400);
      expect((await approve({ key: { ...pk.key, alg: -8 }, proof: await pk.enroll(machine, code) })).status).toBe(400);
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=${code}`, { bearer: SINK })).body.status).toBe("pending");
      expect((await approve({ key: pk.key, proof: await pk.enroll(machine, code) })).status).toBe(200);
    } finally {
      await b.close();
    }
  });

  it("agrees with the enrollment vectors' shape of refusal (rp id receiver.example)", async () => {
    const b = await boot({ rpId: "receiver.example" });
    tmpDirs.push(b.stateDir);
    try {
      const started = await call(b.url, "POST", `${CONTROL}/pair`, { bearer: SINK, body: facts });
      const machine = started.body.machine as string;
      const code = started.body.code as string;
      const pk = await TestPasskey.create({ rpId: "receiver.example" });
      // A localhost-origin assertion is not good enough for a real rp id.
      const http = await pk.enroll(machine, code, { origin: "http://receiver.example" });
      expect(
        (await call(b.url, "POST", `${UI}/pair/${code}/approve`, { body: { key: pk.key, proof: http } })).status,
      ).toBe(422);
      expect(
        (
          await call(b.url, "POST", `${UI}/pair/${code}/approve`, {
            body: { key: pk.key, proof: await pk.enroll(machine, code) },
          })
        ).status,
      ).toBe(200);
    } finally {
      await b.close();
    }
  });
});

describe("machine-token isolation", () => {
  it("a sink token is refused on machine calls; a machine token everywhere else; one machine's token only for itself", async () => {
    const b = await boot();
    tmpDirs.push(b.stateDir);
    try {
      const pk = await TestPasskey.create();
      const a = await enrolled(b, pk, "m_isolationa0000000001");
      const c = await enrolled(b, pk, "m_isolationb0000000001");
      for (const p of [`${CONTROL}/hello`, `${CONTROL}/ack`, `${CONTROL}/off`])
        expect((await call(b.url, "POST", p, { bearer: SINK, body: {} })).status, p).toBe(401);
      expect((await call(b.url, "GET", `${CONTROL}?machine=${a.machine}&wait=0`, { bearer: SINK })).status).toBe(401);
      expect((await call(b.url, "GET", `${CONTROL}?machine=${a.machine}&wait=0`)).status).toBe(401);
      expect((await call(b.url, "GET", `${CONTROL}?machine=${a.machine}&wait=0`, { bearer: c.token })).status).toBe(
        401,
      );
      expect((await call(b.url, "GET", `${CONTROL}?machine=nope&wait=0`, { bearer: a.token })).status).toBe(400);
      expect((await call(b.url, "POST", `${CONTROL}/pair`, { bearer: a.token, body: facts })).status).toBe(401);
      expect((await call(b.url, "GET", `${CONTROL}/pair?code=whatever`, { bearer: a.token })).status).toBe(404);
      expect((await call(b.url, "GET", `${CONTROL}?machine=${a.machine}&wait=0`, { bearer: a.token })).status).toBe(
        204,
      );
      expect((await call(b.url, "POST", `${CONTROL}/hello`, { bearer: a.token, body: facts })).status).toBe(204);
      expect((await call(b.url, "POST", `${CONTROL}/hello`, { bearer: a.token, body: { nope: 1 } })).status).toBe(400);
    } finally {
      await b.close();
    }
  });

  it("the UI routes need the UI's auth; the test door is loopback-only and off by default", async () => {
    const closed = await boot({ uiAuth: false, testDoor: false });
    tmpDirs.push(closed.stateDir);
    try {
      expect((await call(closed.url, "GET", `${UI}/machines`)).status).toBe(401);
      expect((await call(closed.url, "GET", `${UI}/activity`)).status).toBe(401);
      expect((await call(closed.url, "POST", `${UI}/send`, { body: {} })).status).toBe(401);
      expect(
        (await call(closed.url, "POST", `${CONTROL}/_test/enroll`, { body: { machine: "m_door00000000000001" } }))
          .status,
      ).toBe(404);
    } finally {
      await closed.close();
    }
  });
});

describe("the queue", () => {
  let b: Booted;
  let pk: TestPasskey;
  let day: TestDayKey;
  beforeAll(async () => {
    b = await boot();
    tmpDirs.push(b.stateDir);
    pk = await TestPasskey.create();
    day = await TestDayKey.create();
  });
  afterAll(() => b.close());

  const send = (machine: string, signed: unknown, extra: Record<string, unknown> = {}) =>
    call(b.url, "POST", `${UI}/send`, { body: { machineId: machine, ...(signed as object), ...extra } });
  const poll = (m: { machine: string; token: string }, wait = 0) =>
    call(b.url, "GET", `${CONTROL}?machine=${m.machine}&wait=${wait}`, { bearer: m.token });
  const ack = (m: { token: string }, acks: Record<string, unknown>[]) =>
    call(b.url, "POST", `${CONTROL}/ack`, {
      bearer: m.token,
      body: { acks: acks.map((a) => ({ at: new Date().toISOString(), ...a })) },
    });

  it("a signed command is queued, carried byte for byte, redelivered until acked, then gone", async () => {
    const m = await enrolled(b, pk, "m_queue000000000000001");
    const signed = await signedPrompt(pk, day, m.machine, { text: "ship it" });
    const seen: StreamMessage[] = [];
    const off = b.control.subscribe((x) => seen.push(x));
    const queued = await send(m.machine, signed);
    expect(queued.status).toBe(201);
    expect(queued.body).toMatchObject({
      machineId: m.machine,
      kind: "prompt",
      text: "ship it",
      session: "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e",
    });
    expect(queued.body.outcome).toBeUndefined();
    expect(Date.parse(queued.body.expiresAt as string) - Date.now()).toBeLessThanOrEqual(3600_000);
    expect(b.control.machines().get("conformance")?.queued).toBe(1);

    const first = await poll(m);
    expect(first.status).toBe(200);
    expect(first.body.messages).toHaveLength(1);
    const w = first.body.messages![0]!;
    expect(w.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(w.cmd).toBe(signed.cmd);
    expect(w.csig).toBe(signed.csig);
    expect(w.grant).toEqual(signed.grant);
    expect(w.at).toBe(queued.body.at);
    expect(w.expires_at).toBe(queued.body.expiresAt);
    const second = await poll(m);
    expect(second.body.messages![0]!.id).toBe(w.id);

    const r = await ack(m, [{ id: w.id, outcome: "delivered", mode: "waiter", reply: "done" }]);
    expect(r).toMatchObject({ status: 202, body: { applied: 1, unknown: 0 } });
    expect((await poll(m)).status).toBe(204);
    const act = b.control.activity().find((a) => a.id === w.id)!;
    expect(act).toMatchObject({ outcome: "delivered", mode: "waiter", reply: "done" });
    expect(act.ackedAt).toBeDefined();
    expect(JSON.stringify(act)).not.toContain(signed.csig);
    off();
    // Only the command's own frames: a machine's poll state is sent 300 ms after a poll
    // (server/control/index.ts), so on a slow runner one can land inside this window.
    const outcomes = seen.flatMap((s) => (s.kind === "control" ? [s.message.outcome] : []));
    expect(outcomes).toEqual([undefined, "delivered"]);
    const ui = await call(b.url, "GET", `${UI}/activity?limit=5`);
    expect((ui.body.activity as { id: string }[]).some((a) => a.id === w.id)).toBe(true);
  });

  it("a confirm-signed command and a permission answer go through too", async () => {
    const m = await enrolled(b, pk, "m_queueconfirm00000001");
    const c = await signCommand(pk, day, commandStr(m.machine, { iat: Date.now(), text: "confirmed" }), {
      confirm: true,
    });
    expect((await send(m.machine, c)).status).toBe(201);
    const pa = await signedPrompt(pk, day, m.machine, {
      kind: "permission.answer",
      text: undefined,
      for: "perm-1",
      decision: "deny",
      note: "not on main",
    });
    const r = await send(m.machine, pa);
    expect(r.status).toBe(201);
    expect(r.body.text).toBe("deny: not on main");
    expect((await poll(m)).body.messages).toHaveLength(2);
  });

  it("the long-poll wakes on enqueue and times out with 204", async () => {
    const m = await enrolled(b, pk, "m_longpoll000000000001");
    const t0 = Date.now();
    expect((await poll(m, 1)).status).toBe(204);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    const parked = poll(m, 10);
    await new Promise((r) => setTimeout(r, 100));
    await send(m.machine, await signedPrompt(pk, day, m.machine));
    const t1 = Date.now();
    const got = await parked;
    expect(got.status).toBe(200);
    expect(Date.now() - t1).toBeLessThan(2000);
    expect(b.control.machines().get("conformance")?.online).toBe(true);
    // The poll is clamped to wait_max_s and a garbage wait is the maximum.
    expect((await poll(m, 0)).status).toBe(200);
  });

  it("taken pauses redelivery 35 minutes; progress keeps the highest seq; finals end it; duplicates are fine", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const m = await enrolled(b, pk, "m_takenpause0000000001");
    await send(m.machine, await signedPrompt(pk, day, m.machine, { text: "long job" }));
    const id = (await poll(m)).body.messages![0]!.id as string;
    expect((await ack(m, [{ id, outcome: "taken", mode: "resume" }])).status).toBe(202);
    expect((await poll(m)).status).toBe(204);
    expect(b.control.activity().find((a) => a.id === id)).toMatchObject({ outcome: "taken", mode: "resume" });
    expect(b.control.machines().get("conformance")?.queued).toBe(1);
    await ack(m, [{ id, outcome: "progress", reply: "Work", seq: 1 }]);
    await ack(m, [{ id, outcome: "progress", reply: "Working on", seq: 3 }]);
    await ack(m, [{ id, outcome: "progress", reply: "stale", seq: 2 }]);
    expect(b.control.activity().find((a) => a.id === id)).toMatchObject({
      outcome: "taken",
      reply: "Working on",
      replySeq: 3,
    });
    vi.setSystemTime(Date.now() + 36 * 60_000);
    const again = await poll(m);
    expect(again.status).toBe(200);
    expect(again.body.messages![0]!.id).toBe(id);
    const fin = await ack(m, [{ id, outcome: "delivered", mode: "resume", reply: "Working on it. Done." }]);
    expect(fin.body).toEqual({ applied: 1, unknown: 0 });
    const dup = await ack(m, [{ id, outcome: "delivered", mode: "resume" }]);
    expect(dup).toMatchObject({ status: 202, body: { applied: 1, unknown: 0 } });
    expect((await ack(m, [{ id, outcome: "progress", reply: "late", seq: 9 }])).status).toBe(202);
    expect(b.control.activity().find((a) => a.id === id)).toMatchObject({
      outcome: "delivered",
      reply: "Working on it. Done.",
      replySeq: 3,
    });
    expect((await poll(m)).status).toBe(204);
    // A final ack for an id we never carried is still 202.
    const unknown = await ack(m, [{ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", outcome: "refused", code: "replay" }]);
    expect(unknown).toMatchObject({ status: 202, body: { applied: 0, unknown: 1 } });
    // An ack that breaks the schema is dropped, not guessed at; a body with none is 400.
    expect(await ack(m, [{ id: "bad", outcome: "delivered" }])).toMatchObject({
      status: 202,
      body: { applied: 0, unknown: 0 },
    });
    expect((await ack(m, [])).status).toBe(400);
    expect((await call(b.url, "POST", `${CONTROL}/ack`, { bearer: m.token, body: { nope: 1 } })).status).toBe(400);
  });

  it("a message expires at expires_at and is never handed out after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const m = await enrolled(b, pk, "m_expiry00000000000001");
    const r = await send(m.machine, await signedPrompt(pk, day, m.machine), { expires_in_s: 2 });
    expect(Date.parse(r.body.expiresAt as string) - Date.parse(r.body.at as string)).toBe(2000);
    const capped = await send(m.machine, await signedPrompt(pk, day, m.machine), { expires_in_s: 99 * 3600 });
    expect(Date.parse(capped.body.expiresAt as string) - Date.parse(capped.body.at as string)).toBe(24 * 3600_000);
    vi.setSystemTime(Date.now() + 3000);
    const got = await poll(m);
    expect(got.body.messages!.map((x) => x.id)).toEqual([capped.body.id]);
    expect(b.control.activity().find((a) => a.id === r.body.id)).toMatchObject({ outcome: "expired" });
    // A late final ack for it is tolerated and changes nothing.
    await ack(m, [{ id: r.body.id as string, outcome: "delivered" }]);
    expect(b.control.activity().find((a) => a.id === r.body.id)?.outcome).toBe("expired");
  });

  it("off removes the machine, its token and its queue; forget does the same locally", async () => {
    const m = await enrolled(b, pk, "m_off00000000000000001");
    await send(m.machine, await signedPrompt(pk, day, m.machine));
    expect((await call(b.url, "POST", `${CONTROL}/off`, { bearer: m.token })).status).toBe(204);
    expect((await poll(m)).status).toBe(401);
    expect((await call(b.url, "POST", `${CONTROL}/off`, { bearer: m.token })).status).toBe(401);
    expect(b.control.activity().some((a) => a.machineId === m.machine)).toBe(false);
    expect([...b.control.machines().values()].some((x) => x.machineId === m.machine)).toBe(false);

    const f = await enrolled(b, pk, "m_forget00000000000001");
    expect((await call(b.url, "POST", `${UI}/machines/${f.machine}/forget`)).status).toBe(204);
    expect((await call(b.url, "POST", `${UI}/machines/${f.machine}/forget`)).status).toBe(404);
    expect((await poll(f)).status).toBe(401);
    expect((await call(b.url, "GET", `${UI}/machines`)).body.machines).not.toContainEqual(
      expect.objectContaining({ machineId: f.machine }),
    );
  });

  it("send refuses what the verifier refuses, with its code", async () => {
    const m = await enrolled(b, pk, "m_refuse00000000000001");
    const other = await TestPasskey.create();
    const bad = await signedPrompt(other, day, m.machine);
    expect(await send(m.machine, bad)).toMatchObject({ status: 422, body: { code: "untrusted_key" } });
    const good = await signedPrompt(pk, day, m.machine);
    expect(await send(m.machine, { cmd: good.cmd })).toMatchObject({ status: 422, body: { code: "unsigned" } });
    expect(await send(m.machine, { ...good, cmd: good.cmd.replace("Oct 8", "Oct 9") })).toMatchObject({
      status: 422,
      body: { code: "bad_csig" },
    });
    expect(await send("m_unknownmachine000001", good)).toMatchObject({ status: 404 });
    expect((await send(m.machine, { cmd: 5 })).status).toBe(400);
    const sess = await signedPrompt(pk, day, m.machine, { session: "claude-code:not-a-uuid" });
    expect(await send(m.machine, sess)).toMatchObject({ status: 422, body: { code: "bad_session" } });
  });
});

describe("device requests: a trusted device vouches for a phone's passkey (key.add)", () => {
  let b: Booted;
  let mac: TestPasskey;
  let day: TestDayKey;
  let phone: TestPasskey;
  beforeAll(async () => {
    b = await boot();
    tmpDirs.push(b.stateDir);
    mac = await TestPasskey.create();
    day = await TestDayKey.create();
    phone = await TestPasskey.create();
  });
  afterAll(() => b.close());

  const create = (body: unknown, ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)") =>
    fetch(`${b.url}${UI}/devices`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": ua },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }));

  it("creates a request with six digits, lists it, and refuses bad bodies", async () => {
    const r = await create({ key: phone.key, name: "Misha's iPhone" });
    expect(r.status).toBe(201);
    expect(r.body.requestId).toMatch(/^d_[A-Za-z0-9_-]{16}$/);
    expect(r.body.check).toMatch(/^\d{6}$/);
    expect(r.body).toMatchObject({
      status: "pending",
      name: "Misha's iPhone",
      device: "iPhone",
      fromIp: "127.0.0.1",
      key: phone.key,
    });
    expect(Date.parse(r.body.expiresAt as string) - Date.now()).toBeGreaterThan(9 * 60_000);

    const list = await call(b.url, "GET", `${UI}/devices`);
    expect(list.status).toBe(200);
    expect((list.body.devices as { requestId: string }[]).map((d) => d.requestId)).toEqual([r.body.requestId]);
    const one = await call(b.url, "GET", `${UI}/devices/${r.body.requestId}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ requestId: r.body.requestId, check: r.body.check, status: "pending" });
    expect((await call(b.url, "GET", `${UI}/devices/d_nope`)).status).toBe(404);

    // A name is optional and falls back to the device label.
    const unnamed = await create({ key: (await TestPasskey.create()).key }, "Mozilla/5.0 (Linux; Android 15)");
    expect(unnamed.status).toBe(201);
    expect(unnamed.body.name).toBe("Android phone");

    expect((await create({})).status).toBe(400);
    expect((await create({ key: { ...phone.key, alg: -8 } })).status).toBe(400);
    expect((await create({ key: { ...phone.key, id: "not base64url!" } })).status).toBe(400);
    expect((await create({ key: { ...phone.key, spki: "short" } })).status).toBe(400);
    expect((await create({ key: phone.key, name: "x".repeat(41) })).status).toBe(400);
    expect((await create({ key: phone.key, name: 7 })).status).toBe(400);
    const unusable = await create({ key: { ...phone.key, spki: "A".repeat(64) } });
    expect(unusable).toMatchObject({ status: 422, body: { reason: "bad_key" } });

    // Asking again from the same phone renews the request: one live row per key.
    const again = await create({ key: phone.key, name: "Misha's iPhone" });
    expect(again.status).toBe(201);
    expect((await call(b.url, "GET", `${UI}/devices/${r.body.requestId}`)).status).toBe(404);
    const now = await call(b.url, "GET", `${UI}/devices`);
    expect((now.body.devices as unknown[]).length).toBe(2);
  });

  it("a key.add from a trusted device moves it to sent; the machine's delivered ack adds the key", async () => {
    const m = await enrolled(b, mac, "m_devices000000000001");
    const req = await create({ key: phone.key, name: "Misha's iPhone" });
    const id = req.body.requestId as string;

    // The Mac signs key.add with its day grant and sends it like any command.
    const cmd = commandStr(m.machine, {
      kind: "key.add",
      session: "sessionpipe:keys",
      text: undefined,
      key: phone.key,
      name: "Misha's iPhone",
    });
    const sent = await call(b.url, "POST", `${UI}/send`, {
      body: { machineId: m.machine, ...(await signCommand(mac, day, cmd)) },
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ kind: "key.add", session: "sessionpipe:keys", text: "trust Misha's iPhone" });
    const activityId = sent.body.id as string;
    expect(await call(b.url, "GET", `${UI}/devices/${id}`)).toMatchObject({
      status: 200,
      body: { status: "sent", machineId: m.machine, activityId },
    });
    // Still listed for the approving page while the machine has not answered.
    expect((await call(b.url, "GET", `${UI}/devices`)).body.devices).toContainEqual(
      expect.objectContaining({ requestId: id, status: "sent" }),
    );

    // The daemon polls it, byte for byte, and acks delivered.
    const polled = await call(b.url, "GET", `${CONTROL}?machine=${m.machine}&wait=0`, { bearer: m.token });
    expect(polled.status).toBe(200);
    const w = polled.body.messages![0]!;
    expect(w.id).toBe(activityId);
    expect(JSON.parse(w.cmd as string)).toMatchObject({ kind: "key.add", session: "sessionpipe:keys", key: phone.key });
    const before = (await call(b.url, "GET", `${UI}/machines`)).body.machines as { keys: { id: string }[] }[];
    expect(before[0]!.keys.map((k) => k.id)).toEqual([mac.key.id]);
    const acked = await call(b.url, "POST", `${CONTROL}/ack`, {
      bearer: m.token,
      body: { acks: [{ id: activityId, outcome: "delivered", at: new Date().toISOString(), mode: "sdk" }] },
    });
    expect(acked.status).toBe(202);

    expect((await call(b.url, "GET", `${UI}/devices/${id}`)).body.status).toBe("added");
    expect((await call(b.url, "GET", `${UI}/devices`)).body.devices).not.toContainEqual(
      expect.objectContaining({ requestId: id }),
    );
    const after = (await call(b.url, "GET", `${UI}/machines`)).body.machines as {
      keys: { id: string; name?: string }[];
    }[];
    expect(after[0]!.keys.map((k) => k.id)).toEqual([mac.key.id, phone.key.id]);
    expect(after[0]!.keys[1]!.name).toBe("Misha's iPhone");

    // The phone's own passkey now signs commands the receiver's early check accepts.
    const phoneDay = await TestDayKey.create();
    const fromPhone = await call(b.url, "POST", `${UI}/send`, {
      body: {
        machineId: m.machine,
        ...(await signCommand(phone, phoneDay, commandStr(m.machine, { iat: Date.now(), text: "from the phone" }))),
      },
    });
    expect(fromPhone.status).toBe(201);
  });

  it("a refused key.add fails the request with the machine's code", async () => {
    const m = await enrolled(b, mac, "m_devices000000000002");
    const key = (await TestPasskey.create()).key;
    const req = await create({ key, name: "Tablet" });
    const cmd = commandStr(m.machine, { kind: "key.add", session: "sessionpipe:keys", text: undefined, key });
    const sent = await call(b.url, "POST", `${UI}/send`, {
      body: { machineId: m.machine, ...(await signCommand(mac, day, cmd)) },
    });
    expect(sent.status).toBe(201);
    await call(b.url, "POST", `${CONTROL}/ack`, {
      bearer: m.token,
      body: {
        acks: [{ id: sent.body.id, outcome: "refused", code: "untrusted_key", at: new Date().toISOString() }],
      },
    });
    const d = await call(b.url, "GET", `${UI}/devices/${req.body.requestId}`);
    expect(d.body).toMatchObject({ status: "failed", outcome: "refused", code: "untrusted_key" });
    const machines = (await call(b.url, "GET", `${UI}/machines`)).body.machines as {
      machineId: string;
      keys: unknown[];
    }[];
    expect(machines.find((x) => x.machineId === m.machine)!.keys).toHaveLength(1);
  });

  it("a request expires after ten minutes and a rejected one is gone at once", async () => {
    const rejected = await create({ key: (await TestPasskey.create()).key });
    expect((await call(b.url, "POST", `${UI}/devices/${rejected.body.requestId}/reject`)).status).toBe(204);
    expect((await call(b.url, "GET", `${UI}/devices/${rejected.body.requestId}`)).status).toBe(404);
    expect((await call(b.url, "POST", `${UI}/devices/${rejected.body.requestId}/reject`)).status).toBe(404);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const waiting = await create({ key: (await TestPasskey.create()).key });
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect((await call(b.url, "GET", `${UI}/devices/${waiting.body.requestId}`)).body.status).toBe("expired");
      expect((await call(b.url, "GET", `${UI}/devices`)).body.devices).not.toContainEqual(
        expect.objectContaining({ requestId: waiting.body.requestId }),
      );
      vi.setSystemTime(Date.now() + 61 * 60_000);
      expect((await call(b.url, "GET", `${UI}/devices/${waiting.body.requestId}`)).status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the device routes need the UI's auth", async () => {
    const locked = await boot({ uiAuth: false });
    tmpDirs.push(locked.stateDir);
    try {
      expect((await call(locked.url, "GET", `${UI}/devices`)).status).toBe(401);
      expect((await call(locked.url, "POST", `${UI}/devices`, { body: { key: phone.key } })).status).toBe(401);
    } finally {
      await locked.close();
    }
  });
});

describe("device keys off: this receiver's core can't verify one (sessionpipe-core today)", () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot({ deviceKeys: false });
    tmpDirs.push(b.stateDir);
  });
  afterAll(() => b.close());

  it("the core decides: device keys only with a core that exports deviceMessage", () => {
    expect(coreTakesDevice({})).toBe(false);
    expect(coreTakesDevice({ deviceMessage: () => new Uint8Array() })).toBe(true);
    expect(receiverKeyTypes(false)).toEqual(["passkey"]);
    expect(receiverKeyTypes(true)).toEqual(["passkey", "device"]);
  });

  it("passkeys only: the well-known has no key_types, and the page reads passkey", () => {
    expect(b.control.keyTypes).toEqual(["passkey"]);
    expect(b.control.wellKnown().signing).toEqual({ rp_id: "localhost", algs: [-7, -257] });
  });

  it("readKey and readProof take the passkey shapes only", async () => {
    const dev = await TestDeviceKey.create();
    const pk = await TestPasskey.create();
    expect(readKey(dev.key, false)).toBeNull();
    expect(readKey(pk.key, false)).toEqual(pk.key);
    expect(readProof(await dev.sign("pair", new Uint8Array(32)), false)).toBeNull();
    const a = await pk.assert(new Uint8Array(32));
    expect(readProof(a, false)).toEqual(a);
  });

  it("a machine offering device keys still pairs with a passkey; a device key is a 400", async () => {
    // A daemon that says key_types (sessionpipe with device keys) on a receiver that can't check them.
    const started = await call(b.url, "POST", `${CONTROL}/pair`, {
      bearer: SINK,
      body: { ...facts, key_types: ["passkey", "device"] },
    });
    const machine = started.body.machine as string;
    const code = started.body.code as string;
    const dev = await TestDeviceKey.create({ rpId: "localhost" });
    const refused = await call(b.url, "POST", `${UI}/pair/${code}/approve`, {
      body: { key: dev.key, proof: await dev.enroll(machine, code) },
    });
    expect(refused).toMatchObject({ status: 400, body: { reason: "bad_request" } });
    expect(refused.body.error).toBe("Send { key: {id, alg, spki}, proof: {cred, ad, cd, sig} }.");
    const pk = await TestPasskey.create();
    const ok = await call(b.url, "POST", `${UI}/pair/${code}/approve`, {
      body: { key: pk.key, proof: await pk.enroll(machine, code) },
    });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, keyId: pk.key.id } });
  });

  it("a 0.9 or 0.10 daemon's hello (no key_types) leaves keyTypes unset: the page offers it no device key", async () => {
    const pk = await TestPasskey.create();
    const m = await enrolled(b, pk, "m_devicekeysoff0000001");
    await call(b.url, "POST", `${CONTROL}/hello`, { bearer: m.token, body: facts });
    const ms = (await call(b.url, "GET", `${UI}/machines`)).body.machines as {
      machineId: string;
      keyTypes?: string[];
    }[];
    expect(ms.find((x) => x.machineId === m.machine)).toBeDefined();
    expect(ms.find((x) => x.machineId === m.machine)!.keyTypes).toBeUndefined();
  });

  it("/devices takes a passkey and refuses a device key; the door has no device key", async () => {
    const dev = await TestDeviceKey.create();
    const pk = await TestPasskey.create();
    expect((await call(b.url, "POST", `${UI}/devices`, { body: { key: dev.key } })).status).toBe(400);
    expect((await call(b.url, "POST", `${UI}/devices`, { body: { key: pk.key, name: "phone" } })).status).toBe(201);
    for (const route of ["key", "sign", "pair"])
      expect((await call(b.url, "POST", `${CONTROL}/_test/device/${route}`, { body: {} })).status).toBe(404);
  });
});

// The device-key path itself needs a core that verifies device keys (sessionpipe
// mp/native-keys); with today's core it is off (above) and these are skipped.
describe.skipIf(!coreTakesDevice())("device keys: the native app's key, carried whole (CONTROL.md §2, §3.2)", () => {
  let b: Booted;
  beforeAll(async () => {
    b = await boot();
    tmpDirs.push(b.stateDir);
  });
  afterAll(() => b.close());

  it("the well-known says the receiver stores and carries device keys", () => {
    expect(b.control.wellKnown().signing).toEqual({
      rp_id: "localhost",
      algs: [-7, -257],
      key_types: ["passkey", "device"],
    });
  });

  it("readKey and readProof: the two shapes, closed", async () => {
    const dev = await TestDeviceKey.create();
    const pk = await TestPasskey.create();
    expect(readKey(dev.key, true)).toEqual(dev.key);
    expect(readKey(pk.key, true)).toEqual(pk.key);
    expect(readKey({ ...pk.key, name: "x" }, true)).toBeNull();
    expect(readKey({ ...dev.key, attestation: "none" }, true)).toBeNull();
    expect(readKey({ ...pk.key, store: "hardware" }, true)).toBeNull(); // a passkey has no store
    // The values are core's to judge (keyUsable), not the shape's.
    expect(readKey({ ...dev.key, store: "software" }, true)).toMatchObject({ store: "software" });
    const sig = await dev.sign("pair", new Uint8Array(32));
    expect(readProof(sig, true)).toEqual(sig);
    const a = await pk.assert(new Uint8Array(32));
    expect(readProof(a, true)).toEqual(a);
    expect(readProof({ ...sig, extra: 1 }, true)).toBeNull();
    expect(readProof({ cred: sig.cred }, true)).toBeNull();
  });

  it("a pairing approved with a device key: a {cred, sig} proof, and the paired answer carries the whole key", async () => {
    const started = await call(b.url, "POST", `${CONTROL}/pair`, {
      bearer: SINK,
      body: { ...facts, key_types: ["passkey", "device"] },
    });
    const machine = started.body.machine as string;
    const code = started.body.code as string;
    const dev = await TestDeviceKey.create({ rpId: "localhost" });
    // A proof for another purpose, or another rp id, is refused here as on the machine.
    for (const o of [{ purpose: "confirm" as const }, { rpId: "evil.example" }]) {
      const bad = await dev.sign(
        "pair",
        await (await import("sessionpipe-core/control")).pairChallenge(machine, code),
        o,
      );
      const r = await call(b.url, "POST", `${UI}/pair/${code}/approve`, { body: { key: dev.key, proof: bad } });
      expect(r).toMatchObject({ status: 422, body: { reason: "bad_proof" } });
    }
    const soft = await call(b.url, "POST", `${UI}/pair/${code}/approve`, {
      body: { key: { ...dev.key, store: "software" }, proof: await dev.enroll(machine, code) },
    });
    expect(soft).toMatchObject({ status: 422, body: { reason: "bad_key" } });
    const ok = await call(b.url, "POST", `${UI}/pair/${code}/approve`, {
      body: { key: dev.key, proof: await dev.enroll(machine, code), name: "Mac app" },
    });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, keyId: dev.key.id } });
    const paired = await call(b.url, "GET", `${CONTROL}/pair?code=${code}`, { bearer: SINK });
    expect(paired.body.key).toEqual(dev.key);
    expect(paired.body.proof).toEqual({ cred: dev.key.id, sig: expect.any(String) });
    // The machine row says what it takes and which key is a device key.
    const ms = (await call(b.url, "GET", `${UI}/machines`)).body.machines as {
      machineId: string;
      keyTypes?: string[];
      keys: { id: string; type?: string }[];
    }[];
    const row = ms.find((x) => x.machineId === machine)!;
    expect(row.keyTypes).toEqual(["passkey", "device"]);
    expect(row.keys).toEqual([expect.objectContaining({ id: dev.key.id, type: "device" })]);
    // A hello without key_types (a downgraded daemon) takes it away again.
    await call(b.url, "POST", `${CONTROL}/hello`, { bearer: paired.body.token as string, body: facts });
    const after = (await call(b.url, "GET", `${UI}/machines`)).body.machines as {
      machineId: string;
      keyTypes?: string[];
    }[];
    expect(after.find((x) => x.machineId === machine)!.keyTypes).toBeUndefined();
  });

  it("/devices takes a device key, and a key.add for it is mirrored whole once delivered; its grant then verifies", async () => {
    const mac = await TestPasskey.create();
    const day = await TestDayKey.create();
    const m = await enrolled(b, mac, "m_devicekeys000000001");
    const app = await TestDeviceKey.create({ rpId: "localhost" });
    const create = (body: unknown) =>
      fetch(`${b.url}${UI}/devices`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }));
    expect((await create({ key: { ...app.key, extra: true } })).status).toBe(400);
    for (const bad of [{ store: "software" }, { uv: "once" }, { id: mac.key.id }, { type: "tpm" }])
      expect(await create({ key: { ...app.key, ...bad } })).toMatchObject({ status: 422, body: { reason: "bad_key" } });
    const req = await create({ key: app.key, name: "Mac app" });
    expect(req).toMatchObject({ status: 201, body: { key: app.key, device: "Mac" } });

    const cmd = commandStr(m.machine, {
      kind: "key.add",
      session: "sessionpipe:keys",
      text: undefined,
      key: app.key,
      name: "Mac app",
    });
    const sent = await call(b.url, "POST", `${UI}/send`, {
      body: { machineId: m.machine, ...(await signCommand(mac, day, cmd)) },
    });
    expect(sent.status).toBe(201);
    // Before the machine's word, the app's grant is not trusted here either.
    const early = await call(b.url, "POST", `${UI}/send`, {
      body: {
        machineId: m.machine,
        ...(await signWithDevice(app, await TestDayKey.create(), commandStr(m.machine, { iat: Date.now() }))),
      },
    });
    expect(early).toMatchObject({ status: 422, body: { code: "untrusted_key" } });
    await call(b.url, "POST", `${CONTROL}/ack`, {
      bearer: m.token,
      body: { acks: [{ id: sent.body.id, outcome: "delivered", at: new Date().toISOString(), mode: "sdk" }] },
    });
    expect((await call(b.url, "GET", `${UI}/devices/${req.body.requestId}`)).body.status).toBe("added");
    const ms = (await call(b.url, "GET", `${UI}/machines`)).body.machines as {
      machineId: string;
      keys: { id: string; type?: string }[];
    }[];
    expect(ms.find((x) => x.machineId === m.machine)!.keys.find((k) => k.id === app.key.id)).toMatchObject({
      type: "device",
    });
    const appDay = await TestDayKey.create();
    for (const confirm of [false, true]) {
      const r = await call(b.url, "POST", `${UI}/send`, {
        body: {
          machineId: m.machine,
          ...(await signWithDevice(app, appDay, commandStr(m.machine, { iat: Date.now(), text: "from the app" }), {
            confirm,
          })),
        },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    // The same signature counts for no other use: a grant signed as a confirm is refused.
    const c = commandStr(m.machine, { iat: Date.now() });
    const wrong = { cmd: c, confirm: await app.sign("confirm", await sha256(c), { purpose: "grant" }) };
    expect(await call(b.url, "POST", `${UI}/send`, { body: { machineId: m.machine, ...wrong } })).toMatchObject({
      status: 422,
      body: { code: "bad_assertion" },
    });
    // The mirrored key is kept whole on disk, so a restart verifies it as a device key too.
    const file = JSON.parse(readFileSync(path.join(b.stateDir, "control", "machines.json"), "utf8")) as {
      machines: { id: string; keys: Record<string, unknown>[] }[];
    };
    const stored = file.machines.find((x) => x.id === m.machine)!.keys.find((k) => k.id === app.key.id);
    expect(stored).toMatchObject({ ...app.key, name: "Mac app" });
  });

  it("the test door plays the app's signer: key, sign (grant or confirm) and pair, loopback only", async () => {
    const key = await call(b.url, "POST", `${CONTROL}/_test/device/key`, { body: {} });
    expect(key.status).toBe(200);
    expect(key.body.key).toMatchObject({ type: "device", store: "hardware", uv: "each-use", alg: -7 });
    const m = await call(b.url, "POST", `${CONTROL}/_test/enroll`, {
      body: { machine: "m_doordevice0000000001", key: key.body.key },
    });
    expect(m.status).toBe(201);
    const cmd = commandStr("m_doordevice0000000001", { iat: Date.now() });
    for (const mode of ["grant", "confirm"]) {
      const signed = await call(b.url, "POST", `${CONTROL}/_test/device/sign`, { body: { cmd, mode } });
      expect(signed.status).toBe(200);
      expect(signed.body.cmd).toBe(cmd);
      const r = await call(b.url, "POST", `${UI}/send`, {
        body: { machineId: "m_doordevice0000000001", ...signed.body },
      });
      if (mode === "grant") expect(r.status, JSON.stringify(r.body)).toBe(201);
      else expect(r.body.code ?? "ok").toMatch(/ok|replay/);
    }
    expect((await call(b.url, "POST", `${CONTROL}/_test/device/sign`, { body: { cmd, mode: "x" } })).status).toBe(400);
    expect((await call(b.url, "POST", `${CONTROL}/_test/device/pair`, { body: { code: "nope00" } })).status).toBe(404);
  });
});

describe("persistence", () => {
  it("machines, keys, tokens and the queue survive a restart", async () => {
    const b = await boot();
    tmpDirs.push(b.stateDir);
    const pk = await TestPasskey.create();
    const day = await TestDayKey.create();
    const m = await enrolled(b, pk, "m_persist0000000000001");
    const sent = await call(b.url, "POST", `${UI}/send`, {
      body: { machineId: m.machine, ...(await signedPrompt(pk, day, m.machine)) },
    });
    expect(sent.status).toBe(201);
    await b.close();
    const files = readFileSync(path.join(b.stateDir, "control", "machines.json"), "utf8");
    expect(files).not.toContain(m.token);
    const b2 = await boot({ stateDir: b.stateDir });
    try {
      const got = await call(b2.url, "GET", `${CONTROL}?machine=${m.machine}&wait=0`, { bearer: m.token });
      expect(got.status).toBe(200);
      expect(got.body.messages![0]!.id).toBe(sent.body.id);
      expect(
        b2.control
          .machines()
          .get("conformance")
          ?.keys.map((k) => k.id),
      ).toEqual([pk.key.id]);
    } finally {
      await b2.close();
    }
  });
});

// --- a start's options and files (CONTROL.md §2, §3.1, §6; sessionpipe 0.10) -----------

describe("parseHello: files, home and start", () => {
  const base = { ...facts, harnesses: ["claude-code", "codex"] };
  it("keeps a well-formed start, home and files", () => {
    const h = parseHello({
      ...base,
      files: true,
      prompt_files: true,
      home: "/Users/misha",
      start: {
        "claude-code": { permissions: ["read", "safe", "edits", "auto"], permission: "auto", any_model: true },
        codex: { permissions: ["read", "safe", "auto"], permission: "safe", models: ["gpt-6-astra", "gpt-5.6-sol"] },
      },
    })!;
    expect(h.files).toBe(true);
    expect(h.promptFiles).toBe(true);
    expect(h.home).toBe("/Users/misha");
    expect(h.start).toEqual({
      "claude-code": { permissions: ["read", "safe", "edits", "auto"], permission: "auto", anyModel: true },
      codex: { permissions: ["read", "safe", "auto"], permission: "safe", models: ["gpt-6-astra", "gpt-5.6-sol"] },
    });
  });
  it("drops a foreign harness, a default not in the list, unknown levels and bad models", () => {
    const h = parseHello({
      ...base,
      start: {
        gemini: { permissions: ["safe"], permission: "safe" },
        "claude-code": { permissions: ["read", "bypass", "safe"], permission: "safe", models: ["sonnet", "-x", ""] },
        codex: { permissions: ["read"], permission: "auto" },
      },
    })!;
    expect(h.start).toEqual({
      "claude-code": { permissions: ["read", "safe"], permission: "safe", models: ["sonnet"] },
    });
  });
  it("is null for what a 0.9 daemon sends, and for a relative or oversized home", () => {
    const h = parseHello(base)!;
    expect(h).toMatchObject({ files: false, promptFiles: false, home: null, start: null });
    expect(parseHello({ ...base, home: "~/x" })!.home).toBeNull();
    expect(parseHello({ ...base, home: `/${"a".repeat(1024)}` })!.home).toBeNull();
    expect(parseHello({ ...base, home: "/a\nb" })!.home).toBeNull();
    expect(parseHello({ ...base, start: [] })!.start).toBeNull();
    expect(parseHello({ ...base, start: { codex: { permissions: [], permission: "safe" } } })!.start).toBeNull();
  });
});

describe("parseAcks: applied", () => {
  const now = () => "2026-10-23T10:00:00.000Z";
  const id = "01K8ZQ6X4N3T5V7W9Y1A2B3C4D";
  it("keeps a level and a model, drops what is malformed", () => {
    const [a] = parseAcks(
      { acks: [{ id, outcome: "taken", at: now(), applied: { permission: "edits", model: "sonnet" } }] },
      now,
    )!;
    expect(a!.applied).toEqual({ permission: "edits", model: "sonnet" });
    const [b] = parseAcks({ acks: [{ id, outcome: "delivered", applied: { permission: "full", model: "-x" } }] }, now)!;
    expect(b!.applied).toBeUndefined();
    const [c] = parseAcks({ acks: [{ id, outcome: "delivered", applied: { permission: "read" } }] }, now)!;
    expect(c!.applied).toEqual({ permission: "read" });
  });
});

describe("a start's options, files and applied, through POST send", () => {
  let b: Booted;
  let pk: TestPasskey;
  let day: TestDayKey;
  beforeAll(async () => {
    b = await boot();
    tmpDirs.push(b.stateDir);
    pk = await TestPasskey.create();
    day = await TestDayKey.create();
  });
  afterAll(() => b.close());

  const SID = "claude-code:2f6c6f0e-6f0a-4b2e-9d0e-0d6f7a7b8c9d";
  const hello = (m: { token: string }, extra: Record<string, unknown>) =>
    call(b.url, "POST", `${CONTROL}/hello`, {
      bearer: m.token,
      body: { ...facts, name: "studio-mac", harnesses: ["claude-code", "codex"], ...extra },
    });
  const start = async (machine: string, fields: Record<string, unknown>) =>
    call(b.url, "POST", `${UI}/send`, {
      body: {
        machineId: machine,
        ...(await signedPrompt(pk, day, machine, {
          kind: "start",
          session: SID,
          text: "Fix the date picker",
          cwd: "/Users/demo/acme/web",
          ...fields,
        })),
      },
    });
  const upload = (bytes: Uint8Array | string, type: string, name: string) =>
    fetch(`${b.url}${UI}/files?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": type },
      body: bytes as BodyInit,
    });

  it("refuses a level the machine does not advertise, and a model where none is taken", async () => {
    const m = await enrolled(b, pk, "m_startopts00000000001");
    expect(
      (
        await hello(m, {
          mode: "safe",
          start: { "claude-code": { permissions: ["read", "safe"], permission: "safe" } },
        })
      ).status,
    ).toBe(204);
    const c = b.control.machines().get("studio-mac")!;
    expect(c.start).toEqual({ "claude-code": { permissions: ["read", "safe"], permission: "safe" } });

    const auto = await start(m.machine, { permission: "auto" });
    expect(auto.status).toBe(422);
    expect(auto.body.code).toBe("permission");
    expect(String(auto.body.reason)).toMatch(/safe mode/);
    const unknown = await start(m.machine, { permission: "full" });
    expect(unknown.body.code).toBe("bad_fields");
    const model = await start(m.machine, { model: "sonnet" });
    expect(model).toMatchObject({ status: 422, body: { code: "model" } });
    const dash = await start(m.machine, { model: "--dangerously-skip-permissions" });
    expect(dash.body.code).toBe("bad_fields");
    // A level on a harness with no entry, and options on a prompt.
    const codex = await start(m.machine, { session: "codex:019a0000-0000-7000-8000-000000000001", permission: "read" });
    expect(codex.body.code).toBe("permission");
    const onPrompt = await call(b.url, "POST", `${UI}/send`, {
      body: { machineId: m.machine, ...(await signedPrompt(pk, day, m.machine, { permission: "read" })) },
    });
    expect(onPrompt.body.code).toBe("bad_fields");
    expect(b.control.activity().filter((a) => a.machineId === m.machine)).toHaveLength(0);

    const ok = await start(m.machine, { permission: "read" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ kind: "start", cwd: "/Users/demo/acme/web", permission: "read" });
  });

  it("a hello without start takes the options away again (a downgraded daemon)", async () => {
    const m = await enrolled(b, pk, "m_startopts00000000002");
    await hello(m, {
      start: { "claude-code": { permissions: ["safe", "auto"], permission: "auto", any_model: true } },
    });
    expect((await start(m.machine, { model: "opus[1m]" })).status).toBe(201);
    await hello(m, {});
    expect(b.control.machines().get("studio-mac")!.start).toBeUndefined();
    expect((await start(m.machine, { model: "opus[1m]" })).body.code).toBe("model");
  });

  it("a closed model list refuses an id that is not on it", async () => {
    const m = await enrolled(b, pk, "m_startopts00000000003");
    await hello(m, {
      start: { codex: { permissions: ["read", "safe", "auto"], permission: "auto", models: ["gpt-6-astra"] } },
    });
    const sess = "codex:019a0000-0000-7000-8000-000000000002";
    expect((await start(m.machine, { session: sess, model: "gpt-6-astra" })).status).toBe(201);
    expect((await start(m.machine, { session: sess, model: "gpt-x" })).body.code).toBe("model");
  });

  it("files: uploaded here, named by hash, fetched with the machine's token only", async () => {
    const m = await enrolled(b, pk, "m_startfiles0000000001");
    const bytes = new TextEncoder().encode("# notes\nthe date picker is off by one\n");
    const up = await upload(bytes, "text/markdown", "notes.md");
    expect(up.status).toBe(201);
    const entry = (await up.json()) as { name: string; type: string; size: number; sha256: string };
    expect(entry).toEqual({ name: "notes.md", type: "text/markdown", size: bytes.length, sha256: fileHash(bytes) });
    expect(entry.sha256).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // A machine that did not say files: true is not sent any.
    await hello(m, {});
    expect((await start(m.machine, { files: [entry] })).body.code).toBe("bad_fields");
    await hello(m, { files: true });
    const missing = { ...entry, sha256: fileHash(new TextEncoder().encode("never uploaded")) };
    expect((await start(m.machine, { files: [missing] })).body.code).toBe("file");
    expect((await start(m.machine, { files: [{ ...entry, name: ".env" }] })).body.code).toBe("bad_fields");
    const sent = await start(m.machine, { files: [entry] });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body.files).toEqual([entry]);
    // Nothing about the file is in the text the agent reads.
    expect(sent.body.text).toBe("Fix the date picker");

    const get = (sha: string, bearer?: string) =>
      fetch(`${b.url}${CONTROL}/files/${sha}`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
    const got = await get(entry.sha256, m.token);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("text/markdown");
    expect(got.headers.get("content-length")).toBe(String(bytes.length));
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    expect((await get(entry.sha256)).status).toBe(401);
    expect((await get(entry.sha256, SINK)).status).toBe(401);
    expect((await get(missing.sha256, m.token)).status).toBe(404);
    expect((await get("not-a-hash", m.token)).status).toBe(404);
  });

  it("an upload over 25 MiB, without a type, empty, or with a bad name is refused", async () => {
    // The router answers 413 and drops the connection mid-body, so the client may only see the drop.
    const big = await upload(new Uint8Array(26_214_401), "application/octet-stream", "big.bin").then(
      (r) => r.status,
      () => 413,
    );
    expect(big).toBe(413);
    expect((await upload("x", "nonsense", "a.txt")).status).toBe(415);
    expect((await upload("", "text/plain", "a.txt")).status).toBe(400);
    expect((await upload("x", "text/plain", "../a.txt")).status).toBe(400);
    expect((await upload("x", "text/plain", "")).status).toBe(400);
  });

  it("keeps applied from taken and delivered on the activity", async () => {
    const m = await enrolled(b, pk, "m_startapplied00000001");
    await hello(m, {
      start: { "claude-code": { permissions: ["safe", "edits", "auto"], permission: "auto", any_model: true } },
    });
    const sent = await start(m.machine, { permission: "edits", model: "sonnet" });
    expect(sent.status).toBe(201);
    const id = sent.body.id as string;
    const ack = (a: Record<string, unknown>) =>
      call(b.url, "POST", `${CONTROL}/ack`, {
        bearer: m.token,
        body: { acks: [{ id, at: new Date().toISOString(), ...a }] },
      });
    await ack({ outcome: "taken", applied: { permission: "edits", model: "sonnet" } });
    expect(b.control.activity().find((a) => a.id === id)).toMatchObject({
      outcome: "taken",
      permission: "edits",
      model: "sonnet",
      applied: { permission: "edits", model: "sonnet" },
    });
    await ack({ outcome: "delivered", session: SID, applied: { permission: "edits", model: "sonnet" } });
    expect(b.control.activity().find((a) => a.id === id)).toMatchObject({
      outcome: "delivered",
      applied: { permission: "edits", model: "sonnet" },
    });
  });

  it("the well-known says control.files", () => {
    expect(b.control.wellKnown().files).toBe(true);
  });
});

// --- the early verification against every control vector ---------------------------

const repo =
  process.env.SESSIONPIPE_REPO ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../sessionpipe");
const vectorsDir = path.join(repo, "conformance/control-vectors");
let vectorFiles: string[] = [];
try {
  vectorFiles = readdirSync(vectorsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
} catch {}

interface Vector {
  name: string;
  input: {
    signed?: { cmd: string; csig?: string | null; grant?: unknown; confirm?: unknown };
    proof?: unknown;
    machine: string;
    rp_id: string;
    trusted?: { id: string; alg: number; spki: string }[];
    now?: number;
    seen_nonces?: string[];
  };
  expect: { ok: boolean; code?: string };
}

describe.skipIf(!vectorFiles.length)("early verification: conformance/control-vectors through POST send", () => {
  if (!vectorFiles.length) console.log(`control vectors not found at ${vectorsDir}; set SESSIONPIPE_REPO`);
  for (const f of vectorFiles) {
    const v = JSON.parse(readFileSync(path.join(vectorsDir, f), "utf8")) as Vector;
    if (!v.input.signed) continue; // enrollment vectors are verifyEnrollment's; covered above
    it(f, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(v.input.now ?? Date.now());
      const b = await boot({ rpId: v.input.rp_id });
      tmpDirs.push(b.stateDir);
      try {
        const trusted = v.input.trusted ?? [];
        const r0 = await call(b.url, "POST", `${CONTROL}/_test/enroll`, {
          body: { machine: v.input.machine, key: trusted[0] },
        });
        expect(r0.status).toBe(201);
        // Each enrollment mints the machine's token again: keep the last one.
        for (const k of trusted.slice(1))
          r0.body.token = (
            await call(b.url, "POST", `${CONTROL}/_test/enroll`, { body: { machine: v.input.machine, key: k } })
          ).body.token;
        // A machine that takes files on a start, as a hello says it (CONTROL.md §2).
        await call(b.url, "POST", `${CONTROL}/hello`, {
          bearer: r0.body.token as string,
          body: { ...facts, name: "conformance", files: true },
        });
        const s = v.input.signed!;
        const r = await call(b.url, "POST", `${UI}/send`, {
          body: {
            machineId: v.input.machine,
            cmd: s.cmd,
            csig: s.csig ?? undefined,
            grant: s.grant ?? undefined,
            confirm: s.confirm ?? undefined,
          },
        });
        // A receiver's early word differs from the machine's gate in two places (CONTROL.md §5):
        // it allows ten minutes, not a day, and it keeps no nonce store.
        let expectOk = v.expect.ok;
        let code = v.expect.code;
        let iat = Number.NaN;
        try {
          iat = JSON.parse(s.cmd).iat;
        } catch {}
        if (expectOk && Number.isFinite(iat) && Date.now() - iat > RECEIVER_MAX_AGE_MS) {
          expectOk = false;
          code = "too_old";
        }
        if (!expectOk && code === "replay") expectOk = true;
        // And in a third: it holds the bytes a start's files name, and nobody uploaded these.
        let carriesFiles = false;
        try {
          carriesFiles = Array.isArray(JSON.parse(s.cmd).files);
        } catch {}
        if (expectOk && carriesFiles) {
          expectOk = false;
          code = "file";
        }
        if (expectOk) {
          expect(r.status, JSON.stringify(r.body)).toBe(201);
          expect(r.body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
          expect(r.body.machineId).toBe(v.input.machine);
          const got = await call(b.url, "GET", `${CONTROL}?machine=${v.input.machine}&wait=0`, {
            bearer: r0.body.token as string,
          });
          expect(got.status).toBe(200);
          expect(got.body.messages![0]!.cmd).toBe(s.cmd);
        } else {
          expect(r.status, JSON.stringify(r.body)).toBe(422);
          expect(r.body.code).toBe(code);
          expect(b.control.activity()).toHaveLength(0);
        }
      } finally {
        await b.close();
      }
    });
  }
});

it("sha256 is the WebCrypto one the verifier uses", async () => {
  expect((await sha256("x")).length).toBe(32);
});
