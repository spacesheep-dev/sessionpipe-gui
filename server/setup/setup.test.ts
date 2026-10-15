// SPDX-License-Identifier: Apache-2.0
// The setup routes: the status shape from a fake PATH, outbox, daemon socket and trust
// store; the this-machine guard; TLS mode turned on while running on a plain-http app;
// the pairing child (a fake CLI script) and the install hint when there is none. Nothing
// here runs `security` or the real CLI: exec is mocked and the CLI is a shell script.
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES, type SetupStatus } from "../../shared/api.js";
import { Session, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { createControl } from "../control/index.js";
import { Router } from "../http/router.js";
import { Store } from "../store/store.js";
import { ensureCerts, opensslAvailable } from "../tls/certs.js";
import { ViewerRegistry } from "../ui/viewers.js";
import { realHarnessFs } from "./harnesses.js";
import { INSTALL_COMMAND, registerSetup, SETUP_ROUTES, type SetupDeps } from "./index.js";
import { type ExecResult, findCli, isThisMachine, sameMachine } from "./local.js";
import { lookupWithTimeout } from "./status.js";

const HAVE_OPENSSL = opensslAvailable();
const SINK = "spg_test_sink_token_0123456789";

const fetchJson = async (
  url: string,
  o: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(url, {
    method: o.method ?? "GET",
    headers: { ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.headers ?? {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : {} };
};

/** A fake sessionpipe CLI: prints what `control pair` prints, then waits to be killed. */
function fakeCli(root: string): string {
  const pkgDir = path.join(root, "lib", "node_modules", "sessionpipe");
  mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "sessionpipe", version: "9.9.9" }));
  const script = path.join(pkgDir, "dist", "cli.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'echo "  open this link and approve with that device\'s passkey:"',
      'echo "    http://localhost:1/pair?code=fakecode123"',
      'echo "  The page shows these digits too: 123456"',
      `echo "$@" > "${path.join(root, "args.txt")}"`,
      "sleep 60",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  // Installed the way `npx sessionpipe install` does it: a symlink in a bin folder.
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(script, path.join(bin, "sessionpipe"));
  return bin;
}

interface Booted {
  url: string;
  port: number;
  store: Store;
  execCalls: string[][];
  close(): Promise<void>;
}

async function boot(tmp: string, o: Partial<SetupDeps> & { tlsOn?: boolean; exec?: SetupDeps["exec"] } = {}) {
  const store = new Store(path.join(tmp, "state"));
  const control = createControl({
    stateDir: path.join(tmp, "state"),
    sinkToken: () => SINK,
    rpId: "localhost",
    testDoor: true,
    uiAuth: () => true,
  });
  const router = new Router();
  control.register(router);
  const viewers = new ViewerRegistry();
  const execCalls: string[][] = [];
  const exec: SetupDeps["exec"] = async (file, args): Promise<ExecResult> => {
    execCalls.push([file, ...args]);
    if (file === "security" && args[0] === "dump-trust-settings")
      return { code: 0, stdout: "Cert 0: sessionpipe-gui local CA · test-box.local\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  let port = 0;
  let publicUrl: string | undefined = o.publicUrl?.();
  // The harness probes read the temp home as a Linux disk, so this Mac's /Applications stays out of it.
  const env = { PATH: `${o.env?.PATH ?? path.join(tmp, "nowhere")}:/usr/bin:/bin`, HOME: tmp };
  registerSetup(router, {
    store,
    control,
    info: () =>
      ({
        uiKey: "ui-key",
        storage: { dir: path.join(tmp, "state") },
        control: { rpId: publicUrl ? new URL(publicUrl).hostname : "localhost", enabled: true, machines: 0 },
        tls: undefined,
        ...(publicUrl ? { remote: { url: publicUrl, host: new URL(publicUrl).hostname } } : {}),
      }) as never,
    viewers,
    tls: () => null,
    enableTls: () => {
      throw new Error("not in this test");
    },
    sinkToken: () => SINK,
    port: () => port,
    outbox: null,
    outboxPath: path.join(tmp, "sp"),
    testDoor: true,
    exec: o.exec ?? exec,
    env,
    platform: o.platform ?? "darwin",
    harnessFs: realHarnessFs(tmp, env, "linux"),
    home: tmp,
    hostname: "Test-Box.local",
    lookup: o.lookup ?? (async () => ({ address: "192.168.7.9" })),
    askDaemon: o.askDaemon ?? (async () => ({ name: "test-box", version: "0.8.0", receivers: [] })),
    opensslPresent: () => true,
    tlsDir: path.join(tmp, "tls"),
    publicUrl: () => publicUrl,
    setPublicUrl: (u) => {
      if (u !== undefined && !/^https:\/\/[^/]+$/.test(u)) throw new Error(`--public-url must be https: ${u}`);
      publicUrl = u;
    },
    tailscale: o.tailscale ?? (async () => ({ installed: false, running: false, serving: null })),
  });
  const server = http.createServer((req, res) => void router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    store,
    execCalls,
    close: async () => {
      control.close();
      await store.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  } satisfies Booted;
}

describe("this machine", () => {
  it("is loopback or one of our own addresses", () => {
    expect(isThisMachine("127.0.0.1", [])).toBe(true);
    expect(isThisMachine("::1", [])).toBe(true);
    expect(isThisMachine("::ffff:10.0.0.2", ["10.0.0.2"])).toBe(true);
    expect(isThisMachine("fe80::1", ["fe80::1%en0"])).toBe(true);
    expect(isThisMachine("192.168.1.9", ["10.0.0.2"])).toBe(false);
  });
  it("matches a machine name with or without .local, any case", () => {
    expect(sameMachine("Build-Box", "Build-Box.local")).toBe(true);
    expect(sameMachine("build-box.local", "Build-Box")).toBe(true);
    expect(sameMachine("studio-mac", "Build-Box.local")).toBe(false);
    expect(sameMachine(undefined, "x")).toBe(false);
  });
  it("finds the CLI at ~/.local/bin or on the PATH and reads its version without running it", () => {
    const tmp = tempDir("spgui-setup-cli-");
    try {
      expect(findCli({ PATH: path.join(tmp.dir, "nope") }, tmp.dir)).toBeNull();
      const bin = fakeCli(tmp.dir);
      expect(findCli({ PATH: bin }, tmp.dir)).toEqual({ path: path.join(bin, "sessionpipe"), version: "9.9.9" });
      // ~/.local/bin wins even when the PATH has nothing.
      mkdirSync(path.join(tmp.dir, ".local"), { recursive: true });
      writeFileSync(path.join(tmp.dir, ".local", "bin"), ""); // not a dir: skipped quietly
      expect(findCli({ PATH: bin }, tmp.dir)?.path).toBe(path.join(bin, "sessionpipe"));
    } finally {
      tmp.cleanup();
    }
  });
  it("gives up on a slow lookup", async () => {
    const slow = () => new Promise<{ address: string }>(() => {});
    expect(await lookupWithTimeout("x.local", 20, slow)).toEqual({ resolves: false });
    expect(await lookupWithTimeout("x.local", 1000, async () => ({ address: "::1" }))).toEqual({
      resolves: true,
      address: "::1",
    });
    expect(await lookupWithTimeout("x.local", 1000, async () => Promise.reject(new Error("ENOTFOUND")))).toEqual({
      resolves: false,
    });
  });
});

describe("setup routes", () => {
  let tmp: { dir: string; cleanup: () => void };
  let b: Awaited<ReturnType<typeof boot>>;
  let bin: string;
  beforeAll(async () => {
    tmp = tempDir("spgui-setup-");
    mkdirSync(path.join(tmp.dir, "sp", "outbox"), { recursive: true });
    // Two harnesses on this disk: Claude Code with sessionpipe's hooks written, Cursor with none.
    mkdirSync(path.join(tmp.dir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(tmp.dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "/n/node /x/sessionpipe/dist/hook.js claude-code Stop" }] }],
        },
      }),
    );
    mkdirSync(path.join(tmp.dir, ".cursor"), { recursive: true });
    bin = fakeCli(tmp.dir);
    b = await boot(tmp.dir, { env: { PATH: bin } });
    const s = new Session("one");
    b.store.ingest(
      [
        s.ev("session.started", { source: "startup" }, { session: { machine: "test-box", cwd: "~/proj/a" } }),
        s.ev("turn.started", { turn_id: "t" }, { session: { machine: "test-box", cwd: "~/proj/a" } }),
      ],
      "http",
    );
  });
  afterAll(async () => {
    await b.close();
    tmp.cleanup();
  });

  it("status has every section, from the fake PATH, outbox, daemon socket and trust store", async () => {
    const r = await fetchJson(`${b.url}${SETUP_ROUTES.status}`);
    expect(r.status).toBe(200);
    const s = r.body as unknown as SetupStatus;
    expect(s.sessionpipe).toMatchObject({
      installed: true,
      path: path.join(bin, "sessionpipe"),
      version: "9.9.9",
      outbox: { path: path.join(tmp.dir, "sp", "outbox"), present: true, sessions: 0 },
    });
    expect(s.events.total).toBe(2);
    expect(s.events.lastAt).toMatch(/^\d{4}-/);
    // The registry's harnesses on this disk: Claude Code's hooks on with the one session (this
    // machine's), Cursor installed without an adapter, the rest not here.
    expect(s.harnesses.map((h) => h.name)).toContain("antigravity");
    expect(s.harnesses.find((h) => h.name === "claude-code")).toMatchObject({
      installed: true,
      hooks: "on",
      sessions: 1,
      lastEventAt: s.events.lastAt,
      configPath: path.join(tmp.dir, ".claude", "settings.json"),
    });
    expect(s.harnesses.find((h) => h.name === "cursor")).toMatchObject({ installed: true, hooks: "unsupported" });
    expect(s.harnesses.filter((h) => h.installed).map((h) => h.name)).toEqual(["claude-code", "cursor"]);
    expect(s.tls).toMatchObject({
      on: false,
      hostname: "test-box.local",
      httpsUrl: `https://test-box.local:${b.port}`,
      rpId: "localhost",
      caTrusted: null, // no certificates yet: nothing to verify
      opensslPresent: true,
      mdns: { resolves: true, address: "192.168.7.9" },
    });
    expect(s.daemon).toMatchObject({
      running: true,
      name: "test-box",
      pairedHere: false,
      online: false,
      pairing: { active: false },
      suggestedFolders: [path.join(tmp.dir, "proj", "a")],
    });
    expect(s.daemon.pendingPairing).toBeUndefined();
    expect(s.viewers).toEqual({ phones: 0 });
    expect(s.tried).toEqual({ delivered: 0 });
    expect(s.platform).toBe("darwin");
    expect(s.uiKey).toBe("ui-key");
    // Nothing ran `security`: there is no certificate to verify.
    expect(b.execCalls.filter((c) => c[0] === "security")).toEqual([]);
  });

  it("is for this machine only: a LAN address gets 403 on every route, UI key or not", async () => {
    for (const [method, p] of [
      ["GET", SETUP_ROUTES.status],
      ["POST", SETUP_ROUTES.tlsOn],
      ["POST", SETUP_ROUTES.tlsTrust],
      ["POST", SETUP_ROUTES.pair],
      ["POST", SETUP_ROUTES.pairCancel],
    ] as const) {
      const r = await fetchJson(`${b.url}${p}?k=ui-key`, {
        method,
        headers: { "x-spgui-test-remote": "192.168.1.9", cookie: "spgui=ui-key" },
      });
      expect(r.status, `${method} ${p}`).toBe(403);
      expect(r.body.reason).toBe("local_only");
    }
    // The machine's own LAN address counts as this machine (the https origin arrives that way).
    const own = await fetchJson(`${b.url}${SETUP_ROUTES.status}`, {
      headers: { "x-spgui-test-remote": "::ffff:127.0.0.1" },
    });
    expect(own.status).toBe(200);
  });

  it("starts one pairing child, reads its code and digits, refuses a second, cancels it", async () => {
    const started = await fetchJson(`${b.url}${SETUP_ROUTES.pair}`, {
      method: "POST",
      body: { folders: ["/tmp/proj", "relative/not-allowed", 7] },
    });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ started: true, cli: path.join(bin, "sessionpipe"), folders: ["/tmp/proj"] });
    const again = await fetchJson(`${b.url}${SETUP_ROUTES.pair}`, { method: "POST" });
    expect(again.body).toEqual({ started: false, active: true });
    // The fake CLI printed its link and digits; the status reports them as the pending pairing.
    let s: SetupStatus | undefined;
    for (let i = 0; i < 80 && !(s?.daemon.pairing.active && s.daemon.pendingPairing); i++) {
      await new Promise((r) => setTimeout(r, 50));
      s = (await fetchJson(`${b.url}${SETUP_ROUTES.status}`)).body as unknown as SetupStatus;
    }
    expect(s?.daemon.pairing).toMatchObject({ active: true });
    expect(s?.daemon.pendingPairing).toMatchObject({ code: "fakecode123", check: "123456" });
    const args = readFileSync(path.join(tmp.dir, "args.txt"), "utf8");
    expect(args.trim()).toBe(`control pair http://localhost:${b.port} --token ${SINK} --folder /tmp/proj`);
    const cancelled = await fetchJson(`${b.url}${SETUP_ROUTES.pairCancel}`, { method: "POST" });
    expect(cancelled.body).toEqual({ cancelled: true });
    s = (await fetchJson(`${b.url}${SETUP_ROUTES.status}`)).body as unknown as SetupStatus;
    expect(s.daemon.pairing.active).toBe(false);
    expect(s.daemon.pendingPairing).toBeUndefined();
    expect((await fetchJson(`${b.url}${SETUP_ROUTES.pairCancel}`, { method: "POST" })).body).toEqual({
      cancelled: false,
    });
  });

  it("reports a pairing control itself knows about this machine, then the paired row", async () => {
    const started = await fetchJson(`${b.url}${ROUTES.control}/pair`, {
      method: "POST",
      headers: { authorization: `Bearer ${SINK}` },
      body: { name: "Test-Box", harnesses: ["claude-code"], modes: ["waiter"], version: "0.8.0" },
    });
    expect(started.status).toBe(201);
    let s = (await fetchJson(`${b.url}${SETUP_ROUTES.status}`)).body as unknown as SetupStatus;
    expect(s.daemon.pendingPairing).toMatchObject({ code: started.body.code, check: started.body.check });
    expect(s.daemon.pairedHere).toBe(false);
    const approved = await fetchJson(`${b.url}${ROUTES.control}/_test/approve`, {
      method: "POST",
      body: { code: started.body.code },
    });
    expect(approved.status).toBe(200);
    s = (await fetchJson(`${b.url}${SETUP_ROUTES.status}`)).body as unknown as SetupStatus;
    expect(s.daemon.pairedHere).toBe(true);
    expect(s.daemon.online).toBe(false);
    expect(s.daemon.machineId).toBe(started.body.machine);
    expect(s.daemon.suggestedFolders).toEqual([]);
  });

  it("tls/trust elsewhere than macOS returns the distro steps; with TLS off it says so", async () => {
    const off = await fetchJson(`${b.url}${SETUP_ROUTES.tlsTrust}`, { method: "POST" });
    expect(off.status).toBe(409);
    expect(off.body.reason).toBe("tls_off");
  });

  it("pair without a CLI returns the install hint", async () => {
    const t2 = tempDir("spgui-setup-nocli-");
    const other = await boot(t2.dir);
    try {
      const r = await fetchJson(`${other.url}${SETUP_ROUTES.pair}`, { method: "POST" });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ reason: "not_installed", error: "not_installed", command: INSTALL_COMMAND });
      const s = (await fetchJson(`${other.url}${SETUP_ROUTES.status}`)).body as unknown as SetupStatus;
      expect(s.sessionpipe.installed).toBe(false);
      expect(s.sessionpipe.outbox.present).toBe(false);
      expect(s.harnesses).toHaveLength(9);
      expect(s.harnesses.every((h) => !h.installed)).toBe(true);
    } finally {
      await other.close();
      t2.cleanup();
    }
  });
});

