// SPDX-License-Identifier: Apache-2.0
// The pool (DESIGN §2.3): the hello's `pool` read strictly, the `pool` command parsed and
// verified on real signatures beside the core (grant and confirm paths, every refusal code
// the core would give), the second look against the hello, and the whole way through
// POST /send to the queue and back through an ack.
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  CONTROL_KINDS,
  RECEIVER_MAX_AGE_MS,
  type SignedCommand,
  SKEW_MS,
  verifyCommand,
} from "sessionpipe-core/control";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ControlActivity,
  type MachineControl,
  POOL_ACCOUNT_REQUIRED,
  POOL_ACTIONS,
  POOL_CONFIRM_ACTIONS,
  POOL_SESSION,
  type PoolAction,
  ROUTES,
} from "../../shared/api.js";
import { Router } from "../http/router.js";
import { type Control, createControl } from "./index.js";
import { parseHello, parsePool } from "./parse.js";
import { coreTakesPool, looksLikePool, type PoolCommand, parsePoolCommand, verifyPoolCommand } from "./pool.js";
import { poolProblem, precheck } from "./precheck.js";
import { describePool } from "./state.js";
import { commandStr, signCommand, TestDayKey, TestPasskey } from "./testkeys.js";

const SINK = "spg_test_sink_token_0123456789";
const CONTROL = ROUTES.control;
const UI = ROUTES.ui.control;
const M = "m_pooltestmachine00001";
const A = "4d8f1c23-9e6b-4a07-b5d2-7f3e0a1c9b46";
const B = "7c2a9e41-3b6d-4f08-9a5e-1d4c8b2f6e03";

const poolCmd = (machine: string, fields: Record<string, unknown>) =>
  commandStr(machine, { kind: "pool", session: POOL_SESSION, text: undefined, pool_action: "on", ...fields });

const hello = (pool: unknown) => ({
  name: "lab",
  harnesses: ["claude-code"],
  modes: ["waiter"],
  version: "0.11.0",
  pool,
});
const account = (over: Record<string, unknown> = {}) => ({
  id: A,
  email: "work@example.com",
  label: "Work",
  enabled: true,
  status: "ready",
  current: true,
  ...over,
});

describe("hello.pool", () => {
  it("is read strictly: the object whole, each account on its own", () => {
    const h = parseHello(
      hello({
        on: true,
        harness: "claude-code",
        accounts: [
          account({ until: "2026-10-29T10:00:00Z", windows: [{ id: "five_hour", used_percent: 99.2 }, { id: "x y" }] }),
          account({
            id: B,
            label: "a\u0007b",
            email: "not an email",
            status: "limited",
            current: "yes",
            limited_by: "seven_day",
          }),
          account({ id: A }), // a repeat
          account({ id: "", email: "x@example.com" }), // no id
          account({ id: "c", status: "sleepy" }), // unknown status
          account({ id: "d", enabled: "true" }), // enabled not a boolean
          "nope",
        ],
      }),
    );
    expect(h?.pool).toEqual({
      on: true,
      harness: "claude-code",
      accounts: [
        {
          id: A,
          email: "work@example.com",
          label: "Work",
          enabled: true,
          status: "ready",
          current: true,
          until: "2026-10-29T10:00:00.000Z",
          windows: [{ id: "five_hour", usedPercent: 99.2 }],
        },
        { id: B, label: "ab", enabled: true, status: "limited", current: false, limitedBy: "seven_day" },
      ],
    });
  });

  it("drops a malformed pool, never the hello, and keeps an empty one", () => {
    for (const bad of [
      null,
      "on",
      [],
      { on: "yes", harness: "claude-code", accounts: [] },
      { on: true, accounts: [] },
      { on: true, harness: "claude-code" },
    ])
      expect(parseHello(hello(bad))).toMatchObject({ name: "lab", pool: null });
    expect(parsePool({ on: false, harness: "claude-code", accounts: [] })).toEqual({
      on: false,
      harness: "claude-code",
      accounts: [],
    });
    expect(parseHello(hello(undefined))?.pool).toBeNull();
    const many = parsePool({
      on: true,
      harness: "claude-code",
      accounts: Array.from({ length: 30 }, (_, i) => account({ id: `a${i}` })),
    });
    expect(many?.accounts).toHaveLength(20);
  });
});

