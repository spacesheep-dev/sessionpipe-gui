// SPDX-License-Identifier: Apache-2.0
// One shrink before every upload, for the composer and New session alike: a picture is
// redrawn at most 2560 px on its long edge, as WebP at 0.9 (JPEG where the engine can't
// write WebP, as Safari can't), so a 13 MB phone photo or a 30 MB screenshot goes at about
// 2 MB. The decision is spacesheep's own (assets/behaviors/image-shrink.ts, imageShrinkPlan
// and imageShrinkKeep, ported as they are), and the vectors in shrink.test.ts are in its
// image-shrink.test.ts too, so the two decide the same. Added here: a HEIC or HEIF is always
// redrawn, as JPEG (an agent reads none), and a JPEG that carries a location (an Exif GPS
// block) is always redrawn, which leaves its metadata behind; where it can't be, its
// metadata segments are taken out of its bytes instead.
import { type AttachmentType, PICTURE_INPUT_MAX_BYTES, PICTURE_INPUT_TYPES } from "@shared/api";

/** The long edge a picture is drawn at, at most. */
export const SHRINK_EDGE = 2560;
/** One picture's whole shrink, decode and encode, at most; then it is as if it failed. */
export const SHRINK_LIMIT_MS = 20_000;

/** A HEIC this engine cannot draw: it can't be sent as a picture. */
export const HEIC_WORDS =
  "This browser can't open HEIC photos. Export it as JPEG (Photos › File › Export) and attach that.";
/** New session keeps such a HEIC as a file, and says so under its chip. */
export const HEIC_FILE_NOTE = "The agent can't look at HEIC. Export it as JPEG to send it as a picture.";
/** Over PICTURE_INPUT_MAX_BYTES, before any shrink. */
export const OVER_INPUT_WORDS = "That picture is over 50 MB.";
/** A picture that would still go over `limit` bytes: shrunk (`shrunk`), or one that is
 *  never redrawn (a GIF) or was not made smaller. */
export const stillOverWords = (limit: number, shrunk: boolean): string =>
  shrunk
    ? `That picture is still over ${Math.round(limit / 1048576)} MB after shrinking.`
    : `That picture is over ${Math.round(limit / 1048576)} MB.`;
/** A file the page took for a picture that is none of the kinds it sends. */
export const NOT_A_PICTURE_WORDS = "Only PNG, JPEG, GIF, WebP or HEIC pictures can be sent.";

/** The picker's types. Under a finger the four an agent reads, so the iPhone's sheet hands
 *  a HEIC over as a JPEG; on a desktop HEIC too, which the page redraws itself. */
export const PICKER_TOUCH = "image/png,image/jpeg,image/webp,image/gif";
export const PICKER_DESK = `${PICKER_TOUCH},image/heic,image/heif,.heic,.heif`;

const HEIC_NAME_RE = /\.(heic|heif)$/i;
const isHeic = (type: string): boolean => type === "image/heic" || type === "image/heif";

/** The type a picture is taken as: its own where it is one of the six, HEIC for a file
 *  with no type and a .heic or .heif name; null where it is no picture this page sends. */
export function pictureType(type: string, name = ""): string | null {
  if (PICTURE_INPUT_TYPES.includes(type)) return type;
  if (!type && HEIC_NAME_RE.test(name)) return name.toLowerCase().endsWith(".heif") ? "image/heif" : "image/heic";
  return null;
}

/** Why a picture can't be taken in at all, before any shrink; null when it can. */
export function refuseInput(file: Blob & { name?: string }): string | null {
  if (!pictureType(file.type, file.name)) return NOT_A_PICTURE_WORDS;
  if (file.size > PICTURE_INPUT_MAX_BYTES) return OVER_INPUT_WORDS;
  return null;
}

/** What to redraw at, or null to send the original bytes untouched (spacesheep's
 *  imageShrinkPlan, with HEIC and HEIF always planned). `jpeg`: the picture is for a model
 *  that reads JPEG and PNG only, so a WebP is redrawn as a JPEG whatever its size. Asked at
 *  1×1 it answers for the type and the byte count alone, before any decode. */
