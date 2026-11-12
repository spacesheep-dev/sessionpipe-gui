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

/** Fetches that are not of the page's backend, each with why. */
const ALLOWED: Record<string, string> = {
  // The receiver's address over https, probed from the setup page: another origin on purpose.
  "pages/SetupPage.tsx": '/api/ui/info`, { mode: "no-cors"',
  // A sound the person picked: a blob: or data: URL of their own file.
  "lib/sounds.ts": "fetch(customUrl)",
  // The five doors of a spacesheep account, through the native hub: the only requests a
  // page on an account makes, and what apiFetch never does.
  "account/doors.ts": "fetch(url, init))",
  // A path that is not a receiver's at all (another origin, a data: URL) goes as it would.
  "account/routes.ts": "return fetch(path, init);",
};

test("no file but lib/net.ts fetches a receiver path", () => {
  const raw: string[] = [];
  const other: string[] = [];
  for (const file of sources(src)) {
    const rel = path.relative(src, file);
    if (rel === path.join("lib", "net.ts")) continue;
    const text = readFileSync(file, "utf8");
    // fetch(apiUrl(…)), on one line or broken over two.
    raw.push(...found(file, text, /\bfetch\(\s*apiUrl\(/g));
    // Any other fetch: allowed only where this file says why.
    for (const at of found(file, text, /(?<![.\w])fetch\(/g)) {
      const allowed = ALLOWED[rel.split(path.sep).join("/")];
      if (!allowed || !text.includes(allowed)) other.push(at);
    }
  }
  expect(raw, "use apiFetch(path, init) from lib/net.ts").toEqual([]);
  expect(other, "a fetch outside lib/net.ts: use apiFetch, or add it to ALLOWED with the reason").toEqual([]);
});

test("the guard sees a raw fetch when there is one", () => {
  const sample = "const r = await fetch(\n  apiUrl(ROUTES.ui.info),\n);\nwindow.fetch(x);\nfetch(apiUrl(a));";
  expect(found("/x/a.ts", sample, /\bfetch\(\s*apiUrl\(/g)).toHaveLength(2);
});
