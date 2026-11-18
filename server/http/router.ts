// SPDX-License-Identifier: Apache-2.0
// A small router over node:http. No framework: the receiver is a handful of routes and
// the UI API a handful more. Handlers return a Reply, or write the response themselves
// (SSE, static files) and return nothing.
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { isLoopback, isThisMachine } from "./net.js";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Remote address, and whether it is this machine. `forwarded`: the request came through
   *  the trusted proxy (Router.trustProxy), so `ip` is the address the proxy named in
   *  X-Forwarded-For (the socket's own when it named none) and `loopback` is false,
   *  whatever that address is: the visitor is never this machine, though the socket is.
   *  A route that acts on this machine asks `forwarded` before it reads anything into `ip`. */
  remote: { ip: string; loopback: boolean; forwarded: boolean };
  /** The raw body, read once and cached. Rejects with { status: 413 } over `maxBytes`. */
  body: (maxBytes?: number) => Promise<Buffer>;
  /** The body parsed as JSON. Rejects with { status: 400 } on bad JSON. */
  json: <T = unknown>(maxBytes?: number) => Promise<T>;
  bearer: () => string | undefined;
  cookies: () => Record<string, string>;
}

export interface Reply {
  status: number;
  json?: unknown;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
}

export type Handler = (ctx: Ctx) => Promise<Reply | undefined | void> | Reply | undefined | void;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];
  /** Called when no route matched; the static file server hooks in here. */
  fallback: Handler = () => ({ status: 404, json: { reason: "not_found" } });

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), parts: pattern.split("/").filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler): this {
    return this.add("GET", p, h);
  }
  post(p: string, h: Handler): this {
    return this.add("POST", p, h);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter(Boolean);
    let methodMismatch = false;
    for (const r of this.routes) {
      const params = matchParts(r.parts, parts);
      if (!params) continue;
      if (r.method !== method.toUpperCase()) {
        methodMismatch = true;
        continue;
      }
      return { handler: r.handler, params };
    }
    if (methodMismatch) return { handler: () => ({ status: 405, json: { reason: "method_not_allowed" } }), params: {} };
    return null;
  }

  /** Whether a reverse proxy on this machine (Tailscale's `tailscale serve`, --public-url)
   *  forwards to us: then a connection from this machine (loopback, or one of its own
   *  addresses) that carries a forwarding header came through it, and is the visitor the
   *  proxy names, never this machine. The proxy's own word is the last address in
   *  X-Forwarded-For (`proxyEntry`). Whatever that address is, this machine's own
   *  included, the request stays a visitor's: the proxy says who reached it, and that may
   *  be another proxy in front of it. A header on a connection from another machine, or
   *  with no trusted proxy, is ignored. */
  trustProxy: () => boolean = () => false;

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    let ip = req.socket.remoteAddress ?? "";
    let forwarded = false;
    if (this.trustProxy() && FORWARDING.some((h) => req.headers[h] !== undefined) && isThisMachine(ip)) {
      forwarded = true;
      ip = proxyEntry(req.headers["x-forwarded-for"]) || ip;
    }
    const ctx = makeCtx(req, res, url, ip, forwarded);
    try {
      // Inside the try: a path whose percent escape does not decode is the sender's
      // mistake (a 400), and an unauthenticated one; it must never reach the process.
      const m = this.match(req.method ?? "GET", url.pathname);
      const reply = m ? await m.handler({ ...ctx, params: m.params }) : await this.fallback(ctx);
      if (reply) send(res, reply, req);
      else if (!res.writableEnded && !res.headersSent) send(res, { status: 404, json: { reason: "not_found" } });
    } catch (e) {
      if (e instanceof HttpError) send(res, { status: e.status, json: e.body ?? { reason: `http_${e.status}` } });
      else if (e && typeof e === "object" && "status" in e && typeof (e as { status: unknown }).status === "number") {
        const err = e as { status: number; body?: unknown };
        send(res, { status: err.status, json: err.body ?? { reason: `http_${err.status}` } });
      } else {
        process.stderr.write(`[sessionpipe-gui] ${req.method} ${url.pathname}: ${(e as Error)?.stack ?? e}\n`);
        if (!res.headersSent) send(res, { status: 500, json: { reason: "internal" } });
        else res.end();
      }
    }
  }
}

