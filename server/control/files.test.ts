// SPDX-License-Identifier: Apache-2.0
// The files a start or a prompt carries (files.ts): a picture a queued message carried is
// kept 30 days for the page to draw, while machines fetch it only until its own expiry;
// an upload that needs room makes it among the pictures only the page keeps, oldest
// first, before it is refused. And the page's own door to them, GET …/control/files/:sha.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ROUTES, UI_KEY_COOKIE } from "../../shared/api.js";
import { tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import type { Ctx } from "../http/router.js";
import { DISPLAY_KEEP_MS, FILE_TTL_MS, FileStore, fileHash } from "./files.js";

const DAY = 24 * 3600_000;
const T0 = Date.parse("2026-11-18T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
/** `n` bytes of their own (and so a hash of their own). */
const bytes = (n: number, fill: number) => Buffer.alloc(n, fill);
/** A picture's bytes as far as the store goes: it holds what it is given under its type. */
const pic = (seed: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), bytes(60, seed)]);

describe("FileStore: kept for the page", () => {
  it("a picture with displayUntil is drawn after machines may no longer fetch it, and goes once both times are over", () => {
    const tmp = tempDir();
    try {
      const fs = new FileStore(path.join(tmp.dir, "files"));
      const { sha256 } = fs.put(pic(1), "image/png", T0);
      fs.keepUntil(sha256, iso(T0 + 3600_000));
      fs.showUntil(sha256, iso(T0 + DISPLAY_KEEP_MS));
      const later = T0 + 2 * DAY;
      // Machines: the file is over (a start or a prompt naming it would be refused).
      expect(fs.has(sha256, later)).toBe(false);
      expect(fs.get(sha256, later)).toBeUndefined();
      // The page: still a picture to draw, and the sweep keeps it.
      fs.sweep(later);
      expect(fs.picture(sha256, later)).toMatchObject({ type: "image/png" });
      // An earlier time never shortens it.
      fs.showUntil(sha256, iso(T0 + DAY));
      expect(fs.picture(sha256, T0 + 29 * DAY)).toMatchObject({ type: "image/png" });
      // Both times over: gone, and the sweep takes it away.
      const over = T0 + DISPLAY_KEEP_MS + 1;
      expect(fs.picture(sha256, over)).toBe("gone");
      fs.sweep(over);
      expect(fs.picture(sha256, T0)).toBe("gone");
    } finally {
      tmp.cleanup();
    }
  });

  it("a file without displayUntil is the page's only while a machine may fetch it; another type is no picture", () => {
    const tmp = tempDir();
    try {
      const fs = new FileStore(path.join(tmp.dir, "files"));
      const picture = fs.put(pic(2), "image/png", T0).sha256;
      const notes = fs.put(Buffer.from("notes"), "text/plain", T0).sha256;
      expect(fs.picture(picture, T0 + 1000)).toMatchObject({ type: "image/png", size: pic(2).length });
      expect(fs.picture(notes, T0 + 1000)).toBe("not_a_picture");
      expect(fs.picture(picture, T0 + FILE_TTL_MS + 1)).toBe("gone");
      expect(fs.picture("A".repeat(43), T0)).toBe("gone");
      expect(fs.picture("../../etc/passwd", T0)).toBe("gone");
    } finally {
      tmp.cleanup();
    }
  });

  it("uploading the same bytes again keeps the page's time", () => {
    const tmp = tempDir();
    try {
      const fs = new FileStore(path.join(tmp.dir, "files"));
      const { sha256 } = fs.put(pic(3), "image/png", T0);
      fs.showUntil(sha256, iso(T0 + DISPLAY_KEEP_MS));
      fs.put(pic(3), "image/png", T0 + DAY);
      expect(fs.picture(sha256, T0 + 20 * DAY)).toMatchObject({ type: "image/png" });
    } finally {
      tmp.cleanup();
    }
  });
});

