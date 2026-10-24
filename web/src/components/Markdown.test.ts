// SPDX-License-Identifier: Apache-2.0
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("Markdown", () => {
  it("renders an http link as a new-tab anchor titled with its host", () => {
    const html = render("[docs](https://example.com/a/b)");
    expect(html).toContain(
      '<a href="https://example.com/a/b" target="_blank" rel="noopener noreferrer" title="example.com">docs</a>',
    );
  });

  it("renders a javascript: link as text, with no anchor", () => {
    const html = render("[click](javascript:alert(1))");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("renders an image as [alt], with no img", () => {
    const html = render("![a cat](https://example.com/cat.png)");
    expect(html).toContain("[a cat]");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("cat.png");
  });

  it("escapes HTML in the source", () => {
    const html = render("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders fenced code in a labelled well with a copy button", () => {
    const html = render("```ts\nconst a = 1;\n```");
    expect(html).toContain('class="md-pre"');
    expect(html).toContain('<span class="md-pre-lang">ts</span>');
    expect(html).toContain('<code><span class="md-line">const a = 1;</span></code>');
    expect(html).toContain('aria-label="Copy code"');
  });

  it("gives each code line its indent, so a wrapped line hangs under its own text", () => {
    const html = render("```\nif (a) {\n    go();\n\t\tdeep();\n}\n```");
    expect(html).toContain('<span class="md-line">if (a) {</span>');
    expect(html).toContain('<span class="md-line" style="--i:4">    go();</span>');
    expect(html).toContain('<span class="md-line" style="--i:4">\t\tdeep();</span>');
  });

  it("wraps everything in .md and adds the caller's class", () => {
    expect(renderToStaticMarkup(createElement(Markdown, { text: "hi", className: "x" }))).toBe(
      '<div class="md x"><p>hi</p></div>',
    );
  });
});
