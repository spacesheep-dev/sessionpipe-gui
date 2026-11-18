// SPDX-License-Identifier: Apache-2.0
// The router's guard (guard.ts): its readings of Host, Origin and Sec-Fetch-Site by
// themselves, then a whole app with every route it registers. Requests are written by
// hand over node:http, since what matters here is exactly which headers a caller sends: a
// page of another origin, the board's own page, the native shell, a sink, a daemon, this
// package's own CLI, and a page under a name that is not this machine's.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROUTES } from "../../shared/api.js";
import { Session, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { localHostname } from "../tls/certs.js";
import { checkRequest, fromAnotherOrigin, type GuardRequest, hostName, knownHost } from "./guard.js";
import { Router } from "./router.js";

const fake = (headers: Record<string, string>, o: Partial<GuardRequest> & { method?: string; from?: string } = {}) =>
  ({
    req: {
      method: o.method ?? "GET",
      headers,
      socket: { remoteAddress: o.from ?? "127.0.0.1", localPort: 7373 },
    } as unknown as IncomingMessage,
    pathname: o.pathname ?? "/api/ui/info",
    forwarded: o.forwarded ?? false,
    route: o.route ?? {},
  }) satisfies GuardRequest;

describe("the guard's readings", () => {
  it("reads the name out of a Host header as a URL would", () => {
    expect(hostName("Studio.local:7373")).toBe("studio.local");
    expect(hostName("localhost")).toBe("localhost");
    expect(hostName("[::1]:7373")).toBe("::1");
    expect(hostName("[fe80::1%25en0]:7373")).toBe("fe80::1");
    expect(hostName("192.168.1.4:7373")).toBe("192.168.1.4");
    expect(hostName("studio.local.:7373")).toBe("studio.local");
    expect(hostName(undefined)).toBe("");
    // An address has one spelling, however it was written.
    expect(hostName("127.1:7373")).toBe("127.0.0.1");
    expect(hostName("0:7373")).toBe("0.0.0.0");
    expect(hostName("[0:0:0:0:0:0:0:0]:7373")).toBe("::");
    expect(hostName("[0:0:0:0:0:0:0:1]")).toBe("::1");
    expect(hostName("[0:0:0:0:0:ffff:7f00:1]:7373")).toBe("::ffff:7f00:1");
    // What is no host comes back as sent: a name nothing answers to.
    expect(hostName("[::1]other.example")).toBe("[::1]other.example");
    expect(hostName("localhost@other.example")).toBe("localhost@other.example");
    expect(hostName("localhost:7373/x")).toBe("localhost:7373/x");
  });

  it("knows this machine by localhost, an address and the names it was given, and by no other", () => {
    const deps = { hosts: () => ["studio-box.local", undefined, "Board.Test", "host.docker.internal:7373"] };
    for (const h of [
      "localhost",
      "127.0.0.1",
      "127.0.0.2",
      "::1",
      "192.168.1.4",
      "100.64.0.9",
      "fe80::1",
      "studio-box.local",
      "board.test",
      "host.docker.internal",
      "",
    ])
      expect([h, knownHost(h, deps)]).toEqual([h, true]);
    for (const h of [
      // Where a server listens, and an IPv4 address in IPv6 dress: not how it is opened.
      "0.0.0.0",
      "::",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "other.example",
      "app.localhost",
      // Nothing is taken from the hostname by itself: these are the resolver's to answer.
      "studio-box",
      "studio-box.lan",
      "studio-box.home.arpa",
      "studio-box.other.example",
      "localhost.other.example",
      "127.0.0.1.other.example",
      "studio-box.local.other.example",
      "other-box.local",
      "[::1]other.example",
    ])
      expect([h, knownHost(h, deps)]).toEqual([h, false]);
    // With nothing given: localhost and addresses.
    expect(knownHost("localhost")).toBe(true);
    expect(knownHost("studio-box.local")).toBe(false);
  });

  it("takes the browser's word for where a request came from, and Origin where it gives none", () => {
    const another = (h: Record<string, string>, o = {}) => fromAnotherOrigin(fake({ host: "localhost:7373", ...h }, o));
    expect(another({ "sec-fetch-site": "same-origin" })).toBe(false);
    expect(another({ "sec-fetch-site": "none" })).toBe(false);
    expect(another({ "sec-fetch-site": "cross-site" })).toBe(true);
    expect(another({ "sec-fetch-site": "same-site" })).toBe(true);
    // The browser's word outranks an Origin of "null" (a same-origin POST under no-referrer).
    expect(another({ "sec-fetch-site": "same-origin", origin: "null" })).toBe(false);
    expect(another({ "sec-fetch-site": "cross-site", origin: "http://localhost:7373" })).toBe(true);
    // No Sec-Fetch-Site: plain http off loopback, an older browser.
    expect(another({ origin: "http://localhost:7373" })).toBe(false);
    expect(another({ origin: "https://localhost:7373" })).toBe(false);
    expect(another({ origin: "http://LOCALHOST:7373" })).toBe(false);
    expect(another({ origin: "http://localhost:5173" })).toBe(true);
    expect(another({ origin: "https://other.example" })).toBe(true);
    expect(another({ origin: "null" })).toBe(true);
    expect(another({ origin: "not a url" })).toBe(true);
    expect(another({ origin: "file://" })).toBe(true);
    // An Origin is read whole, as a browser writes it: a longer port or a longer name is
    // another origin, and so is one that carries a user or a path.
    expect(another({ origin: "http://localhost:73730" })).toBe(true);
    expect(fromAnotherOrigin(fake({ host: "board.test", origin: "http://board.test.other.example" }))).toBe(true);
    expect(fromAnotherOrigin(fake({ host: "board.test", origin: "http://board.test" }))).toBe(false);
    expect(another({ origin: "http://x@localhost:7373" })).toBe(true);
    expect(another({ origin: "http://localhost:7373/" })).toBe(true);
    // Neither header: not a browser.
    expect(another({})).toBe(false);
    // Through the trusted proxy the browser asked for the forwarded host, which the proxy
    // wrote last; the public url is this server.
    const proxied = {
      host: "127.0.0.1:7373",
      "x-forwarded-host": "studio.tail1234.ts.net",
      origin: "https://studio.tail1234.ts.net",
    };
    expect(fromAnotherOrigin(fake(proxied, { forwarded: true }))).toBe(false);
    expect(fromAnotherOrigin(fake(proxied, { forwarded: false }))).toBe(true);
    const appended = { ...proxied, "x-forwarded-host": "studio.tail1234.ts.net, inner.example" };
    expect(fromAnotherOrigin(fake(appended, { forwarded: true }))).toBe(true);
    const viaPublic = fake({ host: "127.0.0.1:7373", origin: "https://studio.tail1234.ts.net" });
    expect(fromAnotherOrigin(viaPublic, { origins: () => ["https://studio.tail1234.ts.net"] })).toBe(false);
    expect(fromAnotherOrigin(viaPublic, { origins: () => ["https://other.ts.net", undefined] })).toBe(true);
  });

  it("asks a name only of a request made on this machine, and never of a sink's or a daemon's route", () => {
    const named = { host: "board.other.example:7373", "sec-fetch-site": "same-origin" };
    const here = { thisMachine: (ip: string) => ip === "127.0.0.1" || ip === "192.168.1.4" };
    expect(checkRequest(fake(named), here)).toMatchObject({ status: 403, reason: "unknown_host" });
    expect(checkRequest(fake(named, { from: "192.168.1.4" }), here)).toMatchObject({ reason: "unknown_host" });
    expect(checkRequest(fake(named, { from: "192.168.1.77" }), here)).toBeNull();
    // A sink or a daemon, which sends no browser header, is answered under any name; a
    // browser on the same route is asked like anywhere else.
    expect(checkRequest(fake({ host: named.host }, { route: { wire: true } }), here)).toBeNull();
    expect(checkRequest(fake(named, { route: { wire: true } }), here)).toMatchObject({ reason: "unknown_host" });
    const posted = { host: named.host, origin: `http://${named.host}` };
    expect(checkRequest(fake(posted, { method: "POST", route: { wire: true } }), here)).toMatchObject({
      reason: "unknown_host",
    });
    // Through the trusted proxy the request is a visitor's: it stands on the UI key alone.
    expect(checkRequest(fake(named, { forwarded: true }), here)).toBeNull();
    // The address a server listens on is no name of it, from this machine.
    expect(checkRequest(fake({ host: "0.0.0.0:7373" }), here)).toMatchObject({ reason: "unknown_host" });
    expect(checkRequest(fake({ host: "[::ffff:127.0.0.1]:7373" }), here)).toMatchObject({ reason: "unknown_host" });
    expect(checkRequest(fake({ host: "[0:0:0:0:0:0:0:0]:7373" }), here)).toMatchObject({ reason: "unknown_host" });
    expect(checkRequest(fake({ host: "[::1]other.example" }), here)).toMatchObject({ reason: "unknown_host" });
    expect(checkRequest(fake({ host: "127.1:7373" }), here)).toBeNull();
    // The name is said back without anything a page could have put in it.
    const odd = checkRequest(fake({ host: 'x"><script>.example' }), here);
    expect(odd?.error).toContain('"xscript.example"');
  });

  it("takes a link from another site to a page, and nothing else from it", () => {
    const from = (pathname: string, mode: string, dest: string, method = "GET") =>
      checkRequest(
        fake(
          { host: "localhost:7373", "sec-fetch-site": "cross-site", "sec-fetch-mode": mode, "sec-fetch-dest": dest },
          { pathname, method },
        ),
      );
    expect(from("/s/claude-code/abc", "navigate", "document")).toBeNull();
    expect(from("/pair", "navigate", "document")).toBeNull();
    expect(from("/", "navigate", "document", "HEAD")).toBeNull();
    expect(from("/", "navigate", "document", "POST")).toMatchObject({ status: 403, reason: "cross_site" });
    expect(from("/", "navigate", "iframe")).toMatchObject({ reason: "cross_site" });
    expect(from("/", "no-cors", "document")).toMatchObject({ reason: "cross_site" });
    expect(from("/api/ui/info", "navigate", "document")).toMatchObject({ reason: "cross_site" });
    expect(from("/.well-known/sessionpipe", "navigate", "document")).toMatchObject({ reason: "cross_site" });
    // A sink's route is no exception to this rule.
    const wire = fake(
      { host: "localhost:7373", "sec-fetch-site": "cross-site" },
      { method: "POST", route: { wire: true } },
    );
    expect(checkRequest(wire)).toMatchObject({ reason: "cross_site" });
  });
});

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  reason?: string;
}

