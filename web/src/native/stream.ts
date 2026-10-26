// SPDX-License-Identifier: Apache-2.0
// The live stream inside the native shell: net.ts's openEvents, over `rx_stream`. Rust
// opens the receiver's SSE stream and sends each frame as `{ event, data }`, plus
// `{ event: "open" }` and `{ event: "error", retryInMs }`. One upstream connection per
// call; the page's transport keeps its own backoff (it closes this one on an error
// and opens another), so retry logic stays in one place.
import type { EventSourceLike } from "../lib/net";
import { channel, invoke } from "./bridge";
import { shellInfo } from "./shell";

export interface Frame {
  event: string;
  data?: string;
  retryInMs?: number;
}

type Stream = EventSourceLike & {
  on: [string, (e: { data: string }) => void][];
  shut: boolean;
};

const live = new Set<Stream>();

export function openStream(path: string): EventSourceLike {
  const on: Stream["on"] = [];
  const es: Stream = {
    on,
    shut: false,
    onopen: null,
    onerror: null,
    addEventListener: (kind, fn) => void on.push([kind, fn]),
    close() {
      es.shut = true;
      live.delete(es);
      close();
    },
  };
  let streamId: number | null = null;
  const fail = (retryInMs?: number) => {
    if (!es.shut) es.onerror?.({ retryInMs });
  };
  const onFrame = channel<Frame>((f) => {
    if (es.shut) return;
    if (f.event === "open") es.onopen?.();
    else if (f.event === "error") fail(f.retryInMs);
    else for (const [kind, fn] of es.on) if (kind === f.event) fn({ data: f.data ?? "" });
  });
  const close = () => {
    if (streamId !== null) void invoke("rx_stream_close", { streamId }).catch(() => {});
    streamId = null;
  };
  live.add(es);
  const receiver = shellInfo()?.receiver?.id;
  if (!receiver) queueMicrotask(() => fail());
  else
    invoke<number>("rx_stream", { receiver, path, onFrame }).then(
      (id) => {
        streamId = id;
        if (es.shut) close();
      },
      () => fail(),
    );
  return es;
}

/** After sleep: every open stream fails now, and the transport's own resync (the one a
 *  tab coming back to the front runs) reopens it at once with a fresh snapshot. */
export function resyncAll(): void {
  for (const es of [...live]) es.onerror?.({});
  document.dispatchEvent(new Event("visibilitychange"));
}
