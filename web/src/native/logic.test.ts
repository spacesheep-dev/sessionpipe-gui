// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "./appState";
import {
  firstRunDue,
  hotkeyFrom,
  hotkeyLabel,
  isNoNode,
  lastCheckedLine,
  notifyToggle,
  parseAddress,
  type StartState,
  settingsApp,
  startStep,
  trayPlace,
  updateHint,
  updateLine,
} from "./logic";

const base: AppSettings = {
  launchAtLogin: false,
  menuBar: true,
  dockBadge: true,
  keepRunning: true,
  menuBarOnly: false,
  hotkey: null,
  notifications: { enabled: false, kinds: {}, pausedUntil: null },
};

describe("the welcome's start", () => {
  const starting: StartState = { kind: "starting", message: "Installing the background service…" };
  /** What `rx_start_local` rejects with, as the shell serialises it (lifecycle/supervisor.rs
   *  UpdateFailure: the kind, StartError's own words, the log a notRunning line names). */
  const fail = (error: unknown) => startStep(starting, { type: "error", error });

  it("begins and follows progress", () => {
    let s: StartState = { kind: "idle" };
    s = startStep(s, { type: "progress", message: "ignored before begin" });
    expect(s).toEqual({ kind: "idle" });
    s = startStep(s, { type: "begin" });
    expect(s).toEqual({ kind: "starting", message: "Starting sessionpipe…" });
    s = startStep(s, { type: "progress", step: "install", message: "Installing the background service…" });
    expect(s).toEqual(starting);
    s = startStep(s, { type: "progress", step: "wait", message: "  " });
    expect(s).toEqual(starting);
  });
  it("no Node: where to get it, by the shell's kind", () => {
    expect(fail({ kind: "noNode", line: "sessionpipe needs Node 20 or later" })).toEqual({ kind: "needsNode" });
  });
  it("no Node, said in words alone: the same", () => {
    // What the shell rejected with before it gave a kind, and never matched.
    expect(fail("sessionpipe needs Node 20 or later")).toEqual({ kind: "needsNode" });
    expect(isNoNode("sessionpipe needs Node 20 or later")).toBe(true);
    expect(startStep(starting, { type: "progress", step: "no-node" })).toEqual({ kind: "needsNode" });
    expect(fail({ code: "no-node", message: "…" })).toEqual({ kind: "needsNode" });
    expect(isNoNode(new Error("node not found on PATH"))).toBe(true);
    expect(isNoNode("no-node")).toBe(true);
    expect(isNoNode("launchctl failed")).toBe(false);
  });
  it("started and still loading: one sentence, and no line to unfold", () => {
    expect(
      fail({
        kind: "timeout",
        line: "sessionpipe started but isn't answering on port 7373 yet; a big board takes a while to load",
      }),
    ).toEqual({ kind: "failed", sentence: "Give it a minute to load, then try again." });
  });
  it("another install at work: waited for, and said not to have started only when nothing answers", () => {
    const busy = fail({ kind: "busy", line: "an install or update is already running" });
    expect(busy).toEqual({ kind: "busy", line: "an install or update is already running" });
    expect(
      fail({ kind: "stillRunning", line: "the update is still finishing; it carries on in the background" }),
    ).toEqual({ kind: "busy", line: "the update is still finishing; it carries on in the background" });
    // Progress from the run that was refused changes nothing.
    expect(startStep(busy, { type: "progress", message: "Looking for Node…" })).toEqual(busy);
    expect(startStep(busy, { type: "noAnswer" })).toEqual({
      kind: "failed",
      sentence: "It didn't start.",
      detail: "an install or update is already running",
    });
    expect(startStep(starting, { type: "noAnswer" })).toEqual(starting);
  });
  it("anything else: it didn't start, with the shell's line kept for Details", () => {
    expect(fail({ kind: "failed", line: "service install exited with 1" })).toEqual({
      kind: "failed",
      sentence: "It didn't start.",
      detail: "service install exited with 1",
    });
    expect(
      fail({ kind: "download", line: "couldn't download sessionpipe (npm error code E404); nothing was changed" }),
    ).toEqual({
      kind: "failed",
      sentence: "It didn't start.",
      detail: "couldn't download sessionpipe (npm error code E404); nothing was changed",
    });
    // The log goes under the line, unless the line names it already (the shell reads it from there).
    const line = "sessionpipe-gui: 0.8.4 isn't running on :7373 after 90 s: see ~/s/service.log";
    expect(fail({ kind: "notRunning", line, log: "~/s/service.log" })).toEqual({
      kind: "failed",
      sentence: "It didn't start.",
      detail: line,
    });
    expect(fail({ kind: "notRunning", line: "it isn't running", log: "~/s/service.log" })).toEqual({
      kind: "failed",
      sentence: "It didn't start.",
      detail: "it isn't running\n~/s/service.log",
    });
    // Words alone (a thrown Error, a string) are the line; nothing readable leaves nothing to unfold.
    expect(fail(new Error("port 7373 is taken"))).toEqual({
      kind: "failed",
      sentence: "It didn't start.",
      detail: "port 7373 is taken",
    });
    expect(fail(undefined)).toEqual({ kind: "failed", sentence: "It didn't start.", detail: "" });
  });
});

