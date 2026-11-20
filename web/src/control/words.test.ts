// SPDX-License-Identifier: Apache-2.0
// The words a start that did not start shows on its session page (words.ts): a machine's
// own detail ends the sentence it is quoted in, once, whatever punctuation it came with.
import type { ControlActivity } from "@shared/api";
import { describe, expect, it, vi } from "vitest";
import { ControlError, UNHEARD_CODE } from "./api";
import { noteMachineControl } from "./remoteRp";
import {
  answerEndWords,
  handoffEndWords,
  harnessCommand,
  notSentLine,
  notSentWords,
  outcomeWords,
  promptFailureWords,
  receiptWords,
  refusalWords,
  sendErrorWords,
  sentLine,
  startFailureWords,
  unheardWords,
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
    // The account's own host is the one named, where the machine's row says where it lives.
    noteMachineControl({
      machineId: "m-else",
      remote: { via: "spacesheep", origin: "https://sheep.example.org", rpId: "sheep.example.org" },
    } as never);
    expect(startFailureWords({ ...n, machineId: "m-else" }, "rc-mac", "Claude Code")).toBe(
      "Sent, but this app can't follow it. Check sheep.example.org to see how it went.",
    );
    noteMachineControl({ machineId: "m-else" } as never);
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
  it("on a spacesheep account names no place that is not there: a refused key is connected again where the account is, Settings → App", async () => {
    const g = globalThis as { sessionpipeShell?: unknown };
    g.sessionpipeShell = {
      rxBase: "rx://localhost/ACCT",
      receiver: { kind: "spacesheep", origin: "https://spacesheep.dev" },
    };
    vi.resetModules();
    try {
      const { sendErrorWords: words } = await import("./words");
      const { ControlError: Refused } = await import("./api");
      const said = words(new Refused(502, "Unknown or revoked API key.", "spacesheep_unauthorized"));
      // The phone's own sentence: the account is under Settings → App, and is connected again there.
      expect(said).toBe("Not sent. spacesheep no longer takes this app's key: connect again in Settings → App.");
      expect(said).not.toMatch(/Settings → Data|disconnect/);
    } finally {
      delete g.sessionpipeShell;
      vi.resetModules();
    }
  });

  it("on a spacesheep account a key the computer does not list is said as that, with the computer's name", async () => {
    const g = globalThis as { sessionpipeShell?: unknown };
    g.sessionpipeShell = {
      platform: "ios",
      rxBase: "rx://localhost/ACCT",
      receiver: { kind: "spacesheep", origin: "https://spacesheep.dev" },
    };
    vi.resetModules();
    try {
      const { sendErrorWords: words } = await import("./words");
      const { ControlError: Refused } = await import("./api");
      const refused = new Refused(422, "That key isn't trusted on this computer.", "untrusted_key");
      expect(words(refused, "Misha-Petrov-laptop")).toBe("Not sent: Misha-Petrov-laptop hasn't added this iPhone yet.");
      // Never the day grant's words, which would promise a Face ID that changes nothing.
      expect(words(refused, "Misha-Petrov-laptop")).not.toMatch(/grant|Face ID/);
      expect(words(refused)).toBe("Not sent: the computer hasn't added this iPhone yet.");
    } finally {
      delete g.sessionpipeShell;
      vi.resetModules();
    }
  });

  it("a send held back for the hour a new device waits says from when in one sentence, never spacesheep's paragraph", async () => {
    const g = globalThis as { sessionpipeShell?: unknown };
    g.sessionpipeShell = {
      platform: "ios",
      rxBase: "rx://localhost/ACCT",
      receiver: { kind: "spacesheep", origin: "https://spacesheep.dev" },
    };
    vi.resetModules();
    try {
      const { sendErrorWords: words } = await import("./words");
      const { ControlError: Refused } = await import("./api");
      const { clock } = await import("../native/accountWords");
      const paragraph =
        "This device was approved from another device less than an hour ago. New devices wait an hour before they can send, so a stolen sign-in can't act at once. It can send in 58 minutes.";
      const until = Date.parse("2026-11-16T05:26:00Z");
      const said = words(new Refused(403, paragraph, "cooling", paragraph, until));
      expect(said).toBe(`Not sent. This iPhone can send from ${clock(until)}.`);
      expect(said).toMatch(/^Not sent\. This iPhone can send from \d{1,2}:\d{2}( [AP]M)?\.$/);
      // spacesheep named no time: why it waits, still in the app's words.
      expect(words(new Refused(403, paragraph, "cooling", paragraph))).toBe(
        "Not sent. New devices wait an hour, so a stolen sign-in can't act at once.",
      );
      for (const e of [
        new Refused(403, paragraph, "cooling", paragraph, until),
        new Refused(403, paragraph, "cooling"),
      ])
        expect(words(e)).not.toMatch(/This device|minutes/);
    } finally {
      delete g.sessionpipeShell;
      vi.resetModules();
    }
  });

  it("tells spacesheep's refusal of this app's key from the page's own key", () => {
    expect(sendErrorWords(new ControlError(502, "Unknown or revoked API key.", "spacesheep_unauthorized"))).toBe(
      "Not sent. spacesheep no longer takes this app's key: disconnect and connect again in Settings → Data.",
    );
    expect(
      sendErrorWords(new ControlError(422, "Files can't be sent to rc-mac through spacesheep yet.", "relay_files")),
    ).toBe("Not sent. Files can't be sent to rc-mac through spacesheep yet.");
    expect(sendErrorWords(new ControlError(401, "unauthorized"))).toBe(
      "not sent · this page's key does not open the board: open the board's link again",
    );
  });

  it("a send nobody heard the answer to says the same of its row: it may have been sent, then what it turned out to be", () => {
    const row = start({ kind: "prompt", code: "hub_unknown", detail: "spacesheep did not answer in time." });
    const may =
      "It may have been sent: spacesheep did not answer in time. Look at the session before you send it again.";
    // While the app finds out, and when nobody can say any more.
    const asking = { ...row, unheard: { state: "asking" as const } };
    const unknown = { ...row, outcome: "unconfirmed" as const, unheard: { state: "unknown" as const } };
    for (const a of [asking, unknown]) {
      expect(unheardWords(a)).toBe(may);
      expect(outcomeWords(a, { machine: "rc-mac" })).toBe(may);
      expect(sentLine(a, { machine: "rc-mac", online: true, command: "claude" })).toEqual({
        text: may,
        running: false,
      });
    }
    // Still being asked for, it is no failure yet; settled as one nobody can say, it reads the same.
    expect(promptFailureWords(asking, "rc-mac")).toBeNull();
    expect(startFailureWords({ ...asking, kind: "start" }, "rc-mac", "Claude Code")).toBeNull();
    expect(promptFailureWords(unknown, "rc-mac")).toBe(may);
    // No job was made: a send's own words for the refusal, never the computer's.
    const unsent = (over: Partial<ControlActivity>, u: { status: number; reason: string }) => ({
      ...row,
      code: undefined,
      detail: undefined,
      outcome: "failed" as const,
      ...over,
      unheard: { state: "unsent" as const, ...u },
    });
    const old = unsent({ code: "too_old" }, { status: 422, reason: "That was signed too long ago." });
    expect(unheardWords(old)).toBe("not sent · signed too long ago; send it again");
    expect(promptFailureWords(old, "rc-mac")).toBe("not sent · signed too long ago; send it again");
    const folder = unsent(
      { code: "folder", detail: "rc-mac only lets the agent work in: /srv." },
      { status: 400, reason: "rc-mac only lets the agent work in: /srv." },
    );
    expect(unheardWords(folder)).toBe("not sent · rc-mac only lets the agent work in: /srv.");
    // Every other row has nothing of this to say.
    expect(unheardWords(start({ outcome: "delivered" }))).toBeNull();
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

describe("notSentWords", () => {
  it("a send that did not go, as a line of its own says it: one form under a field, in a sheet and in the Inbox", () => {
    expect(notSentWords(new ControlError(422, "refused", "nonce_store"))).toBe(
      "Not sent: the machine could not record the nonce, so it did not run it",
    );
    expect(notSentWords(new ControlError(404, "unknown_machine"))).toBe(
      "Not sent: this machine is no longer paired here",
    );
    expect(notSentLine("not sent · x")).toBe("Not sent: x");
    // Words that are already a sentence of their own stay as they are.
    expect(notSentWords(new ControlError(502, "Unknown or revoked API key.", "spacesheep_unauthorized"))).toBe(
      "Not sent. spacesheep no longer takes this app's key: disconnect and connect again in Settings → Data.",
    );
    // A send nobody heard the answer to is never said to be not sent.
    const unheard = new ControlError(
      504,
      "spacesheep did not answer in time.",
      UNHEARD_CODE,
      "spacesheep did not answer in time.",
    );
    expect(notSentWords(unheard)).toBe(sendErrorWords(unheard));
    expect(notSentWords(unheard)).toMatch(/^It may have been sent: /);
    // Only the start of the line: a reason that quotes the words keeps them.
    expect(notSentLine("Not sent: the reason says not sent · here")).toBe("Not sent: the reason says not sent · here");
  });
});

describe("receiptWords", () => {
  it("says which answer went first, then what it waits for", () => {
    expect(receiptWords({ decision: "allow", machine: "studio-mac" })).toEqual({
      what: "Allowed",
      text: "Allowed · waiting for studio-mac",
    });
    expect(receiptWords({ decision: "deny", machine: "studio-mac" }).text).toBe("Denied · waiting for studio-mac");
    expect(receiptWords({ decision: "allow", plan: true, machine: "studio-mac" }).text).toBe(
      "Plan approved · waiting for studio-mac",
    );
    expect(receiptWords({ decision: "deny", plan: true, machine: "studio-mac" }).text).toBe(
      "Asked for changes · waiting for studio-mac",
    );
    expect(receiptWords({ decision: "allow", machine: "studio-mac", offline: true }).text).toBe(
      "Allowed · waiting for studio-mac to come back",
    );
    expect(receiptWords({ decision: "allow" }).text).toBe("Allowed · waiting for its computer");
  });
});

describe("answerEndWords", () => {
  const answer = (over: Partial<ControlActivity>) =>
    start({ kind: "permission.answer", text: "allow", answer: { for: "perm-1", decision: "allow" }, ...over });
  it("says why an answer did not go as a line of its own", () => {
    expect(answerEndWords(answer({ outcome: "refused", code: "nonce_store" }), "studio-mac")).toBe(
      "Not sent: the machine could not record the nonce, so it did not run it",
    );
    expect(answerEndWords(answer({ outcome: "failed", detail: "the hook is gone" }), "studio-mac")).toBe(
      "Not sent: the hook is gone",
    );
    // Taken and never heard of again is no "not sent".
    expect(answerEndWords(answer({ outcome: "unconfirmed" }), "studio-mac")).toMatch(/^No word from studio-mac/);
  });
});
