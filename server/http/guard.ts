// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. What the router asks of every request before a handler sees it.
//
// The UI API trusts this machine: a request from loopback needs no key, and the routes
// that act here (setup, plugins, the sink token) look at the remote address alone. The
// address says where a request was made. Which page made it, the browser says: in
// `Sec-Fetch-Site` and `Origin`, and in the name it asked for, `Host`. The receiver
// answers its own pages, under its own names, so two rules stand in front of every route,
// the static files included:
//
//   1. Its own pages. A request the browser marks as coming from another origin is
//      refused, 403 `cross_site`: `Sec-Fetch-Site` other than `same-origin` or `none`;
//      where the browser sends none (plain http off loopback, an older browser), an
//      `Origin` that is not this server's own. A link is the one thing taken from another
//      site: a top-level GET navigation to a page, never to the API. No route is exempt.
//   2. Its own names. A request made on this machine must name the server in `Host` by a
//      name it hands out itself or was told: localhost, an address, the `.local` name,
//      the TLS name, `--rp-id`, `--allow-host`. Else 403 `unknown_host`. The public url's
//      name is the proxy's: a request under it is answered when it came through the
//      proxy, never straight from this machine. A request from another machine, or one
//      that came through the trusted proxy, has no standing here but the UI key, and is
//      not asked.
//
// A route a sink or a daemon calls with a bearer token of its own (`wire: true`, HTTP.md
// §1–3) takes nothing from the address, so rule 2 passes its callers by: a sink or a
// daemon is answered under whatever name it reached the server by. A browser has no call
// to make there, and one that makes it is asked the name like anywhere else. Clients that
// are not browsers (the sessionpipe CLI, hooks and daemon, the native shell, which carries
// the page's requests itself, this package's own CLI, curl) send neither header rule 1
// reads; rule 2 asks them the name as it asks a browser, on every route that is not a
// sink's or a daemon's.
import type { IncomingMessage } from "node:http";
import net from "node:net";
import { isThisMachine } from "./net.js";

export interface RouteOptions {
  /** A sink's or a daemon's route: its credential is its own bearer token, never the
   *  address it calls from. Rule 2 above does not apply to a caller there that is not a
   *  browser; rule 1 applies to every caller. */
  wire?: boolean;
}

export interface GuardDeps {
  /** The names this server answers to on this machine besides localhost and an address:
   *  the `.local` name, the TLS name, `--rp-id`, `--allow-host`. Read on every request
   *  (the setup page changes them). */
  hosts?: () => readonly (string | undefined)[];
  /** Origins that are this server seen through a proxy (`--public-url`). */
  origins?: () => readonly (string | undefined)[];
  /** Whether a socket's remote address is this machine's (tests). */
  thisMachine?: (ip: string) => boolean;
}

export type GuardReason = "cross_site" | "unknown_host";

export interface GuardRefusal {
  status: 403;
  reason: GuardReason;
  /** Words for a person. */
  error: string;
}

/** What a guarded request is, for `checkRequest`. */
export interface GuardRequest {
  req: IncomingMessage;
  pathname: string;
  /** The request came through the trusted proxy (router.ts), so `X-Forwarded-Host` names
   *  the host the browser asked for, and the request is a visitor's, not this machine's. */
  forwarded: boolean;
  route: RouteOptions;
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** The host of a `Host` header as a URL would have it, without its port: lowercased, an
 *  address in its one canonical spelling (`127.1` → `127.0.0.1`, `[0:0:0:0:0:0:0:1]` →
 *  `::1`), a zone id and a trailing dot dropped. `Studio.local:7373` → `studio.local`.
 *  What is no host at all (`user@host`, `[::1]x`) comes back as it was sent, which is a
 *  name nothing answers to. */
export function hostName(header: string | undefined): string {
  const raw = (header ?? "").trim().toLowerCase();
  if (!raw) return "";
  try {
    const u = new URL(`http://${raw.replace(/%[^\]]*\]/, "]")}`);
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash || raw.includes("@")) return raw;
    return u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return raw;
  }
}

/** An address a browser does not take for this machine's when it marks a request, though
 *  the connection may arrive from loopback all the same: the unspecified address (0.0.0.0,
 *  ::), which is where a server listens, not where it is opened, and an IPv4 address
 *  written as an IPv6 one (::ffff:127.0.0.1). Neither is a way this server is opened. */
