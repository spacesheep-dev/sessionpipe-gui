// SPDX-License-Identifier: Apache-2.0
// Owned by: onboarding. Tailscale on this machine, as far as the setup page's "From
// anywhere" step needs: installed, connected, this node's MagicDNS name, and whether
// `tailscale serve` already forwards to our port. Read from the `tailscale` CLI alone
// (`status --json`, `serve status`); the one thing that changes anything is
// `serveTailscale` (`serve --bg <port>`), the phone page's one click. The probe is
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

/** `fresh` skips the cache: right after `serveTailscale`, so `serving` tells the truth. */
export type TailscaleProbe = (o?: { fresh?: boolean }) => Promise<TailscaleStatus>;

export class TailscaleError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The last few lines of what a command printed, for an error a person reads. */
export function stderrTail(r: { stderr: string; stdout: string; code: number | null }, lines = 6): string {
  const text = (r.stderr.trim() || r.stdout.trim()).split("\n").filter(Boolean);
  const tail = text.slice(-lines).join("\n");
  return tail || `tailscale exited ${r.code ?? "without a code"}`;
}

/** `tailscale serve --bg <port>`: https://<MagicDNS name> on the tailnet forwards to our
 *  port, remembered by tailscaled across restarts. Skipped when a probe already shows the
 *  port served. Answers the fresh status; throws TailscaleError (409 when Tailscale is not
 *  there or not connected, 502 when the CLI refused) with the CLI's own last lines. */
export async function serveTailscale(
  exec: Exec,
  bin: string | null,
  port: number,
  probe: TailscaleProbe,
  timeoutMs = 15_000,
): Promise<TailscaleStatus> {
  const before = await probe({ fresh: true });
  if (!bin || !before.installed) throw new TailscaleError(409, "Tailscale is not installed on this machine.");
  if (!before.running)
    throw new TailscaleError(409, "Tailscale is installed but not connected: open the app and sign in.");
  if (!before.dnsName) throw new TailscaleError(409, "Tailscale gave this machine no MagicDNS name yet.");
  if (!before.serving) {
    const r = await exec(bin, ["serve", "--bg", String(port)], { timeoutMs });
    if (r.code !== 0) throw new TailscaleError(502, stderrTail(r));
  }
  const after = await probe({ fresh: true });
  if (!after.serving)
    throw new TailscaleError(502, "tailscale serve returned, but `serve status` does not show this port yet.");
  return after;
}

/** The probe the status route calls: one `tailscale` run per `ttlMs` at most. */
export function createTailscaleProbe(
  exec: Exec,
  opts: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string; port: () => number; ttlMs?: number },
): TailscaleProbe {
  const ttl = opts.ttlMs ?? 10_000;
  let at = 0;
  let last: Promise<TailscaleStatus> | null = null;
  return (o = {}) => {
    const now = Date.now();
    if (last && !o.fresh && now - at < ttl) return last;
    at = now;
    const bin = findTailscale(opts.env, opts.platform, opts.home);
    last = probeTailscale(exec, bin, opts.port()).catch(() => NOT_INSTALLED);
    return last;
  };
}
