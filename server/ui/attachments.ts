// SPDX-License-Identifier: Apache-2.0
// Images sent beside a control prompt (shared/attachments.ts). The composer uploads one
// here (POST /api/ui/attachments), the prompt text names it by path or URL, and the
// file is served back (GET /attachments/<id>.<ext>) to this board's browsers and to the
// agent on another machine. Files live under <stateDir>/attachments (dir 0700, files
// 0600), are validated by their magic bytes (never by the declared type alone), and
// are pruned after ATTACHMENT_RETENTION_DAYS unless a stored event still names them.
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { ulid } from "sessionpipe-core";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  ATTACHMENTS_PER_MESSAGE,
  type Attachment,
  type AttachmentType,
  type Info,
  ROUTES,
  UI_KEY_PARAM,
} from "../../shared/api.js";
import { attachmentIdsIn } from "../../shared/attachments.js";
import type { Handler, Reply, Router } from "../http/router.js";
import { readLines } from "../store/files.js";

export const ATTACHMENT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 3600_000;
/** `<ulid>.<ext>`: the only file names the routes answer for. */
const FILE_RE = /^([0-9A-HJKMNP-TV-Z]{26})\.(png|jpg|gif|webp)$/;
const TYPE_OF_EXT: Record<string, AttachmentType> = Object.fromEntries(
  Object.entries(ATTACHMENT_TYPES).map(([t, e]) => [e, t as AttachmentType]),
);
/** Headroom over the image for multipart boundaries and part headers. */
const MULTIPART_SLACK = 64 * 1024;

export interface ImageInfo {
  type: AttachmentType;
  ext: Attachment["ext"];
  width: number;
  height: number;
}

/** The format and pixel size from the first bytes of a file; null when it is not one
 *  of the four image types. PNG IHDR, GIF logical screen, JPEG SOFn, WebP VP8/VP8L/VP8X. */
export function sniffImage(buf: Buffer): ImageInfo | null {
  if (buf.length >= 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: "image/png", ext: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && (buf.toString("latin1", 0, 6) === "GIF87a" || buf.toString("latin1", 0, 6) === "GIF89a")) {
    return { type: "image/gif", ext: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof)
        return { type: "image/jpeg", ext: "jpg", width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      if (marker === 0xd9 || marker === 0xda) return null;
      i += 2 + len;
    }
    return null;
  }
  if (buf.length >= 30 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8 ") {
      return {
        type: "image/webp",
        ext: "webp",
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === "VP8L" && buf[20] === 0x2f) {
      const b = buf.readUInt32LE(21);
      return { type: "image/webp", ext: "webp", width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") {
      return {
        type: "image/webp",
        ext: "webp",
        width: buf.readUIntLE(24, 3) + 1,
        height: buf.readUIntLE(27, 3) + 1,
      };
    }
  }
  return null;
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.reason));
  }
}

const stores = new Map<string, AttachmentStore>();

