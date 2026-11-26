// SPDX-License-Identifier: Apache-2.0
// The secrets a caller brings are held to the server's in constant time: the sink token on
// the events endpoint, the UI key as `?k=` or the cookie, and the `?k=` that sets the cookie.
// `===` stops at the first byte that differs, so a guess's timing says how much of it was
// right; every one of these doors goes through secretEquals instead.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ n: 0 }));
vi.mock("./secret.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./secret.js")>();
  return {
    ...real,
    secretEquals: (a: string | undefined | null, b: string) => {
      calls.n++;
      return real.secretEquals(a, b);
    },
  };
});

const { secretEquals } = await import("./secret.js");
const { Router } = await import("./router.js");
const { registerReceiver } = await import("../receiver/index.js");
const { uiAuth } = await import("../ui/auth.js");
const { staticFiles } = await import("../static.js");

const TOKEN = "st_0123456789abcdefghijklmnopqrstuv";
const KEY = "uk_abcdefghijklmnopqrstuvwxyz012345";

describe("secretEquals", () => {
  it("matches the same secret only", () => {
    expect(secretEquals(TOKEN, TOKEN)).toBe(true);
    expect(secretEquals(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(secretEquals(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(secretEquals(TOKEN.toUpperCase(), TOKEN)).toBe(false);
  });
  it("never matches an empty or a missing secret, on either side", () => {
    expect(secretEquals("", "")).toBe(false);
    expect(secretEquals(undefined, "")).toBe(false);
    expect(secretEquals(null, "")).toBe(false);
    expect(secretEquals("", TOKEN)).toBe(false);
    expect(secretEquals(TOKEN, "")).toBe(false);
    expect(secretEquals(undefined, TOKEN)).toBe(false);
  });
});

const ctxWith = (o: { url?: string; cookie?: string; thisComputer?: boolean } = {}) =>
  ({
    url: new URL(o.url ?? "http://local/"),
    remote: { ip: "10.0.0.9", loopback: false, forwarded: false, thisComputer: o.thisComputer ?? false },
    cookies: () => (o.cookie === undefined ? {} : { spgui: o.cookie }),
    req: { method: "GET", headers: {} },
  }) as unknown as Parameters<typeof uiAuth>[0];

describe("the UI key", () => {
  beforeEach(() => {
    calls.n = 0;
  });

  it("is compared in constant time, as ?k= and as the cookie", () => {
    expect(uiAuth(ctxWith({ url: `http://local/?k=${KEY}` }), KEY)).toBe(true);
    expect(calls.n).toBeGreaterThan(0);
    calls.n = 0;
    expect(uiAuth(ctxWith({ cookie: KEY }), KEY)).toBe(true);
    expect(calls.n).toBeGreaterThan(0);
  });

  it("opens nothing for a prefix, a longer guess or nothing at all", () => {
    expect(uiAuth(ctxWith({ url: `http://local/?k=${KEY.slice(0, 8)}` }), KEY)).toBe(false);
    expect(uiAuth(ctxWith({ cookie: `${KEY}0` }), KEY)).toBe(false);
    expect(uiAuth(ctxWith(), KEY)).toBe(false);
    expect(uiAuth(ctxWith({ url: "http://local/?k=" }), "")).toBe(false);
  });

  it("sets the cookie from ?k= only for the key, compared in constant time", () => {
    const serve = staticFiles("/nowhere", { uiAuth: () => false, uiKey: () => KEY });
    const right = serve(ctxWith({ url: `http://local/sessions?k=${KEY}` }) as never) as { status: number };
    expect(right.status).toBe(302);
    expect(calls.n).toBeGreaterThan(0);
    const wrong = serve(ctxWith({ url: `http://local/sessions?k=${KEY.slice(0, -1)}` }) as never) as {
      status: number;
    };
    expect(wrong.status).toBe(401);
  });

  it("with no key, an empty ?k= sets no cookie", () => {
    const serve = staticFiles("/nowhere", { uiAuth: () => false, uiKey: () => "" });
    const r = serve(ctxWith({ url: "http://local/?k=" }) as never) as {
      status: number;
      headers?: Record<string, string>;
    };
    expect(r.status).toBe(401);
    expect(r.headers?.["set-cookie"]).toBeUndefined();
  });
});

describe("the sink token on the events endpoint", () => {
  let server: http.Server;
  let port = 0;
  const ingest = vi.fn(() => ({ accepted: 0, duplicates: 0, rejected: [] }));

  beforeEach(async () => {
    calls.n = 0;
    ingest.mockClear();
    const router = new Router();
    registerReceiver(router, {
      store: { ingest } as never,
      sinkToken: () => TOKEN,
      control: { wellKnown: () => ({}) } as never,
    });
    server = http.createServer((q, s) => void router.handle(q, s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const post = (bearer?: string) =>
    fetch(`http://127.0.0.1:${port}/api/sessionpipe/v1/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body: JSON.stringify({ events: [{}] }),
    });

  it("is compared in constant time", async () => {
    const r = await post(TOKEN);
    expect(r.status).toBe(202);
    expect(calls.n).toBeGreaterThan(0);
  });

  it("refuses a prefix, a longer guess, the wrong case and none, before reading a batch", async () => {
    for (const guess of [TOKEN.slice(0, 10), `${TOKEN}0`, TOKEN.toUpperCase(), undefined]) {
      const r = await post(guess);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect(ingest).not.toHaveBeenCalled();
  });
});
