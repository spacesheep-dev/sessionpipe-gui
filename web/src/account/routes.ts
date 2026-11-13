// SPDX-License-Identifier: Apache-2.0
// Owned by: web. What a page on a spacesheep account answers when it asks its backend by
// path (lib/net.ts apiFetch): the routes of /api/ui that mean something with no receiver
// are answered from the page's own store and control, with the shapes the receiver answers
// (server/ui, server/control/ui.ts); a send goes to the jobs door; this phone's own device
// key goes through the hub. Every other path is answered 404 here, in the page: nothing but
// the five doors ever reaches the network in this mode.
import type { ControlActivity, Info, LimitsEntry, Snapshot, SpacesheepSourceStatus } from "@shared/api";
import { ROUTES } from "@shared/api";
import { cleanReason } from "@shared/reason";
import { type MemoryControl, SendRefused } from "../../../server/control/remote";
import { isPaired, type MachineRow, pairedMachine } from "../../../server/control/rows";
import type { ApiBackend } from "../lib/net";
import type { AccountDoors } from "./doors";
import { type AccountShell, type DeviceAsked, type Disconnected, hubError } from "./shell";

/** The reason every path with no meaning on an account is refused with. */
export const NOT_HERE = "not_in_account_mode";

export interface RouteDeps {
  shell: AccountShell;
  info(): Info;
  snapshot(): Snapshot;
  control: MemoryControl;
  /** A send for one of the account's machines: its row, or SendRefused. */
  send(m: MachineRow, body: Record<string, unknown>): Promise<ControlActivity>;
  /** Every row the page is shown, newest first. */
  activity(limit: number): ControlActivity[];
  limits(): LimitsEntry[];
  doors: AccountDoors;
  /** The account as the receiver's Settings reads a connected one; null once it is gone. */
  relay(): SpacesheepSourceStatus | null;
  deviceAsk(): Promise<DeviceAsked>;
  disconnect(): Promise<Disconnected>;
  asked: Map<string, number>;
  json(body: unknown, status?: number): Response;
}

type Handler = (url: URL, body: unknown) => Response | Promise<Response>;

/** Where a path the page asks for is read against: no host of anybody's. */
const HERE = "http://account.invalid";

/** The paths of a receiver: the page's requests of these are the backend's to answer. */
const OURS = /^\/(api\/|themes\/|skins\/|attachments\/|\.well-known\/)/;

export function routes(d: RouteDeps): ApiBackend {
  const { json, control } = d;
  const C = ROUTES.ui.control;
  const table: Record<string, Handler> = {
    [`GET ${ROUTES.ui.info}`]: () => json(d.info()),
    [`GET ${ROUTES.ui.snapshot}`]: () => json(d.snapshot()),
    [`GET ${ROUTES.ui.limits}`]: () => json({ limits: d.limits() }),
    [`GET ${C}/machines`]: () =>
      json({
        machines: control
          .allMachines()
          .filter(isPaired)
          .map((m) => pairedMachine(m, control.machineControl(m))),
      }),
    [`GET ${C}/activity`]: (url) => {
      const asked = Number(url.searchParams.get("limit") ?? 100);
      const limit = Number.isFinite(asked) ? Math.max(1, Math.min(1000, Math.floor(asked))) : 100;
      return json({ activity: d.activity(limit) });
    },
    // A machine pairs with the account on spacesheep, and a device is approved there:
    // nothing waits here for either.
    [`GET ${C}/pairings`]: () => json({ pairings: [] }),
    [`GET ${C}/devices`]: () => json({ devices: [] }),
    [`POST ${C}/send`]: async (_url, body) => {
      const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
      const m = typeof b.machineId === "string" ? control.machine(b.machineId) : undefined;
      if (!m) return json({ reason: "not_found", error: "No such machine." }, 404);
      try {
        return json(await d.send(m, b), 201);
      } catch (e) {
        if (e instanceof SendRefused) return json(e.body, e.status);
        throw e;
      }
    },
    // The account itself, as the receiver's Settings reads a connected one.
    [`GET ${ROUTES.ui.spacesheep}`]: () => json({ link: d.relay(), pending: null }),
    [`DELETE ${ROUTES.ui.spacesheep}`]: async () => {
      try {
        const gone = await d.disconnect();
        // What the hub says of it: the key is forgotten here and still works there.
        return json({ ok: true, revoked: gone.revoked, revokeUrl: gone.revokeUrl, note: cleanReason(gone.note, 300) });
      } catch (e) {
        const h = hubError(e);
        return json({ reason: h.code, error: cleanReason(h.message) }, h.code === "cancelled" ? 409 : 502);
      }
    },
    // This phone's own device key: the hub reads it from the signer and writes the whole
    // request; nothing the page sends is used.
    [`POST ${ROUTES.ui.spacesheep}/device`]: async () => {
      try {
        const a = await d.deviceAsk();
        return json({ code: a.code, keyId: a.keyId, trustedOn: a.trustedOn ?? [], devicesUrl: a.devicesUrl });
      } catch (e) {
        const h = hubError(e);
        const status =
          h.code === "unauthorized" ? 401 : h.code === "rate_limited" || h.code === "too_many_asks" ? 429 : 502;
        return json({ reason: h.upstream ?? h.code, error: cleanReason(h.message) }, status);
      }
    },
    [`GET ${ROUTES.ui.spacesheep}/device`]: async () => {
      const a = await d.doors.device();
      if (a.hub)
        return json({ reason: a.hub, error: cleanReason(a.json.error) }, a.hub === "no_device_key" ? 409 : 502);
      if (a.status < 200 || a.status >= 300)
        return json({ reason: String(a.json.code ?? "refused"), error: cleanReason(a.json.error) }, 502);
      return json({ trustedOn: a.json.trusted_on ?? [], machines: a.json.machines ?? [], pending: !!a.json.pending });
    },
  };

  return async (path, init) => {
    // Whatever is asked of the page's backend is answered here, in the page: a path that is
    // not a receiver's (another origin, `//host/…`, a data: URL) is not handed to the
    // network on this function's word. It is answered 404 like any path with no meaning.
    let url: URL | null = null;
    try {
      url = new URL(path, HERE);
    } catch {
      // not an address at all
    }
    const ours = !!url && url.origin === HERE && OURS.test(url.pathname);
    const method = (init?.method ?? "GET").toUpperCase();
    const name = ours ? `${method} ${url!.pathname}` : `${method} (not a receiver's path)`;
    const h = ours ? table[name] : undefined;
    let res: Response;
    if (!h) res = json({ reason: NOT_HERE }, 404);
    else {
      let body: unknown;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = undefined;
        }
      }
      try {
        res = await h(url!, body);
      } catch (e) {
        console.error("[account] %s: %s", name, (e as Error).message);
        res = json({ reason: "failed" }, 500);
      }
    }
    d.asked.set(name.replace(/\/[0-9A-Za-z_-]{20,}(?=\/|$)/g, "/:id"), res.status);
    return res;
  };
}
