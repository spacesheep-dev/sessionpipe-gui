// SPDX-License-Identifier: Apache-2.0
// Mock mode: `VITE_MOCK=1` or `?mock=1` swaps the HTTP transport for an in-page World, so
// the whole app runs with `npx vite --config web/vite.config.ts` and no server. Add
// `&empty=1` for the first-run board.
import { LABEL_COLORS, LABEL_NAME_MAX, type Labels, type LabelsPatch, type StreamMessage } from "@shared/api";
import type { Transport } from "../data/transport";
import { installPhoneMock } from "./phone";
import { review } from "./review";
import { World } from "./world";

const latency = <T>(v: T, ms = 60): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));

/** The server's label merge (server/ui/labels.ts), in the page: the same refusals. */
function mergeLabels(doc: Labels, p: LabelsPatch, known: (key: string) => boolean): Labels {
  const sessions = { ...doc.sessions };
  const names = { ...doc.names };
  for (const [k, c] of Object.entries(p.sessions ?? {})) {
    if (c === null) delete sessions[k];
    else if (!LABEL_COLORS.includes(c)) throw new Error("bad_label");
    else if (!known(k)) throw new Error("not_found");
    else sessions[k] = c;
  }
  for (const [c, n] of Object.entries(p.names ?? {}) as [keyof Labels["names"], string | null][]) {
    if (!LABEL_COLORS.includes(c)) throw new Error("bad_label");
    const t = (n ?? "").trim();
    if (t.length > LABEL_NAME_MAX) throw new Error("bad_name");
    if (t) names[c] = t;
    else delete names[c];
  }
  return { rev: doc.rev + 1, names, sessions };
}

export function createMockTransport(): Transport {
  const world = new World({ empty: new URLSearchParams(location.search).get("empty") === "1" });
  (window as unknown as { __sessionpipeMock?: World }).__sessionpipeMock = world;
  installPhoneMock(new URLSearchParams(location.search), () => world.info());
  // Labels live beside the World, as they live beside the store on the server.
  let labels: Labels = { rev: 0, names: {}, sessions: {} };
  const handlers = new Set<(m: StreamMessage) => void>();
  return {
    openStream(h) {
      let stop: (() => void) | null = null;
      const send = (m: StreamMessage) => h.onMessage(m);
      const t = setTimeout(() => {
        h.onOpen();
        const first = world.snapshot();
        h.onMessage(first.kind === "snapshot" ? { ...first, snapshot: { ...first.snapshot, labels } } : first);
        handlers.add(send);
        const off = world.subscribe((m) => {
          if (m.kind === "forgotten" && m.key in labels.sessions) {
            const sessions = { ...labels.sessions };
            delete sessions[m.key];
            labels = { ...labels, rev: labels.rev + 1, sessions };
            for (const l of handlers) l({ kind: "labels", labels });
          }
          h.onMessage(m);
        });
        stop = () => {
          off();
          handlers.delete(send);
        };
      }, 250);
      return () => {
        clearTimeout(t);
        stop?.();
      };
    },
    labels: () => latency(labels, 40),
    patchLabels: async (p) => {
      await latency(undefined, 60);
      const snap = world.snapshot();
      const known = (k: string) => snap.kind === "snapshot" && snap.snapshot.sessions.some((s) => s.key === k);
      labels = mergeLabels(labels, p, known);
      for (const l of handlers) l({ kind: "labels", labels });
      return labels;
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
