// SPDX-License-Identifier: Apache-2.0
import "../native/test-env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InstalledTheme } from "@shared/theme-api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSvgDomStub } from "../lib/safeSvg.test";
import { ADD_LINE, formatExtensionMeta, safeViewSvg, ThemeRow, ViewIconTile, viewBadges } from "./ThemesPage";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const makeTheme = (patch: Partial<InstalledTheme> = {}): InstalledTheme => ({
  id: "canvas",
  name: "Canvas",
  version: "0.3.0",
  description: "Every live session as a window on an infinite canvas.",
  api: 1,
  url: "/themes/canvas/",
  ...patch,
});

describe("ThemesPage helpers", () => {
  it("formats concise PageBar meta for views and plugins", () => {
    expect(formatExtensionMeta(0, 0)).toBeUndefined();
    expect(formatExtensionMeta(1, 0)).toBe("1 view");
    expect(formatExtensionMeta(2, 0)).toBe("2 views");
    expect(formatExtensionMeta(0, 1)).toBe("1 plugin");
    expect(formatExtensionMeta(2, 1)).toBe("2 views · 1 plugin");
    expect(formatExtensionMeta(1, 3)).toBe("1 view · 3 plugins");
  });

  it("sanitizes inline SVG icons and rejects unsafe markup", () => {
    installSvgDomStub();
    try {
      const clean = '<svg viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16"/></svg>';
      const out = safeViewSvg(clean);
      expect(out).toContain('viewBox="0 0 20 20"');
      expect(out).toContain('<rect x="2" y="2" width="16" height="16"/>');
      expect(safeViewSvg(undefined)).toBeNull();
      expect(safeViewSvg("<div>not svg</div>")).toBeNull();
      expect(safeViewSvg("<svg><script>alert(1)</script></svg>")).toBeNull();
      expect(safeViewSvg('<svg onload="alert(1)"></svg>')).toBeNull();
      expect(safeViewSvg('<svg><a href="javascript:alert(1)"></a></svg>')).toBeNull();
      expect(safeViewSvg("<svg><foreignObject></foreignObject></svg>")).toBeNull();
      expect(safeViewSvg("<svg><iframe src='x'></iframe></svg>")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows only noteworthy badges and omits noisy bundled/disabled pills", () => {
    expect(viewBadges(makeTheme({ bundled: true }))).toEqual([]);
    expect(viewBadges(makeTheme({ bundled: true, disabled: true }))).toEqual([]);
    expect(viewBadges(makeTheme({ linked: true, experimental: true }))).toEqual([
      { key: "linked", label: "linked" },
      { key: "experimental", label: "experimental" },
    ]);
    expect(viewBadges(makeTheme({ error: "Bad manifest" }))).toEqual([{ key: "broken", label: "broken", err: true }]);
  });

  it("uses the concise CLI install line", () => {
    expect(ADD_LINE).toBe("sessionpipe-gui view add <source>");
  });
});

describe("ThemeRow and ViewIconTile", () => {
  it("renders a 36x36 icon tile, native switch, Open link, and More menu for a healthy view", () => {
    const html = renderToStaticMarkup(
      createElement(ThemeRow, {
        t: makeTheme({ bundled: true, experimental: true }),
        loopback: true,
        busy: false,
        onToggle: () => {},
        onReload: () => {},
      }),
    );
    expect(html).toContain('data-theme-row="canvas"');
    expect(html).toContain('data-bundled=""');
    expect(html).toContain('class="ext-icon"');
    expect(html).toContain(">Canvas<");
    expect(html).toContain(">0.3.0<");
    expect(html).toContain(">experimental<");
    expect(html).not.toContain(">bundled<");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('data-toggle="canvas"');
    expect(html).toContain('href="/t/canvas"');
    expect(html).toContain('aria-label="Actions for Canvas"');
  });

  it("dims the icon, hides Open, and unchecks the switch when disabled", () => {
    const html = renderToStaticMarkup(
      createElement(ThemeRow, {
        t: makeTheme({ id: "office", name: "Office", disabled: true }),
        loopback: true,
        busy: false,
        onToggle: () => {},
        onReload: () => {},
      }),
    );
    expect(html).toContain('data-disabled=""');
    expect(html).toContain("ext-icon--dim");
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain('href="/t/office"');
  });

  it("renders broken badge and mono error well without switch or Open link when broken", () => {
    const html = renderToStaticMarkup(
      createElement(ThemeRow, {
        t: makeTheme({ id: "bad", name: "Bad View", error: "Missing entry file" }),
        loopback: true,
        busy: false,
        onToggle: () => {},
        onReload: () => {},
      }),
    );
    expect(html).toContain("ext-icon--err");
    expect(html).toContain("ext-pill--err");
    expect(html).toContain("Missing entry file");
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('href="/t/bad"');
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders manifest SVG inside ViewIconTile when safe and falls back otherwise", () => {
    installSvgDomStub();
    const withManifest = renderToStaticMarkup(
      createElement(ViewIconTile, {
        theme: makeTheme({ icon: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6"/></svg>' }),
      }),
    );
    expect(withManifest).toContain('class="ext-icon-svg"');
    expect(withManifest).toContain('<circle cx="10" cy="10" r="6"/>');

    const withUnsafe = renderToStaticMarkup(
      createElement(ViewIconTile, {
        theme: makeTheme({ id: "office", icon: "<svg><script>evil()</script></svg>" }),
      }),
    );
    expect(withUnsafe).not.toContain("evil()");
    expect(withUnsafe).toContain("<svg");
  });
});

describe("Views & Plugins house rules", () => {
  const files = [
    path.join(HERE, "ThemesPage.tsx"),
    path.join(HERE, "../plugins/PluginsSection.tsx"),
    path.join(HERE, "../components/Extras.tsx"),
    path.join(HERE, "../themes/host/host.css"),
    path.join(HERE, "../plugins/plugins.css"),
  ];

  it("contains zero em-dashes or en-dashes in UI files", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, `${path.basename(file)} must not contain em-dash or en-dash`).not.toMatch(/[—–]/);
    }
  });

  it("uses semantic tokens only and never uses --needs or hardcoded hex colors in Views/Plugins CSS", () => {
    for (const cssFile of [path.join(HERE, "../themes/host/host.css"), path.join(HERE, "../plugins/plugins.css")]) {
      const css = readFileSync(cssFile, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css, `${path.basename(cssFile)} must not use --needs`).not.toContain("--needs");
      expect(css, `${path.basename(cssFile)} must not contain hardcoded hex colors`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