describe("parsePoolCommand", () => {
  const ok = (fields: Record<string, unknown>) => parsePoolCommand(poolCmd(M, fields));
  it("takes each action with the fields it owns", () => {
    expect(ok({ pool_action: "on" })).toMatchObject({ ok: true, cmd: { kind: "pool", pool_action: "on" } });
    expect(ok({ pool_action: "off", note: "for tonight" })).toMatchObject({ ok: true });
    for (const a of ["enable", "disable", "remove", "refresh"])
      expect(ok({ pool_action: a, pool_account: A })).toMatchObject({ ok: true, cmd: { pool_account: A } });
    expect(ok({ pool_action: "refresh" })).toMatchObject({ ok: true });
    expect(ok({ pool_action: "enable", pool_account: "acc_1.x:y-z" })).toMatchObject({ ok: true });
    expect(ok({ pool_action: "order", pool_order: [A, B] })).toMatchObject({ ok: true, cmd: { pool_order: [A, B] } });
    expect(ok({ pool_action: "login.begin" })).toMatchObject({ ok: true });
    expect(ok({ pool_action: "login.complete", pool_account: "login_1", pool_code: "abc#state" })).toMatchObject({
      ok: true,
    });
  });
  it("refuses what breaks the shape, with the core's codes", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ pool_action: "shell" }, "bad_fields"],
      [{ pool_action: "on", pool_account: A }, "bad_fields"],
      [{ pool_action: "enable" }, "bad_fields"],
      [{ pool_action: "enable", pool_account: "has space" }, "bad_fields"],
      [{ pool_action: "enable", pool_account: "acc/1" }, "bad_fields"],
      [{ pool_action: "login.begin", pool_account: A }, "bad_fields"],
      [{ pool_action: "login.complete", pool_account: "l", pool_code: "two\nlines" }, "bad_fields"],
      [{ pool_action: "enable", pool_account: "x".repeat(129) }, "bad_fields"],
      [{ pool_action: "order" }, "bad_fields"],
      [{ pool_action: "order", pool_order: [] }, "bad_fields"],
      [{ pool_action: "order", pool_order: [A, A] }, "bad_fields"],
      [{ pool_action: "order", pool_order: Array.from({ length: 21 }, (_, i) => `a${i}`) }, "bad_fields"],
      [{ pool_action: "off", pool_order: [A] }, "bad_fields"],
      [{ pool_action: "login.complete", pool_account: "l" }, "bad_fields"],
      [{ pool_action: "login.complete", pool_account: "l", pool_code: "x".repeat(513) }, "bad_fields"],
      [{ pool_action: "login.complete", pool_account: "l", pool_code: "a\u0000b" }, "bad_fields"],
      [{ pool_action: "on", pool_code: "x" }, "bad_fields"],
      [{ pool_action: "on", text: "hi" }, "bad_fields"],
      [{ pool_action: "on", note: "n".repeat(2001) }, "bad_fields"],
      [{ session: "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e" }, "bad_session"],
      [{ kind: "prompt" }, "unknown_kind"],
      [{ nonce: "short" }, "bad_nonce"],
      [{ iat: 1.5 }, "malformed"],
      [{ machine: "x" }, "malformed"],
      [{ v: 2 }, "not_a_command"],
    ];
    for (const [fields, code] of cases) expect(ok(fields), JSON.stringify(fields)).toMatchObject({ ok: false, code });
    expect(parsePoolCommand("not json")).toMatchObject({ ok: false, code: "malformed" });
    expect(parsePoolCommand("[1]")).toMatchObject({ ok: false, code: "malformed" });
    expect(parsePoolCommand("")).toMatchObject({ ok: false, code: "malformed" });
  });
  it("tells a pool command from the rest before any check", () => {
    expect(looksLikePool(poolCmd(M, {}))).toBe(true);
    expect(looksLikePool(commandStr(M, {}))).toBe(false);
    expect(looksLikePool("{")).toBe(false);
    expect(looksLikePool(42)).toBe(false);
  });
});

