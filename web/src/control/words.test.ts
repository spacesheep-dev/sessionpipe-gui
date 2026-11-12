// SPDX-License-Identifier: Apache-2.0
// The words a start that did not start shows on its session page (words.ts): a machine's
// own detail ends the sentence it is quoted in, once, whatever punctuation it came with.
import type { ControlActivity } from "@shared/api";
import { describe, expect, it } from "vitest";
import { harnessCommand, outcomeWords, sentLine, startFailureWords } from "./words";

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

  it("says a refusal with no code once, with its note (a spacesheep without `code`)", () => {
    const a = start({ outcome: "refused", detail: "called off by its owner before the machine took it" });
    expect(startFailureWords(a, "rc-mac", "Claude Code")).toBe(
      "rc-mac refused it: called off by its owner before the machine took it.",
    );
    expect(startFailureWords(start({ outcome: "refused" }), "rc-mac", "Claude Code")).toBe("rc-mac refused it.");
    expect(outcomeWords(a)).toBe("refused · called off by its owner before the machine took it");
  });

  it("says a start called off before it began as that, not as the computer's refusal", () => {
    for (const outcome of ["refused", "failed"] as const)
      expect(
        startFailureWords(start({ outcome, code: "cancelled", detail: "called off" }), "rc-mac", "Claude Code"),
      ).toBe("This start was called off before it began on rc-mac.");
    expect(outcomeWords(start({ outcome: "refused", code: "cancelled" }))).toBe(
      "refused · called off before the machine took it",
    );
  });

  it("says a send it can no longer follow through spacesheep as that, not as a failure there", () => {
    const a = start({ outcome: "failed", code: "untracked" });
    expect(startFailureWords(a, "rc-mac", "Claude Code")).toBe(
      "This app no longer reads the spacesheep account that carried this, so it can't tell whether it started on rc-mac.",
    );
    expect(outcomeWords(a)).toBe("not followed · this app no longer reads the spacesheep account that carried it");
  });

  it("has nothing to say while the start is on its way or after it started", () => {
    expect(startFailureWords(start({}), "studio-mac", "Claude Code")).toBeNull();
    expect(startFailureWords(start({ outcome: "delivered" }), "studio-mac", "Claude Code")).toBeNull();
  });
});

describe("sentLine", () => {
  const o = { machine: "studio-mac", online: true, command: "claude" };
  it("follows a start's acks in words, and says Running once the agent is at it", () => {
    expect(sentLine(start({}), o)).toEqual({ text: "Sent to studio-mac", running: false });
    expect(sentLine(start({}), { ...o, online: false })?.text).toBe(
      "Waiting for studio-mac. It starts when the machine is back.",
    );
    expect(sentLine(start({ outcome: "taken" }), o)).toEqual({
      text: "Starting claude on studio-mac…",
      running: false,
    });
    expect(sentLine(start({ outcome: "taken", reply: "Reading…" }), o)).toEqual({ text: "Running", running: true });
    expect(sentLine(start({ outcome: "refused", code: "folder" }), o)).toBeNull();
  });

  it("an ACP agent's start (`api`) ran and answered in the ack: no first events promised", () => {
    expect(sentLine(start({ outcome: "delivered", mode: "api", reply: "Done." }), o)?.text).toBe("Ran on studio-mac.");
    expect(sentLine(start({ outcome: "delivered", mode: "sdk" }), o)?.text).toMatch(/first events are on their way/);
  });

  it("names the command a harness runs as, and keeps the label of one without", () => {
    expect(harnessCommand("claude-code", "Claude Code")).toBe("claude");
    expect(harnessCommand("antigravity", "Antigravity")).toBe("Antigravity");
  });
});
