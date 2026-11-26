// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Strict DOM-based allowlist sanitizer for inline SVG icons from view manifests.
// Parses as image/svg+xml via DOMParser, rejects parser errors, active/scripting/external
// elements, event handlers, style attributes, and unsafe URI schemes, then rebuilds a fresh
// SVG subtree containing only allowlisted elements and geometry/presentation attributes.

const SVG_NS = "http://www.w3.org/2000/svg";

const ALLOWED_ELEMENTS = new Map<string, string>([
  ["svg", "svg"],
  ["g", "g"],
  ["path", "path"],
  ["circle", "circle"],
  ["ellipse", "ellipse"],
  ["rect", "rect"],
  ["line", "line"],
  ["polyline", "polyline"],
  ["polygon", "polygon"],
  ["defs", "defs"],
  ["clippath", "clipPath"],
  ["title", "title"],
]);

const FORBIDDEN_ELEMENTS = new Set([
  "script",
  "style",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "use",
  "image",
  "feimage",
  "a",
  "set",
]);

const ALLOWED_ATTRS = new Map<string, string>([
  ["viewbox", "viewBox"],
  ["width", "width"],
  ["height", "height"],
  ["fill", "fill"],
  ["fill-rule", "fill-rule"],
  ["fill-opacity", "fill-opacity"],
  ["stroke", "stroke"],
  ["stroke-width", "stroke-width"],
  ["stroke-linecap", "stroke-linecap"],
  ["stroke-linejoin", "stroke-linejoin"],
  ["stroke-dasharray", "stroke-dasharray"],
  ["stroke-dashoffset", "stroke-dashoffset"],
  ["stroke-opacity", "stroke-opacity"],
  ["opacity", "opacity"],
  ["d", "d"],
  ["cx", "cx"],
  ["cy", "cy"],
  ["r", "r"],
  ["rx", "rx"],
  ["ry", "ry"],
  ["x", "x"],
  ["y", "y"],
  ["x1", "x1"],
  ["y1", "y1"],
  ["x2", "x2"],
  ["y2", "y2"],
  ["points", "points"],
  ["transform", "transform"],
  ["id", "id"],
  ["clip-path", "clip-path"],
  ["xmlns", "xmlns"],
  ["preserveaspectratio", "preserveAspectRatio"],
]);

const SAFE_LOCAL_CLIP_URL = /^url\(\s*#[A-Za-z_][A-Za-z0-9_.:-]*\s*\)$/;
const SAFE_ID = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const DANGEROUS_SCHEME = /javascript\s*:|vbscript\s*:|data\s*:/i;

function isForbiddenTag(localLower: string): boolean {
  return FORBIDDEN_ELEMENTS.has(localLower) || localLower.startsWith("animate");
}

function hasUnsafeValue(attrLower: string, value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip ASCII control characters before inspecting URI schemes
  const collapsed = value.replace(/[\u0000-\u0020]+/g, "");
  if (DANGEROUS_SCHEME.test(collapsed)) return true;
  if (/url\s*\(/i.test(value)) {
    return attrLower !== "clip-path" || !SAFE_LOCAL_CLIP_URL.test(value.trim());
  }
  return false;
}

function isForbiddenAttr(nameLower: string, localLower: string): boolean {
  return (
    nameLower.startsWith("on") ||
    localLower.startsWith("on") ||
    nameLower === "style" ||
    localLower === "style" ||
    nameLower === "href" ||
    localLower === "href" ||
    nameLower === "xlink:href"
  );
}

/** Sanitizes an inline SVG string via DOMParser + strict element/attribute allowlist.
 *  Returns the serialized safe `<svg>` string, or `undefined` if rejected or if DOM APIs
 *  are unavailable in the current environment. */
export function safeSvg(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined" || typeof document === "undefined") {
    return undefined;
  }

  let parsed: Document;
  try {
    parsed = new DOMParser().parseFromString(trimmed, "image/svg+xml");
  } catch {
    return undefined;
  }
  if (!parsed) return undefined;
  if (
    parsed.getElementsByTagName("parsererror").length > 0 ||
    (typeof parsed.getElementsByTagNameNS === "function" &&
      parsed.getElementsByTagNameNS("*", "parsererror").length > 0)
  ) {
    return undefined;
  }

  const root = parsed.documentElement;
  if (!root || root.localName !== "svg") return undefined;
  if (root.namespaceURI !== SVG_NS && root.namespaceURI !== null) return undefined;

  // Reject any forbidden element, foreign namespace, forbidden attribute, or unsafe URI anywhere in the tree.
  const inspect = (el: Element): boolean => {
    if (el.namespaceURI !== SVG_NS && el.namespaceURI !== null) return false;
    const localLower = (el.localName || el.tagName).toLowerCase();
    if (isForbiddenTag(localLower)) return false;
    for (const attr of Array.from(el.attributes)) {
      const nameLower = attr.name.toLowerCase();
      const attrLocal = (attr.localName || attr.name).toLowerCase();
      if (isForbiddenAttr(nameLower, attrLocal)) return false;
      if (nameLower === "xmlns" && attr.value.trim() !== SVG_NS) return false;
      if (hasUnsafeValue(attrLocal, attr.value)) return false;
    }
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 1 && !inspect(child as Element)) return false;
    }
    return true;
  };
  if (!inspect(root)) return undefined;

  const rebuild = (el: Element): Element | null => {
    const localLower = (el.localName || el.tagName).toLowerCase();
    const canonicalTag = ALLOWED_ELEMENTS.get(localLower);
    if (!canonicalTag) return null;
    const out = document.createElementNS(SVG_NS, canonicalTag);
    for (const attr of Array.from(el.attributes)) {
      const attrLocal = (attr.localName || attr.name).toLowerCase();
      const canonicalAttr = ALLOWED_ATTRS.get(attrLocal);
      if (!canonicalAttr || canonicalAttr === "xmlns") continue;
      const val = attr.value.trim();
      if (canonicalAttr === "id" && !SAFE_ID.test(val)) continue;
      if (canonicalAttr === "clip-path" && val !== "none" && !SAFE_LOCAL_CLIP_URL.test(val)) continue;
      out.setAttribute(canonicalAttr, attr.value);
    }
    if (canonicalTag === "title") {
      const text = el.textContent ?? "";
      if (text) out.appendChild(document.createTextNode(text));
      return out;
    }
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType !== 1) continue;
      const rebuilt = rebuild(child as Element);
      if (rebuilt) out.appendChild(rebuilt);
    }
    return out;
  };

  const cleanRoot = rebuild(root);
  if (!cleanRoot) return undefined;
  try {
    return new XMLSerializer().serializeToString(cleanRoot);
  } catch {
    return undefined;
  }
}
