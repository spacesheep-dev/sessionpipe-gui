// SPDX-License-Identifier: Apache-2.0
// Every request the page makes of its backend goes through lib/net.ts `apiFetch`, which
// knows whether there is a receiver to ask (docs/rfcs/08, "The phone on an account": on a
// spacesheep account there is none, and a request to `${rxBase}/api/ui/…` would reach a
// route that does not exist). This reads the page's source and fails when a file fetches a
// receiver path on its own.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** The lines of `text` where `re` matches, as "file:line". */
function found(file: string, text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re))
    out.push(`${path.relative(src, file)}:${text.slice(0, m.index).split("\n").length}`);
  return out;
}

/** The code of a file with its comments taken out and its plain strings emptied (a `//`
 *  in a string, as in a URL, is not a comment; a word in a sentence is not a request):
 *  what the guard reads. A template literal is kept whole, since it can hold code. Line
 *  numbers are kept. */
export function code(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const c = text[i]!;
    const two = text.slice(i, i + 2);
    if (quote) {
      const keep = quote === "`" || c === quote || c === "\n";
      if (c === "\\") {
        if (keep) out += c + (text[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (keep) out += c;
      if (c === quote) quote = null;
      i++;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
    } else if (two === "//") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, "");
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Every place a file reaches for the network by itself, as "file:line what":
 *  - `fetch` used as a value: called, on `window` / `globalThis` / `self`, or handed on
 *    under another name (`const f = fetch`). A property of something else (`o.fetch`), a
 *    key (`fetch:`, `fetch?:`) and the type (`typeof fetch`) are not requests;
 *  - the other ways out: XMLHttpRequest, sendBeacon, EventSource, WebSocket, importScripts. */
export function reaches(file: string, text: string): string[] {
  const t = code(text);
  const out: string[] = [];
  const at = (index: number, what: string) =>
    out.push(`${path.relative(src, file).split(path.sep).join("/")}:${t.slice(0, index).split("\n").length} ${what}`);
  for (const m of t.matchAll(/(?<![\w$])fetch\b/g)) {
    const before = t.slice(Math.max(0, m.index - 24), m.index);
    const after = t.slice(m.index + 5, m.index + 12);
    if (/typeof\s+$/.test(before)) continue;
    if (/^\s*\??\s*:/.test(after) && !/[?]\s*$/.test(before)) continue;
    const owner = /([\w$]+)\s*\??\.\s*$/.exec(before);
    if (owner && !/^(window|globalThis|self)$/.test(owner[1]!)) continue;
    if (!owner && /\.\s*$/.test(before)) continue;
    at(m.index, "fetch");
  }
  for (const m of t.matchAll(/\b(XMLHttpRequest|sendBeacon|EventSource|WebSocket|importScripts)\b(?=\s*\()/g))
    at(m.index, m[1]!);
  for (const m of t.matchAll(/\bnew\s+(XMLHttpRequest|EventSource|WebSocket)\b(?!\s*\()/g)) at(m.index, m[1]!);
  return out;
}

/** The files that reach for the network by themselves, each with how often and why. One
 *  more in any of them, or one anywhere else, fails: use apiFetch, or say here why not. */
const ALLOWED: Record<string, { n: number; why: string }> = {
  "lib/net.ts": { n: 2, why: "apiFetch itself, and the receiver's stream (openEvents)" },
  "pages/SetupPage.tsx": {
    n: 1,
    why: "the receiver's address over https, probed from the setup page: another origin on purpose",
  },
  "lib/sounds.ts": { n: 1, why: "a sound the person picked: a blob: or data: URL of their own file" },
  "mock/phone.ts": {
    n: 2,
    why: "the demo: window.fetch wrapped for the phone page's routes (mock mode, which an account never is)",
  },
  "account/doors.ts": {
    n: 1,
    why: "the five doors of a spacesheep account, through the native hub: the only requests a page on an account makes",
  },
};

test("no file but lib/net.ts fetches a receiver path", () => {
  const raw: string[] = [];
  for (const file of sources(src)) {
    if (path.relative(src, file) === path.join("lib", "net.ts")) continue;
    // fetch(apiUrl(…)), on one line or broken over two.
    raw.push(...found(file, code(readFileSync(file, "utf8")), /\bfetch\(\s*apiUrl\(/g));
  }
  expect(raw, "use apiFetch(path, init) from lib/net.ts").toEqual([]);
});

test("the files that reach for the network by themselves are the ones listed, each as often as listed", () => {
  const seen: Record<string, string[]> = {};
  for (const file of sources(src)) {
    const hits = reaches(file, readFileSync(file, "utf8"));
    if (hits.length) seen[path.relative(src, file).split(path.sep).join("/")] = hits;
  }
  const counts = Object.fromEntries(Object.entries(seen).map(([f, hits]) => [f, hits.length]));
  const allowed = Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.n]));
  expect(
    counts,
    `a request outside lib/net.ts: use apiFetch, or list it in ALLOWED with the reason.\n${JSON.stringify(seen, null, 1)}`,
  ).toEqual(allowed);
});

test("the guard sees every way out, and not what only looks like one", () => {
  const sample = "const r = await fetch(\n  apiUrl(ROUTES.ui.info),\n);\nwindow.fetch(x);\nfetch(apiUrl(a));";
  expect(found("/x/a.ts", sample, /\bfetch\(\s*apiUrl\(/g)).toHaveLength(2);
  const what = (text: string) => reaches(path.join(src, "a.ts"), text).map((h) => h.replace(/^a\.ts:/, ""));
  // Each of these reaches the network.
  expect(what("fetch(url);")).toEqual(["1 fetch"]);
  expect(what("x;\nwindow.fetch(url);\nglobalThis.fetch(url);\nself.fetch(url);")).toEqual([
    "2 fetch",
    "3 fetch",
    "4 fetch",
  ]);
  expect(what("const f = fetch;\nf(url);")).toEqual(["1 fetch"]);
  expect(what("const f = o.fetch ?? fetch;")).toEqual(["1 fetch"]);
  expect(what("go(fetch, 1);\nconst g = [fetch];\nconst h = ok ? fetch : other;")).toEqual([
    "1 fetch",
    "2 fetch",
    "3 fetch",
  ]);
  expect(what("fetch.call(null, url);\nfetch\n  (url);")).toEqual(["1 fetch", "2 fetch"]);
  expect(what("const x = new XMLHttpRequest();\nnavigator.sendBeacon(url, body);")).toEqual([
    "1 XMLHttpRequest",
    "2 sendBeacon",
  ]);
  expect(
    what("new EventSource(url);\nnew WebSocket(url);\nimportScripts(url);\nconst X = new XMLHttpRequest;"),
  ).toEqual(["1 EventSource", "2 WebSocket", "3 importScripts", "4 XMLHttpRequest"]);
  // A second one in a file is a second one.
  expect(what("fetch(a);\nfetch(b);")).toHaveLength(2);
  // None of these does.
  for (const quiet of [
    "interface O {\n  fetch?: typeof fetch;\n}",
    "const o = { fetch: other, more: 1 };",
    "o.fetch(url);\nopts?.fetch(url);\nstore.transport.fetch.session(key);",
    "// fetch(url) in a comment\n/* window.fetch(url)\n fetch(x) */\nconst a = 1;",
    "apiFetch(path);\nrefetch();\nprefetch(x);\nconst fetched = 1;\nfetchAll();",
    "type F = typeof fetch;\nlet f: typeof fetch | undefined;",
    "const s = { EventSourceLike: 1 };\ntype E = EventSource;\nfunction WebSocketish() {}",
  ])
    expect(what(quiet), quiet).toEqual([]);
  // A comment marker inside a string is not a comment: what follows it is still read. A
  // word inside a plain string is not a request; code inside a template literal is.
  expect(what('const u = "https://x.example/a";\nfetch(u);')).toEqual(["2 fetch"]);
  expect(what("const a = \"the worker waits in `fetch` here\";\nconst b = 'window.fetch(x)';")).toEqual([]);
  expect(what(["const c = `$", "{await fetch(u)}`;"].join(""))).toEqual(["1 fetch"]);
});
