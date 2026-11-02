// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTACHMENT_MAX_BYTES, type Attachment, type Info, ROUTES, UI_KEY_COOKIE } from "../../shared/api.js";
import { composePrompt, splitAttachments } from "../../shared/attachments.js";
import { Session, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import type { Ctx } from "../http/router.js";
import { ATTACHMENT_RETENTION_DAYS, AttachmentStore, multipartFiles, sniffImage } from "./attachments.js";

let app: App;
let tmp: { dir: string; cleanup: () => void };

beforeAll(async () => {
  tmp = tempDir();
  const web = path.join(tmp.dir, "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>board</title>");
  app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, webDir: web });
});
afterAll(async () => {
  await app.close();
  AttachmentStore.for(tmp.dir).close();
  tmp.cleanup();
});

// ---------- fixtures: real or header-only images of known size ----------

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer): number => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** A real, decodable PNG of one colour. */
export function png(width: number, height: number, rgb = [0x5a, 0x7a, 0xd0]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const gif = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(13 + 16);
  b.write("GIF89a", 0, "latin1");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
};
const jpeg = (w: number, h: number): Buffer => {
  // SOI, APP0 (JFIF, 16 bytes), SOF0 (width/height), then junk.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(2 + 2 + 5 + 3);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(sof.length - 2, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = 1;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(32, 0x11)]);
};
const webpVp8 = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(32, 4);
  b.write("WEBP", 8, "latin1");
  b.write("VP8 ", 12, "latin1");
  b.writeUInt32LE(20, 16);
  b.set([0x9d, 0x01, 0x2a], 23); // start code
  b.writeUInt16LE(w, 26);
  b.writeUInt16LE(h, 28);
  return b;
};
const webpVp8l = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write("VP8L", 12, "latin1");
  b[20] = 0x2f;
  b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
  return b;
};
const webpVp8x = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
};

