// SPDX-License-Identifier: Apache-2.0
// The store's core is not Node's: it bundles for the browser (esbuild, platform "browser",
// where an import of a Node module, or of a package that needs one, does not resolve), its
// bundle is the repo's own files with no package in it and no use of Node's globals, and
// it runs in a context that has a page's globals and none of Node's. Envelope validation
// (receiver/validate.ts) is held to the same, for a page that reads events from a relay.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import vm from "node:vm";
import { build } from "esbuild";
import { expect, test, vi } from "vitest";
import type { ProtocolEvent } from "../../shared/api.js";
import { Session, SID } from "../../test/events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

/** The core, a memory log and the validator as one browser bundle, an IIFE named `core`. */
async function bundle() {
  const out = await build({
    stdin: {
      contents: [
        'export { StoreCore } from "./core.js";',
        'export { MemoryLog } from "./log.js";',
        'export { eventProblem } from "../receiver/validate.js";',
      ].join("\n"),
      resolveDir: here,
      sourcefile: "browser-entry.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "core",
    target: "es2022",
    write: false,
    metafile: true,
    legalComments: "none",
    logLevel: "silent",
  });
  return { code: out.outputFiles[0]!.text, inputs: Object.keys(out.metafile.inputs) };
}

test("the core bundles for the browser from the repo's own files alone", async () => {
  const { code, inputs } = await bundle();
  const files = inputs.filter((f) => f !== "browser-entry.ts").map((f) => path.relative(root, path.resolve(f)));
  expect(files.filter((f) => f.includes("node_modules") || f.startsWith(".."))).toEqual([]);
  // What the core may read: its own folder, the shared types and readings, the validator.
  expect(files.filter((f) => !/^(server\/store|shared|server\/receiver|server\/control\/refs\.ts$)/.test(f))).toEqual(
    [],
  );
  expect(files).toContain("server/store/core.ts");
  // Node's globals, outside a property read (`globalThis.Buffer` is how slim.ts asks).
  expect(code.match(/(?<![.\w$])(?:Buffer|process|require|__dirname|__filename|setImmediate)\b/g) ?? []).toEqual([]);
});

test("the bundle runs with a page's globals and none of Node's: board, session page, feed pages, digest", async () => {
  const { code } = await bundle();
  const errors: string[] = [];
  // A page's timers are numbers; Node's Timeout objects (with unref) never reach the core.
  const page = vm.createContext({
    console: { error: (...a: unknown[]) => errors.push(format(...a)), log() {}, warn() {} },
    TextEncoder,
    TextDecoder,
    btoa,
    atob,
    setTimeout: (f: () => void, ms: number) => Number(setTimeout(f, ms)),
    clearTimeout: (t: number) => clearTimeout(t),
    setInterval: (f: () => void, ms: number) => Number(setInterval(f, ms)),
    clearInterval: (t: number) => clearInterval(t),
  });
  expect(vm.runInContext("typeof Buffer + typeof process + typeof require", page)).toBe("undefinedundefinedundefined");
  vm.runInContext(`${code}\nglobalThis.core = core;`, page);
  const lib = page.core as typeof import("./core.js") &
    typeof import("./log.js") &
    typeof import("../receiver/validate.js");

  const parent = new Session();
  const child = new Session("child-1");
  const long = "x".repeat(5_000);
  const events: ProtocolEvent[] = [
    parent.ev("session.started", { source: "startup" }),
    parent.ev("turn.started", { turn_id: "t1" }),
    parent.ev("tool.started", { tool: "Bash", call_id: "c1", input: { command: long } }),
    parent.ev("tool.ended", { tool: "Bash", call_id: "c1", ok: true, output: long }),
    child.ev("session.started", {}, { session: { parent_id: SID } }),
    child.ev("tool.started", { tool: "Read", call_id: "c2" }),
    parent.ev("files.changed", { paths: ["a.ts"] }),
    parent.ev("turn.ended", { turn_id: "t1" }),
  ];
  for (const e of events) expect(lib.eventProblem(e)).toBeNull();
  expect(lib.eventProblem({ ...events[0], id: "nope" })).toBe("bad_id");

  const log = new lib.MemoryLog();
  const store = new lib.StoreCore("page", { tickMs: 60_000, statsMs: 60_000 }, log);
  const seen: string[] = [];
  store.subscribe((m) => seen.push(m.kind));
  store.subscribe(() => {
    throw new Error("a listener that throws");
  });
  expect(store.ingest(events, "spacesheep")).toMatchObject({ accepted: events.length, duplicates: 0 });
  expect(seen).toContain("event");
  expect(errors[0]).toBe("[store] listener: a listener that throws");

  const board = store.snapshot();
  expect(board.sessions.map((s) => s.id).sort()).toEqual(["child-1", SID].sort());
  const key = board.sessions.find((s) => s.id === SID)!.key;
  expect(store.session(key)!.children).toBe(1);
  const detail = store.sessionDetail(key, -1, 100)!;
  expect(detail.events).toHaveLength(6);
  expect((detail.events[3]!.data as { output: string }).output).toBe(long);
  // The feed a page at a time: the cursor goes out and comes back.
  const first = store.feed({ limit: 3 });
  expect(first.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  const second = store.feed({ limit: 100, before: first.cursor });
  expect([...first.events, ...second.events].map((e) => e.id).sort()).toEqual(events.map((e) => e.id).sort());
  expect(store.digest({}).sessions.map((s) => s.key)).toContain(key);

  // Booted again from what the log kept: the same board, the child still its parent's.
  const again = new lib.StoreCore("page", { tickMs: 60_000, statsMs: 60_000 }, log);
  expect(again.snapshot().sessions).toEqual(board.sessions);
  await store.close();
  await again.close();
  vi.useRealTimers();
});
