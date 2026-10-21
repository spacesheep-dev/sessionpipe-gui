// SPDX-License-Identifier: Apache-2.0
// Mock mode's phone routes: the control pages fetch their own origin, so the mock answers
// `fetch` itself for /api/ui/phone*, /api/ui/info (with `control.origins`), the setup
// status (403 for the phone side) and the two control reads the page makes. The scene is
// picked by the url: `?phone=tailscale|serving|wifi|waiting|trusted` (wifi by default) and
// `&side=phone` for the phone's own view of it.
import type { Info, PhoneDeviceState, PhoneInfo, PhoneTrustCheck } from "@shared/api";
import { ROUTES } from "@shared/api";

export type PhoneScene = "tailscale" | "serving" | "wifi" | "waiting" | "trusted";

const TLS = {
  on: true,
  hostname: "studio-mac.local",
  httpsUrl: "https://studio-mac.local:7373",
  caUrl: "http://192.168.1.20:7373/ca.crt",
  caFingerprint: "3F:1A:9C:0B:77:D2:4E:88:AA:10:5C:6E:21:B3:9F:04:C8:12:7D:E5:36:A9:50:0F:91:68:2B:DD:47:C3:15:8E",
  expiresAt: "2027-10-01T00:00:00.000Z",
};

export function phoneInfoFor(scene: PhoneScene, at = Date.now()): PhoneInfo {
  const serving = scene === "serving";
  const ts = scene === "tailscale" || serving;
  return {
    lan: { url: "http://192.168.1.20:7373/?k=uik_demo0000000000000000", qr: "/api/ui/qr.svg" },
    rpId: serving ? "studio-mac.tail1234.ts.net" : "studio-mac.local",
    tls: true,
    publicUrl: serving ? "https://studio-mac.tail1234.ts.net" : null,
    tailscale: ts
      ? { installed: true, running: true, name: "studio-mac.tail1234.ts.net", serving }
      : { installed: false, running: false, name: null, serving: false },
    trusted:
      scene === "trusted" ? [{ id: "k_iphone", name: "iPhone", addedAt: new Date(at - 95_000).toISOString() }] : [],
    pending:
      scene === "waiting"
        ? [{ id: "req_demo", name: "iPhone", digits: "482913", since: new Date(at - 20_000).toISOString() }]
        : [],
  };
}

export function phoneDeviceFor(scene: PhoneScene): PhoneDeviceState {
  return scene === "trusted"
    ? { state: "trusted", digits: "482913", machine: "studio-mac" }
    : { state: "pending", digits: "482913", machine: null };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Wraps `window.fetch` for the routes the page and the control pages read. Everything
 *  else goes through untouched. */
export function installPhoneMock(q: URLSearchParams, info: () => Info): void {
  const scene = (q.get("phone") as PhoneScene | null) ?? "wifi";
  const phoneSide = q.get("side") === "phone";
  let state = phoneInfoFor(scene);
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, location.origin).pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (path === ROUTES.ui.phone) return json(state);
    if (path === `${ROUTES.ui.phone}/tailscale` && method === "POST") {
      state = phoneInfoFor("serving");
      return json(state);
    }
    if (path.startsWith(`${ROUTES.ui.phone}/device/`)) return json(phoneDeviceFor(scene));
    if (path === `${ROUTES.ui.phone}/tailscale`) return json({ error: "tailscale: not running" }, 409);
    if (path === `${ROUTES.ui.phone}/trust-check`)
      return json({ https: location.protocol === "https:", rpId: state.rpId } satisfies PhoneTrustCheck);
    if (path === ROUTES.ui.info) {
      const i = info();
      return json({
        ...i,
        tls: TLS,
        remote: state.publicUrl
          ? { url: state.publicUrl, host: new URL(state.publicUrl).host, sinkCommand: "", connectCommand: "" }
          : undefined,
        control: { enabled: true, rpId: state.rpId, machines: 1, origins: [state.publicUrl ?? TLS.httpsUrl] },
      } satisfies Info);
    }
    if (path === `${ROUTES.ui.setup}/status` && phoneSide) return json({ reason: "not_this_machine" }, 403);
    if (path === `${ROUTES.ui.control}/devices` && method === "GET")
      return json({
        devices: state.pending.map((p) => ({
          requestId: p.id,
          check: p.digits,
          key: { id: "cred_demo", alg: -7, spki: "" },
          name: p.name,
          device: "iPhone · Safari",
          fromIp: "192.168.1.31",
          createdAt: p.since,
          expiresAt: new Date(Date.parse(p.since) + 600_000).toISOString(),
          status: "pending",
        })),
      });
    if (path === `${ROUTES.ui.control}/machines`)
      return json({
        machines: [
          { name: "studio-mac", machineId: "m_studio", online: true, keys: [], queued: 0, createdAt: state.lan.url },
        ],
      });
    if (path === `${ROUTES.ui.control}/activity`) return json({ activity: [] });
    return real(input, init);
  };
}