describe("FileStore: making room", () => {
  /** A store of 1000 bytes holding three 300-byte pictures only the page keeps (their
   *  machine time over), kept until day 10, 5 and 20. */
  function full(dir: string) {
    const fs = new FileStore(path.join(dir, "files"), 1000);
    const shas = [1, 2, 3].map((i) => fs.put(bytes(300, i), "image/png", T0).sha256);
    fs.showUntil(shas[0]!, iso(T0 + 10 * DAY));
    fs.showUntil(shas[1]!, iso(T0 + 5 * DAY));
    fs.showUntil(shas[2]!, iso(T0 + 20 * DAY));
    return { fs, shas, now: T0 + 2 * DAY };
  }

  it("an upload past the cap removes the files only the page keeps, the one kept the shortest first", () => {
    const tmp = tempDir();
    try {
      const { fs, shas, now } = full(tmp.dir);
      // 900 held, 200 more: one has to go, and it is the one kept until day 5.
      fs.put(bytes(200, 9), "image/png", now);
      expect(shas.map((s) => fs.picture(s, now) !== "gone")).toEqual([true, false, true]);
      // 800 held, 500 more: two more go, day 10 before day 20... but only as many as needed.
      fs.put(bytes(450, 8), "image/png", now);
      expect(shas.map((s) => fs.picture(s, now) !== "gone")).toEqual([false, false, true]);
    } finally {
      tmp.cleanup();
    }
  });

  it("never removes a file a machine may still fetch, and is full only once nothing it may remove is enough", () => {
    const tmp = tempDir();
    try {
      const { fs, shas, now } = full(tmp.dir);
      // A file a queued message still needs: never made room from.
      const needed = fs.put(bytes(100, 7), "text/plain", now).sha256;
      // 1000 held, of them 900 only the page keeps: 950 more can't be had.
      expect(() => fs.put(bytes(950, 6), "image/png", now)).toThrow(new RangeError("full"));
      // Nothing went for an upload that was refused anyway.
      expect(shas.every((s) => fs.picture(s, now) !== "gone")).toBe(true);
      // 900 can: every picture only the page keeps goes, the needed file stays.
      fs.put(bytes(900, 5), "image/png", now);
      expect(shas.every((s) => fs.picture(s, now) === "gone")).toBe(true);
      expect(fs.has(needed, now)).toBe(true);
      // Now it is full of files machines may fetch: the next upload is refused. (Exactly
      // RangeError("full"): the upload route answers 507 for that one, and for a full disk.)
      expect(() => fs.put(bytes(10, 4), "image/png", now)).toThrow(new RangeError("full"));
    } finally {
      tmp.cleanup();
    }
  });
});

