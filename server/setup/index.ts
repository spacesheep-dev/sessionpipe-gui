// SPDX-License-Identifier: Apache-2.0
// Owned by: onboarding. The first-run page's server side, under /api/ui/setup. Every
// route is for this machine only (loopback, or one of its own addresses; 403 otherwise,
// UI key or not), because each one acts here: turning TLS mode on, adding the CA to this
// Mac's keychain, starting `sessionpipe control pair`.
//
//   GET  /status        SetupStatus (shared/api.ts), fresh each call
//   POST /tls/on        make certificates if needed, attach https to the running port,
//                       switch the rp id, remember tls: true → { ok, restartRequired: false, tls, rpId }
//   POST /tls/trust     macOS: security add-trusted-cert (user domain; macOS asks for the
//                       password), then verify → { trusted, settingPresent, caCertPath, manual? }
//                       elsewhere: { trusted: false, steps[] }
//   POST /pair          spawn `sessionpipe control pair http://localhost:<port>` → { started }
//                       (409 not_installed with the install command when there is no CLI)
//   POST /pair/cancel   kill it → { cancelled }
//   POST /remote        { url } → set --public-url at runtime (the rp id follows, remembered)
//                       → { ok, remote, rpId }; 400 bad_url with the reason
//   POST /remote/off    forget it → { ok }
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Info, ROUTES } from "../../shared/api.js";
import type { Control } from "../control/index.js";
import type { Reply, Router } from "../http/router.js";
import type { OutboxSource } from "../sources/outbox.js";
import type { Store } from "../store/store.js";
import { opensslAvailable, readCerts, TlsError, type TlsMaterial } from "../tls/certs.js";
import type { ViewerRegistry } from "../ui/viewers.js";
import { createHarnessDetector, type HarnessFs, realHarnessFs } from "./harnesses.js";
import { type Exec, execDefault, findCli, thisMachineOnly } from "./local.js";
import { Pairer, type SpawnFn } from "./pairer.js";
import { type AskDaemon, askDaemonDefault, buildStatus, caTrustedOnMac, type Lookup } from "./status.js";
import { createTailscaleProbe, type TailscaleProbe } from "./tailscale.js";

export { findCli, isThisMachine, sameMachine } from "./local.js";

export interface SetupDeps {
  store: Store;
  control: Control;
  info: () => Info;
  viewers: ViewerRegistry;
  tls: () => TlsMaterial | null;
  enableTls: () => TlsMaterial;
  sinkToken: () => string;
  port: () => number;
  outbox: OutboxSource | null;
  outboxPath?: string;
  /** With the test door on, `x-spgui-test-remote` stands in for the remote address (e2e). */
  testDoor?: boolean;
  /** Test seams: nothing below touches `security`, the CLI, DNS or the daemon's socket when mocked. */
  exec?: Exec;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  hostname?: string;
  lookup?: Lookup;
  askDaemon?: AskDaemon;
  opensslPresent?: () => boolean;
  tlsDir?: string;
  /** The disk the harness probes read (`harnesses.ts`); a fake one in tests. */
  harnessFs?: HarnessFs;
  /** `--public-url`, and the setup page's way of setting or forgetting it (App.setPublicUrl). */
  publicUrl: () => string | undefined;
  setPublicUrl: (url: string | undefined) => void;
  /** The Tailscale probe (`tailscale.ts`); a fake one in tests. */
  tailscale?: TailscaleProbe;
}

export const SETUP_ROUTES = {
  status: `${ROUTES.ui.setup}/status`,
  tlsOn: `${ROUTES.ui.setup}/tls/on`,
  tlsTrust: `${ROUTES.ui.setup}/tls/trust`,
  pair: `${ROUTES.ui.setup}/pair`,
  pairCancel: `${ROUTES.ui.setup}/pair/cancel`,
  remote: `${ROUTES.ui.setup}/remote`,
  remoteOff: `${ROUTES.ui.setup}/remote/off`,
} as const;

