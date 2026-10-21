// SPDX-License-Identifier: Apache-2.0
// TLS mode: certificates into a temp dir (skipped with a message when openssl is
// missing), the SAN set and its re-issue on a new address, one port answering both
// protocols, /ca.crt and /trust, Info.tls, the rp id switch and the --no-tls preference.
import { X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Info, ROUTES, UI_KEY_COOKIE } from "../../shared/api.js";
import { tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { readGuiConfig, setTlsPreference } from "../config.js";
import { certSans, ensureCerts, localHostname, opensslAvailable, readCerts, resetCerts, sanSet } from "./certs.js";
import { CA_CONTENT_TYPE } from "./trust.js";

const HAVE_OPENSSL = opensslAvailable();
if (!HAVE_OPENSSL) process.stderr.write("[tls.test] openssl is not on the PATH: TLS tests are skipped\n");

const get = (
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
  new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    mod
      .get(url, { rejectUnauthorized: false, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      })
      .on("error", reject);
  });

describe("hostname and SAN set", () => {
  it("lowercases the hostname, strips a .local suffix and appends one", () => {
    expect(localHostname("Build-Box.local")).toBe("build-box.local");
    expect(localHostname("box")).toBe("box.local");
    expect(localHostname("my box.local.")).toBe("my-box.local");
    expect(localHostname("")).toBe("sessionpipe-gui.local");
  });
  it("is the name, localhost, loopback and every IPv4 given, once each", () => {
    expect(sanSet("Box.local", ["192.168.1.9", "10.0.0.2", "192.168.1.9", "fe80::1"])).toEqual([
      "DNS:box.local",
      "DNS:localhost",
      "IP:127.0.0.1",
      "IP:192.168.1.9",
      "IP:10.0.0.2",
    ]);
  });
});

describe.skipIf(!HAVE_OPENSSL)("certificates", () => {
  let tmp: { dir: string; cleanup: () => void };
  beforeAll(() => {
    tmp = tempDir("spgui-tls-");
  });
  afterAll(() => tmp.cleanup());

  it("makes a CA and a server certificate, 0600 in a 0700 dir, with the SAN set", () => {
    const dir = path.join(tmp.dir, "a");
    const m = ensureCerts(dir, { hostname: "Test-Box.local", addresses: ["10.0.0.5"] });
    expect(m.made).toBe("all");
    expect(m.hostname).toBe("test-box.local");
    expect(m.sans).toEqual(["DNS:test-box.local", "DNS:localhost", "IP:127.0.0.1", "IP:10.0.0.5"]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of [m.caKeyPath, m.caCertPath, m.serverKeyPath, m.serverCertPath]) {
      expect(statSync(f).mode & 0o777).toBe(0o600);
    }
    expect(m.caCert).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(m.key).toMatch(/PRIVATE KEY-----/);
    expect(m.caFingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const ca = new X509Certificate(m.caCert);
    expect(ca.subject).toContain("CN=sessionpipe-gui local CA · test-box.local");
    expect(ca.ca).toBe(true);
    const leaf = new X509Certificate(m.cert);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.checkHost("test-box.local")).toBe("test-box.local");
    expect(leaf.checkIP("10.0.0.5")).toBe("10.0.0.5");
    const caDays = (new Date(ca.validTo).getTime() - Date.now()) / 86_400_000;
    const leafDays = (new Date(leaf.validTo).getTime() - Date.now()) / 86_400_000;
    expect(caDays).toBeGreaterThan(3600);
    expect(leafDays).toBeGreaterThan(820);
    expect(leafDays).toBeLessThanOrEqual(826);
    // No scratch files left behind.
    expect(readFileSync(m.caCertPath, "utf8")).toBe(m.caCert);
    expect(readCerts(dir)?.sans).toEqual(m.sans);
  });

  it("keeps everything when nothing changed, re-issues only the server certificate for a new address", () => {
    const dir = path.join(tmp.dir, "b");
    const first = ensureCerts(dir, { hostname: "box.local", addresses: ["10.0.0.5"] });
    const again = ensureCerts(dir, { hostname: "box.local", addresses: ["10.0.0.5"] });
    expect(again.made).toBe("nothing");
    expect(again.serverFingerprint).toBe(first.serverFingerprint);
    const moved = ensureCerts(dir, { hostname: "box.local", addresses: ["10.0.0.5", "192.168.7.3"] });
    expect(moved.made).toBe("server");
    expect(moved.caFingerprint).toBe(first.caFingerprint);
    expect(moved.serverFingerprint).not.toBe(first.serverFingerprint);
    expect(certSans(moved.cert)).toContain("IP:192.168.7.3");
    // Near expiry, the server certificate is re-issued too.
    const soon = ensureCerts(dir, {
      hostname: "box.local",
      addresses: ["10.0.0.5", "192.168.7.3"],
      now: () => Date.now() + 800 * 86_400_000,
    });
    expect(soon.made).toBe("server");
    expect(soon.caFingerprint).toBe(first.caFingerprint);
    expect(resetCerts(dir)).toBe(true);
    expect(readCerts(dir)).toBeNull();
    expect(resetCerts(dir)).toBe(false);
  });
});

