// SPDX-License-Identifier: Apache-2.0
// The feed cursor without Buffer reads every string as the Buffer version did.
import { expect, test } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.js";

/** The cursor as the store wrote and read it before it ran in a page too. */
const bufferEncode = (r: { t: number; no: number }): string => Buffer.from(`${r.t}.${r.no}`).toString("base64url");
const bufferDecode = (c: string): { t: number; no: number } | null => {
  const m = /^(\d+)\.(\d+)$/.exec(Buffer.from(c, "base64url").toString());
  return m ? { t: Number(m[1]), no: Number(m[2]) } : null;
};

test("a cursor is the same string Buffer made, and reads back", () => {
  for (const r of [
    { t: 0, no: 0 },
    { t: 1, no: 1 },
    { t: 1_762_963_200_000, no: 7 },
    { t: 1_762_963_200_123, no: 123_456 },
    { t: 99_999_999_999_999, no: 9_007_199_254_740_991 },
  ]) {
    expect(encodeCursor(r)).toBe(bufferEncode(r));
    expect(decodeCursor(encodeCursor(r))).toEqual(r);
  }
});

test("any string reads as Buffer read it: padding, the other alphabet, junk, a lone last character", () => {
  let seed = 11;
  const rnd = () => {
    seed = (seed * 1_103_515_245 + 12_345) >>> 0;
    return seed / 2 ** 32;
  };
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_=!. \n\t%éŁĮ☃\ud83d\u0000";
  const valid = [
    bufferEncode({ t: 1_762_963_200_000, no: 42 }),
    bufferEncode({ t: 5, no: 9 }),
    Buffer.from("12.34").toString("base64"),
  ];
  const samples = ["", "=", "MTIzLjQ1", "MTIzLjQ1=", "MTIzLjQ1!", "MTIzLjQ1M", "MTI=zLjQ1", "M TIz\nLjQ1"];
  for (let n = 0; n < 20_000; n++) {
    let s = n % 2 ? valid[n % valid.length]! : "";
    const len = Math.floor(rnd() * 6);
    for (let k = 0; k < len; k++) {
      const at = Math.floor(rnd() * (s.length + 1));
      s = s.slice(0, at) + chars[Math.floor(rnd() * chars.length)] + s.slice(at);
    }
    samples.push(s);
  }
  let matched = 0;
  for (const s of samples) {
    const want = bufferDecode(s);
    expect(decodeCursor(s), JSON.stringify(s)).toEqual(want);
    if (want) matched++;
  }
  // The sample reaches both answers, not only null.
  expect(matched).toBeGreaterThan(1_000);
});
