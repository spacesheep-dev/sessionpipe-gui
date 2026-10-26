// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A stand-in for the Tauri 2 runtime's __TAURI_INTERNALS__. */
function fakeInternals() {
  const callbacks = new Map<number, (raw: unknown) => void>();
  let next = 1;
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    callbacks,
    unregistered: [] as number[],
    transformCallback(cb: (raw: unknown) => void) {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id: number) {
      this.unregistered.push(id);
      callbacks.delete(id);
    },
    async invoke(cmd: string, args: Record<string, unknown> = {}) {
      // What the runtime's IPC does to the args (process-ipc-message-fn.js).
      const wire = JSON.parse(
        JSON.stringify(args, (_k, v) =>
          v && typeof v === "object" && "__TAURI_TO_IPC_KEY__" in v ? v.__TAURI_TO_IPC_KEY__() : v,
        ),
      );
      calls.push({ cmd, args: wire });
      if (cmd === "plugin:event|listen") return 42;
      if (cmd === "boom") throw new Error("nope");
      return { ok: cmd };
    },
  };
}

let T: ReturnType<typeof fakeInternals>;
const g = globalThis as Record<string, unknown>;
beforeEach(() => {
  T = fakeInternals();
  g.window = { __TAURI_INTERNALS__: T, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: vi.fn() } };
});
afterEach(() => {
  delete g.window;
});

describe("bridge", () => {
  it("invoke passes the command and args to the runtime", async () => {
    const { invoke } = await import("./bridge");
    await expect(invoke("app_settings_get")).resolves.toEqual({ ok: "app_settings_get" });
    await expect(invoke("boom")).rejects.toThrow("nope");
    expect(T.calls[0]).toEqual({ cmd: "app_settings_get", args: {} });
  });

  it("a channel serialises as __CHANNEL__:<id> and delivers in index order", async () => {
    const { channel, invoke } = await import("./bridge");
    const got: string[] = [];
    const ch = channel<string>((m) => got.push(m));
    await invoke("rx_stream", { receiver: "r", path: "/s", onFrame: ch });
    expect(T.calls[0]!.args.onFrame).toBe(`__CHANNEL__:${ch.id}`);
    expect(JSON.stringify({ c: ch })).toBe(`{"c":"__CHANNEL__:${ch.id}"}`);
    const send = T.callbacks.get(ch.id)!;
    send({ index: 2, message: "c" });
    send({ index: 0, message: "a" });
    expect(got).toEqual(["a"]);
    send({ index: 1, message: "b" });
    expect(got).toEqual(["a", "b", "c"]);
    // The end marker arrives before the last message: it waits for it.
    send({ index: 4, end: true });
    expect(T.unregistered).toEqual([]);
    send({ index: 3, message: "d" });
    expect(got).toEqual(["a", "b", "c", "d"]);
    expect(T.unregistered).toEqual([ch.id]);
  });

  it("a handler that throws never stalls the channel", async () => {
    const { channel } = await import("./bridge");
    const got: number[] = [];
    const thrown: unknown[] = [];
    const prev = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (f) => {
      try {
        f();
      } catch (e) {
        thrown.push(e);
      }
    };
    try {
      const ch = channel<number>((m) => {
        if (m === 1) throw new Error("bad frame");
        got.push(m);
      });
      const send = T.callbacks.get(ch.id)!;
      send({ index: 0, message: 0 });
      send({ index: 1, message: 1 });
      send({ index: 2, message: 2 });
      expect(got).toEqual([0, 2]);
      expect(thrown).toHaveLength(1);
    } finally {
      globalThis.queueMicrotask = prev;
    }
  });

  it("listen hands the payload over and unlistens", async () => {
    const { listen } = await import("./bridge");
    const got: unknown[] = [];
    const off = await listen<{ action: string }>("menu", (p) => got.push(p));
    const call = T.calls[0]!;
    expect(call.cmd).toBe("plugin:event|listen");
    expect(call.args).toMatchObject({ event: "menu", target: { kind: "Any" } });
    T.callbacks.get(call.args.handler as number)!({ event: "menu", id: 42, payload: { action: "palette" } });
    expect(got).toEqual([{ action: "palette" }]);
    off();
    expect(T.calls[1]).toEqual({ cmd: "plugin:event|unlisten", args: { event: "menu", eventId: 42 } });
  });
});
