// SPDX-License-Identifier: Apache-2.0
// --public-url: the GUI behind a trusted https proxy on this machine (Tailscale serve).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Info, ROUTES } from "../shared/api.js";
import { tempDir } from "../test/events.js";
import { type App, createApp, normalizePublicUrl } from "./app.js";

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

  it("without --public-url the same header is ignored", async () => {
    const a = await boot();
    const r = await fetch(`${a.url}${ROUTES.ui.info}`, { headers: { "x-forwarded-for": "100.64.0.7" } });
    expect(r.status).toBe(200);
    expect(a.info().remote).toBeUndefined();
  });
});
