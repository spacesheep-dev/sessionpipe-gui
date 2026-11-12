// SPDX-License-Identifier: Apache-2.0
// A send a receiver holds for a confirm (CONTROL.md §3.2), through the GUI server, on real
// signatures (testkeys.ts) and the real verifier (sessionpipe-core's verifyCommand): what
// the page sends after a hold (a new command, signed by one confirm and nothing else) is
// what both carriers take. A machine paired on spacesheep: the server carries the send
// (forwardSend) and spacesheep verifies it, here a stand-in that verifies exactly as the
// core does for spacesheep's rp id and holds what the day grant signed. A machine paired
// here: this server's own verifier and second look (verifySend, pool.ts).
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { POOL_SESSION, type SignedCommand, verifyCommand } from "sessionpipe-core/control";
import { afterAll, describe, expect, it } from "vitest";
import { ROUTES } from "../../shared/api.js";
import { Router } from "../http/router.js";
import { type ControlDeps, createControl } from "./index.js";
import { commandStr, signCommand, TestDayKey, TestPasskey } from "./testkeys.js";

const SINK = "spg_test_sink_token_0123456789";
const CONTROL = ROUTES.control;
const UI = ROUTES.ui.control;
const WHY = "it reads like an instruction to delete files";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

async function boot(o: Pick<ControlDeps, "remoteSend"> = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "spgui-held-"));
  tmpDirs.push(stateDir);
  const control = createControl({
    stateDir,
    sinkToken: () => SINK,
    rpId: "localhost",
    testDoor: true,
    uiAuth: (ctx) => ctx.remote.loopback,
    ...o,
  });
  const router = new Router();
  control.register(router);
  const server = http.createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    control,
    close: async () => {
      control.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function call(url: string, method: string, p: string, o: { bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${url}${p}`, {
    method,
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

describe("a held send, confirmed as the page confirms it", () => {
  it("a machine paired on spacesheep: held with spacesheep's reason; a new command with a confirm alone verifies there and is queued", async () => {
    const machine = "m_heldremote000000000001";
    const pk = await TestPasskey.create({ rpId: "spacesheep.dev" });
    const day = await TestDayKey.create();
    const verdicts: string[] = [];
    // spacesheep's jobs route as far as the hold goes: the core's verdict for its rp id and
    // the machine's keys; the day grant held for a confirm, a confirm queued.
    const b = await boot({
      remoteSend: async (_m, body) => {
        // What forwardSend carried: the exact fields it got from the page.
        const signed = Object.fromEntries(
          Object.entries(body).filter(([, v]) => v !== null && v !== undefined),
        ) as unknown as SignedCommand;
        const v = await verifyCommand(signed, {
          machine,
          rpId: "spacesheep.dev",
          trusted: [pk.key],
          now: Date.now(),
          maxAgeMs: 10 * 60_000,
        });
        verdicts.push(v.ok ? v.via : `refused ${v.code}`);
        if (!v.ok) return { status: 400, json: { code: "bad", refusal: v.code, error: v.why } };
        if (v.via === "grant")
          return {
            status: 409,
            json: { code: "confirm", error: `Confirm with your passkey to send this: ${WHY}.`, why: WHY },
          };
        return { status: 202, json: { job: 7 } };
      },
    });
    try {
      b.control.remote.upsert(
        [{ id: machine, name: "lab-mac", online: true, agents: ["claude-code"], passkey_ids: [pk.key.id] }],
        { via: "spacesheep", origin: "https://spacesheep.dev", rpId: "spacesheep.dev" },
      );
      const first = commandStr(machine, {});
      const held = await call(b.url, "POST", `${UI}/send`, {
        body: { machineId: machine, ...(await signCommand(pk, day, first)) },
      });
      expect(held).toEqual({
        status: 422,
        body: { reason: `Confirm with your passkey to send this: ${WHY}.`, code: "confirm_required", detail: WHY },
      });
      expect(b.control.activity()).toHaveLength(0);
      // The press on Confirm: the same fields, a new nonce and iat, one confirm, nothing else.
      const again = commandStr(machine, {});
      expect(JSON.parse(again).nonce).not.toBe(JSON.parse(first).nonce);
      const body = { machineId: machine, ...(await signCommand(pk, day, again, { confirm: true })) };
      expect(Object.keys(body).sort()).toEqual(["cmd", "confirm", "machineId"]);
      const sent = await call(b.url, "POST", `${UI}/send`, { body });
      expect(sent.status).toBe(201);
      expect(verdicts).toEqual(["grant", "confirm"]);
      expect(b.control.activity()).toHaveLength(1);
    } finally {
      await b.close();
    }
  });

  it("a machine paired here: a confirm-only pool action under the grant is held; a new command with a confirm alone is verified and queued; so is a confirmed prompt", async () => {
    const machine = "m_heldlocal0000000000001";
    const b = await boot();
    try {
      const pk = await TestPasskey.create();
      const day = await TestDayKey.create();
      const enrolled = await call(b.url, "POST", `${CONTROL}/_test/enroll`, { body: { machine, key: pk.key } });
      expect(enrolled.status).toBe(201);
      const token = enrolled.body.token as string;
      const account = {
        id: "4d8f1c23-9e6b-4a07-b5d2-7f3e0a1c9b46",
        email: "w@example.com",
        label: "Work",
        enabled: true,
        status: "ready",
        current: true,
      };
      const other = {
        ...account,
        id: "7c2a9e41-3b6d-4f08-9a5e-1d4c8b2f6e03",
        email: "f@example.com",
        label: "Fiction",
        current: false,
      };
      const hello = {
        name: "lab",
        harnesses: ["claude-code"],
        modes: ["waiter"],
        version: "0.11.0",
        pool: { on: true, harness: "claude-code", accounts: [account, other] },
      };
      expect((await call(b.url, "POST", `${CONTROL}/hello`, { bearer: token, body: hello })).status).toBe(204);
      const order = () =>
        commandStr(machine, {
          kind: "pool",
          session: POOL_SESSION,
          text: undefined,
          pool_action: "order",
          pool_order: [other.id, account.id],
        });
      const send = (signed: SignedCommand) =>
        call(b.url, "POST", `${UI}/send`, { body: { machineId: machine, ...signed } });

      const held = await send(await signCommand(pk, day, order()));
      expect(held).toMatchObject({ status: 422, body: { code: "confirm_required" } });
      expect(String(held.body.reason)).toMatch(/confirm/);
      expect(b.control.activity()).toHaveLength(0);
      const confirmed = await signCommand(pk, day, order(), { confirm: true });
      expect(Object.keys(confirmed).sort()).toEqual(["cmd", "confirm"]);
      expect((await send(confirmed)).status).toBe(201);
      // A message signed by a confirm alone, as the page sends one a receiver held.
      const prompt = await signCommand(pk, day, commandStr(machine, {}), { confirm: true });
      expect((await send(prompt)).status).toBe(201);
      expect(b.control.activity()).toHaveLength(2);
    } finally {
      await b.close();
    }
  });
});
