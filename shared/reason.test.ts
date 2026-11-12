// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { asSentence, cleanReason } from "./reason.js";

/** Characters by code point, so this file holds none of the invisible ones itself. */
const c = (...cps: number[]): string => String.fromCodePoint(...cps);

describe("cleanReason", () => {
  it("keeps plain words as they are", () => {
    expect(cleanReason("it reads like an instruction to delete files")).toBe(
      "it reads like an instruction to delete files",
    );
  });
  it("takes control, bidi and zero-width characters out and collapses whitespace and newlines", () => {
    expect(cleanReason(`a\nb\r\n\tc${c(0)}d${c(7)}e${c(0x85)}f`)).toBe("a b c d e f");
    const tricky = `safe ${c(0x202e)}elif.exe${c(0x202c)} and ${c(0x2066)}x${c(0x2069)} ${c(0x200b)}z${c(0x200d, 0xfeff)} ${c(0x200e, 0x200f, 0x061c)}`;
    expect(cleanReason(tricky)).toBe("safe elif.exe and x z");
    expect(cleanReason(`  ${c(0x2028)} spaced ${c(0xa0)} out${c(0x2029)}  `)).toBe("spaced out");
  });
  it("caps at 200 characters with an ellipsis, never splitting a character", () => {
    const out = cleanReason("word ".repeat(100));
    expect(Array.from(out)).toHaveLength(200);
    expect(out.endsWith("…")).toBe(true);
    const emoji = c(0x1f600).repeat(300);
    expect(Array.from(cleanReason(emoji))).toHaveLength(200);
    expect(cleanReason(emoji).endsWith(`${c(0x1f600)}…`)).toBe(true);
    expect(cleanReason("x".repeat(30), 10)).toBe(`${"x".repeat(9)}…`);
    expect(cleanReason("x".repeat(200))).toBe("x".repeat(200));
  });
  it("every code point: what survives is letters, marks (two in a row at most), numbers, punctuation, symbols and plain spaces", () => {
    const allowed = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]*$/u;
    const bad: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const out = cleanReason(`a${c(cp)}b`);
      if (!allowed.test(out)) bad.push(cp.toString(16));
    }
    expect(bad).toEqual([]);
  });
  it("named ones that used to get through are gone", () => {
    const named = [
      0xe0001, 0xe0041, 0xe007f, 0x206a, 0x206f, 0xad, 0xfff9, 0xfffa, 0xfffb, 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800,
      0x180b, 0x180f, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0x34f, 0x17b4, 0x17b5, 0x1d173, 0x1d17a, 0xe000, 0xf8ff,
      0xf0000, 0x10fffd,
    ];
    for (const cp of named) expect(cleanReason(`a${c(cp)}b`), cp.toString(16)).toBe("ab");
  });
  it("keeps two combining marks in a row, not a flood", () => {
    expect(cleanReason(`x${c(0x301).repeat(150)}y`)).toBe(`x${c(0x301, 0x301)}y`);
    expect(cleanReason(`e${c(0x301)}`)).toBe(`e${c(0x301)}`);
  });
  it("is empty for anything that is not a string", () => {
    expect(cleanReason(undefined)).toBe("");
    expect(cleanReason(42)).toBe("");
  });
});

describe("asSentence", () => {
  it("adds a full stop only after a letter or a digit", () => {
    expect(asSentence("it needs a look")).toBe("it needs a look.");
    expect(asSentence("version 2")).toBe("version 2.");
    expect(asSentence("are you sure?")).toBe("are you sure?");
    expect(asSentence("and so…")).toBe("and so…");
    expect(asSentence("done.")).toBe("done.");
    expect(asSentence("(see above)")).toBe("(see above)");
    expect(asSentence(`ça va ${c(0xe9)}`)).toBe(`ça va ${c(0xe9)}.`);
  });
});