describe.skipIf(!HAVE_OPENSSL)("TLS mode in the app", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  let base: string;
  let sbase: string;
  beforeAll(async () => {
    tmp = tempDir("spgui-tls-app-");
    const web = path.join(tmp.dir, "web");
    mkdirSync(web, { recursive: true });
    writeFileSync(path.join(web, "index.html"), "<!doctype html><title>board</title>");
    app = await createApp({
      port: 0,
      stateDir: tmp.dir,
      outbox: false,
      quiet: true,
      webDir: web,
      tls: true,
      tlsHostname: "test-box.local",
    });
    base = `http://127.0.0.1:${app.port}`;
    sbase = `https://127.0.0.1:${app.port}`;
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  it("answers http and https on the same port", async () => {
    const plain = await get(`${base}${ROUTES.ui.info}`);
    const secure = await get(`${sbase}${ROUTES.ui.info}`);
    expect(plain.status).toBe(200);
    expect(secure.status).toBe(200);
    expect(JSON.parse(plain.body).port).toBe(app.port);
    expect(JSON.parse(secure.body).port).toBe(app.port);
    expect(app.listener).not.toBe(app.server);
    expect(app.httpsServer).not.toBeNull();
  });

  it("Info.tls and the well-known carry the .local rp id and the https url", async () => {
    const info = JSON.parse((await get(`${base}${ROUTES.ui.info}`)).body) as Info;
    expect(info.control.rpId).toBe("test-box.local");
    expect(info.control.origins).toEqual([`https://test-box.local:${app.port}`]);
    expect(info.urls.https).toBe(`https://test-box.local:${app.port}`);
    expect(info.tls).toMatchObject({
      on: true,
      hostname: "test-box.local",
      httpsUrl: `https://test-box.local:${app.port}`,
      caFingerprint: app.tls!.caFingerprint,
    });
    expect(info.tls!.caUrl).toMatch(new RegExp(`^http://[\\d.]+:${app.port}/ca\\.crt$`));
    expect(info.tls!.expiresAt).toBe(app.tls!.serverExpiresAt);
    const wk = JSON.parse((await get(`${sbase}${ROUTES.wellKnown}`)).body) as {
      control: { signing: { rp_id: string } };
    };
    expect(wk.control.signing.rp_id).toBe("test-box.local");
  });

  it("serves the CA as a download with the right headers, and the fingerprint matches", async () => {
    const r = await get(`${base}${ROUTES.caCert}`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe(CA_CONTENT_TYPE);
    expect(r.headers["content-disposition"]).toBe('attachment; filename="sessionpipe-gui-test-box.crt"');
    expect(r.body).toBe(app.tls!.caCert);
    expect(new X509Certificate(r.body).fingerprint256).toBe(app.tls!.caFingerprint);
  });

  it("the trust page has the steps, the fingerprint and the https button; sets the cookie from ?k=", async () => {
    const r = await get(`${base}${ROUTES.trust}`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/html/);
    expect(r.body).toContain("Passkeys from this phone");
    expect(r.body).toContain(app.tls!.caFingerprint);
    expect(r.body).toContain("Certificate Trust Settings");
    expect(r.body).toContain("Install a certificate");
    expect(r.body).toContain("sessionpipe-gui tls trust");
    expect(r.body).toContain("update-ca-certificates");
    expect(r.body).toContain(`https://test-box.local:${app.port}/`);
    expect(r.body).toContain('href="/ca.crt"'); // loopback: no key in the links
    expect(r.body).toContain("prefers-color-scheme");
    // Over https, the page knows it is already on the secure origin.
    const s = await get(`${sbase}${ROUTES.trust}`);
    expect(s.body).toContain("Passkeys are available here");
    expect(s.body).not.toContain("Profile Downloaded");
    // ?k= with the key sets the cookie (a phone arrives here from the QR code).
    const key = app.config().uiKey;
    const keyed = await get(`${base}${ROUTES.trust}?k=${encodeURIComponent(key)}`);
    expect(keyed.headers["set-cookie"]?.[0]).toMatch(
      new RegExp(`^${UI_KEY_COOKIE}=${encodeURIComponent(key)}; Path=/`),
    );
    expect((await get(`${base}${ROUTES.trust}?k=nope`)).headers["set-cookie"]).toBeUndefined();
  });

  it("--rp-id still wins over the hostname", async () => {
    const other = await createApp({
      port: 0,
      stateDir: path.join(tmp.dir, "other"),
      outbox: false,
      quiet: true,
      tls: true,
      tlsHostname: "test-box.local",
      rpId: "localhost",
    });
    try {
      const info = JSON.parse((await get(`https://127.0.0.1:${other.port}${ROUTES.ui.info}`)).body) as Info;
      expect(info.control.rpId).toBe("localhost");
      expect(info.tls?.hostname).toBe("test-box.local");
    } finally {
      await other.close();
    }
  });
});

describe("TLS mode off", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  beforeAll(async () => {
    tmp = tempDir("spgui-tls-off-");
    app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true });
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  it("has no tls in Info, no CA to download, and a trust page that says how to turn it on", async () => {
    const info = JSON.parse((await get(`${app.url}${ROUTES.ui.info}`)).body) as Info;
    expect(info.tls).toBeUndefined();
    expect(info.urls.https).toBeUndefined();
    expect(info.control.rpId).toBe("localhost");
    expect(app.httpsServer).toBeNull();
    expect((await get(`${app.url}${ROUTES.caCert}`)).status).toBe(404);
    const t = await get(`${app.url}${ROUTES.trust}`);
    expect(t.status).toBe(200);
    expect(t.body).toContain("TLS mode is off");
    expect(t.body).toContain("sessionpipe-gui --tls");
  });

  it("--tls / --no-tls persist in config.json and survive a re-read", () => {
    const dir = path.join(tmp.dir, "pref");
    const cfg = readGuiConfig(dir);
    expect(cfg.tls).toBeUndefined();
    const on = setTlsPreference(dir, cfg, true);
    expect(on.tls).toBe(true);
    expect(readGuiConfig(dir).tls).toBe(true);
    expect(readGuiConfig(dir).sinkToken).toBe(cfg.sinkToken);
    const off = setTlsPreference(dir, on, false);
    expect(off.tls).toBe(false);
    expect(readGuiConfig(dir)).toMatchObject({ tls: false, uiKey: cfg.uiKey });
    expect(JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8")).tls).toBe(false);
  });
});
