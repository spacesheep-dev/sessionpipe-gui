// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. Where the GUI keeps its own state, and the two secrets it
// makes on first run: the sink token (what senders present) and the UI key (what a
// phone presents). Both live in <stateDir>/config.json, mode 0600.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface GuiConfig {
  sinkToken: string;
  uiKey: string;
  createdAt: string;
  /** TLS mode on by default (`--tls` persists true, `--no-tls` false); absent = off. */
  tls?: boolean;
  /** The https origin a trusted reverse proxy on this machine serves from anywhere
   *  (`--public-url`, remembered; `--no-public-url` forgets). Also the passkeys' rp id. */
  publicUrl?: string;
  /** Extensions turned off, as `<kind>:<id>` (`view:canvas`): the way a bundled one, which
   *  cannot be removed, is hidden. Honoured by the registries and the rail. */
  disabled?: string[];
  /** Bundled plugins turned on, as `plugin:<id>`. A plugin that ships with the GUI runs
   *  code and may reach out of the machine (ping-a-human messages a phone), so it stays
   *  off until the person enables it here; an installed plugin needs no entry. */
  enabled?: string[];
  /** Session search reads this machine's own agent history (Claude Code, Codex,
   *  Antigravity, Gemini CLI logs), read-only. Absent = on; Settings ▸ Data turns it off. */
  searchHistory?: boolean;
  /** A spacesheep account used as a backend (server/sources/spacesheep.ts, RFC 08): the
   *  relay's origin, the `gui` key it minted for this install, and who. Absent = off. */
  spacesheep?: SpacesheepLink;
  /** SHA-256 (hex) of the board keys and sink tokens of 16 characters or more this board
   *  replaced, oldest first, the
   *  newest RETIRED_MAX kept: shared by every receiver on the folder and kept across starts,
   *  so none of them is taken from this file again. Never the secrets themselves. */
  retired?: string[];
}

export interface SpacesheepLink {
  origin: string;
  key: string;
  email: string;
  connectedAt: string;
}

/** The link as it is kept, or undefined when the record is not one. */
export function readSpacesheepLink(v: unknown): SpacesheepLink | undefined {
  const r = v as Partial<SpacesheepLink> | null;
  if (!r || typeof r !== "object") return undefined;
  if (typeof r.origin !== "string" || !/^https?:\/\/[^/\s]+$/.test(r.origin)) return undefined;
  if (typeof r.key !== "string" || !/^ss_[A-Za-z0-9_-]{8,}$/.test(r.key)) return undefined;
  if (typeof r.email !== "string" || !r.email) return undefined;
  return {
    origin: r.origin,
    key: r.key,
    email: r.email,
    connectedAt: typeof r.connectedAt === "string" ? r.connectedAt : new Date().toISOString(),
  };
}

export function defaultStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return (
    process.env.SESSIONPIPE_GUI_STATE ??
    (xdg ? path.join(xdg, "sessionpipe-gui") : path.join(os.homedir(), ".local", "state", "sessionpipe-gui"))
  );
}

export const newSinkToken = (): string => `spg_${randomBytes(24).toString("base64url")}`;
export const newUiKey = (): string => randomBytes(12).toString("base64url");
/** The shortest UI key or sink token a running receiver takes from config.json (app.ts
 *  live): it makes 16 and 36 characters. A shorter one is not taken, and is written over. */
export const SECRET_MIN = 16;

/** How many retired secrets config.json remembers. */
export const RETIRED_MAX = 64;
/** A secret's entry in `retired`. */
export const hashSecret = (s: string): string => createHash("sha256").update(s).digest("hex");
/** `retired` as kept: hex SHA-256s only. */
export const readRetired = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) : [];
/** `list` with `secret` added: one shorter than SECRET_MIN is never recorded (its hash
 *  would give a short word back, and a running receiver never takes one anyway). */
export const retire = (list: readonly string[] | undefined, secret: string): string[] =>
  secret.length >= SECRET_MIN ? mergeRetired(list ?? [], [hashSecret(secret)]) : [...(list ?? [])];
/** Two lists as one: `a` in its order, then what only `b` holds; the newest RETIRED_MAX. */
export function mergeRetired(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  for (const h of b) if (!out.includes(h)) out.push(h);
  return out.slice(-RETIRED_MAX);
}

/** config.json (or control/machines.json, control/state.ts) holds something that cannot be
 *  read, and was left as it is. */
export class ConfigError extends Error {
  readonly name = "ConfigError";
}

