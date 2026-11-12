// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { olderReceiver, SINCE, updateCommand } from "./serverAge";

const here = { appVersion: "0.8.0", receiver: { name: "studio-mac", local: true } };
const g = globalThis as { sessionpipeShell?: unknown };
afterEach(() => {
  delete g.sessionpipeShell;
});

describe("olderReceiver", () => {
  it("in the app, says the receiver on this computer is older than the option, with the command and the app", () => {
    expect(olderReceiver("spacesheep", "0.7.2", { shell: here })).toEqual({
      sentence:
        "sessionpipe on this computer is 0.7.2, which is older than this option. Update it with this command, or reopen the app:",
      command:
        "npx -y --package=https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v0.8.0/sessionpipe-gui-0.8.0.tgz -- sessionpipe-gui service install",
    });
    expect(updateCommand("0.8.0")).toBe(olderReceiver("spacesheep", "0.7.2", { shell: here })?.command);
  });

  it("says nothing where the receiver has the option, or the page is the receiver's own", () => {
    expect(olderReceiver("spacesheep", SINCE.spacesheep, { shell: here })).toBeNull();
    expect(olderReceiver("spacesheep", "0.10.0", { shell: here })).toBeNull();
    expect(olderReceiver("spacesheep", undefined, { shell: here })).toBeNull();
    // A page the receiver served: no flag, nothing to say, even on a 404.
    expect(olderReceiver("spacesheep", "0.7.2", { shell: null })).toBeNull();
    expect(olderReceiver("spacesheep", "0.7.2", { shell: null, notFound: true })).toBeNull();
  });

  it("takes a 404 as older, saying the version where it knows it", () => {
    // Info.version up to 0.8.0 can name the new version while the old code answers.
    expect(olderReceiver("spacesheep", "0.8.0", { shell: here, notFound: true })?.sentence).toBe(
      "sessionpipe on this computer is 0.8.0, which is older than this option. Update it with this command, or reopen the app:",
    );
    expect(olderReceiver("spacesheep", undefined, { shell: here, notFound: true })?.sentence).toBe(
      "sessionpipe on this computer is older than this option. Update it with this command, or reopen the app:",
    );
  });

  it("names another machine's receiver and sends the update there; with no app version, no command", () => {
    const there = { appVersion: "0.8.0", receiver: { name: "build-box", local: false } };
    expect(olderReceiver("spacesheep", "0.7.2", { shell: there })).toEqual({
      sentence: "sessionpipe on build-box is 0.7.2, which is older than this option. Update it there.",
    });
    expect(olderReceiver("spacesheep", "0.7.2", { shell: { receiver: { local: true } } })).toEqual({
      sentence: "sessionpipe on this computer is 0.7.2, which is older than this option. Update it, or reopen the app.",
    });
  });

  it("reads the app's flag from the page when none is given", () => {
    expect(olderReceiver("spacesheep", "0.7.2")).toBeNull();
    g.sessionpipeShell = { v: 1, platform: "macos", ...here };
    expect(olderReceiver("spacesheep", "0.7.2")?.command).toContain("/v0.8.0/");
  });
});
