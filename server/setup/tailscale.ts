// SPDX-License-Identifier: Apache-2.0
// Owned by: onboarding. Tailscale on this machine, as far as the setup page's "From
// anywhere" step needs: installed, connected, this node's MagicDNS name, and whether
// `tailscale serve` already forwards to our port. Read from the `tailscale` CLI alone
// (`status --json`, `serve status`): nothing is changed, no key is read. The probe is
// cached for a few seconds because the status is polled every two.
import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { SetupStatus } from "../../shared/api.js";
import type { Exec } from "./local.js";

export type TailscaleStatus = SetupStatus["remote"]["tailscale"];

export const NOT_INSTALLED: TailscaleStatus = { installed: false, running: false, serving: null };

/** The `tailscale` CLI: on the PATH, or inside the macOS app bundle (which does not put it there). */
export function findTailscale(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string | null {
  const names = platform === "win32" ? ["tailscale.exe", "tailscale"] : ["tailscale"];
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs)
    for (const n of names) {
      const bin = path.join(dir, n);
      if (executable(bin)) return bin;
    }
  if (platform === "darwin")
    for (const app of ["/Applications/Tailscale.app", path.join(home, "Applications", "Tailscale.app")]) {
      const bin = path.join(app, "Contents", "MacOS", "Tailscale");
      if (executable(bin)) return bin;
    }
  if (platform === "win32") {
    const bin = path.join(env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe");
    if (executable(bin)) return bin;
  }
  return null;
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface StatusJson {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
}

/** One probe: the node's state, and whether `serve status` names our port. */
export async function probeTailscale(
  exec: Exec,
  bin: string | null,
  port: number,
  timeoutMs = 3000,
): Promise<TailscaleStatus> {
  if (!bin) return NOT_INSTALLED;
  const st = await exec(bin, ["status", "--json"], { timeoutMs });
  let parsed: StatusJson | null = null;
  try {
    parsed = JSON.parse(st.stdout) as StatusJson;
  } catch {
    parsed = null;
  }
  const running = st.code === 0 && parsed?.BackendState === "Running";
  const out: TailscaleStatus = { installed: true, running, serving: null };
  if (!parsed) return out;
  const dns = parsed.Self?.DNSName?.replace(/\.$/, "");
  if (dns) out.dnsName = dns;
  if (Array.isArray(parsed.Self?.TailscaleIPs)) out.ips = parsed.Self.TailscaleIPs.filter((x) => typeof x === "string");
  if (!running) return out;
  const serve = await exec(bin, ["serve", "status"], { timeoutMs });
  // `serve status` lists each handler as "https://name:443 (tailnet only)" then
  // "|-- / proxy http://127.0.0.1:7373"; the port alone is enough to tell.
  if (serve.code === 0) out.serving = new RegExp(`(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}\\b`).test(serve.stdout);
  return out;
}

export type TailscaleProbe = () => Promise<TailscaleStatus>;

/** The probe the status route calls: one `tailscale` run per `ttlMs` at most. */
export function createTailscaleProbe(
  exec: Exec,
  opts: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string; port: () => number; ttlMs?: number },
): TailscaleProbe {
  const ttl = opts.ttlMs ?? 10_000;
  let at = 0;
  let last: Promise<TailscaleStatus> | null = null;
  return () => {
    const now = Date.now();
    if (last && now - at < ttl) return last;
    at = now;
    const bin = findTailscale(opts.env, opts.platform, opts.home);
    last = probeTailscale(exec, bin, opts.port()).catch(() => NOT_INSTALLED);
    return last;
  };
}
