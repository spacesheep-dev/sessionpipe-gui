// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { isRouteNotFound, olderReceiver, SINCE, updateCommand } from "./serverAge";

const ORIGIN = "http://127.0.0.1:7373";
const shell = { appVersion: "0.8.1", receiver: { name: "studio-mac", origin: ORIGIN, local: true } };
/** The app's launch check found this receiver to be this computer's (its run.json names it). */
const here = { shell, localOrigin: ORIGIN };
const g = globalThis as { sessionpipeShell?: unknown };
afterEach(() => {
  delete g.sessionpipeShell;
});

describe("olderReceiver", () => {
  it("on this computer, in the app: the sentence, the button, and the command to copy", () => {
    expect(olderReceiver("spacesheep", "0.7.2", here)).toEqual({
      sentence: "sessionpipe on this computer is 0.7.2, which is older than this option.",
      here: true,
      command:
        "npx -y --package=https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v0.8.1/sessionpipe-gui-0.8.1.tgz -- sessionpipe-gui service install",
    });
    expect(updateCommand("0.8.1")).toBe(olderReceiver("spacesheep", "0.7.2", here)?.command);
  });

  it("says nothing where the receiver has the option, or the page is the receiver's own", () => {
    expect(olderReceiver("spacesheep", SINCE.spacesheep, here)).toBeNull();
    expect(olderReceiver("spacesheep", "0.10.0", here)).toBeNull();
    expect(olderReceiver("spacesheep", undefined, here)).toBeNull();
    // A page the receiver served: no flag, nothing to say, even on a 404.
    expect(olderReceiver("spacesheep", "0.7.2", { shell: null })).toBeNull();
    expect(olderReceiver("spacesheep", "0.7.2", { shell: null, notFound: true })).toBeNull();
  });

  it("takes the receiver's own 404 as older, and names the version only when it is below the option's", () => {
    // A stale process whose info names the new version (up to 0.8.0): no "is 0.8.0, which is older".
    expect(olderReceiver("spacesheep", "0.8.0", { ...here, notFound: true })?.sentence).toBe(
      "sessionpipe on this computer is older than this option.",
    );
    expect(olderReceiver("spacesheep", undefined, { ...here, notFound: true })?.sentence).toBe(
      "sessionpipe on this computer is older than this option.",
    );
    expect(olderReceiver("spacesheep", "0.7.2", { ...here, notFound: true })?.sentence).toBe(
      "sessionpipe on this computer is 0.7.2, which is older than this option.",
    );
  });

  it("tells the receiver's 404 from the app proxy's: only `{ reason: \"not_found\" }` is a missing route", () => {
    expect(isRouteNotFound(404, { reason: "not_found" })).toBe(true);
    // The proxy's "unknown receiver" is plain text, which parses to nothing.
    expect(isRouteNotFound(404, {})).toBe(false);
    expect(isRouteNotFound(404, null)).toBe(false);
    expect(isRouteNotFound(400, { reason: "not_found" })).toBe(false);
  });

  it("a loopback receiver the launch check didn't find to be this computer's (a tunnel) is another machine's", () => {
    for (const localOrigin of [null, undefined, "http://127.0.0.1:7380"]) {
      expect(olderReceiver("spacesheep", "0.7.2", { shell, localOrigin })).toEqual({
        sentence: "sessionpipe on studio-mac is 0.7.2, which is older than this option. Update it there.",
        here: false,
      });
    }
    const there = { appVersion: "0.8.1", receiver: { name: "build-box", origin: "http://build-box.local:7373" } };
    expect(olderReceiver("spacesheep", "0.7.2", { shell: there, localOrigin: ORIGIN })?.sentence).toBe(
      "sessionpipe on build-box is 0.7.2, which is older than this option. Update it there.",
    );
    // No app version in the flag: no command.
    expect(olderReceiver("spacesheep", "0.7.2", { shell: { receiver: shell.receiver }, localOrigin: ORIGIN })).toEqual({
      sentence: "sessionpipe on this computer is 0.7.2, which is older than this option.",
      here: true,
    });
  });

  it("reads the app's flag from the page when none is given", () => {
    expect(olderReceiver("spacesheep", "0.7.2")).toBeNull();
    g.sessionpipeShell = { v: 1, platform: "macos", ...shell };
    expect(olderReceiver("spacesheep", "0.7.2", { localOrigin: ORIGIN })?.command).toContain("/v0.8.1/");
  });
});