/** `text` without a leading UTF-8 byte-order mark. PowerShell 5's `UTF8` encoding and
 *  older Windows editors write one, and JSON.parse refuses it. */
export const withoutBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const WHAT_IT_HOLDS =
  "it holds the sink token every sender presents and the UI key every phone and browser holds. " +
  "Fix it, or move it aside to start fresh (senders and phones then pair again), then run this again.";

/** What config.json holds: undefined when it is missing (the first run). A file that
 *  cannot be read (a folder of that name, no permission), is empty (a write that died
 *  before its first byte: the GUI never writes one) or does not parse throws a
 *  ConfigError, saying where but never quoting the text, which can be part of the sink
 *  token: writing fresh secrets over a cut-short, mistyped or unreadable file would lock
 *  out every sender and phone paired with the old ones. */
export function readConfigFile(f: string): Partial<GuiConfig> | undefined {
  let text: string;
  try {
    text = withoutBom(readFileSync(f, "utf8"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new ConfigError(`${f} could not be read (${code}), so it was not written over: ${WHAT_IT_HOLDS}`);
  }
  if (!text.trim()) throw new ConfigError(`${f} is empty, so it was not written over: ${WHAT_IT_HOLDS}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const m = (e as Error).message;
    const at = (/line \d+ column \d+/.exec(m) ?? /position \d+/.exec(m))?.[0];
    throw new ConfigError(
      `${f} is not valid JSON${at ? ` at ${at}` : ""}, so it was not written over: ${WHAT_IT_HOLDS}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ConfigError(`${f} is not a JSON object, so it was not written over: ${WHAT_IT_HOLDS}`);
  return parsed as Partial<GuiConfig>;
}

/** Read the config, making it (or any missing secret) on first run. A file that cannot be
 *  read or does not parse throws a ConfigError and is left byte for byte as it was; one
 *  with a byte-order mark is read past it (and written back without one, the GUI's own
 *  format). A file it reads is also brought to mode 0600 if it is looser (tightenMode). */
export function readGuiConfig(dir: string): GuiConfig {
  const f = path.join(dir, "config.json");
  const cfg = readConfigFile(f) ?? {};
  const complete = typeof cfg.sinkToken === "string" && cfg.sinkToken && typeof cfg.uiKey === "string" && cfg.uiKey;
  const full: GuiConfig = {
    sinkToken: typeof cfg.sinkToken === "string" && cfg.sinkToken ? cfg.sinkToken : newSinkToken(),
    uiKey: typeof cfg.uiKey === "string" && cfg.uiKey ? cfg.uiKey : newUiKey(),
    createdAt: typeof cfg.createdAt === "string" ? cfg.createdAt : new Date().toISOString(),
  };
  if (typeof cfg.tls === "boolean") full.tls = cfg.tls;
  if (typeof cfg.publicUrl === "string" && cfg.publicUrl) full.publicUrl = cfg.publicUrl;
  if (Array.isArray(cfg.disabled)) full.disabled = cfg.disabled.filter((d): d is string => typeof d === "string");
  if (Array.isArray(cfg.enabled)) full.enabled = cfg.enabled.filter((d): d is string => typeof d === "string");
  if (typeof cfg.searchHistory === "boolean") full.searchHistory = cfg.searchHistory;
  const link = readSpacesheepLink(cfg.spacesheep);
  if (link) full.spacesheep = link;
  const retired = readRetired(cfg.retired);
  if (retired.length) full.retired = retired;
  if (!complete) writeGuiConfig(dir, full);
  else tightenMode(f);
  return full;
}

/** The fields this version reads; any other a config.json holds is kept through a write. */
const KNOWN: readonly string[] = [
  "sinkToken",
  "uiKey",
  "createdAt",
  "tls",
  "publicUrl",
  "disabled",
  "enabled",
  "searchHistory",
  "spacesheep",
  "retired",
] satisfies readonly (keyof GuiConfig)[];

/** Write config.json whole, keeping the fields this version does not know (a newer one
 *  wrote them). See writePrivate for how. */
export function writeGuiConfig(dir: string, cfg: GuiConfig): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, "config.json");
  let kept: Record<string, unknown> = {};
  try {
    const disk = readConfigFile(f);
    if (disk) kept = Object.fromEntries(Object.entries(disk).filter(([k]) => !KNOWN.includes(k)));
  } catch {
    // A file that does not read has nothing to keep; the caller decided to write anyway.
  }
  writeIfOther(f, `${JSON.stringify({ ...kept, ...cfg }, null, 2)}\n`);
}

/** The text the last write here was for, to be taken by the writer at once (app.ts
 *  `wrote`: what this process wrote is its own, with no read back that could pick up
 *  another writer's rename). */
let lastWrite: { file: string; text: string } | undefined;
export function takeWrite(f: string): string | undefined {
  const w = lastWrite;
  lastWrite = undefined;
  return w?.file === f ? w.text : undefined;
}

/** Write `text` to `f` only when the file does not already hold exactly that. */
function writeIfOther(f: string, text: string): void {
  lastWrite = { file: f, text };
  try {
    if (readFileSync(f, "utf8") === text) return;
  } catch {}
  writePrivate(f, text);
}

/** Win32 refuses a rename over a file another program holds open for a moment (an editor,
 *  an indexer, an antivirus): tried again a few times before it counts. */
const RENAME_TRIES = 6;

/** Write a file only this user can read, whole: a new file beside it under a random name,
 *  made at 0600 and made by this call alone (O_EXCL, and O_NOFOLLOW where there is one, so
 *  nothing already at that name, a symbolic link included, is written through), flushed to
 *  the disk, then renamed over `f`. A reader sees the old file or the new one, never half;
 *  a symbolic link at `f` itself is replaced, not followed. */
export function writePrivate(f: string, text: string): void {
  const tmp = `${f}.${randomBytes(8).toString("hex")}.tmp`;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let fd: number | undefined = openSync(tmp, flags, 0o600);
  try {
    const buf = Buffer.from(text, "utf8");
    let at = 0;
    while (at < buf.length) at += writeSync(fd, buf, at, buf.length - at);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    for (let i = 1; ; i++) {
      try {
        renameSync(tmp, f);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || i >= RENAME_TRIES || !["EPERM", "EBUSY", "EACCES"].includes(code ?? ""))
          throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * i);
      }
    }
  } catch (e) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  // The rename itself, on disk: the folder's entry, where the platform lets a folder be opened.
  if (process.platform !== "win32") {
    try {
      const d = openSync(path.dirname(f), constants.O_RDONLY);
      try {
        fsyncSync(d);
      } finally {
        closeSync(d);
      }
    } catch {}
  }
}

