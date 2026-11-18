// SPDX-License-Identifier: Apache-2.0
// The layout's widths are written once in the page's code, in lib/device.ts: every other
// file asks that one (phoneLayout, usePhoneLayout, wideLayout, panelCovers). A copy of a
// number anywhere else is a part of the page that would switch on its own.
// A stylesheet cannot ask: it writes the query out. So each one that names a width writes
// one of that file's queries whole, the phone layout's (PHONE_QUERY), its opposite
// (DESKTOP_QUERY) or the narrow desktop's, where the panel covers the page
// (PANEL_COVERS_QUERY), and a part of the page styled by any other would switch on its own
// too: a Mac window tiled to half the screen would get a phone's rule in the middle of the
// desktop's layout.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DESKTOP_QUERY, PANEL_COVERS_QUERY, PHONE_QUERY } from "./device";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The ways a width is written, put together here so this file holds none: in a media
 *  query (a number with px), and as a number a width is compared with. A window with a
 *  mouse changes layout at the first pair, a touch screen at the second. */
const NUMBERS = ["719", "720", "839", "840"];
const WIDTHS = NUMBERS.map((n) => `${n}px`);
const COMPARED = new RegExp(`[<>]=?\\s*(${NUMBERS.join("|")})\\b`);
const [, MOUSE_FROM, NARROW, WIDE] = NUMBERS as [string, string, string, string];

/** The queries a stylesheet may write: lib/device.ts's own, whole. */
const SHARED = [PHONE_QUERY, DESKTOP_QUERY, PANEL_COVERS_QUERY];
/** The queries that name a width and are none of those, each with why it may. */
const OWN: { file: string; query: string; why: string }[] = [
  {
    file: "styles/chat.css",
    query: `(hover: none), ${PHONE_QUERY}`,
    why: "a bubble's time shows on hover: it is hidden where nothing hovers, at any width, and in the phone layout",
  },
  {
    file: "styles/narrow.css",
    query: `(pointer: coarse) and (max-width: ${NARROW}px)`,
    why: "a finger's reach in the phone layout: a touch screen's alone, which changes layout where it always did",
  },
  {
    file: "styles/narrow.css",
    query: `(pointer: coarse) and (min-width: ${WIDE}px)`,
    why: "a finger's reach in the desktop layout (a tablet on its side): a touch screen's alone",
  },
  {
    file: "styles/narrow.css",
    query: `(hover: none) and (max-width: ${NARROW}px)`,
    why: "a row pressed in the phone layout: only where nothing hovers, so never a window with a mouse",
  },
];

function sources(dir: string, kind: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const at = path.join(dir, e.name);
    if (e.isDirectory()) return sources(at, kind);
    return kind.test(e.name) ? [at] : [];
  });
}
const named = (file: string) => path.relative(SRC, file).split(path.sep).join("/");

/** Every @media of the stylesheets that names a width, as "file: query" (a query the
 *  formatter broke over two lines reads as one). */
function widthQueries(): { rules: string[]; loose: string[]; files: number } {
  const files = sources(SRC, /\.css$/);
  const rules: string[] = [];
  const loose: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, query] of text.matchAll(/@media\s+([^{]+)\{/g))
      if (WIDTHS.some((w) => query!.includes(w))) rules.push(`${named(f)}: ${query!.replace(/\s+/g, " ").trim()}`);
    // Outside a media query (a container's, a width), the two a touch screen changes at:
    // a copy no query form would hold. (720 px is also a measure, a dialog's width.)
    if ([NARROW, WIDE].some((n) => text.replace(/@media\s+[^{]+\{/g, "").includes(`${n}px`))) loose.push(named(f));
  }
  return { rules, loose, files: files.length };
}

describe("the layout's widths", () => {
  it("are written in lib/device.ts and in no other .ts or .tsx file", () => {
    const files = sources(SRC, /\.tsx?$/);
    // The walk found the page: a wrong folder would pass with nothing read.
    expect(files.length).toBeGreaterThan(200);
    const holders = files
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return WIDTHS.some((w) => text.includes(w)) || COMPARED.test(text);
      })
      .map(named);
    expect(holders).toEqual(["lib/device.ts"]);
  });

  it("are written in a stylesheet as one of lib/device.ts's queries, whole", () => {
    const { rules, loose, files } = widthQueries();
    expect(files).toBeGreaterThan(40);
    // All are in use, the two layouts many times over: a scan that read nothing would pass.
    const count = (query: string) => rules.filter((r) => r.endsWith(`: ${query}`)).length;
    expect(count(PHONE_QUERY)).toBeGreaterThan(40);
    expect(count(DESKTOP_QUERY)).toBeGreaterThan(10);
    expect(count(PANEL_COVERS_QUERY)).toBeGreaterThan(0);
    const other = rules.filter((r) => !SHARED.some((q) => r.endsWith(`: ${q}`)));
    // Each of the few that stand apart is still there, and nothing else is.
    expect(other.sort()).toEqual(OWN.map((o) => `${o.file}: ${o.query}`).sort());
    for (const o of OWN) expect(o.why).not.toBe("");
    expect(loose).toEqual([]);
  });

  it("start where the desktop app's window stops: its narrowest is still a desktop", () => {
    // The window's minimum (apps/desktop, window.rs) and the width a window with a mouse
    // keeps the desktop layout from are one number: a pixel under it would be a phone's.
    expect(DESKTOP_QUERY).toContain(`(min-width: ${MOUSE_FROM}px) and (pointer: fine)`);
    const shell = readFileSync(path.resolve(SRC, "../../apps/desktop/src-tauri/src/window.rs"), "utf8");
    expect(shell).toContain(`const MIN_WIDTH: f64 = ${MOUSE_FROM}.0;`);
    expect(shell.match(/\.min_inner_size\(MIN_WIDTH, MIN_HEIGHT\)/g)).toHaveLength(2);
    expect(shell).not.toMatch(/\.min_inner_size\(\s*\d/);
  });
});
