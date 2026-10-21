// SPDX-License-Identifier: Apache-2.0
// The /phone page's state machine: the lane it recommends, the chips, the two sides, the
// phone's three readings of step 2 and step 3, and the urls it derives.
import type { PhoneInfo, Viewer } from "@shared/api";
import { describe, expect, it } from "vitest";
import {
  currentStep,
  digitsOf,
  phoneOs,
  phoneStep2,
  phonesConnected,
  pickLane,
  sendingUrl,
  side,
  step3FromDevice,
  tailscaleState,
  trustUrl,
} from "./state";

const base: PhoneInfo = {
  lan: { url: "http://192.168.1.20:7373/?k=uik_demo", qr: "/api/ui/qr.svg" },
  rpId: "studio-mac.local",
  tls: true,
  publicUrl: null,
  tailscale: { installed: false, running: false, name: null, serving: false },
  trusted: [],
  pending: [],
};
const ts = (over: Partial<PhoneInfo["tailscale"]>, publicUrl: string | null = null): PhoneInfo => ({
  ...base,
  publicUrl,
  tailscale: { ...base.tailscale, ...over },
});

describe("the lane", () => {
  it("is Tailscale when it is installed and connected, or already serving", () => {
    expect(pickLane(ts({ installed: true, running: true, name: "studio.tail1234.ts.net" }))).toBe("tailscale");
    expect(pickLane(ts({ installed: true, running: true, serving: true }, "https://studio.tail1234.ts.net"))).toBe(
      "tailscale",
    );
  });
  it("is the same Wi-Fi otherwise: not installed, or installed but not connected", () => {
    expect(pickLane(base)).toBe("wifi");
    expect(pickLane(ts({ installed: true, running: false }))).toBe("wifi");
  });
  it("reads the Tailscale chip", () => {
    expect(tailscaleState(base)).toBe("absent");
    expect(tailscaleState(ts({ installed: true }))).toBe("off");
    expect(tailscaleState(ts({ installed: true, running: true }))).toBe("running");
    expect(tailscaleState(ts({ installed: true, running: true, serving: true }, "https://s.ts.net"))).toBe("serving");
    // A public url set by hand with no serve behind it is still "running": the serve is what makes it reachable.
    expect(tailscaleState(ts({ installed: true, running: true, serving: false }, "https://s.ts.net"))).toBe("running");
  });
});

describe("urls", () => {
  it("sends through the public url first, then the TLS origin, else nowhere", () => {
    expect(sendingUrl(base)).toBe("https://studio-mac.local:7373");
    expect(sendingUrl({ ...base, publicUrl: "https://studio.tail1234.ts.net" })).toBe("https://studio.tail1234.ts.net");
    expect(sendingUrl({ ...base, tls: false })).toBeNull();
    expect(sendingUrl({ ...base, lan: { ...base.lan, url: "nope" } })).toBeNull();
  });
  it("derives the trust page from the LAN url, keeping the key", () => {
    expect(trustUrl(base.lan.url)).toBe("http://192.168.1.20:7373/trust?k=uik_demo");
    expect(trustUrl("http://192.168.1.20:7373/")).toBe("http://192.168.1.20:7373/trust");
    expect(trustUrl("nope")).toBeNull();
  });
});

describe("sides and phones", () => {
  const ua = {
    iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
    android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
  };
  it("reads the phone's OS from its user agent", () => {
    expect(phoneOs(ua.iphone)).toBe("iphone");
    expect(phoneOs(ua.android)).toBe("android");
    expect(phoneOs(ua.mac)).toBe("other");
  });
  it("is the laptop side on this machine, the phone side elsewhere, and guesses from the agent until known", () => {
    expect(side(true, ua.iphone)).toBe("laptop");
    expect(side(false, ua.mac)).toBe("phone");
    expect(side(null, ua.iphone)).toBe("phone");
    expect(side(null, ua.mac)).toBe("laptop");
  });
  it("counts phones and tablets on the stream, never this very connection", () => {
    const v = (device: Viewer["device"], current = false): Viewer => ({
      id: device + String(current),
      ip: "192.168.1.30",
      loopback: false,
      device,
      label: device,
      connectedAt: "2026-10-22T10:00:00Z",
      lastSeenAt: "2026-10-22T10:00:00Z",
      current,
    });
    expect(phonesConnected([])).toBe(0);
    expect(phonesConnected([v("laptop"), v("phone"), v("tablet"), v("phone", true)])).toBe(2);
  });
});

describe("the phone's step 2", () => {
  const https = "https://studio-mac.local:7373";
  it("is plain over http, wrong on an https origin off the rp id, secure under it", () => {
    expect(phoneStep2({ protocol: "http:", hostname: "192.168.1.20" }, "studio-mac.local", https)).toBe("plain");
    expect(phoneStep2({ protocol: "https:", hostname: "other.local" }, "studio-mac.local", https)).toBe("wrong");
    expect(phoneStep2({ protocol: "https:", hostname: "studio-mac.local" }, "studio-mac.local", https)).toBe("secure");
    // No sending origin known: nowhere to point, so no "wrong".
    expect(phoneStep2({ protocol: "https:", hostname: "other.local" }, "studio-mac.local", null)).toBe("secure");
  });
});

describe("the phone's step 3", () => {
  it("follows the device poll", () => {
    expect(step3FromDevice({ state: "pending", digits: "482913", machine: null })).toEqual({
      k: "waiting",
      digits: "482913",
    });
    expect(step3FromDevice({ state: "trusted", digits: "482913", machine: "studio-mac" })).toEqual({
      k: "trusted",
      machine: "studio-mac",
    });
    expect(step3FromDevice({ state: "refused", digits: "482913", machine: null })).toEqual({ k: "refused" });
    expect(step3FromDevice({ state: "expired", digits: "482913", machine: null })).toEqual({ k: "expired" });
  });
  it("shows the digits in two groups, zero-padded", () => {
    expect(digitsOf("482913")).toEqual(["482", "913"]);
    expect(digitsOf("913")).toEqual(["000", "913"]);
  });
});

describe("the step to do now", () => {
  it("walks 1 → 2 → 3 and rests once trusted", () => {
    expect(currentStep({ phones: 0, https: false, trusted: false })).toBe(1);
    expect(currentStep({ phones: 1, https: false, trusted: false })).toBe(2);
    expect(currentStep({ phones: 1, https: true, trusted: false })).toBe(3);
    expect(currentStep({ phones: 0, https: true, trusted: false })).toBe(3);
    expect(currentStep({ phones: 1, https: true, trusted: true })).toBe(0);
  });
});
