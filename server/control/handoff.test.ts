// SPDX-License-Identifier: Apache-2.0
// Agents asking agents, the receiver's part: the hello's `ask` / `handoff` on the machine,
// `reply_to` on a carried prompt or start (the second look, and the activity), and the
// UI's unsigned `from` note on /send.
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ControlCommand } from "sessionpipe-core/control";
import { afterAll, describe, expect, it } from "vitest";
import { ROUTES } from "../../shared/api.js";
import { Router } from "../http/router.js";
import { type Control, createControl } from "./index.js";
import { parseHello } from "./parse.js";
import { ControlState, toActivity } from "./state.js";
import { commandStr, signCommand, TestDayKey, TestPasskey } from "./testkeys.js";
import { coreTakesReplyTo, replyToProblem } from "./ui.js";

const SINK = "spg_test_sink_token_0123456789";
const CONTROL = ROUTES.control;
const UI = ROUTES.ui.control;
const SESSION = "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e";
const OTHER = "codex:019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b";
const facts = { name: "mac-mini", harnesses: ["claude-code", "codex"], modes: ["waiter", "turn"], version: "0.11.0" };

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<{ url: string; control: Control; close(): Promise<void> }> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "spgui-handoff-"));
  tmpDirs.push(stateDir);
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
  const a = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${a.port}`,
    control,
    close: async () => {
      control.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function call(url: string, method: string, p: string, o: { bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (o.bearer !== undefined) headers.authorization = `Bearer ${o.bearer}`;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${url}${p}`, {
    method,
    headers,
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

describe("hello: ask and handoff", () => {
  it("parseHello reads ask as a boolean and handoff as true; a hello that says neither says nothing", () => {
    expect(parseHello({ ...facts, ask: true, handoff: true })).toMatchObject({ ask: true, handoff: true });
    expect(parseHello({ ...facts, ask: false })).toMatchObject({ ask: false });
    const quiet = parseHello(facts)!;
    expect("ask" in quiet).toBe(false);
    expect("handoff" in quiet).toBe(false);
    // Not booleans: not said.
    const odd = parseHello({ ...facts, ask: "yes", handoff: 1 })!;
    expect("ask" in odd).toBe(false);
    expect("handoff" in odd).toBe(false);
  });

  it("the machine's hello puts them on MachineControl; the next hello without takes them away", async () => {
    const b = await boot();
    try {
      const pk = await TestPasskey.create();
      const machine = "m_handoffhello00000001";
      const r = await call(b.url, "POST", `${CONTROL}/_test/enroll`, { body: { machine, key: pk.key } });
      const token = r.body.token as string;
      expect(
        (await call(b.url, "POST", `${CONTROL}/hello`, { bearer: token, body: { ...facts, ask: true, handoff: true } }))
          .status,
      ).toBe(204);
      let m = b.control.machines().get("mac-mini")!;
      expect(m).toMatchObject({ ask: true, handoff: true });
      const ui = await call(b.url, "GET", `${UI}/machines`);
      expect((ui.body.machines as Record<string, unknown>[]).find((x) => x.machineId === machine)).toMatchObject({
        ask: true,
        handoff: true,
      });
      expect(
        (await call(b.url, "POST", `${CONTROL}/hello`, { bearer: token, body: { ...facts, ask: false } })).status,
      ).toBe(204);
      m = b.control.machines().get("mac-mini")!;
      expect(m.ask).toBe(false);
      expect(m.handoff).toBeUndefined();
      expect((await call(b.url, "POST", `${CONTROL}/hello`, { bearer: token, body: facts })).status).toBe(204);
      m = b.control.machines().get("mac-mini")!;
      expect(m.ask).toBeUndefined();
      expect(m.handoff).toBeUndefined();
    } finally {
      await b.close();
    }
  });
});

describe("reply_to", () => {
  it("the second look: a prompt or a start only, a session ref, not itself, only to a machine that said handoff", () => {
    const prompt = { kind: "prompt", session: SESSION, text: "x", reply_to: OTHER };
    expect(replyToProblem(prompt, { handoff: true })).toBeNull();
    expect(replyToProblem({ ...prompt, kind: "start", cwd: "/x" }, { handoff: true })).toBeNull();
    expect(replyToProblem({ kind: "prompt", session: SESSION, text: "x" }, {})).toBeNull();
    expect(replyToProblem({ kind: "cancel", session: SESSION, reply_to: OTHER }, { handoff: true })).toMatchObject({
      code: "bad_fields",
    });
    expect(
      replyToProblem(
        { kind: "permission.answer", session: SESSION, for: "p", decision: "allow", reply_to: OTHER },
        { handoff: true },
      ),
    ).toMatchObject({ code: "bad_fields" });
    expect(replyToProblem({ ...prompt, reply_to: "not a ref" }, { handoff: true })).toMatchObject({
      code: "bad_fields",
    });
    expect(replyToProblem({ ...prompt, reply_to: 7 }, { handoff: true })).toMatchObject({ code: "bad_fields" });
    expect(replyToProblem({ ...prompt, reply_to: SESSION }, { handoff: true })).toMatchObject({ code: "bad_fields" });
    expect(replyToProblem(prompt, {})).toMatchObject({ code: "handoff" });
    expect(replyToProblem(prompt, { handoff: false })).toMatchObject({ code: "handoff" });
  });

  it("a carried prompt keeps reply_to and the UI's from on its activity, across a restart", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "spgui-handoff-state-"));
    tmpDirs.push(dir);
    let state = new ControlState(dir);
    try {
      const m = state.createMachine("m_handoffrow0000000001", parseHello({ ...facts, handoff: true })!);
      state.mintToken(m);
      const cmd = {
        kind: "prompt",
        session: SESSION,
        text: "Review this",
        reply_to: OTHER,
      } as unknown as ControlCommand;
      const row = state.enqueue(m, { cmd: JSON.stringify(cmd) }, cmd, { via: "ui", from: SESSION });
      expect(toActivity(row)).toMatchObject({ kind: "prompt", text: "Review this", replyTo: OTHER, from: SESSION });
      // Only a prompt or a start reads it; nothing else ever carries one past the second look.
      const cancel = { kind: "cancel", session: SESSION, reply_to: OTHER } as unknown as ControlCommand;
      expect(toActivity(state.enqueue(m, { cmd: "{}" }, cancel, { via: "ui" })).replyTo).toBeUndefined();
      state.close();
      state = new ControlState(dir);
      expect(state.activity().find((a) => a.id === row.id)).toMatchObject({ replyTo: OTHER, from: SESSION });
    } finally {
      state.close();
    }
  });

  it("/send stores `from` on the activity and refuses one that is not a session ref", async () => {
    const b = await boot();
    try {
      const pk = await TestPasskey.create();
      const day = await TestDayKey.create();
      const machine = "m_handoffsend000000001";
      await call(b.url, "POST", `${CONTROL}/_test/enroll`, { body: { machine, key: pk.key } });
      const signed = await signCommand(pk, day, commandStr(machine, { iat: Date.now(), text: "ship it" }));
      const sent = await call(b.url, "POST", `${UI}/send`, { body: { machineId: machine, ...signed, from: OTHER } });
      expect(sent.status).toBe(201);
      expect(sent.body).toMatchObject({ kind: "prompt", from: OTHER });
      expect(sent.body.replyTo).toBeUndefined();
      expect(b.control.activity().find((a) => a.id === sent.body.id)?.from).toBe(OTHER);
      const bad = await call(b.url, "POST", `${UI}/send`, { body: { machineId: machine, ...signed, from: "nope" } });
      expect(bad.status).toBe(400);
    } finally {
      await b.close();
    }
  });

  it("/send with reply_to: carried to a machine that said handoff once this core takes the field", async () => {
    const b = await boot();
    try {
      const pk = await TestPasskey.create();
      const day = await TestDayKey.create();
      const machine = "m_handoffreply00000001";
      const r = await call(b.url, "POST", `${CONTROL}/_test/enroll`, { body: { machine, key: pk.key } });
      const token = r.body.token as string;
      const cmd = commandStr(machine, { iat: Date.now(), text: "Second opinion?", reply_to: OTHER });
      const signed = await signCommand(pk, day, cmd);
      // Before the hello says handoff: refused, by the second look or by an older core first.
      const early = await call(b.url, "POST", `${UI}/send`, { body: { machineId: machine, ...signed } });
      expect(early.status).toBe(422);
      await call(b.url, "POST", `${CONTROL}/hello`, { bearer: token, body: { ...facts, ask: true, handoff: true } });
      const sent = await call(b.url, "POST", `${UI}/send`, { body: { machineId: machine, ...signed, from: SESSION } });
      if (coreTakesReplyTo()) {
        expect(early.body.code).toBe("handoff");
        expect(sent.status).toBe(201);
        expect(sent.body).toMatchObject({ replyTo: OTHER, from: SESSION });
        // Carried byte for byte: the field is inside what was signed.
        const polled = await call(b.url, "GET", `${CONTROL}?machine=${machine}&wait=0`, { bearer: token });
        expect((polled.body.messages as { cmd: string }[])[0]!.cmd).toBe(cmd);
      } else {
        // sessionpipe-core 0.10.0: its verifier's closed field list refuses it before our look.
        expect(early.body.code).toBe("bad_fields");
        expect(sent.status).toBe(422);
        expect(sent.body.code).toBe("bad_fields");
      }
    } finally {
      await b.close();
    }
  });
});