export const INSTALL_COMMAND = "npx sessionpipe install";

export function linuxTrustSteps(caCertPath: string): string[] {
  return [
    `Debian/Ubuntu: sudo cp ${caCertPath} /usr/local/share/ca-certificates/sessionpipe-gui.crt && sudo update-ca-certificates`,
    `Fedora/RHEL: sudo trust anchor ${caCertPath}`,
    "Firefox and Chrome keep their own store: Settings → Privacy and security → Security → Manage certificates → Authorities → Import, and tick “Trust this certificate for identifying websites”.",
    "Resolving the .local name needs avahi-daemon (or nss-mdns) on this machine.",
  ];
}

export function windowsTrustSteps(caCertPath: string): string[] {
  return [
    `certutil -user -addstore Root "${caCertPath}" (Windows asks once; Edge and Chrome read this store)`,
    "By hand: open ca.crt → Install Certificate… → Current User → Place all certificates in the following store → Trusted Root Certification Authorities.",
    "Firefox keeps its own store: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import.",
    "The .local name resolves on Windows 10 and later with nothing to install.",
  ];
}

/** The CA-trust steps for a platform `tls trust` can't do itself. */
export const trustSteps = (platform: NodeJS.Platform, caCertPath: string): string[] =>
  platform === "win32" ? windowsTrustSteps(caCertPath) : linuxTrustSteps(caCertPath);

