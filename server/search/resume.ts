// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service. A ResumeSpec (sources) → the one line a person pastes into a
// terminal (SEARCH-SPEC D10): `cd '<cwd>' && [CLAUDE_CONFIG_DIR=~/.claude-work ]claude --resume <id>`,
// `codex resume <id>`. POSIX sh quoting: single quotes, `'` written as `'\''`.
import path from "node:path";
import type { ResumeSpec } from "./types.js";

/** Characters a shell word may hold without quoting. */
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `s` single-quoted for sh, unless it needs no quoting at all. */
export function shQuote(s: string): string {
  if (s !== "" && SAFE.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Always single-quoted (the folder after `cd`, so a space or `$` never splits it). */
export function shQuoteAlways(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** A path under `home` as `~/rest` (the tilde unquoted so the shell expands it), else quoted. */
export function homePath(p: string, home?: string): string {
  if (home) {
    const h = home.endsWith(path.sep) ? home.slice(0, -1) : home;
    if (p === h) return "~";
    if (p.startsWith(`${h}/`)) {
      const rest = p.slice(h.length + 1);
      return SAFE.test(rest) ? `~/${rest}` : `~/${shQuoteAlways(rest)}`;
    }
  }
  return shQuote(p);
}

/** The folder after `cd`: single-quoted, except a leading `~/` (sessionpipe sends `~/proj`)
 *  which stays outside the quotes so the shell expands it. */
function cdTarget(cwd: string): string {
  if (cwd === "~") return "~";
  if (cwd.startsWith("~/")) return `~/${shQuoteAlways(cwd.slice(2))}`;
  return shQuoteAlways(cwd);
}

/** The verified command for a harness, when the logs gave none (a session sessionpipe
 *  delivered from any machine): Claude Code in its folder, Codex by id. Others: none (D10). */
export function fallbackResume(harness: string, id: string, cwd?: string): ResumeSpec | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return undefined;
  if (harness === "claude-code") return { argv: ["claude", "--resume", id], ...(cwd ? { cwd } : {}) };
  if (harness === "codex") return { argv: ["codex", "resume", id] };
  return undefined;
}

/** The line, or undefined when there is nothing verified to run. */
export function resumeLine(spec: ResumeSpec | undefined, home?: string): string | undefined {
  if (!spec || !Array.isArray(spec.argv) || spec.argv.length === 0) return undefined;
  if (spec.argv.some((a) => typeof a !== "string" || a.includes("\n") || a.includes("\0"))) return undefined;
  const parts: string[] = [];
  if (spec.cwd && !spec.cwd.includes("\n")) parts.push(`cd ${cdTarget(spec.cwd)} && `);
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (!ENV_NAME.test(k) || typeof v !== "string" || v.includes("\n")) continue;
    parts.push(`${k}=${v.startsWith("/") ? homePath(v, home) : shQuote(v)} `);
  }
  parts.push(spec.argv.map(shQuote).join(" "));
  return parts.join("");
}