describe.skipIf(!HAVE_OPENSSL)("trusting the CA (mocked security)", () => {
  it("macOS: add-trusted-cert in the user domain against the login keychain, then verify-cert", async () => {
    const tmp = tempDir("spgui-setup-trust-");
    const m = ensureCerts(path.join(tmp.dir, "tls"), { hostname: "test-box.local", addresses: [] });
    const calls: string[][] = [];
    const exec: SetupDeps["exec"] = async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === "dump-trust-settings")
        return { code: 0, stdout: "Cert 1: sessionpipe-gui local CA · test-box.local\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const b = await boot(tmp.dir, { exec });
    try {
      const s = (await fetchJson(`${b.url}${SETUP_ROUTES.status}`)).body as unknown as SetupStatus;
      expect(s.tls.caTrusted).toBe(true); // verify-cert (mocked) said yes
      expect(s.tls.caFingerprint).toBe(m.caFingerprint);
      expect(calls.find((c) => c[1] === "verify-cert")).toEqual([
        "security",
        "verify-cert",
        "-c",
        m.serverCertPath,
        "-c",
        m.caCertPath,
        "-p",
        "ssl",
        "-L",
      ]);
      const r = await fetchJson(`${b.url}${SETUP_ROUTES.tlsTrust}`, { method: "POST" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ trusted: true, settingPresent: true, added: true, caCertPath: m.caCertPath });
      const add = calls.find((c) => c[1] === "add-trusted-cert")!;
      expect(add).toEqual([
        "security",
        "add-trusted-cert",
        "-r",
        "trustRoot",
        "-p",
        "ssl",
        "-p",
        "basic",
        "-k",
        path.join(tmp.dir, "Library", "Keychains", "login.keychain-db"),
        m.caCertPath,
      ]);
      expect(add).not.toContain("-d");
    } finally {
      await b.close();
      tmp.cleanup();
    }
  });

  it("macOS: when security refuses (dialog cancelled) the answer carries the manual steps", async () => {
    const tmp = tempDir("spgui-setup-trust2-");
    ensureCerts(path.join(tmp.dir, "tls"), { hostname: "test-box.local", addresses: [] });
    const exec: SetupDeps["exec"] = async (_file, args) => {
      if (args[0] === "add-trusted-cert") return { code: 1, stdout: "", stderr: "User canceled." };
      return { code: 1, stdout: "", stderr: "" };
    };
    const b = await boot(tmp.dir, { exec });
    try {
      const r = await fetchJson(`${b.url}${SETUP_ROUTES.tlsTrust}`, { method: "POST" });
      expect(r.body).toMatchObject({ trusted: false, settingPresent: false, added: false, error: "User canceled." });
      expect(String(r.body.manual)).toContain("Always Trust");
    } finally {
      await b.close();
      tmp.cleanup();
    }
  });

  it("Linux: the steps, with the ca.crt path", async () => {
    const tmp = tempDir("spgui-setup-trust3-");
    const m = ensureCerts(path.join(tmp.dir, "tls"), { hostname: "test-box.local", addresses: [] });
    const b = await boot(tmp.dir, { platform: "linux" });
    try {
      const s = (await fetchJson(`${b.url}${SETUP_ROUTES.status}`)).body as unknown as SetupStatus;
      expect(s.tls.caTrusted).toBeNull();
      const r = await fetchJson(`${b.url}${SETUP_ROUTES.tlsTrust}`, { method: "POST" });
      expect(r.body).toMatchObject({ trusted: false, platform: "linux", caCertPath: m.caCertPath });
      expect((r.body.steps as string[]).join("\n")).toContain("update-ca-certificates");
      expect(b.execCalls).toEqual([]);
    } finally {
      await b.close();
      tmp.cleanup();
    }
  });
});

