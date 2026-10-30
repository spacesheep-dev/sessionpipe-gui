// SPDX-License-Identifier: Apache-2.0
// Owned by: onboarding. "This machine", for routes that act on it: loopback, or a
// connection from one of this machine's own addresses (the Mac's browser reaching
// https://<name>.local:7373 arrives from the LAN address, not from 127.0.0.1). Also the
// two lookups the setup page needs about the machine: the sessionpipe CLI, and whether
// a machine name control knows is this one.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isLoopback } from "../http/net.js";
import type { Handler } from "../http/router.js";

/** Every address of this machine's interfaces, IPv4 and IPv6, zone ids dropped. */
export function ownAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs ?? []) out.push(a.address.replace(/%.*$/, ""));
  return out;
}

const plainIp = (ip: string): string => ip.replace(/^::ffff:/i, "").replace(/%.*$/, "");

/** A request from `ip` was made on this machine. */
export function isThisMachine(ip: string, addresses: string[] = ownAddresses()): boolean {
  if (isLoopback(ip)) return true;
  const p = plainIp(ip);
  return addresses.some((a) => plainIp(a) === p);
}

/** The guard every route that acts on this machine wears (the setup actions, the phone
 *  page's Tailscale click): 403 `local_only` for anyone else, UI key or not. With the test
 *  door on, `x-spgui-test-remote` stands in for the remote address (e2e). */
export function thisMachineOnly(o: { testDoor: boolean; port: () => number }): (h: Handler) => Handler {
  return (h) => (ctx) => {
    let ip = ctx.remote.ip;
    if (o.testDoor) {
      const over = ctx.req.headers["x-spgui-test-remote"];
      if (typeof over === "string" && over) ip = over;
    }
    if (!isThisMachine(ip))
      return {
        status: 403,
        json: {
          reason: "local_only",
          error: `Setup acts on the machine running sessionpipe-gui: open http://localhost:${o.port()}/setup there.`,
        },
      };
    return h(ctx);
  };
}

/** Does a machine name (what the daemon calls itself; `session.machine` in events) name
 *  this host? Case-insensitive, with or without the `.local` suffix. */
export function sameMachine(name: string | undefined, hostname: string): boolean {
  if (!name) return false;
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\.local\.?$/, "");
  return norm(name) === norm(hostname);
}

export interface CliInfo {
  path: string;
  version?: string;
}

/** The `sessionpipe` CLI: ~/.local/bin first (where `npx sessionpipe install` puts it),
 *  then the PATH. The version is read from the package beside the real file, not by
 *  running it (the status is polled every two seconds). */
export function findCli(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): CliInfo | null {
  const names = process.platform === "win32" ? ["sessionpipe.cmd", "sessionpipe"] : ["sessionpipe"];
  const dirs = [path.join(home, ".local", "bin"), ...(env.PATH ?? "").split(path.delimiter).filter(Boolean)];
  for (const dir of dirs)
    for (const name of names) {
      const bin = path.join(dir, name);
      try {
        accessSync(bin, constants.X_OK);
      } catch {
        continue;
      }
      return { path: bin, version: cliVersion(bin) };
    }
  return null;
}

/** The script an npm-style `.cmd` shim runs on Windows: the one `"%dp0%\…"` or
 *  `"%~dp0\…"` word before `%*` (npm's cmd-shim, old and new; pnpm's is the same shape),
 *  resolved beside the shim. Null when the file is no such shim, or names nothing there. */
export function cmdShimTarget(shim: string): string | null {
  let text = "";
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return null;
  }
  const m = /"%(?:~dp0|dp0%)\\([^"]+)"\s+%\*/.exec(text);
  if (!m) return null;
  const target = path.resolve(path.dirname(shim), (m[1] as string).split("\\").join(path.sep));
  return existsSync(target) ? target : null;
}

/** How to run the CLI as a child with no shell. A JavaScript entry (the installed CLI is
 *  `#!/usr/bin/env node`; a GUI started by launchd may have no node on its PATH) runs
 *  under our own node. On Windows an `npm install -g` leaves `sessionpipe.cmd`, which
 *  node refuses to spawn bare (CVE-2024-27980): the script the shim names runs under our
 *  node instead. A shim that names no script runs as one quoted command under a shell,
 *  since a shell given the arguments splits one with a space (`--folder C:\sp user\code`)
 *  into two words. */
export function cliCommand(
  cli: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; shell: boolean } {
  try {
    const real = realpathSync(cli);
    if (/\.(c|m)?js$/.test(real)) return { file: process.execPath, args: [real, ...args], shell: false };
  } catch {}
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(cli)) return { file: cli, args, shell: false };
  const target = cmdShimTarget(cli);
  if (target && /\.[cm]?js$/i.test(target)) return { file: process.execPath, args: [target, ...args], shell: false };
  const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
  return { file: [cli, ...args].map(quote).join(" "), args: [], shell: true };
}

export function cliVersion(bin: string): string | undefined {
  try {
    const real = realpathSync(bin);
    let dir = path.dirname(real);
    for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
      const pkg = path.join(dir, "package.json");
      if (!existsSync(pkg)) continue;
      const j = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; version?: string };
      if (j.name === "sessionpipe" && typeof j.version === "string") return j.version;
    }
    // The bundle's first line: "// sessionpipe 0.8.0 · Apache-2.0 · …".
    const m = /sessionpipe (\d+\.\d+\.\d+\S*)/.exec(readFileSync(real, "utf8").slice(0, 400));
    return m?.[1];
  } catch {
    return undefined;
  }
}

export interface ExecResult {
  /** The exit code; null when the command could not run or was killed (see `stderr`). */
  code: number | null;
  stdout: string;
  stderr: string;
}
/** Runs a command to completion. Injectable so tests never touch `security` or the CLI. */
export type Exec = (file: string, args: string[], o?: { timeoutMs?: number }) => Promise<ExecResult>;

export const execDefault: Exec = (file, args, o = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: o.timeoutMs ?? 10_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const code = e ? (typeof e.code === "number" ? e.code : null) : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: `${String(stderr ?? "")}${e && code === null ? `\n${e.message}` : ""}`.trim(),
        });
      },
    );
  });
