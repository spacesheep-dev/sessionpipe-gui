// SPDX-License-Identifier: Apache-2.0
// The documents' file: a byte-order mark an editor leaves on a hand edit is read past,
// while a file that really is broken is still set aside.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../test/events.js";
import { docFile } from "./docFile.js";
import { LabelStore } from "./labels.js";
import { LimitsStore } from "./limits.js";
import { MarkStore } from "./marks.js";

const BOM = String.fromCharCode(0xfeff);
const T0 = Date.parse("2026-10-28T10:00:00.000Z");

/** Puts a byte-order mark in front of what is in `file`, as Notepad or PowerShell 5's
 *  `Set-Content -Encoding UTF8` does on a hand edit. */
function addBom(file: string): void {
  writeFileSync(file, BOM + readFileSync(file, "utf8"));
}

const setAside = (dir: string) => readdirSync(dir).filter((f) => f.includes(".bad-"));

describe("docFile", () => {
  it("reads a file that starts with a byte-order mark", () => {
    const tmp = tempDir();
    try {
      const file = path.join(tmp.dir, "doc.json");
      writeFileSync(file, `${BOM}{"a":1}`);
      expect(docFile(file).load()).toEqual({ a: 1 });
    } finally {
      tmp.cleanup();
    }
  });

  it("still throws on a broken file, with or without a byte-order mark", () => {
    const tmp = tempDir();
    try {
      const file = path.join(tmp.dir, "doc.json");
      writeFileSync(file, `${BOM}{nope`);
      expect(() => docFile(file).load()).toThrow(SyntaxError);
      writeFileSync(file, `${BOM}${BOM}{}`);
      expect(() => docFile(file).load()).toThrow(SyntaxError);
    } finally {
      tmp.cleanup();
    }
  });

  it("keeps labels.json's names and colours when it has a byte-order mark", () => {
    const tmp = tempDir();
    try {
      const store = new LabelStore(tmp.dir, () => true);
      store.patch({ sessions: { a: "red" }, names: { red: "Urgent" } });
      addBom(path.join(tmp.dir, "labels.json"));
      expect(new LabelStore(tmp.dir, () => true).get()).toEqual({
        rev: 1,
        names: { red: "Urgent" },
        sessions: { a: "red" },
      });
      expect(setAside(tmp.dir)).toEqual([]);
    } finally {
      tmp.cleanup();
    }
  });

  it("keeps marks.json's since when it has a byte-order mark", () => {
    const tmp = tempDir();
    try {
      new MarkStore(
        tmp.dir,
        () => true,
        () => T0,
      );
      addBom(path.join(tmp.dir, "marks.json"));
      const later = new MarkStore(
        tmp.dir,
        () => true,
        () => T0 + 60_000,
      );
      expect(later.get().since).toBe(new Date(T0).toISOString());
      expect(setAside(tmp.dir)).toEqual([]);
    } finally {
      tmp.cleanup();
    }
  });

  it("does not set aside a limits.json with a byte-order mark", () => {
    const tmp = tempDir();
    try {
      const file = path.join(tmp.dir, "limits.json");
      writeFileSync(file, `${BOM}{"version":1,"entries":[]}`);
      expect(new LimitsStore(tmp.dir).list()).toEqual([]);
      expect(setAside(tmp.dir)).toEqual([]);
      expect(existsSync(file)).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });
});
