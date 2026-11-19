// SPDX-License-Identifier: Apache-2.0
// --public-url: the GUI behind a trusted https proxy on this machine (Tailscale serve).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Info, ROUTES } from "../shared/api.js";
import { tempDir } from "../test/events.js";
import { type App, createApp, normalizePublicUrl } from "./app.js";
import { lanAddresses } from "./http/net.js";

const PUBLIC = "https://laptop.tail1234.ts.net";
let app: App | null = null;
let tmp: { dir: string; cleanup: () => void } | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
  tmp?.cleanup();
  tmp = null;
});

async function boot(publicUrl?: string | null, dir?: string): Promise<App> {
  if (!dir) {
    tmp = tempDir();
    dir = tmp.dir;
  }
  const web = path.join(dir, "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>t</title>");
  app = await createApp({ port: 0, stateDir: dir, outbox: false, quiet: true, webDir: web, publicUrl });
  return app;
}

describe("normalizePublicUrl", () => {
  it("keeps an https origin and refuses the rest", () => {
    expect(normalizePublicUrl(" https://laptop.tail1234.ts.net/ ")).toBe(PUBLIC);
    expect(normalizePublicUrl("https://laptop.tail1234.ts.net:8443")).toBe("https://laptop.tail1234.ts.net:8443");
    expect(() => normalizePublicUrl("http://laptop.tail1234.ts.net")).toThrow(/https/);
    expect(() => normalizePublicUrl("https://laptop.tail1234.ts.net/gui")).toThrow(/origin/);
    expect(() => normalizePublicUrl("https://u:p@laptop.tail1234.ts.net")).toThrow(/credentials/);
    expect(() => normalizePublicUrl("laptop")).toThrow(/not a url/);
  });
});