describe("sniffImage", () => {
  it("reads the size from the header of each format", () => {
    expect(sniffImage(png(1440, 900))).toEqual({ type: "image/png", ext: "png", width: 1440, height: 900 });
    expect(sniffImage(gif(320, 200))).toEqual({ type: "image/gif", ext: "gif", width: 320, height: 200 });
    expect(sniffImage(jpeg(4032, 3024))).toEqual({ type: "image/jpeg", ext: "jpg", width: 4032, height: 3024 });
    expect(sniffImage(webpVp8(800, 600))).toEqual({ type: "image/webp", ext: "webp", width: 800, height: 600 });
    expect(sniffImage(webpVp8l(1024, 768))).toEqual({ type: "image/webp", ext: "webp", width: 1024, height: 768 });
    expect(sniffImage(webpVp8x(2560, 1440))).toEqual({ type: "image/webp", ext: "webp", width: 2560, height: 1440 });
  });
  it("refuses anything else", () => {
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImage(Buffer.from("%PDF-1.4 ..."))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

describe("multipartFiles", () => {
  it("returns every part body, without the trailing CRLF", () => {
    const body = Buffer.from(
      [
        "--B",
        'content-disposition: form-data; name="file"; filename="a.png"',
        "content-type: image/png",
        "",
        "AAA",
        "--B",
        'content-disposition: form-data; name="file"; filename="b.png"',
        "",
        "BBBB",
        "--B--",
        "",
      ].join("\r\n"),
    );
    expect(multipartFiles(body, "multipart/form-data; boundary=B").map(String)).toEqual(["AAA", "BBBB"]);
  });
});

describe("attachments API", () => {
  /** A Buffer as fetch wants it (the Node typings want an ArrayBuffer-backed view). */
  const bytes = (b: Buffer): Uint8Array<ArrayBuffer> =>
    new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer);
  const upload = (buf: Buffer, type = "image/png") =>
    fetch(`${app.url}${ROUTES.ui.attachments}`, {
      method: "POST",
      headers: { "content-type": type },
      body: bytes(buf),
    });

  it("uploads, serves and deletes an image; the reference names path, URL and size", async () => {
    const res = await upload(png(1440, 900));
    expect(res.status).toBe(201);
    const a = (await res.json()) as Attachment;
    expect(a).toMatchObject({ type: "image/png", ext: "png", width: 1440, height: 900 });
    expect(a.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.path).toBe(path.join(tmp.dir, "attachments", `${a.id}.png`));
    expect(existsSync(a.path)).toBe(true);
    const info = app.info();
    const base = info.urls.lan[0] ?? info.urls.local;
    expect(a.url).toBe(`${base}/attachments/${a.id}.png?k=${info.uiKey}`);
    expect(a.bytes).toBeGreaterThan(100);

    const got = await fetch(`${app.url}/attachments/${a.id}.png`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(Buffer.from(await got.arrayBuffer()).equals(png(1440, 900))).toBe(true);
    const head = await fetch(`${app.url}/attachments/${a.id}.png`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(a.bytes));

    // Storage counts it.
    expect(info.storage.attachments).toBe(a.bytes);
    expect(info.storage.bytes).toBeGreaterThanOrEqual(a.bytes);

    const del = await fetch(`${app.url}/attachments/${a.id}.png`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(existsSync(a.path)).toBe(false);
    expect((await fetch(`${app.url}/attachments/${a.id}.png`)).status).toBe(404);
    expect((await fetch(`${app.url}/attachments/${a.id}.png`, { method: "DELETE" })).status).toBe(404);
    expect(app.info().storage.attachments).toBe(0);
  });

  it("reads the size of every format and stores each under its own extension", async () => {
    for (const [buf, type, ext, w, h] of [
      [gif(320, 200), "image/gif", "gif", 320, 200],
      [jpeg(4032, 3024), "image/jpeg", "jpg", 4032, 3024],
      [webpVp8(800, 600), "image/webp", "webp", 800, 600],
    ] as const) {
      const res = await upload(buf, type);
      expect(res.status).toBe(201);
      const a = (await res.json()) as Attachment;
      expect(a).toMatchObject({ type, ext, width: w, height: h });
      expect(a.path.endsWith(`.${ext}`)).toBe(true);
      expect((await fetch(`${app.url}/attachments/${a.id}.${ext}`)).headers.get("content-type")).toBe(type);
    }
  });

  it("takes multipart bodies: one file → the attachment, several → { attachments }", async () => {
    const form = new FormData();
    form.set("file", new Blob([bytes(png(10, 20))], { type: "image/png" }), "a.png");
    const one = await fetch(`${app.url}${ROUTES.ui.attachments}`, { method: "POST", body: form });
    expect(one.status).toBe(201);
    expect(await one.json()).toMatchObject({ width: 10, height: 20 });
    form.append("file", new Blob([bytes(gif(30, 40))], { type: "image/gif" }), "b.gif");
    const two = await fetch(`${app.url}${ROUTES.ui.attachments}`, { method: "POST", body: form });
    expect(two.status).toBe(201);
    const j = (await two.json()) as { attachments: Attachment[] };
    expect(j.attachments.map((a) => [a.ext, a.width])).toEqual([
      ["png", 10],
      ["gif", 30],
    ]);
  });

  it("refuses the wrong type, a lying type, and a file over the limit", async () => {
    const svg = await upload(Buffer.from("<svg/>"), "image/svg+xml");
    expect(svg.status).toBe(415);
    expect(await svg.json()).toMatchObject({ reason: "unsupported_type" });
    const lying = await upload(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png");
    expect(lying.status).toBe(400);
    expect(await lying.json()).toMatchObject({ reason: "not_an_image" });
    const big = await upload(Buffer.concat([png(2, 2), Buffer.alloc(9 * 1024 * 1024)]), "image/png");
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ reason: "too_large", limit: ATTACHMENT_MAX_BYTES });
    expect(readdirSync(path.join(tmp.dir, "attachments")).some((f) => f.endsWith(".svg"))).toBe(false);
  });

  it("wants the UI key off loopback, for the upload and for the file", async () => {
    const key = app.config().uiKey;
    const ctxFor = (method: string, pathname: string, o: { cookie?: string; query?: string }): Ctx =>
      ({
        req: { method, headers: { "content-type": "image/png", "content-length": "0" } },
        res: {},
        url: new URL(`http://x${pathname}${o.query ?? ""}`),
        params: {},
        remote: { ip: "192.168.1.9", loopback: false },
        body: async () => Buffer.alloc(0),
        json: async () => ({}),
        bearer: () => undefined,
        cookies: () => (o.cookie ? { [UI_KEY_COOKIE]: o.cookie } : {}),
      }) as unknown as Ctx;
    const post = app.router.match("POST", ROUTES.ui.attachments)!;
    expect(await post.handler(ctxFor("POST", ROUTES.ui.attachments, {}))).toMatchObject({ status: 401 });
    expect(await post.handler(ctxFor("POST", ROUTES.ui.attachments, { cookie: "nope" }))).toMatchObject({
      status: 401,
    });
    // With the key the request gets past auth (and fails on its empty body).
    expect(await post.handler(ctxFor("POST", ROUTES.ui.attachments, { cookie: key }))).toMatchObject({ status: 400 });
    const get = app.router.match("GET", "/attachments/01ARZ3NDEKTSV4RRFFQ69G5FAV.png")!;
    expect(await get.handler({ ...ctxFor("GET", "/attachments/x.png", {}), params: get.params })).toMatchObject({
      status: 401,
    });
    expect(
      await get.handler({ ...ctxFor("GET", "/attachments/x.png", { query: `?k=${key}` }), params: get.params }),
    ).toMatchObject({
      status: 404,
    });
    const del = app.router.match("DELETE", "/attachments/01ARZ3NDEKTSV4RRFFQ69G5FAV.png")!;
    expect(await del.handler({ ...ctxFor("DELETE", "/attachments/x.png", {}), params: del.params })).toMatchObject({
      status: 401,
    });
  });

  it("answers 404 for a name that is not <ulid>.<ext>, never a path", async () => {
    expect((await fetch(`${app.url}/attachments/..%2Fconfig.json`)).status).toBe(404);
    expect((await fetch(`${app.url}/attachments/config.json`)).status).toBe(404);
  });

  it("prunes files past the retention unless a stored event still names them", async () => {
    const store = AttachmentStore.for(tmp.dir);
    const info = app.info();
    const kept = store.save(png(4, 4), info);
    const gone = store.save(png(5, 5), info);
    const young = store.save(png(6, 6), info);
    const old = new Date(Date.now() - (ATTACHMENT_RETENTION_DAYS + 1) * 86400_000);
    utimesSync(kept.path, old, old);
    utimesSync(gone.path, old, old);
    // The prompt that named `kept` was framed into the session: its transcript holds the block.
    const s = new Session("with-image");
    const text = composePrompt("Make the header look like this", [kept], true);
    app.store.ingest(
      [
        s.ev("session.started", { source: "startup" }),
        s.ev("turn.transcript", { turn: 1, user: text, assistant: "ok" }),
      ],
      "http",
    );
    const removed = store.prune(path.join(tmp.dir, "events"));
    expect(removed).toEqual([`${gone.id}.png`]);
    expect(existsSync(kept.path)).toBe(true);
    expect(existsSync(gone.path)).toBe(false);
    expect(existsSync(young.path)).toBe(true);
  });
});

describe("the text block", () => {
  const a = (id: string, w: number, h: number): Attachment => ({
    id,
    type: "image/png",
    ext: "png",
    path: `/Users/m/.local/state/sessionpipe-gui/attachments/${id}.png`,
    url: `https://mac.local:7373/attachments/${id}.png?k=abc`,
    width: w,
    height: h,
    bytes: 1,
  });
  const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const B = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

  it("is the message, a blank line and one block; paths here, URLs elsewhere", () => {
    expect(composePrompt("Fix this ", [a(A, 1440, 900)], true)).toBe(
      `Fix this\n\nAttached images (open them with your file-reading tool):\n- /Users/m/.local/state/sessionpipe-gui/attachments/${A}.png (1440×900)`,
    );
    expect(composePrompt("", [a(A, 1, 2), a(B, 3, 4)], false)).toBe(
      `Attached images (fetch them; they are on the board you were messaged from):\n- https://mac.local:7373/attachments/${A}.png?k=abc (1×2)\n- https://mac.local:7373/attachments/${B}.png?k=abc (3×4)`,
    );
    expect(composePrompt("Just words", [], true)).toBe("Just words");
  });

  it("reads back the body and the images from either form", () => {
    const local = splitAttachments(composePrompt("Fix this", [a(A, 1440, 900), a(B, 10, 10)], true));
    expect(local.body).toBe("Fix this");
    expect(local.items).toEqual([
      { id: A, ext: "png", src: `/attachments/${A}.png`, width: 1440, height: 900 },
      { id: B, ext: "png", src: `/attachments/${B}.png`, width: 10, height: 10 },
    ]);
    const remote = splitAttachments(composePrompt("", [a(A, 1, 2)], false));
    expect(remote.body).toBe("");
    expect(remote.items).toEqual([{ id: A, ext: "png", src: `/attachments/${A}.png`, width: 1, height: 2 }]);
    const plain = splitAttachments("Nothing attached here");
    expect(plain).toEqual({ body: "Nothing attached here", items: [] });
    const winAttachment: Attachment = {
      ...a(A, 800, 600),
      path: `C:\\Users\\dev name\\.local\\state\\sessionpipe-gui\\attachments\\${A}.png`,
    };
    const win = splitAttachments(composePrompt("Windows path", [winAttachment], true));
    expect(win.body).toBe("Windows path");
    expect(win.items).toEqual([{ id: A, ext: "png", src: `/attachments/${A}.png`, width: 800, height: 600 }]);
  });
});

/** Keeps the Info type honest about the fields the composer reads. */
const _check = (i: Info): string | undefined => i.hostname;
void _check;
