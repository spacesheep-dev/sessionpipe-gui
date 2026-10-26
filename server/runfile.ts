// SPDX-License-Identifier: Apache-2.0
// Owned by: packaging. `<state>/run.json`: where a running receiver can be found. Written
// atomically when it listens, removed when it stops cleanly, so the desktop app (and
// anything else on this machine) finds a receiver on a port other than 7373 without
// scanning. A file left behind by a crash names a dead pid, and readers ignore it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const RUN_FILE = "run.json";

export interface RunInfo {
  port: number;
  pid: number;
  version: string;
  /** http://127.0.0.1:<port> */
  url: string;
  /** ISO 8601 */
  startedAt: string;
}

export const runFilePath = (stateDir: string): string => path.join(stateDir, RUN_FILE);

/** Write `run.json`: a temporary file beside it, then a rename, so a reader never sees half of it. */
export function writeRunFile(stateDir: string, info: RunInfo): string {
  mkdirSync(stateDir, { recursive: true });
  const file = runFilePath(stateDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
  return file;
}

/** Is a process with this pid alive? EPERM means it is, and belongs to someone else. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The run file as written, or null when it is missing or malformed. Says nothing about liveness. */
export function readRunFileRaw(stateDir: string): RunInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(runFilePath(stateDir), "utf8"));
  } catch {
    return null;
  }
  const r = raw as Partial<RunInfo>;
  if (
    !r ||
    typeof r !== "object" ||
    !Number.isInteger(r.port) ||
    !Number.isInteger(r.pid) ||
    typeof r.url !== "string" ||
    typeof r.version !== "string" ||
    typeof r.startedAt !== "string"
  )
    return null;
  return { port: r.port!, pid: r.pid!, version: r.version!, url: r.url!, startedAt: r.startedAt! };
}

/** The run file of a live receiver, or null (missing, malformed, or its pid is gone). */
export function readRunFile(stateDir: string, alive: (pid: number) => boolean = pidAlive): RunInfo | null {
  const r = readRunFileRaw(stateDir);
  return r && alive(r.pid) ? r : null;
}

/** Remove the run file, but only when it is ours: a second receiver on the same state dir
 *  that failed to start must not delete the first one's. Returns whether it removed it. */
export function removeRunFile(stateDir: string, pid = process.pid): boolean {
  const r = readRunFileRaw(stateDir);
  if (r && r.pid !== pid) return false;
  try {
    rmSync(runFilePath(stateDir), { force: true });
    return r !== null;
  } catch {
    return false;
  }
}
