// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. How a command on this computer reaches the receiver that serves a
// state folder, whatever address it is bound to: each receiver, once it listens, writes
// `<state>/run/<pid>-<port>.json` (0600, this user alone) with its port, the addresses it
// answers on and a secret made for this run, and takes it away when it stops. A request
// that carries the secret in DOOR_HEADER was made by someone who can read this user's state
// folder; `POST /api/ui/key/renew` takes it, and judges a request that brings the header
// by it alone (another receiver's door is refused, never taken as this computer). A file a
// crash left names a dead pid, and readers pass it.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { writePrivate } from "./config.js";
import { secretEquals } from "./control/routes.js";
import type { Ctx } from "./http/router.js";
import { pidAlive } from "./runfile.js";

export const DOOR_HEADER = "x-sessionpipe-gui-local";

export interface Door {
  pid: number;
  port: number;
  /** Where it answers from this computer, most likely first. */
  urls: string[];
  /** Where this computer opens the board with no key (Info.urls.local). */
  home: string;
  secret: string;
}

export const doorsDir = (stateDir: string): string => path.join(stateDir, "run");

/** Write this receiver's door; `close` takes it away. */
export function openDoor(
  stateDir: string,
  port: number,
  urls: string[],
  home: string,
): { secret: string; close(): void } {
  const secret = randomBytes(24).toString("base64url");
  const dir = doorsDir(stateDir);
  const file = path.join(dir, `${process.pid}-${port}.json`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // What a receiver that did not stop cleanly left: its pid is gone.
  for (const n of readdirSync(dir)) {
    const pid = Number(/^(\d+)-\d+\.json$/.exec(n)?.[1]);
    if (pid && pid !== process.pid && !pidAlive(pid)) rmSync(path.join(dir, n), { force: true });
  }
  const door: Door = { pid: process.pid, port, urls, home, secret };
  writePrivate(file, `${JSON.stringify(door)}\n`);
  return {
    secret,
    close: () => rmSync(file, { force: true }),
  };
}

/** The doors of the receivers alive on this state folder. */
export function listDoors(stateDir: string, alive: (pid: number) => boolean = pidAlive): Door[] {
  let names: string[];
  try {
    names = readdirSync(doorsDir(stateDir)).filter((n) => /^\d+-\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const out: Door[] = [];
  for (const n of names) {
    try {
      const d = JSON.parse(readFileSync(path.join(doorsDir(stateDir), n), "utf8")) as Partial<Door>;
      if (
        Number.isInteger(d.pid) &&
        Number.isInteger(d.port) &&
        Array.isArray(d.urls) &&
        d.urls.every((u) => typeof u === "string") &&
        typeof d.secret === "string" &&
        d.secret &&
        alive(d.pid!)
      )
        out.push({ ...(d as Door), home: typeof d.home === "string" ? d.home : `http://localhost:${d.port}` });
    } catch {}
  }
  return out;
}

/** Does this request carry this receiver's secret (and did it not come through a proxy)? */
export function throughDoor(ctx: Ctx, secret: string): boolean {
  if (ctx.remote.forwarded) return false;
  const h = ctx.req.headers[DOOR_HEADER];
  return typeof h === "string" && secretEquals(h, secret);
}
