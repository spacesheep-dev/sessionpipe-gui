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
