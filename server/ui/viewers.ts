// SPDX-License-Identifier: Apache-2.0
// Owned by: platform. Who is looking at this GUI right now: one Viewer per open SSE
// stream (shared/api.ts `Viewer`), read from the connection alone (remote address, user
// agent). Nothing is installed on the device; a phone that closes the tab is gone from
// the list the moment its stream drops. Listeners hear every join and leave.
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Viewer } from "../../shared/api.js";

/** The desktop app's own menu-bar stream says so in this header. It is the app watching
 *  for the menu bar and the Dock badge, not a person looking, so it is not a viewer. */
export const CLIENT_HEADER = "x-sessionpipe-client";

export const isShellClient = (headers: IncomingHttpHeaders): boolean => {
  const v = headers[CLIENT_HEADER];
  return (Array.isArray(v) ? v[0] : v)?.trim().toLowerCase() === "shell";
};

export interface ViewerSource {
  ip: string;
  loopback: boolean;
  /** Came through the trusted reverse proxy (--public-url): from anywhere, not the LAN. */
  forwarded?: boolean;
  userAgent?: string;
}

/** The device kind and a short label, from the user agent. A phone and a tablet say so
 *  in their UA; a Mac, Windows or Linux browser does not say whether it is a laptop, so
 *  one on another address is called a laptop (it came over the network) and the one on
 *  this machine a desktop. */
export function describeViewer(ua: string | undefined, loopback: boolean): Pick<Viewer, "device" | "label"> {
  const s = ua ?? "";
  const browser = browserName(s);
  if (/iPhone|iPod/.test(s)) return { device: "phone", label: `iPhone · ${browser}` };
  if (/iPad/.test(s)) return { device: "tablet", label: `iPad · ${browser}` };
  if (/Android/.test(s)) {
    return /Mobile/.test(s)
      ? { device: "phone", label: `Android · ${browser}` }
      : { device: "tablet", label: `Android tablet · ${browser}` };
  }
  const platform = /Macintosh/.test(s)
    ? "Mac"
    : /Windows/.test(s)
      ? "Windows"
      : /CrOS/.test(s)
        ? "ChromeOS"
        : /Linux|X11/.test(s)
          ? "Linux"
          : null;
  if (platform) return { device: loopback ? "desktop" : "laptop", label: `${platform} · ${browser}` };
  return { device: "unknown", label: browser === "browser" ? "unknown device" : `unknown device · ${browser}` };
}

function browserName(ua: string): string {
  if (/Edg(e|A|iOS)?\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Firefox\/|FxiOS\//.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS\/|HeadlessChrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "browser";
}

/** `::ffff:192.168.1.9` is how node reports an IPv4 peer on a dual-stack socket. */
const plainIp = (ip: string): string => ip.replace(/^::ffff:/i, "");

export class ViewerRegistry {
  private viewers = new Map<string, Viewer>();
  private listeners = new Set<() => void>();

  /** Registers a connection and tells every listener; returns the new entry's id. */
  add(src: ViewerSource): string {
    const id = randomBytes(8).toString("hex");
    const now = new Date().toISOString();
    this.viewers.set(id, {
      id,
      ip: src.loopback ? "this machine" : plainIp(src.ip),
      loopback: src.loopback,
      ...(src.forwarded ? { forwarded: true } : {}),
      ...describeViewer(src.userAgent, src.loopback),
      connectedAt: now,
      lastSeenAt: now,
    });
    this.emit();
    return id;
  }

  /** The connection is still open (a ping went out). Quiet: nobody is told. */
  touch(id: string): void {
    const v = this.viewers.get(id);
    if (v) v.lastSeenAt = new Date().toISOString();
  }

  remove(id: string): void {
    if (this.viewers.delete(id)) this.emit();
  }

  /** Every viewer, oldest connection first; `current` set on the one whose id is `self`. */
  list(self?: string): Viewer[] {
    return [...this.viewers.values()].map((v) => (v.id === self ? { ...v, current: true } : { ...v }));
  }

  get size(): number {
    return this.viewers.size;
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
