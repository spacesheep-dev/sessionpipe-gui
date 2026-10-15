// SPDX-License-Identifier: Apache-2.0
// GET /api/ui/stream: Server-Sent Events. The first frame is a snapshot, then every
// store message, every control message and every change of who is connected as it
// happens, and a `: ping` comment every 15 s so proxies and phones keep the connection.
// Each stream is one Viewer in the registry for as long as it stays open.
import type { Snapshot, StreamMessage } from "../../shared/api.js";
import { machineEntry } from "../../shared/machine.js";
import type { Control } from "../control/index.js";
import type { Ctx } from "../http/router.js";
import type { Store } from "../store/store.js";
import type { ViewerRegistry } from "./viewers.js";

export const PING_MS = 15_000;

export interface StreamDeps {
  store: Store;
  control: Control;
  snapshot: () => Snapshot;
  viewers: ViewerRegistry;
  pingMs?: number;
  /** The plugin host's own messages (suggestions), when plugins are on. */
  plugins?: { subscribe(l: (m: StreamMessage) => void): () => void };
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
  const me = deps.viewers.add({
    ip: ctx.remote.ip,
    loopback: ctx.remote.loopback,
    userAgent: Array.isArray(ua) ? ua[0] : ua,
  });
  write({ kind: "snapshot", snapshot: { ...deps.snapshot(), viewers: deps.viewers.list(me) } });
  const offStore = deps.store.subscribe((m) => {
    if (m.kind === "machine") {
      const control = machineEntry(deps.control.machines(), m.machine.name)?.[1];
      write({ kind: "machine", machine: control ? { ...m.machine, control } : m.machine });
    } else write(m);
  });
  // A machine message from control carries only what the daemon told it; the store's
  // reading of that machine (sessions, versions) wins when it has one: the snapshot row
  // this daemon was merged into, by its id (the names may differ by a `.local`).
  const offControl = deps.control.subscribe((m) => {
    if (m.kind === "machine") {
      const id = m.machine.control?.machineId;
      const known = id ? deps.snapshot().machines.find((x) => x.control?.machineId === id) : undefined;
      write({ kind: "machine", machine: known ?? m.machine });
    } else write(m);
  });
  const offViewers = deps.viewers.subscribe(() => write({ kind: "viewers", viewers: deps.viewers.list(me) }));
  const offPlugins = deps.plugins?.subscribe(write);
  const ping = setInterval(() => {
    if (res.destroyed || res.writableEnded) return;
    res.write(": ping\n\n");
    deps.viewers.touch(me);
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
    deps.viewers.remove(me);
    if (!res.writableEnded) res.end();
  };
  res.on("close", cleanup);
  req.on("close", cleanup);
  req.on("error", cleanup);
}
