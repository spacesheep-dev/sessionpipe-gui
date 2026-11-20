// SPDX-License-Identifier: Apache-2.0
// Pictures for a page test: real PNGs of one colour each (so a thumbnail can be drawn and
// each has its own hash), and a paste or a drop of them into the session's message box as
// a person's would come.
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";

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

/** A PNG of `width`×`height` in one colour. */
export function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A file's SHA-256 as a command names it. */
export const sha = (b: Buffer | Uint8Array): string => createHash("sha256").update(b).digest("base64url");

export interface Given {
  name: string;
  type: string;
  base64: string;
}
export const given = (name: string, b: Buffer, type = "image/png"): Given => ({
  name,
  type,
  base64: b.toString("base64"),
});

/** Paste `files` into the message field. Answers whether the page prevented the paste. */
export function paste(page: Page, files: Given[]): Promise<boolean> {
  return page.evaluate((list) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector<HTMLTextAreaElement>(".ctl-ask textarea")!.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, files);
}

/** Drag `files` over the message box and drop them there. Answers whether the drop was taken. */
export function drop(page: Page, files: Given[]): Promise<boolean> {
  return page.evaluate((list) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    const form = document.querySelector<HTMLFormElement>("form.ctl")!;
    form.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    const dropped = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
    form.dispatchEvent(dropped);
    return dropped.defaultPrevented;
  }, files);
}
