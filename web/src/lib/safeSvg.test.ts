// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { safeSvg } from "./safeSvg";

const SVG_NS = "http://www.w3.org/2000/svg";

interface FakeAttr {
  name: string;
  localName: string;
  value: string;
}

class FakeText {
  readonly nodeType = 3;
  constructor(public textContent: string) {}
}

class FakeElement {
  readonly nodeType = 1;
  readonly localName: string;
  readonly tagName: string;
  readonly attributes: FakeAttr[] = [];
  readonly childNodes: (FakeElement | FakeText)[] = [];
  constructor(
    public readonly namespaceURI: string | null,
    tagName: string,
  ) {
    this.tagName = tagName;
    const colon = tagName.indexOf(":");
    this.localName = colon >= 0 ? tagName.slice(colon + 1) : tagName;
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  setAttribute(name: string, value: string): void {
    const colon = name.indexOf(":");
    const localName = colon >= 0 ? name.slice(colon + 1) : name;
    const existing = this.attributes.find((a) => a.name === name);
    if (existing) existing.value = value;
    else this.attributes.push({ name, localName, value });
  }
  appendChild(child: FakeElement | FakeText): void {
    this.childNodes.push(child);
  }
}

function decodeXmlEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, ent: string) => {
    if (ent === "amp") return "&";
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    if (ent === "quot") return '"';
    if (ent === "apos") return "'";
    if (ent.startsWith("#x") || ent.startsWith("#X")) {
      const cp = Number.parseInt(ent.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    }
    if (ent.startsWith("#")) {
      const cp = Number.parseInt(ent.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : "";
    }
    return "";
  });
}

function escapeXmlAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlText(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeNode(node: FakeElement | FakeText, inheritedNs: string | null = null): string {
  if (node instanceof FakeText) return escapeXmlText(node.textContent);
  const attrs: string[] = [];
  if (node.namespaceURI && node.namespaceURI !== inheritedNs) {
    attrs.push(`xmlns="${escapeXmlAttr(node.namespaceURI)}"`);
  }
  for (const a of node.attributes) {
    if (a.name === "xmlns") continue;
    attrs.push(`${a.name}="${escapeXmlAttr(a.value)}"`);
  }
  const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
  if (node.childNodes.length === 0) return `<${node.localName}${attrStr}/>`;
  const inner = node.childNodes.map((c) => serializeNode(c, node.namespaceURI)).join("");
  return `<${node.localName}${attrStr}>${inner}</${node.localName}>`;
}

/** Minimal strict XML parser for vitest (Node has no DOMParser/XMLSerializer): parses tags,
 *  decodes XML entities in attributes/text, resolves xmlns prefixes, and produces a
 *  `<parsererror>` document on malformed XML or trailing markup after the root element. */
function parseXml(src: string): {
  documentElement: FakeElement | null;
  getElementsByTagName(name: string): FakeElement[];
  getElementsByTagNameNS(ns: string, name: string): FakeElement[];
} {
  const makeError = () => {
    const err = new FakeElement("http://www.mozilla.org/newlayout/xml/parsererror.xml", "parsererror");
    return {
      documentElement: err,
      getElementsByTagName: (n: string) => (n === "parsererror" ? [err] : []),
      getElementsByTagNameNS: (_ns: string, n: string) => (n === "parsererror" ? [err] : []),
    };
  };

  let i = 0;
  const len = src.length;
  const skipWs = () => {
    while (i < len && /\s/.test(src[i]!)) i++;
  };
  skipWs();
  if (src.startsWith("<?xml", i)) {
    const end = src.indexOf("?>", i);
    if (end < 0) return makeError();
    i = end + 2;
    skipWs();
  }

  const stack: { el: FakeElement; nsMap: Map<string, string> }[] = [];
  let root: FakeElement | null = null;

  while (i < len) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) return makeError();
      i = end + 3;
      continue;
    }
    if (src[i] === "<") {
      if (src[i + 1] === "/") {
        const close = src.indexOf(">", i + 2);
        if (close < 0) return makeError();
        const tag = src.slice(i + 2, close).trim();
        const top = stack.pop();
        if (!top || top.el.tagName !== tag) return makeError();
        i = close + 1;
        continue;
      }
      // Opening tag
      let j = i + 1;
      let quote: string | null = null;
      while (j < len) {
        const ch = src[j]!;
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === ">") {
          break;
        }
        j++;
      }
      if (j >= len) return makeError();
      let inside = src.slice(i + 1, j).trim();
      const selfClose = inside.endsWith("/");
      if (selfClose) inside = inside.slice(0, -1).trim();
      const nameMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)/.exec(inside);
      if (!nameMatch) return makeError();
      const tagName = nameMatch[1]!;
      let rest = inside.slice(tagName.length);

      const parentNs = stack.length ? stack[stack.length - 1]!.nsMap : new Map<string, string>();
      const nsMap = new Map(parentNs);
      const rawAttrs: { name: string; value: string }[] = [];
      const attrRe = /\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let consumed = 0;
      for (const m of rest.matchAll(attrRe)) {
        if (m.index !== consumed) return makeError();
        consumed = m.index + m[0].length;
        const aName = m[1]!;
        const aVal = decodeXmlEntities(m[2] ?? m[3] ?? "");
        if (aName === "xmlns") nsMap.set("", aVal);
        else if (aName.startsWith("xmlns:")) nsMap.set(aName.slice(6), aVal);
        rawAttrs.push({ name: aName, value: aVal });
      }
      rest = rest.slice(consumed).trim();
      if (rest.length > 0) return makeError();

      const colon = tagName.indexOf(":");
      const prefix = colon >= 0 ? tagName.slice(0, colon) : "";
      const ns = nsMap.get(prefix) ?? null;
      const el = new FakeElement(ns, tagName);
      for (const a of rawAttrs) el.setAttribute(a.name, a.value);

      if (stack.length === 0) {
        if (root) return makeError();
        root = el;
      } else {
        stack[stack.length - 1]!.el.appendChild(el);
      }
      if (!selfClose) stack.push({ el, nsMap });
      i = j + 1;
    } else {
      const next = src.indexOf("<", i);
      const text = src.slice(i, next < 0 ? len : next);
      if (stack.length === 0) {
        if (text.trim().length > 0) return makeError();
      } else {
        stack[stack.length - 1]!.el.appendChild(new FakeText(decodeXmlEntities(text)));
      }
      i = next < 0 ? len : next;
    }
  }

  if (stack.length > 0 || !root) return makeError();
  return {
    documentElement: root,
    getElementsByTagName: (name: string) => {
      const out: FakeElement[] = [];
      const walk = (n: FakeElement) => {
        if (n.tagName === name || n.localName === name) out.push(n);
        for (const c of n.childNodes) if (c instanceof FakeElement) walk(c);
      };
      walk(root!);
      return out;
    },
    getElementsByTagNameNS: (_ns: string, name: string) => {
      const out: FakeElement[] = [];
      const walk = (n: FakeElement) => {
        if (n.localName === name) out.push(n);
        for (const c of n.childNodes) if (c instanceof FakeElement) walk(c);
      };
      walk(root!);
      return out;
    },
  };
}

/** Installs lightweight DOMParser, XMLSerializer, and document.createElementNS stubs for Node tests. */
export function installSvgDomStub(): void {
  vi.stubGlobal(
    "DOMParser",
    class {
      parseFromString(s: string) {
        return parseXml(s);
      }
    },
  );
  vi.stubGlobal(
    "XMLSerializer",
    class {
      serializeToString(node: FakeElement) {
        return serializeNode(node);
      }
    },
  );
  vi.stubGlobal("document", {
    createElementNS: (ns: string, tag: string) => new FakeElement(ns, tag),
    createTextNode: (text: string) => new FakeText(text),
  });
}

