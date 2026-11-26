// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. Resolves an Antigravity subagent or /swarm worker's parent
// conversation UUID from local Antigravity brain files so subagents nest under their
// parent even when events arrive from an older sessionpipe CLI without session.parent_id.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { antigravityDirs } from "../search/sources/homes.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MSG_SENDER_RE = /\[Message\][^\n]*\bsender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

const HEAD_BYTES = 16 * 1024;
const MAX_MESSAGE_FILES = 16;
const MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_NEGATIVE_TTL_MS = 5_000;
const DEFAULT_MAX_CACHE = 2_000;
const TITLE_MAX = 80;

export interface AntigravityParentInfo {
  parentId: string;
  title?: string;
}

export interface AntigravityParentResolverOptions {
  /** Override Antigravity data dirs (defaults to `~/.gemini/antigravity{,-cli,-ide}`). */
  dirs?: () => string[];
  /** Custom clock (tests). */
  now?: () => number;
  /** How long a first negative lookup is cached before a single retry (default 5 s). */
  negativeTtlMs?: number;
  /** Max entries kept in the resolver cache (default 2000). */
  maxEntries?: number;
}

type SqliteRow = Record<string, unknown>;
interface SqliteStatement {
  get(...params: unknown[]): SqliteRow | undefined;
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type DatabaseSyncCtor = new (file: string, opts?: { readOnly?: boolean }) => SqliteDatabase;

let cachedDbCtor: DatabaseSyncCtor | null | undefined;
function getDatabaseSync(): DatabaseSyncCtor | null {
  if (cachedDbCtor !== undefined) return cachedDbCtor;
  try {
    const req = createRequire(import.meta.url);
    const mod = req("node:sqlite") as { DatabaseSync?: DatabaseSyncCtor };
    cachedDbCtor = typeof mod?.DatabaseSync === "function" ? mod.DatabaseSync : null;
  } catch {
    cachedDbCtor = null;
  }
  return cachedDbCtor;
}

function defaultAntigravityDirs(): string[] {
  return antigravityDirs({
    env: process.env,
    home: os.homedir(),
    stateDir: "",
    hostname: "",
    platform: process.platform,
  });
}

function capTitle(raw: string): string | undefined {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  if (clean.length <= TITLE_MAX) return clean;
  let end = TITLE_MAX - 1;
  const floor = Math.max(0, end - 30);
  for (let i = end; i > floor; i--) {
    if (clean.charCodeAt(i) === 32) {
      end = i;
      break;
    }
  }
  return `${clean.slice(0, end).replace(/[\s,;:.-]+$/, "")}…`;
}

/** Extract a clean fallback title (<= 80 chars) from an Antigravity subagent message. */
export function extractAntigravityTitle(raw: string): string | undefined {
  let text = raw.replace(/<\/?SYSTEM_MESSAGE\b[^>]*>/gi, "");
  const msgMatch = /\[Message\][^\n]*?\bcontent=/i.exec(text);
  if (msgMatch) text = text.slice(msgMatch.index + msgMatch[0].length);
  text = text.replace(/<\/?[A-Za-z][A-Za-z0-9_-]*(?:\s[^>]*)?>/g, "");
  const firstLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return undefined;
  const stripped = firstLine
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^you are\s+/i, "")
    .trim();
  return capTitle(stripped);
}

