// SPDX-License-Identifier: Apache-2.0
// Mock mode: `VITE_MOCK=1` or `?mock=1` swaps the HTTP transport for an in-page World, so
// the whole app runs with `npx vite --config web/vite.config.ts` and no server. Add
// `&empty=1` for the first-run board.
import type { Transport } from "../data/transport";
import { installPhoneMock } from "./phone";
import { review } from "./review";
import { World } from "./world";

const latency = <T>(v: T, ms = 60): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

export function createMockTransport(): Transport {
  const world = new World({ empty: new URLSearchParams(location.search).get("empty") === "1" });
  (window as unknown as { __sessionpipeMock?: World }).__sessionpipeMock = world;
  installPhoneMock(new URLSearchParams(location.search), () => world.info());
  return {
    openStream(h) {
      let stop: (() => void) | null = null;
      const t = setTimeout(() => {
        h.onOpen();
        h.onMessage(world.snapshot());
        stop = world.subscribe((m) => h.onMessage(m));
      }, 250);
      return () => {
        clearTimeout(t);
        stop?.();
      };
    },
    info: () => latency(world.info()),
    session: async (harness, id, q) => {
      const d = world.detail(harness, id, q);
      if (!d) throw new Error("no such session");
      return latency(d, 120);
    },
    feed: (q) => latency(world.feed(q), 90),
    search: (q) => latency(review(world).search(q), 120),
    files: (q) => latency(review(world).files(q), 90),
    digest: (q) => latency(review(world).digest(q), 90),
    forget: async (harness, id) => {
      await latency(undefined, 80);
      world.forget(harness, id);
    },
    rotateToken: () => latency({ sinkToken: world.rotate() }, 150),
    demo: async (on) => {
      world.demoOn = on;
      return latency({ on }, 80);
    },
    qrUrl: () => null,
  };
}