describe("addresses", () => {
  it("takes a host, a URL or a phone link", () => {
    expect(parseAddress("studio-mac.local:7373")).toBe("http://studio-mac.local:7373/");
    expect(parseAddress(" https://studio-mac.local:7374/?k=abc ")).toBe("https://studio-mac.local:7374/?k=abc");
    expect(parseAddress("")).toBeNull();
    expect(parseAddress("ftp://x")).toBeNull();
    expect(parseAddress("javascript:alert(1)")).toBeNull();
    expect(parseAddress("http://")).toBeNull();
  });
});

describe("the first-run sheet", () => {
  it("shows once", () => {
    expect(firstRunDue(null, false)).toBe(true);
    expect(firstRunDue(null, true)).toBe(false);
    // The shell's word wins over this device's memory.
    expect(firstRunDue({ ...base, firstRunDone: true }, false)).toBe(false);
    expect(firstRunDue({ ...base, firstRunDone: false }, true)).toBe(true);
    expect(firstRunDue(base, true)).toBe(false);
  });
  it("asks for notification permission only when turned on", async () => {
    const ask = vi.fn(async () => "granted" as const);
    expect(await notifyToggle(false, ask)).toEqual({ enabled: false, note: null });
    expect(ask).not.toHaveBeenCalled();
    expect(await notifyToggle(true, ask)).toEqual({ enabled: true, note: null });
    expect(ask).toHaveBeenCalledTimes(1);
    const denied = await notifyToggle(true, async () => "denied");
    expect(denied.enabled).toBe(false);
    expect(denied.note).toMatch(/System Settings/);
    expect(await notifyToggle(true, async () => null)).toEqual({ enabled: false, note: null });
  });
  it("names the tray and the settings app as each computer does", () => {
    expect(trayPlace("macos")).toBe("menu bar");
    expect(trayPlace("windows")).toBe("system tray");
    expect(trayPlace("linux")).toBe("system tray");
    expect(settingsApp("macos")).toBe("System Settings");
    expect(settingsApp("windows")).toBe("Settings");
    expect(settingsApp("ios")).toBe("Settings");
  });
});

