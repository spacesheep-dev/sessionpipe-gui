// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";

const g = globalThis as Record<string, unknown>;

afterEach(() => {
  delete g.sessionpipeShell;
  delete g.EventSource;
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
