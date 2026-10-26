// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. What the engine and the service import from the sources
// (SEARCH-SPEC.md §3.1): the history adapters, the sessionpipe events adapter, the
// store's file path for a key, and the environment every adapter reads from.
import os from "node:os";
import path from "node:path";
import { safeName } from "../../store/files.js";
import type { SessionKey, SourceAdapter, SourceEnv } from "../types.js";
import { antigravityAdapter } from "./antigravity.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { eventsAdapter as makeEventsAdapter } from "./events.js";
import { geminiAdapter } from "./gemini.js";

/** This machine's own agent history: Claude Code, Codex, Antigravity, Gemini CLI. A new
 *  set each call (adapters keep small in-process caches). */
export function historyAdapters(): SourceAdapter[] {
  return [claudeAdapter(), codexAdapter(), antigravityAdapter(), geminiAdapter()];
}

/** What sessionpipe delivered: `<stateDir>/events/<harness>/<id>.jsonl`, at its tier. */
export function eventsAdapter(): SourceAdapter {
  return makeEventsAdapter();
}

/** The store's file for a session key (server/store/files.ts `EventFiles.file`). */
export function eventsPath(stateDir: string, key: SessionKey): string {
  const i = key.indexOf(":");
  const harness = i < 0 ? key : key.slice(0, i);
  const id = i < 0 ? "" : key.slice(i + 1);
  return path.join(stateDir, "events", safeName(harness), `${safeName(id)}.jsonl`);
}

/** The environment adapters read: `home` defaults to os.homedir() (`--search-home` /
 *  SPGUI_SEARCH_HOME point it at a synthetic home). */
export function sourceEnv(opts: { home?: string; stateDir: string; hostname: string }): SourceEnv {
  const home = opts.home ? path.resolve(opts.home) : os.homedir();
  // A synthetic home must not pick up the real CLAUDE_CONFIG_DIR / CODEX_HOME / GEMINI_CLI_HOME.
  const env: Record<string, string | undefined> = { ...process.env };
  if (opts.home) {
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CODEX_HOME;
    delete env.GEMINI_CLI_HOME;
  }
  return { home, stateDir: path.resolve(opts.stateDir), hostname: opts.hostname, env, platform: process.platform };
}
