// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { DEMO_WORDS, showDemoBanner } from "./banner";

/** Just enough of a document for the banner: elements with text, attributes and children. */
class El {
  className = "";
  textContent = "";
  href = "";
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: El[] = [];
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return k === "href" ? this.href : (this.attrs.get(k) ?? null);
  }
  append(...c: El[]) {
    this.children.push(...c);
  }
  prepend(...c: El[]) {
    this.children.unshift(...c);
  }
  get text(): string {
    return this.textContent + this.children.map((c) => c.text).join(" ");
  }
}
const fakeDoc = () => {
  const body = new El();
  const root = new El();
  return {
    body,
    documentElement: root,
    createElement: () => new El(),
    querySelector: () => body.children.find((c) => "demoBanner" in c.dataset) ?? null,
  } as unknown as Document & { body: El; documentElement: El };
};

describe("demo banner", () => {
  it("labels the page as made-up sessions, once, with a way out", () => {
    const doc = fakeDoc();
    const bar = showDemoBanner(doc) as unknown as El;
    expect(doc.documentElement.dataset.demo).toBe("1");
    expect(bar.getAttribute("role")).toBe("status");
    expect(bar.text).toContain(DEMO_WORDS.label);
    expect(bar.text).toContain("made up");
    expect(bar.children.find((c) => c.href)?.href).toBe("/");
    expect(showDemoBanner(doc)).toBe(bar as unknown as HTMLElement);
    expect(doc.body.children).toHaveLength(1);
  });
});
