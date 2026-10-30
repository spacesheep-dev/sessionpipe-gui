// SPDX-License-Identifier: Apache-2.0
// The sidebar's lines once machines pool (lib/glance.ts): one line per pooled machine, its
// accounts drawn nowhere else, a pool that is off glanced as before.
import type { LimitsEntry, MachinePool, MachinePoolAccount } from "@shared/api";
import { describe, expect, it } from "vitest";
import { glanceLines } from "./glance";

const acc = (over: Partial<MachinePoolAccount> & { id: string }): MachinePoolAccount => ({
  enabled: true,
  status: "ready",
  current: false,
  ...over,
});
const entry = (id: string): LimitsEntry => ({
  key: `claude-code a:${id}`,
  harness: "claude-code",
  accountId: id,
  machine: "lab-mac",
  machines: ["lab-mac"],
  windows: [{ id: "five_hour", usedPercent: 38 }],
  observedAt: "2026-10-29T12:00:00Z",
});
const machine = (name: string, pool: MachinePool) => ({
  name,
  control: { machineId: name, online: true, keys: [], queued: 0, pool },
});
const misha = acc({ id: "a", label: "Misha", current: true });
const fiction = acc({ id: "b", label: "Fiction" });
const sheep = acc({ id: "c", label: "Spacesheep", status: "limited" });
const codex = {
  entry: {
    key: "codex m:lab-mac",
    harness: "codex",
    machine: "lab-mac",
    machines: ["lab-mac"],
    windows: [],
    observedAt: "",
  } as LimitsEntry,
};
const limits = [entry("a"), entry("c"), entry("d")];
const accounts = limits.map((e) => ({ entry: e }));

describe("glanceLines", () => {
  it("gives a pooled machine one line, its current account's, and hides its accounts' own", () => {
    const lab = machine("lab-mac", { on: true, harness: "claude-code", accounts: [misha, fiction, sheep] });
    const out = glanceLines([...accounts, codex], [lab], limits);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      kind: "pool",
      key: "pool:lab-mac",
      machine: "lab-mac",
      current: misha,
      entry: entry("a"),
    });
    expect(out.slice(1)).toEqual([{ entry: entry("d") }, codex]);
  });
  it("an account in two pools appears once, under the first machine by name; a pool that is off changes nothing", () => {
    const mini = machine("mini-mac", {
      on: true,
      harness: "claude-code",
      accounts: [acc({ id: "a", label: "Misha", status: "error" }), acc({ id: "w", label: "Work", current: true })],
    });
    const lab = machine("lab-mac", { on: true, harness: "claude-code", accounts: [misha, fiction] });
    const desk = machine("desk-pc", { on: false, harness: "claude-code", accounts: [acc({ id: "d" }), fiction] });
    const out = glanceLines(accounts, [mini, lab, desk], limits);
    expect(out.map((l) => ("kind" in l ? l.key : l.entry.accountId))).toEqual([
      "pool:lab-mac",
      "pool:mini-mac",
      "c",
      "d",
    ]);
    expect((out[1] as { current?: MachinePoolAccount }).current?.label).toBe("Work");
  });
  it("two machines serving with the same account are one line, the first machine's by name", () => {
    const lab = machine("lab-mac", { on: true, harness: "claude-code", accounts: [misha, fiction] });
    const mini = machine("mini-mac", { on: true, harness: "claude-code", accounts: [misha, sheep] });
    const out = glanceLines(accounts, [mini, lab], limits);
    expect(out.map((l) => ("kind" in l ? l.key : l.entry.accountId))).toEqual(["pool:lab-mac", "d"]);
    // A machine serving with another account keeps its line.
    const other = machine("mini-mac", {
      on: true,
      harness: "claude-code",
      accounts: [{ ...misha, current: false }, acc({ id: "w", label: "Work", current: true })],
    });
    expect(glanceLines(accounts, [other, lab], limits).map((l) => ("kind" in l ? l.key : l.entry.accountId))).toEqual([
      "pool:lab-mac",
      "pool:mini-mac",
      "c",
      "d",
    ]);
  });
  it("a pool with every account out has a line with no current account; an empty pool has none", () => {
    const lab = machine("lab-mac", {
      on: true,
      harness: "claude-code",
      accounts: [{ ...misha, current: false, status: "limited" }],
    });
    const line = glanceLines(accounts, [lab], limits)[0];
    expect(line).toMatchObject({ kind: "pool" });
    expect(line).not.toHaveProperty("current");
    expect(line).not.toHaveProperty("entry");
    expect(
      glanceLines(accounts, [machine("lab-mac", { on: true, harness: "claude-code", accounts: [] })], limits),
    ).toEqual(accounts);
  });
});
