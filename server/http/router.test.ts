// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { Router } from "./router.js";

describe("Router", () => {
  it("matches params and wildcards", () => {
    const r = new Router();
    r.get("/api/ui/sessions/:harness/:id", () => ({ status: 200 }));
    r.get("/static/*path", () => ({ status: 200 }));
    expect(r.match("GET", "/api/ui/sessions/claude-code/abc")?.params).toEqual({ harness: "claude-code", id: "abc" });
    expect(r.match("GET", "/static/a/b.js")?.params).toEqual({ path: "a/b.js" });
    expect(r.match("POST", "/api/ui/sessions/x/y")).toMatchObject({ params: {} });
    expect(r.match("GET", "/nope")).toBeNull();
  });
});

import { createServer } from "node:http";
import { gunzipSync, gzipSync } from "node:zlib";

describe("gzip", () => {
  it("compresses large JSON when the client accepts it, and not otherwise", async () => {
    const r = new Router();
    const big = { rows: Array.from({ length: 200 }, (_, i) => ({ i, text: "x".repeat(50) })) };
    r.get("/big", () => ({ status: 200, json: big }));
    const server = createServer((req, res) => void r.handle(req, res));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    const gz = await fetch(`http://127.0.0.1:${port}/big`, { headers: { "accept-encoding": "gzip" } });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(await gz.json()).toEqual(big);
    const raw = await new Promise<{ enc: string | undefined; body: Buffer }>((ok) => {
      import("node:http").then((http) =>
        http.get({ host: "127.0.0.1", port, path: "/big", headers: { "accept-encoding": "identity" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => ok({ enc: res.headers["content-encoding"], body: Buffer.concat(chunks) }));
        }),
      );
    });
    expect(raw.enc).toBeUndefined();
    expect(JSON.parse(raw.body.toString())).toEqual(big);
    expect(gunzipSync(gzipSync(Buffer.from("x"))).toString()).toBe("x");
    server.close();
  });
});

describe("trusted proxy", () => {
  async function probe(trust: boolean, headers: Record<string, string>) {
    const r = new Router();
    r.trustProxy = () => trust;
    r.get("/who", (ctx) => ({ status: 200, json: ctx.remote }));
    const server = createServer((req, res) => void r.handle(req, res));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    try {
      return (await (await fetch(`http://127.0.0.1:${port}/who`, { headers })).json()) as {
        ip: string;
        loopback: boolean;
        forwarded: boolean;
      };
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  }

  it("ignores X-Forwarded-For unless the router trusts a proxy", async () => {
    const r = await probe(false, { "x-forwarded-for": "100.64.0.9" });
    expect(r).toMatchObject({ loopback: true, forwarded: false });
  });

  it("with a trusted proxy, a loopback connection is the first forwarded address", async () => {
    const r = await probe(true, { "x-forwarded-for": "100.64.0.9, 10.0.0.1" });
    expect(r).toEqual({ ip: "100.64.0.9", loopback: false, forwarded: true });
  });

  it("a forwarded loopback address stays this machine; no header stays loopback", async () => {
    expect(await probe(true, { "x-forwarded-for": "127.0.0.1" })).toMatchObject({ loopback: true, forwarded: false });
    expect(await probe(true, {})).toMatchObject({ loopback: true, forwarded: false });
  });
});
