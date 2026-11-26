// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAntigravityParentResolver,
  extractAntigravityTitle,
  resolveAntigravityParent,
} from "./antigravityParent.js";

const PARENT = "8f78dc26-6620-41cd-bf87-91c7a3dde24e";
const CHILD = "e418f517-de91-4b55-80d8-20d82e8b440a";
const OTHER = "11111111-2222-4333-8444-555555555555";

let root: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "spgui-ag-parent-"));
  dataDir = path.join(root, "antigravity-cli");
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeTranscript(id: string, lines: unknown[], legacyPath = false): string {
  const dir = legacyPath
    ? path.join(dataDir, "brain", id, "logs")
    : path.join(dataDir, "brain", id, ".system_generated", "logs");
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "transcript.jsonl");
  writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return p;
}

function writeMessage(id: string, filename: string, body: unknown): string {
  const dir = path.join(dataDir, "brain", id, ".system_generated", "messages");
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, filename);
  writeFileSync(p, JSON.stringify(body));
  return p;
}

type SqliteDb = { exec(sql: string): void; close(): void };
type SqliteCtor = new (file: string) => SqliteDb;

function loadSqliteCtor(): SqliteCtor | null {
  try {
    const req = createRequire(import.meta.url);
    const mod = req("node:sqlite") as { DatabaseSync?: SqliteCtor };
    return typeof mod?.DatabaseSync === "function" ? mod.DatabaseSync : null;
  } catch {
    return null;
  }
}

