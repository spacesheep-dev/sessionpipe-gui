// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../config.js";
import { parseHello } from "./parse.js";
import { ControlState } from "./state.js";

const BOM = String.fromCharCode(0xfeff);
const facts = { name: "mac-mini", harnesses: ["claude-code"], modes: ["waiter"], version: "0.11.0" };

// machines.json is the only record of which machines paired; at start the receiver deletes
// the queue of every machine not in it. So one it cannot read must stop it, as config.json
// does, never read as "no machines".
describe("control/machines.json at start", () => {
  let dir: string;
  let control: string;
  let machines: string;
  let queue: string;
  const queued = `${JSON.stringify({ v: 1, messages: [{ id: "msg_keepme", state: "queued" }] })}\n`;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "spgui-machines-"));
    control = path.join(dir, "control");
    machines = path.join(control, "machines.json");
    const first = new ControlState(control);
    const m = first.createMachine("m_machinesfile00000001", parseHello(facts)!);
    first.mintToken(m);
    first.close();
    queue = path.join(control, "queue", `${m.id}.json`);
    mkdirSync(path.dirname(queue), { recursive: true });
    writeFileSync(queue, queued);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const start = (): ControlState => {
    const s = new ControlState(control);
    s.close();
    return s;
  };

  it("reads a machines.json with a byte-order mark past it, keeping the machine and its queue", () => {
    writeFileSync(machines, BOM + readFileSync(machines, "utf8"));
    expect(
      start()
        .allMachines()
        .map((m) => m.id),
    ).toEqual(["m_machinesfile00000001"]);
    expect(readFileSync(queue, "utf8")).toBe(queued);
  });

  it("stops on a machines.json that is empty, cut short or without a machines list, leaving it and every queue as they were", () => {
    const whole = readFileSync(machines, "utf8");
    for (const [text, says] of [
      ["", /is empty/],
      ["  \n", /is empty/],
      [whole.slice(0, 30), /is not valid JSON/],
      [`${BOM}${whole.slice(0, 30)}`, /is not valid JSON/],
      ['{\n  "v": 1,\n  "machines": [\n    {', /is not valid JSON at (line|position) \d+/],
      ["null", /holds no list of machines/],
      ["[]", /holds no list of machines/],
      ["{}", /holds no list of machines/],
      ['{"v":1,"machines":{}}', /holds no list of machines/],
    ] as const) {
      writeFileSync(machines, text);
      let err: unknown;
      try {
        start();
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(text)).toBeInstanceOf(ConfigError);
      const m = (err as Error).message;
      expect(m).toContain(machines);
      expect(m).toMatch(says);
      expect(m).toMatch(/not written over/);
      expect(m).toMatch(/move it aside/);
      expect(m).not.toContain("tokenHash");
      expect(readFileSync(machines, "utf8")).toBe(text);
      expect(readFileSync(queue, "utf8")).toBe(queued);
    }
  });

  it("stops on a machines.json that cannot be read, such as a folder of that name", () => {
    rmSync(machines);
    mkdirSync(machines);
    expect(start).toThrow(ConfigError);
    expect(start).toThrow(/could not be read \(EISDIR\)/);
    expect(readFileSync(queue, "utf8")).toBe(queued);
  });

  it("starts with no machines when machines.json is missing, as on a first run", () => {
    rmSync(machines);
    expect(start().allMachines()).toEqual([]);
    expect(existsSync(queue)).toBe(false);
  });
});
