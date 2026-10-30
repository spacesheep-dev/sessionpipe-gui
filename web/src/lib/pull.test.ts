// SPDX-License-Identifier: Apache-2.0
// Pull to refresh's arithmetic and state: the band, the arm distance, what a touch that
// is not a pull does, and the refresh's timings.
import { describe, expect, it } from "vitest";
import {
  ARM_PX,
  arc,
  begin,
  holdFor,
  IDLE,
  landed,
  MAX_PX,
  MIN_SPIN_MS,
  move,
  outcome,
  overdue,
  release,
  SLACK_PX,
  settle,
  settled,
  TIMEOUT_MS,
  travel,
} from "./pull";

/** The finger's travel that arms (travel() is monotonic, so search it). */
const armRaw = (() => {
  let raw = 0;
  while (travel(raw) < ARM_PX) raw++;
  return raw;
})();

describe("travel", () => {
  it("gives nothing inside the slack, then half the finger's travel", () => {
    expect(travel(0)).toBe(0);
    expect(travel(SLACK_PX)).toBe(0);
    expect(travel(SLACK_PX + 40)).toBe(20);
    expect(travel(SLACK_PX + 128)).toBe(64);
  });

  it("tightens past the soft point and never reaches the cap", () => {
    expect(travel(SLACK_PX + 160)).toBeGreaterThan(64);
    expect(travel(SLACK_PX + 160)).toBeLessThan(80);
    expect(travel(600)).toBeLessThan(MAX_PX);
    expect(travel(10_000)).toBeCloseTo(MAX_PX, 3);
    // Monotonic, with no step at the join.
    let last = 0;
    for (let raw = 0; raw < 400; raw++) {
      const t = travel(raw);
      expect(t).toBeGreaterThanOrEqual(last);
      expect(t - last).toBeLessThanOrEqual(0.5 + 1e-9);
      last = t;
    }
  });

  it("arms a little past twice the arm distance of finger travel", () => {
    expect(armRaw).toBe(2 * ARM_PX + SLACK_PX);
  });
});

describe("arc", () => {
  it("draws in proportion to the pull and completes at the arm distance", () => {
    expect(arc(0)).toBe(0);
    expect(arc(ARM_PX / 2)).toBe(0.5);
    expect(arc(ARM_PX)).toBe(1);
    expect(arc(MAX_PX)).toBe(1);
    expect(arc(-10)).toBe(0);
  });
});

describe("a pull", () => {
  it("follows the finger, arms once, disarms once, and refreshes on release", () => {
    let s = begin(IDLE, 100, 200, true);
    expect(s.phase).toBe("idle");
    expect(s.y0).toBe(200);
    // Inside the slack it is still a tap.
    let m = move(s, 100, 204, true);
    expect(m.state.phase).toBe("idle");
    expect(m.arm).toBeNull();
    m = move(m.state, 100, 240, true);
    expect(m.state.phase).toBe("pulling");
    expect(m.state.y).toBe(travel(40));
    expect(m.state.armed).toBe(false);
    expect(m.arm).toBeNull();
    m = move(m.state, 100, 200 + armRaw, true);
    expect(m.state.armed).toBe(true);
    expect(m.arm).toBe("arm");
    // Further still: armed stays, no second haptic.
    m = move(m.state, 100, 200 + armRaw + 60, true);
    expect(m.arm).toBeNull();
    expect(m.state.y).toBeLessThan(MAX_PX);
    // Back under the line: one disarm.
    m = move(m.state, 100, 200 + armRaw - 20, true);
    expect(m.arm).toBe("disarm");
    expect(m.state.armed).toBe(false);
    m = move(m.state, 100, 200 + armRaw + 1, true);
    expect(m.arm).toBe("arm");
    s = release(m.state, 1000);
    expect(s.phase).toBe("refreshing");
    expect(s.y).toBe(ARM_PX);
    expect(s.since).toBe(1000);
    expect(s.y0).toBeNull();
  });

  it("eases back and does nothing when let go short of the arm distance", () => {
    const s = begin(IDLE, 100, 200, true);
    const m = move(s, 100, 260, true);
    expect(m.state.phase).toBe("pulling");
    const r = release(m.state, 1000);
    expect(r.phase).toBe("settling");
    expect(settled(r)).toEqual(IDLE);
  });

  it("is nobody's when the touch is owned elsewhere, and a tap leaves no trace", () => {
    expect(begin(IDLE, 100, 200, false)).toBe(IDLE);
    const s = begin(IDLE, 100, 200, true);
    expect(release(s, 1000)).toEqual(IDLE);
  });

  it("lets go of a sideways swipe, a scroll up, and a page that has scrolled", () => {
    const s = begin(IDLE, 100, 200, true);
    expect(move(s, 130, 210, true).state).toEqual(IDLE);
    expect(move(s, 100, 180, true).state).toEqual(IDLE);
    expect(move(s, 100, 240, false).state).toEqual(IDLE);
    // Mid-pull the page scrolls (the finger went back up past the start): the pull ends.
    const p = move(s, 100, 260, true).state;
    expect(move(p, 100, 190, false).state).toEqual(IDLE);
    // A finger going back to where it started draws nothing but is still a pull.
    expect(move(p, 100, 200, true).state.y).toBe(0);
  });

  it("ignores a new finger while a refresh runs", () => {
    const r = release(move(begin(IDLE, 0, 0, true), 0, armRaw, true).state, 0);
    expect(begin(r, 0, 0, true)).toBe(r);
    expect(move(r, 0, 50, true).state).toBe(r);
    expect(release(r, 5)).toBe(r);
  });
});

describe("the refresh", () => {
  const running = release(move(begin(IDLE, 0, 0, true), 0, armRaw, true).state, 10_000);

  it("has landed once the stream is live with a newer snapshot", () => {
    expect(landed("t1", "t1", "live")).toBe(false);
    expect(landed("t1", "t2", "connecting")).toBe(false);
    expect(landed("t1", "t2", "live")).toBe(true);
    expect(landed(null, "t2", "live")).toBe(true);
    expect(landed(null, null, "live")).toBe(false);
  });

  it("spins at least MIN_SPIN_MS, and no longer once that has passed", () => {
    expect(holdFor(running, 10_000)).toBe(MIN_SPIN_MS);
    expect(holdFor(running, 10_400)).toBe(MIN_SPIN_MS - 400);
    expect(holdFor(running, 10_000 + MIN_SPIN_MS)).toBe(0);
    expect(holdFor(running, 20_000)).toBe(0);
    expect(holdFor(IDLE, 0)).toBe(0);
  });

  it("stops at TIMEOUT_MS whatever the stream did", () => {
    expect(overdue(running, 10_000 + TIMEOUT_MS - 1)).toBe(false);
    expect(overdue(running, 10_000 + TIMEOUT_MS)).toBe(true);
    expect(overdue(IDLE, 1e9)).toBe(false);
  });

  it("says how it went, then eases back to nothing", () => {
    expect(outcome(true)).toBe("Up to date");
    expect(outcome(false)).toBe("Couldn't refresh");
    const s = settle(running);
    expect(s.phase).toBe("settling");
    expect(settled(s)).toEqual(IDLE);
    expect(settle(IDLE)).toBe(IDLE);
    expect(settled(running)).toBe(running);
  });
});
