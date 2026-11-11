// SPDX-License-Identifier: Apache-2.0
// --host decides which addresses the receiver answers on; the URLs it offers (the
// banner's network lines, the phone QR, the sink command) must be ones that answer.
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { type Info, ROUTES } from "../shared/api.js";
import { tempDir } from "../test/events.js";
import { type App, createApp } from "./app.js";
import { lanAddresses } from "./http/net.js";

let app: App | undefined;
let tmp: { dir: string; cleanup: () => void } | undefined;

afterEach(async () => {
  await app?.close();
  tmp?.cleanup();
  app = undefined;
  tmp = undefined;
});

async function start(host?: string): Promise<App> {
  tmp = tempDir();
  app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, host });
  return app;
}

const sinkBase = (info: Info): string => info.sinkCommand.split(" ")[3]!;
const answers = async (base: string): Promise<number> => (await fetch(`${base}${ROUTES.ui.info}`)).status;
const hasIpv6Loopback = Object.values(os.networkInterfaces()).some((as) =>
  (as ?? []).some((a) => a.internal && a.address === "::1"),
);
const lan = lanAddresses()[0];
// A link-local IPv6 address with its zone id, as `--host fe80::1%lo0` binds on macOS.
const zoned = (os.networkInterfaces().lo0 ?? []).some((a) => a.address === "fe80::1") ? "fe80::1%lo0" : undefined;

describe("--host and the URLs the receiver offers", () => {
  it("bound to 127.0.0.1: no LAN URL, and the sink command names 127.0.0.1", async () => {
    const a = await start("127.0.0.1");
    const info = a.info();
    expect(info.urls.lan).toEqual([]);
    expect(a.lanUrls).toEqual([]);
    expect(sinkBase(info)).toBe(`http://127.0.0.1:${a.port}`);
    expect(await answers(sinkBase(info))).toBe(200);
  });

  it.skipIf(!hasIpv6Loopback)("bound to ::1: no LAN URL, and the sink command and url name [::1]", async () => {
    const a = await start("::1");
    const info = a.info();
    expect(info.urls.lan).toEqual([]);
    expect(sinkBase(info)).toBe(`http://[::1]:${a.port}`);
    expect(a.url).toBe(`http://[::1]:${a.port}`);
    expect(await answers(sinkBase(info))).toBe(200);
    expect(await answers(a.url)).toBe(200);
  });

  // localhost may resolve to ::1 first, so it needs the same IPv6 loopback as the test above.
  it.skipIf(!hasIpv6Loopback)("bound to localhost: no LAN URL, and the sink command answers", async () => {
    const a = await start("localhost");
    const info = a.info();
    expect(info.urls.lan).toEqual([]);
    expect(await answers(sinkBase(info))).toBe(200);
    expect(await answers(a.url)).toBe(200);
  });

  it.skipIf(!lan)("bound to one LAN address: that address alone", async () => {
    const a = await start(lan);
    expect(a.info().urls.lan).toEqual([`http://${lan}:${a.port}`]);
    expect(a.url).toBe(`http://${lan}:${a.port}`);
    expect(sinkBase(a.info())).toBe(`http://${lan}:${a.port}`);
  });

  // An IPv4-mapped bind needs an IPv6 socket, like the ::1 tests above. Node reports it as
  // ::ffff:127.0.0.1; the URLs name 127.0.0.1, which answers on that socket.
  it.skipIf(!hasIpv6Loopback)("bound to ::ffff:127.0.0.1: no LAN URL, and the URLs name 127.0.0.1", async () => {
    const a = await start("::ffff:127.0.0.1");
    const info = a.info();
    expect(info.urls.lan).toEqual([]);
    expect(a.url).toBe(`http://127.0.0.1:${a.port}`);
    expect(sinkBase(info)).toBe(`http://127.0.0.1:${a.port}`);
    expect(await answers(a.url)).toBe(200);
  });

  it.skipIf(!lan || !hasIpv6Loopback)("bound to a LAN address, IPv4-mapped: that IPv4 address alone", async () => {
    const a = await start(`::ffff:${lan}`);
    expect(a.info().urls.lan).toEqual([`http://${lan}:${a.port}`]);
    expect(a.url).toBe(`http://${lan}:${a.port}`);
    // It answers (a 401 when the UI asks for its key off loopback); a refused connection throws.
    expect([200, 401]).toContain(await answers(a.url));
  });

  it.skipIf(!zoned)("bound to an address with a zone id: no LAN URL, and no URL that does not parse", async () => {
    const a = await start(zoned);
    const info = a.info();
    expect(info.urls.lan).toEqual([]);
    for (const u of [a.url, sinkBase(info)]) expect(() => new URL(u)).not.toThrow();
  });

  it("the default wildcard bind still offers every LAN address", async () => {
    const a = await start();
    expect(a.info().urls.lan).toEqual(lanAddresses().map((ip) => `http://${ip}:${a.port}`));
    expect(a.url).toBe(`http://127.0.0.1:${a.port}`);
  });

  // Linux reports this bind as ::ffff:0.0.0.0, macOS as ::; either way it is a wildcard.
  // It needs an IPv6 socket, like the ::1 tests above.
  it.skipIf(!hasIpv6Loopback)("the IPv4-mapped wildcard ::ffff:0.0.0.0 offers every LAN address too", async () => {
    const a = await start("::ffff:0.0.0.0");
    expect(a.info().urls.lan).toEqual(lanAddresses().map((ip) => `http://${ip}:${a.port}`));
    expect(a.url).toBe(`http://127.0.0.1:${a.port}`);
    expect(await answers(a.url)).toBe(200);
  });
});