/** Decode a potentially truncated JSON string literal prefix (handles >16 KB SYSTEM_MESSAGE lines). */
function extractTruncatedContent(line: string): string | null {
  const m = /"content"\s*:\s*"/.exec(line);
  if (!m) return null;
  let out = "";
  let i = m.index + m[0].length;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '"') break;
    if (ch === "\\") {
      if (i + 1 >= line.length) break;
      const esc = line[i + 1]!;
      if (esc === "n") {
        out += "\n";
        i += 2;
      } else if (esc === "r") {
        out += "\r";
        i += 2;
      } else if (esc === "t") {
        out += "\t";
        i += 2;
      } else if (esc === '"' || esc === "\\" || esc === "/") {
        out += esc;
        i += 2;
      } else if (esc === "u" && i + 6 <= line.length) {
        const code = Number.parseInt(line.slice(i + 2, i + 6), 16);
        if (Number.isFinite(code)) out += String.fromCharCode(code);
        i += 6;
      } else {
        out += esc;
        i += 2;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Parse the parent UUID (and fallback title) from the head of an Antigravity transcript.jsonl. */
export function parseAntigravityParentFromTranscriptHead(
  head: string,
  id: string,
  truncated = false,
): AntigravityParentInfo | null {
  const lowerId = id.toLowerCase();
  const lines = head.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (truncated && i === lines.length - 1) {
        if (/"type"\s*:\s*"USER_INPUT"/.test(line)) break;
        if (/"type"\s*:\s*"SYSTEM_MESSAGE"/.test(line)) {
          const content = extractTruncatedContent(line);
          if (content) {
            const m = MSG_SENDER_RE.exec(content);
            const sender = m?.[1]?.toLowerCase();
            if (sender && sender !== lowerId) {
              const title = extractAntigravityTitle(content);
              return title ? { parentId: sender, title } : { parentId: sender };
            }
          }
        }
      }
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const rec = parsed as Record<string, unknown>;
    if (rec.type === "USER_INPUT") break;
    if (rec.type === "SYSTEM_MESSAGE" && typeof rec.content === "string") {
      const m = MSG_SENDER_RE.exec(rec.content);
      const sender = m?.[1]?.toLowerCase();
      if (sender && sender !== lowerId) {
        const title = extractAntigravityTitle(rec.content);
        return title ? { parentId: sender, title } : { parentId: sender };
      }
    }
  }
  return null;
}

function readHead(filePath: string): { text: string; truncated: boolean } | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const bytesRead = readSync(fd, buf, 0, HEAD_BYTES, 0);
    if (bytesRead <= 0) return null;
    return { text: buf.subarray(0, bytesRead).toString("utf8"), truncated: bytesRead === HEAD_BYTES };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function checkTranscript(brainDir: string, id: string): AntigravityParentInfo | null {
  for (const rel of [
    path.join(".system_generated", "logs", "transcript.jsonl"),
    path.join("logs", "transcript.jsonl"),
  ]) {
    const filePath = path.join(brainDir, rel);
    const head = readHead(filePath);
    if (!head) continue;
    const hit = parseAntigravityParentFromTranscriptHead(head.text, id, head.truncated);
    if (hit) return hit;
  }
  return null;
}

function checkMessages(brainDir: string, id: string): AntigravityParentInfo | null {
  const msgDir = path.join(brainDir, ".system_generated", "messages");
  let names: string[];
  try {
    names = readdirSync(msgDir)
      .filter((n) => n.endsWith(".json"))
      .sort()
      .slice(0, MAX_MESSAGE_FILES);
  } catch {
    return null;
  }
  const lowerId = id.toLowerCase();
  for (const name of names) {
    const filePath = path.join(msgDir, name);
    try {
      const st = statSync(filePath);
      if (!st.isFile() || st.size > MAX_MESSAGE_BYTES) continue;
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const rec = parsed as Record<string, unknown>;
      const rawSender = typeof rec.sender === "string" ? rec.sender.trim() : "";
      if (!UUID_RE.test(rawSender)) continue;
      const sender = rawSender.toLowerCase();
      if (sender === lowerId) continue;
      const title = typeof rec.content === "string" ? extractAntigravityTitle(rec.content) : undefined;
      return title ? { parentId: sender, title } : { parentId: sender };
    } catch {}
  }
  return null;
}

function checkSummariesDb(dataDir: string, id: string): AntigravityParentInfo | null {
  const dbPath = path.join(dataDir, "conversation_summaries.db");
  if (!existsSync(dbPath)) return null;
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync) return null;
  const lowerId = id.toLowerCase();
  let db: SqliteDatabase | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const stmt = db.prepare(
        "SELECT parent_conversation_id, agent_name, title FROM conversation_summaries WHERE conversation_id = ?",
      );
      const row = stmt.get(id) ?? (lowerId !== id ? stmt.get(lowerId) : undefined);
      const rawParent = typeof row?.parent_conversation_id === "string" ? row.parent_conversation_id.trim() : "";
      if (UUID_RE.test(rawParent) && rawParent.toLowerCase() !== lowerId) {
        const title =
          (typeof row?.title === "string" ? capTitle(row.title) : undefined) ??
          (typeof row?.agent_name === "string" ? capTitle(row.agent_name) : undefined);
        return title ? { parentId: rawParent.toLowerCase(), title } : { parentId: rawParent.toLowerCase() };
      }
    } catch {}
    try {
      const stmt = db.prepare("SELECT parent_id FROM conversation_parents WHERE conversation_id = ?");
      const row = stmt.get(id) ?? (lowerId !== id ? stmt.get(lowerId) : undefined);
      const rawParent = typeof row?.parent_id === "string" ? row.parent_id.trim() : "";
      if (UUID_RE.test(rawParent) && rawParent.toLowerCase() !== lowerId) {
        return { parentId: rawParent.toLowerCase() };
      }
    } catch {}
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
  return null;
}

