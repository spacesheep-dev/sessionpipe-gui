// SPDX-License-Identifier: Apache-2.0
// The store's core is not Node's: it bundles for the browser (esbuild, platform "browser",
// where an import of a Node module, or of a package that needs one, does not resolve), its
// bundle is the repo's own files with no package in it and no word of Node's globals, and
// it runs in a context that has what a page on the oldest Safari we hold to has, and none
// of Node's. Envelope validation (receiver/validate.ts) is held to the same, for a page
// that reads events from a relay.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import vm from "node:vm";
import { build } from "esbuild";
import { expect, test } from "vitest";
import type { ProtocolEvent } from "../../shared/api.js";
import { Session, SID } from "../../test/events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

/** The floor: Safari 17.0, the oldest the iPhone app runs on (iOS 17). What a page there
 *  has beyond the language: the context below gets these, Node's own implementations. */
const PAGE_GLOBALS = {
  TextEncoder,
  TextDecoder,
  btoa,
  atob,
  queueMicrotask,
  structuredClone,
  performance,
  crypto,
  URL,
  URLSearchParams,
  AbortController,
  AbortSignal,
  Event,
  EventTarget,
  Blob,
  fetch,
  Headers,
  Request,
  Response,
};
/** And what the language has in Node's V8 but Safari 17.0 does not, taken out of the
 *  context before the bundle runs (with the version that brought each). */
const NEWER_THAN_SAFARI_17 = [
  "Object.groupBy", // 17.4
  "Map.groupBy", // 17.4
  "Promise.withResolvers", // 17.4
  "ArrayBuffer.prototype.transfer", // 17.4
  "ArrayBuffer.prototype.transferToFixedLength", // 17.4
  "Iterator", // 18.4, with the helpers on every iterator below
  "Promise.try", // 18.2
  "RegExp.escape", // 18.2
  "Uint8Array.fromBase64", // 18.2
  "Uint8Array.fromHex", // 18.2
  "Uint8Array.prototype.toBase64", // 18.2
  "Uint8Array.prototype.toHex", // 18.2
  "Float16Array", // 18.2
  "Math.f16round", // 18.2
  "JSON.rawJSON", // 18.4
  "JSON.isRawJSON", // 18.4
  "Error.isError",
  "Math.sumPrecise",
  "Atomics.pause",
  "Symbol.dispose",
  "Symbol.asyncDispose",
  "DisposableStack",
  "AsyncDisposableStack",
];
/** Iterator helpers (Safari 18.4): on the prototype every array, map and set iterator shares. */
const ITERATOR_HELPERS = [
  "map",
  "filter",
  "take",
  "drop",
  "flatMap",
  "reduce",
  "toArray",
  "forEach",
  "some",
  "every",
  "find",
];