describe("verifyPoolCommand", () => {
  const opts = async (pk: TestPasskey, now = Date.now()) => ({
    machine: M,
    rpId: "localhost",
    trusted: [pk.key],
    now,
    maxAgeMs: RECEIVER_MAX_AGE_MS,
  });

  it("takes the grant path and the confirm path on a trusted key, by the core's own primitives", async () => {
    const pk = await TestPasskey.create();
    const day = await TestDayKey.create();
    const cmd = poolCmd(M, { pool_action: "refresh", pool_account: A });
    const grant = await verifyPoolCommand(await signCommand(pk, day, cmd), await opts(pk));
    expect(grant).toMatchObject({ ok: true, via: "grant", key: pk.key.id, cmd: { pool_account: A } });
    const confirm = await verifyPoolCommand(await signCommand(pk, day, cmd, { confirm: true }), await opts(pk));
    expect(confirm).toMatchObject({ ok: true, via: "confirm", key: pk.key.id });
    // The core itself still says unknown_kind: that is why pool.ts exists.
    expect(await verifyCommand(await signCommand(pk, day, cmd), await opts(pk))).toMatchObject({
      ok: false,
      code: "unknown_kind",
    });
    expect(coreTakesPool()).toBe(CONTROL_KINDS.includes("pool" as never));
  });

  it("refuses the way the core does: each code in the core's order", async () => {
    const pk = await TestPasskey.create();
    const other = await TestPasskey.create();
    const day = await TestDayKey.create();
    const cmd = poolCmd(M, {});
    const good = await signCommand(pk, day, cmd);
    const o = await opts(pk);
    const code = async (s: SignedCommand | null, over: Partial<typeof o> = {}) => {
      const v = await verifyPoolCommand(s, { ...o, ...over });
      return v.ok ? "ok" : v.code;
    };
    expect(await code(null)).toBe("malformed");
    expect(await code({ cmd })).toBe("unsigned");
    expect(await code(good, { machine: "m_othermachine00000001" })).toBe("wrong_machine");
    expect(await code(good, { trusted: [other.key] })).toBe("untrusted_key");
    expect(await code(await signCommand(pk, day, cmd, { confirm: true }), { trusted: [other.key] })).toBe(
      "untrusted_key",
    );
    // The bytes changed after signing: the day key's signature no longer covers them.
    const tampered = { ...good, cmd: cmd.replace('"on"', '"off"') };
    expect(await code(tampered)).toBe("bad_csig");
    expect(await code({ ...good, csig: "AAAA" })).toBe("bad_csig");
    expect(
      await code({
        ...good,
        grant: { ...good.grant!, sig: good.grant!.sig.replace(/^./, (c) => (c === "A" ? "B" : "A")) },
      }),
    ).toBe("bad_assertion");
    expect(
      await code({ ...good, grant: { ...good.grant!, str: good.grant!.str.replace("localhost", "evil.example") } }),
    ).toBe("bad_grant");
    const iat = JSON.parse(cmd).iat as number;
    // A grant that begins after the command was signed, past the clock slack.
    expect(
      await code(
        await signCommand(pk, day, cmd, { grantIat: iat + SKEW_MS + 60_000, grantExp: iat + SKEW_MS + 3600_000 }),
      ),
    ).toBe("outside_grant");
    expect(await code(good, { now: iat - 10 * 60_000 })).toBe("future");
    expect(await code(good, { now: iat + RECEIVER_MAX_AGE_MS + 1000 })).toBe("too_old");
    // A confirm with a tampered command: the assertion is over the old bytes.
    const confirmed = await signCommand(pk, day, cmd, { confirm: true });
    expect(await code({ ...confirmed, cmd: cmd.replace('"on"', '"off"') })).toBe("bad_assertion");
  });

  it("refuses a confirm-only action signed with the day grant alone, as the daemon does", async () => {
    const pk = await TestPasskey.create();
    const day = await TestDayKey.create();
    const o = await opts(pk);
    const fields = (action: PoolAction): Record<string, unknown> =>
      action === "order"
        ? { pool_action: action, pool_order: [B, A] }
        : action === "login.complete"
          ? { pool_action: action, pool_account: "pl_1", pool_code: "code#state" }
          : POOL_ACCOUNT_REQUIRED.includes(action)
            ? { pool_action: action, pool_account: A }
            : { pool_action: action };
    expect(POOL_CONFIRM_ACTIONS).toEqual(["on", "off", "remove", "order", "disable", "login.complete"]);
    for (const action of POOL_ACTIONS) {
      const cmd = poolCmd(M, fields(action));
      const granted = await verifyPoolCommand(await signCommand(pk, day, cmd), o);
      const confirmed = await verifyPoolCommand(await signCommand(pk, day, cmd, { confirm: true }), o);
      expect(confirmed).toMatchObject({ ok: true, via: "confirm" });
      if (POOL_CONFIRM_ACTIONS.includes(action))
        expect(granted, action).toEqual({
          ok: false,
          code: "confirm_required",
          why: `pool ${action} needs a fresh confirm, not a day grant`,
        });
      else expect(granted, action).toMatchObject({ ok: true, via: "grant" });
    }
    // The signature checks come first: an untrusted key is refused as such, not as unconfirmed.
    const other = await TestPasskey.create();
    const off = await signCommand(pk, day, poolCmd(M, { pool_action: "off" }));
    expect(await verifyPoolCommand(off, { ...o, trusted: [other.key] })).toMatchObject({ code: "untrusted_key" });
  });

  it("hands the whole check to a core that lists the kind", async () => {
    const pk = await TestPasskey.create();
    const day = await TestDayKey.create();
    const cmd = poolCmd(M, {});
    const calls: unknown[] = [];
    let via: "grant" | "confirm" = "confirm";
    const newer = {
      CONTROL_KINDS: [...CONTROL_KINDS, "pool"] as unknown as typeof CONTROL_KINDS,
      verifyCommand: async (s: unknown, o: unknown) => {
        calls.push([s, o]);
        return { ok: true as const, cmd: JSON.parse((s as SignedCommand).cmd), via, key: "k" };
      },
    };
    expect(coreTakesPool(newer)).toBe(true);
    const v = await verifyPoolCommand(
      await signCommand(pk, day, cmd, { confirm: true }),
      await opts(pk),
      newer as never,
    );
    expect(v).toMatchObject({ ok: true, via: "confirm", key: "k", cmd: { pool_action: "on" } });
    expect(calls).toHaveLength(1);
    // The confirm rule holds on this path too: `on` under a grant is refused whatever the core said.
    via = "grant";
    expect(await verifyPoolCommand(await signCommand(pk, day, cmd), await opts(pk), newer as never)).toMatchObject({
      ok: false,
      code: "confirm_required",
    });
    const refusing = {
      ...newer,
      verifyCommand: async () => ({ ok: false as const, code: "replay" as const, why: "seen" }),
    };
    expect(await verifyPoolCommand(await signCommand(pk, day, cmd), await opts(pk), refusing as never)).toEqual({
      ok: false,
      code: "replay",
      why: "seen",
    });
    // A broken core object answers false, never throws.
    expect(
      coreTakesPool({
        get CONTROL_KINDS(): never {
          throw new Error("x");
        },
      } as never),
    ).toBe(false);
  });
});

