// SPDX-License-Identifier: Apache-2.0
// `sessionpipe-gui key renew` with no receiver serving the folder writes config.json
// itself. A write the system refuses is one line and exit 1; an error that is not the
// system's refusal (a programming error, also one of Node's own with an ERR_ code) is
// thrown on with its stack, never reported as a folder that could not be written.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../test/events.js";
import { readGuiConfig } from "./config.js";
import { runKeyCommand } from "./keyCommand.js";

/** What the next rename throws, in place of renaming. */
const refuse = vi.hoisted(() => ({ with: null as Error | null }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const renameSync: typeof fs.renameSync = (from, to) => {
    if (refuse.with) throw refuse.with;
    fs.renameSync(from, to);
  };
  return { ...fs, renameSync, default: { ...fs, renameSync } };
});

let tmp: { dir: string; cleanup: () => void };
beforeEach(() => {
  tmp = tempDir("spgui-keycmd-refused-");
  readGuiConfig(tmp.dir);
});
afterEach(() => {
  refuse.with = null;
  tmp.cleanup();
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stateDir: tmp.dir,
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void err.push(s) },
      // Nothing listens there: no receiver serves the folder.
      probePort: 9,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("key renew, the write of the new key", () => {
  it("refused by the system: one line, and the folder as it was", async () => {
    const before = readFileSync(path.join(tmp.dir, "config.json"), "utf8");
    refuse.with = Object.assign(new Error("ENOSPC: no space left on device, rename"), {
      code: "ENOSPC",
      errno: -28,
      syscall: "rename",
    });
    const t = io();
    expect(await runKeyCommand("renew", t.io)).toBe(1);
    expect(t.err()).toBe(`sessionpipe-gui: ${tmp.dir} could not be written (ENOSPC); the key was not changed.\n`);
    expect(t.out()).toBe("");
    expect(readFileSync(path.join(tmp.dir, "config.json"), "utf8")).toBe(before);
    expect(readdirSync(tmp.dir)).toEqual(["config.json"]);
  });

  it("failed some other way: the error itself, not a folder that could not be written", async () => {
    const before = readFileSync(path.join(tmp.dir, "config.json"), "utf8");
    refuse.with = Object.assign(new TypeError('The "path" argument must be of type string'), {
      code: "ERR_INVALID_ARG_TYPE",
    });
    const t = io();
    await expect(runKeyCommand("renew", t.io)).rejects.toBe(refuse.with);
    expect(t.err()).toBe("");
    expect(readFileSync(path.join(tmp.dir, "config.json"), "utf8")).toBe(before);
  });
});
