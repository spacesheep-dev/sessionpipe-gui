// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Exec } from "./local.js";
import { createTailscaleProbe, findTailscale, NOT_INSTALLED, probeTailscale } from "./tailscale.js";

const fakeExec =
  (answers: Record<string, { code: number; stdout: string }>, calls: string[][] = []): Exec =>
  async (file, args) => {
    calls.push([file, ...args]);
    const a = answers[args.join(" ")] ?? { code: 1, stdout: "" };
    return { ...a, stderr: "" };
  };

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "laptop.tail1234.ts.net.", TailscaleIPs: ["100.64.0.9", "fd7a::9"] },
});

describe("tailscale probe", () => {
  it("is not installed without a binary", async () => {
    expect(await probeTailscale(fakeExec({}), null, 7373)).toEqual(NOT_INSTALLED);
    expect(findTailscale({ PATH: "/nowhere" }, "linux", "/home/x")).toBeNull();
  });

  it("reads the node's state, strips the trailing dot, and sees whether serve names our port", async () => {
    const serving = fakeExec({
      "status --json": { code: 0, stdout: STATUS },
      "serve status": {
        code: 0,
        stdout: "https://laptop.tail1234.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:7373\n",
      },
    });
    expect(await probeTailscale(serving, "/usr/bin/tailscale", 7373)).toEqual({
      installed: true,
      running: true,
      dnsName: "laptop.tail1234.ts.net",
      ips: ["100.64.0.9", "fd7a::9"],
      serving: true,
    });
    const other = fakeExec({
      "status --json": { code: 0, stdout: STATUS },
      "serve status": {
        code: 0,
        stdout: "https://laptop.tail1234.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:3000\n",
      },
    });
    expect((await probeTailscale(other, "/usr/bin/tailscale", 7373)).serving).toBe(false);
    const noServe = fakeExec({ "status --json": { code: 0, stdout: STATUS } });
    expect((await probeTailscale(noServe, "/usr/bin/tailscale", 7373)).serving).toBeNull();
  });

  it("installed but not connected: running false, serve not asked", async () => {
    const calls: string[][] = [];
    const stopped = fakeExec(
      { "status --json": { code: 0, stdout: JSON.stringify({ BackendState: "NeedsLogin", Self: {} }) } },
      calls,
    );
    expect(await probeTailscale(stopped, "/usr/bin/tailscale", 7373)).toEqual({
      installed: true,
      running: false,
      serving: null,
    });
    expect(calls).toHaveLength(1);
  });

  it("caches a probe for the ttl", async () => {
    const calls: string[][] = [];
    const exec = fakeExec({ "status --json": { code: 0, stdout: STATUS } }, calls);
    const probe = createTailscaleProbe(exec, {
      env: { PATH: "/nowhere" },
      platform: "linux",
      home: "/home/x",
      port: () => 7373,
      ttlMs: 60_000,
    });
    expect((await probe()).installed).toBe(false);
    await probe();
    // No binary found: nothing ran, and the second call reused the first probe.
    expect(calls).toHaveLength(0);
  });
});
