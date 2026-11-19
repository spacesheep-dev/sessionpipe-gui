// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { failureWords, type LocalUpdate, serviceRow } from "./receiverUpdate";

const local = (o: Partial<LocalUpdate> = {}): LocalUpdate => ({
  origin: "http://127.0.0.1:7373",
  running: "0.8.3",
  app: "0.8.4",
  state: "click",
  busy: false,
  ...o,
});
const idle = { busy: false, progress: null, failed: null };

describe("failureWords", () => {
  it("says what to do in one sentence, with the line to fold away", () => {
    expect(failureWords({ kind: "download", line: "couldn't download sessionpipe" })).toEqual({
      sentence: "Couldn't update it. Press Update again.",
      detail: "couldn't download sessionpipe",
    });
    expect(failureWords({ kind: "notRunning", line: "0.8.4 isn't running", log: "~/service.log" })).toEqual({
      sentence: "The update didn't finish and the service isn't running. Press Update again.",
      detail: "~/service.log",
    });
  });
});

describe("serviceRow", () => {
  it("behind (a click) and failed at launch: shown, with what to do", () => {
    expect(serviceRow(local(), idle)).toEqual({ kind: "behind", running: "0.8.3", app: "0.8.4" });
    expect(serviceRow(local({ state: "failed", why: "npx exited 1" }), idle)).toEqual({
      kind: "failed",
      running: "0.8.3",
      sentence: "Couldn't update it. Press Update again.",
      detail: "npx exited 1",
    });
  });

  it("working: the progress line, and a run that failed: its words", () => {
    expect(serviceRow(local(), { ...idle, busy: true, progress: "Looking for Node…" })).toEqual({
      kind: "working",
      running: "0.8.3",
      progress: "Looking for Node…",
    });
    expect(serviceRow(local(), { ...idle, busy: true })?.kind).toBe("working");
    expect(
      serviceRow(local(), { ...idle, failed: { kind: "notRunning", line: "x", log: "~/service.log" } }),
    ).toMatchObject({ kind: "failed", sentence: expect.stringContaining("isn't running"), detail: "~/service.log" });
  });

  it("says nothing where there is nothing to do", () => {
    expect(serviceRow(null, idle)).toBeNull();
    for (const state of ["current", "updated", "unchanged"] as const)
      expect(serviceRow(local({ state }), idle)).toBeNull();
    // An install running for another reason (the welcome's start) is not this row's.
    expect(serviceRow(local({ state: "current", busy: true }), { ...idle, busy: true })).toBeNull();
    // Updated from a terminal since launch: this window's receiver answers the app's version.
    expect(serviceRow(local(), idle, { live: "0.8.4" })).toBeNull();
    expect(serviceRow(local(), idle, { live: "0.8.3" })?.kind).toBe("behind");
  });

  it("once shown, a service brought current says its new version until the window closes", () => {
    expect(serviceRow(local({ state: "current", running: "0.8.4" }), idle, { shown: true })).toEqual({
      kind: "done",
      running: "0.8.4",
    });
    // Updated, its version not read yet: the app's.
    expect(serviceRow(local({ state: "updated", running: "" }), idle, { shown: true })).toEqual({
      kind: "done",
      running: "0.8.4",
    });
    expect(serviceRow(local(), idle, { shown: true, live: "0.8.4" })).toEqual({ kind: "done", running: "0.8.4" });
    expect(serviceRow(local({ state: "unchanged" }), idle, { shown: true })).toBeNull();
  });
});
