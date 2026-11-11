// SPDX-License-Identifier: Apache-2.0
// The page come back: which of a browser's signs ask the store for a fresh stream.
import { describe, expect, it, vi } from "vitest";
import { BEAT_MS, cameBack, HIDDEN_LONG_MS, ONCE_MS, type PageSigns, SLEPT_MS, watchResume } from "./resume";

/** A page whose clock, visibility, events and timer the test moves by hand. */
class Page {
  at = 1_000_000;
  isHidden = false;
  stopped = 0;
  private readonly listeners = new Map<string, (e: { persisted?: boolean }) => void>();
  private beat: () => void = () => {};
  readonly signs: PageSigns = {
    hidden: () => this.isHidden,
    now: () => this.at,
    on: (kind, fn) => {
      this.listeners.set(kind, fn);
      return () => {
        this.listeners.delete(kind);
        this.stopped++;
      };
    },
    every: (_ms, fn) => {
      this.beat = fn;
      return () => {
        this.beat = () => {};
        this.stopped++;
      };
    },
  };
  fire(kind: string, e: { persisted?: boolean } = {}) {
    this.listeners.get(kind)?.(e);
  }
  show(shown: boolean) {
    this.isHidden = !shown;
    this.fire("visibilitychange");
  }
  hide(ms: number) {
    this.show(false);
    this.at += ms;
    this.show(true);
  }
  /** `ms` pass with the page running: its beat fires on time. */
  run(ms: number) {
    for (let t = BEAT_MS; t <= ms; t += BEAT_MS) {
      this.at += BEAT_MS;
      this.beat();
    }
  }
  /** `ms` pass with the page not running, then its beat fires. */
  sleep(ms: number) {
    this.at += ms;
    this.beat();
  }
}
const page = () => new Page();

describe("the page come back", () => {
  it("a tab asks again when shown after a long time hidden, not after a glance away", () => {
    expect(cameBack(HIDDEN_LONG_MS - 1, 0)).toBe(false);
    expect(cameBack(HIDDEN_LONG_MS, 0)).toBe(true);
    expect(cameBack(0, SLEPT_MS)).toBe(true);
    const p = page();
    const resync = vi.fn();
    watchResume({ resync }, p.signs);
    p.hide(5_000);
    expect(resync).not.toHaveBeenCalled();
    p.run(30_000);
    p.hide(HIDDEN_LONG_MS);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("a page out of the back/forward cache asks; an ordinary load does not", () => {
    const p = page();
    const resync = vi.fn();
    watchResume({ resync }, p.signs);
    p.fire("pageshow", { persisted: false });
    expect(resync).not.toHaveBeenCalled();
    p.fire("pageshow", { persisted: true });
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("a laptop awake again asks: at once with the tab in front, when it is shown otherwise", () => {
    const p = page();
    const resync = vi.fn();
    watchResume({ resync }, p.signs);
    p.run(60_000);
    expect(resync).not.toHaveBeenCalled();
    p.sleep(3_600_000);
    expect(resync).toHaveBeenCalledTimes(1);
    p.run(60_000);
    // Asleep while hidden: nothing until someone looks.
    p.show(false);
    p.sleep(3_600_000);
    expect(resync).toHaveBeenCalledTimes(1);
    p.at += 1_000;
    p.show(true);
    expect(resync).toHaveBeenCalledTimes(2);
  });

  it("the network back asks, and signs that come together ask once", () => {
    const p = page();
    const resync = vi.fn();
    const stop = watchResume({ resync }, p.signs);
    p.fire("online");
    expect(resync).toHaveBeenCalledTimes(1);
    // A page put away for an hour and restored: shown, out of the cache, online, its beat late.
    p.show(false);
    p.at += 3_600_000;
    p.isHidden = false;
    p.fire("pageshow", { persisted: true });
    p.fire("visibilitychange");
    p.fire("online");
    p.sleep(0);
    expect(resync).toHaveBeenCalledTimes(2);
    stop();
    expect(p.stopped).toBe(4);
    p.at += ONCE_MS;
    p.fire("online");
    expect(resync).toHaveBeenCalledTimes(2);
  });
});