describe("the second look and the words", () => {
  const pool = {
    on: true,
    harness: "claude-code",
    accounts: [
      { id: A, enabled: true, status: "ready" as const, current: true },
      { id: B, enabled: true, status: "limited" as const, current: false },
    ],
  };
  const files = { has: () => true } as never;
  it("holds a pool command to the hello", () => {
    const cmd = (f: Record<string, unknown>) => ({ kind: "pool", pool_action: "on", ...f });
    expect(precheck(cmd({}), {}, files)).toMatchObject({ code: "pool_unsupported" });
    expect(precheck(cmd({}), { pool }, files)).toBeNull();
    expect(precheck(cmd({ pool_action: "enable", pool_account: "zzz" }), { pool }, files)).toMatchObject({
      code: "pool_account",
    });
    expect(precheck(cmd({ pool_action: "enable", pool_account: B }), { pool }, files)).toBeNull();
    expect(
      precheck(cmd({ pool_action: "login.complete", pool_account: "login_7", pool_code: "x#y" }), { pool }, files),
    ).toBeNull();
    expect(poolProblem(cmd({ pool_action: "order", pool_order: [A] }), pool)).toMatchObject({ code: "pool_order" });
    expect(poolProblem(cmd({ pool_action: "order", pool_order: [A, B, "c"] }), pool)).toMatchObject({
      code: "pool_order",
    });
    expect(poolProblem(cmd({ pool_action: "order", pool_order: [B, A] }), pool)).toBeNull();
    expect(precheck(cmd({ text: "x" }), { pool }, files)).toMatchObject({ code: "bad_fields" });
  });
  it("says what a command does, naming accounts as the person does", () => {
    const names = (id: string) => (id === A ? "Work" : id);
    const d = (f: Partial<PoolCommand>) =>
      describePool({ kind: "pool", pool_action: "on", ...f } as PoolCommand, names);
    expect(d({})).toBe("Turn the pool on");
    expect(d({ pool_action: "off" })).toBe("Turn the pool off");
    expect(d({ pool_action: "enable", pool_account: A })).toBe("Turn Work on");
    expect(d({ pool_action: "disable", pool_account: B })).toBe(`Turn ${B} off`);
    expect(d({ pool_action: "remove", pool_account: A })).toBe("Remove Work");
    expect(d({ pool_action: "refresh", pool_account: A })).toBe("Refresh Work");
    expect(d({ pool_action: "refresh" })).toBe("Refresh usage");
    expect(d({ pool_action: "order", pool_order: [A, B] })).toBe("Move Work first");
    expect(d({ pool_action: "order" })).toBe("Reorder the accounts");
    expect(d({ pool_action: "login.begin" })).toBe("Sign in to Claude");
    expect(d({ pool_action: "login.complete", pool_account: "l", pool_code: "c" })).toBe("Finish signing in");
  });
});