/** Take the group and other bits off config.json when it is read (a write makes it at
 *  0600 itself): one saved by an editor at its own umask, or restored from a backup, keeps
 *  its bits otherwise. Nothing to do for a file that is not there yet, for a symbolic link
 *  (whatever it points at is not this folder's to change), nor on Windows, where the mode
 *  bits are not the file's access rules. A chmod that fails
 *  (a share that refuses it, a file owned by someone else) warns, once per file in this
 *  process, and goes on: the secrets are already in the file either way. */
const warnedMode = new Set<string>();
export function tightenMode(f: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  try {
    const st = lstatSync(f);
    if (!st.isFile()) return;
    const mode = st.mode & 0o777;
    if ((mode & 0o077) === 0) return;
    chmodSync(f, mode & 0o700);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || warnedMode.has(f)) return;
    warnedMode.add(f);
    process.stderr.write(
      `sessionpipe-gui: could not take the group and other bits off ${f} (${(e as Error).message}); it holds the sink token and the UI key, so make it readable by you alone\n`,
    );
  }
}

/** Write what a setter changed, and only that: config.json is read again just before the
 *  write, the fields that differ between `prev` and `next` are set (or dropped) in what it
 *  holds, and the rest stays as it is on disk. A caller holding a copy read a while ago
 *  (the CLI, a receiver) so never writes back secrets or lists it did not mean to change.
 *  A file that is missing or does not read is written whole from `next`. */
export function writeChanged(dir: string, prev: GuiConfig, next: GuiConfig): void {
  const f = path.join(dir, "config.json");
  let disk: Record<string, unknown> | undefined;
  try {
    disk = readConfigFile(f);
  } catch {
    disk = undefined;
  }
  if (!disk) {
    writeGuiConfig(dir, next);
    return;
  }
  const out: Record<string, unknown> = { ...disk };
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  for (const k of KNOWN) {
    if (k === "retired" || JSON.stringify(a[k]) === JSON.stringify(b[k])) continue;
    if (b[k] === undefined) delete out[k];
    else out[k] = b[k];
  }
  // The retired list only grows: what the file holds and what the writer knows, as one.
  const retired = mergeRetired(readRetired(disk.retired), next.retired ?? []);
  if (retired.length) out.retired = retired;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeIfOther(f, `${JSON.stringify(out, null, 2)}\n`);
}