describe("GET /api/ui/control/files/:sha", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  let fs: FileStore;
  const url = (sha: string) => `${app.url}${ROUTES.ui.control}/files/${sha}`;

  beforeAll(async () => {
    tmp = tempDir();
    const web = path.join(tmp.dir, "web");
    mkdirSync(web, { recursive: true });
    writeFileSync(path.join(web, "index.html"), "<!doctype html><title>board</title>");
    app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, webDir: web });
    fs = new FileStore(path.join(tmp.dir, "control", "files"));
  }, 60_000);
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  it("answers a picture as itself, drawn as nothing else", async () => {
    const kiwi = pic(4);
    const res = await fetch(url(fs.put(kiwi, "image/png").sha256));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(kiwi)).toBe(true);
    const want = {
      "content-type": "image/png",
      "content-length": String(kiwi.length),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
    };
    for (const [name, value] of Object.entries(want)) expect([name, res.headers.get(name)]).toEqual([name, value]);
  });

  it("each of the four picture types; any other type is not_a_picture", async () => {
    for (const type of ["image/jpeg", "image/gif", "image/webp"]) {
      const b = bytes(64, type.length);
      const sha = fs.put(b, type).sha256;
      const res = await fetch(url(sha));
      expect([type, res.status, res.headers.get("content-type")]).toEqual([type, 200, type]);
    }
    for (const type of ["text/plain", "image/svg+xml", "text/html", "application/pdf"]) {
      const sha = fs.put(Buffer.from(`<svg onload=alert(1)> ${type}`), type).sha256;
      const res = await fetch(url(sha));
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ reason: "not_a_picture" });
    }
  });

  it("gone once it is kept no more, and for a hash never held; kept on for the page after a machine's time", async () => {
    const old = pic(5);
    const sha = fs.put(old, "image/png", Date.now() - 2 * DAY).sha256;
    const gone = await fetch(url(sha));
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ reason: "gone" });
    const never = await fetch(url(fileHash(Buffer.from("never uploaded"))));
    expect(never.status).toBe(404);
    expect(await never.json()).toMatchObject({ reason: "gone" });
    // A picture a queued message carried: the page still draws it.
    const shown = fs.put(pic(6), "image/png", Date.now() - 2 * DAY).sha256;
    fs.showUntil(shown, iso(Date.now() + DISPLAY_KEEP_MS));
    expect((await fetch(url(shown))).status).toBe(200);
    // The machines' own door still reads the machine's time only.
    expect((await fetch(`${app.url}${ROUTES.control}/files/${shown}`)).status).toBe(401);
    expect(fs.get(shown)).toBeUndefined();
  });

  it("a picture that can't be read once its answer has begun ends that answer, and the receiver stays up", async () => {
    const sha = fs.put(pic(8), "image/png").sha256;
    // Its bytes replaced by what can't be read as a file (as a file removed between the
    // check and the open is): the check still finds it, the read fails.
    const bytesAt = path.join(tmp.dir, "control", "files", sha);
    rmSync(bytesAt);
    mkdirSync(bytesAt);
    const read = await fetch(url(sha)).then(
      (r) => r.arrayBuffer().then(() => "whole"),
      () => "ended",
    );
    expect(read).toBe("ended");
    rmSync(bytesAt, { recursive: true });
    // The receiver answers on.
    const next = pic(9);
    const ok = await fetch(url(fs.put(next, "image/png").sha256));
    expect(Buffer.from(await ok.arrayBuffer()).equals(next)).toBe(true);
  });

  it("wants the UI key off loopback", async () => {
    const sha = fs.put(pic(7), "image/png").sha256;
    const key = app.config().uiKey;
    const route = app.router.match("GET", `${ROUTES.ui.control}/files/${sha}`)!;
    const ctxFor = (o: { cookie?: string }): Ctx =>
      ({
        req: { method: "GET", headers: {} },
        res: { writeHead: () => {}, end: () => {}, on: () => {}, once: () => {}, emit: () => {}, write: () => true },
        url: new URL(`http://x${ROUTES.ui.control}/files/${sha}`),
        params: route.params,
        remote: { ip: "192.0.2.9", loopback: false },
        bearer: () => undefined,
        cookies: () => (o.cookie ? { [UI_KEY_COOKIE]: o.cookie } : {}),
      }) as unknown as Ctx;
    const status = async (ctx: Ctx) => {
      try {
        await route.handler(ctx);
        return 200;
      } catch (e) {
        return (e as { status?: number }).status;
      }
    };
    expect(await status(ctxFor({}))).toBe(401);
    expect(await status(ctxFor({ cookie: "nope" }))).toBe(401);
    // With the key it gets past auth; a hash not held is gone.
    const goneCtx = { ...ctxFor({ cookie: key }), params: { sha: "A".repeat(43) } } as Ctx;
    expect(await status(goneCtx)).toBe(404);
  });
});

describe("POST /api/ui/control/files", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a files folder it cannot write is a 500 the page says as not saved, never full",
    async () => {
      const tmp = tempDir();
      const web = path.join(tmp.dir, "web");
      mkdirSync(web, { recursive: true });
      writeFileSync(path.join(web, "index.html"), "<!doctype html><title>board</title>");
      const app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, webDir: web });
      const files = path.join(tmp.dir, "control", "files");
      mkdirSync(files, { recursive: true });
      const logged = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        chmodSync(files, 0o500);
        const res = await fetch(`${app.url}${ROUTES.ui.control}/files?name=notes.txt`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "notes",
        });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ reason: "internal" });
        // The cause is in the receiver's log, not in the answer.
        expect(logged.mock.calls.map(([s]) => String(s)).join("")).toMatch(/EACCES/);
      } finally {
        logged.mockRestore();
        chmodSync(files, 0o700);
        await app.close();
        tmp.cleanup();
      }
    },
    60_000,
  );

  it("a disk with no room left is still full: 507, never a path", async () => {
    const tmp = tempDir();
    const web = path.join(tmp.dir, "web");
    mkdirSync(web, { recursive: true });
    writeFileSync(path.join(web, "index.html"), "<!doctype html><title>board</title>");
    const app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, webDir: web });
    const put = vi.spyOn(FileStore.prototype, "put").mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    });
    try {
      const res = await fetch(`${app.url}${ROUTES.ui.control}/files?name=notes.txt`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "notes",
      });
      expect(res.status).toBe(507);
      expect(await res.json()).toEqual({ reason: "full", error: "The disk this board keeps files on is full." });
    } finally {
      put.mockRestore();
      await app.close();
      tmp.cleanup();
    }
  });
});
