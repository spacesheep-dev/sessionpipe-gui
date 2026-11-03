// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The UI side of "use a spacesheep account as the backend"
// (docs/rfcs/08, server/sources/spacesheep.ts): GET the link and any pending connect,
// POST to start one (the server asks spacesheep for a code, hands the page the digits
// and the link to open, and polls until the person confirms, then keeps the key and
// starts the source), DELETE to disconnect (the key is forgotten here; revoking it on
// spacesheep is the sure end).
import type { SpacesheepConnectStart, SpacesheepSourceStatus } from "../../shared/api.js";
import { ROUTES } from "../../shared/api.js";
import type { SpacesheepLink } from "../config.js";
import type { Handler, Reply, Router } from "../http/router.js";

export const DEFAULT_SPACESHEEP_ORIGIN = "https://spacesheep.dev";
/** How long the server keeps polling a pending connect before giving up. */
export const CONNECT_POLL_MAX_MS = 11 * 60_000;

export interface SpacesheepUiDeps {
  /** The link as kept now, or undefined. */
  link: () => SpacesheepLink | undefined;
  /** The running source's status, or null when off. */
  status: () => SpacesheepSourceStatus | null;
  /** Keep the link and start the source (app.ts). */
  connect: (link: SpacesheepLink) => void;
  /** Forget the link and stop the source. */
  disconnect: () => void;
  /** What this install calls itself on spacesheep's confirm page. */
  deviceName: () => string;
  version: () => string;
  fetch?: typeof fetch;
}

export type Pending = SpacesheepConnectStart & {
  origin: string;
  pollToken: string;
  startedAt: number;
  error?: string;
  state: "pending" | "approved" | "denied" | "expired" | "failed";
};

