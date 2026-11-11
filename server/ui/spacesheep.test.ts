// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES } from "../../shared/api.js";
import type { Ctx, Handler, Reply, Router } from "../http/router.js";
import { cleanOrigin, registerSpacesheepUi, type SpacesheepUiDeps } from "./spacesheep.js";

/** A router that only remembers its handlers. */
function fakeRouter(): { router: Router; call: (method: string, body?: unknown) => Promise<Reply> } {
  const handlers = new Map<string, Handler>();
  const router = {
    get: (p: string, h: Handler) => handlers.set(`GET ${p}`, h),
    post: (p: string, h: Handler) => handlers.set(`POST ${p}`, h),
    add: (m: string, p: string, h: Handler) => handlers.set(`${m} ${p}`, h),
  } as unknown as Router;
  const call = async (method: string, body?: unknown): Promise<Reply> => {
    const h = handlers.get(`${method} ${ROUTES.ui.spacesheep}`);
    if (!h) throw new Error(`no ${method}`);
    const ctx = {
      json: async () => body ?? {},
      req: { headers: {} },
      remote: { ip: "127.0.0.1", loopback: true, forwarded: false },
    } as unknown as Ctx;
    return (await h(ctx)) as Reply;
  };
  return { router, call };
}

describe("the spacesheep connect flow on the GUI side (ui/spacesheep.ts)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("takes only an https origin (or a local dev server), defaulting to spacesheep.dev", () => {
    expect(cleanOrigin(undefined)).toBe("https://spacesheep.dev");
    expect(cleanOrigin("https://staging.spacesheep.dev/")).toBe("https://staging.spacesheep.dev");
    expect(cleanOrigin("http://localhost:8791")).toBe("http://localhost:8791");
    expect(cleanOrigin("http://evil.example")).toBeNull();
    expect(cleanOrigin(42)).toBeNull();
  });

  it("starts a connect, polls until the person confirms, then keeps the key", async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetchStub = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/gui/connect")) {
        expect(JSON.parse(String(init?.body))).toEqual({ device: "studio-mac", version: "0.7.4" });
        return new Response(
          JSON.stringify({
            code: "c".repeat(24),
            digits: "4821",
            url: "https://spacesheep.dev/connect/gui?code=x",
            poll_token: "t",
            expires_at: "2026-11-03T13:00:00.000Z",
          }),
          { status: 201 },
        );
      }
      if (url.includes("/api/gui/connect/poll")) {
        expect(init?.headers).toMatchObject({ authorization: "Bearer t" });
        polls++;
        return polls < 2
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ state: "approved", key: "ss_abcdefghij", email: "me@x.co" }), {
              status: 200,
            });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    let link: SpacesheepUiDeps["link"] extends () => infer R ? R : never;
    const deps: SpacesheepUiDeps = {
      link: () => link,
      status: () =>
        link
          ? {
              origin: link.origin,
              email: link.email,
              connectedAt: link.connectedAt,
              events: 0,
              cursor: 0,
              state: "starting",
              machines: [],
            }
          : null,
      connect: (l) => {
        link = l;
      },
      disconnect: () => {
        link = undefined;
      },
      deviceName: () => "studio-mac",
      version: () => "0.7.4",
      fetch: fetchStub,
    };
    const { router, call } = fakeRouter();
    registerSpacesheepUi(router, deps, (h) => h);
    const started = await call("POST", {});
    expect(started.status).toBe(201);
    expect(started.json).toMatchObject({
      digits: "4821",
      url: "https://spacesheep.dev/connect/gui?code=x",
      state: "pending",
    });
    expect(JSON.stringify(started.json)).not.toContain('"pollToken"');
    // A second press while pending returns the same code, no new ask.
    expect((await call("POST", {})).status).toBe(200);
    expect(calls.filter((c) => c.endsWith("/api/gui/connect")).length).toBe(1);
    // Two polls: pending, then approved → the link is kept.
    await vi.advanceTimersByTimeAsync(2100);
    expect(polls).toBe(1);
    expect(link).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2100);
    expect(polls).toBe(2);
    expect(link).toMatchObject({ origin: "https://spacesheep.dev", key: "ss_abcdefghij", email: "me@x.co" });
    const got = await call("GET");
    expect(got.json).toMatchObject({ link: { email: "me@x.co" }, pending: { state: "approved" } });
    // Connected: another connect is refused; DELETE forgets.
    expect((await call("POST", {})).status).toBe(409);
    expect((await call("DELETE")).status).toBe(200);
    expect(link).toBeUndefined();
    expect((await call("GET")).json).toEqual({ link: null, pending: null });
  });

  it("says when spacesheep can't be reached, or refuses", async () => {
    const { router, call } = fakeRouter();
    registerSpacesheepUi(
      router,
      {
        link: () => undefined,
        status: () => null,
        connect: () => {},
        disconnect: () => {},
        deviceName: () => "m",
        version: () => "0",
        fetch: (async () => {
          throw new Error("ENOTFOUND");
        }) as unknown as typeof fetch,
      },
      (h) => h,
    );
    const r = await call("POST", { origin: "https://nowhere.example" });
    expect(r.status).toBe(502);
    expect(String((r.json as { error: string }).error)).toContain("ENOTFOUND");
    expect((await call("POST", { origin: "ftp://x" })).status).toBe(400);
  });
});
