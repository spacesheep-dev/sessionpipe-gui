// SPDX-License-Identifier: Apache-2.0
// The row menu's Allow and Deny name the tool as the strip and the Inbox do.
import { describe, expect, it, vi } from "vitest";

// The menus this file imports listen on the window when they load; node has none.
vi.hoisted(() => {
  Object.assign(globalThis, { window: new EventTarget() });
});

import { answerItems } from "./SessionCard";

describe("answerItems", () => {
  it("names the tool by its label", () => {
    const st = { off: false, reason: null };
    expect(answerItems("run_shell_command", st, () => {}).map((i) => "label" in i && i.label)).toEqual([
      "Allow Shell",
      "Deny Shell",
    ]);
    expect(answerItems("Bash", st, () => {}).map((i) => "label" in i && i.label)).toEqual(["Allow Bash", "Deny Bash"]);
    expect(answerItems(undefined, st, () => {}).map((i) => "label" in i && i.label)).toEqual(["Allow", "Deny"]);
  });
  it("asks a plan review's own question", () => {
    const st = { off: false, reason: null };
    for (const tool of ["ExitPlanMode", "exit_plan_mode"])
      expect(answerItems(tool, st, () => {}).map((i) => "label" in i && i.label)).toEqual([
        "Approve plan",
        "Keep planning",
      ]);
  });
});
