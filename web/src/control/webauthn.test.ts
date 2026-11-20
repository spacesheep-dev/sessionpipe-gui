// SPDX-License-Identifier: Apache-2.0
// Where a phone's browser on the board's plain-http address is told the ways that work.
import "../native/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PHONE_HTTP_WORDS, plainHttpHere } from "./webauthn";

afterEach(() => {
  vi.unstubAllGlobals();
});

const at = (url: string, secure: boolean) => {
  vi.stubGlobal("location", new URL(url));
  vi.stubGlobal("isSecureContext", secure);
};

describe("plainHttpHere", () => {
  it("is a LAN or tailnet address over http, not this machine's own and not https", () => {
    at("http://192.0.2.10:7373/s/claude-code/x", false);
    expect(plainHttpHere()).toBe(true);
    at("http://studio-mac.example.com:7373/", false);
    expect(plainHttpHere()).toBe(true);
    for (const own of ["http://localhost:7373/", "http://127.0.0.1:7373/", "http://[::1]:7373/"]) {
      at(own, true);
      expect(plainHttpHere(), own).toBe(false);
    }
    at("https://studio-mac.local:7373/", true);
    expect(plainHttpHere()).toBe(false);
  });

  it("says the app, /connect and --tls in one sentence", () => {
    expect(PHONE_HTTP_WORDS).toBe(
      "To send from this phone, use the sessionpipe app (scan the code on /connect) or open this board over HTTPS (start it with --tls).",
    );
    expect(PHONE_HTTP_WORDS.split("/connect")).toHaveLength(2);
  });
});
