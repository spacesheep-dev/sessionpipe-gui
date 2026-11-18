// SPDX-License-Identifier: Apache-2.0
// The wake that turns "Catching up…" on, against timers that wake on time: whole
// milliseconds after they were set, or a fraction of one before the page's clock agrees.
import { describe, expect, it } from "vitest";
import { BEHIND_SAID_AFTER_MS, type WakeClock, wakeAt } from "./current";

/** A clock read in fractions of a millisecond, whose timers take their delay in whole ones
 *  (as setTimeout does) and wake `early` before the clock says those are up. */
function onTime(start: number, early: number) {
  let now = start;
  let n = 0;
  const timers = new Map<number, { at: number; f: () => void }>();
  const clock: WakeClock & { set: number; run(): void } = {
    now: () => now,
    setTimeout(f, ms) {
      clock.set++;
      timers.set(++n, { at: now + Math.trunc(ms) - early, f });
      return n;
    },
    clearTimeout: (t) => void timers.delete(t as number),
    set: 0,
    /** Every timer in its turn, until none is left. */
    run() {
      for (;;) {
        const next = [...timers].sort(([, a], [, b]) => a.at - b.at)[0];
        if (!next) return;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].f();
      }
    },
  };
  return clock;
}

describe("wakeAt", () => {
  // Behind at 83.9 ms, the page rendered at 84.2: the second is up at 1083.9, and a timer
  // set for the 999.7 ms left takes 999 of them.
  const since = 83.9;
  const due = since + BEHIND_SAID_AFTER_MS;

  it.each([0, 0.6, 0.99])("wakes once, when the clock reads the moment, for a timer %f ms early", (early) => {
    const clock = onTime(84.2, early);
    const woke: number[] = [];
    wakeAt(due, () => woke.push(clock.now()), clock);
    clock.run();
    expect(woke).toHaveLength(1);
    expect(woke[0]).toBeGreaterThanOrEqual(due);
    expect(woke[0]! - due).toBeLessThan(2);
  });

  it("wakes at once when the moment has passed, and not at all once cancelled", () => {
    const late = onTime(due + 5, 0);
    let woken = 0;
    wakeAt(due, () => woken++, late);
    expect(woken).toBe(1);
    expect(late.set).toBe(0);

    const clock = onTime(84.2, 0.6);
    const cancel = wakeAt(due, () => woken++, clock);
    cancel();
    clock.run();
    expect(woken).toBe(1);
  });
});