export function shrinkPlan(
  type: string,
  bytes: number,
  width: number,
  height: number,
  jpeg = false,
): { width: number; height: number } | null {
  const heic = isHeic(type);
  // A GIF may be animated, and every other type is not a picture we can redraw.
  if (!heic && type !== "image/png" && type !== "image/jpeg" && type !== "image/webp") return null;
  if (!(width > 0 && height > 0)) return null;
  const edge = Math.max(width, height);
  const scale = edge > SHRINK_EDGE ? SHRINK_EDGE / edge : 1;
  // Small enough already: the round trip through a canvas would buy nothing.
  if (!heic && scale === 1 && bytes < 300 * 1024 && !(jpeg && type === "image/webp")) return null;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether the redrawn bytes go instead of the original (spacesheep's imageShrinkKeep): a
 *  scaled one only has to be smaller, a same-size one must save a fifth to be worth the
 *  generation loss, and one that `must` go (HEIC, a location to leave behind, a format the
 *  reader needs) always does. */
export function shrinkKeep(originalBytes: number, shrunkBytes: number, scaled: boolean, must = false): boolean {
  if (!(shrunkBytes > 0)) return false;
  if (must) return true;
  return scaled ? shrunkBytes < originalBytes : shrunkBytes < originalBytes * 0.8;
}

/** The types to encode as, in order; the first the engine really writes is used. */
export function shrinkTypes(type: string, jpeg = false): ("image/webp" | "image/jpeg")[] {
  return jpeg || isHeic(type) ? ["image/jpeg"] : ["image/webp", "image/jpeg"];
}

/** Whether a JPEG's first bytes hold an Exif block with a GPS IFD (tag 0x8825, pointing
 *  somewhere): the photo says where it was taken. Reads the markers up to the scan. */
export function jpegHasGps(b: Uint8Array): boolean {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return false;
    const m = b[i + 1]!;
    // Fill bytes, and markers with no length.
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    // The scan (or the end): no metadata after it.
    if (m === 0xda || m === 0xd9) return false;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2) return false;
    const start = i + 4;
    const end = Math.min(b.length, i + 2 + len);
    if (
      m === 0xe1 &&
      end - start > 6 &&
      b[start] === 0x45 &&
      b[start + 1] === 0x78 &&
      b[start + 2] === 0x69 &&
      b[start + 3] === 0x66 &&
      b[start + 4] === 0 &&
      b[start + 5] === 0 &&
      tiffHasGps(b.subarray(start + 6, end))
    )
      return true;
    i += 2 + len;
  }
  return false;
}

/** A JPEG without its APP1 segments before the scan (Exif and XMP both live in one, and the
 *  location with them), every other byte as it was; with the size its frame header (SOFn)
 *  says, 0×0 where it has none. Nothing is decoded: what a picture that can't be redrawn
 *  goes as, so its location stays behind all the same. */
export function jpegWithoutApp1(b: Uint8Array): { bytes: Uint8Array; width: number; height: number } {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let width = 0;
  let height = 0;
  let i = 2;
  let from = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1]!;
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    // The scan (or the end): the rest goes as it is.
    if (m === 0xda || m === 0xd9) break;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2) break;
    // SOF0–SOF15, but DHT (C4), JPG (C8) and DAC (CC): precision, height, width.
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && i + 9 <= b.length) {
      height = (b[i + 5]! << 8) | b[i + 6]!;
      width = (b[i + 7]! << 8) | b[i + 8]!;
    }
    const end = Math.min(b.length, i + 2 + len);
    if (m === 0xe1) {
      parts.push(b.subarray(from, i));
      from = end;
    }
    i = end;
  }
  parts.push(b.subarray(from));
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, width, height };
}

/** IFD0 of a TIFF header (an Exif block's body) has a GPS pointer that is not zero. */
function tiffHasGps(t: Uint8Array): boolean {
  if (t.length < 8) return false;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return false;
  const u16 = (o: number) => (le ? t[o]! | (t[o + 1]! << 8) : (t[o]! << 8) | t[o + 1]!);
  const u32 = (o: number) =>
    le
      ? (t[o]! | (t[o + 1]! << 8) | (t[o + 2]! << 16) | (t[o + 3]! << 24)) >>> 0
      : ((t[o]! << 24) | (t[o + 1]! << 16) | (t[o + 2]! << 8) | t[o + 3]!) >>> 0;
  if (u16(2) !== 42) return false;
  const ifd = u32(4);
  if (ifd + 2 > t.length) return false;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const at = ifd + 2 + k * 12;
    if (at + 12 > t.length) return false;
    if (u16(at) === 0x8825) return u32(at + 8) !== 0;
  }
  return false;
}

/** A picture redrawn: the bytes to send in place of the original, their type, and the
 *  size they were drawn at. */
export interface Shrunk {
  blob: Blob;
  type: AttachmentType;
  width: number;
  height: number;
}

/** A picture that can't be sent: its words are the message. */
export class ShrinkRefused extends Error {}

interface Decoded {
  src: CanvasImageSource;
  width: number;
  height: number;
  done(): void;
}

