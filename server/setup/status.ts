// SPDX-License-Identifier: Apache-2.0
// Owned by: onboarding. The live facts behind GET /api/ui/setup/status: the CLI, the
// outbox, the events, the registry's harnesses on this disk and their hooks, TLS mode and
// whether this Mac trusts the CA, the daemon and its pairing, phones on the stream, and
// whether a message ever reached `delivered`. Computed fresh on every call (the harness
// probes cached for ten seconds); the page polls it every two seconds.
import dns from "node:dns";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { SetupStatus } from "../../shared/api.js";
import type { Control } from "../control/index.js";
import { DEMO_MACHINE } from "../control/state.js";
import type { OutboxSource } from "../sources/outbox.js";
import { resolveOutboxRoot } from "../sources/outbox.js";
import type { Store } from "../store/store.js";
import { localHostname, readCerts, type TlsMaterial } from "../tls/certs.js";
import type { ViewerRegistry } from "../ui/viewers.js";
import type { HarnessDetector } from "./harnesses.js";
import { type Exec, findCli, sameMachine } from "./local.js";
import type { Pairer } from "./pairer.js";
import type { TailscaleProbe } from "./tailscale.js";

export type Lookup = (host: string) => Promise<{ address: string }>;

/** Resolve a `.local` name, giving up after `ms` (a name mDNS does not know can hang). */
export async function lookupWithTimeout(
  host: string,
  ms: number,
  lookup: Lookup = (h) => dns.promises.lookup(h),
): Promise<{ resolves: boolean; address?: string }> {
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<{ resolves: false }>((r) => {
    timer = setTimeout(() => r({ resolves: false }), ms);
    timer.unref();
  });
  try {
    return await Promise.race([
      lookup(host).then(
        (r) => ({ resolves: true, address: r.address }),
        () => ({ resolves: false }),
      ),
      gaveUp,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DaemonStatus {
  name?: string;
  version?: string;
  receivers?: { url?: string; machine?: string; polling?: boolean }[];
}
export type AskDaemon = (sock: string) => Promise<DaemonStatus | null>;

/** The daemon's local socket (sessionpipe's CONTROL.md §8): one line of JSON in, one out. */
export const askDaemonDefault: AskDaemon = (sock) =>
  new Promise((resolve) => {
    if (process.platform !== "win32" && !existsSync(sock)) {
      resolve(null);
      return;
    }
    let buf = "";
    let done = false;
    const s = net.connect(sock);
    const finish = (r: DaemonStatus | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      s.destroy();
      resolve(r);
    };
    const t = setTimeout(() => finish(null), 1000);
    s.on("connect", () => s.write('{"op":"status"}\n'));
    s.on("data", (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try {
        const r = JSON.parse(buf.slice(0, i)) as { op?: string; status?: DaemonStatus };
        finish(r.op === "status" && r.status && typeof r.status === "object" ? r.status : null);
      } catch {
        finish(null);
      }
    });
    s.on("error", () => finish(null));
    s.on("close", () => finish(null));
  });

/** Where the daemon listens: `SESSIONPIPE_SOCKET`, a named pipe on Windows, else
 *  <sessionpipe state>/control.sock. */
export function daemonSocketPath(spStateDir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.SESSIONPIPE_SOCKET) return env.SESSIONPIPE_SOCKET;
  if (platform === "win32") return `\\\\.\\pipe\\sessionpipe-control-${os.userInfo().username}`;
  return path.join(spStateDir, "control.sock");
}

/** macOS: would the system trust our server certificate for SSL right now? The same
 *  evaluation Safari and Chrome run, so it also sees a trust setting added by hand. */
export async function caTrustedOnMac(exec: Exec, m: Pick<TlsMaterial, "serverCertPath" | "caCertPath">) {
  const r = await exec("security", ["verify-cert", "-c", m.serverCertPath, "-c", m.caCertPath, "-p", "ssl", "-L"], {
    timeoutMs: 8000,
  });
  return r.code === 0;
}

export interface StatusDeps {
  store: Store;
  control: Control;
  viewers: ViewerRegistry;
  tls: () => TlsMaterial | null;
  tlsDir: string;
  port: () => number;
  uiKey: () => string;
  rpId: () => string;
  outbox: OutboxSource | null;
  outboxPath?: string;
  pairer: Pairer;
  exec: Exec;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  hostname: string;
  lookup: Lookup;
  askDaemon: AskDaemon;
  opensslPresent: () => boolean;
  /** `--public-url`, when set. */
  publicUrl: () => string | undefined;
  tailscale: TailscaleProbe;
  /** The registry's harnesses on this disk (`harnesses.ts`), its probes cached across polls. */
  harnesses: HarnessDetector;
}

export async function buildStatus(d: StatusDeps): Promise<SetupStatus> {
  const cli = findCli(d.env, d.home);
  const spRoot = resolveOutboxRoot(d.outboxPath);
  const outboxDir = d.outbox?.status().path ?? path.join(spRoot, "outbox");

  const stats = d.store.stats();
  let lastAt: string | undefined;
  for (const m of d.store.machines()) if (!lastAt || m.lastAt > lastAt) lastAt = m.lastAt;

  const tls = d.tls();
  const material = tls ?? readCerts(d.tlsDir);
  const hostname = tls?.hostname ?? localHostname(d.hostname);
  const [caTrusted, mdns, daemon, tailscale] = await Promise.all([
    d.platform === "darwin" && material ? caTrustedOnMac(d.exec, material) : Promise.resolve(null),
    lookupWithTimeout(hostname, 1500, d.lookup),
    d.askDaemon(daemonSocketPath(spRoot, d.env, d.platform)),
    d.tailscale(),
  ]);

  // The machine's name: what the daemon says when it answers, else this host's.
  const names = [daemon?.name, d.hostname].filter((n): n is string => !!n);
  let paired: { name: string; machineId: string; online: boolean } | undefined;
  for (const [name, c] of d.control.machines())
    if (names.some((n) => sameMachine(name, n))) paired = { name, machineId: c.machineId, online: c.online };
  const pending = d.control.pendingPairings().find((p) => names.some((n) => sameMachine(p.machine, n)));
  const child = d.pairer.state();
  const pendingPairing = pending
    ? { code: pending.code, check: pending.check, expiresAt: pending.expiresAt }
    : child.active && child.code && child.check
      ? { code: child.code, check: child.check, expiresAt: new Date(Date.now() + 60_000).toISOString() }
      : undefined;

  const sessions = d.store.snapshot().sessions;
  const harnesses = d.harnesses.statuses(sessions, (m) => names.some((n) => sameMachine(m, n)));

  const suggestedFolders: string[] = [];
  if (!paired) {
    const seen = new Set<string>();
    for (const s of sessions) {
      if (!s.cwd || !names.some((n) => sameMachine(s.machine, n))) continue;
      const abs = s.cwd.startsWith("~") ? path.join(d.home, s.cwd.slice(1)) : s.cwd;
      if (!path.isAbsolute(abs) || seen.has(abs)) continue;
      seen.add(abs);
      suggestedFolders.push(abs);
      if (suggestedFolders.length >= 8) break;
    }
  }

  const allViewers = d.viewers.list();
  const phones = allViewers.filter((v) => !v.loopback && (v.device === "phone" || v.device === "tablet")).length;
  const publicUrl = d.publicUrl();
  // Demo mode's machine (server/demo/machine.ts) is nobody's first message.
  const delivered = d.control
    .activity(1000)
    .filter((a) => a.outcome === "delivered" && !a.machineId.startsWith(DEMO_MACHINE)).length;

  return {
    sessionpipe: {
      installed: !!cli,
      ...(cli ? { path: cli.path } : {}),
      ...(cli?.version ? { version: cli.version } : {}),
      outbox: { path: outboxDir, present: existsSync(outboxDir), sessions: d.outbox?.status().sessions ?? 0 },
    },
    events: { total: stats.events, ...(lastAt ? { lastAt } : {}) },
    harnesses,
    tls: {
      on: !!tls,
      hostname,
      httpsUrl: `https://${hostname}:${d.port()}`,
      rpId: d.rpId(),
      ...(material ? { caFingerprint: material.caFingerprint } : {}),
      caTrusted,
      opensslPresent: d.opensslPresent(),
      mdns,
    },
    daemon: {
      running: daemon !== null,
      ...(daemon?.name ? { name: daemon.name } : {}),
      pairedHere: !!paired,
      online: paired?.online ?? false,
      ...(paired ? { machineId: paired.machineId } : {}),
      ...(pendingPairing ? { pendingPairing } : {}),
      pairing: {
        active: child.active,
        ...(child.exitCode !== undefined ? { exitCode: child.exitCode } : {}),
        ...(child.error ? { error: child.error } : {}),
      },
      suggestedFolders,
    },
    viewers: { phones },
    tried: { delivered },
    remote: {
      ...(publicUrl ? { publicUrl } : {}),
      tailscale,
      viewers: allViewers.filter((v) => v.forwarded).length,
    },
    platform: d.platform,
    uiKey: d.uiKey(),
  };
}
