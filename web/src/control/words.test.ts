// SPDX-License-Identifier: Apache-2.0
// The words a start that did not start shows on its session page (words.ts): a machine's
// own detail ends the sentence it is quoted in, once, whatever punctuation it came with.
import type { ControlActivity } from "@shared/api";
import { describe, expect, it } from "vitest";
import { ControlError } from "./api";
import {
  handoffEndWords,
  harnessCommand,
  outcomeWords,
  promptFailureWords,
  refusalWords,
  sendErrorWords,
  sentLine,
  startFailureWords,
} from "./words";

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
      "rc-mac refused it. Called off by its owner before the machine took it.",
    );
    expect(startFailureWords(start({ outcome: "refused" }), "rc-mac", "Claude Code")).toBe("rc-mac refused it.");
    // An older spacesheep's bare outcome as the note: said once.
    expect(startFailureWords(start({ outcome: "refused", detail: "refused" }), "rc-mac", "Claude Code")).toBe(
      "rc-mac refused it.",
    );
    expect(outcomeWords(start({ outcome: "refused", detail: "refused" }))).toBe("refused");
    expect(outcomeWords(a)).toBe("refused · called off by its owner before the machine took it");
  });

  it("says a start called off before it began as that, not as the computer's refusal", () => {
    for (const outcome of ["refused", "failed"] as const)
      expect(
        startFailureWords(start({ outcome, code: "cancelled", detail: "called off" }), "rc-mac", "Claude Code"),
      ).toBe("Cancelled before rc-mac started it.");
    expect(outcomeWords(start({ outcome: "refused", code: "cancelled" }))).toBe(
      "cancelled · before the machine started it",
    );
  });

  it("says a send it can no longer follow through spacesheep as that, not as a failure there", () => {
    const a = start({ outcome: "failed", code: "untracked" });
    expect(startFailureWords(a, "rc-mac", "Claude Code")).toBe(
      "Sent through a spacesheep account that's no longer connected here. Check spacesheep.dev to see if it started.",
    );
    expect(outcomeWords(a)).toBe("not followed · sent through an account that's no longer connected");
    const u = start({ outcome: "unconfirmed" });
    expect(startFailureWords(u, "rc-mac", "Claude Code")).toBe(
      "No word from rc-mac since it took this. Check spacesheep.dev to see how it went.",
    );
    expect(outcomeWords(u, { machine: "rc-mac" })).toBe("no word · rc-mac took it and said nothing more");
    const w = start({ unfollowed: "disconnected" });
    expect(sentLine(w, { machine: "rc-mac", online: false, command: "claude" })?.text).toBe(
      "Not being followed while spacesheep is disconnected.",
    );
    expect(
      sentLine(start({ unfollowed: "revoked" }), { machine: "rc-mac", online: false, command: "claude" })?.text,
    ).toBe("Not being followed: spacesheep no longer takes this app's key.");
  });

  it("a send spacesheep took without naming its job claims nothing of the computer: sent, and not followed", () => {
    const n = start({ outcome: "unconfirmed", code: "no_job" });
    const said = [
      startFailureWords(n, "rc-mac", "Claude Code"),
      promptFailureWords({ ...n, kind: "prompt" }, "rc-mac"),
      outcomeWords(n, { machine: "rc-mac" }),
      handoffEndWords(n, "rc-mac"),
    ];
    expect(said).toEqual([
      "Sent, but this app can't follow it. Check spacesheep.dev to see how it went.",
      "Sent, but this app can't follow it. Check spacesheep.dev to see how it went.",
      "not followed · spacesheep didn't say which job it is",
      "not followed · spacesheep didn't say which job it is",
    ]);
    // Nothing here knows that the computer took it, or that it was not sent.
    for (const s of said) {
      expect(s).not.toContain("rc-mac");
      expect(s).not.toMatch(/took this|not sent/i);
    }
  });

  it('a handoff\'s card says "not sent" only of what was not: a send whose end is not known says what is', () => {
    // Sent, and no word of the end: the computer's silence, or an account no longer connected.
    expect(handoffEndWords(start({ outcome: "unconfirmed" }), "rc-mac")).toBe(
      "no word · rc-mac took it and said nothing more",
    );
    expect(handoffEndWords(start({ outcome: "failed", code: "untracked" }), "rc-mac")).toBe(
      "not followed · sent through an account that's no longer connected",
    );
    // What did not go: as it was.
    expect(handoffEndWords(start({ outcome: "refused", code: "folder" }), "rc-mac")).toBe(
      `not sent · ${refusalWords("folder")}`,
    );
    expect(handoffEndWords(start({ outcome: "failed", detail: "the path errored" }), "rc-mac")).toBe(
      "not sent · the path errored",
    );
    expect(handoffEndWords(start({ outcome: "expired" }), "rc-mac")).toBe("not sent · expired");
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

describe("sendErrorWords", () => {
  it("tells spacesheep's refusal of this app's key from the page's own key", () => {
    expect(sendErrorWords(new ControlError(502, "Unknown or revoked API key.", "spacesheep_unauthorized"))).toBe(
      "Not sent. spacesheep no longer takes this app's key: disconnect and connect again in Settings → Data.",
    );
    expect(
      sendErrorWords(new ControlError(422, "Files can't be sent to rc-mac through spacesheep yet.", "relay_files")),
    ).toBe("Not sent. Files can't be sent to rc-mac through spacesheep yet.");
    expect(sendErrorWords(new ControlError(401, "unauthorized"))).toBe(
      "not sent · this page lost its key; reload it from the terminal's link",
    );
  });

  it("a send nobody heard the answer to is never said to be not sent", () => {
    expect(sendErrorWords(new ControlError(502, "spacesheep did not answer in time.", "hub_unknown"))).toBe(
      "It may have been sent: spacesheep did not answer in time. Look at the session before you send it again.",
    );
    expect(sendErrorWords(new ControlError(502, "spacesheep could not be reached", "hub_unknown"))).toBe(
      "It may have been sent: spacesheep could not be reached. Look at the session before you send it again.",
    );
    // A refusal the app made before any network is not sent, as before.
    expect(sendErrorWords(new ControlError(502, "That is too large to send.", "hub_too_large"))).toBe(
      "not sent · That is too large to send.",
    );
  });
});
