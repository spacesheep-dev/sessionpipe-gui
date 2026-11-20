// SPDX-License-Identifier: Apache-2.0
// The stand-in hub's files door (hub.ts), held to what the native one does (account.rs
// Door::MachineFiles, proxy.rs send_timeout): a picture's bytes with its type and name, the
// account's key added, its limits, and a time limit that grows with the bytes.
import { describe, expect, it } from "vitest";
import { FakeSpacesheep, ManualClock } from "./fake-spacesheep.js";
import { FILE_MAX, HUB_HEADER, HubStandIn, sendTimeoutS } from "./hub.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const FILES = "/api/machines/files";

function bed(clock?: ManualClock) {
  const ss = new FakeSpacesheep(clock);
  const asked: { authorization?: string; headers?: Record<string, string>; bytes?: Uint8Array }[] = [];
  const hub = new HubStandIn({
    upstream: {
      origin: "https://spacesheep.test",
      ask: (req) => {
        asked.push(req);
        return ss.handle(req);
      },
    },
    ...(clock ? { clock } : {}),
  });
  const id = hub.add("you@example.com", "ss_gui_fake_0000000000000000").id;
  const send = (o: { path?: string; method?: string; bytes?: Uint8Array; headers?: Record<string, string> }) =>
    hub.door(id, {
      method: o.method ?? "POST",
      path: o.path ?? FILES,
      ...(o.bytes ? { bytes: o.bytes } : {}),
      headers: o.headers ?? { "content-type": "image/png", "x-file-name": "screen%20shot.png" },
    });
  return { ss, hub, id, asked, send };
}

