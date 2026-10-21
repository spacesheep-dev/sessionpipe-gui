// SPDX-License-Identifier: Apache-2.0
// The phone routes over real HTTP: the one read, the Tailscale click against a fake CLI
// (never the real `tailscale serve`), the device poll through control's own device
// requests, and the https probe over plain http, through a trusted proxy, and over TLS.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { type PhoneDeviceState, type PhoneInfo, ROUTES } from "../../shared/api.js";
import { tempDir } from "../../test/events.js";
import { createControl } from "../control/index.js";
import { commandStr, signCommand, TestDayKey, TestPasskey } from "../control/testkeys.js";
import { Router } from "../http/router.js";
import type { ExecResult } from "../setup/local.js";
import { createTailscaleProbe } from "../setup/tailscale.js";
import { ensureCerts, opensslAvailable } from "../tls/certs.js";
import { arrivedOverHttps, PHONE_ROUTES, registerPhone } from "./index.js";

const SINK = "spg_test_sink_token_0123456789";
const CONTROL = ROUTES.control;
const UI = ROUTES.ui.control;
const STATUS = (dns = "test-box.tail1234.ts.net") =>
  JSON.stringify({ BackendState: "Running", Self: { DNSName: `${dns}.`, TailscaleIPs: ["100.64.0.9"] } });

