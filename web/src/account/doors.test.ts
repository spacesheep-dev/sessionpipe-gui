// SPDX-License-Identifier: Apache-2.0
// The hub's files door as the page asks it (doors.ts uploadFile): a stop the page hands in
// ends the request.
import { describe, expect, it } from "vitest";
import { openDoors } from "./doors";

const PNG = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), type: "image/png", name: "kiwi.png" };

describe("uploadFile", () => {
  it("an upload the page stops aborts its fetch", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    // A hub that never answers: only a stop ends the request.
    const fetch = ((_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }) as typeof globalThis.fetch;
    const d = openDoors({ rxBase: "https://rx.test/a1", fetch });
    const stop = new AbortController();
    const going = d.uploadFile(PNG, stop.signal);
    await Promise.resolve();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    stop.abort();
    await expect(going).rejects.toMatchObject({ name: "AbortError" });
    expect(signals[0]!.aborted).toBe(true);
    // Stopped before it went: no request at all.
    await expect(d.uploadFile(PNG, stop.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(signals).toHaveLength(1);
  });
});
