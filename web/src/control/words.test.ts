// SPDX-License-Identifier: Apache-2.0
// The words a start that did not start shows on its session page (words.ts): a machine's
// own detail ends the sentence it is quoted in, once, whatever punctuation it came with.
import type { ControlActivity } from "@shared/api";
import { describe, expect, it } from "vitest";
import { startFailureWords } from "./words";

const start = (over: Partial<ControlActivity>): ControlActivity => ({
  id: "c1",
  machineId: "m1",
  kind: "start",
  session: "claude-code:00000000-0000-4000-8000-000000000000",
  text: "Upgrade the date library.",
  at: "2026-10-23T08:00:00.000Z",
  expiresAt: "2026-10-23T08:10:00.000Z",
  ...over,
});

describe("startFailureWords", () => {
  it("ends a machine's detail with one full stop", () => {
    const a = start({ outcome: "refused", code: "permission", detail: "this machine runs in safe mode" });
    expect(startFailureWords(a, "studio-mac", "Claude Code")).toBe(
      "studio-mac won't start this: this machine runs in safe mode.",
    );
  });

  it("keeps the detail's own ending", () => {
    const a = start({ outcome: "failed", detail: "claude exited with code 1." });
    expect(startFailureWords(a, "studio-mac", "Claude Code")).toBe(
      "It didn't start on studio-mac: claude exited with code 1.",
    );
  });

  it("says it plainly when the machine gave no detail", () => {
    const a = start({ outcome: "refused", code: "folder" });
    expect(startFailureWords(a, "build-box", "Claude Code")).toBe("build-box doesn't allow that folder.");
  });

  it("has nothing to say while the start is on its way or after it started", () => {
    expect(startFailureWords(start({}), "studio-mac", "Claude Code")).toBeNull();
    expect(startFailureWords(start({ outcome: "delivered" }), "studio-mac", "Claude Code")).toBeNull();
  });
});
