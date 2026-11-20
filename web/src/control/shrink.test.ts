// SPDX-License-Identifier: Apache-2.0
// The one shrink before every upload (shrink.ts): the plan and the keep rule as spacesheep
// decides them (the vectors marked "shared" are also in spacesheep's image-shrink.test.ts),
// HEIC always redrawn as JPEG, a JPEG's location found in its Exif, and the browser half
// against a stand-in decoder and canvas: WebP, else JPEG; a HEIC that can't be drawn
// refused in words; any other picture sent as it is.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HEIC_WORDS,
  jpegHasGps,
  jpegWithoutApp1,
  NOT_A_PICTURE_WORDS,
  OVER_INPUT_WORDS,
  PICKER_DESK,
  PICKER_TOUCH,
  pictureType,
  refuseInput,
  ShrinkRefused,
  shrinkImage,
  shrinkKeep,
  shrinkPlan,
  shrinkTypes,
  stillOverWords,
} from "./shrink";

const KB = 1000;
const MB = 1000 * 1000;

describe("shrinkPlan (shared vectors)", () => {
  it("leaves a small PNG alone", () => {
    expect(shrinkPlan("image/png", 150 * KB, 1280, 800)).toBeNull();
  });
  it("draws a 30.7 MB 3200×3200 PNG at 2560×2560", () => {
    expect(shrinkPlan("image/png", 30.7 * MB, 3200, 3200)).toEqual({ width: 2560, height: 2560 });
  });
  it("draws a 13.5 MB 4032×3024 photo and a 5 MB 4000×3000 one at 2560×1920", () => {
    expect(shrinkPlan("image/jpeg", 13.5 * MB, 4032, 3024)).toEqual({ width: 2560, height: 1920 });
    expect(shrinkPlan("image/jpeg", 5 * MB, 4000, 3000)).toEqual({ width: 2560, height: 1920 });
  });
  it("never touches a GIF (it may be animated)", () => {
    expect(shrinkPlan("image/gif", 3 * MB, 1080, 2404)).toBeNull();
    expect(shrinkPlan("image/gif", 3 * MB, 1, 1)).toBeNull();
  });
  it("redraws a 400 KB WebP at its own size", () => {
    expect(shrinkPlan("image/webp", 400 * KB, 1000, 1000)).toEqual({ width: 1000, height: 1000 });
  });
  it("always redraws a HEIC, as JPEG", () => {
    expect(shrinkPlan("image/heic", 3.4 * MB, 4032, 3024)).toEqual({ width: 2560, height: 1920 });
    expect(shrinkPlan("image/heic", 50 * KB, 640, 480)).toEqual({ width: 640, height: 480 });
    expect(shrinkPlan("image/heif", 50 * KB, 1, 1)).toEqual({ width: 1, height: 1 });
    expect(shrinkTypes("image/heic")).toEqual(["image/jpeg"]);
  });
  it("tries WebP first, then JPEG; JPEG alone for a model that reads no WebP", () => {
    expect(shrinkTypes("image/png")).toEqual(["image/webp", "image/jpeg"]);
    expect(shrinkTypes("image/png", true)).toEqual(["image/jpeg"]);
    expect(shrinkPlan("image/webp", 50 * KB, 800, 600)).toBeNull();
    expect(shrinkPlan("image/webp", 50 * KB, 800, 600, true)).toEqual({ width: 800, height: 600 });
  });
  it("answers for type and bytes alone at 1×1, and refuses one it could not measure", () => {
    expect(shrinkPlan("image/png", 2 * MB, 1, 1)).not.toBeNull();
    expect(shrinkPlan("image/png", 100 * KB, 1, 1)).toBeNull();
    expect(shrinkPlan("image/png", 2 * MB, 0, 0)).toBeNull();
    expect(shrinkPlan("application/pdf", 5 * MB, 1080, 2404)).toBeNull();
  });
});

describe("shrinkKeep (shared vectors)", () => {
  it("sends a same-size redraw only when it saves a fifth", () => {
    expect(shrinkKeep(2_000_000, 400_000, false)).toBe(true);
    expect(shrinkKeep(2_000_000, 1_700_000, false)).toBe(false);
  });
  it("sends a scaled one whenever it is smaller", () => {
    expect(shrinkKeep(2_000_000, 1_900_000, true)).toBe(true);
    expect(shrinkKeep(2_000_000, 2_100_000, true)).toBe(false);
  });
  it("always sends one that must go, and never an empty one", () => {
    expect(shrinkKeep(50_000, 90_000, false, true)).toBe(true);
    expect(shrinkKeep(2_000_000, 0, true, true)).toBe(false);
  });
});