describe("--public-url", () => {
  it("sets the rp id and Info.remote, is remembered, and is forgotten with null", async () => {
    const a = await boot(`${PUBLIC}/`);
    const dir = a.stateDir;
    expect(a.rpId).toBe("laptop.tail1234.ts.net");
    const info = a.info();
    expect(info.control.origins).toEqual([PUBLIC]);
    expect(info.urls.public).toBe(PUBLIC);
    expect(info.remote).toEqual({
      url: PUBLIC,
      host: "laptop.tail1234.ts.net",
      sinkCommand: `sessionpipe sink add ${PUBLIC} --tier 3 --token ${info.sinkToken}`,
      connectCommand: `sessionpipe connect ${PUBLIC}`,
    });
    expect(JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8")).publicUrl).toBe(PUBLIC);
    await a.close();
    app = null;

    // A plain start keeps it.
    const b = await boot(undefined, dir);
    expect(b.info().remote?.url).toBe(PUBLIC);
    // At runtime: off, then on again (the setup page's two buttons).
    b.setPublicUrl(undefined);
    expect(b.info().remote).toBeUndefined();
    expect(b.rpId).toBe("localhost");
    expect(JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8")).publicUrl).toBeUndefined();
    b.setPublicUrl("https://other.example.net");
    expect(b.rpId).toBe("other.example.net");
    expect(() => b.setPublicUrl("http://nope")).toThrow(/https/);
    await b.close();
    app = null;

    const c = await boot(null, dir);
    expect(c.info().remote).toBeUndefined();
  });

  it("trusts the proxy's X-Forwarded-For: a forwarded visitor needs the UI key, loopback itself does not", async () => {
    const a = await boot(PUBLIC);
    const url = `${a.url}${ROUTES.ui.info}`;
    const forwarded = {
      "x-forwarded-for": "100.64.0.7",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "laptop.tail1234.ts.net",
    };
    expect((await fetch(url, { headers: forwarded })).status).toBe(401);
    const withKey = await fetch(`${url}?k=${a.config().uiKey}`, { headers: forwarded });
    expect(withKey.status).toBe(200);
    expect(((await withKey.json()) as Info).remote?.url).toBe(PUBLIC);
    expect((await fetch(url)).status).toBe(200);
    // A LAN-only route (the setup actions) refuses a forwarded visitor too.
    const setup = await fetch(`${a.url}${ROUTES.ui.setup}/remote/off`, { method: "POST", headers: forwarded });
    expect(setup.status).toBe(403);
  });

  it("takes the proxy's own entry as the visitor: what the sender wrote before it counts for nothing", async () => {
    const a = await boot(PUBLIC);
    const key = a.config().uiKey;
    const via = (xff: string) => ({
      "x-forwarded-for": xff,
      "x-forwarded-proto": "https",
      "x-forwarded-host": "laptop.tail1234.ts.net",
    });
    // A proxy that appends leaves the sender's own entries in front of the address it saw.
    for (const sent of ["127.0.0.1", "::1", "localhost", "127.0.0.1, ::1"]) {
      const headers = via(`${sent}, 203.0.113.9`);
      const r = await fetch(`${a.url}${ROUTES.ui.info}`, { headers });
      expect(`${sent} ${r.status}`).toBe(`${sent} 401`);
      expect(await r.text()).not.toContain(key);
      expect((await fetch(`${a.url}${ROUTES.ui.snapshot}`, { headers })).status).toBe(401);
      expect((await fetch(`${a.url}/`, { headers })).status).toBe(401);
      // With the key it is a visitor like any other: let in, and still not this machine.
      expect((await fetch(`${a.url}${ROUTES.ui.info}?k=${key}`, { headers })).status).toBe(200);
      const rotate = await fetch(`${a.url}${ROUTES.ui.rotateToken}?k=${key}`, { method: "POST", headers });
      expect(rotate.status).toBe(403);
      const setup = await fetch(`${a.url}${ROUTES.ui.setup}/remote/off?k=${key}`, { method: "POST", headers });
      expect(setup.status).toBe(403);
    }
    expect(a.publicUrl).toBe(PUBLIC);
  });

  it("a request the proxy forwarded is never this machine, whatever address the proxy names for it", async () => {
    const a = await boot(PUBLIC);
    const key = a.config().uiKey;
    const token = a.config().sinkToken;
    // The proxy took the connection from loopback or from one of this machine's own
    // addresses: from a browser here, or from another proxy in front of it.
    for (const named of ["127.0.0.1", "::1", "::ffff:127.0.0.1", ...lanAddresses().slice(0, 1)]) {
      const headers = { "x-forwarded-for": named, "x-forwarded-proto": "https" };
      const r = await fetch(`${a.url}${ROUTES.ui.info}`, { headers });
      expect(`${named} ${r.status}`).toBe(`${named} 401`);
      expect((await fetch(`${a.url}${ROUTES.ui.info}?k=${key}`, { headers })).status).toBe(200);
      // The routes that act on this machine, and the ones only loopback may call.
      const status = await fetch(`${a.url}${ROUTES.ui.setup}/status?k=${key}`, { headers });
      expect(`${named} ${status.status}`).toBe(`${named} 403`);
      expect(((await status.json()) as { reason: string }).reason).toBe("local_only");
      const off = await fetch(`${a.url}${ROUTES.ui.setup}/remote/off?k=${key}`, { method: "POST", headers });
      expect(off.status).toBe(403);
      const rotate = await fetch(`${a.url}${ROUTES.ui.rotateToken}?k=${key}`, { method: "POST", headers });
      expect(rotate.status).toBe(403);
      const reindex = await fetch(`${a.url}${ROUTES.ui.searchReindex}?k=${key}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      });
      expect(reindex.status).toBe(403);
    }
    expect(a.publicUrl).toBe(PUBLIC);
    expect(a.config().sinkToken).toBe(token);
    // No header: the connection is this machine's own, as before.
    expect((await fetch(`${a.url}${ROUTES.ui.info}`)).status).toBe(200);
    const rotated = await fetch(`${a.url}${ROUTES.ui.rotateToken}`, { method: "POST" });
    expect(rotated.status).toBe(200);
  });

  const lan = lanAddresses()[0];
  it.skipIf(!lan)("a proxy that reaches the server by the machine's own address is a proxy too", async () => {
    const a = await boot(PUBLIC);
    const key = a.config().uiKey;
    const base = `http://${lan}:${a.port}`;
    const headers = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };
    // The routes that act on this machine take this machine's own addresses for it; a
    // visitor the proxy forwarded from one of them is not it.
    const status = await fetch(`${base}${ROUTES.ui.setup}/status`, { headers });
    expect(status.status).toBe(403);
    expect(await status.text()).not.toContain(key);
    const off = await fetch(`${base}${ROUTES.ui.setup}/remote/off?k=${key}`, { method: "POST", headers });
    expect(off.status).toBe(403);
    expect(a.publicUrl).toBe(PUBLIC);
    // It is a visitor like any other: in with the key, and what it names is not read as its own.
    expect((await fetch(`${base}${ROUTES.ui.info}`, { headers })).status).toBe(401);
    expect((await fetch(`${base}${ROUTES.ui.info}?k=${key}`, { headers })).status).toBe(200);
  });

  it("a request that carries any other mark of a proxy, and no X-Forwarded-For, is a visitor too", async () => {
    const a = await boot(PUBLIC);
    const key = a.config().uiKey;
    for (const headers of [
      { forwarded: "for=203.0.113.9;proto=https;host=laptop.tail1234.ts.net" },
      { "x-real-ip": "203.0.113.9" },
      { "x-forwarded-host": "laptop.tail1234.ts.net", "x-forwarded-proto": "https" },
    ] as Record<string, string>[]) {
      const r = await fetch(`${a.url}${ROUTES.ui.info}`, { headers });
      expect(`${Object.keys(headers)[0]} ${r.status}`).toBe(`${Object.keys(headers)[0]} 401`);
      expect((await fetch(`${a.url}${ROUTES.ui.info}?k=${key}`, { headers })).status).toBe(200);
      const off = await fetch(`${a.url}${ROUTES.ui.setup}/remote/off?k=${key}`, { method: "POST", headers });
      expect(off.status).toBe(403);
    }
    expect(a.publicUrl).toBe(PUBLIC);
  });

  it("without --public-url the same header is ignored", async () => {
    const a = await boot();
    const r = await fetch(`${a.url}${ROUTES.ui.info}`, { headers: { "x-forwarded-for": "100.64.0.7" } });
    expect(r.status).toBe(200);
    expect(a.info().remote).toBeUndefined();
  });
});
