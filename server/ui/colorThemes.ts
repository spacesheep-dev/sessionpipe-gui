// SPDX-License-Identifier: Apache-2.0
// Custom color themes: JSON files a person drops into <stateDir>/color-themes/. Each is
// a `ColorTheme` (shared/color-theme.ts); the web app lists them after its built-ins.
// Read on every request (the folder is small and edits should show on reload); a file
// that does not parse or validate is reported, never served.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type ColorThemesResponse, parseColorTheme } from "../../shared/color-theme.js";
import { withoutBom } from "../config.js";

export function readColorThemes(dir: string): ColorThemesResponse {
  const out: ColorThemesResponse = { themes: [], errors: [] };
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return out; // no folder yet: nothing custom
  }
  const seen = new Set<string>();
  for (const file of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(withoutBom(readFileSync(path.join(dir, file), "utf8")));
    } catch (err) {
      out.errors.push({ file, error: `not JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const r = parseColorTheme(doc);
    if ("error" in r) {
      out.errors.push({ file, error: r.error });
      continue;
    }
    if (seen.has(r.theme.id)) {
      out.errors.push({ file, error: `duplicate id ${r.theme.id}` });
      continue;
    }
    seen.add(r.theme.id);
    out.themes.push(r.theme);
  }
  return out;
}