export function registerSetup(router: Router, deps: SetupDeps): { pairer: Pairer } {
  const exec = deps.exec ?? execDefault;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const hostname = deps.hostname ?? os.hostname();
  const tlsDir = deps.tlsDir ?? path.join(deps.info().storage.dir, "tls");
  const pairer = new Pairer(deps.spawn);
  const harnesses = createHarnessDetector(deps.harnessFs ?? realHarnessFs(home, env, platform));

  const local = thisMachineOnly({ testDoor: deps.testDoor ?? false, port: deps.port });

  const tailscale = deps.tailscale ?? createTailscaleProbe(exec, { env, platform, home, port: deps.port });

  router.get(
    SETUP_ROUTES.status,
    local(
      async (): Promise<Reply> => ({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: await buildStatus({
          store: deps.store,
          control: deps.control,
          viewers: deps.viewers,
          tls: deps.tls,
          tlsDir,
          port: deps.port,
          uiKey: () => deps.info().uiKey,
          rpId: () => deps.info().control.rpId,
          outbox: deps.outbox,
          outboxPath: deps.outboxPath,
          pairer,
          exec,
          env,
          platform,
          home,
          hostname,
          lookup: deps.lookup ?? ((h) => import("node:dns").then((dns) => dns.promises.lookup(h))),
          askDaemon: deps.askDaemon ?? askDaemonDefault,
          opensslPresent: deps.opensslPresent ?? opensslAvailable,
          harnesses,
          publicUrl: deps.publicUrl,
          tailscale,
        }),
      }),
    ),
  );

  router.post(
    SETUP_ROUTES.tlsOn,
    local((): Reply => {
      try {
        deps.enableTls();
      } catch (e) {
        if (e instanceof TlsError) return { status: 422, json: { reason: "tls_failed", error: e.message } };
        throw e;
      }
      const info = deps.info();
      return { status: 200, json: { ok: true, restartRequired: false, tls: info.tls, rpId: info.control.rpId } };
    }),
  );

  router.post(
    SETUP_ROUTES.remote,
    local(async (ctx): Promise<Reply> => {
      const body = await ctx.json<{ url?: unknown }>(4096);
      if (typeof body.url !== "string" || !body.url.trim())
        return { status: 400, json: { reason: "bad_url", message: "a url is required" } };
      try {
        deps.setPublicUrl(body.url);
      } catch (e) {
        return { status: 400, json: { reason: "bad_url", message: (e as Error).message } };
      }
      const info = deps.info();
      return { status: 200, json: { ok: true, remote: info.remote, rpId: info.control.rpId } };
    }),
  );

  router.post(
    SETUP_ROUTES.remoteOff,
    local((): Reply => {
      deps.setPublicUrl(undefined);
      return { status: 200, json: { ok: true } };
    }),
  );

  router.post(
    SETUP_ROUTES.tlsTrust,
    local(async (): Promise<Reply> => {
      const m = deps.tls() ?? readCerts(tlsDir);
      if (!m) return { status: 409, json: { reason: "tls_off", error: "Turn TLS mode on first." } };
      if (platform !== "darwin")
        return {
          status: 200,
          json: { trusted: false, platform, caCertPath: m.caCertPath, steps: trustSteps(platform, m.caCertPath) },
        };
      const keychain = path.join(home, "Library", "Keychains", "login.keychain-db");
      // The user trust domain (no -d): the admin domain needs sudo and otherwise imports
      // the certificate with no trust setting at all. macOS asks for the login password.
      const add = await exec(
        "security",
        ["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-p", "basic", "-k", keychain, m.caCertPath],
        { timeoutMs: 180_000 },
      );
      const [trusted, dump] = await Promise.all([
        caTrustedOnMac(exec, m),
        exec("security", ["dump-trust-settings"], { timeoutMs: 8000 }),
      ]);
      const settingPresent = dump.stdout.includes("sessionpipe-gui local CA");
      const manual = `Open ${m.caCertPath} (double-click it), find “sessionpipe-gui local CA” in the login keychain, open it and set Trust → Secure Sockets Layer (SSL) to “Always Trust”.`;
      return {
        status: 200,
        json: {
          trusted,
          settingPresent,
          added: add.code === 0,
          caCertPath: m.caCertPath,
          ...(add.code !== 0 ? { error: add.stderr.trim() || `security exited ${add.code ?? "without a code"}` } : {}),
          ...(trusted ? {} : { manual }),
        },
      };
    }),
  );

  router.post(
    SETUP_ROUTES.pair,
    local(async (ctx): Promise<Reply> => {
      const cli = findCli(env, home);
      if (!cli)
        return {
          status: 409,
          json: {
            reason: "not_installed",
            error: "not_installed",
            command: INSTALL_COMMAND,
            message: `No sessionpipe CLI on this machine. Run ${INSTALL_COMMAND} in a terminal, then try again.`,
          },
        };
      if (pairer.state().active) return { status: 200, json: { started: false, active: true } };
      let body: { folders?: unknown } = {};
      try {
        body = await ctx.json<{ folders?: unknown }>(16 * 1024);
      } catch {
        body = {};
      }
      const folders = Array.isArray(body.folders)
        ? body.folders.filter((f): f is string => typeof f === "string" && path.isAbsolute(f)).slice(0, 20)
        : [];
      // No --mode: with no terminal to ask, the CLI picks safe for a first pairing and
      // keeps the machine's existing choice otherwise. The sink token makes it a keyed
      // pairing (the page then shows no open-pairing warning).
      const args = [
        "control",
        "pair",
        `http://localhost:${deps.port()}`,
        "--token",
        deps.sinkToken(),
        ...folders.flatMap((f) => ["--folder", f]),
      ];
      // The installed CLI is `#!/usr/bin/env node`; a GUI started by launchd may have no
      // node on its PATH, so a JavaScript entry runs under our own node.
      let file = cli.path;
      let argv = args;
      try {
        const real = realpathSync(cli.path);
        if (/\.(c|m)?js$/.test(real)) {
          file = process.execPath;
          argv = [real, ...args];
        }
      } catch {}
      pairer.start(file, argv, { cwd: home, env, shell: platform === "win32" && file === cli.path });
      return { status: 200, json: { started: true, cli: cli.path, folders } };
    }),
  );

  router.post(
    SETUP_ROUTES.pairCancel,
    local((): Reply => ({ status: 200, json: { cancelled: pairer.cancel() } })),
  );

  return { pairer };
}