/** The core, a memory log, detach and the validator as one browser bundle, an IIFE named `core`. */
async function bundle() {
  const out = await build({
    stdin: {
      contents: [
        'export { StoreCore } from "./core.js";',
        'export { MemoryLog } from "./log.js";',
        'export { detach } from "./slim.js";',
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
    // Syntax past the floor is lowered, or the build fails where it can't be.
    target: "safari17",
    write: false,
    metafile: true,
    legalComments: "none",
    logLevel: "silent",
  });
  return { code: out.outputFiles[0]!.text, inputs: Object.keys(out.metafile.inputs) };
}

/** A context with a page's globals at the floor and none of Node's. */
function pageContext(errors: string[]) {
  const page = vm.createContext({
    ...PAGE_GLOBALS,
    console: { error: (...a: unknown[]) => errors.push(format(...a)), log() {}, warn() {}, info() {} },
    // A page's timers are numbers; Node's Timeout objects (with unref) never reach the core.
    setTimeout: (f: () => void, ms: number) => Number(setTimeout(f, ms)),
    clearTimeout: (t: number) => clearTimeout(t),
    setInterval: (f: () => void, ms: number) => Number(setInterval(f, ms)),
    clearInterval: (t: number) => clearInterval(t),
  });
  vm.runInContext(
    `(() => {
      for (const name of ${JSON.stringify(NEWER_THAN_SAFARI_17)}) {
        const parts = name.split(".");
        const last = parts.pop();
        let owner = globalThis;
        for (const p of parts) owner = owner?.[p];
        if (owner) delete owner[last];
      }
      const proto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
      for (const m of ${JSON.stringify(ITERATOR_HELPERS)}) delete proto[m];
    })();`,
    page,
  );
  return page;
}

test("the core bundles for the browser from the repo's own files alone, naming nothing of Node's", async () => {
  const { code, inputs } = await bundle();
  const files = inputs.filter((f) => f !== "browser-entry.ts").map((f) => path.relative(root, path.resolve(f)));
  expect(files.filter((f) => f.includes("node_modules") || f.startsWith(".."))).toEqual([]);
  // What the core may read: its own folder, the shared types and readings, the validator.
  expect(files.filter((f) => !/^(server\/store|shared|server\/receiver|server\/control\/refs\.ts$)/.test(f))).toEqual(
    [],
  );
  expect(files).toContain("server/store/core.ts");
  // Node's globals by name anywhere, through globalThis or a string too; Buffer only where
  // slim.ts asks whether there is one.
  expect(code.match(/\b(?:process|require|module|__dirname|__filename|setImmediate|global)\b/g) ?? []).toEqual([]);
  expect(code.replace(/globalThis\.Buffer\b/g, "").match(/\bBuffer\b/g) ?? []).toEqual([]);
  // The newer built-ins by name too, for a path the run below does not take (the iterator
  // helpers share their names with an array's, so only the run catches those).
  const newer = NEWER_THAN_SAFARI_17.map((n) => (n.includes(".") ? `\\.${n.split(".").pop()}` : `\\b${n}`));
  expect(code.match(new RegExp(`(?:${newer.join("|")})\\b`, "g")) ?? []).toEqual([]);
});

test("the context is the floor: a page's globals, nothing of Node's, nothing newer than Safari 17", () => {
  const page = pageContext([]);
  expect(vm.runInContext("[typeof Buffer, typeof process, typeof require, typeof setImmediate]", page)).toEqual([
    "undefined",
    "undefined",
    "undefined",
    "undefined",
  ]);
  expect(
    vm.runInContext(
      "[typeof Object.groupBy, typeof Promise.withResolvers, typeof [].values().map, typeof Iterator]",
      page,
    ),
  ).toEqual(["undefined", "undefined", "undefined", "undefined"]);
  expect(
    vm.runInContext(
      "[typeof structuredClone, typeof queueMicrotask, typeof crypto.randomUUID, typeof performance.now, typeof new URL('https://a.b/').host, typeof [].toSorted, typeof new Set().union]",
      page,
    ),
  ).toEqual(["function", "function", "function", "function", "string", "function", "function"]);
});

test("the bundle runs at the floor: ingest, board, pages, feed, search, files, digest, tick, forget, boot", async () => {
  const { code } = await bundle();
  const errors: string[] = [];
  const page = pageContext(errors);
  vm.runInContext(`${code}\nglobalThis.core = core;`, page);
  const lib = page.core as typeof import("./core.js") &
    typeof import("./log.js") &
    typeof import("./slim.js") &
    typeof import("../receiver/validate.js");

  // detach without Buffer gives back what Buffer does: a BOM stays, a lone surrogate is U+FFFD.
  for (const s of ["plain", "﻿leading bom", "a﻿b", "lone \ud83d", "\udc00 low", "😀 é"])
    expect(lib.detach(s), JSON.stringify(s)).toBe(Buffer.from(s, "utf8").toString("utf8"));

  const parent = new Session();
  const child = new Session("child-1");
  const other = new Session("other-1", "codex");
  const long = "x".repeat(5_000);
  const events: ProtocolEvent[] = [
    parent.ev("session.started", { source: "startup" }),
    parent.ev("turn.started", { turn_id: "t1" }),
    parent.ev("tool.started", { tool: "Bash", call_id: "c1", input: { command: long } }),
    parent.ev("tool.ended", { tool: "Bash", call_id: "c1", ok: true, output: long }),
    child.ev("session.started", {}, { session: { parent_id: SID } }),
    child.ev("tool.started", { tool: "Read", call_id: "c2" }),
    parent.ev("files.changed", { paths: ["src/a.ts"] }, { session: { repo: "acme/web" } }),
    parent.ev("turn.transcript", { turn: 1, user: "fix the flaky login test", assistant: "done" }, { tier: 2 }),
    parent.ev("turn.ended", { turn_id: "t1" }),
    other.ev("session.started", { source: "startup" }),
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
  expect(board.sessions.map((s) => s.id).sort()).toEqual(["child-1", "other-1", SID].sort());
  const key = board.sessions.find((s) => s.id === SID)!.key;
  expect(store.session(key)!.children).toBe(1);
  const detail = store.sessionDetail(key, -1, 100)!;
  expect(detail.events).toHaveLength(7);
  expect((detail.events[3]!.data as { output: string }).output).toBe(long);
  // The feed a page at a time: the cursor goes out and comes back.
  const first = store.feed({ limit: 3 });
  expect(first.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  const second = store.feed({ limit: 100, before: first.cursor });
  expect([...first.events, ...second.events].map((e) => e.id).sort()).toEqual(events.map((e) => e.id).sort());
  const found = store.search({ q: "flaky login" });
  expect(found.hits.map((h) => h.session.key)).toContain(key);
  expect(typeof found.ms).toBe("number");
  expect(store.filesChanged({}).repos.flatMap((r) => r.paths.map((p) => p.path))).toContain("src/a.ts");
  expect(store.digest({}).sessions.map((s) => s.key)).toContain(key);
  // A tick three days on: the silent session moves on and the page is told.
  const stateBefore = store.session(key)!.state;
  seen.length = 0;
  store.tick(Date.now() + 3 * 86_400_000);
  expect(store.session(key)!.state).not.toBe(stateBefore);
  expect(seen).toContain("session");

  store.forget(board.sessions.find((s) => s.id === "other-1")!.key);
  const kept = store.snapshot().sessions;
  expect(kept.map((s) => s.id).sort()).toEqual(["child-1", SID].sort());

  // Booted again from what the log kept: the same board, the child still its parent's,
  // the forgotten session gone.
  const again = new lib.StoreCore("page", { tickMs: 60_000, statsMs: 60_000 }, log);
  expect(
    again
      .snapshot()
      .sessions.map((s) => s.id)
      .sort(),
  ).toEqual(["child-1", SID].sort());
  expect(again.session(key)!.children).toBe(1);
  await store.close();
  await again.close();
});
