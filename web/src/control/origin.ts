// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The wrong-origin guard. A passkey is bound to the origin that made
// it, so a page on any other address (http://localhost while the rp id is the `.local`
// name, say) can never sign: offering to "add this device" there would make a passkey the
// right origin cannot see. The one honest answer is the address where sending works. Pure
// functions, so the page's reading of them is tested without a browser.
import type { Info, TlsInfo } from "@shared/api";

/** Is `hostname` the rp id or under it (CONTROL.md §3.2)? True when the rp id is unknown. */
export function underRp(hostname: string, rp: string | null | undefined): boolean {
  if (!rp) return true;
  const h = hostname.toLowerCase();
  const r = rp.toLowerCase();
  return h === r || h.endsWith(`.${r}`);
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** The origin passkeys work at: the server's own list (`Info.control.origins`, the first
 *  one); on an older server the public url or the TLS origin, when its host is the rp id.
 *  Null when nothing secure exists yet. */
export function sendingOrigin(o: {
  origins?: string[];
  rpId?: string | null;
  tls?: TlsInfo | null;
  remote?: { url: string } | null;
}): string | null {
  const rp = o.rpId?.toLowerCase();
  const listed = (o.origins ?? []).filter((u) => hostOf(u) !== null);
  if (listed[0]) return listed[0];
  for (const u of [o.remote?.url, o.tls?.on ? o.tls.httpsUrl : undefined]) {
    if (!u) continue;
    const h = hostOf(u);
    if (h && (!rp || underRp(h, rp))) return u;
  }
  return null;
}

export const sendingOriginOf = (info: Info): string | null =>
  sendingOrigin({ origins: info.control?.origins, rpId: info.control?.rpId, tls: info.tls, remote: info.remote });

/** Is this page's origin one passkeys work at? With the server's list, exactly one of
 *  them (an origin is scheme + host + port); without it, under the rp id. */
export function onSendingOrigin(
  loc: { origin: string; hostname: string },
  rp: string | null | undefined,
  origins: string[] | undefined,
): boolean {
  if (origins?.length) return origins.some((o) => o.replace(/\/$/, "").toLowerCase() === loc.origin.toLowerCase());
  return underRp(loc.hostname, rp);
}

/** The one line a page on the wrong address shows instead of any control affordance. */
export const wrongOriginWords = (origin: string): string => `Sending works from ${origin}; open it there.`;

/** The guard's reading for a page at `loc`: the sending origin when this page is not on
 *  one and one is known, else null (right address, or nothing to point at). */
export function wrongOrigin(
  loc: { origin: string; hostname: string },
  rp: string | null | undefined,
  origins: string[] | undefined,
  target: string | null,
): string | null {
  if (!target || onSendingOrigin(loc, rp, origins)) return null;
  if (target.replace(/\/$/, "").toLowerCase() === loc.origin.toLowerCase()) return null;
  // A loopback origin is the server's own machine: from a page on any other host it names
  // the visitor's machine instead, so there is nowhere honest to point (the plain-http hint
  // says what is true there).
  const targetHost = hostOf(target);
  if (targetHost && isLoopback(targetHost) && !isLoopback(loc.hostname.toLowerCase())) return null;
  return target;
}

const isLoopback = (host: string): boolean =>
  host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "::1" || /^127\./.test(host);