export class AttachmentStore {
  readonly dir: string;
  private bytesCache: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "attachments");
  }

  /** One store per state dir, so the Info builder and the routes share the byte count. */
  static for(stateDir: string): AttachmentStore {
    let s = stores.get(stateDir);
    if (!s) {
      s = new AttachmentStore(stateDir);
      stores.set(stateDir, s);
    }
    return s;
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Validate and write one image; the reference the client puts into the prompt. */
  save(buf: Buffer, info: Info): Attachment {
    if (buf.length > ATTACHMENT_MAX_BYTES)
      throw new UploadError(413, { reason: "too_large", bytes: buf.length, limit: ATTACHMENT_MAX_BYTES });
    const img = sniffImage(buf);
    if (!img) throw new UploadError(400, { reason: "not_an_image", accepted: Object.keys(ATTACHMENT_TYPES) });
    this.ensureDir();
    const id = ulid();
    const name = `${id}.${img.ext}`;
    const file = path.join(this.dir, name);
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, buf);
    } finally {
      closeSync(fd);
    }
    if (this.bytesCache !== null) this.bytesCache += buf.length;
    return {
      id,
      type: img.type,
      ext: img.ext,
      path: file,
      url: `${publicBase(info)}${ROUTES.attachments}/${name}?${UI_KEY_PARAM}=${encodeURIComponent(info.uiKey)}`,
      width: img.width,
      height: img.height,
      bytes: buf.length,
    };
  }

  /** The absolute path of a stored file, or null for a name that is not ours or is gone. */
  file(name: string): { file: string; type: AttachmentType; size: number } | null {
    const m = FILE_RE.exec(name);
    if (!m) return null;
    const file = path.join(this.dir, name);
    try {
      const st = statSync(file);
      return st.isFile() ? { file, type: TYPE_OF_EXT[m[2]!]!, size: st.size } : null;
    } catch {
      return null;
    }
  }

  remove(name: string): boolean {
    const f = this.file(name);
    if (!f) return false;
    rmSync(f.file, { force: true });
    if (this.bytesCache !== null) this.bytesCache -= f.size;
    return true;
  }

  /** Bytes on disk under the attachments dir (cached; kept current by save/remove/prune). */
  bytes(): number {
    if (this.bytesCache === null) {
      let n = 0;
      for (const e of this.list()) n += e.size;
      this.bytesCache = n;
    }
    return this.bytesCache;
  }

  list(): { name: string; size: number; mtimeMs: number }[] {
    if (!existsSync(this.dir)) return [];
    const out: { name: string; size: number; mtimeMs: number }[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!FILE_RE.test(name)) continue;
      try {
        const st = statSync(path.join(this.dir, name));
        if (st.isFile()) out.push({ name, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // gone between readdir and stat
      }
    }
    return out;
  }

  /** Delete files older than the retention that no stored event names any more. The
   *  event files (`<stateDir>/events/**\/*.jsonl`) are read for references only when
   *  there is a candidate. Returns the names removed. */
  prune(eventsDir: string, now = Date.now()): string[] {
    const cutoff = now - ATTACHMENT_RETENTION_DAYS * DAY_MS;
    const old = this.list().filter((e) => e.mtimeMs < cutoff);
    if (old.length === 0) return [];
    const referenced = referencedIds(eventsDir);
    const removed: string[] = [];
    for (const e of old) {
      if (referenced.has(e.name.slice(0, 26))) continue;
      if (this.remove(e.name)) removed.push(e.name);
    }
    return removed;
  }

  /** Prune now and once a day; the timer never keeps the process alive. */
  schedulePruning(eventsDir: string): void {
    if (this.timer) return;
    const run = () => {
      try {
        this.prune(eventsDir);
      } catch (e) {
        process.stderr.write(`[sessionpipe-gui] attachments prune: ${(e as Error).message}\n`);
      }
    };
    run();
    this.timer = setInterval(run, DAY_MS);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    stores.delete(path.dirname(this.dir));
  }
}

/** Every attachment id any stored event line mentions. */
function referencedIds(eventsDir: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(eventsDir)) return ids;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.isFile() && name.name.endsWith(".jsonl")) {
        try {
          readLines(p, (text) => {
            if (text.includes("attachments")) {
              for (const id of attachmentIdsIn(text)) ids.add(id);
            }
          });
        } catch {
          // a file being rewritten; the next daily pass sees it
        }
      }
    }
  };
  walk(eventsDir);
  return ids;
}

/** Where another machine fetches from: the https origin with TLS on, else the LAN URL. */
function publicBase(info: Info): string {
  return info.urls.https ?? info.urls.lan[0] ?? info.urls.local;
}

/** The file parts of a multipart/form-data body, by boundary; names and field names
 *  are ignored, every part with a body counts. */
