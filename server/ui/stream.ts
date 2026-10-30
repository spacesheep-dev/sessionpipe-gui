// SPDX-License-Identifier: Apache-2.0
// GET /api/ui/stream: Server-Sent Events. The first frame is a snapshot, then every
// store message, every control message, every change of who is connected, of the
// labels, of the usage limits, of a view's stored state and of a workflow run (`workflowRun`,
// the whole run; `workflows` after a save or a delete; server/orchestrate, through the
// Broadcast) as it happens, and a `: ping` comment every 15 s so proxies and phones keep the connection.
// Each stream is one Viewer in the registry for as long as it stays open, except the
// desktop app's menu-bar stream (`x-sessionpipe-client: shell`), which is not a person.
import type { Snapshot, StreamMessage } from "../../shared/api.js";
import type { Control } from "../control/index.js";
import type { Ctx } from "../http/router.js";
import type { Store } from "../store/store.js";
import { isShellClient, type ViewerRegistry } from "./viewers.js";

export const PING_MS = 15_000;

export interface StreamDeps {
  store: Store;
  control: Control;
  snapshot: () => Snapshot;
  viewers: ViewerRegistry;
  pingMs?: number;
  /** The plugin host's own messages (suggestions), when plugins are on. */
  plugins?: { subscribe(l: (m: StreamMessage) => void): () => void };
  /** Other sources forwarded as they are: label and limits changes, view-state writes. */
  more?: { subscribe(l: (m: StreamMessage) => void): () => void }[];
}

export function serveStream(ctx: Ctx, deps: StreamDeps): void {
  const { req, res } = ctx;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  const write = (msg: StreamMessage): void => {
    if (res.destroyed || res.writableEnded) return;
    res.write(`event: ${msg.kind}\ndata: ${JSON.stringify(msg)}\n\n`);
  };
  const ua = req.headers["user-agent"];
  const me = isShellClient(req.headers)
    ? undefined
    : deps.viewers.add({
        ip: ctx.remote.ip,
        loopback: ctx.remote.loopback,
        forwarded: ctx.remote.forwarded,
        userAgent: Array.isArray(ua) ? ua[0] : ua,
      });
  write({ kind: "snapshot", snapshot: { ...deps.snapshot(), viewers: deps.viewers.list(me) } });
  const offStore = deps.store.subscribe((m) => {
    if (m.kind === "machine") {
      const control = deps.control.machines().get(m.machine.name);
      write({ kind: "machine", machine: control ? { ...m.machine, control } : m.machine });
    } else write(m);
  });
  // A machine message from control carries only what the daemon told it; the store's
  // reading of that machine (sessions, versions) wins when it has one.
  const offControl = deps.control.subscribe((m) => {
    if (m.kind === "machine") {
      const known = deps.snapshot().machines.find((x) => x.name === m.machine.name);
      write({ kind: "machine", machine: known ?? m.machine });
    } else write(m);
  });
  const offViewers = me
    ? deps.viewers.subscribe(() => write({ kind: "viewers", viewers: deps.viewers.list(me) }))
    : () => {};
  const offPlugins = deps.plugins?.subscribe(write);
  const offMore = (deps.more ?? []).map((src) => src.subscribe(write));
  const ping = setInterval(() => {
    if (res.destroyed || res.writableEnded) return;
    res.write(": ping\n\n");
    if (me) deps.viewers.touch(me);
  }, deps.pingMs ?? PING_MS);
  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    clearInterval(ping);
    offStore();
    offControl();
    offViewers();
    offPlugins?.();
    for (const off of offMore) off();
    if (me) deps.viewers.remove(me);
    if (!res.writableEnded) res.end();
  };
  res.on("close", cleanup);
  req.on("close", cleanup);
  req.on("error", cleanup);
}

/** A fan-out of stream messages for sources that have no subscription of their own
 *  (a view's state written by the theme routes). */
export class Broadcast {
  private readonly listeners = new Set<(m: StreamMessage) => void>();

  emit(m: StreamMessage): void {
    for (const l of this.listeners) {
      try {
        l(m);
      } catch (e) {
        process.stderr.write(`[stream] listener: ${(e as Error).message}\n`);
      }
    }
  }

  subscribe(l: (m: StreamMessage) => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
}
