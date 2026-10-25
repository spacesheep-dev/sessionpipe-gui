// SPDX-License-Identifier: Apache-2.0
// Skins: manifest validation, the registry (built-ins, packages, the bundled ones that
// ship with the GUI, the color-theme files listed as token-only skins, errors kept), the
// listing / reload routes, the static file route (types, caching, traversal) and the
// installer bound to the skin kind.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type InstalledSkin, SKIN_ROUTES } from "../../shared/skin-api.js";
import { BUILTIN_SKINS } from "../../shared/skins-builtin.js";
import { tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { InstallError } from "../extensions/install.js";
import { addSkin, formatSkinList, linkSkin, listSkins, removeSkin } from "./install.js";
import {
  contrastWarning as contrastWarningImpl,
  readSkinManifest,
  SkinRegistry,
  skinFromManifest,
  validateSkinManifest,
} from "./registry.js";

/** The install tests look at their own folder alone, not the skins/plugins that ship in dist/bundled. */
const NO_BUNDLED = { bundledDir: "/nonexistent/spgui-bundled" };

const DARK = { "--bg": "oklch(0.2 0.01 250)", "--fg": "oklch(0.95 0.01 90)", "--needs": "oklch(0.78 0.14 60)" };
const LIGHT = { "--bg": "oklch(0.98 0.01 90)", "--fg": "oklch(0.2 0.01 250)" };

const BASE = { id: "fx", name: "Fixture", version: "1.0.0", kind: "skin", api: 1 };

/** A skin folder; `manifest` overrides the defaults, `files` adds files beside skin.json. */
function makeSkin(dir: string, manifest: Record<string, unknown> = {}, files: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  const m = { ...BASE, id: path.basename(dir), scheme: "dark", tokens: DARK, ...manifest };
  writeFileSync(path.join(dir, "skin.json"), JSON.stringify(m));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

describe("skin manifest validation", () => {
  it("accepts a single-scheme manifest and a both-scheme one", () => {
    expect(validateSkinManifest({ ...BASE, scheme: "dark", tokens: DARK })).toEqual({
      ...BASE,
      scheme: "dark",
      tokens: DARK,
    });
    const both = validateSkinManifest({
      ...BASE,
      scheme: "both",
      description: "d",
      tokens: { dark: DARK, light: LIGHT },
      fonts: [{ family: "Lit", src: "fonts/lit.woff2", weight: "200 900", style: "italic" }],
      typography: { ui: '"Lit", serif', mono: "Menlo, monospace", scale: 1.05 },
      shape: { radius: 2, hairline: 1.5, density: "comfortable" },
      css: "skin.css",
      preview: "preview.png",
    });
    expect(both.tokens).toEqual({ dark: DARK, light: LIGHT });
    expect(both.fonts).toEqual([{ family: "Lit", src: "fonts/lit.woff2", weight: "200 900", style: "italic" }]);
    expect(both.shape).toEqual({ radius: 2, hairline: 1.5, density: "comfortable" });
    expect(both.typography?.scale).toBe(1.05);
    // A number weight is kept as a string; style tokens may sit in the token map.
    const m = validateSkinManifest({
      ...BASE,
      scheme: "light",
      tokens: { ...LIGHT, "--font-ui": '"Lit", serif', "--hairline": "2px" },
      fonts: [{ family: "Lit", src: "a.ttf", weight: 600 }],
    });
    expect(m.fonts?.[0]?.weight).toBe("600");
    expect((m.tokens as Record<string, string>)["--font-ui"]).toBe('"Lit", serif');
  });

  it("refuses what does not fit", () => {
    const bad = (m: Record<string, unknown>, re: RegExp) =>
      expect(() => validateSkinManifest({ ...BASE, scheme: "dark", tokens: DARK, ...m })).toThrow(re);
    bad({ id: "Bad" }, /id "Bad"/);
    bad({ id: "paper" }, /is a built-in/);
    bad({ kind: "view" }, /kind "view" is not "skin"/);
    bad({ api: 2 }, /api 2 is newer/);
    bad({ api: 0 }, /"api"/);
    bad({ scheme: "dim" }, /scheme "dim"/);
    bad({ scheme: undefined }, /"scheme" is required/);
    bad({ tokens: { "--nope": "red" } }, /unknown token --nope/);
    bad({ tokens: { "--bg": "red; x" } }, /--bg must be a CSS colour value/);
    bad({ tokens: { "--font-ui": "a; b" } }, /--font-ui must be a CSS style value/);
    bad({ tokens: { dark: DARK } }, /flat tokens map/);
    bad({ scheme: "both" }, /tokens.dark and tokens.light/);
    bad({ scheme: "both", tokens: { dark: DARK } }, /tokens.light must be an object/);
    bad({ scheme: "both", tokens: { dark: DARK, light: { "--x": "red" } } }, /tokens.light: unknown token --x/);
    bad({ fonts: "x" }, /"fonts" must be an array/);
    bad({ fonts: [{ family: "A", src: "../a.woff2" }] }, /fonts\[0\].src/);
    bad({ fonts: [{ family: "A", src: "a.exe" }] }, /woff2, woff, ttf or otf/);
    bad({ fonts: [{ family: "A", src: "a.woff2", weight: "heavy" }] }, /weight/);
    bad({ fonts: [{ family: "A", src: "a.woff2", style: "slanted" }] }, /style/);
    bad({ typography: { scale: 2 } }, /typography.scale/);
    bad({ typography: { ui: "a {" } }, /typography.ui/);
    bad({ shape: { radius: 99 } }, /shape.radius/);
    bad({ shape: { hairline: 3 } }, /shape.hairline/);
    bad({ shape: { density: "cozy" } }, /shape.density/);
    bad({ css: "/etc/x.css" }, /css "\/etc\/x.css"/);
    bad({ css: "x.js" }, /must be a .css file/);
    bad({ preview: "p.txt" }, /must be an image/);
    expect(() => validateSkinManifest([])).toThrow(/object/);
  });

  it("readSkinManifest wants the fonts, the css and the preview to exist", () => {
    const tmp = tempDir();
    try {
      const good = makeSkin(
        path.join(tmp.dir, "good"),
        { fonts: [{ family: "A", src: "fonts/a.woff2" }], css: "skin.css", preview: "p.png" },
        { "fonts/a.woff2": "wOF2", "skin.css": "", "p.png": "png" },
      );
      expect(readSkinManifest(good)).toMatchObject({ id: "good", css: "skin.css" });
      makeSkin(path.join(tmp.dir, "nofont"), { fonts: [{ family: "A", src: "fonts/a.woff2" }] });
      expect(() => readSkinManifest(path.join(tmp.dir, "nofont"))).toThrow(/font "fonts\/a.woff2" is missing/);
      makeSkin(path.join(tmp.dir, "nocss"), { css: "skin.css" });
      expect(() => readSkinManifest(path.join(tmp.dir, "nocss"))).toThrow(/css "skin.css" is missing/);
      makeSkin(path.join(tmp.dir, "nopreview"), { preview: "p.png" });
      expect(() => readSkinManifest(path.join(tmp.dir, "nopreview"))).toThrow(/preview "p.png" is missing/);
      expect(() => readSkinManifest(path.join(tmp.dir, "nothing"))).toThrow(/no skin.json/);
    } finally {
      tmp.cleanup();
    }
  });

  it("skinFromManifest normalises the tokens per scheme and names the files' URL", () => {
    const one = skinFromManifest(validateSkinManifest({ ...BASE, scheme: "light", tokens: LIGHT, source: "s" }), "/d");
    expect(one).toEqual({
      id: "fx",
      name: "Fixture",
      version: "1.0.0",
      scheme: "light",
      source: "skin",
      tokens: { light: LIGHT },
      url: "/skins/fx/",
      dir: "/d",
      origin: "s",
    });
    const both = skinFromManifest(
      validateSkinManifest({ ...BASE, scheme: "both", tokens: { dark: DARK, light: LIGHT } }),
      "/d",
    );
    expect(both.tokens).toEqual({ dark: DARK, light: LIGHT });
  });
});

describe("SkinRegistry", () => {
  it("lists built-ins, then packages (bad ones with an error), then the color-theme files", () => {
    const tmp = tempDir();
    try {
      const skins = path.join(tmp.dir, "skins");
      const ct = path.join(tmp.dir, "color-themes");
      makeSkin(
        path.join(skins, "alpha"),
        { scheme: "both", tokens: { dark: DARK, light: LIGHT }, css: "s.css" },
        {
          "s.css": "",
        },
      );
      makeSkin(path.join(skins, "beta"), { id: "other" });
      makeSkin(path.join(skins, "gamma"), { api: 9 });
      mkdirSync(path.join(skins, "empty"));
      makeSkin(path.join(skins, ".npm"));
      const outside = makeSkin(path.join(tmp.dir, "dev-skin"), { id: "linked" });
      symlinkSync(outside, path.join(skins, "linked"), "dir");
      mkdirSync(ct, { recursive: true });
      writeFileSync(
        path.join(ct, "mint.json"),
        JSON.stringify({ id: "mint", name: "Mint", scheme: "light", tokens: LIGHT }),
      );
      writeFileSync(
        path.join(ct, "odd.json"),
        JSON.stringify({ id: "odd", name: "Odd", scheme: "dark", tokens: { "--x": "r" } }),
      );
      // A file whose id a package already took is listed, but as an error.
      writeFileSync(
        path.join(ct, "alpha.json"),
        JSON.stringify({ id: "alpha", name: "Alpha file", scheme: "dark", tokens: DARK }),
      );

      const reg = new SkinRegistry(skins, ct, { bundledDir: path.join(tmp.dir, "no-bundled") });
      const list = reg.list();
      const ids = list.map((s) => s.id);
      expect(ids.slice(0, BUILTIN_SKINS.length)).toEqual(BUILTIN_SKINS.map((b) => b.id));
      expect(ids.slice(BUILTIN_SKINS.length)).toEqual([
        "alpha",
        "beta",
        "empty",
        "gamma",
        "linked",
        "alpha",
        "mint",
        "odd",
      ]);
      const byId = (id: string, source?: string) => list.find((s) => s.id === id && (!source || s.source === source))!;
      expect(byId("sessionpipe")).toMatchObject({ source: "builtin", scheme: "both" });
      expect(byId("sessionpipe").tokens.dark?.["--bg"]).toBe("#141414");
      expect(byId("plain")).toMatchObject({ source: "builtin", tokens: {} });
      expect(byId("alpha", "skin")).toMatchObject({
        source: "skin",
        scheme: "both",
        css: "s.css",
        url: "/skins/alpha/",
        dir: path.join(skins, "alpha"),
      });
      expect(byId("alpha", "skin").error).toBeUndefined();
      expect(byId("beta").error).toMatch(/id "other" does not match the folder "beta"/);
      expect(byId("gamma").error).toMatch(/api 9 is newer/);
      expect(byId("empty").error).toMatch(/no skin.json/);
      expect(byId("linked")).toMatchObject({ linked: true, name: "Fixture" });
      expect(byId("linked").origin).toMatch(/^link:/);
      expect(byId("mint")).toMatchObject({
        source: "color-theme",
        scheme: "light",
        tokens: { light: LIGHT },
        origin: "mint.json",
      });
      expect(byId("mint").error).toBeUndefined();
      expect(byId("odd")).toMatchObject({ source: "color-theme", origin: "odd.json" });
      expect(byId("odd").error).toBe("unknown token --x");
      expect(byId("alpha", "color-theme").error).toMatch(/taken by an installed skin/);

      expect(reg.get("alpha")).toBeDefined();
      expect(reg.get("gamma")).toBeUndefined();
      expect(reg.get("mint")).toBeUndefined(); // no files to serve
      expect(reg.get("paper")).toBeUndefined();
      expect(reg.has("gamma")).toBe(true);
      expect(reg.has("nope")).toBe(false);

      makeSkin(path.join(skins, "late"));
      expect(reg.get("late")).toBeUndefined();
      reg.scan();
      expect(reg.get("late")).toBeDefined();
    } finally {
      tmp.cleanup();
    }
  });

  it("lists bundled skins after the person's own, an install of the same id winning; disabled ones stay listed", () => {
    const tmp = tempDir();
    try {
      const skins = path.join(tmp.dir, "skins");
      const bundled = path.join(tmp.dir, "bundled", "skins");
      makeSkin(path.join(bundled, "paper-serif"), { name: "Paper Serif (bundled)", scheme: "light", tokens: LIGHT });
      makeSkin(path.join(bundled, "vivid"), { name: "Vivid" });
      makeSkin(path.join(skins, "paper-serif"), { name: "Paper Serif (mine)", scheme: "light", tokens: LIGHT });
      let off: string[] = [];
      const reg = new SkinRegistry(skins, undefined, { bundledDir: bundled, disabled: () => off });
      const packages = () => reg.list().filter((s) => s.source === "skin");
      expect(packages().map((s) => [s.id, s.name, s.bundled ?? false])).toEqual([
        ["paper-serif", "Paper Serif (mine)", false],
        ["vivid", "Vivid", true],
      ]);
      expect(reg.get("vivid")).toMatchObject({ bundled: true, origin: "bundled", dir: path.join(bundled, "vivid") });
      expect(reg.get("paper-serif")!.bundled).toBeUndefined();
      expect(reg.isBundled("paper-serif")).toBe(true);
      expect(reg.isBundled("nope")).toBe(false);
      // Disabled: still listed with the flag, but it serves no files.
      off = ["skin:vivid", "view:canvas"];
      reg.scan();
      expect(packages().find((s) => s.id === "vivid")).toMatchObject({ disabled: true, bundled: true });
      expect(reg.get("vivid")).toBeUndefined();
      // Removing a bundled skin says to disable it instead; removing the install of the same id works.
      expect(() => removeSkin(skins, "vivid", { bundledDir: bundled })).toThrow(
        /bundled with sessionpipe-gui.*skin disable vivid/,
      );
      expect(removeSkin(skins, "paper-serif", { bundledDir: bundled }).message).toBe("removed paper-serif");
      expect(listSkins(skins, { bundledDir: bundled }).find((s) => s.id === "paper-serif")!.name).toBe(
        "Paper Serif (bundled)",
      );
      const out = formatSkinList(skins, listSkins(skins, { bundledDir: bundled, disabled: () => ["skin:vivid"] }));
      expect(out).toMatch(/^paper-serif\s+Paper Serif \(bundled\) 1\.0\.0\s+\[bundled, light\]\s+← bundled/m);
      expect(out).toMatch(/^vivid\s+Vivid 1\.0\.0\s+\[bundled, disabled, dark\]/m);
    } finally {
      tmp.cleanup();
    }
  });

  it("is the built-ins alone for missing folders", () => {
    const list = new SkinRegistry("/nonexistent/spgui-skins", "/nonexistent/spgui-ct", {
      bundledDir: "/nonexistent/bundled",
    }).list();
    expect(list.map((s) => s.id)).toEqual(BUILTIN_SKINS.map((b) => b.id));
    expect(list[0]!.id).toBe("sessionpipe");
  });
});

describe("skin routes", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  let skins: string;

  beforeAll(async () => {
    tmp = tempDir();
    skins = path.join(tmp.dir, "skins");
    makeSkin(
      path.join(skins, "one"),
      { fonts: [{ family: "One", src: "fonts/one.woff2" }], css: "skin.css", preview: "preview.png" },
      {
        "fonts/one.woff2": "wOF2",
        "fonts/one.ttf": "ttf",
        "skin.css": ".one{}",
        "preview.png": "png",
        "blob.bin": "x",
      },
    );
    makeSkin(path.join(skins, "broken"), { api: 42 });
    writeFileSync(path.join(tmp.dir, "secret.txt"), "secret");
    symlinkSync(path.join(tmp.dir, "secret.txt"), path.join(skins, "one", "leak.txt"));
    const ct = path.join(tmp.dir, "color-themes");
    mkdirSync(ct);
    writeFileSync(
      path.join(ct, "mint.json"),
      JSON.stringify({ id: "mint", name: "Mint", scheme: "light", tokens: LIGHT }),
    );
    // The bundled skins live beside the bundled views dir; none here, so the list is exact.
    app = await createApp({
      port: 0,
      stateDir: tmp.dir,
      outbox: false,
      quiet: true,
      webDir: tmp.dir,
      bundledDir: path.join(tmp.dir, "bundled", "views"),
    });
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  const url = (p: string) => `${app.url}${p}`;

  it("lists every source, with dir on loopback and errors kept", async () => {
    const res = await fetch(url(SKIN_ROUTES.list));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { skins: list } = (await res.json()) as { skins: InstalledSkin[] };
    expect(list.map((s) => s.id)).toEqual([...BUILTIN_SKINS.map((b) => b.id), "broken", "one", "mint"]);
    expect(list.find((s) => s.id === "one")).toMatchObject({
      source: "skin",
      url: "/skins/one/",
      dir: path.join(skins, "one"),
    });
    expect(list.find((s) => s.id === "broken")!.error).toMatch(/api 42/);
    expect(list.find((s) => s.id === "mint")).toMatchObject({ source: "color-theme" });
    expect(app.skins.list()).toHaveLength(list.length);
  });

  it("reloads on POST (loopback) and sees a new skin", async () => {
    makeSkin(path.join(skins, "two"));
    let ids = ((await (await fetch(url(SKIN_ROUTES.list))).json()) as { skins: InstalledSkin[] }).skins.map(
      (s) => s.id,
    );
    expect(ids).not.toContain("two");
    const res = await fetch(url(SKIN_ROUTES.reload), { method: "POST" });
    expect(res.status).toBe(200);
    ids = ((await res.json()) as { skins: InstalledSkin[] }).skins.map((s) => s.id);
    expect(ids).toContain("two");
    expect((await fetch(url(SKIN_ROUTES.reload))).status).toBe(405);
  });

  it("serves a package's files: fonts immutable, json and css revalidated, nothing outside", async () => {
    const font = await fetch(url("/skins/one/fonts/one.woff2"));
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await fetch(url("/skins/one/fonts/one.ttf"))).headers.get("content-type")).toBe("font/ttf");
    const css = await fetch(url("/skins/one/skin.css"));
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("cache-control")).toBe("no-cache");
    expect(await css.text()).toBe(".one{}");
    const json = await fetch(url("/skins/one/skin.json"));
    expect(json.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(json.headers.get("cache-control")).toBe("no-cache");
    const png = await fetch(url("/skins/one/preview.png"));
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await fetch(url("/skins/one/blob.bin"))).headers.get("content-type")).toBe("application/octet-stream");
    const head = await fetch(url("/skins/one/skin.css"), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(css.headers.get("content-length"));

    expect((await fetch(url("/skins/one/missing.css"))).status).toBe(404);
    expect((await fetch(url("/skins/one/"))).status).toBe(404);
    expect((await fetch(url("/skins/broken/skin.json"))).status).toBe(404);
    expect((await fetch(url("/skins/mint/skin.json"))).status).toBe(404); // a file, not a package
    expect((await fetch(url("/skins/paper/skin.json"))).status).toBe(404); // a built-in has no folder
    expect((await fetch(url("/skins/one/leak.txt"))).status).toBe(404);
    for (const p of [
      "/skins/one/../../secret.txt",
      "/skins/one/%2e%2e/%2e%2e/secret.txt",
      "/skins/one/..%2fsecret.txt",
    ]) {
      const r = await fetch(url(p));
      expect([404, 200, 503]).toContain(r.status);
      expect(await r.text()).not.toContain("secret");
    }
  });

  it("needs the UI key away from loopback", async () => {
    const ctx = { remote: { ip: "10.0.0.2", loopback: false }, url: new URL("http://x/"), cookies: () => ({}) };
    const reply = await app.router.match("GET", SKIN_ROUTES.list)!.handler(ctx as never);
    expect(reply).toMatchObject({ status: 401 });
    const files = await app.router
      .match("GET", "/skins/one/skin.css")!
      .handler({ ...ctx, params: { id: "one", rest: "skin.css" } } as never);
    expect(files).toMatchObject({ status: 401 });
    const reload = await app.router.match("POST", SKIN_ROUTES.reload)!.handler({
      ...ctx,
      remote: { ip: "10.0.0.2", loopback: false },
      cookies: () => ({ spgui: app.config().uiKey }),
    } as never);
    expect(reload).toMatchObject({ status: 403 });
  });
});