describe("the stand-in hub's files door", () => {
  it("waits fifteen seconds and one more for each 32 KiB, at most ten minutes", () => {
    expect(sendTimeoutS(0)).toBe(15);
    expect(sendTimeoutS(32 * 1024)).toBe(16);
    expect(sendTimeoutS(32 * 1024 + 1)).toBe(17);
    expect(sendTimeoutS(5_000_000)).toBe(168);
    expect(sendTimeoutS(25 * 1024 * 1024)).toBe(600);
  });

  it("forwards a picture's bytes, its type and name, with the account's key", async () => {
    const { ss, asked, send } = bed();
    const a = await send({ bytes: PNG });
    expect(a.status).toBe(200);
    expect(a.headers[HUB_HEADER]).toBeUndefined();
    const body = JSON.parse(a.body) as { sha256: string; size: number; type: string };
    expect(body).toMatchObject({ size: PNG.length, type: "image/png" });
    expect(body.sha256).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ss.files).toEqual([{ sha256: body.sha256, size: PNG.length, type: "image/png", name: "screen shot.png" }]);
    const up = asked.at(-1)!;
    expect(up.authorization).toBe("Bearer ss_gui_fake_0000000000000000");
    expect(up.headers).toEqual({ "content-type": "image/png", "x-file-name": "screen%20shot.png" });
    expect([...up.bytes!]).toEqual([...PNG]);
    // A name is the page's to give or not.
    expect((await send({ bytes: PNG, headers: { "content-type": "image/webp" } })).status).toBe(200);
    expect(asked.at(-1)!.headers).toEqual({ "content-type": "image/webp" });
  });

  it("refuses what is not a file, before any network", async () => {
    const { ss, send } = bed();
    const before = ss.log.length;
    const cases: [Parameters<typeof send>[0], string][] = [
      [{ method: "GET" }, "not_a_door"],
      [{ method: "PUT", bytes: PNG }, "not_a_door"],
      [{ path: `${FILES}/`, bytes: PNG }, "not_a_door"],
      [{ path: `${FILES}?name=a.png`, bytes: PNG }, "bad_query"],
      [{ bytes: new Uint8Array(FILE_MAX + 1) }, "too_large"],
      [{ bytes: new Uint8Array() }, "bad_body"],
      [{ bytes: PNG, headers: {} }, "bad_header"],
      [{ bytes: PNG, headers: { "content-type": "image/png; charset=utf-8" } }, "bad_header"],
      [{ bytes: PNG, headers: { "content-type": "picture" } }, "bad_header"],
      [{ bytes: PNG, headers: { "content-type": `image/${"p".repeat(95)}` } }, "bad_header"],
      [{ bytes: PNG, headers: { "content-type": "image/png", "x-file-name": "a.png\r" } }, "bad_header"],
      [{ bytes: PNG, headers: { "content-type": "image/png", "x-file-name": "a\nb.png" } }, "bad_header"],
      [{ bytes: PNG, headers: { "content-type": "image/png", "x-file-name": "a b.png" } }, "bad_header"],
      [{ bytes: PNG, headers: { "content-type": "image/png", "x-file-name": "" } }, "bad_header"],
      [{ bytes: PNG, headers: { "content-type": "image/png", "x-file-name": "a".repeat(1025) } }, "bad_header"],
    ];
    for (const [n, [req, code]] of cases.entries()) {
      const a = await send(req);
      expect([a.headers[HUB_HEADER], JSON.parse(a.body).reason], `case ${n}`).toEqual([code, code]);
    }
    expect(ss.log.length).toBe(before);
    // The largest file there may be goes.
    expect((await send({ bytes: new Uint8Array(FILE_MAX) })).status).toBe(200);
  });

  it("passes on no answer over a megabyte", async () => {
    const { ss, send } = bed();
    ss.fileAnswer = { status: 200, headers: { "content-type": "application/json" }, body: " ".repeat(1024 * 1024 + 1) };
    const a = await send({ bytes: PNG });
    expect(a.headers[HUB_HEADER]).toBe("answer_too_large");
  });

  it("passes on an older spacesheep's 401 and keeps the key", async () => {
    const { ss, hub, send } = bed();
    const heard: unknown[] = [];
    hub.on((event, payload) => heard.push([event, payload]));
    // A spacesheep that takes no key on the files door yet answers as to a visitor.
    const sign = JSON.stringify({ error: "Sign in first.", code: "unauthorized" });
    ss.fileAnswer = { status: 401, headers: { "content-type": "application/json" }, body: sign };
    const a = await send({ bytes: PNG });
    expect([a.status, a.headers[HUB_HEADER], a.body]).toEqual([401, undefined, sign]);
    const accounts = (hub.status() as { accounts: { state: string }[] }).accounts;
    expect(accounts.map((x) => x.state)).toEqual(["ok"]);
    expect(heard).toEqual([]);
  });

  it("gives a picture as long as its bytes take, and cuts off what takes longer", async () => {
    const clock = new ManualClock();
    const { hub, send } = bed(clock);
    // A 5 MB photo at 2 Mbit/s: twenty seconds, past the fifteen of every other door and
    // inside the 168 its bytes are given.
    hub.uplinkBytesPerS = 250_000;
    const photo = new Uint8Array(5_000_000);
    const going = send({ bytes: photo });
    await clock.advance(20_000);
    expect((await going).status).toBe(200);
    // The same photo at 128 kbit/s takes 312 s: cut off at 168.
    hub.uplinkBytesPerS = 16_000;
    let done = false;
    const slow = send({ bytes: photo }).then((a) => {
      done = true;
      return a;
    });
    await clock.advance(167_000);
    expect(done).toBe(false);
    await clock.advance(1_000);
    expect((await slow).headers[HUB_HEADER]).toBe("timeout");
  });

  it("holds an upload in one of the account's six places", async () => {
    const clock = new ManualClock();
    const { hub, send } = bed(clock);
    hub.uplinkBytesPerS = 1_000;
    const held = Array.from({ length: 6 }, () => send({ bytes: PNG }));
    await clock.settle();
    expect((await send({ bytes: PNG })).headers[HUB_HEADER]).toBe("busy");
    await clock.advance(1_000);
    for (const a of await Promise.all(held)) expect(a.status).toBe(200);
  });
});