/** What a proxy puts on a request it forwards: any one of these says the request came
 *  through one. X-Forwarded-For names the visitor; the others only say there was a proxy. */
const FORWARDING = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip"] as const;

/** What the proxy itself wrote in an X-Forwarded-* header: the last entry. A proxy appends
 *  its own (for X-Forwarded-For, the address it took the connection from) to whatever the
 *  header already held (nginx, Apache, HAProxy, Cloudflare), or writes its own alone
 *  (Tailscale, Caddy), so the last entry is the proxy's word and every entry before it is
 *  the sender's. A header sent on several lines reads the same. Undefined when the request
 *  carries no such header, or one with nothing in it. */
export function proxyEntry(header: string | string[] | undefined): string | undefined {
  return (Array.isArray(header) ? header.join(",") : header)
    ?.split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .pop();
}

function matchParts(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) {
    const last = pattern[pattern.length - 1];
    if (!(last?.startsWith("*") && parts.length >= pattern.length - 1)) return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const v = parts[i];
    if (p.startsWith("*")) {
      params[p.slice(1) || "rest"] = parts.slice(i).map(decodePart).join("/");
      return params;
    }
    if (v === undefined) return null;
    if (p.startsWith(":")) params[p.slice(1)] = decodePart(v);
    else if (p !== v) return null;
  }
  return params;
}

/** A path segment decoded, or a 400 when its escape is not UTF-8 (`%E0%A4%A`, `%zz`). */
function decodePart(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    throw new HttpError(400, { reason: "bad_path" });
  }
}

/** A cookie value decoded, or as it is: cookies are per host, not per port, so another
 *  app on this machine can set one this server cannot decode, and that must not fail
 *  every request the browser makes here. */
function decodeCookie(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Bodies over this are gzipped when the client accepts it (a session page is 140 KB of JSON). */
const GZIP_MIN = 1024;

export function send(res: ServerResponse, r: Reply, req?: IncomingMessage): void {
  const headers: Record<string, string> = { ...(r.headers ?? {}) };
  let body: Buffer;
  if (r.json !== undefined) {
    headers["content-type"] ??= "application/json; charset=utf-8";
    body = Buffer.from(JSON.stringify(r.json));
  } else if (r.html !== undefined) {
    headers["content-type"] ??= "text/html; charset=utf-8";
    body = Buffer.from(r.html);
  } else {
    headers["content-type"] ??= "text/plain; charset=utf-8";
    body = Buffer.from(r.text ?? "");
  }
  if (
    body.length >= GZIP_MIN &&
    !headers["content-encoding"] &&
    /\bgzip\b/.test(String(req?.headers["accept-encoding"] ?? ""))
  ) {
    body = gzipSync(body);
    headers["content-encoding"] = "gzip";
    headers.vary = headers.vary ? `${headers.vary}, accept-encoding` : "accept-encoding";
  }
  headers["content-length"] = String(body.length);
  res.writeHead(r.status, headers);
  res.end(body);
}

function makeCtx(req: IncomingMessage, res: ServerResponse, url: URL, ip: string, forwarded = false): Ctx {
  let raw: Promise<Buffer> | null = null;
  let limit = Number.POSITIVE_INFINITY;
  const body = (maxBytes = 1024 * 1024): Promise<Buffer> => {
    if (raw) return raw;
    limit = maxBytes;
    raw = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let n = 0;
      req.on("data", (c: Buffer) => {
        n += c.length;
        if (n > limit) {
          reject(new HttpError(413, { reason: "too_large" }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
    return raw;
  };
  return {
    req,
    res,
    url,
    params: {},
    remote: { ip, loopback: !forwarded && isLoopback(ip), forwarded },
    body,
    json: async <T>(maxBytes?: number) => {
      const b = await body(maxBytes);
      try {
        return JSON.parse(b.toString("utf8")) as T;
      } catch {
        throw new HttpError(400, { reason: "malformed" });
      }
    },
    bearer: () => {
      const h = req.headers.authorization;
      const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
      return m?.[1]?.trim();
    },
    cookies: () => {
      const out: Record<string, string> = {};
      for (const part of (req.headers.cookie ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out[part.slice(0, i).trim()] = decodeCookie(part.slice(i + 1).trim());
      }
      return out;
    },
  };
}