/** Decode, the photo's own orientation applied: createImageBitmap, else an <img>. */
async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bm = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { src: bm, width: bm.width, height: bm.height, done: () => bm.close() };
    } catch {
      // The <img> below, which reads some types a bitmap can't (HEIC in Safari).
    }
  }
  if (typeof Image !== "function") throw new Error("no decoder");
  const url = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("decode"));
      img.src = url;
    });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { src: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function canvas(width: number, height: number): { cv: AnyCanvas; cx: CanvasRenderingContext2D } | null {
  if (typeof OffscreenCanvas === "function") {
    const cv = new OffscreenCanvas(width, height);
    const cx = cv.getContext("2d") as unknown as CanvasRenderingContext2D | null;
    if (cx) return { cv, cx };
  }
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = width;
  cv.height = height;
  const cx = cv.getContext("2d");
  return cx ? { cv, cx } : null;
}

function encode(cv: AnyCanvas, type: string, quality: number): Promise<Blob | null> {
  if ("convertToBlob" in cv) return cv.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((resolve) => cv.toBlob((b) => resolve(b), type, quality));
}

/** "failed": the picture could not be drawn or written here. */
async function draw(file: Blob, type: string, jpeg: boolean, must: boolean): Promise<Shrunk | null | "failed"> {
  let d: Decoded;
  try {
    d = await decode(file);
  } catch {
    return "failed";
  }
  try {
    const plan =
      shrinkPlan(type, file.size, d.width, d.height, jpeg) ?? (must ? { width: d.width, height: d.height } : null);
    if (!plan) return null;
    const c = canvas(plan.width, plan.height);
    if (!c) return "failed";
    // A matte for a transparent PNG, since JPEG has no alpha: white, like paper.
    c.cx.fillStyle = "#fff";
    c.cx.fillRect(0, 0, plan.width, plan.height);
    c.cx.drawImage(d.src, 0, 0, plan.width, plan.height);
    const scaled = plan.width !== d.width || plan.height !== d.height;
    for (const t of shrinkTypes(type, jpeg)) {
      const b = await encode(c.cv, t, 0.9);
      // Safari hands back a PNG when asked for a WebP it cannot write: try the next.
      if (!b || b.type !== t) continue;
      return shrinkKeep(file.size, b.size, scaled, must)
        ? { blob: b, type: t, width: plan.width, height: plan.height }
        : null;
    }
    return "failed";
  } catch {
    return "failed";
  } finally {
    d.done();
  }
}

/** `drawing`: hears the redraw itself as it begins, which can go on past the limit. */
async function shrinkNow(
  file: Blob,
  o: { name?: string; jpeg?: boolean; limitMs?: number },
  drawing: (d: Promise<unknown>) => void,
): Promise<Shrunk | null> {
  const name = o.name ?? (file as Partial<File>).name ?? "";
  const type = pictureType(file.type, name);
  if (!type) return null;
  const jpeg = !!o.jpeg;
  const heic = isHeic(type);
  const gps = type === "image/jpeg" && jpegHasGps(new Uint8Array(await file.slice(0, 65_536).arrayBuffer()));
  const must = heic || gps || (jpeg && type === "image/webp");
  if (!must && !shrinkPlan(type, file.size, 1, 1, jpeg)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"failed">((resolve) => {
    timer = setTimeout(() => resolve("failed"), o.limitMs ?? SHRINK_LIMIT_MS);
  });
  const drawn = draw(file, type, jpeg, must);
  drawing(drawn);
  const out = await Promise.race([drawn, late]);
  clearTimeout(timer);
  if (out !== "failed") return out;
  // Nothing an agent reads: the HEIC can't go.
  if (heic) throw new ShrinkRefused(HEIC_WORDS);
  // A JPEG that says where it was taken goes without its metadata, the location with it.
  if (gps) {
    const bare = jpegWithoutApp1(new Uint8Array(await file.arrayBuffer()));
    return {
      blob: new Blob([bare.bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
      type: "image/jpeg",
      width: bare.width,
      height: bare.height,
    };
  }
  // Any other picture goes as it is, if it fits.
  return null;
}

let queue: Promise<unknown> = Promise.resolve();

/** The picture redrawn smaller (or without its location, or as JPEG for a HEIC), or null
 *  to send the original. Throws ShrinkRefused for a HEIC this engine can't draw. One at a
 *  time on the page, since a 48 MP photo decoded takes a phone's memory: the limit decides
 *  only what the caller gets, and the next picture waits for the last one's redraw itself
 *  to end (at most a second limit more, so a decode that never ends holds up no other). */
export function shrinkImage(
  file: Blob,
  o: { name?: string; jpeg?: boolean; limitMs?: number } = {},
): Promise<Shrunk | null> {
  let drawn: Promise<unknown> = Promise.resolve();
  const run = queue.then(() =>
    shrinkNow(file, o, (d) => {
      drawn = d;
    }),
  );
  const settled = () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise((resolve) => {
      timer = setTimeout(resolve, o.limitMs ?? SHRINK_LIMIT_MS);
    });
    return Promise.race([drawn.catch(() => undefined), late]).finally(() => clearTimeout(timer));
  };
  queue = run.then(settled, settled);
  return run;
}
