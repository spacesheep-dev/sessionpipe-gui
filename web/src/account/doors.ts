// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The account's five doors (docs/rfcs/08, "The doors"): the page asks
// `${rxBase}<path>`, the native hub adds the account's key and forwards these and nothing
// else. An answer with the header `x-sessionpipe-hub` is the hub's own (`{ hub: true,
// reason, error }`), one without it is spacesheep's; the two are told apart here, once,
// so nothing reads a hub refusal as spacesheep's word (its 401 is not a revoked key, its
// `busy` 429 not spacesheep's limit).
import { cleanReason } from "@shared/reason";
import type { RemoteSend } from "../../../server/control/remote";
import { type Doors, HUB_HEADER } from "../../../server/sources/relay";

/** A door's answer, read: whose it is, and its JSON body (an empty object when none). */
export interface DoorAnswer {
  status: number;
  /** The hub's own code when the answer is the hub's; null when it is spacesheep's. */
  hub: string | null;
  json: Record<string, unknown>;
}

/** The code a send's refusal carries when the hub itself refused or failed: `hub_<code>`. */
export const hubCode = (code: string): string => `hub_${code}`;

/** How often a send the hub's room was too full for (`busy`) is tried again, and how long
 *  it waits between tries when the hub names no time. */
export const SEND_BUSY_TRIES = 3;
export const SEND_BUSY_WAIT_MS = 1000;

export interface AccountDoors {
  /** The three read doors, for the relay's reader (GET, no body). */
  read: Doors;
  /** `POST /api/machines/<id>/jobs`: a signed command for one of the account's machines. */
  send: RemoteSend;
  /** `GET /api/gui/device`: where this phone's own device key stands. */
  device(): Promise<DoorAnswer>;
}

export interface DoorsOptions {
  rxBase: string;
  fetch?: typeof fetch;
  /** A pause (tests move it). */
  sleep?: (ms: number) => Promise<void>;
  /** spacesheep itself refused the key on a send (its own 401, not the grant's `unlock`). */
  onUnauthorized?: () => void;
}

async function read(res: Response): Promise<DoorAnswer> {
  let json: Record<string, unknown> = {};
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) json = body as Record<string, unknown>;
  } catch {
    // no body, or not JSON
  }
  return { status: res.status, hub: res.headers.get(HUB_HEADER), json };
}

export function openDoors(o: DoorsOptions): AccountDoors {
  const f = o.fetch ?? ((url: RequestInfo | URL, init?: RequestInit) => fetch(url, init));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const get = (path: string, signal?: AbortSignal): Promise<Response> =>
    f(`${o.rxBase}${path}`, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
  return {
    read: (path, init) => get(path, init?.signal),
    async send(m, body) {
      let last: DoorAnswer | null = null;
      for (let i = 0; i < SEND_BUSY_TRIES; i++) {
        let res: Response;
        try {
          res = await f(`${o.rxBase}/api/machines/${encodeURIComponent(m.id)}/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(body),
          });
        } catch {
          // The request never left the app (the hub's protocol failed it).
          return { status: 502, json: { code: hubCode("unreachable"), error: "spacesheep could not be reached." } };
        }
        last = await read(res);
        if (last.hub !== "busy") break;
        const wait = Number(res.headers.get("retry-after"));
        if (i < SEND_BUSY_TRIES - 1) await sleep(Number.isFinite(wait) && wait > 0 ? wait * 1000 : SEND_BUSY_WAIT_MS);
      }
      const a = last!;
      // The hub's own refusal: its words, under a code that is never one of spacesheep's,
      // and a status that is never read as spacesheep's 401 or 409.
      if (a.hub)
        return {
          status: a.status === 504 ? 504 : 502,
          json: { code: hubCode(a.hub), error: cleanReason(a.json.error) || a.hub.replace(/_/g, " ") },
        };
      // spacesheep's own 401 that is not the grant's: the key is refused there.
      if (a.status === 401 && a.json.code !== "unlock") o.onUnauthorized?.();
      return { status: a.status, json: a.json };
    },
    device: async () => read(await get("/api/gui/device")),
  };
}
