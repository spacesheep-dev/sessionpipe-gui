// SPDX-License-Identifier: Apache-2.0
// The files a `start` carries (CONTROL.md §3.1 `files`, HTTP.md §3): the command names
// each file by its SHA-256 and the receiver holds the bytes until the machine fetches
// them with its own token. Here that is one folder, <stateDir>/control/files/, with the
// bytes under the base64url hash and a small JSON beside them (type and expiry):
//
//   control/files/<sha256>       the bytes, 0600
//   control/files/<sha256>.json  { type, size, expiresAt }
//
// An upload lives a day; queuing a start that names it stretches that to the message's
// own expiry, so a file is never gone before the command that needs it (HTTP.md §3).
// One account per GUI, so any machine paired here may fetch any file held here.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { START_FILE_MAX_BYTES } from "../../shared/api.js";

/** An upload is kept this long unless a queued start needs it longer. */
export const FILE_TTL_MS = 24 * 3600_000;
/** At most this much is held at once; an upload past it is refused until older ones expire. */
export const FILES_HELD_MAX_BYTES = 512 * 1024 * 1024;
export const SHA256_RE = /^[A-Za-z0-9_-]{43}$/;
/** CONTROL.md §3.1: a media type `type/subtype`, case aside. */
export const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

interface Meta {
  type: string;
  size: number;
  expiresAt: string;
}

export interface HeldFile {
  path: string;
  type: string;
  size: number;
}

/** base64url SHA-256 without padding: the name CONTROL.md §3.1 gives a file. */
export const fileHash = (b: Uint8Array): string => createHash("sha256").update(b).digest("base64url");

export class FileStore {
  constructor(readonly dir: string) {}

  private bytesPath(sha: string): string {
    return path.join(this.dir, sha);
  }
  private metaPath(sha: string): string {
    return path.join(this.dir, `${sha}.json`);
  }
  private meta(sha: string): Meta | null {
    if (!SHA256_RE.test(sha)) return null;
    try {
      const m = JSON.parse(readFileSync(this.metaPath(sha), "utf8")) as Meta;
      return typeof m.type === "string" && typeof m.size === "number" && typeof m.expiresAt === "string" ? m : null;
    } catch {
      return null;
    }
  }

  /** Holds `bytes` (an upload already within START_FILE_MAX_BYTES) under its hash. The
   *  same bytes twice are one file; the later upload's type and expiry win. */
  put(bytes: Buffer, type: string, now = Date.now()): { sha256: string; size: number } {
    if (bytes.length < 1 || bytes.length > START_FILE_MAX_BYTES) throw new RangeError("size");
    this.sweep(now);
    const sha256 = fileHash(bytes);
    if (!this.has(sha256, now) && this.heldBytes() + bytes.length > FILES_HELD_MAX_BYTES) throw new RangeError("full");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.bytesPath(sha256)}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, this.bytesPath(sha256));
    const old = this.meta(sha256);
    const expiresAt = new Date(Math.max(now + FILE_TTL_MS, old ? Date.parse(old.expiresAt) : 0)).toISOString();
    writeFileSync(this.metaPath(sha256), JSON.stringify({ type, size: bytes.length, expiresAt } satisfies Meta), {
      mode: 0o600,
    });
    return { sha256, size: bytes.length };
  }

  /** Held and not expired. */
  has(sha: string, now = Date.now()): boolean {
    const m = this.meta(sha);
    return !!m && Date.parse(m.expiresAt) > now && existsSync(this.bytesPath(sha));
  }

  /** The file to serve, or undefined when it is not held (never uploaded, or expired). */
  get(sha: string, now = Date.now()): HeldFile | undefined {
    const m = this.meta(sha);
    if (!m || Date.parse(m.expiresAt) <= now || !existsSync(this.bytesPath(sha))) return undefined;
    return { path: this.bytesPath(sha), type: m.type, size: m.size };
  }

  /** Keep `sha` at least until `until` (a queued start's expiry). */
  keepUntil(sha: string, until: string): void {
    const m = this.meta(sha);
    if (!m || Date.parse(m.expiresAt) >= Date.parse(until)) return;
    writeFileSync(this.metaPath(sha), JSON.stringify({ ...m, expiresAt: until } satisfies Meta), { mode: 0o600 });
  }

  private heldBytes(): number {
    if (!existsSync(this.dir)) return 0;
    let n = 0;
    for (const f of readdirSync(this.dir)) if (SHA256_RE.test(f)) n += statSync(path.join(this.dir, f)).size;
    return n;
  }

  /** Expired files go, and so do leftovers (a meta without bytes, a stale temp file). */
  sweep(now = Date.now()): void {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      const full = path.join(this.dir, f);
      if (f.endsWith(".tmp")) {
        if (now - statSync(full).mtimeMs > 3600_000) rmSync(full, { force: true });
        continue;
      }
      const sha = f.endsWith(".json") ? f.slice(0, -5) : f;
      if (!SHA256_RE.test(sha)) continue;
      const m = this.meta(sha);
      if (!m || Date.parse(m.expiresAt) <= now || !existsSync(this.bytesPath(sha))) {
        rmSync(this.bytesPath(sha), { force: true });
        rmSync(this.metaPath(sha), { force: true });
      }
    }
  }
}
