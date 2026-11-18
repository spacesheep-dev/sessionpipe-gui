// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { lanAddresses } from "./net.js";
import { proxyEntry, Router } from "./router.js";

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
  /** One GET of /who with exactly these headers, to a server bound on `host`; a list sends
   *  the header once per value, as a proxy that adds a line of its own does. */
  async function probe(trust: boolean, headers: Record<string, string | string[]>, host = "127.0.0.1") {
    const r = new Router();
    r.trustProxy = () => trust;
    r.get("/who", (ctx) => ({ status: 200, json: ctx.remote }));
    const server = createServer((req, res) => void r.handle(req, res));
    await new Promise<void>((ok) => server.listen(0, host, ok));
    const port = (server.address() as { port: number }).port;
    try {
      return await new Promise<{ ip: string; loopback: boolean; forwarded: boolean }>((ok, no) => {
        import("node:http").then((http) =>
          http
            .get({ host, port, path: "/who", headers, agent: false }, (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () => ok(JSON.parse(Buffer.concat(chunks).toString())));
            })
            .on("error", no),
        );
      });
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  }

  it("ignores X-Forwarded-For unless the router trusts a proxy", async () => {
    const r = await probe(false, { "x-forwarded-for": "100.64.0.9" });
    expect(r).toMatchObject({ loopback: true, forwarded: false });
  });

  it("with a trusted proxy, a loopback connection is the address the proxy named: the last", async () => {
    expect(await probe(true, { "x-forwarded-for": "100.64.0.9" })).toEqual({
      ip: "100.64.0.9",
      loopback: false,
      forwarded: true,
    });
    // A proxy that appends leaves what the sender wrote in front of its own entry.
    for (const sent of ["10.0.0.1", "127.0.0.1", "::1", "localhost", "127.0.0.1, ::1, 10.0.0.1"])
      expect(await probe(true, { "x-forwarded-for": `${sent}, 203.0.113.9` })).toEqual({
        ip: "203.0.113.9",
        loopback: false,
        forwarded: true,
      });
    // A proxy that adds a header line of its own, after the sender's.
    expect(await probe(true, { "x-forwarded-for": ["127.0.0.1", "203.0.113.9"] })).toEqual({
      ip: "203.0.113.9",
      loopback: false,
      forwarded: true,
    });
  });

  it("a forwarded request is a visitor whatever address it names; no header stays loopback", async () => {
    // The proxy took this one from loopback: from this machine, or from another proxy in
    // front of it. The address does not say which.
    for (const named of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "203.0.113.9, 127.0.0.1"])
      expect(await probe(true, { "x-forwarded-for": named })).toMatchObject({ loopback: false, forwarded: true });
    // A header with no address in it is still a proxy's, and so is any other header a proxy
    // marks its requests with: the visitor then has the connection's own address.
    const marks: Record<string, string>[] = [
      { "x-forwarded-for": "" },
      { "x-forwarded-for": " , " },
      { forwarded: "for=203.0.113.9;proto=https" },
      { "x-real-ip": "203.0.113.9" },
      { "x-forwarded-proto": "https" },
      { "x-forwarded-host": "board.example" },
    ];
    for (const mark of marks)
      expect(await probe(true, mark)).toEqual({ ip: "127.0.0.1", loopback: false, forwarded: true });
    expect(await probe(true, {})).toMatchObject({ loopback: true, forwarded: false });
    // With no proxy to trust, none of them is read.
    expect(await probe(false, { forwarded: "for=203.0.113.9", "x-real-ip": "203.0.113.9" })).toMatchObject({
      loopback: true,
      forwarded: false,
    });
  });

  const lan = lanAddresses()[0];
  it.skipIf(!lan)("a proxy that reaches this server by one of the machine's own addresses is a proxy too", async () => {
    const own = lan as string;
    expect(await probe(true, { "x-forwarded-for": "127.0.0.1, 203.0.113.9" }, own)).toEqual({
      ip: "203.0.113.9",
      loopback: false,
      forwarded: true,
    });
    // The same connection with no header is a browser on this machine, as before; and
    // with no proxy to trust the header is not read.
    expect(await probe(true, {}, own)).toMatchObject({ loopback: false, forwarded: false });
    expect(await probe(false, { "x-forwarded-for": "203.0.113.9" }, own)).toMatchObject({ forwarded: false });
  });

  it("reads the proxy's entry out of the header", () => {
    expect(proxyEntry(undefined)).toBeUndefined();
    expect(proxyEntry("100.64.0.9")).toBe("100.64.0.9");
    expect(proxyEntry(" 127.0.0.1 ,203.0.113.9 ")).toBe("203.0.113.9");
    expect(proxyEntry("203.0.113.9, ")).toBe("203.0.113.9");
    expect(proxyEntry(["127.0.0.1", "10.0.0.1, 203.0.113.9"])).toBe("203.0.113.9");
    expect(proxyEntry("http, https")).toBe("https");
    expect(proxyEntry("")).toBeUndefined();
    expect(proxyEntry([])).toBeUndefined();
  });
});
