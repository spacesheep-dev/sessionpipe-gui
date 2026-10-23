// SPDX-License-Identifier: Apache-2.0
// Hostile requests the router meets before any route's guard runs: a bad percent escape
// in the path or a cookie must be a 4xx for that request, never a crash of the process or
// a 500 for every later request from the same browser.
import { createServer, type Server } from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "./router.js";

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function serve(r: Router): Promise<number> {
  server = createServer((req, res) => void r.handle(req, res));
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  return (server.address() as { port: number }).port;
}

/** A raw request, so the path reaches the server exactly as written. */
function raw(port: number, lines: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`${lines.join("\r\n")}\r\n\r\n`));
    let out = "";
    s.on("data", (c) => {
      out += c.toString();
    });
    s.on("end", () => ok(out));
    s.on("error", fail);
    s.setTimeout(2000, () => {
      s.destroy();
      ok(out);
    });
  });
}

describe("router: malformed input", () => {
  it("answers 400 to a path whose escape does not decode, and keeps serving", async () => {
    const r = new Router();
    r.get("/api/ui/sessions/:harness/:id", (ctx) => ({ status: 200, json: ctx.params }));
    r.get("/files/*rest", (ctx) => ({ status: 200, json: ctx.params }));
    const port = await serve(r);
    const bad = await raw(port, ["GET /api/ui/sessions/%E0%A4%A/x HTTP/1.1", "Host: x", "Connection: close"]);
    expect(bad).toMatch(/^HTTP\/1\.1 400/);
    const wild = await raw(port, ["GET /files/a/%zz HTTP/1.1", "Host: x", "Connection: close"]);
    expect(wild).toMatch(/^HTTP\/1\.1 400/);
    const ok = await fetch(`http://127.0.0.1:${port}/api/ui/sessions/claude-code/abc`);
    expect(await ok.json()).toEqual({ harness: "claude-code", id: "abc" });
  });

  it("reads a cookie it cannot decode as it is, instead of failing the request", async () => {
    const r = new Router();
    r.get("/c", (ctx) => ({ status: 200, json: ctx.cookies() }));
    const port = await serve(r);
    // Another app on the same host (cookies ignore the port) set a value with a stray %.
    const res = await fetch(`http://127.0.0.1:${port}/c`, { headers: { cookie: "other=%zz; spgui=k%20ey" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ other: "%zz", spgui: "k ey" });
  });
});
