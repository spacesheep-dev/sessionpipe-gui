// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. Tokenizer vectors (arch-engine.md §4).
import { describe, expect, it } from "vitest";
import { analyze, fold, tokenize } from "./tokenize.js";

const toks = (s: string) => {
  const out: [string, number, string][] = [];
  tokenize(s, (t, p, a, b) => out.push([t, p, s.slice(a, b)]));
  return out;
};
const words = (s: string) => toks(s).map((t) => t[0]);

describe("tokenize", () => {
  it("lowercases words and splits on punctuation", () => {
    expect(toks("Fix the Build, now!")).toEqual([
      ["fix", 0, "Fix"],
      ["the", 1, "the"],
      ["build", 2, "Build"],
      ["now", 3, "now"],
    ]);
  });

  it("splits camelCase and keeps the whole identifier at the first part's position", () => {
    expect(toks("getUserName")).toEqual([
      ["get", 0, "get"],
      ["user", 1, "User"],
      ["name", 2, "Name"],
      ["getusername", 0, "getUserName"],
    ]);
  });

  it("splits acronyms before a capitalised word", () => {
    expect(words("HTTPServer")).toEqual(["http", "server", "httpserver"]);
    expect(words("parseHTTPResponse")).toEqual(["parse", "http", "response", "parsehttpresponse"]);
  });

  it("splits snake_case and drops leading underscores from the whole", () => {
    expect(words("get_user_name")).toEqual(["get", "user", "name", "get_user_name"]);
    expect(words("__init__")).toEqual(["init"]);
    expect(words("_private_thing")).toEqual(["private", "thing", "private_thing"]);
  });

  it("never splits letter→digit, but splits digit→Upper", () => {
    expect(words("sha256 utf8 v8")).toEqual(["sha256", "utf8", "v8"]);
    expect(words("base64Encode")).toEqual(["base64", "encode", "base64encode"]);
  });

  it("reads paths, UUIDs, versions and emails as consecutive words", () => {
    expect(toks("src/store/review.ts").map((t) => [t[0], t[1]])).toEqual([
      ["src", 0],
      ["store", 1],
      ["review", 2],
      ["ts", 3],
    ]);
    expect(words("11111111-2222-3333")).toEqual(["11111111", "2222", "3333"]);
    expect(words("v1.2.3")).toEqual(["v1", "2", "3"]);
    expect(words("ana@example.com")).toEqual(["ana", "example", "com"]);
  });

  it("folds diacritics and ß", () => {
    expect(words("Café Größe naïve")).toEqual(["cafe", "grosse", "naive"]);
    expect(fold("İstanbul")).toBe("istanbul");
    expect(words("Ошибка сборки")).toEqual(["ошибка", "сборки"]);
  });

  it("marks map back to the original text even when folding changes lengths", () => {
    const s = "Größe ok";
    const t = toks(s);
    expect(t[0]).toEqual(["grosse", 0, "Größe"]);
    expect(t[1]).toEqual(["ok", 1, "ok"]);
  });

  it("gives CJK one token per character", () => {
    expect(toks("検索する").map((t) => [t[0], t[1]])).toEqual([
      ["検", 0],
      ["索", 1],
      ["す", 2],
      ["る", 3],
    ]);
  });

  it("keeps kana voicing and Hangul syllables (NFKC, no mark stripping)", () => {
    expect(words("デ テ")).toEqual(["デ", "テ"]);
    expect(words("ｶ")).toEqual(["カ"]);
    expect(words("한국")).toEqual(["한", "국"]);
  });

  it("skips runs over 200 characters and parts over 40", () => {
    const b64 = "A".repeat(150) + "b".repeat(60);
    expect(words(`x ${b64} y`)).toEqual(["x", "y"]);
    expect(words(`${"a".repeat(41)} ok`)).toEqual(["ok"]);
  });

  it("treats emoji and other astral characters as separators", () => {
    expect(words("ship🚀it")).toEqual(["ship", "it"]);
  });

  it("returns the next position and continues from pos0", () => {
    expect(tokenize("a b c", () => {}, 10)).toBe(13);
  });
});

describe("analyze", () => {
  it("returns parts and whole identifiers with their spans", () => {
    expect(analyze("getUserName")).toEqual({
      parts: ["get", "user", "name"],
      wholes: [{ at: 0, term: "getusername", span: 3 }],
    });
    expect(analyze("fooBar baz")).toEqual({
      parts: ["foo", "bar", "baz"],
      wholes: [{ at: 0, term: "foobar", span: 2 }],
    });
    expect(analyze("a fooBar")).toEqual({ parts: ["a", "foo", "bar"], wholes: [{ at: 1, term: "foobar", span: 2 }] });
    expect(analyze("!!!")).toEqual({ parts: [], wholes: [] });
  });
});
