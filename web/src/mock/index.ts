// SPDX-License-Identifier: Apache-2.0
// Mock mode: `VITE_MOCK=1` or `?mock=1` swaps the HTTP transport for an in-page World, so
// the whole app runs with `npx vite --config web/vite.config.ts` and no server. Add
// `&empty=1` for the first-run board.
import {
  LABEL_COLORS,
  LABEL_NAME_MAX,
  type Labels,
  type LabelsPatch,
  type LimitsEntry,
  type Marks,
  type MarksPatch,
  type StreamMessage,
} from "@shared/api";
import type { Transport } from "../data/transport";
import { installPhoneMock } from "./phone";
import { review } from "./review";
import { mockLimits, World } from "./world";

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

/** The server's marks merge (server/ui/marks.ts), in the page: the same refusals, and a
 *  key the World does not know is skipped. */
function mergeMarks(doc: Marks, p: MarksPatch, known: (key: string) => boolean): Marks {
  const read = { ...doc.read };
  const unread = { ...doc.unread };
  for (const [k, at] of Object.entries(p.read ?? {})) {
    if (at !== null && (typeof at !== "string" || Number.isNaN(Date.parse(at)))) throw new Error("bad_read");
    if (at === null) delete read[k];
    else if (known(k) && !(read[k] && read[k] >= at)) read[k] = at;
  }
  for (const [k, on] of Object.entries(p.unread ?? {})) {
    if (on !== null && on !== true) throw new Error("bad_unread");
    if (on === null) delete unread[k];
    else if (known(k)) unread[k] = true;
  }
  const notify = { ...doc.notify };
  for (const [k, level] of Object.entries(p.notify ?? {})) {
    if (level !== null && level !== "finishes" && level !== "never") throw new Error("bad_notify");
    if (level === null) delete notify[k];
    else if (known(k)) notify[k] = level;
  }
  return { ...doc, rev: doc.rev + 1, read, unread, notify };
}

export function createMockTransport(): Transport {
  const empty = new URLSearchParams(location.search).get("empty") === "1";
  const world = new World({ empty });
  (window as unknown as { __sessionpipeMock?: World }).__sessionpipeMock = world;
  installPhoneMock(new URLSearchParams(location.search), () => world.info());
  // Labels live beside the World, as they live beside the store on the server.
  let labels: Labels = { rev: 0, names: {}, sessions: {} };
  // Marks too; the samples made before this page opened are read.
  let marks: Marks = { rev: 0, since: new Date().toISOString(), read: {}, unread: {}, notify: {} };
  // So do the usage limits; the first-run board has none.
  let limits: LimitsEntry[] = empty ? [] : mockLimits(Date.now());
  const handlers = new Set<(m: StreamMessage) => void>();
  let search: ReturnType<Transport["sessionSearch"]> | null = null;
  return {
    openStream(h) {
      let stop: (() => void) | null = null;
      const send = (m: StreamMessage) => h.onMessage(m);
      const t = setTimeout(() => {
        h.onOpen();
        const first = world.snapshot();
        h.onMessage(
          first.kind === "snapshot" ? { ...first, snapshot: { ...first.snapshot, labels, marks, limits } } : first,
        );
        // The messages the receiver carried, as the stream would have brought them.
        for (const message of [...world.controlActivity()].reverse()) h.onMessage({ kind: "control", message });
        handlers.add(send);
        const off = world.subscribe((m) => {
          if (m.kind === "forgotten" && m.key in labels.sessions) {
            const sessions = { ...labels.sessions };
            delete sessions[m.key];
            labels = { ...labels, rev: labels.rev + 1, sessions };
            for (const l of handlers) l({ kind: "labels", labels });
          }
          if (m.kind === "forgotten" && (m.key in marks.read || m.key in marks.unread)) {
            const read = { ...marks.read };
            const unread = { ...marks.unread };
            delete read[m.key];
            delete unread[m.key];
            marks = { ...marks, rev: marks.rev + 1, read, unread };
            for (const l of handlers) l({ kind: "marks", marks });
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
    marks: () => latency(marks, 40),
    patchMarks: async (p) => {
      await latency(undefined, 60);
      const snap = world.snapshot();
      const known = (k: string) => snap.kind === "snapshot" && snap.snapshot.sessions.some((s) => s.key === k);
      marks = mergeMarks(marks, p, known);
      for (const l of handlers) l({ kind: "marks", marks });
      return marks;
    },
    forgetLimits: async (key) => {
      await latency(undefined, 60);
      if (!limits.some((e) => e.key === key)) throw new Error("not_found");
      limits = limits.filter((e) => e.key !== key);
      for (const l of handlers) l({ kind: "limits", limits });
    },
    info: () => latency(world.info()),
    session: async (harness, id, q) => {
      const d = world.detail(harness, id, q);
      if (!d) throw new Error("not_found");
      return latency(d, 120);
    },
    feed: (q) => latency(world.feed(q), 90),
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
    sessionSearch: () => {
      search ??= import("./search").then((m) => m.mockSearch(world, () => labels));
      return search;
    },
  };
}
