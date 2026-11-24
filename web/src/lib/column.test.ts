// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { columnKind, markColumn, NARROW_COLUMN_PX } from "./column";

/** A ResizeObserver that is told sizes by the test. */
class FakeObserver {
  static last: FakeObserver | null = null;
  watched: Element[] = [];
  stopped = false;
  constructor(readonly cb: (entries: unknown[]) => void) {
    FakeObserver.last = this;
  }
  observe(el: Element) {
    this.watched.push(el);
  }
  disconnect() {
    this.stopped = true;
  }
  /** The column is now `width` px wide inside its padding. */
  size(width: number) {
    this.cb([{ contentBoxSize: [{ inlineSize: width, blockSize: 100 }], contentRect: { width } }]);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeObserver.last = null;
});

describe("a transcript's column", () => {
  it("is narrow under 640 px and wide from it", () => {
    expect(NARROW_COLUMN_PX).toBe(640);
    // The Duo's and a tablet's columns as the app lays them out (duo.spec.ts measures them).
    for (const w of [288, 361, 350, 354, 417, 568, 615, 639.9]) expect(columnKind(w), `${w}`).toBe("narrow");
    for (const w of [640, 672, 760]) expect(columnKind(w), `${w}`).toBe("wide");
  });

  it("is said on the column as its width changes, and no more once stopped", () => {
    vi.stubGlobal("ResizeObserver", FakeObserver);
    const el = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    const stop = markColumn(el);
    const ro = FakeObserver.last!;
    expect(ro.watched).toEqual([el]);
    ro.size(615);
    expect(el.dataset.column).toBe("narrow");
    ro.size(672);
    expect(el.dataset.column).toBe("wide");
    // A width that is read from the old contentRect alone (an older engine) is read too.
    ro.cb([{ contentRect: { width: 417 } }]);
    expect(el.dataset.column).toBe("narrow");
    stop();
    expect(ro.stopped).toBe(true);
  });

  it("is left unsaid where there is no ResizeObserver, and the measure stays", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const el = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    markColumn(el)();
    expect(el.dataset.column).toBeUndefined();
  });
});
