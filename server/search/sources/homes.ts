// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. Where each harness keeps its history on this machine
// (sources.md §2–§5). Every function takes the SourceEnv, never the real process, so
// tests and demos point them at a synthetic home (SEARCH-SPEC.md D14).
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { SourceEnv } from "../types.js";

export interface ClaudeHome {
  /** The config dir (`~/.claude`, `~/.claude-work`, `$CLAUDE_CONFIG_DIR`). */
  dir: string;
  /** `work` for ~/.claude-work; absent for the default home. */
  account?: string;
  /** The default home (`~/.claude` with no CLAUDE_CONFIG_DIR pointing elsewhere). */
  isDefault: boolean;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** A home's label: `~/.claude-work` → `work`, `/data/claude.alt` → `alt`. */
export function accountLabel(dir: string): string {
  const base = path.basename(dir).replace(/^\./, "");
  return base.replace(/^claude[-_.]?/, "") || base;
}

/**
 * Every Claude Code config dir: `~/.claude`, `$CLAUDE_CONFIG_DIR`, and every
 * `~/.claude[-_.]*` directory holding `projects/` (14 `.claude.json*` files sit beside
 * them on a real Mac, so a match must be a directory). The default home is the one
 * `claude` uses with no CLAUDE_CONFIG_DIR: `~/.claude`.
 */
export function claudeHomes(env: SourceEnv): ClaudeHome[] {
  const seen = new Set<string>();
  const out: ClaudeHome[] = [];
  const def = path.join(env.home, ".claude");
  const add = (dir: string) => {
    const d = path.resolve(dir);
    if (seen.has(d) || !isDir(path.join(d, "projects"))) return;
    seen.add(d);
    const isDefault = d === def;
    out.push(isDefault ? { dir: d, isDefault } : { dir: d, isDefault, account: accountLabel(d) });
  };
  add(def);
  const cfg = env.env.CLAUDE_CONFIG_DIR;
  if (cfg) add(cfg.startsWith("~") ? path.join(env.home, cfg.slice(1)) : cfg);
  let names: string[] = [];
  try {
    names = readdirSync(env.home);
  } catch {}
  for (const n of names.sort())
    if (/^\.claude[-_.]/.test(n) && !n.startsWith(".claude.json")) add(path.join(env.home, n));
  return out;
}

/** `$CODEX_HOME`, else `~/.codex`. */
export function codexHome(env: SourceEnv): string {
  const h = env.env.CODEX_HOME;
  return h ? path.resolve(h.startsWith("~") ? path.join(env.home, h.slice(1)) : h) : path.join(env.home, ".codex");
}

/** `$GEMINI_CLI_HOME` resolved (`~` is the home), or undefined when unset. */
function geminiCliHome(env: SourceEnv): string | undefined {
  const h = env.env.GEMINI_CLI_HOME;
  return h ? path.resolve(h.startsWith("~") ? path.join(env.home, h.slice(1)) : h) : undefined;
}

/** Gemini CLI's `.gemini` folder: `$GEMINI_CLI_HOME/.gemini`, else `~/.gemini`. Gemini CLI
 *  reads GEMINI_CLI_HOME as the home that holds `.gemini`, not as `.gemini` itself. */
export function geminiHome(env: SourceEnv): string {
  return path.join(geminiCliHome(env) ?? env.home, ".gemini");
}

/** Antigravity's data dirs: `antigravity`, `antigravity-cli`, `antigravity-ide` under ~/.gemini.
 *  With GEMINI_CLI_HOME set they are looked for directly under it, as before: whether
 *  Antigravity reads that variable at all is unverified, so its folders stay where they were. */
export function antigravityDirs(env: SourceEnv): string[] {
  const g = geminiCliHome(env) ?? path.join(env.home, ".gemini");
  return ["antigravity", "antigravity-cli", "antigravity-ide"].map((n) => path.join(g, n)).filter(isDir);
}

/** readdir that never throws (a missing folder is an empty list). */
export function list(dir: string): import("node:fs").Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
