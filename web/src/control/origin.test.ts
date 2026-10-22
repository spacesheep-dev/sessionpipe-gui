// SPDX-License-Identifier: Apache-2.0
// The wrong-origin guard: a page off the rp id is pointed at the sending origin, never
// offered a passkey; the origin comes from the server's list, else the public url or TLS.
import type { TlsInfo } from "@shared/api";
import { describe, expect, it } from "vitest";
import { sendingOrigin, underRp, wrongOrigin, wrongOriginWords } from "./origin";

const tls: TlsInfo = {
  on: true,
  hostname: "studio-mac.local",
  httpsUrl: "https://studio-mac.local:7373",
  caUrl: "http://192.168.1.20:7373/ca.crt",
  caFingerprint: "AB:CD",
  expiresAt: "2027-01-01T00:00:00Z",
};

describe("underRp", () => {
  it("matches the rp id and names under it, case-insensitively, and trusts an unknown rp", () => {
    expect(underRp("studio-mac.local", "studio-mac.local")).toBe(true);
    expect(underRp("Studio-Mac.LOCAL", "studio-mac.local")).toBe(true);
    expect(underRp("a.studio-mac.local", "studio-mac.local")).toBe(true);
    expect(underRp("localhost", "studio-mac.local")).toBe(false);
    expect(underRp("notstudio-mac.local", "studio-mac.local")).toBe(false);
    expect(underRp("localhost", null)).toBe(true);
  });
});

describe("sendingOrigin", () => {
  it("takes the first origin the server lists", () => {
    expect(
      sendingOrigin({
        origins: ["https://studio.tail1234.ts.net", "https://studio-mac.local:7373"],
        rpId: "studio.tail1234.ts.net",
        tls,
      }),
    ).toBe("https://studio.tail1234.ts.net");
  });
  it("falls back to the public url, then TLS, on an older server", () => {
    expect(
      sendingOrigin({ rpId: "studio.tail1234.ts.net", tls, remote: { url: "https://studio.tail1234.ts.net" } }),
    ).toBe("https://studio.tail1234.ts.net");
    expect(sendingOrigin({ rpId: "studio-mac.local", tls })).toBe("https://studio-mac.local:7373");
  });
  it("is null when TLS is off and nothing else is known, or the rp id matches no origin", () => {
    expect(sendingOrigin({ rpId: "localhost", tls: { ...tls, on: false } })).toBeNull();
    expect(sendingOrigin({ rpId: "other.local", tls })).toBeNull();
    expect(sendingOrigin({ origins: ["not a url"], rpId: "x" })).toBeNull();
  });
});

describe("wrongOrigin", () => {
  const target = "https://studio-mac.local:7373";
  const origins = [target];
  const at = (origin: string) => ({ origin, hostname: new URL(origin).hostname });
  it("points http://localhost at the https origin when the rp id is the .local name", () => {
    expect(wrongOrigin(at("http://localhost:7373"), "studio-mac.local", origins, target)).toBe(target);
    expect(wrongOrigin(at("http://192.168.1.20:7373"), "studio-mac.local", origins, target)).toBe(target);
    // The right host over the wrong scheme is still the wrong origin.
    expect(wrongOrigin(at("http://studio-mac.local:7373"), "studio-mac.local", origins, target)).toBe(target);
  });
  it("is quiet on a listed origin, under the rp id when no list is known, or with nowhere to point", () => {
    expect(wrongOrigin(at(target), "studio-mac.local", origins, target)).toBeNull();
    expect(wrongOrigin(at("https://studio-mac.local:7373"), "studio-mac.local", undefined, target)).toBeNull();
    expect(wrongOrigin(at("https://localhost:7373"), "localhost", undefined, "https://localhost:7373")).toBeNull();
    expect(wrongOrigin(at("http://localhost:7373"), "studio-mac.local", origins, null)).toBeNull();
  });
  it("never points a page on another host at a loopback origin", () => {
    const local = "http://localhost:7373";
    expect(wrongOrigin(at("http://192.168.1.20:7373"), "localhost", [local], local)).toBeNull();
    expect(wrongOrigin(at("http://studio-mac.local:7373"), "localhost", [local], local)).toBeNull();
    // On the machine itself, 127.0.0.1 is still pointed at the rp id's localhost.
    expect(wrongOrigin(at("http://127.0.0.1:7373"), "localhost", [local], local)).toBe(local);
  });
  it("words the one line with the address", () => {
    expect(wrongOriginWords(target)).toBe("Sending works from https://studio-mac.local:7373; open it there.");
  });
});