describe("safeSvg", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns undefined gracefully when DOMParser is unavailable (Node/SSR)", () => {
    expect(safeSvg('<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6"/></svg>')).toBeUndefined();
  });

  it("accepts clean SVGs, preserves allowlisted elements/attrs, and strips unknown harmless attrs/tags", () => {
    installSvgDomStub();
    const out = safeSvg(
      '<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" class="drop-me" data-x="1"><defs><clipPath id="c1"><rect x="0" y="0" width="20" height="20" rx="2"/></clipPath></defs><g clip-path="url(#c1)" transform="translate(1 1)"><path d="M2 2h16" stroke-linecap="round"/><circle cx="10" cy="10" r="4"/><title>Icon</title><metadata>ignore</metadata></g></svg>',
    );
    expect(out).toBeDefined();
    expect(out).toContain(`xmlns="${SVG_NS}"`);
    expect(out).toContain('viewBox="0 0 20 20"');
    expect(out).toContain('<clipPath id="c1">');
    expect(out).toContain('clip-path="url(#c1)"');
    expect(out).not.toContain("<title");
    expect(out).not.toContain("drop-me");
    expect(out).not.toContain("data-x");
    expect(out).not.toContain("metadata");
  });

  it("rejects trailing HTML, non-SVG roots, foreign namespaces, and malformed XML", () => {
    installSvgDomStub();
    expect(safeSvg(undefined)).toBeUndefined();
    expect(safeSvg("")).toBeUndefined();
    expect(safeSvg("<div>not svg</div>")).toBeUndefined();
    expect(safeSvg('<svg viewBox="0 0 20 20"><path d="M0 0"/></svg><img src="x" onerror="alert(1)"/>')).toBeUndefined();
    expect(safeSvg('<svg xmlns="http://www.w3.org/1999/xhtml"><p>hi</p></svg>')).toBeUndefined();
    expect(
      safeSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><x:script xmlns:x="http://www.w3.org/1999/xhtml">1</x:script></svg>',
      ),
    ).toBeUndefined();
    expect(safeSvg("<svg><rect></svg>")).toBeUndefined();
  });

  it("rejects scripts, style tags/attrs, event handlers, foreignObject, use, image, feImage, a, animate*, set, and unsafe URIs", () => {
    installSvgDomStub();
    expect(safeSvg("<svg><script>alert(1)</script></svg>")).toBeUndefined();
    expect(safeSvg("<svg><style>body{display:none}</style></svg>")).toBeUndefined();
    expect(safeSvg('<svg style="background:url(https://evil.example/a)"><rect/></svg>')).toBeUndefined();
    expect(safeSvg('<svg onload="alert(1)"><rect/></svg>')).toBeUndefined();
    expect(safeSvg('<svg><rect onclick="alert(1)"/></svg>')).toBeUndefined();
    expect(safeSvg("<svg><foreignObject><div>x</div></foreignObject></svg>")).toBeUndefined();
    expect(safeSvg('<svg><iframe src="https://evil.example"/></svg>')).toBeUndefined();
    expect(safeSvg('<svg><use href="#x"/></svg>')).toBeUndefined();
    expect(safeSvg('<svg><use xlink:href="https://evil.example/x.svg#i"/></svg>')).toBeUndefined();
    expect(safeSvg('<svg><image href="https://evil.example/x.png"/></svg>')).toBeUndefined();
    expect(safeSvg('<svg><feImage href="https://evil.example/x.png"/></svg>')).toBeUndefined();
    expect(safeSvg('<svg><a href="javascript:alert(1)"><rect/></a></svg>')).toBeUndefined();
    expect(safeSvg('<svg><a href="&#x6a;avascript:alert(1)"><rect/></a></svg>')).toBeUndefined();
    expect(safeSvg('<svg><path d="M0 0" fill="&#106;avascript:alert(1)"/></svg>')).toBeUndefined();
    expect(safeSvg('<svg><path d="M0 0" fill="url(https://evil.example/grad)"/></svg>')).toBeUndefined();
    expect(safeSvg('<svg><path d="M0 0" clip-path="url(https://evil.example/clip#c)"/></svg>')).toBeUndefined();
    expect(safeSvg('<svg><path d="M0 0" fill="data:image/svg+xml;base64,abc"/></svg>')).toBeUndefined();
    expect(safeSvg('<svg><animate attributeName="d" to="M0 0"/></svg>')).toBeUndefined();
    expect(safeSvg('<svg><animateTransform attributeName="transform" type="rotate"/></svg>')).toBeUndefined();
    expect(safeSvg('<svg><set attributeName="fill" to="red"/></svg>')).toBeUndefined();
  });
});