type Res = { status: number; body: Record<string, unknown> & { messages?: Record<string, unknown>[] } };
async function call(
  url: string,
  method: string,
  p: string,
  o: { bearer?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
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

/** What the fake `tailscale` answers, per argument line; `serve --bg` is recorded, never run. */
interface FakeTailscale {
  installed: boolean;
  running: boolean;
  serving: boolean;
  serveFails?: string;
  calls: string[][];
}

async function boot(tmp: string, ts: FakeTailscale, o: { uiKey?: string; tls?: boolean } = {}) {
  const stateDir = path.join(tmp, "state");
  const control = createControl({
    stateDir,
    sinkToken: () => SINK,
    rpId: () => rpId,
    testDoor: true,
    uiAuth: (ctx) =>
      ctx.remote.loopback || ctx.url.searchParams.get("k") === "ui-key" || ctx.cookies().spgui === "ui-key",
  });
  const router = new Router();
  control.register(router);
  let port = 0;
  let publicUrl: string | undefined;
  let rpId = "localhost";
  // A fake binary on the PATH, so findTailscale finds it; exec is faked so it never runs.
  const bin = path.join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  if (ts.installed) {
    writeFileSync(path.join(bin, "tailscale"), "#!/bin/sh\nexit 1\n");
    chmodSync(path.join(bin, "tailscale"), 0o755);
  }
  const exec = async (file: string, args: string[]): Promise<ExecResult> => {
    ts.calls.push([file, ...args]);
    const line = args.join(" ");
    if (line === "status --json")
      return { code: 0, stdout: ts.running ? STATUS() : JSON.stringify({ BackendState: "NeedsLogin" }), stderr: "" };
    if (line === "serve status")
      return {
        code: 0,
        stdout: ts.serving
          ? `https://test-box.tail1234.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:${port}\n`
          : "",
        stderr: "",
      };
    if (line === `serve --bg ${port}`) {
      if (ts.serveFails) return { code: 1, stdout: "", stderr: ts.serveFails };
      ts.serving = true;
      return { code: 0, stdout: "Available within your tailnet:\nhttps://test-box.tail1234.ts.net/\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unknown: ${line}` };
  };
  const env = { PATH: bin };
  const tailscale = createTailscaleProbe(exec, { env, platform: "linux", home: tmp, port: () => port, ttlMs: 60_000 });
  registerPhone(router, {
    control,
    info: () =>
      ({
        uiKey: "ui-key",
        urls: {
          local: `http://localhost:${port}`,
          lan: [`http://192.168.1.20:${port}`],
          ...(publicUrl ? { public: publicUrl } : {}),
        },
        control: { enabled: true, rpId, machines: 0 },
        ...(o.tls ? { tls: { on: true } } : {}),
      }) as never,
    uiAuth: (ctx) =>
      ctx.remote.loopback || ctx.cookies().spgui === "ui-key" || ctx.url.searchParams.get("k") === "ui-key",
    port: () => port,
    setPublicUrl: (u) => {
      if (u !== undefined && !/^https:\/\/[^/]+$/.test(u)) throw new Error(`--public-url must be https: ${u}`);
      publicUrl = u;
      rpId = u ? new URL(u).hostname : "localhost";
    },
    tailscale,
    testDoor: true,
    exec,
    env,
    platform: "linux",
    home: tmp,
  });
  router.trustProxy = () => publicUrl !== undefined;
  const server = http.createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    router,
    control,
    publicUrl: () => publicUrl,
    close: async () => {
      control.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const tmpDirs: { cleanup: () => void }[] = [];
afterAll(() => {
  for (const t of tmpDirs) t.cleanup();
});
afterEach(() => vi.useRealTimers());

describe("GET /api/ui/phone", () => {
  it("carries the LAN url and QR, the rp id, no Tailscale, and the keys and requests control knows", async () => {
    const tmp = tempDir("spgui-phone-");
    tmpDirs.push(tmp);
    const b = await boot(tmp.dir, { installed: false, running: false, serving: false, calls: [] });
    try {
      const r = await call(b.url, "GET", PHONE_ROUTES.info);
      expect(r.status).toBe(200);
      const p = r.body as unknown as PhoneInfo;
      expect(p.lan.url).toBe(`http://192.168.1.20:${b.port}/?k=ui-key`);
      expect(p.lan.qr).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
      expect(p).toMatchObject({
        rpId: "localhost",
        tls: false,
        publicUrl: null,
        tailscale: { installed: false, running: false, name: null, serving: false },
        trusted: [],
        pending: [],
      });

      // A paired machine's keys are the trusted list; a phone's request is pending with its digits.
      const mac = await TestPasskey.create();
      const enrol = await call(b.url, "POST", `${CONTROL}/_test/enroll`, {
        body: { machine: "m_phone0000000000000001", key: mac.key, name: "Misha's Mac" },
      });
      expect(enrol.status).toBe(201);
      const phone = await TestPasskey.create();
      const req = await call(b.url, "POST", `${UI}/devices`, { body: { key: phone.key, name: "Misha's iPhone" } });
      expect(req.status).toBe(201);
      const again = (await call(b.url, "GET", PHONE_ROUTES.info)).body as unknown as PhoneInfo;
      expect(again.trusted).toEqual([
        { id: mac.key.id, name: "Misha's Mac", addedAt: expect.stringMatching(/^\d{4}-/) },
      ]);
      expect(again.pending).toEqual([
        { id: req.body.requestId, name: "Misha's iPhone", digits: req.body.check, since: req.body.createdAt },
      ]);
    } finally {
      await b.close();
    }
  });

  it("with TLS on the LAN url is the trust page; the routes need the UI's auth", async () => {
    const tmp = tempDir("spgui-phone-");
    tmpDirs.push(tmp);
    const b = await boot(tmp.dir, { installed: false, running: false, serving: false, calls: [] }, { tls: true });
    try {
      const p = (await call(b.url, "GET", PHONE_ROUTES.info)).body as unknown as PhoneInfo;
      expect(p.lan.url).toBe(`http://192.168.1.20:${b.port}/trust?k=ui-key`);
      expect(p.tls).toBe(true);
      const lan = { "x-spgui-test-remote": "192.168.1.9" };
      // The test door's remote address only moves the this-machine guard; auth still reads the
      // socket, so a LAN visitor is simulated by a router with no loopback admission: the
      // uiAuth above admits the cookie or ?k=, and a wrong key is refused by both.
      for (const [m, p2] of [
        ["GET", PHONE_ROUTES.info],
        ["POST", PHONE_ROUTES.tailscale],
        ["GET", `${PHONE_ROUTES.device}/d_nope`],
        ["POST", PHONE_ROUTES.trustCheck],
      ] as const) {
        const ok = await call(b.url, m, `${p2}?k=ui-key`, { headers: lan });
        expect(ok.status, `${m} ${p2}`).not.toBe(401);
      }
    } finally {
      await b.close();
    }
  });
});

describe("POST /api/ui/phone/tailscale", () => {
  it("is for this machine only, like the setup actions", async () => {
    const tmp = tempDir("spgui-phone-");
    tmpDirs.push(tmp);
    const b = await boot(tmp.dir, { installed: true, running: true, serving: false, calls: [] });
    try {
      const r = await call(b.url, "POST", `${PHONE_ROUTES.tailscale}?k=ui-key`, {
        headers: { "x-spgui-test-remote": "192.168.1.9", cookie: "spgui=ui-key" },
      });
      expect(r.status).toBe(403);
      expect(r.body.reason).toBe("local_only");
      expect(b.publicUrl()).toBeUndefined();
    } finally {
      await b.close();
    }
  });

  it("runs `serve --bg <port>` once, sets the public url to the MagicDNS name, and is idempotent", async () => {
    const tmp = tempDir("spgui-phone-");
    tmpDirs.push(tmp);
    const ts: FakeTailscale = { installed: true, running: true, serving: false, calls: [] };
    const b = await boot(tmp.dir, ts);
    try {
      const before = (await call(b.url, "GET", PHONE_ROUTES.info)).body as unknown as PhoneInfo;
      expect(before.tailscale).toEqual({
        installed: true,
        running: true,
        name: "test-box.tail1234.ts.net",
        serving: false,
      });

      const r = await call(b.url, "POST", PHONE_ROUTES.tailscale);
      expect(r.status).toBe(200);
      const p = r.body as unknown as PhoneInfo;
      expect(p.publicUrl).toBe("https://test-box.tail1234.ts.net");
      expect(p.rpId).toBe("test-box.tail1234.ts.net");
      expect(p.tailscale.serving).toBe(true);
      expect(b.publicUrl()).toBe("https://test-box.tail1234.ts.net");
      const serves = ts.calls.filter((c) => c[1] === "serve" && c[2] === "--bg");
      expect(serves).toEqual([[path.join(tmp.dir, "bin", "tailscale"), "serve", "--bg", String(b.port)]]);

      // Already serving: no second `serve --bg`, the same answer.
      const again = await call(b.url, "POST", PHONE_ROUTES.tailscale);
      expect(again.status).toBe(200);
      expect(ts.calls.filter((c) => c[1] === "serve" && c[2] === "--bg")).toHaveLength(1);
      // The shared probe's cache was refreshed: the plain read agrees.
      const read = (await call(b.url, "GET", PHONE_ROUTES.info)).body as unknown as PhoneInfo;
      expect(read.tailscale.serving).toBe(true);
    } finally {
      await b.close();
    }
  });

  it("answers { error } with the CLI's own words: not installed, not connected, serve refused", async () => {
    const tmp = tempDir("spgui-phone-");
    tmpDirs.push(tmp);
    const none = await boot(path.join(tmp.dir, "a"), { installed: false, running: false, serving: false, calls: [] });
    try {
      const r = await call(none.url, "POST", PHONE_ROUTES.tailscale);
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: "Tailscale is not installed on this machine." });
    } finally {
      await none.close();
    }
    const stopped = await boot(path.join(tmp.dir, "b"), { installed: true, running: false, serving: false, calls: [] });
    try {
      const r = await call(stopped.url, "POST", PHONE_ROUTES.tailscale);
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/not connected/);
    } finally {
      await stopped.close();
    }
    const ts: FakeTailscale = {
      installed: true,
      running: true,
      serving: false,
      serveFails: "error: serve config denied by policy\nrun `tailscale serve reset` first\n",
      calls: [],
    };
    const refused = await boot(path.join(tmp.dir, "c"), ts);
    try {
      const r = await call(refused.url, "POST", PHONE_ROUTES.tailscale);
      expect(r.status).toBe(502);
      expect(r.body).toEqual({ error: "error: serve config denied by policy\nrun `tailscale serve reset` first" });
      expect(refused.publicUrl()).toBeUndefined();
    } finally {
      await refused.close();
    }
  });
});

describe("GET /api/ui/phone/device/:id", () => {
  it("follows control's device request: pending, trusted with the machine's name, refused, expired, unknown", async () => {
    const tmp = tempDir("spgui-phone-");
    tmpDirs.push(tmp);
    const b = await boot(tmp.dir, { installed: false, running: false, serving: false, calls: [] });
    try {
      const mac = await TestPasskey.create();
      const day = await TestDayKey.create();
      const machine = "m_phone0000000000000002";
      const enrol = await call(b.url, "POST", `${CONTROL}/_test/enroll`, { body: { machine, key: mac.key } });
      const token = enrol.body.token as string;
      await call(b.url, "POST", `${CONTROL}/hello`, {
        bearer: token,
        body: { name: "mac-mini", harnesses: ["claude-code"], modes: ["turn"], version: "0.9.0" },
      });

      const phone = await TestPasskey.create();
      const req = await call(b.url, "POST", `${UI}/devices`, { body: { key: phone.key, name: "Misha's iPhone" } });
      const id = req.body.requestId as string;
      const digits = req.body.check as string;
      const state = async (of = id) =>
        (await call(b.url, "GET", `${PHONE_ROUTES.device}/${of}`)).body as unknown as PhoneDeviceState;
      expect(await state()).toEqual({ state: "pending", digits, machine: null });

      // The Mac approves: key.add signed with its passkey; still pending until the machine says delivered.
      const cmd = commandStr(machine, {
        kind: "key.add",
        session: "sessionpipe:keys",
        text: undefined,
        key: phone.key,
        name: "Misha's iPhone",
      });
      const sent = await call(b.url, "POST", `${UI}/send`, {
        body: { machineId: machine, ...(await signCommand(mac, day, cmd)) },
      });
      expect(sent.status).toBe(201);
      expect(await state()).toEqual({ state: "pending", digits, machine: "mac-mini" });
      await call(b.url, "GET", `${CONTROL}?machine=${machine}&wait=0`, { bearer: token });
      await call(b.url, "POST", `${CONTROL}/ack`, {
        bearer: token,
        body: { acks: [{ id: sent.body.id, outcome: "delivered", at: new Date().toISOString(), mode: "sdk" }] },
      });
      expect(await state()).toEqual({ state: "trusted", digits, machine: "mac-mini" });

      // Refused by the machine.
      const tablet = await TestPasskey.create();
      const req2 = await call(b.url, "POST", `${UI}/devices`, { body: { key: tablet.key, name: "Tablet" } });
      const cmd2 = commandStr(machine, {
        kind: "key.add",
        session: "sessionpipe:keys",
        text: undefined,
        key: tablet.key,
      });
      const sent2 = await call(b.url, "POST", `${UI}/send`, {
        body: { machineId: machine, ...(await signCommand(mac, day, cmd2)) },
      });
      await call(b.url, "POST", `${CONTROL}/ack`, {
        bearer: token,
        body: {
          acks: [{ id: sent2.body.id, outcome: "refused", code: "untrusted_key", at: new Date().toISOString() }],
        },
      });
      expect(await state(req2.body.requestId as string)).toMatchObject({ state: "refused", machine: "mac-mini" });

      // Rejected on the approving device, or never made: refused, nothing to show.
      const req3 = await call(b.url, "POST", `${UI}/devices`, { body: { key: (await TestPasskey.create()).key } });
      await call(b.url, "POST", `${UI}/devices/${req3.body.requestId}/reject`);
      expect(await state(req3.body.requestId as string)).toEqual({ state: "refused", digits: "", machine: null });
      expect(await state("d_nope")).toEqual({ state: "refused", digits: "", machine: null });

      // Ten minutes without an approval.
      vi.useFakeTimers({ toFake: ["Date"] });
      const req4 = await call(b.url, "POST", `${UI}/devices`, { body: { key: (await TestPasskey.create()).key } });
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(await state(req4.body.requestId as string)).toMatchObject({ state: "expired", machine: null });
    } finally {
      await b.close();
    }
  });
});

describe("POST /api/ui/phone/trust-check", () => {
  it("is false over plain http, true through the trusted proxy's X-Forwarded-Proto, and true over TLS", async () => {
    const tmp = tempDir("spgui-phone-");
    tmpDirs.push(tmp);
    const ts: FakeTailscale = { installed: true, running: true, serving: true, calls: [] };
    const b = await boot(tmp.dir, ts);
    try {
      expect((await call(b.url, "POST", PHONE_ROUTES.trustCheck)).body).toEqual({ https: false, rpId: "localhost" });
      // Headers mean nothing until a public url makes the router trust the proxy.
      const spoof = await call(b.url, "POST", `${PHONE_ROUTES.trustCheck}?k=ui-key`, {
        headers: { "x-forwarded-for": "100.64.0.3", "x-forwarded-proto": "https" },
      });
      expect(spoof.body.https).toBe(false);
      await call(b.url, "POST", PHONE_ROUTES.tailscale);
      const via = await call(b.url, "POST", `${PHONE_ROUTES.trustCheck}?k=ui-key`, {
        headers: { "x-forwarded-for": "100.64.0.3", "x-forwarded-proto": "https" },
      });
      expect(via.body).toEqual({ https: true, rpId: "test-box.tail1234.ts.net" });
      // The forwarded visitor is not this machine: the Tailscale click is refused to it.
      const notMe = await call(b.url, "POST", `${PHONE_ROUTES.tailscale}?k=ui-key`, {
        headers: { "x-forwarded-for": "100.64.0.3", "x-forwarded-proto": "https" },
      });
      expect(notMe.status).toBe(403);

      if (!opensslAvailable()) return;
      const m = ensureCerts(path.join(tmp.dir, "tls"), { hostname: "test-box.local", addresses: [] });
      const secure = https.createServer({ key: m.key, cert: m.cert }, (req, res) => void b.router.handle(req, res));
      await new Promise<void>((r) => secure.listen(0, "127.0.0.1", r));
      try {
        const port = (secure.address() as { port: number }).port;
        const got = await new Promise<string>((resolve, reject) => {
          const rq = https.request(
            {
              host: "127.0.0.1",
              port,
              method: "POST",
              path: PHONE_ROUTES.trustCheck,
              ca: m.caCert,
              servername: "test-box.local",
            },
            (res) => {
              let s = "";
              res.on("data", (c) => (s += c));
              res.on("end", () => resolve(s));
            },
          );
          rq.on("error", reject);
          rq.end();
        });
        expect(JSON.parse(got).https).toBe(true);
      } finally {
        secure.closeAllConnections?.();
        await new Promise<void>((r) => secure.close(() => r()));
      }
    } finally {
      await b.close();
    }
  });

  it("reads the socket, then the proxy header only when forwarded", () => {
    const ctx = (o: { encrypted?: boolean; forwarded?: boolean; proto?: string }) =>
      ({
        req: { socket: { encrypted: o.encrypted }, headers: o.proto ? { "x-forwarded-proto": o.proto } : {} },
        remote: { ip: "127.0.0.1", loopback: true, forwarded: o.forwarded ?? false },
      }) as never;
    expect(arrivedOverHttps(ctx({ encrypted: true }))).toBe(true);
    expect(arrivedOverHttps(ctx({ proto: "https" }))).toBe(false);
    expect(arrivedOverHttps(ctx({ forwarded: true, proto: "https" }))).toBe(true);
    expect(arrivedOverHttps(ctx({ forwarded: true, proto: "http" }))).toBe(false);
  });
});