/** A new sink token, written; the old one stops working at once. */
export function rotateSinkToken(dir: string, cfg: GuiConfig): GuiConfig {
  let sinkToken = newSinkToken();
  while (sinkToken === cfg.sinkToken) sinkToken = newSinkToken();
  const next = { ...cfg, sinkToken, retired: retire(cfg.retired, cfg.sinkToken) };
  writeChanged(dir, cfg, next);
  return next;
}

/** A new UI key, written; the old one stops working at once (server/ui/auth.ts reads
 *  the key on every call). Phones and browsers that came in by link open the new one. */
export function renewUiKey(dir: string, cfg: GuiConfig): GuiConfig {
  let uiKey = newUiKey();
  while (uiKey === cfg.uiKey) uiKey = newUiKey();
  const next = { ...cfg, uiKey, retired: retire(cfg.retired, cfg.uiKey) };
  writeChanged(dir, cfg, next);
  return next;
}

/** Remember `--tls` / `--no-tls`, so a plain `npx sessionpipe-gui` keeps the choice. */
export function setTlsPreference(dir: string, cfg: GuiConfig, on: boolean): GuiConfig {
  const next = { ...cfg, tls: on };
  if (cfg.tls !== on) writeChanged(dir, cfg, next);
  return next;
}

/** Remember `--public-url <url>`, or forget it (`undefined`), so a plain start keeps the choice. */
export function setPublicUrl(dir: string, cfg: GuiConfig, url: string | undefined): GuiConfig {
  if (cfg.publicUrl === url) return cfg;
  const next = { ...cfg };
  if (url) next.publicUrl = url;
  else delete next.publicUrl;
  writeChanged(dir, cfg, next);
  return next;
}

/** Session search's history setting (`POST /api/ui/search/settings`), remembered. */
/** Connect to, or disconnect from, a spacesheep account; written at once. */
export function setSpacesheep(dir: string, cfg: GuiConfig, link: SpacesheepLink | undefined): GuiConfig {
  const next = { ...cfg };
  if (link) next.spacesheep = link;
  else delete next.spacesheep;
  writeChanged(dir, cfg, next);
  return next;
}

export function setSearchHistory(dir: string, cfg: GuiConfig, on: boolean): GuiConfig {
  if ((cfg.searchHistory !== false) === on) return cfg;
  const next = { ...cfg, searchHistory: on };
  writeChanged(dir, cfg, next);
  return next;
}

/** Turn an extension off or on again: `key` is `<kind>:<id>`, e.g. `view:canvas`. */
export function setDisabled(dir: string, cfg: GuiConfig, key: string, off: boolean): GuiConfig {
  const cur = cfg.disabled ?? [];
  const has = cur.includes(key);
  if (has === off) return cfg;
  const disabled = off ? [...cur, key] : cur.filter((k) => k !== key);
  const next: GuiConfig = { ...cfg };
  if (disabled.length) next.disabled = disabled;
  else delete next.disabled;
  writeChanged(dir, cfg, next);
  return next;
}

/** Turn an extension on or off, keeping both lists straight: on takes `key` out of
 *  `disabled` and (for a bundled plugin, which is off until said otherwise) puts it in
 *  `enabled`; off does the reverse. `key` is `<kind>:<id>`, e.g. `plugin:ping-a-human`. */
export function setEnabled(dir: string, cfg: GuiConfig, key: string, on: boolean): GuiConfig {
  const disabled = (cfg.disabled ?? []).filter((k) => k !== key);
  const enabled = (cfg.enabled ?? []).filter((k) => k !== key);
  if (on) enabled.push(key);
  else disabled.push(key);
  const next: GuiConfig = { ...cfg };
  if (disabled.length) next.disabled = disabled;
  else delete next.disabled;
  if (enabled.length) next.enabled = enabled;
  else delete next.enabled;
  if (JSON.stringify(next) !== JSON.stringify(cfg)) writeChanged(dir, cfg, next);
  return next;
}

function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [path.join(here, "..", "package.json"), path.join(here, "..", "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(c, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "sessionpipe-gui" && typeof pkg.version === "string") return pkg.version;
    } catch {}
  }
  return "0.0.0";
}

/** Read once, when the code is loaded: the version this process runs. Read again on every
 *  call (as it was up to 0.8.0), a receiver whose package `npm i -g` replaced under it
 *  answered /api/ui/info with the new version while it still ran the old code. */
const VERSION = readPackageVersion();

/** This package's version, from package.json beside dist/ (or the repo root from source),
 *  as it was when this process loaded it. */
export function packageVersion(): string {
  return VERSION;
}