/** Resolve an Antigravity brain's parent directly from its brain folder (and optional data dir DB). */
export function resolveAntigravityBrainParent(
  brainDir: string,
  id: string,
  dataDir?: string,
): AntigravityParentInfo | null {
  if (!UUID_RE.test(id)) return null;
  const fromTranscript = checkTranscript(brainDir, id);
  if (fromTranscript) return fromTranscript;
  const fromMessages = checkMessages(brainDir, id);
  if (fromMessages) return fromMessages;
  if (dataDir) {
    const fromDb = checkSummariesDb(dataDir, id);
    if (fromDb) return fromDb;
  }
  return null;
}

/** Resolve an Antigravity conversation's parent across local Antigravity data dirs. */
export function resolveAntigravityParent(id: string, dirs?: string[]): AntigravityParentInfo | null {
  if (!UUID_RE.test(id)) return null;
  const searchDirs = dirs ?? defaultAntigravityDirs();
  const lowerId = id.toLowerCase();
  for (const dir of searchDirs) {
    const exact = path.join(dir, "brain", id);
    const brainDir = existsSync(exact) ? exact : lowerId !== id ? path.join(dir, "brain", lowerId) : exact;
    const hit = resolveAntigravityBrainParent(brainDir, id);
    if (hit) return hit;
  }
  for (const dir of searchDirs) {
    const hit = checkSummariesDb(dir, id);
    if (hit) return hit;
  }
  return null;
}

type CacheEntry = { hit: true; info: AntigravityParentInfo } | { hit: false; checkedAt: number; rechecked: boolean };

/** Create a cached parent resolver suitable for `StoreOptions.resolveParent`. */
export function createAntigravityParentResolver(
  opts: AntigravityParentResolverOptions = {},
): (harness: string, id: string) => AntigravityParentInfo | null {
  const getDirs = opts.dirs ?? defaultAntigravityDirs;
  const now = opts.now ?? Date.now;
  const negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_CACHE);
  const cache = new Map<string, CacheEntry>();

  const put = (key: string, entry: CacheEntry) => {
    if (!cache.has(key) && cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, entry);
  };

  return (harness: string, id: string): AntigravityParentInfo | null => {
    if (harness !== "antigravity" || !UUID_RE.test(id)) return null;
    const key = id.toLowerCase();
    const cached = cache.get(key);
    if (cached) {
      if (cached.hit) return cached.info;
      if (cached.rechecked || now() - cached.checkedAt < negativeTtlMs) return null;
      const retry = resolveAntigravityParent(id, getDirs());
      if (retry) {
        put(key, { hit: true, info: retry });
        return retry;
      }
      put(key, { hit: false, checkedAt: now(), rechecked: true });
      return null;
    }
    const found = resolveAntigravityParent(id, getDirs());
    if (found) {
      put(key, { hit: true, info: found });
      return found;
    }
    put(key, { hit: false, checkedAt: now(), rechecked: false });
    return null;
  };
}
