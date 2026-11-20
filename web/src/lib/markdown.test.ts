// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { type Block, type Inline, parseMarkdown } from "./markdown";

const text = (t: string): Inline => ({ type: "text", text: t });
const para = (...children: Inline[]): Block => ({ type: "paragraph", children });

/** The inlines of a source that is one paragraph. */
const inlines = (src: string): Inline[] => {
  const blocks = parseMarkdown(src);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe("paragraph");
  return (blocks[0] as { children: Inline[] }).children;
};

describe("parseMarkdown", () => {
  it("splits paragraphs on blank lines, and a single newline is a line break", () => {
    expect(parseMarkdown("one\ntwo\n\nthree")).toEqual([
      para(text("one"), { type: "br" }, text("two")),
      para(text("three")),
    ]);
    // An agent's reply of three lines reads as three lines.
    expect(parseMarkdown("Purple, Iris\nGreen, Thyme\nBrown, Copper")).toEqual([
      para(text("Purple, Iris"), { type: "br" }, text("Green, Thyme"), { type: "br" }, text("Brown, Copper")),
    ]);
  });

  it("parses ATX headings and clamps h5/h6 to level 4", () => {
    expect(parseMarkdown("# Title\n### Sub ###\n##### Deep")).toEqual([
      { type: "heading", level: 1, children: [text("Title")] },
      { type: "heading", level: 3, children: [text("Sub")] },
      { type: "heading", level: 4, children: [text("Deep")] },
    ]);
  });

  it("parses bold with ** and __", () => {
    expect(inlines("a **b** __c__")).toEqual([
      text("a "),
      { type: "strong", children: [text("b")] },
      text(" "),
      { type: "strong", children: [text("c")] },
    ]);
  });

  it("parses italic with * and _, leaving snake_case alone", () => {
    expect(inlines("*a* _b_ snake_case_name")).toEqual([
      { type: "em", children: [text("a")] },
      text(" "),
      { type: "em", children: [text("b")] },
      text(" snake_case_name"),
    ]);
    expect(inlines("***both***")).toEqual([{ type: "strong", children: [{ type: "em", children: [text("both")] }] }]);
  });

  it("keeps inline code verbatim, with no parsing inside", () => {
    expect(inlines("run `**not bold** [x](y)` now")).toEqual([
      text("run "),
      { type: "code", text: "**not bold** [x](y)" },
      text(" now"),
    ]);
    expect(inlines("`` a ` b ``")).toEqual([{ type: "code", text: "a ` b" }]);
  });

  it("parses fenced code with a language label, and runs an unterminated fence to the end", () => {
    expect(parseMarkdown("```ts\nconst a = 1;\n\n  indented\n```\nafter")).toEqual([
      { type: "code", lang: "ts", text: "const a = 1;\n\n  indented" },
      para(text("after")),
    ]);
    expect(parseMarkdown("~~~\n<b>raw</b>\nstill code")).toEqual([
      { type: "code", lang: "", text: "<b>raw</b>\nstill code" },
    ]);
  });

  it("parses an unordered list", () => {
    expect(parseMarkdown("- a\n* b\n+ c")).toEqual([
      { type: "list", ordered: false, start: 1, items: [[para(text("a"))], [para(text("b"))], [para(text("c"))]] },
    ]);
  });

  it("parses an ordered list and keeps its start number", () => {
    expect(parseMarkdown("3. a\n4. b")).toEqual([
      { type: "list", ordered: true, start: 3, items: [[para(text("a"))], [para(text("b"))]] },
    ]);
  });

  it("nests lists by indentation", () => {
    expect(parseMarkdown("- a\n  - b\n    1. c\n- d")).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          [
            para(text("a")),
            {
              type: "list",
              ordered: false,
              start: 1,
              items: [[para(text("b")), { type: "list", ordered: true, start: 1, items: [[para(text("c"))]] }]],
            },
          ],
          [para(text("d"))],
        ],
      },
    ]);
  });

  it("parses blockquotes with nested blocks", () => {
    expect(parseMarkdown("> # h\n> text\n>\n> - item")).toEqual([
      {
        type: "blockquote",
        children: [
          { type: "heading", level: 1, children: [text("h")] },
          para(text("text")),
          { type: "list", ordered: false, start: 1, items: [[para(text("item"))]] },
        ],
      },
    ]);
  });

  it("parses horizontal rules in all three spellings", () => {
    expect(parseMarkdown("---\n\n***\n\n_ _ _")).toEqual([{ type: "hr" }, { type: "hr" }, { type: "hr" }]);
  });

  it("parses a pipe table with inline cells", () => {
    expect(parseMarkdown("| a | b |\n|---|:-:|\n| **x** | y \\| z |\n| only")).toEqual([
      {
        type: "table",
        header: [[text("a")], [text("b")]],
        rows: [
          [[{ type: "strong", children: [text("x")] }], [text("y | z")]],
          [[text("only")], []],
        ],
      },
    ]);
  });

  it("parses an http link to a link node with its href", () => {
    expect(inlines('see [docs](https://example.com/a?b=1 "t")')).toEqual([
      text("see "),
      { type: "link", href: "https://example.com/a?b=1", children: [text("docs")] },
    ]);
  });

  it("keeps non-http hrefs on the link node for the renderer to refuse", () => {
    expect(inlines("[x](javascript:alert(1))")).toEqual([
      { type: "link", href: "javascript:alert(1)", children: [text("x")] },
    ]);
    expect(inlines("[m](mailto:a@b.c)")).toEqual([{ type: "link", href: "mailto:a@b.c", children: [text("m")] }]);
  });

  it("turns an image into an image node with alt only", () => {
    const nodes = inlines("![a cat](https://example.com/cat.png)");
    expect(nodes).toEqual([{ type: "image", alt: "a cat" }]);
    expect(JSON.stringify(nodes)).not.toContain("cat.png");
  });

  it("autolinks bare http(s) URLs and drops trailing punctuation", () => {
    expect(inlines("go to https://example.com/x). ok")).toEqual([
      text("go to "),
      { type: "link", href: "https://example.com/x", children: [text("https://example.com/x")] },
      text("). ok"),
    ]);
  });

  it("makes hard breaks from two trailing spaces or a backslash", () => {
    expect(inlines("a  \nb\\\nc\nd")).toEqual([
      text("a"),
      { type: "br" },
      text("b"),
      { type: "br" },
      text("c"),
      { type: "br" },
      text("d"),
    ]);
  });

  it("never passes HTML through: tags are plain text", () => {
    const src = "<script>alert(1)</script> and <img src=x onerror=alert(1)>";
    const nodes = inlines(src);
    expect(nodes.every((n) => n.type === "text")).toBe(true);
    expect(nodes.map((n) => (n as { text: string }).text).join("")).toBe(src);
  });
});
