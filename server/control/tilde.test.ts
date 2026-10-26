// SPDX-License-Identifier: Apache-2.0
// A start's `~/…` folder (tilde.ts): offered only when this receiver's core and the
// machine's daemon both take one.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Hello } from "./parse.js";
import { ControlState } from "./state.js";
import { coreTakesTilde } from "./tilde.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("coreTakesTilde", () => {
  it("asks the core's own parser, and says no when it throws", () => {
    const parse = (ok: boolean) => ({
      COMMAND_TYPE: "sessionpipe.control" as const,
      parseCommand: (s: unknown) =>
        (ok || !JSON.parse(String(s)).cwd.startsWith("~") ? { ok: true } : { ok: false, code: "bad_fields" }) as never,
    });
    expect(coreTakesTilde(parse(true))).toBe(true);
    expect(coreTakesTilde(parse(false))).toBe(false);
    expect(
      coreTakesTilde({
        COMMAND_TYPE: "sessionpipe.control",
        parseCommand: () => {
          throw new Error("x");
        },
      } as never),
    ).toBe(false);
  });
});

describe("MachineControl.tilde", () => {
  it("is set only when both sides take it", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "spgui-tilde-"));
    dirs.push(dir);
    const st = new ControlState(dir);
    const hello = (version: string, start: Hello["start"]): Hello => ({
      name: `m-${version}`,
      harnesses: ["claude-code"],
      modes: ["sdk"],
      keys: [],
      version,
      waiting: [],
      folders: null,
      mode: "inherit",
      accounts: [],
      files: false,
      promptFiles: false,
      start,
      keyTypes: null,
    });
    // CONTROL.md §3.1: a machine whose hello has `start` takes a `~` folder; another doesn't.
    const opts = { "claude-code": { permissions: ["read" as const, "safe" as const], permission: "inherit" as const } };
    const newer = st.createMachine("m_tilde0000000000000001", hello("0.10.0", opts));
    const older = st.createMachine("m_tilde0000000000000002", hello("0.9.0", null));
    expect(st.machineControl(newer).tilde).toBeUndefined();
    st.takesTilde = true;
    expect(st.machineControl(newer).tilde).toBe(true);
    expect(st.machineControl(older).tilde).toBeUndefined();
    expect(st.machineControl(newer).mode).toBe("inherit");
    st.close();
  });
});
