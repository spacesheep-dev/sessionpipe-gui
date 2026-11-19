// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. A DocKeep (docKeep.ts) that is one JSON file: read whole, written
// whole and atomically (a temp file, then rename) for its owner alone, and renamed to
// `<file>.bad-<time>` when it cannot be read, so a broken file is never lost.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DocKeep } from "./docKeep.js";

export function docFile(file: string): DocKeep {
  return {
    load() {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
      return JSON.parse(text) as unknown;
    },
    save(value) {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
      renameSync(tmp, file);
    },
    setAside() {
      try {
        renameSync(file, `${file}.bad-${Date.now()}`);
      } catch {
        // nothing to set aside
      }
    },
  };
}