/** `origin` from a request body, or the default: https (or http for a local dev server). */
export function cleanOrigin(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return DEFAULT_SPACESHEEP_ORIGIN;
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname)))
      return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function registerSpacesheepUi(
  router: Router,
  deps: SpacesheepUiDeps,
  guard: (h: Handler) => Handler,
): { pending: () => Pending | null } {
  const f = deps.fetch ?? fetch;
  let pending: Pending | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  const view = (p: Pending | null): Omit<Pending, "pollToken"> | null => {
    if (!p) return null;
    const { pollToken: _t, ...rest } = p;
    return rest;
  };

  const pollOnce = async (p: Pending): Promise<void> => {
    const res = await f(`${p.origin}/api/gui/connect/poll?code=${encodeURIComponent(p.code)}`, {
      headers: { authorization: `Bearer ${p.pollToken}`, accept: "application/json" },
    });
    if (res.status === 204) return;
    const j = (await res.json().catch(() => ({}))) as { state?: string; key?: string; email?: string };
    if (res.status === 200 && j.state === "approved" && typeof j.key === "string" && typeof j.email === "string") {
      p.state = "approved";
      deps.connect({ origin: p.origin, key: j.key, email: j.email, connectedAt: new Date().toISOString() });
      return;
    }
    p.state = j.state === "denied" ? "denied" : "expired";
  };

  const schedule = (): void => {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      const p = pending;
      if (!p || p.state !== "pending") return;
      if (Date.now() - p.startedAt > CONNECT_POLL_MAX_MS) {
        p.state = "expired";
        return;
      }
      try {
        await pollOnce(p);
      } catch (e) {
        p.error = (e as Error).message;
      }
      if (p.state === "pending") schedule();
    }, 2000);
    pollTimer.unref();
  };

  router.get(
    ROUTES.ui.spacesheep,
    guard(() => ({
      status: 200,
      json: { link: deps.status(), pending: view(pending) },
      headers: { "cache-control": "no-store" },
    })),
  );

  router.post(
    ROUTES.ui.spacesheep,
    guard(async (ctx): Promise<Reply> => {
      let body: { origin?: unknown } = {};
      try {
        body = await ctx.json<{ origin?: unknown }>(2048);
      } catch {
        body = {};
      }
      const origin = cleanOrigin(body.origin);
      if (!origin)
        return { status: 400, json: { reason: "bad_origin", error: "The origin must be an https address." } };
      if (deps.link())
        return { status: 409, json: { reason: "connected", error: "Already connected. Disconnect first." } };
      if (pending && pending.state === "pending" && Date.now() - pending.startedAt < CONNECT_POLL_MAX_MS)
        return { status: 200, json: view(pending) };
      let res: Response;
      try {
        res = await f(`${origin}/api/gui/connect`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ device: deps.deviceName(), version: deps.version() }),
        });
      } catch (e) {
        return {
          status: 502,
          json: { reason: "unreachable", error: `Couldn't reach ${origin}: ${(e as Error).message}` },
        };
      }
      if (res.status === 429)
        return {
          status: 429,
          json: { reason: "rate_limited", error: "spacesheep asked to wait a bit. Try again in a minute." },
        };
      if (res.status !== 201)
        return {
          status: 502,
          json: {
            reason: "refused",
            error: `${origin} answered ${res.status}. Is it a spacesheep this version knows?`,
          },
        };
      const j = (await res.json()) as {
        code?: string;
        digits?: string;
        url?: string;
        poll_token?: string;
        expires_at?: string;
      };
      if (!j.code || !j.digits || !j.url || !j.poll_token)
        return { status: 502, json: { reason: "malformed", error: "spacesheep's answer was missing a field." } };
      pending = {
        code: j.code,
        digits: j.digits,
        url: j.url,
        expiresAt: j.expires_at ?? new Date(Date.now() + 600_000).toISOString(),
        origin,
        pollToken: j.poll_token,
        startedAt: Date.now(),
        state: "pending",
      };
      schedule();
      return { status: 201, json: view(pending) };
    }),
  );

  // The app's device key, asked to be trusted on spacesheep (its /api/gui/device): the
  // answer carries the match code the app shows and the Devices link where a trusted
  // passkey approves it, per machine, as for a phone.
  router.post(
    `${ROUTES.ui.spacesheep}/device`,
    guard(async (ctx): Promise<Reply> => {
      const link = deps.link();
      if (!link)
        return { status: 409, json: { reason: "not_connected", error: "Connect a spacesheep account first." } };
      let body: { key?: unknown; name?: unknown } = {};
      try {
        body = await ctx.json<{ key?: unknown; name?: unknown }>(4096);
      } catch {
        return { status: 400, json: { reason: "malformed" } };
      }
      let res: Response;
      try {
        res = await f(`${link.origin}/api/gui/device`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${link.key}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ key: body.key, name: typeof body.name === "string" ? body.name : deps.deviceName() }),
        });
      } catch (e) {
        return {
          status: 502,
          json: { reason: "unreachable", error: `Couldn't reach ${link.origin}: ${(e as Error).message}` },
        };
      }
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok)
        return {
          status: res.status === 401 ? 401 : res.status === 403 ? 403 : 502,
          json: {
            reason: String(j.code ?? "refused"),
            error: String(j.error ?? `${link.origin} answered ${res.status}`),
          },
        };
      return {
        status: 200,
        json: { code: j.code, keyId: j.key_id, trustedOn: j.trusted_on ?? [], devicesUrl: j.devices_url },
      };
    }),
  );
  router.get(
    `${ROUTES.ui.spacesheep}/device`,
    guard(async (ctx): Promise<Reply> => {
      const link = deps.link();
      if (!link) return { status: 409, json: { reason: "not_connected" } };
      const id = ctx.url.searchParams.get("id") ?? "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return { status: 400, json: { reason: "bad_request" } };
      let res: Response;
      try {
        res = await f(`${link.origin}/api/gui/device?id=${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${link.key}`, accept: "application/json" },
        });
      } catch (e) {
        return { status: 502, json: { reason: "unreachable", error: (e as Error).message } };
      }
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return { status: 502, json: { reason: String(j.code ?? "refused"), error: String(j.error ?? "") } };
      return { status: 200, json: { trustedOn: j.trusted_on ?? [], machines: j.machines ?? [], pending: !!j.pending } };
    }),
  );

  router.add(
    "DELETE",
    ROUTES.ui.spacesheep,
    guard(() => {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      pending = null;
      deps.disconnect();
      return { status: 200, json: { ok: true } };
    }),
  );

  return { pending: () => pending };
}