describe("antigravityParent", () => {
  it("resolves parent and fallback title from transcript.jsonl SYSTEM_MESSAGE", () => {
    writeTranscript(CHILD, [
      {
        type: "SYSTEM_MESSAGE",
        content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T12:35:16Z sender=${PARENT} priority=HIGH content=You are the **GUI Subagents Engineer**. Implement parent nesting.\nSecond line ignored.\n</SYSTEM_MESSAGE>`,
      },
      { type: "PLANNER_RESPONSE", content: "On it." },
    ]);
    expect(resolveAntigravityParent(CHILD, [dataDir])).toEqual({
      parentId: PARENT,
      title: "the GUI Subagents Engineer. Implement parent nesting.",
    });
  });

  it("supports fallback brain/<id>/logs/transcript.jsonl and huge >16 KB SYSTEM_MESSAGE lines", () => {
    const padding = "x".repeat(20_000);
    writeTranscript(
      CHILD,
      [
        {
          type: "SYSTEM_MESSAGE",
          content: `[Message] timestamp=2026-11-26T12:35:16Z sender=${PARENT.toUpperCase()} content=You are **Worker Alpha**\n${padding}`,
        },
      ],
      true,
    );
    expect(resolveAntigravityParent(CHILD, [dataDir])).toEqual({
      parentId: PARENT,
      title: "Worker Alpha",
    });
  });

  it("stops scanning transcript at USER_INPUT so top-level sessions return null", () => {
    writeTranscript(CHILD, [
      { type: "USER_INPUT", content: "<USER_REQUEST>Build a dashboard</USER_REQUEST>" },
      {
        type: "SYSTEM_MESSAGE",
        content: `[Message] sender=${PARENT} content=Subagent reply arrived later`,
      },
    ]);
    expect(resolveAntigravityParent(CHILD, [dataDir])).toBeNull();
  });

  it("falls back to .system_generated/messages/*.json and skips oversized files", () => {
    // Oversized file (> 256 KB) should be skipped
    writeMessage(CHILD, "01-big.json", {
      sender: OTHER,
      content: "a".repeat(300 * 1024),
    });
    // Non-UUID sender should be skipped
    writeMessage(CHILD, "02-user.json", {
      sender: "user",
      content: "Hello",
    });
    // Valid UUID sender should match
    writeMessage(CHILD, "03-parent.json", {
      sender: PARENT,
      content: "You are **Codebase Researcher**. Inspect the store.",
    });
    expect(resolveAntigravityParent(CHILD, [dataDir])).toEqual({
      parentId: PARENT,
      title: "Codebase Researcher. Inspect the store.",
    });
  });

  it("resolves forked /swarm workers from conversation_summaries.db when node:sqlite is available", () => {
    const DatabaseSync = loadSqliteCtor();
    if (!DatabaseSync) return;
    const dbPath = path.join(dataDir, "conversation_summaries.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          parent_conversation_id TEXT,
          agent_name TEXT,
          title TEXT
        );
        CREATE TABLE conversation_parents (
          conversation_id TEXT PRIMARY KEY,
          parent_id TEXT
        );
        INSERT INTO conversation_summaries VALUES ('${CHILD}', '${PARENT}', 'worker-1', 'Fix sidebar nesting');
        INSERT INTO conversation_parents VALUES ('${OTHER}', '${PARENT}');
      `);
    } finally {
      db.close();
    }
    // Forked worker whose transcript starts with USER_INPUT (no SYSTEM_MESSAGE)
    writeTranscript(CHILD, [{ type: "USER_INPUT", content: "<USER_REQUEST>Original prompt</USER_REQUEST>" }]);
    expect(resolveAntigravityParent(CHILD, [dataDir])).toEqual({
      parentId: PARENT,
      title: "Fix sidebar nesting",
    });
    // Fallback to conversation_parents table
    expect(resolveAntigravityParent(OTHER, [dataDir])).toEqual({
      parentId: PARENT,
    });
  });

  it("rejects self-parent in transcript, messages, and sqlite DB, and rejects non-UUID ids", () => {
    expect(resolveAntigravityParent("not-a-uuid", [dataDir])).toBeNull();
    writeTranscript(CHILD, [{ type: "SYSTEM_MESSAGE", content: `[Message] sender=${CHILD} content=Self reference` }]);
    writeMessage(CHILD, "m1.json", { sender: CHILD, content: "Self reference" });
    expect(resolveAntigravityParent(CHILD, [dataDir])).toBeNull();
  });

  it("extracts clean fallback titles stripped of wrappers, tags, markdown, and capped at 80 chars", () => {
    expect(
      extractAntigravityTitle(
        "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-01 sender=8f78dc26-6620-41cd-bf87-91c7a3dde24e content=\n\n<role>You are **Search Indexer**</role>\nDetails below\n</SYSTEM_MESSAGE>",
      ),
    ).toBe("Search Indexer");
    const long = extractAntigravityTitle(
      `[Message] sender=${PARENT} content=You are responsible for implementing a very long and detailed migration across every single module in the repository`,
    );
    expect(long).toBeDefined();
    expect(long!.length).toBeLessThanOrEqual(80);
    expect(long!.endsWith("…")).toBe(true);
    expect(extractAntigravityTitle("<SYSTEM_MESSAGE>   </SYSTEM_MESSAGE>")).toBeUndefined();
  });

  it("caches positive hits permanently, caches negative misses for 5s, and retries once after 5s", () => {
    let clock = 1_000;
    let dirCalls = 0;
    const resolve = createAntigravityParentResolver({
      dirs: () => {
        dirCalls++;
        return [dataDir];
      },
      now: () => clock,
    });

    // Non-antigravity harness short-circuits immediately
    expect(resolve("claude-code", CHILD)).toBeNull();
    expect(dirCalls).toBe(0);

    // First miss (transcript not yet written)
    expect(resolve("antigravity", CHILD)).toBeNull();
    expect(dirCalls).toBe(1);

    // Within 5s: still cached as null without touching disk
    clock += 4_999;
    writeTranscript(CHILD, [{ type: "SYSTEM_MESSAGE", content: `[Message] sender=${PARENT} content=Late brief` }]);
    expect(resolve("antigravity", CHILD)).toBeNull();
    expect(dirCalls).toBe(1);

    // At 5s: retries once and upgrades to permanent positive hit
    clock += 1;
    expect(resolve("antigravity", CHILD)).toEqual({ parentId: PARENT, title: "Late brief" });
    expect(dirCalls).toBe(2);

    // Subsequent calls hit cache permanently without re-reading disk
    clock += 60_000;
    expect(resolve("antigravity", CHILD)).toEqual({ parentId: PARENT, title: "Late brief" });
    expect(dirCalls).toBe(2);

    // A permanently top-level session only retries once after 5s, then stays negative-cached
    expect(resolve("antigravity", OTHER)).toBeNull();
    expect(dirCalls).toBe(3);
    clock += 5_000;
    expect(resolve("antigravity", OTHER)).toBeNull();
    expect(dirCalls).toBe(4);
    clock += 60_000;
    expect(resolve("antigravity", OTHER)).toBeNull();
    expect(dirCalls).toBe(4);
  });
});
