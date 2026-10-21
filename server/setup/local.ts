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
