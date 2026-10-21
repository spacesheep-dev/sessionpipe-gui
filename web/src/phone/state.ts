// SPDX-License-Identifier: Apache-2.0
// Owned by: phone-web. The /phone page's readings, as pure functions of the server's facts
// (PhoneInfo), the viewers on the stream and this page's own origin: which side of the
// page this is (the laptop or the phone), which lane to recommend for sending, what each
// of the three steps shows, and the phone's OS from its user agent. The page draws these;
// nothing here touches the DOM, so the state machine is tested without a browser.
import type { PhoneDeviceState, PhoneInfo, Viewer } from "@shared/api";
import { underRp } from "../control/origin";

export type PhoneOs = "iphone" | "android" | "other";

/** Which phone the steps are for: from the phone's own user agent on the phone side. */
export function phoneOs(ua: string): PhoneOs {
  if (/iPhone|iPad|iPod/i.test(ua)) return "iphone";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

/** The lane the page recommends for sending: Tailscale when it is on this machine and
 *  connected (or already serving), else the same Wi-Fi with the local CA. */
export type Lane = "tailscale" | "wifi";

export function pickLane(info: Pick<PhoneInfo, "tailscale" | "publicUrl">): Lane {
  const ts = info.tailscale;
  if (info.publicUrl || (ts.installed && ts.running)) return "tailscale";
  return "wifi";
}

/** The Tailscale lane's chip: where its one button stands. */
export type TailscaleState = "serving" | "running" | "off" | "absent";

export function tailscaleState(info: Pick<PhoneInfo, "tailscale" | "publicUrl">): TailscaleState {
  const ts = info.tailscale;
  if (info.publicUrl && ts.serving) return "serving";
  if (ts.installed && ts.running) return "running";
  if (ts.installed) return "off";
  return "absent";
}

/** The https origin sending works at, by lane: the public url (no port: the proxy's own),
 *  else `https://<rpId>:<port>` on the LAN url's port when TLS mode is on. */
export function sendingUrl(info: Pick<PhoneInfo, "publicUrl" | "tls" | "rpId" | "lan">): string | null {
  if (info.publicUrl) return info.publicUrl;
  if (!info.tls) return null;
  try {
    const port = new URL(info.lan.url).port;
    return `https://${info.rpId}${port ? `:${port}` : ""}`;
  } catch {
    return null;
  }
}

/** The trust page over plain http on the LAN address, with the UI key (the QR for the
 *  same-Wi-Fi lane). Null when the LAN url does not parse. */
export function trustUrl(lanUrl: string): string | null {
  try {
    const u = new URL(lanUrl);
    const k = u.searchParams.get("k");
    const t = new URL("/trust", u.origin);
    if (k) t.searchParams.set("k", k);
    return t.toString();
  } catch {
    return null;
  }
}

/** Step 1's chip: phones on the stream (other than this very connection). */
export function phonesConnected(viewers: readonly Viewer[]): number {
  return viewers.filter((v) => (v.device === "phone" || v.device === "tablet") && !v.current).length;
}

/** Which side of the page this is. `local` is the setup poller's word (null until known);
 *  a page that cannot tell is read as the phone side when its user agent says phone. */
export type Side = "laptop" | "phone";

export function side(local: boolean | null, ua: string): Side {
  if (local === true) return "laptop";
  if (local === false) return "phone";
  return phoneOs(ua) === "other" ? "laptop" : "phone";
}

/** Step 2's reading on the phone side: on the https origin already (passkeys can work),
 *  on the wrong one (sending works elsewhere), or still over plain http (trust first). */
export type PhoneStep2 = "secure" | "wrong" | "plain";

export function phoneStep2(
  loc: { protocol: string; hostname: string },
  rpId: string,
  https: string | null,
): PhoneStep2 {
  if (loc.protocol !== "https:") return "plain";
  if (!underRp(loc.hostname, rpId) && https) return "wrong";
  return "secure";
}

/** Step 3 on the phone side, from the device request's phase and the poll's answer. */
export type Step3 =
  | { k: "ready" }
  | { k: "waiting"; digits: string }
  | { k: "trusted"; machine: string | null }
  | { k: "refused" }
  | { k: "expired" };

export function step3FromDevice(d: PhoneDeviceState): Step3 {
  switch (d.state) {
    case "pending":
      return { k: "waiting", digits: d.digits };
    case "trusted":
      return { k: "trusted", machine: d.machine };
    case "refused":
      return { k: "refused" };
    case "expired":
      return { k: "expired" };
  }
}

/** The six digits as two groups of three, zero-padded. */
export function digitsOf(check: string): [string, string] {
  const d = check.replace(/\D/g, "").padStart(6, "0").slice(-6);
  return [d.slice(0, 3), d.slice(3)];
}

/** Which of the three steps is the one to do now, for the gutter's mark. */
export function currentStep(o: { phones: number; https: boolean; trusted: boolean }): 1 | 2 | 3 | 0 {
  if (o.trusted) return 0;
  if (!o.phones && !o.https) return 1;
  if (!o.https) return 2;
  return 3;
}
