// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAME_PATH, WORDMARK_CSS, wordmarkHtml } from "./brand.js";

const pub = (f: string) => readFileSync(new URL(`../../web/public/brand/${f}`, import.meta.url), "utf8");

describe("the server pages' lockup", () => {
  it("draws the same outlined name as web/public/brand/name.svg", () => {
    expect(pub("name.svg")).toContain(` d="${NAME_PATH}"`);
  });

  it("is one inline svg with the brand's geometry and colours, no font and no fetch", () => {
    const html = wordmarkHtml();
    expect(html).toMatch(/^<svg class="wordmark" role="img" aria-label="sessionpipe" width="123.5" height="17"/);
    expect(html).toContain('viewBox="5.5 13.5 268.851 37"');
    expect(html).not.toMatch(/href=|url\(|<text/);
    expect(WORDMARK_CSS).toContain("--brand-dot:#ff5a1f");
  });
});