describe("through the receiver", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  async function boot(): Promise<{ url: string; control: Control; close(): Promise<void> }> {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "spgui-pool-"));
    dirs.push(stateDir);
    const control = createControl({
      stateDir,
      sinkToken: () => SINK,
      rpId: "localhost",
      testDoor: true,
      uiAuth: (ctx) => ctx.remote.loopback,
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
  const call = async (url: string, method: string, p: string, o: { bearer?: string; body?: unknown } = {}) => {
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
  };

  it("queues a signed pool command for a pooling machine, carries its words, and takes the ack's detail", async () => {
    const b = await boot();
    try {
      const pk = await TestPasskey.create();
      const day = await TestDayKey.create();
      const enrolled = await call(b.url, "POST", `${CONTROL}/_test/enroll`, { body: { machine: M, key: pk.key } });
      expect(enrolled.status).toBe(201);
      const token = enrolled.body.token as string;
      const send = (signed: SignedCommand) => call(b.url, "POST", `${UI}/send`, { body: { machineId: M, ...signed } });

      // Before the hello says `pool`: refused at the second look, nothing queued. (`on` is
      // confirm-only, so it is signed as the page signs it, with a confirm.)
      const early = await send(await signCommand(pk, day, poolCmd(M, {}), { confirm: true }));
      expect(early).toMatchObject({ status: 422, body: { code: "pool_unsupported" } });

      const h = hello({
        on: false,
        harness: "claude-code",
        accounts: [
          account({ current: false }),
          account({ id: B, email: "fiction@example.com", label: "Fiction", current: false }),
        ],
      });
      expect((await call(b.url, "POST", `${CONTROL}/hello`, { bearer: token, body: h })).status).toBe(204);
      const machines = (await call(b.url, "GET", `${UI}/machines`)).body.machines as MachineControl[];
      expect(machines[0]?.pool).toMatchObject({
        on: false,
        accounts: [
          { id: A, label: "Work" },
          { id: B, label: "Fiction" },
        ],
      });
      expect(b.control.machines().get("lab")?.pool?.accounts).toHaveLength(2);

      // An unknown account, a short order: refused with the pool's own codes.
      expect(
        await send(
          await signCommand(pk, day, poolCmd(M, { pool_action: "remove", pool_account: "nobody" }), { confirm: true }),
        ),
      ).toMatchObject({ status: 422, body: { code: "pool_account" } });
      expect(
        await send(
          await signCommand(pk, day, poolCmd(M, { pool_action: "order", pool_order: [A] }), { confirm: true }),
        ),
      ).toMatchObject({ status: 422, body: { code: "pool_order" } });
      // A confirm-only action under the day grant alone: refused before the second look,
      // as the daemon would refuse it, nothing queued.
      expect(
        await send(await signCommand(pk, day, poolCmd(M, { pool_action: "order", pool_order: [B, A] }))),
      ).toMatchObject({ status: 422, body: { code: "confirm_required" } });
      // A bad signature is the verifier's word, not the second look's.
      const good = await signCommand(pk, day, poolCmd(M, {}));
      expect(await send({ ...good, csig: "AAAA" })).toMatchObject({ status: 422, body: { code: "bad_csig" } });

      const frames: ControlActivity[] = [];
      b.control.subscribe((m) => {
        if (m.kind === "control") frames.push(m.message);
      });
      const queued = await send(
        await signCommand(pk, day, poolCmd(M, { pool_action: "order", pool_order: [B, A] }), { confirm: true }),
      );
      expect(queued.status).toBe(201);
      const act = queued.body as unknown as ControlActivity;
      expect(act).toMatchObject({
        kind: "pool",
        session: POOL_SESSION,
        text: "Move Fiction first",
        poolAction: "order",
      });
      expect(act.poolAccount).toBeUndefined();
      const begun = await send(
        await signCommand(pk, day, poolCmd(M, { pool_action: "login.begin" }), { confirm: true }),
      );
      expect(begun.body).toMatchObject({ text: "Sign in to Claude", poolAction: "login.begin" });
      const disabled = await send(
        await signCommand(pk, day, poolCmd(M, { pool_action: "disable", pool_account: A }), { confirm: true }),
      );
      expect(disabled.body).toMatchObject({ text: "Turn Work off", poolAction: "disable", poolAccount: A });

      // The machine polls them byte for byte and acks: the detail reaches the activity.
      const polled = await call(b.url, "GET", `${CONTROL}?machine=${M}&wait=0`, { bearer: token });
      expect(polled.status).toBe(200);
      const msgs = polled.body.messages as { id: string; cmd: string }[];
      expect(msgs.map((m) => JSON.parse(m.cmd).pool_action)).toEqual(["order", "login.begin", "disable"]);
      const acks = {
        acks: [
          { id: act.id, outcome: "delivered", at: new Date().toISOString(), detail: "on · 2 accounts · Fiction, Work" },
          {
            id: (begun.body as { id: string }).id,
            outcome: "delivered",
            at: new Date().toISOString(),
            detail: "login_8f3k2m https://claude.ai/oauth/authorize?code=true&state=abc",
          },
          {
            id: (disabled.body as { id: string }).id,
            outcome: "refused",
            at: new Date().toISOString(),
            code: "pool_account",
            detail: "no such account",
          },
        ],
      };
      expect((await call(b.url, "POST", `${CONTROL}/ack`, { bearer: token, body: acks })).status).toBe(202);
      const activity = (await call(b.url, "GET", `${UI}/activity`)).body.activity as ControlActivity[];
      const byId = new Map(activity.map((a) => [a.id, a]));
      expect(byId.get(act.id)).toMatchObject({ outcome: "delivered", detail: "on · 2 accounts · Fiction, Work" });
      expect(byId.get((begun.body as { id: string }).id)?.detail).toContain("https://claude.ai/oauth/authorize");
      expect(byId.get((disabled.body as { id: string }).id)).toMatchObject({
        outcome: "refused",
        code: "pool_account",
      });
      expect(frames.filter((f) => f.kind === "pool").length).toBeGreaterThanOrEqual(6);
      // The signature never reaches the UI.
      expect(JSON.stringify(activity)).not.toContain(good.csig);

      // A hello without `pool` takes it away, and the next command is refused again.
      expect((await call(b.url, "POST", `${CONTROL}/hello`, { bearer: token, body: hello(undefined) })).status).toBe(
        204,
      );
      expect(b.control.machines().get("lab")?.pool).toBeUndefined();
      expect(await send(await signCommand(pk, day, poolCmd(M, {}), { confirm: true }))).toMatchObject({
        status: 422,
        body: { code: "pool_unsupported" },
      });
    } finally {
      await b.close();
    }
  });
});
