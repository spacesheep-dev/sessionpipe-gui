// SPDX-License-Identifier: Apache-2.0
import "./test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanQr } from "./scanner";

const invoke = vi.fn();
vi.mock("./bridge", () => ({ invoke: (...a: unknown[]) => invoke(...a), listen: vi.fn(), channel: vi.fn() }));
let platform = "ios";
vi.mock("./shell", () => ({ platform: () => platform, features: () => new Set(["scanner"]) }));

/** The plugin's scan, held until the test ends it. */
let scan: { resolve(v: unknown): void; reject(e: unknown): void };
const fits = () => invoke.mock.calls.filter(([cmd]) => cmd === "app_fit_camera").length;
const resize = () => window.dispatchEvent(new Event("resize"));

beforeEach(() => {
  vi.useFakeTimers();
  platform = "ios";
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "plugin:barcode-scanner|scan")
      return new Promise((resolve, reject) => {
        scan = { resolve, reject };
      });
    return Promise.resolve(null);
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("scanQr fits the camera to the window", () => {
  it("a moment after the scan starts, and on every resize until it ends", async () => {
    const text = scanQr();
    expect(invoke.mock.calls[0]?.[0]).toBe("plugin:barcode-scanner|scan");
    await vi.advanceTimersByTimeAsync(299);
    expect(fits()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fits()).toBe(1);
    resize();
    resize();
    expect(fits()).toBe(3);
    scan.resolve({ content: "http://10.0.0.128:7397/?k=uik" });
    await expect(text).resolves.toBe("http://10.0.0.128:7397/?k=uik");
    resize();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fits()).toBe(3);
  });

  it("a scan that ends before the moment is never fitted", async () => {
    const text = scanQr();
    scan.reject("cancelled");
    await expect(text).resolves.toBeNull();
    resize();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fits()).toBe(0);
  });

  it("a failed scan stops fitting too", async () => {
    const text = scanQr();
    resize();
    expect(fits()).toBe(1);
    scan.reject("No camera available on this device (e.g., iOS Simulator)");
    await expect(text).rejects.toThrow("No camera available");
    resize();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fits()).toBe(1);
  });

  it("a fit the shell refuses is ignored", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "app_fit_camera") return Promise.reject(new Error("no main window"));
      if (cmd === "plugin:barcode-scanner|scan")
        return new Promise((resolve, reject) => {
          scan = { resolve, reject };
        });
      return Promise.resolve(null);
    });
    const text = scanQr();
    await vi.advanceTimersByTimeAsync(300);
    resize();
    expect(fits()).toBe(2);
    scan.resolve({ content: "x" });
    await expect(text).resolves.toBe("x");
  });

  it("Android sizes its own camera: never asked", async () => {
    platform = "android";
    const text = scanQr();
    await vi.advanceTimersByTimeAsync(300);
    resize();
    scan.resolve({ content: "x" });
    await text;
    expect(fits()).toBe(0);
  });
});