/** One request with exactly these headers (node:http adds Host and Connection only). */
function ask(
  port: number,
  o: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    // The length is said outright: node leaves a DELETE's body unframed otherwise.
    const length = o.body === undefined ? {} : { "content-length": String(Buffer.byteLength(o.body)) };
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: o.method ?? "GET",
        path: o.path,
        headers: { ...(o.headers ?? {}), ...length },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        // An SSE answer never ends: its head is all that is asked of it here.
        if (String(res.headers["content-type"]).startsWith("text/event-stream")) {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: "" });
          req.destroy();
          return;
        }
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let reason: string | undefined;
          try {
            reason = (JSON.parse(text) as { reason?: string }).reason;
          } catch {}
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, ...(reason ? { reason } : {}) });
        });
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}

/** What a browser puts on a request a page of another origin makes toward a loopback
 *  address (Chromium, as seen on the wire): a no-cors fetch, or a form. */
const CROSS = {
  origin: "https://other.example",
  referer: "https://other.example/",
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "no-cors",
  "sec-fetch-dest": "empty",
};
const JSON_TYPE = { "content-type": "application/json" };
const PLAIN = { "content-type": "text/plain;charset=UTF-8" };
/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
  "base64",
);

describe("every route, behind the guard", () => {
  let tmp: { dir: string; cleanup: () => void };
  let app: App;
  let port: number;
  /** The app's whole route table again, on a second port, behind the same guard, with
   *  handlers that do nothing: the tests that walk every route ask this one. Setup's
   *  routes start programs (the CLI, `tailscale serve`), and a test must not start them on
   *  the day the guard is broken; here that day shows as a 200 `reached`. */
  let walk: number;
  let walker: http.Server;
  let sink: string;
  /** The page's own request, as a browser marks it. */
  let own: Record<string, string>;
  const fill = (pattern: string): string =>
    pattern
      .split("/")
      .map((p) => (p.startsWith(":") ? "x1" : p.startsWith("*") ? "a.txt" : p))
      .join("/");

  beforeAll(async () => {
    tmp = tempDir("spgui-guard-");
    const web = path.join(tmp.dir, "web");
    mkdirSync(path.join(web, "assets"), { recursive: true });
    writeFileSync(path.join(web, "index.html"), "<!doctype html><title>board</title>");
    writeFileSync(path.join(web, "assets", "app.js"), "export {};");
    app = await createApp({
      port: 0,
      host: "127.0.0.1",
      stateDir: path.join(tmp.dir, "state"),
      outbox: false,
      quiet: true,
      testDoor: true,
      webDir: web,
      allowHosts: ["board.test"],
    });
    port = app.port;
    sink = app.config().sinkToken;
    const inert = new Router();
    for (const r of app.router.list())
      inert.add(r.method, r.pattern, () => ({ status: 200, json: { reason: "reached" } }), r.options);
    inert.guard = app.router.guard;
    inert.trustProxy = app.router.trustProxy;
    walker = http.createServer((req, res) => void inert.handle(req, res));
    await new Promise<void>((ok) => walker.listen(0, "127.0.0.1", ok));
    walk = (walker.address() as { port: number }).port;
    own = { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
  });
  afterAll(async () => {
    walker.closeAllConnections?.();
    await new Promise<void>((ok) => walker.close(() => ok()));
    await app.close();
    tmp.cleanup();
  });

  it("names its exceptions: the sink's and the machines' routes; nothing else", () => {
    const routes = app.router.list();
    const wire = routes
      .filter((r) => r.options.wire === true)
      .map((r) => `${r.method} ${r.pattern}`)
      .sort();
    expect(wire).toEqual([
      "GET /.well-known/sessionpipe",
      `GET ${ROUTES.control}`,
      `GET ${ROUTES.control}/files/:sha`,
      `GET ${ROUTES.control}/pair`,
      `POST ${ROUTES.control}/ack`,
      `POST ${ROUTES.control}/hello`,
      `POST ${ROUTES.control}/off`,
      `POST ${ROUTES.control}/pair`,
      `POST ${ROUTES.events}`,
    ]);
    // A route under /api/ui is never a wire route: it is the page's.
    expect(routes.filter((r) => r.options.wire && r.pattern.startsWith("/api/ui"))).toEqual([]);
    expect(routes.length).toBeGreaterThan(100);
  });

  it("refuses a request from another origin on every route, whatever its method", async () => {
    const seen: string[] = [];
    for (const r of app.router.list()) {
      const a = await ask(walk, {
        method: r.method,
        path: fill(r.pattern),
        headers: { ...CROSS, ...(r.method === "GET" || r.method === "HEAD" ? {} : PLAIN) },
        ...(r.method === "GET" || r.method === "HEAD" ? {} : { body: "{}" }),
      });
      const want = `${r.method} ${r.pattern} 403 ${r.method === "HEAD" ? "" : "cross_site"}`;
      expect(`${r.method} ${r.pattern} ${a.status} ${a.reason ?? ""}`).toBe(want);
      seen.push(`${r.method} ${r.pattern}`);
    }
    // Among them the routes that act on this machine, the uploads and the deletes.
    for (const p of ["/pair", "/pair/cancel", "/tls/on", "/tls/trust", "/remote", "/remote/off"])
      expect(seen).toContain(`POST ${ROUTES.ui.setup}${p}`);
    expect(seen).toContain(`POST ${ROUTES.ui.phone}/tailscale`);
    expect(seen).toContain(`POST ${ROUTES.ui.attachments}`);
    expect(seen).toContain(`POST ${ROUTES.ui.control}/files`);
    expect(seen).toContain(`DELETE ${ROUTES.attachments}/:file`);
    expect(seen).toContain(`DELETE ${ROUTES.ui.spacesheep}`);
    expect(seen).toContain(`POST ${ROUTES.ui.searchReindex}`);
    expect(seen).toContain(`POST ${ROUTES.ui.workflows}/:id/run`);
    // A path no route has, and a method a route does not take, are refused the same way.
    expect((await ask(port, { method: "POST", path: "/api/ui/nothing-here", headers: CROSS })).reason).toBe(
      "cross_site",
    );
    expect((await ask(port, { method: "DELETE", path: ROUTES.ui.demo, headers: CROSS })).reason).toBe("cross_site");
  });

  it("refuses it where the browser sends an Origin and nothing else, and an Origin of null", async () => {
    const writes = app.router.list().filter((r) => r.method !== "GET" && r.method !== "HEAD");
    expect(writes.length).toBeGreaterThan(40);
    // The last is this host on another port: another program of this machine, another origin.
    for (const origin of ["http://other.example", "null", "http://127.0.0.1:1"])
      for (const r of writes) {
        const a = await ask(walk, {
          method: r.method,
          path: fill(r.pattern),
          headers: { origin, ...PLAIN },
          body: "{}",
        });
        expect(`${origin} ${r.method} ${r.pattern} ${a.status} ${a.reason}`).toBe(
          `${origin} ${r.method} ${r.pattern} 403 cross_site`,
        );
      }
  });

  it("starts nothing, changes nothing, stores nothing and deletes nothing for a request from another origin", async () => {
    const before = JSON.stringify(app.config());
    const info = app.info();
    for (const [path, body] of [
      [ROUTES.ui.demo, '{"on":true}'],
      [ROUTES.ui.rotateToken, ""],
      [`${ROUTES.ui.setup}/remote`, '{"url":"https://other.example"}'],
      [`${ROUTES.ui.setup}/tls/on`, ""],
      [ROUTES.ui.spacesheep, '{"origin":"https://other.invalid"}'],
      ["/api/ui/plugins/ping-a-human/enable", ""],
    ] as const)
      expect((await ask(port, { method: "POST", path, headers: { ...CROSS, ...PLAIN }, body })).status).toBe(403);
    expect(JSON.stringify(app.config())).toBe(before);
    expect(app.info().sources.demo).toBe(false);
    expect(app.info().control.rpId).toBe(info.control.rpId);
    expect(app.publicUrl).toBeUndefined();
    expect(app.tls).toBeNull();

    // A file for a start, as text/plain; an image, alone and as a form's part.
    const files = path.join(app.stateDir, "control", "files");
    const attachments = path.join(app.stateDir, "attachments");
    const held = () => (existsSync(files) ? readdirSync(files) : []);
    const images = () => (existsSync(attachments) ? readdirSync(attachments).filter((f) => f.endsWith(".png")) : []);
    const file = await ask(port, {
      method: "POST",
      path: `${ROUTES.ui.control}/files?name=notes.txt`,
      headers: { ...CROSS, ...PLAIN },
      body: "notes",
    });
    expect(`${file.status} ${file.reason}`).toBe("403 cross_site");
    expect(held()).toEqual([]);
    const image = await ask(port, {
      method: "POST",
      path: ROUTES.ui.attachments,
      headers: { ...CROSS, "content-type": "image/png" },
      body: PNG,
    });
    expect(`${image.status} ${image.reason}`).toBe("403 cross_site");
    const form = Buffer.concat([
      Buffer.from(
        '--x\r\ncontent-disposition: form-data; name="file"; filename="a.png"\r\ncontent-type: image/png\r\n\r\n',
      ),
      PNG,
      Buffer.from("\r\n--x--\r\n"),
    ]);
    const multipart = await ask(port, {
      method: "POST",
      path: ROUTES.ui.attachments,
      headers: { ...CROSS, "content-type": "multipart/form-data; boundary=x" },
      body: form,
    });
    expect(`${multipart.status} ${multipart.reason}`).toBe("403 cross_site");
    expect(images()).toEqual([]);

    // The page's own upload is kept, and only the page takes it away again.
    const kept = await ask(port, {
      method: "POST",
      path: ROUTES.ui.attachments,
      headers: { ...own, "content-type": "multipart/form-data; boundary=x" },
      body: form,
    });
    expect(kept.status).toBe(201);
    const { id } = JSON.parse(kept.text) as { id: string };
    expect(images()).toEqual([`${id}.png`]);
    for (const headers of [
      { ...CROSS, "sec-fetch-mode": "cors" },
      { origin: "https://other.example" },
      { origin: "null" },
    ]) {
      const gone = await ask(port, { method: "DELETE", path: `${ROUTES.attachments}/${id}.png`, headers });
      expect(`${gone.status} ${gone.reason}`).toBe("403 cross_site");
    }
    // Nor is it shown to another origin's page, as an image or to a fetch.
    const shown = await ask(port, {
      path: `${ROUTES.attachments}/${id}.png`,
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" },
    });
    expect(shown.status).toBe(403);
    expect(images()).toEqual([`${id}.png`]);
    expect((await ask(port, { method: "DELETE", path: `${ROUTES.attachments}/${id}.png`, headers: own })).status).toBe(
      204,
    );
    expect(images()).toEqual([]);
    const mine = await ask(port, {
      method: "POST",
      path: `${ROUTES.ui.control}/files?name=notes.txt`,
      headers: { ...own, ...PLAIN },
      body: "notes",
    });
    expect(mine.status).toBe(201);
    expect(held().length).toBeGreaterThan(0);
  });

  it("takes the page's own requests: same-origin by the browser's word, or an Origin that is this server", async () => {
    const demo = (headers: Record<string, string>, on: boolean) =>
      ask(port, {
        method: "POST",
        path: ROUTES.ui.demo,
        headers: { ...JSON_TYPE, ...headers },
        body: JSON.stringify({ on }),
      });
    expect((await ask(port, { path: ROUTES.ui.info, headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
    expect((await demo(own, false)).status).toBe(200);
    // Over plain http on a LAN address a browser sends Origin and no Sec-Fetch-Site.
    expect((await demo({ origin: `http://127.0.0.1:${port}` }, false)).status).toBe(200);
    // The same port answers https: the page there is this server too.
    expect((await demo({ origin: `https://127.0.0.1:${port}` }, false)).status).toBe(200);
    // Typed into the address bar, a bookmark: the browser says "none".
    expect(
      (await ask(port, { path: "/", headers: { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" } })).status,
    ).toBe(200);
    // The stream the page holds open, and the files it loads.
    const stream = await ask(port, {
      path: ROUTES.ui.stream,
      headers: { "sec-fetch-site": "same-origin", accept: "text/event-stream" },
    });
    expect(stream.status).toBe(200);
    const script = await ask(port, {
      path: "/assets/app.js",
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "script" },
    });
    expect(script.status).toBe(200);
  });

  it("takes the native shell's requests, which carry no browser header at all", async () => {
    // sp-receivers' proxy forwards content-type, accept, if-match, if-none-match and
    // user-agent, and adds the key cookie for a receiver on another machine.
    const shell = { accept: "application/json", "user-agent": "Mozilla/5.0 (Macintosh) sessionpipe/0.8.4" };
    expect((await ask(port, { path: ROUTES.ui.info, headers: shell })).status).toBe(200);
    expect((await ask(port, { path: ROUTES.ui.snapshot, headers: shell })).status).toBe(200);
    const post = await ask(port, {
      method: "POST",
      path: ROUTES.ui.demo,
      headers: { ...shell, ...JSON_TYPE },
      body: '{"on":false}',
    });
    expect(post.status).toBe(200);
    const patch = await ask(port, {
      method: "PATCH",
      path: ROUTES.ui.labels,
      headers: { ...shell, ...JSON_TYPE },
      body: '{"names":{}}',
    });
    expect(patch.status).toBe(200);
    // Its uploads and its delete: an image, a file for a start.
    const image = await ask(port, {
      method: "POST",
      path: ROUTES.ui.attachments,
      headers: { ...shell, "content-type": "image/png" },
      body: PNG,
    });
    expect(image.status).toBe(201);
    const { id } = JSON.parse(image.text) as { id: string };
    expect(
      (await ask(port, { method: "DELETE", path: `${ROUTES.attachments}/${id}.png`, headers: shell })).status,
    ).toBe(204);
    const file = await ask(port, {
      method: "POST",
      path: `${ROUTES.ui.control}/files?name=plan.txt`,
      headers: { ...shell, ...PLAIN },
      body: "plan",
    });
    expect(file.status).toBe(201);
    // From another machine, with the key as the cookie the shell adds, under whatever name
    // that machine knows this one by.
    app.router.guard.thisMachine = () => false;
    try {
      const remote = { ...shell, cookie: `spgui=${app.config().uiKey}` };
      expect(
        (await ask(port, { path: ROUTES.ui.info, headers: { ...remote, host: "studio.example:7373" } })).status,
      ).toBe(200);
    } finally {
      delete app.router.guard.thisMachine;
    }
  });

  it("takes a sink and a machine's daemon with their tokens, by any name, the body as they send it", async () => {
    const s = new Session("guarded");
    const batch = JSON.stringify({ events: [s.ev("session.started", { source: "startup" })] });
    const bearer = { authorization: `Bearer ${sink}` };
    // sessionpipe's own client (node fetch): no Origin, no Sec-Fetch-Site, `sec-fetch-mode: cors`.
    const node = { "sec-fetch-mode": "cors", "user-agent": "node", accept: "*/*" };
    const posted = await ask(port, {
      method: "POST",
      path: ROUTES.events,
      headers: { ...node, ...bearer, ...JSON_TYPE, "sessionpipe-protocol": "1" },
      body: batch,
    });
    expect(posted.status).toBe(202);
    // A sink that names this machine by a name the GUI was never told, and says nothing of
    // the body's type: the token is its credential, not the name or the address.
    const odd = await ask(port, {
      method: "POST",
      path: ROUTES.events,
      headers: { ...bearer, host: "gui.corp.example:7373", "content-type": "text/plain" },
      body: batch,
    });
    expect(odd.status).toBe(202);
    expect((await ask(port, { path: ROUTES.wellKnown, headers: { host: "gui.corp.example:7373" } })).status).toBe(200);
    // Without the token it is a 401 as before, not the guard's 403.
    expect((await ask(port, { method: "POST", path: ROUTES.events, headers: JSON_TYPE, body: batch })).status).toBe(
      401,
    );
    // The daemon: pair with the sink token (`sessionpipe control pair --token`), then its own.
    const hello = JSON.stringify({
      name: "guard-box",
      harnesses: ["claude-code"],
      modes: ["waiter"],
      version: "0.13.6",
    });
    const paired = await ask(port, {
      method: "POST",
      path: `${ROUTES.control}/pair`,
      headers: { ...node, ...bearer, ...JSON_TYPE, host: "gui.corp.example:7373" },
      body: hello,
    });
    expect(paired.status).toBe(201);
    const code = (JSON.parse(paired.text) as { code: string }).code;
    const status = await ask(port, { path: `${ROUTES.control}/pair?code=${code}`, headers: { ...node, ...bearer } });
    expect(JSON.parse(status.text)).toEqual({ status: "pending" });
    // And with no token (`sessionpipe connect`): a poll key of its own.
    const open = await ask(port, {
      method: "POST",
      path: `${ROUTES.control}/pair`,
      headers: { ...node, ...JSON_TYPE, host: "gui.corp.example:7373" },
      body: JSON.stringify({ ...JSON.parse(hello), poll_key: "p".repeat(43) }),
    });
    expect(open.status).toBe(201);
    const enrolled = await ask(port, {
      method: "POST",
      path: `${ROUTES.control}/_test/enroll`,
      headers: JSON_TYPE,
      body: JSON.stringify({ machine: "m_guardguardguardguard00" }),
    });
    const token = (JSON.parse(enrolled.text) as { token: string }).token;
    const said = await ask(port, {
      method: "POST",
      path: `${ROUTES.control}/hello`,
      headers: { ...node, authorization: `Bearer ${token}`, ...JSON_TYPE },
      body: hello,
    });
    expect(said.status).toBe(204);
    expect(
      (await ask(port, { method: "POST", path: `${ROUTES.control}/hello`, headers: JSON_TYPE, body: hello })).status,
    ).toBe(401);
  });

  it("takes this package's own CLI, which asks the running server to index", async () => {
    // server/search/cli.ts: fetch to 127.0.0.1 with a JSON body; server/service: a GET of the info.
    const r = await fetch(`http://127.0.0.1:${port}${ROUTES.ui.searchReindex}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rebuild: false }),
    });
    expect(r.status).toBe(202);
    expect((await fetch(`http://127.0.0.1:${port}${ROUTES.ui.searchStatus}`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}${ROUTES.ui.info}`)).status).toBe(200);
  });

  it("only reads on a GET: the process's numbers come either way, a full collection with a POST", async () => {
    const read = await fetch(`http://127.0.0.1:${port}/api/ui/stats/process?gc=1`);
    expect(read.status).toBe(200);
    expect(typeof ((await read.json()) as { heapUsed: number }).heapUsed).toBe("number");
    const collected = await fetch(`http://127.0.0.1:${port}/api/ui/stats/process`, { method: "POST" });
    expect(collected.status).toBe(200);
    // From another site neither is answered.
    const a = await ask(port, {
      method: "POST",
      path: "/api/ui/stats/process",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(a.status).toBe(403);
  });

  it("refuses, from this machine, a name that is not this machine's", async () => {
    // A page under such a name is same-origin to itself by the browser's word.
    const named = { host: `board.other.example:${port}`, "sec-fetch-site": "same-origin" };
    for (const path of [
      ROUTES.ui.info,
      ROUTES.ui.snapshot,
      `${ROUTES.ui.setup}/status`,
      `${ROUTES.ui.control}/pairings`,
      ROUTES.ui.qr,
      ROUTES.trust,
      "/assets/app.js",
      "/",
    ]) {
      const a = await ask(port, { path, headers: named });
      expect(`${path} ${a.status}`).toBe(`${path} 403`);
      expect(a.text).not.toContain(sink);
      expect(a.text).not.toContain(app.config().uiKey);
    }
    // Every route, a sink's and a daemon's too: a browser has no call to make there.
    for (const r of app.router.list()) {
      const write = r.method !== "GET" && r.method !== "HEAD";
      const a = await ask(walk, {
        method: r.method,
        path: fill(r.pattern),
        headers: { ...named, origin: `http://board.other.example:${port}`, ...(write ? JSON_TYPE : {}) },
        ...(write ? { body: "{}" } : {}),
      });
      const want = `${r.method} ${r.pattern} 403 ${r.method === "HEAD" ? "" : "unknown_host"}`;
      expect(`${r.method} ${r.pattern} ${a.status} ${a.reason ?? ""}`).toBe(want);
    }
    // The address the server listens on is not a name it is opened by.
    for (const host of [`0.0.0.0:${port}`, `[::]:${port}`, `[::ffff:127.0.0.1]:${port}`])
      expect(`${host} ${(await ask(port, { path: ROUTES.ui.info, headers: { host } })).reason}`).toBe(
        `${host} unknown_host`,
      );
    // Asked for as a page, the refusal is a page that says where to go instead.
    const page = await ask(port, { path: "/", headers: { ...named, accept: "text/html,*/*" } });
    expect(page.status).toBe(403);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    expect(page.text).toContain(`http://localhost:${port}`);
    expect(page.text).toContain("--allow-host");
  });

  it("takes the names this machine goes by: localhost, an address, the names it hands out or was given", async () => {
    const at = (host: string) => ask(port, { path: ROUTES.ui.info, headers: { host } });
    for (const host of [
      `localhost:${port}`,
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
      `LOCALHOST:${port}`,
      // The `.local` name the setup page shows, and the one --allow-host gave.
      `${localHostname()}:${port}`,
      "board.test",
      `192.168.1.4:${port}`,
    ])
      expect(`${host} ${(await at(host)).status}`).toBe(`${host} 200`);
    // The public url's name is the proxy's: answered through the proxy, not from this machine.
    expect((await at("studio.tail1234.ts.net")).reason).toBe("unknown_host");
    app.setPublicUrl("https://studio.tail1234.ts.net");
    try {
      expect((await at("studio.tail1234.ts.net")).reason).toBe("unknown_host");
      // Through the proxy: the browser's Origin is the public url, the visitor is not this machine.
      const proxied = {
        host: "studio.tail1234.ts.net",
        "x-forwarded-for": "100.64.0.9",
        "x-forwarded-host": "studio.tail1234.ts.net",
        "x-forwarded-proto": "https",
        origin: "https://studio.tail1234.ts.net",
        cookie: `spgui=${app.config().uiKey}`,
      };
      const viaProxy = await ask(port, {
        method: "POST",
        path: `${ROUTES.ui.phone}/trust-check`,
        headers: proxied,
      });
      expect(viaProxy.status).toBe(200);
      expect((await ask(port, { path: ROUTES.ui.info, headers: proxied })).status).toBe(200);
      expect((await ask(port, { path: ROUTES.ui.info, headers: { ...proxied, cookie: "" } })).status).toBe(401);
      // The same from a page of another origin, through the proxy: refused as anywhere.
      const other = await ask(port, {
        method: "POST",
        path: `${ROUTES.ui.phone}/trust-check`,
        headers: { ...proxied, origin: "https://other.example", "sec-fetch-site": "cross-site" },
      });
      expect(other.reason).toBe("cross_site");
    } finally {
      app.setPublicUrl(undefined);
    }
    expect((await at("studio.tail1234.ts.net")).reason).toBe("unknown_host");
  });

  it("does not take the public url's name from this machine when --rp-id is that name", async () => {
    const dir = tempDir("spgui-guard-rp-");
    const own = await createApp({
      port: 0,
      host: "127.0.0.1",
      stateDir: path.join(dir.dir, "state"),
      outbox: false,
      quiet: true,
      publicUrl: "https://studio.tail1234.ts.net",
      rpId: "studio.tail1234.ts.net",
    });
    try {
      const a = await ask(own.port, { path: ROUTES.ui.info, headers: { host: "studio.tail1234.ts.net" } });
      expect(`${a.status} ${a.reason}`).toBe("403 unknown_host");
      expect((await ask(own.port, { path: ROUTES.ui.info, headers: { host: `localhost:${own.port}` } })).status).toBe(
        200,
      );
    } finally {
      await own.close();
      dir.cleanup();
    }
  });

  it("asks no name of a request from another machine, or of one the proxy forwarded: what they need is the key", async () => {
    // The socket is loopback in a test, so the guard is told the caller is elsewhere; its
    // own reading of that is the unit test above. The name is then not the guard's business.
    const odd = { host: "gui.corp.example:7373", "sec-fetch-site": "same-origin" };
    app.router.guard.thisMachine = () => false;
    try {
      for (const path of [ROUTES.ui.info, ROUTES.ui.snapshot, "/"])
        expect((await ask(port, { path, headers: odd })).reason).not.toBe("unknown_host");
    } finally {
      delete app.router.guard.thisMachine;
    }
    expect((await ask(port, { path: ROUTES.ui.info, headers: { host: "gui.corp.example:7373" } })).reason).toBe(
      "unknown_host",
    );
    // A proxy that serves this board under a second name: its visitors stand on the key,
    // and none of them is this machine.
    app.setPublicUrl("https://studio.tail1234.ts.net");
    try {
      const via = { ...odd, "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "gui.corp.example" };
      expect((await ask(port, { path: ROUTES.ui.info, headers: via })).status).toBe(401);
      expect((await ask(port, { path: `${ROUTES.ui.setup}/status`, headers: via })).reason).toBe("local_only");
      const keyed = { ...via, cookie: `spgui=${app.config().uiKey}` };
      expect((await ask(port, { path: ROUTES.ui.info, headers: keyed })).status).toBe(200);
      expect((await ask(port, { path: `${ROUTES.ui.setup}/status`, headers: keyed })).reason).toBe("local_only");
    } finally {
      app.setPublicUrl(undefined);
    }
  });

  it("sends no CORS header and answers no preflight", async () => {
    const pre = await ask(port, {
      method: "OPTIONS",
      path: ROUTES.ui.demo,
      headers: {
        origin: "https://other.example",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(pre.status).toBe(403);
    const answers = [
      pre,
      await ask(port, { method: "OPTIONS", path: ROUTES.ui.demo }),
      await ask(port, { path: ROUTES.ui.info, headers: { origin: "https://other.example" } }),
      await ask(port, { path: ROUTES.ui.info, headers: own }),
      await ask(port, { path: ROUTES.wellKnown }),
      await ask(port, { path: "/" }),
    ];
    for (const a of answers) expect(Object.keys(a.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
  });

  it("lets another site link to a page, and neither frame it nor load from it", async () => {
    const from = (mode: string, dest: string) => ({
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": mode,
      "sec-fetch-dest": dest,
    });
    // A link in a chat, an email, another tab: a top-level navigation.
    const link = await ask(port, { path: "/s/claude-code/abc", headers: from("navigate", "document") });
    expect(link.status).toBe(200);
    expect(link.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(link.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect((await ask(port, { path: ROUTES.trust, headers: from("navigate", "document") })).status).toBe(200);
    // The pairing link a terminal prints, opened from wherever it was pasted.
    const key = app.config().uiKey;
    const paired = await ask(port, { path: `/pair?code=abc&k=${key}`, headers: from("navigate", "document") });
    expect(paired.status).toBe(302);
    expect((await ask(port, { path: "/pair?code=abc", headers: from("navigate", "document") })).status).toBe(200);
    // In a frame, as a script, an image, a fetch: refused; and the API even as a navigation.
    for (const [path, mode, dest] of [
      ["/", "navigate", "iframe"],
      ["/", "navigate", "frame"],
      ["/assets/app.js", "no-cors", "script"],
      ["/skins/x1/skin.css", "no-cors", "style"],
      ["/themes/x1/index.js", "cors", "script"],
      ["/attachments/x1.png", "no-cors", "image"],
      [ROUTES.ui.qr, "no-cors", "image"],
      [ROUTES.ui.info, "navigate", "document"],
      [ROUTES.ui.info, "no-cors", "empty"],
      [ROUTES.ui.stream, "cors", "empty"],
      [`${ROUTES.ui.searchSessions}?q=words`, "no-cors", "empty"],
      ["/api/ui/stats/process?gc=1", "no-cors", "image"],
    ] as const) {
      const a = await ask(port, { path, headers: from(mode, dest) });
      expect(`${path} ${dest} ${a.status} ${a.reason}`).toBe(`${path} ${dest} 403 cross_site`);
    }
    // The API is the API however its path is written: the router drops empty segments,
    // and so does the guard.
    for (const path of ["//api/ui/info", "/api//ui/info", "///api/ui//info", "//x/..//api/ui/info"]) {
      const a = await ask(port, { path, headers: from("navigate", "document") });
      expect(`${path} ${a.status} ${a.reason}`).toBe(`${path} 403 cross_site`);
      expect(a.text).not.toContain(key);
      expect(`${path} ${(await ask(port, { path, headers: own })).status}`).toBe(`${path} 200`);
    }
    // A path that only starts like another host's address is a page of this server, and
    // the key in its query sends the browser back to this server, not on to that name.
    const elsewhere = await ask(port, { path: `//other.example/x?k=${key}`, headers: from("navigate", "document") });
    expect(elsewhere.status).toBe(302);
    expect(elsewhere.headers.location).toBe("/other.example/x");
    // Every page the server writes itself says the same of frames: the trust page, the refusal.
    expect((await ask(port, { path: ROUTES.trust })).headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    const refused = await ask(port, { path: "/", headers: { host: "other.example", accept: "text/html" } });
    expect(refused.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