describe("what is taken as a picture", () => {
  it("takes the four an agent reads and HEIC, also a HEIC with no type", () => {
    for (const t of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"])
      expect(pictureType(t)).toBe(t);
    expect(pictureType("", "IMG_0412.HEIC")).toBe("image/heic");
    expect(pictureType("", "scan.heif")).toBe("image/heif");
    expect(pictureType("", "notes.txt")).toBeNull();
    expect(pictureType("image/tiff", "scan.tiff")).toBeNull();
  });
  it("refuses one over 50 MB before any shrink, and says what can be sent", () => {
    const f = (size: number, type: string, name = "a") => ({ size, type, name }) as Blob & { name: string };
    expect(refuseInput(f(52_428_800, "image/jpeg"))).toBeNull();
    expect(refuseInput(f(52_428_801, "image/jpeg"))).toBe(OVER_INPUT_WORDS);
    expect(OVER_INPUT_WORDS).toBe("That picture is over 50 MB.");
    expect(refuseInput(f(10, "image/tiff"))).toBe(NOT_A_PICTURE_WORDS);
    expect(refuseInput(f(10, "", "IMG_1.heic"))).toBeNull();
  });
  it("says the cap after the shrink in megabytes", () => {
    expect(stillOverWords(26_214_400, true)).toBe("That picture is still over 25 MB after shrinking.");
    expect(stillOverWords(8 * 1024 * 1024, true)).toBe("That picture is still over 8 MB after shrinking.");
    expect(stillOverWords(26_214_400, false)).toBe("That picture is over 25 MB.");
  });
  it("offers the four on a touch screen, so the phone's sheet converts a HEIC; HEIC too on a desktop", () => {
    expect(PICKER_TOUCH).toBe("image/png,image/jpeg,image/webp,image/gif");
    expect(PICKER_DESK.split(",")).toEqual(expect.arrayContaining(["image/heic", "image/heif"]));
  });
});

// ---------- a JPEG's location ----------

/** A JPEG's first bytes: SOI, an APP1 Exif block whose IFD0 has `tags`, then a DQT and SOS. */
function jpeg(tags: [number, number][], o: { little?: boolean; before?: number[] } = {}): Uint8Array {
  const le = o.little ?? false;
  const u16 = (n: number) => (le ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) =>
    le
      ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24]
      : [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const tiff = [
    ...(le ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(tags.length),
    // tag, type LONG, count 1, value
    ...tags.flatMap(([tag, v]) => [...u16(tag), ...u16(4), ...u32(1), ...u32(v)]),
    ...u32(0),
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
  const dqt = [0xff, 0xdb, 0x00, 0x04, 0x00, 0x00];
  const sos = [0xff, 0xda, 0x00, 0x02, 0x11, 0x22];
  return Uint8Array.from([0xff, 0xd8, ...(o.before ?? []), ...app1, ...dqt, ...sos]);
}

describe("jpegHasGps", () => {
  it("finds a GPS block in either byte order", () => {
    expect(jpegHasGps(jpeg([[0x8825, 0x40]]))).toBe(true);
    expect(jpegHasGps(jpeg([[0x8825, 0x40]], { little: true }))).toBe(true);
    expect(
      jpegHasGps(
        jpeg(
          [
            [0x0112, 1],
            [0x8769, 0x30],
            [0x8825, 0x90],
          ],
          { little: true },
        ),
      ),
    ).toBe(true);
  });
  it("after a JFIF block, too", () => {
    const jfif = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    expect(jpegHasGps(jpeg([[0x8825, 0x40]], { before: jfif }))).toBe(true);
  });
  it("finds none in a photo without one, one whose pointer is zero, or one cut short", () => {
    expect(jpegHasGps(jpeg([[0x0112, 1]]))).toBe(false);
    expect(jpegHasGps(jpeg([[0x8825, 0]]))).toBe(false);
    expect(jpegHasGps(jpeg([[0x8825, 0x40]]).subarray(0, 20))).toBe(false);
    expect(jpegHasGps(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBe(false);
  });
  it("reads no other kind of file", () => {
    expect(jpegHasGps(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
    expect(jpegHasGps(new Uint8Array(0))).toBe(false);
  });
});

// ---------- the browser half, against stand-ins ----------

interface Engine {
  /** Decoded size, or "fail" for a picture it can't read. */
  decode: { width: number; height: number } | "fail";
  /** What the canvas writes for a type asked for: its type and size (Safari: PNG for WebP). */
  write: (type: string, w: number, h: number) => { type: string; size: number } | null;
}

function stub(e: Engine): { drawn: { w: number; h: number }[]; asked: string[] } {
  const drawn: { w: number; h: number }[] = [];
  const asked: string[] = [];
  vi.stubGlobal("createImageBitmap", async () => {
    if (e.decode === "fail") throw new Error("decode");
    return { ...e.decode, close() {} };
  });
  // No <img> to fall back to: a decode failure is a failure.
  vi.stubGlobal("Image", undefined);
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {
        drawn.push({ w: width, h: height });
      }
      getContext() {
        return { fillRect() {}, drawImage() {}, fillStyle: "" };
      }
      async convertToBlob(o: { type: string }) {
        asked.push(o.type);
        const out = e.write(o.type, this.width, this.height);
        return out ? new Blob([new Uint8Array(out.size)], { type: out.type }) : null;
      }
    },
  );
  return { drawn, asked };
}

const file = (size: number, type: string, name: string, head?: Uint8Array) => {
  const bytes = new Uint8Array(size);
  if (head) bytes.set(head);
  return new File([bytes], name, { type });
};

describe("shrinkImage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("draws a 13.5 MB photo at 2560×1920 as WebP", async () => {
    const s = stub({ decode: { width: 4032, height: 3024 }, write: (t) => ({ type: t, size: 2_100_000 }) });
    const out = await shrinkImage(file(13_500_000, "image/jpeg", "kiwi.jpg"));
    expect(s.drawn).toEqual([{ w: 2560, h: 1920 }]);
    expect(s.asked).toEqual(["image/webp"]);
    expect(out).toMatchObject({ type: "image/webp", width: 2560, height: 1920 });
    expect(out!.blob.size).toBe(2_100_000);
  });

  it("writes JPEG where the engine hands back a PNG for WebP (Safari)", async () => {
    const s = stub({
      decode: { width: 3200, height: 3200 },
      write: (t) => (t === "image/webp" ? { type: "image/png", size: 9_000_000 } : { type: t, size: 1_500_000 }),
    });
    const out = await shrinkImage(file(30_700_000, "image/png", "huge.png"));
    expect(s.asked).toEqual(["image/webp", "image/jpeg"]);
    expect(out).toMatchObject({ type: "image/jpeg", width: 2560, height: 2560 });
  });

  it("does not decode a small picture or a GIF at all", async () => {
    const s = stub({ decode: "fail", write: () => null });
    expect(await shrinkImage(file(150_000, "image/png", "a.png"))).toBeNull();
    expect(await shrinkImage(file(3_000_000, "image/gif", "a.gif"))).toBeNull();
    expect(s.drawn).toEqual([]);
  });

  it("sends the original where the redraw saves too little", async () => {
    stub({ decode: { width: 1000, height: 1000 }, write: (t) => ({ type: t, size: 390_000 }) });
    expect(await shrinkImage(file(400_000, "image/webp", "a.webp"))).toBeNull();
  });

  it("redraws a HEIC as JPEG, whatever it weighs, under a type it may not have had", async () => {
    const s = stub({ decode: { width: 4032, height: 3024 }, write: (t) => ({ type: t, size: 4_000_000 }) });
    const out = await shrinkImage(file(3_400_000, "", "IMG_0412.HEIC"));
    expect(s.asked).toEqual(["image/jpeg"]);
    expect(out).toMatchObject({ type: "image/jpeg", width: 2560, height: 1920 });
  });

  it("refuses a HEIC this engine can't open, in words", async () => {
    stub({ decode: "fail", write: () => null });
    const going = shrinkImage(file(3_400_000, "image/heic", "IMG_0412.heic"));
    await expect(going).rejects.toBeInstanceOf(ShrinkRefused);
    await expect(going).rejects.toThrow(HEIC_WORDS);
    expect(HEIC_WORDS).toBe(
      "This browser can't open HEIC photos. Export it as JPEG (Photos › File › Export) and attach that.",
    );
  });

  it("sends any other picture it can't open as it is", async () => {
    stub({ decode: "fail", write: () => null });
    expect(await shrinkImage(file(5_000_000, "image/png", "a.png"))).toBeNull();
  });

  it("gives up on one that takes too long, and the next one still goes", async () => {
    vi.stubGlobal("createImageBitmap", () => new Promise(() => {}));
    expect(await shrinkImage(file(5_000_000, "image/png", "slow.png"), { limitMs: 20 })).toBeNull();
    await expect(shrinkImage(file(5_000_000, "image/heic", "slow.heic"), { limitMs: 20 })).rejects.toThrow(HEIC_WORDS);
    stub({ decode: { width: 4000, height: 3000 }, write: (t) => ({ type: t, size: 1_000_000 }) });
    expect(await shrinkImage(file(5_000_000, "image/jpeg", "next.jpg"))).toMatchObject({ width: 2560 });
  });

  it("takes the metadata out of a JPEG that says where it was taken when it can't be redrawn", async () => {
    // A frame header of 800×600, an XMP block beside the Exif one, then the scan's bytes.
    const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    const xmp = [0xff, 0xe1, 0x00, 0x0a, ...Array.from("http://", (c) => c.charCodeAt(0)), 0];
    const head = jpeg([[0x8825, 0x40]], { before: [...sof, ...xmp] });
    const scan = Uint8Array.from({ length: 4000 }, (_, i) => (i * 7) & 0x7f);
    const located = new File([head as Uint8Array<ArrayBuffer>, scan], "here.jpg", { type: "image/jpeg" });
    const bare = async (out: Awaited<ReturnType<typeof shrinkImage>>) => {
      expect(out).toMatchObject({ type: "image/jpeg", width: 800, height: 600 });
      const b = new Uint8Array(await out!.blob.arrayBuffer());
      // Not one APP1 segment before the scan; the scan and all after it as they were.
      const sos = b.findIndex((x, i) => x === 0xff && b[i + 1] === 0xda);
      expect(b.subarray(0, sos).some((x, i) => x === 0xff && b[i + 1] === 0xe1)).toBe(false);
      expect(jpegHasGps(b)).toBe(false);
      const was = new Uint8Array(await located.arrayBuffer());
      const wasSos = was.findIndex((x, i) => x === 0xff && was[i + 1] === 0xda);
      expect(Array.from(b.subarray(sos))).toEqual(Array.from(was.subarray(wasSos)));
      expect(Array.from(b.subarray(0, 2 + sof.length))).toEqual(Array.from(was.subarray(0, 2 + sof.length)));
    };
    // The engine can't decode it.
    stub({ decode: "fail", write: () => null });
    await bare(await shrinkImage(located));
    // It takes longer than the limit.
    vi.stubGlobal("createImageBitmap", () => new Promise(() => {}));
    await bare(await shrinkImage(located, { limitMs: 20 }));
  });

  it("finds a JPEG's size in its frame header, and leaves one without APP1 as it was", () => {
    const plain = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0, 0, 0xff, 0xda, 0x00, 0x02, 1, 2]);
    expect(jpegWithoutApp1(plain)).toEqual({ bytes: plain, width: 0, height: 0 });
    const stripped = jpegWithoutApp1(jpeg([[0x8825, 0x40]]));
    expect(Array.from(stripped.bytes)).toEqual([
      0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0, 0, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22,
    ]);
  });

  it("always redraws a small JPEG that says where it was taken, and keeps the redraw", async () => {
    const s = stub({ decode: { width: 800, height: 600 }, write: (t) => ({ type: t, size: 90_000 }) });
    const located = file(60_000, "image/jpeg", "here.jpg", jpeg([[0x8825, 0x40]]));
    expect(await shrinkImage(located)).toMatchObject({ type: "image/webp", width: 800, height: 600 });
    // The same photo without one is small enough as it is.
    expect(await shrinkImage(file(60_000, "image/jpeg", "there.jpg", jpeg([[0x0112, 1]])))).toBeNull();
    expect(s.drawn).toEqual([{ w: 800, h: 600 }]);
  });

  it("shrinks one picture at a time", async () => {
    let decoding = 0;
    let most = 0;
    stub({ decode: { width: 4000, height: 3000 }, write: (t) => ({ type: t, size: 1_000_000 }) });
    vi.stubGlobal("createImageBitmap", async () => {
      decoding++;
      most = Math.max(most, decoding);
      await new Promise((r) => setTimeout(r, 10));
      decoding--;
      return { width: 4000, height: 3000, close() {} };
    });
    await Promise.all([1, 2, 3].map((i) => shrinkImage(file(5_000_000, "image/jpeg", `${i}.jpg`))));
    expect(most).toBe(1);
  });

  it("starts the next decode only once a redraw past the limit has ended", async () => {
    stub({ decode: { width: 4000, height: 3000 }, write: (t) => ({ type: t, size: 1_000_000 }) });
    const log: string[] = [];
    let n = 0;
    vi.stubGlobal("createImageBitmap", async () => {
      const i = ++n;
      log.push(`decode ${i}`);
      // The first goes on past the limit; the caller hears "as it is" at the limit.
      await new Promise((r) => setTimeout(r, i === 1 ? 32 : 1));
      log.push(`decoded ${i}`);
      return { width: 4000, height: 3000, close() {} };
    });
    const first = shrinkImage(file(5_000_000, "image/png", "slow.png"), { limitMs: 20 });
    const second = shrinkImage(file(5_000_000, "image/jpeg", "next.jpg"), { limitMs: 200 });
    expect(await first).toBeNull();
    expect(await second).toMatchObject({ width: 2560 });
    expect(log).toEqual(["decode 1", "decoded 1", "decode 2", "decoded 2"]);
  });
});
