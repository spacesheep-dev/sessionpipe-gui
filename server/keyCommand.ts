// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. `sessionpipe-gui key renew`: a new key for the board (the UI key
// every phone and browser that came in by link or QR holds).
//
// Only a folder that holds a board (config.json) is touched; none is ever made. A receiver
// that serves the folder is asked, and applies it at once: by its door in `<state>/run/`
// (localDoor.ts), which also reaches it under `--host <address>`; or, when it left no door
// (an older one, or one that could not write it), over loopback, found by run.json or on
// the port. Success is said only once config.json holds a key other than the one before.
// A run file whose receiver does not answer is from an earlier run, and is passed. A
// receiver on the port that serves another folder means nothing is changed, and it says
// which. Only when no receiver serves the folder is config.json written here; a folder it
// cannot write is said in one line, not as an error stack.
//
// It prints no key and no link that holds one.
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { DEFAULT_PORT, type Info, ROUTES } from "../shared/api.js";
import { readConfigFile, readGuiConfig, renewUiKey } from "./config.js";
import { DOOR_HEADER, listDoors } from "./localDoor.js";
import { readRunFile } from "./runfile.js";

export interface KeyCommandIo {
  stateDir: string;
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  /** Tests: how a running receiver is reached. */
  fetch?: typeof fetch;
  /** Tests: whether a pid is alive. */
  alive?: (pid: number) => boolean;
  /** The port probed when no receiver left a door or a run.json (`--port`, else 7373). */
  probePort?: number;
}

/** What it says when the receiver serving the folder took the new key. */
export const renewed = (home: string): string =>
  `The board has a new key. Phones and browsers that came in by the old link are asked for the new one; Connect at ${home}/connect on this computer shows it.`;
export const RENEWED_LATER =
  "The board has a new key, in config.json; a receiver of this version serving this folder takes it within a few seconds; any other at its next start.";

/** Runs `key <verb>`; the answer is the exit code. */
export async function runKeyCommand(verb: string | undefined, io: KeyCommandIo): Promise<number> {
  const out = (s: string) => io.stdout.write(`${s}\n`);
  const err = (s: string) => io.stderr.write(`sessionpipe-gui: ${s}\n`);
  if (verb !== "renew") {
    err(`unknown key command "${verb ?? ""}" (renew)`);
    return 2;
  }
  const dir = path.resolve(io.stateDir);
  const file = path.join(dir, "config.json");
  if (!existsSync(file)) {
    err(`no board in ${dir}: it holds no config.json. Nothing was changed.`);
    return 1;
  }
  const keyNow = (): string | undefined => {
    try {
      const k = readConfigFile(file)?.uiKey;
      return typeof k === "string" ? k : undefined;
    } catch {
      return undefined;
    }
  };
  const before = keyNow();
  /** Before saying nothing changed: config.json is read again, and a key that did change
   *  (a receiver that applied it but answered late or with an error) is said as such. */
  const unchanged = (msg: string, home: string): number => {
    if (keyNow() !== before) {
      out(renewed(home));
      return 0;
    }
    err(msg);
    return 1;
  };
  /** Folders compared by where they really are (a symlinked --state is the same folder). */
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const http = io.fetch ?? fetch;
  const ask = async (url: string, init?: RequestInit): Promise<Response | null> => {
    try {
      // A receiver under load takes seconds to write and flush config.json.
      return await http(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch {
      return null;
    }
  };

  const doors = listDoors(dir, io.alive);
  // 1. A receiver's door: its secret, on the addresses it named.
  for (const door of doors)
    for (const url of door.urls) {
      const r = await ask(`${url}${ROUTES.ui.renewKey}`, { method: "POST", headers: { [DOOR_HEADER]: door.secret } });
      if (keyNow() !== before) {
        out(renewed(door.home));
        return 0;
      }
      if (r?.status !== 204) continue;
      return unchanged(
        `the receiver on port ${door.port} answered but ${dir} has the same key; nothing was changed.`,
        door.home,
      );
    }
  if (doors.length)
    err(
      `no receiver for ${dir} answered at the address its run file names (port ${doors.map((d) => d.port).join(", ")}); the file is from an earlier run.`,
    );
  // 2. A receiver on this computer that left no door (an older one, or one that could not
  // write it): found by run.json or on the port, and asked over loopback, which it takes.
  const run = readRunFile(dir, io.alive);
  const ports = [...new Set([...(run ? [run.port] : []), io.probePort ?? DEFAULT_PORT])];
  let elsewhere: { port: number; dir: string } | null = null;
  for (const port of ports) {
    const base = `http://127.0.0.1:${port}`;
    const r = await ask(`${base}${ROUTES.ui.info}`);
    if (!r?.ok) continue;
    const info = (await r.json().catch(() => null)) as Info | null;
    if (info?.name !== "sessionpipe-gui" || typeof info.storage?.dir !== "string") continue;
    const serves = path.resolve(info.storage.dir);
    if (real(serves) !== real(dir)) {
      elsewhere ??= { port, dir: serves };
      continue;
    }
    const renew = await ask(`${base}${ROUTES.ui.renewKey}`, { method: "POST" });
    return unchanged(
      `the receiver on port ${port} serves ${dir} but did not take a new key (it answered ${renew?.status ?? "nothing"}); nothing was changed.`,
      typeof info.urls?.local === "string" ? info.urls.local : `http://localhost:${port}`,
    );
  }
  if (elsewhere)
    return unchanged(
      `the receiver on port ${elsewhere.port} serves ${elsewhere.dir}, not ${dir}; nothing was changed.`,
      `http://localhost:${elsewhere.port}`,
    );
  // 3. No receiver serves the folder: config.json holds the new key. A folder it cannot
  // write (read-only, another account's, a full disk) is said in one line; writePrivate
  // leaves no file of its own behind. The key is said to be unchanged only when
  // config.json still holds the one before (readGuiConfig completing a file without a key
  // may have written one first). A config.json that does not read is a ConfigError,
  // which has no code and is said by the CLI.
  try {
    renewUiKey(dir, readGuiConfig(dir));
  } catch (e) {
    // A write the system refused carries the call it failed in; anything else (a
    // programming error, Node's own ERR_ codes included) is thrown on, with its stack.
    const { code, syscall } = e as NodeJS.ErrnoException;
    if (typeof code !== "string" || typeof syscall !== "string") throw e;
    err(`${dir} could not be written (${code})${keyNow() === before ? "; the key was not changed" : ""}.`);
    return 1;
  }
  out(RENEWED_LATER);
  return 0;
}
