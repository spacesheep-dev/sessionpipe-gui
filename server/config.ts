// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. Where the GUI keeps its own state, and the two secrets it
// makes on first run: the sink token (what senders present) and the UI key (what a
// phone presents). Both live in <stateDir>/config.json, mode 0600.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Read the config, making it (or any missing secret) on first run. */
export function readGuiConfig(dir: string): GuiConfig {
  const f = path.join(dir, "config.json");
  let cfg: Partial<GuiConfig> = {};
  if (existsSync(f)) {
    try {
      cfg = JSON.parse(readFileSync(f, "utf8")) as Partial<GuiConfig>;
    } catch {
      cfg = {};
    }
  }
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
  if (!complete) writeGuiConfig(dir, full);
  return full;
}

export function writeGuiConfig(dir: string, cfg: GuiConfig): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "config.json"), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

/** A new sink token, written; the old one stops working at once. */
export function rotateSinkToken(dir: string, cfg: GuiConfig): GuiConfig {
  const next = { ...cfg, sinkToken: newSinkToken() };
  writeGuiConfig(dir, next);
  return next;
}

/** Remember `--tls` / `--no-tls`, so a plain `npx sessionpipe-gui` keeps the choice. */
export function setTlsPreference(dir: string, cfg: GuiConfig, on: boolean): GuiConfig {
  const next = { ...cfg, tls: on };
  if (cfg.tls !== on) writeGuiConfig(dir, next);
  return next;
}

/** Remember `--public-url <url>`, or forget it (`undefined`), so a plain start keeps the choice. */
export function setPublicUrl(dir: string, cfg: GuiConfig, url: string | undefined): GuiConfig {
  if (cfg.publicUrl === url) return cfg;
  const next = { ...cfg };
  if (url) next.publicUrl = url;
  else delete next.publicUrl;
  writeGuiConfig(dir, next);
  return next;
}

/** Session search's history setting (`POST /api/ui/search/settings`), remembered. */
export function setSearchHistory(dir: string, cfg: GuiConfig, on: boolean): GuiConfig {
  if ((cfg.searchHistory !== false) === on) return cfg;
  const next = { ...cfg, searchHistory: on };
  writeGuiConfig(dir, next);
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
  writeGuiConfig(dir, next);
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
  if (JSON.stringify(next) !== JSON.stringify(cfg)) writeGuiConfig(dir, next);
  return next;
}

/** This package's version, from package.json beside dist/ (or the repo root from source). */
export function packageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [path.join(here, "..", "package.json"), path.join(here, "..", "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(c, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "sessionpipe-gui" && typeof pkg.version === "string") return pkg.version;
    } catch {}
  }
  return "0.0.0";
}