describe("skin install", () => {
  let tmp: { dir: string; cleanup: () => void };
  let skins: string;
  beforeAll(() => {
    tmp = tempDir();
    skins = path.join(tmp.dir, "skins");
  });
  afterAll(() => tmp.cleanup());

  it("adds a folder by copying it and records the source", async () => {
    const src = makeSkin(path.join(tmp.dir, "src-folder"), { id: "folder", name: "From folder" }, { "skin.css": "" });
    const r = await addSkin(skins, src);
    expect(r.replaced).toBe(false);
    expect(r.dir).toBe(path.join(skins, "folder"));
    expect(r.message).toMatch(/^installed folder \(From folder 1\.0\.0\) from /);
    expect(existsSync(path.join(skins, "folder", "skin.css"))).toBe(true);
    const installed = JSON.parse(readFileSync(path.join(skins, "folder", "skin.json"), "utf8"));
    expect(installed).toMatchObject({ id: "folder", kind: "skin", source: src });
    expect(listSkins(skins, NO_BUNDLED).find((s) => s.id === "folder")).toMatchObject({ source: "skin", origin: src });
    const again = await addSkin(skins, src);
    expect(again.replaced).toBe(true);
  });

  it("adds a .tgz, finding skin.json one level down", async () => {
    const src = makeSkin(path.join(tmp.dir, "pack", "package"), { id: "packed", name: "Packed", version: "2.0.0" });
    const tgz = path.join(tmp.dir, "packed-2.0.0.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", path.dirname(src), "package"]);
    const r = await addSkin(skins, tgz);
    expect(r.manifest).toMatchObject({ id: "packed", version: "2.0.0", source: tgz });
    expect(readFileSync(path.join(skins, "packed", "skin.json"), "utf8")).toContain('"kind": "skin"');
  });

  it("links a folder as a symlink and removes the link only", () => {
    const src = makeSkin(path.join(tmp.dir, "dev"), { id: "dev", name: "Dev" });
    const r = linkSkin(skins, src);
    expect(r.message).toMatch(/^linked dev \(Dev 1\.0\.0\) → /);
    expect(lstatSync(path.join(skins, "dev")).isSymbolicLink()).toBe(true);
    expect(listSkins(skins, NO_BUNDLED).find((s) => s.id === "dev")).toMatchObject({ linked: true });
    writeFileSync(
      path.join(src, "skin.json"),
      JSON.stringify({ ...BASE, id: "dev", name: "Dev 2", scheme: "dark", tokens: DARK }),
    );
    expect(listSkins(skins, NO_BUNDLED).find((s) => s.id === "dev")).toMatchObject({ name: "Dev 2" });
    const rm = removeSkin(skins, "dev");
    expect(rm.message).toMatch(/^removed dev \(the link/);
    expect(existsSync(path.join(skins, "dev"))).toBe(false);
    expect(existsSync(path.join(src, "skin.json"))).toBe(true);
  });

  it("removes an installed copy, refuses what is not there and what it cannot read", async () => {
    expect(removeSkin(skins, "packed").message).toBe("removed packed");
    expect(() => removeSkin(skins, "packed")).toThrow(InstallError);
    expect(() => removeSkin(skins, "../folder")).toThrow(/no skin/);
    await expect(addSkin(skins, path.join(tmp.dir, "nothing-here"))).rejects.toThrow(/does not exist/);
    const view = path.join(tmp.dir, "a-view");
    mkdirSync(view);
    writeFileSync(path.join(view, "theme.json"), "{}");
    await expect(addSkin(skins, view)).rejects.toThrow(/no skin.json/);
    const wrongKind = makeSkin(path.join(tmp.dir, "wrong-kind"), { kind: "plugin" });
    await expect(addSkin(skins, wrongKind)).rejects.toThrow(/kind "plugin" is not "skin"/);
    await expect(addSkin(skins, "")).rejects.toThrow(/needs a source/);
  });

  it("formats the list for the terminal: packages only, with the scheme as a flag", () => {
    makeSkin(path.join(skins, "broken"), { api: 7 });
    const out = formatSkinList(skins, listSkins(skins, NO_BUNDLED));
    expect(out).toMatch(/^broken\s+\(broken: skin.json: api 7 is newer/m);
    expect(out).toMatch(/^folder\s+From folder 1\.0\.0\s+\[dark\]\s+← /m);
    expect(out).not.toMatch(/^sessionpipe\s/m);
    expect(formatSkinList(skins, [])).toBe(`no skins installed in ${skins}\n`);
  });
});

describe("contrast", () => {
  it("parses oklch, hex and rgb and measures the ratio", async () => {
    const { contrastRatio, parseCssColor } = await import("../../shared/contrast.js");
    expect(parseCssColor("#000")).toEqual([0, 0, 0]);
    expect(parseCssColor("rgb(255, 255, 255)")).toEqual([1, 1, 1]);
    expect(parseCssColor("var(--fg)")).toBeNull();
    expect(contrastRatio("#000", "#fff")).toBeCloseTo(21, 1);
    expect(contrastRatio("oklch(1 0 0)", "oklch(0 0 0)")).toBeCloseTo(21, 0);
    expect(contrastRatio("red", "#fff")).toBeNull();
  });

  it("every built-in clears the text-tier floors; a low tier is a warning, not an error", () => {
    const { contrastWarning } = requireRegistry();
    for (const b of BUILTIN_SKINS) expect(contrastWarning(b), b.id).toBeUndefined();
    const low = contrastWarning({ scheme: "light", tokens: { light: { "--fg-3": "oklch(0.7 0.01 60)" } } });
    expect(low).toMatch(/^low contrast: --fg-3 on --bg \d\.\d:1, needs 4\.5 · --fg-3 on --bg-2/);
    const both = contrastWarning({
      scheme: "both",
      tokens: { dark: { "--fg-4": "oklch(0.3 0 0)" }, light: { "--fg": "#000", "--bg": "#fff" } },
    });
    expect(both).toMatch(/^low contrast: dark: --fg-4 on --bg/);
    expect(both).not.toMatch(/light:/);
    const tmp = tempDir();
    try {
      const skins = path.join(tmp.dir, "skins");
      makeSkin(path.join(skins, "faint"), { tokens: { ...DARK, "--fg-3": "oklch(0.4 0.01 250)" } });
      const reg = new SkinRegistry(skins, undefined, { bundledDir: path.join(tmp.dir, "no-bundled") });
      const faint = reg.list().find((s) => s.id === "faint")!;
      expect(faint.error).toBeUndefined();
      expect(faint.warning).toMatch(/^low contrast: --fg-3 on --bg/);
      expect(reg.get("faint")).toBeDefined();
    } finally {
      tmp.cleanup();
    }
  });
});

function requireRegistry(): { contrastWarning: typeof import("./registry.js").contrastWarning } {
  return { contrastWarning: contrastWarningImpl };
}