export function multipartFiles(body: Buffer, contentType: string): Buffer[] {
  const m = /boundary="?([^";]+)"?/i.exec(contentType);
  if (!m) throw new UploadError(400, { reason: "malformed", detail: "multipart without a boundary" });
  const delim = Buffer.from(`--${m[1]}`);
  const files: Buffer[] = [];
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    pos += delim.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // the closing "--"
    const headEnd = body.indexOf("\r\n\r\n", pos);
    if (headEnd < 0) break;
    const next = body.indexOf(delim, headEnd + 4);
    if (next < 0) break;
    // The part body ends with the CRLF that precedes the next boundary.
    const part = body.subarray(headEnd + 4, next - 2);
    if (part.length > 0) files.push(part);
    pos = next;
  }
  return files;
}

export interface AttachmentDeps {
  info: () => Info;
  /** The store (one per state dir); made from `info().storage.dir` when absent. */
  store?: AttachmentStore;
}

/** POST /api/ui/attachments, GET + DELETE /attachments/:file, all behind `guard` (uiAuth). */
export function registerAttachments(router: Router, deps: AttachmentDeps, guard: (h: Handler) => Handler): void {
  const store = (): AttachmentStore => deps.store ?? AttachmentStore.for(deps.info().storage.dir);
  // Retention runs now and daily; only files past the cutoff cost a read of the event files.
  store().schedulePruning(path.join(deps.info().storage.dir, "events"));

  router.post(
    ROUTES.ui.attachments,
    guard(async (ctx): Promise<Reply> => {
      const type = String(ctx.req.headers["content-type"] ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      const declared = Number(ctx.req.headers["content-length"] ?? 0);
      const multipart = type === "multipart/form-data";
      const limit = multipart ? ATTACHMENTS_PER_MESSAGE * ATTACHMENT_MAX_BYTES + MULTIPART_SLACK : ATTACHMENT_MAX_BYTES;
      if (!multipart && !(type in ATTACHMENT_TYPES))
        return { status: 415, json: { reason: "unsupported_type", accepted: Object.keys(ATTACHMENT_TYPES) } };
      if (declared > limit)
        return { status: 413, json: { reason: "too_large", bytes: declared, limit: ATTACHMENT_MAX_BYTES } };
      let body: Buffer;
      try {
        body = await ctx.body(limit);
      } catch (e) {
        if ((e as { status?: number }).status === 413)
          return { status: 413, json: { reason: "too_large", limit: ATTACHMENT_MAX_BYTES } };
        throw e;
      }
      try {
        const info = deps.info();
        if (!multipart) return { status: 201, json: store().save(body, info) };
        const parts = multipartFiles(body, String(ctx.req.headers["content-type"]));
        if (parts.length === 0) return { status: 400, json: { reason: "malformed", detail: "no file part" } };
        if (parts.length > ATTACHMENTS_PER_MESSAGE)
          return { status: 400, json: { reason: "too_many", limit: ATTACHMENTS_PER_MESSAGE } };
        const saved = parts.map((p) => store().save(p, info));
        return { status: 201, json: saved.length === 1 ? saved[0] : { attachments: saved } };
      } catch (e) {
        if (e instanceof UploadError) return { status: e.status, json: e.body };
        throw e;
      }
    }),
  );

  const serve: Handler = guard((ctx): Reply | undefined => {
    const f = store().file(ctx.params.file!);
    if (!f) return { status: 404, json: { reason: "not_found" } };
    ctx.res.writeHead(200, {
      "content-type": f.type,
      "content-length": String(f.size),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    if (ctx.req.method === "HEAD") {
      ctx.res.end();
      return undefined;
    }
    createReadStream(f.file).pipe(ctx.res);
    return undefined;
  });
  router.get(`${ROUTES.attachments}/:file`, serve);
  router.add("HEAD", `${ROUTES.attachments}/:file`, serve);
  router.add(
    "DELETE",
    `${ROUTES.attachments}/:file`,
    guard(
      (ctx): Reply =>
        store().remove(ctx.params.file!) ? { status: 204, text: "" } : { status: 404, json: { reason: "not_found" } },
    ),
  );
}
