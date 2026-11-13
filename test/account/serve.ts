// SPDX-License-Identifier: Apache-2.0
// Test helper: the app's page served with no GUI server behind it. One small http server
// stands where the native app stands: it serves the built page (dist/web) as the app serves
// its bundle, and it is the way to the hub stood in (hub.ts): the account's doors under
// /rx/<id>/…, the hub's commands under /__hub/invoke, its events under /__hub/events, the
// shell's contract under /__hub/contract. There is no /api/ui here: a request to any
// receiver path is answered 599 and kept in `strays`, for a test to find.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { HubRefused, type HubStandIn } from "./hub.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

export interface AccountServer {
  url: string;
  /** Requests to a receiver's own paths (/api/…, /themes/…): there is no receiver here. */
  strays: string[];
  /** Every request, in order: "GET /path". */
  seen: string[];
  close(): Promise<void>;
}

const read = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
  });

export async function startAccountServer(o: { web: string; hub: HubStandIn; port?: number }): Promise<AccountServer> {
  const { hub } = o;
  const strays: string[] = [];
  const seen: string[] = [];
  const events: { n: number; event: string; payload: unknown }[] = [];
  const waiting = new Set<() => void>();
  hub.on((event, payload) => {
    events.push({ n: events.length + 1, event, payload });
    for (const w of [...waiting]) w();
  });
  // Same-origin with the page here; the app's rx: protocol is another origin there.
  hub.rxBase = (id) => `/rx/${id}`;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://account.test");
    const p = url.pathname;
    seen.push(`${req.method} ${p}`);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      if (p === "/__hub/contract") return send(200, hub.contract());
      if (p === "/__hub/invoke" && req.method === "POST") {
        const { cmd, args, deviceKey } = JSON.parse((await read(req)) || "{}") as {
          cmd: string;
          args?: Record<string, unknown>;
          deviceKey?: Record<string, unknown>;
        };
        // The signer's own key, as the shell would read it natively.
        if (deviceKey) hub.deviceKey = deviceKey;
        try {
          return send(200, { ok: (await hub.invoke(cmd, args ?? {})) ?? null });
        } catch (e) {
          return send(200, {
            err:
              e instanceof HubRefused ? e.toJSON() : typeof e === "string" ? e : { code: "failed", message: String(e) },
          });
        }
      }
      if (p === "/__hub/events") {
        const since = Number(url.searchParams.get("since") ?? 0);
        if (!events.some((e) => e.n > since))
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(t);
              waiting.delete(done);
              resolve();
            };
            const t = setTimeout(done, 20_000);
            waiting.add(done);
            req.on("close", done);
          });
        return send(200, { events: events.filter((e) => e.n > since), next: events.length });
      }
      if (p.startsWith("/rx/")) {
        const [, , id = "", ...rest] = p.split("/");
        const ac = new AbortController();
        res.on("close", () => ac.abort());
        const body = req.method === "GET" ? "" : await read(req);
        const a = await hub.door(id, {
          method: req.method ?? "GET",
          path: `/${rest.join("/")}${url.search}`,
          ...(body ? { body } : {}),
          signal: ac.signal,
        });
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(a.status, a.headers);
        return void res.end(a.status === 204 ? undefined : a.body);
      }
      if (/^\/(api|themes|skins|attachments|\.well-known)(\/|$)/.test(p)) {
        strays.push(`${req.method} ${p}`);
        return send(599, { error: "there is no receiver here" });
      }
      // The bundle; any other path is the app's own route (/s/…, /inbox): the page.
      const file = path.join(o.web, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
      const target = p !== "/" && existsSync(file) && statSync(file).isFile() ? file : path.join(o.web, "index.html");
      res.writeHead(200, {
        "content-type": TYPES[path.extname(target)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      createReadStream(target).pipe(res);
    } catch (e) {
      if (!res.headersSent) send(500, { error: String(e) });
    }
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    strays,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const w of [...waiting]) w();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
