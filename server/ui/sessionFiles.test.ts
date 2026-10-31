// SPDX-License-Identifier: Apache-2.0
// GET /api/ui/sessions/:harness/:id/files: the whole session's files from the index.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES, type SessionFiles } from "../../shared/api.js";
import { Session, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";

let app: App;
let tmp: { dir: string; cleanup: () => void };
const s = new Session();
const CWD = "/Users/me/code/app";

beforeAll(async () => {
  tmp = tempDir();
  const web = path.join(tmp.dir, "web");
  mkdirSync(path.join(web, "assets"), { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>board</title>");
  app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, webDir: web });
  const ev = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    s.ev(type, data, { session: { cwd: CWD }, ...extra });
  const big = "x".repeat(3000);
  app.store.ingest(
    [
      ev("session.started", { source: "startup" }),
      ev("tool.started", { tool: "Read", call_id: "r1", input: { file_path: `${CWD}/src/a.ts` } }),
      ev("tool.ended", {
        tool: "Read",
        call_id: "r1",
        ok: true,
        input: { file_path: `${CWD}/src/a.ts` },
        output: "1→a",
      }),
      ev("tool.started", {
        tool: "Edit",
        call_id: "e1",
        input: { file_path: `${CWD}/src/a.ts`, old_string: "a", new_string: "b" },
      }),
      ev("tool.ended", {
        tool: "Edit",
        call_id: "e1",
        ok: true,
        input: { file_path: `${CWD}/src/a.ts`, old_string: "a", new_string: "b" },
      }),
      // The same end again (a replayed hook with a new seq) changes nothing.
      ev("tool.ended", {
        tool: "Edit",
        call_id: "e1",
        ok: true,
        input: { file_path: `${CWD}/src/a.ts`, old_string: "a", new_string: "b" },
      }),
      // Within seconds of the edit: the same touch, not a second one.
      ev("files.changed", { paths: ["src/a.ts"] }),
      ev("tool.ended", {
        tool: "Write",
        call_id: "w1",
        ok: true,
        input: { file_path: `${CWD}/src/new.ts`, content: big },
      }),
      ev("tool.ended", { tool: "Bash", call_id: "b1", ok: false, input: { command: "npm test" }, output: "FAIL" }),
      ev("tool.started", {
        tool: "Edit",
        call_id: "e2",
        input: { file_path: `${CWD}/src/b.ts`, old_string: "x", new_string: "y" },
      }),
    ],
    "http",
  );
});
afterAll(async () => {
  await app.close();
  tmp.cleanup();
});

const get = async (key: string) => {
  const res = await fetch(`${app.url}${ROUTES.ui.session}/${key}/files`);
  return { status: res.status, body: (await res.json()) as SessionFiles, cache: res.headers.get("cache-control") };
};

describe("GET /sessions/:harness/:id/files", () => {
  it("lists every file with its touches paired, the end's seq winning, a repeat end ignored", async () => {
    const { status, body, cache } = await get(`${s.harness}/${s.id}`);
    expect(status).toBe(200);
    expect(cache).toBe("no-store");
    expect(body.lastSeq).toBe(9);
    const a = body.files.find((f) => f.path === "src/a.ts")!;
    expect(a.given).toBe(`${CWD}/src/a.ts`);
    expect(a.touches.map((t) => [t.kind, t.seq, t.pending ?? false])).toEqual([
      ["read", 2, false],
      ["edit", 4, false],
    ]);
    const n = body.files.find((f) => f.path === "src/new.ts")!;
    expect(n.touches).toEqual([expect.objectContaining({ kind: "write", seq: 7, cut: true })]);
    const b = body.files.find((f) => f.path === "src/b.ts")!;
    expect(b.touches).toEqual([{ seq: 9, at: expect.any(String), tool: "Edit", kind: "edit", pending: true }]);
    // Newest-touched first; Bash names no file.
    expect(body.files.map((f) => f.path)).toEqual(["src/b.ts", "src/new.ts", "src/a.ts"]);
  });

  it("is 404 for a session the store does not know", async () => {
    const { status, body } = await get("claude-code/nope");
    expect(status).toBe(404);
    expect(body).toEqual({ reason: "not_found" });
  });
});
