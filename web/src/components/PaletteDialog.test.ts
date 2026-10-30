// SPDX-License-Identifier: Apache-2.0
import "../native/test-env";
import { describe, expect, it } from "vitest";
import { answerWords } from "./PaletteDialog";

describe("answerWords", () => {
  it("names a plan review's own pair, with no tool to allow", () => {
    const a = { kind: "permission", tool: "ExitPlanMode" };
    expect(answerWords(a, true)).toEqual({ verb: "Approve plan" });
    expect(answerWords(a, false)).toEqual({ verb: "Keep planning" });
  });
  it("names any other prompt's tool beside Allow and Deny", () => {
    expect(answerWords({ kind: "permission", tool: "run_shell_command" }, true)).toEqual({
      verb: "Allow",
      tool: "Shell",
    });
    expect(answerWords({ kind: "permission" }, false)).toEqual({ verb: "Deny", tool: "this" });
  });
});
