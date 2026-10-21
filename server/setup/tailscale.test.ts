// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { Exec } from "./local.js";
import {
  createTailscaleProbe,
  findTailscale,
  NOT_INSTALLED,
  probeTailscale,
  serveTailscale,
  stderrTail,
  TailscaleError,
} from "./tailscale.js";

const fakeExec =
  (answers: Record<string, { code: number; stdout: string; stderr?: string }>, calls: string[][] = []): Exec =>
  async (file, args) => {
    calls.push([file, ...args]);
    const a = answers[args.join(" ")] ?? { code: 1, stdout: "" };
    return { stderr: "", ...a };
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

  it("a fresh probe skips the cache", async () => {
    const calls: string[][] = [];
    const exec = fakeExec({ "status --json": { code: 0, stdout: STATUS } }, calls);
    const probe = createTailscaleProbe(exec, {
      env: { PATH: "/nowhere" },
      platform: "linux",
      home: "/home/x",
      port: () => 7373,
      ttlMs: 60_000,
    });
    const a = probe();
    expect(probe()).toBe(a);
    expect(probe({ fresh: true })).not.toBe(a);
  });
});

describe("tailscale serve", () => {
  const BIN = "/usr/bin/tailscale";
  /** A fake tailscaled: `serve --bg` flips what `serve status` shows, like the real one. */
  const fakeNode = (o: { running?: boolean; deny?: string; silent?: boolean } = {}) => {
    const calls: string[][] = [];
    let serving = false;
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args]);
      const line = args.join(" ");
      if (line === "status --json")
        return {
          code: 0,
          stdout: o.running === false ? JSON.stringify({ BackendState: "NeedsLogin" }) : STATUS,
          stderr: "",
        };
      if (line === "serve status")
        return {
          code: 0,
          stdout: serving ? "https://laptop.tail1234.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:7373\n" : "",
          stderr: "",
        };
      if (line === "serve --bg 7373") {
        if (o.deny) return { code: 1, stdout: "", stderr: o.deny };
        if (!o.silent) serving = true;
        return { code: 0, stdout: "Available within your tailnet:\nhttps://laptop.tail1234.ts.net/\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unknown ${line}` };
    };
    const probe = () => probeTailscale(exec, BIN, 7373);
    const serves = () => calls.filter((c) => c[1] === "serve" && c[2] === "--bg");
    return { exec, probe, serves };
  };
  const failure = async (run: Promise<unknown>): Promise<TailscaleError> => {
    try {
      await run;
    } catch (e) {
      return e as TailscaleError;
    }
    throw new Error("did not throw");
  };

  it("runs `serve --bg <port>` once and answers the fresh status", async () => {
    const n = fakeNode();
    const st = await serveTailscale(n.exec, BIN, 7373, n.probe);
    expect(st).toMatchObject({ running: true, dnsName: "laptop.tail1234.ts.net", serving: true });
    expect(n.serves()).toEqual([[BIN, "serve", "--bg", "7373"]]);
    // Already served: nothing runs but the probes.
    await serveTailscale(n.exec, BIN, 7373, n.probe);
    expect(n.serves()).toHaveLength(1);
  });

  it("refuses with the CLI's last lines when it is missing, stopped, says no, or changes nothing", async () => {
    const none = await failure(
      serveTailscale(fakeExec({}), null, 7373, () => probeTailscale(fakeExec({}), null, 7373)),
    );
    expect(none).toBeInstanceOf(TailscaleError);
    expect(none).toMatchObject({ status: 409, message: "Tailscale is not installed on this machine." });
    const stopped = fakeNode({ running: false });
    expect(await failure(serveTailscale(stopped.exec, BIN, 7373, stopped.probe))).toMatchObject({
      status: 409,
      message: expect.stringMatching(/not connected/),
    });
    const denied = fakeNode({ deny: "one\ntwo\nthree\nfour\nfive\nsix\nerror: serve denied\n" });
    expect(await failure(serveTailscale(denied.exec, BIN, 7373, denied.probe))).toMatchObject({
      status: 502,
      message: "two\nthree\nfour\nfive\nsix\nerror: serve denied",
    });
    const silent = fakeNode({ silent: true });
    expect(await failure(serveTailscale(silent.exec, BIN, 7373, silent.probe))).toMatchObject({
      status: 502,
      message: expect.stringMatching(/does not show this port/),
    });
    expect(stderrTail({ code: null, stdout: "", stderr: "" })).toBe("tailscale exited without a code");
    expect(stderrTail({ code: 1, stdout: "only stdout\n", stderr: "" })).toBe("only stdout");
  });
});
