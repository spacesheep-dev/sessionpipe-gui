// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

const g = globalThis as Record<string, unknown>;

const realFetch = g.fetch;
afterEach(() => {
  delete g.sessionpipeShell;
  delete g.EventSource;
  g.fetch = realFetch;
  vi.resetModules();
});

describe("net in a browser", () => {
  it("leaves paths as they are and opens a real EventSource", async () => {
    const made: string[] = [];
    g.EventSource = class {
      constructor(public url: string) {
        made.push(url);
      }
    };
    const net = await import("./net");
    expect(net.apiUrl("/api/ui/info")).toBe("/api/ui/info");
    expect(net.apiUrl("https://other.example/x")).toBe("https://other.example/x");
    const es = net.openEvents("/api/ui/stream");
    expect(es).toBeInstanceOf(g.EventSource as new (u: string) => unknown);
    expect(made).toEqual(["/api/ui/stream"]);
  });
});

describe("net in the shell", () => {
  it("prefixes rxBase and opens the stream with the adapter's opener", async () => {
    g.sessionpipeShell = {
      v: 1,
      platform: "macos",
      rxBase: "rx://localhost/abc123",
      receiver: { id: "abc123", origin: "http://127.0.0.1:7815" },
    };
    g.EventSource = class {
      constructor() {
        throw new Error("no EventSource in the shell");
      }
    };
    const net = await import("./net");
    expect(net.apiUrl("/api/ui/info")).toBe("rx://localhost/abc123/api/ui/info");
    expect(net.apiUrl("data:,x")).toBe("data:,x");
    expect(net.receiverOrigin()).toBe("http://127.0.0.1:7815");
    const stream = { addEventListener() {}, onopen: null, onerror: null, close() {} };
    const open = vi.fn(() => stream);
    net.shellStreams.open = open;
    expect(net.openEvents("/api/ui/stream")).toBe(stream);
    expect(open).toHaveBeenCalledWith("/api/ui/stream");
  });

  it("a null rxBase (no receiver) leaves paths as they are", async () => {
    g.sessionpipeShell = { v: 1, platform: "macos", rxBase: null };
    const net = await import("./net");
    expect(net.apiUrl("/api/ui/info")).toBe("/api/ui/info");
  });
});

describe("apiFetch", () => {
  const answering = () => {
    const asked: [string, RequestInit | undefined][] = [];
    g.fetch = (async (url: string, init?: RequestInit) => {
      asked.push([url, init]);
      return new Response("{}");
    }) as unknown;
    return asked;
  };

  it("in a browser is fetch of the path as it is, with the same init", async () => {
    const asked = answering();
    const net = await import("./net");
    const init = { method: "POST", body: "{}" };
    await net.apiFetch("/api/ui/info", init);
    expect(asked).toEqual([["/api/ui/info", init]]);
    expect(net.accountMode()).toBe(false);
  });

  it("in the shell on a receiver is fetch of the rx: address", async () => {
    g.sessionpipeShell = {
      v: 1,
      platform: "ios",
      rxBase: "rx://localhost/abc123",
      receiver: { id: "abc123", origin: "http://127.0.0.1:7815" },
    };
    const asked = answering();
    const net = await import("./net");
    await net.apiFetch("/api/ui/info");
    expect(asked).toEqual([["rx://localhost/abc123/api/ui/info", undefined]]);
    expect(net.accountMode()).toBe(false);
  });

  it("on a spacesheep account never reaches the network: it waits for the page's own backend", async () => {
    g.sessionpipeShell = {
      v: 1,
      platform: "ios",
      rxBase: "rx://localhost/acct",
      receiver: { id: "acct", origin: "https://spacesheep.dev", kind: "spacesheep", email: "me@example.com" },
    };
    const asked = answering();
    const net = await import("./net");
    expect(net.accountMode()).toBe(true);
    // Asked before the backend is in place: held, not sent to rxBase.
    const early = net.apiFetch("/api/ui/setup/status");
    await new Promise((r) => setTimeout(r, 5));
    expect(asked).toEqual([]);
    const seen: string[] = [];
    net.setApiBackend(async (path) => {
      seen.push(path);
      return new Response("{}", { status: 404 });
    });
    expect((await early).status).toBe(404);
    await net.apiFetch("/api/ui/info");
    expect(seen).toEqual(["/api/ui/setup/status", "/api/ui/info"]);
    expect(asked).toEqual([]);
  });
});