const notOpenedBy = (host: string): boolean => host === "0.0.0.0" || host === "::" || host.startsWith("::ffff:");

/** Whether `host` (as `hostName` gives it) is a name this server answers to on this
 *  machine: localhost, any other address (an address is not a name: nothing resolves it),
 *  and the names the server hands out or was given. Nothing is taken from the machine's
 *  hostname by itself: what a name resolves to is the resolver's to say. No `Host` at all
 *  is a client that is not a browser. */
export function knownHost(host: string, deps: GuardDeps = {}): boolean {
  if (!host) return true;
  if (notOpenedBy(host)) return false;
  if (net.isIP(host) !== 0) return true;
  if (host === "localhost") return true;
  for (const extra of deps.hosts?.() ?? []) if (extra && hostName(extra) === host) return true;
  return false;
}

/** The last entry of a forwarded header: the one the proxy itself wrote (router.ts). */
const lastOf = (v: string | string[] | undefined): string | undefined =>
  (Array.isArray(v) ? v.join(",") : v)
    ?.split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .pop();

/** Whether an `Origin` header names this server: the host the request itself was sent to
 *  (either scheme: one port answers http and https), or the public url. */
function ownOrigin(origin: string, g: GuardRequest, deps: GuardDeps): boolean {
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (o.protocol !== "http:" && o.protocol !== "https:") return false;
  // An Origin is a scheme, a host and a port, written as a browser writes it: one that
  // carries anything more (a user, a path) or reads differently once parsed is not one.
  if (origin.toLowerCase() !== o.origin) return false;
  const h = g.req.headers;
  const asked = [one(h.host), g.forwarded ? lastOf(h["x-forwarded-host"]) : undefined];
  if (asked.some((a) => a !== undefined && a.trim().toLowerCase() === o.host)) return true;
  return (deps.origins?.() ?? []).some((own) => own !== undefined && own.replace(/\/+$/, "") === o.origin);
}

/** Rule 1's reading of the browser's own word. */
export function fromAnotherOrigin(g: GuardRequest, deps: GuardDeps = {}): boolean {
  const site = one(g.req.headers["sec-fetch-site"]);
  if (site !== undefined) return site !== "same-origin" && site !== "none";
  const origin = one(g.req.headers.origin);
  if (origin === undefined) return false;
  return !ownOrigin(origin, g, deps);
}

const isRead = (method: string): boolean => method === "GET" || method === "HEAD";

/** The two rules; null when the request may go on to its handler. */
export function checkRequest(g: GuardRequest, deps: GuardDeps = {}): GuardRefusal | null {
  const { req, route } = g;
  const method = (req.method ?? "GET").toUpperCase();

  // 1. Another origin: only a link to a page.
  if (fromAnotherOrigin(g, deps)) {
    const api = g.pathname.startsWith("/api/") || g.pathname.startsWith("/.well-known/");
    const link =
      isRead(method) &&
      !api &&
      one(req.headers["sec-fetch-mode"]) === "navigate" &&
      one(req.headers["sec-fetch-dest"]) === "document";
    if (!link)
      return {
        status: 403,
        reason: "cross_site",
        error: "This request came from another site. sessionpipe-gui answers its own pages only.",
      };
  }
  // A visitor the proxy forwarded stands on the UI key, and a sink or a daemon on its
  // token: neither is asked a name. A browser says it is one in either header.
  const browser = req.headers["sec-fetch-site"] !== undefined || req.headers.origin !== undefined;
  if (g.forwarded || (route.wire && !browser)) return null;

  // 2. On this machine, by a name of this machine.
  const host = hostName(one(req.headers.host));
  if (!knownHost(host, deps) && (deps.thisMachine ?? isThisMachine)(req.socket.remoteAddress ?? "")) {
    const port = req.socket.localPort;
    return {
      status: 403,
      reason: "unknown_host",
      error: `sessionpipe-gui does not know this machine by the name "${host.replace(/[^a-z0-9.:_-]/g, "")}". Open http://localhost${port ? `:${port}` : ""} instead, or start it with --allow-host <name>. Behind a reverse proxy: --public-url https://<name>, and the proxy must send X-Forwarded-For.`,
    };
  }
  return null;
}

/** For a page a browser may show: this server's pages are not for another site's frame. */
export const NO_FRAMING: Readonly<Record<string, string>> = {
  "content-security-policy": "frame-ancestors 'self'",
  "x-frame-options": "SAMEORIGIN",
};
