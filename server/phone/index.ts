// SPDX-License-Identifier: Apache-2.0
// Owned by: onboarding. Connecting a phone, under /api/ui/phone: everything the page
// needs in one read, the one click that puts the GUI on the tailnet, the poll a phone
// runs while a trusted device approves its passkey, and a probe that proves https works.
// The UI's own auth throughout (loopback free, else the UI key); the Tailscale action is
// for this machine only, like the setup actions, because it changes what this machine
// serves. A phone through the public url is a visitor, never this machine (router.ts).
//
//   GET  /              PhoneInfo
//   POST /tailscale     this machine: `tailscale serve --bg <port>` (skipped when serve
//                       already names the port), then the public url → PhoneInfo;
//                       409 / 502 { error } with the CLI's last lines
//   GET  /device/:id    PhoneDeviceState: pending | trusted | refused | expired
//   POST /trust-check   PhoneTrustCheck: https true when this request came over TLS
import os from "node:os";
import type { TLSSocket } from "node:tls";
import QRCode from "qrcode";
import {
  type Info,
  type PhoneDeviceState,
  type PhoneInfo,
  type PhoneTrustCheck,
  ROUTES,
  UI_KEY_PARAM,
} from "../../shared/api.js";
import type { Control } from "../control/index.js";
import type { Ctx, Handler, Reply, Router } from "../http/router.js";
import { type Exec, execDefault, thisMachineOnly } from "../setup/local.js";
import { findTailscale, serveTailscale, TailscaleError, type TailscaleProbe } from "../setup/tailscale.js";

export interface PhoneDeps {
  control: Control;
  info: () => Info;
  uiAuth: (ctx: Ctx) => boolean;
  port: () => number;
  /** The same path the setup page's "Use https://…" takes (App.setPublicUrl). */
  setPublicUrl: (url: string | undefined) => void;
  /** The setup page's probe, shared so its cache is shared (`server/setup/tailscale.ts`). */
  tailscale: TailscaleProbe;
  /** With the test door on, `x-spgui-test-remote` stands in for the remote address (e2e). */
  testDoor?: boolean;
  /** Test seams: the CLI runner and where to look for the binary. */
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

export const PHONE_ROUTES = {
  info: ROUTES.ui.phone,
  tailscale: `${ROUTES.ui.phone}/tailscale`,
  /** + `/:id` */
  device: `${ROUTES.ui.phone}/device`,
  trustCheck: `${ROUTES.ui.phone}/trust-check`,
} as const;

/** The "see it on your phone" url: the LAN address with the UI key, the trust page first
 *  when TLS is on (the same url the QR route and the CLI banner carry). */
export function lanPhoneUrl(info: Info): string {
  const base = info.urls.lan[0] ?? info.urls.local;
  return `${base}${info.tls?.on ? ROUTES.trust : "/"}?${UI_KEY_PARAM}=${encodeURIComponent(info.uiKey)}`;
}

/** The request came over TLS: our own https side, or the trusted proxy's say-so. */
export function arrivedOverHttps(ctx: Ctx): boolean {
  if ((ctx.req.socket as TLSSocket).encrypted === true) return true;
  if (!ctx.remote.forwarded) return false;
  const v = ctx.req.headers["x-forwarded-proto"];
  return (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim() === "https";
}

export function registerPhone(router: Router, deps: PhoneDeps): void {
  const exec = deps.exec ?? execDefault;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const guard =
    (h: Handler): Handler =>
    (ctx) =>
      deps.uiAuth(ctx) ? h(ctx) : { status: 401, json: { reason: "unauthorized" } };
  const local = thisMachineOnly({ testDoor: deps.testDoor ?? false, port: deps.port });

  const phoneInfo = async (): Promise<PhoneInfo> => {
    const info = deps.info();
    const url = lanPhoneUrl(info);
    const [qr, ts] = await Promise.all([
      QRCode.toDataURL(url, { margin: 1, errorCorrectionLevel: "M", width: 320 }),
      deps.tailscale(),
    ]);
    const trusted = new Map<string, PhoneInfo["trusted"][number]>();
    for (const m of deps.control.machines().values())
      for (const k of m.keys)
        if (!trusted.has(k.id)) trusted.set(k.id, { id: k.id, name: k.name ?? "", addedAt: k.addedAt });
    return {
      lan: { url, qr },
      rpId: info.control.rpId,
      tls: info.tls?.on === true,
      publicUrl: info.urls.public ?? null,
      tailscale: {
        installed: ts.installed,
        running: ts.running,
        name: ts.dnsName ?? null,
        serving: ts.serving === true,
      },
      trusted: [...trusted.values()],
      pending: deps.control.pendingDevices(),
    };
  };

  router.get(
    PHONE_ROUTES.info,
    guard(
      async (): Promise<Reply> => ({ status: 200, headers: { "cache-control": "no-store" }, json: await phoneInfo() }),
    ),
  );

  router.post(
    PHONE_ROUTES.tailscale,
    guard(
      local(async (): Promise<Reply> => {
        let name: string;
        try {
          const ts = await serveTailscale(exec, findTailscale(env, platform, home), deps.port(), deps.tailscale);
          name = ts.dnsName!;
        } catch (e) {
          if (e instanceof TailscaleError) return { status: e.status, json: { error: e.message } };
          throw e;
        }
        try {
          deps.setPublicUrl(`https://${name}`);
        } catch (e) {
          return { status: 500, json: { error: (e as Error).message } };
        }
        return { status: 200, headers: { "cache-control": "no-store" }, json: await phoneInfo() };
      }),
    ),
  );

  router.get(
    `${PHONE_ROUTES.device}/:id`,
    guard((ctx): Reply => {
      const d = deps.control.deviceRequest(ctx.params.id ?? "");
      const state: PhoneDeviceState["state"] = !d
        ? "refused"
        : d.status === "added"
          ? "trusted"
          : d.status === "failed"
            ? "refused"
            : d.status === "expired"
              ? "expired"
              : "pending";
      const json: PhoneDeviceState = { state, digits: d?.digits ?? "", machine: d?.machine ?? null };
      return { status: 200, headers: { "cache-control": "no-store" }, json };
    }),
  );

  router.post(
    PHONE_ROUTES.trustCheck,
    guard((ctx): Reply => {
      const json: PhoneTrustCheck = { https: arrivedOverHttps(ctx), rpId: deps.info().control.rpId };
      return { status: 200, headers: { "cache-control": "no-store" }, json };
    }),
  );
}