describe.skipIf(!HAVE_OPENSSL)("TLS mode turned on while running", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  beforeAll(async () => {
    tmp = tempDir("spgui-setup-tlson-");
    app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, tlsHostname: "test-box.local" });
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  it("POST tls/on makes certificates, attaches https to the same port, switches the rp id and remembers", async () => {
    expect(app.httpsServer).toBeNull();
    expect(app.rpId).toBe("localhost");
    const before = await fetchJson(`${app.url}${ROUTES.ui.info}`);
    expect(before.body.tls).toBeUndefined();

    const r = await fetchJson(`${app.url}${SETUP_ROUTES.tlsOn}`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      restartRequired: false,
      rpId: "test-box.local",
      tls: { on: true, hostname: "test-box.local", httpsUrl: `https://test-box.local:${app.port}` },
    });
    expect(app.httpsServer).not.toBeNull();
    expect(app.tls?.hostname).toBe("test-box.local");
    expect(app.rpId).toBe("test-box.local");
    expect(JSON.parse(readFileSync(path.join(tmp.dir, "config.json"), "utf8")).tls).toBe(true);

    // The same port now answers https too; plain http keeps working.
    const secure = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      https
        .get(`https://127.0.0.1:${app.port}${ROUTES.ui.info}`, { rejectUnauthorized: false }, (res) => {
          let body = "";
          res.on("data", (c) => {
            body += c;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on("error", reject);
    });
    expect(secure.status).toBe(200);
    expect(JSON.parse(secure.body).control.rpId).toBe("test-box.local");
    const plain = await fetchJson(`${app.url}${ROUTES.ui.info}`);
    expect(plain.body.tls).toMatchObject({ on: true });
    const wk = await fetchJson(`${app.url}${ROUTES.wellKnown}`);
    expect((wk.body.control as { signing: { rp_id: string } }).signing.rp_id).toBe("test-box.local");

    // A second call is a no-op.
    const again = await fetchJson(`${app.url}${SETUP_ROUTES.tlsOn}`, { method: "POST" });
    expect(again.status).toBe(200);
    expect(app.tls?.caFingerprint).toBe((r.body.tls as { caFingerprint: string }).caFingerprint);
  });
});

