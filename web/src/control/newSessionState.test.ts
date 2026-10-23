// SPDX-License-Identifier: Apache-2.0
// The New session sheet's state (newSessionState.ts): which machine a plain "New session…"
// means, a remembered choice pruned to what the machine still advertises, the alias window.
import type { ControlActivity, MachineControl } from "@shared/api";
import { describe, expect, it } from "vitest";
import {
  aliasHidden,
  fixedPermission,
  machineFacts,
  pickContext,
  pruneRemembered,
  readDraft,
  saveDraft,
} from "./newSessionState";

const sessions = [
  { machine: "build-box", lastAt: "2026-10-23T09:00:00Z" },
  { machine: "studio-mac", lastAt: "2026-10-23T11:00:00Z" },
  { machine: "laptop", lastAt: "2026-10-23T12:00:00Z" },
];
const machines = ["build-box", "studio-mac"];

describe("pickContext", () => {
  it("an explicit target first", () => {
    expect(
      pickContext({
        target: { machine: "build-box", harness: "codex" },
        filter: { machine: "studio-mac" },
        sessions,
        machines,
      }),
    ).toEqual({ machine: "build-box", harness: "codex" });
  });
  it("then the board's one-value filter, keeping its harness", () => {
    expect(
      pickContext({
        filter: { machine: "studio-mac", harness: "codex" },
        last: { machine: "build-box" },
        sessions,
        machines,
      }),
    ).toEqual({ machine: "studio-mac", harness: "codex" });
  });
  it("then the last start on this device, with its agent", () => {
    expect(pickContext({ last: { machine: "build-box", harness: "codex" }, sessions, machines })).toEqual({
      machine: "build-box",
      harness: "codex",
    });
  });
  it("then the paired machine with the most recent session (an unpaired one is passed over)", () => {
    expect(pickContext({ last: { machine: "gone-box" }, sessions, machines })).toEqual({ machine: "studio-mac" });
  });
  it("then the first machine, or nothing", () => {
    expect(pickContext({ sessions: [], machines })).toEqual({ machine: "build-box" });
    expect(pickContext({ sessions: [], machines: [] })).toEqual({});
  });
});

describe("pruneRemembered", () => {
  const c: MachineControl = {
    machineId: "m_studio",
    online: true,
    keys: [],
    queued: 0,
    harnesses: ["claude-code", "codex"],
    folders: ["/Users/demo/acme/web"],
    home: "/Users/demo",
    start: {
      "claude-code": { permissions: ["read", "safe"], permission: "safe", anyModel: true },
      codex: { permissions: ["read", "safe", "auto"], permission: "auto", models: ["gpt-6-astra"] },
    },
  };
  it("keeps what is still advertised", () => {
    expect(
      pruneRemembered(
        { harness: "claude-code", permission: "read", model: "sonnet", cwd: "~/acme/web" },
        c,
        "studio-mac",
      ),
    ).toEqual({ harness: "claude-code", permission: "read", model: "sonnet", cwd: "/Users/demo/acme/web" });
  });
  it("drops a level above the mode now, a model off a closed list, a folder no longer allowed, a harness gone", () => {
    expect(pruneRemembered({ harness: "claude-code", permission: "auto" }, c, "studio-mac")).toEqual({
      harness: "claude-code",
    });
    expect(pruneRemembered({ harness: "codex", model: "gpt-x" }, c, "studio-mac")).toEqual({ harness: "codex" });
    expect(pruneRemembered({ harness: "codex", cwd: "/Users/demo/acme/api" }, c, "studio-mac")).toEqual({
      harness: "codex",
    });
    expect(pruneRemembered({ harness: "gemini-cli", permission: "read", model: "x" }, c, "studio-mac")).toEqual({});
  });
  it("drops every option on a machine that advertises none (an old daemon)", () => {
    const old: MachineControl = { ...c, start: undefined, home: undefined };
    expect(
      pruneRemembered({ harness: "codex", permission: "read", model: "gpt-6-astra", cwd: "~/acme/web" }, old, "x"),
    ).toEqual({
      harness: "codex",
    });
  });
});

describe("aliasHidden", () => {
  const now = Date.parse("2026-10-23T10:00:20Z");
  const start: ControlActivity = {
    id: "01K8ZQ6X4N3T5V7W9Y1A2B3C4D",
    machineId: "m_studio",
    kind: "start",
    session: "codex:019a0000-0000-7000-8000-000000000001",
    at: "2026-10-23T10:00:00Z",
    expiresAt: "2026-10-23T11:00:00Z",
    cwd: "/Users/demo/acme/web",
  };
  const ids = (n: string | undefined) => (n === "studio-mac" ? "m_studio" : undefined);
  const home = () => "/Users/demo";
  const s = { key: "codex:other-id", harness: "codex", machine: "studio-mac", cwd: "~/acme/web" };
  it("hides a title-less twin on the same machine, harness and folder for 30 s", () => {
    expect(aliasHidden(s, [start], ids, home, now)).toBe(true);
    expect(aliasHidden(s, [start], ids, home, now + 31_000)).toBe(false);
  });
  it("never the start's own key, a titled session, another folder or another harness", () => {
    expect(aliasHidden({ ...s, key: start.session! }, [start], ids, home, now)).toBe(false);
    expect(aliasHidden({ ...s, title: "Fix it" }, [start], ids, home, now)).toBe(false);
    expect(aliasHidden({ ...s, cwd: "~/acme/api" }, [start], ids, home, now)).toBe(false);
    expect(aliasHidden({ ...s, harness: "claude-code", key: "claude-code:x" }, [start], ids, home, now)).toBe(false);
  });
});

describe("storage without localStorage", () => {
  it("reads nothing and writes nowhere, without throwing", () => {
    expect(() => saveDraft({ text: "keep me" })).not.toThrow();
    expect(readDraft()).toBeNull();
  });
});

describe("machineFacts and fixedPermission", () => {
  const base: MachineControl = {
    machineId: "m1",
    online: true,
    keys: [],
    queued: 0,
    harnesses: ["claude-code", "codex"],
  };
  const label = (h: string) => (h === "codex" ? "Codex" : "Claude Code");
  const opts = { permissions: ["read", "safe"] as const, permission: "safe" as const };
  it("says how each machine starts sessions, and what it runs", () => {
    expect(machineFacts({ ...base, mode: "auto", start: {} }, label)).toEqual({
      hint: "auto",
      detail: "Claude Code, Codex",
    });
    expect(machineFacts({ ...base, mode: "safe", start: {} }, label).hint).toBe("safe mode");
    expect(machineFacts({ ...base, version: "0.9.0" }, label).hint).toBe("0.9 · no model choice");
    expect(machineFacts({ ...base, online: false, mode: "auto", start: {} }, label).hint).toBe("offline");
    expect(machineFacts(undefined, label)).toEqual({});
  });
  it("keeps the Permission row on every machine: a pop-up, one level, or set at the machine", () => {
    const L = { read: "Read only", safe: "Safe" };
    expect(
      fixedPermission(
        { ...base, start: { "claude-code": { ...opts, permissions: ["read", "safe"] } } },
        "claude-code",
        L,
      ),
    ).toBeNull();
    expect(
      fixedPermission(
        { ...base, start: { "claude-code": { permissions: ["safe"], permission: "safe" } } },
        "claude-code",
        L,
      ),
    ).toBe("Safe");
    expect(fixedPermission({ ...base, mode: "safe" }, "claude-code", L)).toBe("Safe mode, set at the machine");
    expect(fixedPermission(base, "claude-code", L)).toBe("Set at the machine");
  });
});
