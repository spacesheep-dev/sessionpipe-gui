// SPDX-License-Identifier: Apache-2.0
// A dialog's module fetched on demand: one fetch however often it is asked for, and a
// failed fetch (offline, a new build) tried again on the next ask.
import { describe, expect, it } from "vitest";
import { lazyModule } from "./lazy";

describe("lazyModule", () => {
  it("fetches once, however often it is preloaded", async () => {
    let loads = 0;
    const m = lazyModule(async () => {
      loads++;
      return { ok: true };
    });
    const [a, b] = await Promise.all([m.preload(), m.preload()]);
    await m.preload();
    expect(loads).toBe(1);
    expect(a).toBe(b);
  });

  it("tries again after a failed fetch", async () => {
    let loads = 0;
    const m = lazyModule(async () => {
      loads++;
      if (loads === 1) throw new Error("offline");
      return { ok: true };
    });
    await expect(m.preload()).rejects.toThrow("offline");
    await expect(m.preload()).resolves.toEqual({ ok: true });
    expect(loads).toBe(2);
  });
});