describe("from anywhere (--public-url)", () => {
  it("status carries the tailscale probe and no public url; POST /remote sets one, a bad one is 400, /remote/off forgets it", async () => {
    const t = tempDir();
    const tmp = t.dir;
    const b = await boot(tmp, {
      tailscale: async () => ({
        installed: true,
        running: true,
        dnsName: "test-box.tail1234.ts.net",
        ips: ["100.64.0.9"],
        serving: false,
      }),
    });
    try {
      const status = async () => (await (await fetch(`${b.url}${SETUP_ROUTES.status}`)).json()) as SetupStatus;
      let s = await status();
      expect(s.remote).toEqual({
        tailscale: {
          installed: true,
          running: true,
          dnsName: "test-box.tail1234.ts.net",
          ips: ["100.64.0.9"],
          serving: false,
        },
        viewers: 0,
      });

      const bad = await fetch(`${b.url}${SETUP_ROUTES.remote}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "http://test-box.tail1234.ts.net" }),
      });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { reason: string }).reason).toBe("bad_url");

      const ok = await fetch(`${b.url}${SETUP_ROUTES.remote}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://test-box.tail1234.ts.net" }),
      });
      expect(ok.status).toBe(200);
      const j = (await ok.json()) as { ok: boolean; rpId: string; remote: { url: string } };
      expect(j.rpId).toBe("test-box.tail1234.ts.net");
      expect(j.remote.url).toBe("https://test-box.tail1234.ts.net");
      s = await status();
      expect(s.remote.publicUrl).toBe("https://test-box.tail1234.ts.net");

      // A LAN address may not set it: the route is for this machine only.
      const lan = await fetch(`${b.url}${SETUP_ROUTES.remoteOff}`, {
        method: "POST",
        headers: { "x-spgui-test-remote": "192.168.7.20" },
      });
      expect(lan.status).toBe(403);

      expect((await fetch(`${b.url}${SETUP_ROUTES.remoteOff}`, { method: "POST" })).status).toBe(200);
      s = await status();
      expect(s.remote.publicUrl).toBeUndefined();
    } finally {
      await b.close();
      t.cleanup();
    }
  });
});