describe("the shortcut recorder", () => {
  const k = (
    code: string,
    key: string,
    m: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>,
  ) => ({
    code,
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...m,
  });
  it("needs ⌃, ⌥ or ⌘ and a real key", () => {
    expect(hotkeyFrom(k("KeyN", "˜", { ctrlKey: true, altKey: true }))).toBe("Control+Alt+N");
    expect(hotkeyFrom(k("Digit5", "5", { metaKey: true, shiftKey: true }))).toBe("Shift+Command+5");
    expect(hotkeyFrom(k("KeyN", "N", { shiftKey: true }))).toBeNull();
    expect(hotkeyFrom(k("KeyN", "n", {}))).toBeNull();
    expect(hotkeyFrom(k("ControlLeft", "Control", { ctrlKey: true }))).toBeNull();
    expect(hotkeyFrom(k("F5", "F5", { altKey: true }))).toBe("Alt+F5");
  });
  it("writes it as the Mac does", () => {
    expect(hotkeyLabel("Control+Alt+N")).toBe("⌃⌥N");
    expect(hotkeyLabel("Shift+Command+Space")).toBe("⇧⌘Space");
    expect(hotkeyLabel("Command+Control+KeyK")).toBe("⌃⌘K");
    expect(hotkeyLabel(null)).toBe("");
  });
  it("writes it in words on Windows and Linux, where ⌃⌥ means nothing", () => {
    expect(hotkeyLabel("Control+Alt+N", "windows")).toBe("Ctrl+Alt+N");
    expect(hotkeyLabel("Shift+Command+Space", "windows")).toBe("Shift+Win+Space");
    expect(hotkeyLabel("Command+Control+KeyK", "linux")).toBe("Ctrl+Super+K");
    expect(hotkeyLabel("CmdOrCtrl+Shift+Digit5", "windows")).toBe("Ctrl+Shift+5");
    // CmdOrCtrl and Control are one key off a Mac: named once.
    expect(hotkeyLabel("CmdOrCtrl+Control+N", "windows")).toBe("Ctrl+N");
    expect(hotkeyLabel("Control+Alt+N", "macos")).toBe("⌃⌥N");
    expect(hotkeyLabel(null, "windows")).toBe("");
  });
});

describe("the update row", () => {
  it("says where the update is", () => {
    expect(updateLine("0.3.0", { state: "idle" })).toBe("sessionpipe 0.3.0 is up to date");
    expect(updateLine("0.3.0", { state: "checking" })).toBe("Checking for updates…");
    expect(updateLine("0.3.0", { state: "downloading", version: "0.3.1", progress: 42 })).toBe(
      "Downloading 0.3.1… 42%",
    );
    expect(updateLine("0.3.0", { state: "ready", version: "0.3.1" })).toBe("0.3.1 is ready");
    expect(updateLine("0.3.0", { state: "error" })).toBe("Couldn't check for updates");
  });
  it("says when it last looked", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    expect(lastCheckedLine(undefined, now)).toBe("");
    expect(lastCheckedLine("2026-10-30T11:59:40Z", now)).toBe("Last checked just now");
    expect(lastCheckedLine("2026-10-30T11:35:00Z", now)).toBe("Last checked 25 min ago");
    expect(lastCheckedLine("2026-10-30T10:59:00Z", now)).toBe("Last checked 1 hour ago");
    expect(lastCheckedLine("2026-10-30T06:00:00Z", now)).toBe("Last checked 6 hours ago");
    expect(lastCheckedLine("2026-10-29T08:00:00Z", now)).toBe("Last checked yesterday");
    expect(lastCheckedLine("2026-10-26T08:00:00Z", now)).toBe("Last checked 4 days ago");
  });
  it("captions the row with the reason, the version you have and the last check", () => {
    const now = Date.parse("2026-10-30T12:00:00Z");
    const at = "2026-10-30T11:59:50Z";
    expect(updateHint("0.6.0", { state: "idle" }, now)).toBe("");
    expect(updateHint("0.6.0", { state: "idle", lastChecked: at }, now)).toBe("Last checked just now.");
    expect(updateHint("0.6.0", { state: "ready", version: "0.7.0", lastChecked: at }, now)).toBe(
      "You have 0.6.0. Last checked just now.",
    );
    expect(
      updateHint(
        "0.6.0",
        { state: "error", error: "You're offline, or GitHub can't be reached.", lastChecked: at },
        now,
      ),
    ).toBe("You're offline, or GitHub can't be reached. Last checked just now.");
  });
});
