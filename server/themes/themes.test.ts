// SPDX-License-Identifier: Apache-2.0
// Themes: the registry's scan and validation, the listing / state / reload routes, the
// static file route (types, caching, traversal, symlinks) and the CLI operations
// (add from a folder and from a .tgz, link, remove, list).
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type InstalledTheme, THEME_ROUTES } from "../../shared/theme-api.js";
import { tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { addTheme, formatList, linkTheme, listThemes, removeTheme, ThemeInstallError } from "./install.js";
import { publicTheme, readManifest, ThemeRegistry, validateManifest } from "./registry.js";
import { resolveInside, STATE_MAX_BYTES } from "./routes.js";

/** A minimal theme folder; `manifest` overrides the defaults. */
function makeTheme(dir: string, manifest: Record<string, unknown> = {}, files: Record<string, string> = {}): string {
  mkdirSync(dir, { recursive: true });
  const m = { id: path.basename(dir), name: `Theme ${path.basename(dir)}`, version: "1.0.0", api: 1, ...manifest };
  writeFileSync(path.join(dir, "theme.json"), JSON.stringify(m));
  writeFileSync(path.join(dir, "index.js"), files["index.js"] ?? "export default { mount() { return () => {}; } };");
  for (const [name, body] of Object.entries(files)) if (name !== "index.js") writeFileSync(path.join(dir, name), body);
  return dir;
}

describe("manifest validation", () => {
  it("accepts a minimal manifest and fills the entry", () => {
    expect(validateManifest({ id: "ok", name: "Ok", version: "1", api: 1 })).toEqual({
      id: "ok",
      name: "Ok",
      version: "1",
      api: 1,
      entry: "index.js",
    });
  });
  it("refuses bad ids, a newer api, non-relative entries and wrong types", () => {
    expect(() => validateManifest({ id: "Bad", name: "x", version: "1", api: 1 })).toThrow(/id "Bad"/);
    expect(() => validateManifest({ id: "a", name: "x", version: "1", api: 1 })).toThrow(/id "a"/);
    expect(() => validateManifest({ id: "ok", name: "x", version: "1", api: 2 })).toThrow(/api 2 is newer/);
    expect(() => validateManifest({ id: "ok", name: "x", version: "1", api: 0 })).toThrow(/"api"/);
    expect(() => validateManifest({ id: "ok", name: "x", version: "1" })).toThrow(/"api"/);
    expect(() => validateManifest({ id: "ok", version: "1", api: 1 })).toThrow(/"name" is required/);
    expect(() => validateManifest({ id: "ok", name: "x", version: "1", api: 1, entry: "../x.js" })).toThrow(/entry/);
    expect(() => validateManifest({ id: "ok", name: "x", version: "1", api: 1, entry: "/etc/x.js" })).toThrow(/entry/);
    expect(() => validateManifest({ id: "ok", name: "x", version: "1", api: 1, style: "http://x/y.css" })).toThrow(
      /style/,
    );
    expect(() => validateManifest({ id: "ok", name: "x", version: "1", api: 1, experimental: "yes" })).toThrow(
      /experimental/,
    );
    expect(() => validateManifest([])).toThrow(/object/);
  });
  it("readManifest wants the entry and the style to exist", () => {
    const tmp = tempDir();
    try {
      const dir = makeTheme(path.join(tmp.dir, "good"), { style: "s.css" }, { "s.css": "" });
      expect(readManifest(dir)).toMatchObject({ id: "good", style: "s.css" });
      makeTheme(path.join(tmp.dir, "nostyle"), { style: "missing.css" });
      expect(() => readManifest(path.join(tmp.dir, "nostyle"))).toThrow(/style "missing.css" is missing/);
      mkdirSync(path.join(tmp.dir, "noentry"));
      writeFileSync(
        path.join(tmp.dir, "noentry", "theme.json"),
        JSON.stringify({ id: "noentry", name: "x", version: "1", api: 1 }),
      );
      expect(() => readManifest(path.join(tmp.dir, "noentry"))).toThrow(/entry "index.js" is missing/);
      expect(() => readManifest(path.join(tmp.dir, "nothing"))).toThrow(/no theme.json/);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("ThemeRegistry", () => {
  it("scans the folder: good ones listed, bad ones listed with an error, dot folders skipped", () => {
    const tmp = tempDir();
    try {
      const themes = path.join(tmp.dir, "themes");
      makeTheme(path.join(themes, "alpha"), { experimental: true, icon: "<svg/>" });
      makeTheme(path.join(themes, "beta"), { id: "other" });
      makeTheme(path.join(themes, "gamma"), { api: 99 });
      mkdirSync(path.join(themes, "delta"));
      writeFileSync(path.join(themes, "delta", "theme.json"), "{ nope");
      mkdirSync(path.join(themes, "empty"));
      makeTheme(path.join(themes, ".npm"));
      writeFileSync(path.join(themes, "file.txt"), "not a theme");
      const outside = makeTheme(path.join(tmp.dir, "dev-theme"), { id: "linked" });
      symlinkSync(outside, path.join(themes, "linked"), "dir");
      symlinkSync(path.join(tmp.dir, "gone"), path.join(themes, "dangling"), "dir");

      const reg = new ThemeRegistry(themes, { bundledDir: path.join(tmp.dir, "no-bundled") });
      const byId = Object.fromEntries(reg.list().map((t) => [t.id, t]));
      expect(Object.keys(byId).sort()).toEqual(["alpha", "beta", "dangling", "delta", "empty", "gamma", "linked"]);
      expect(byId.alpha).toMatchObject({
        name: "Theme alpha",
        url: "/themes/alpha/",
        experimental: true,
        icon: "<svg/>",
        dir: path.join(themes, "alpha"),
      });
      expect(byId.alpha!.error).toBeUndefined();
      expect(byId.beta!.error).toMatch(/id "other" does not match the folder "beta"/);
      expect(byId.gamma!.error).toMatch(/api 99 is newer/);
      expect(byId.delta!.error).toMatch(/not valid JSON/);
      expect(byId.empty!.error).toMatch(/no theme.json/);
      expect(byId.linked).toMatchObject({ linked: true, name: "Theme dev-theme" });
      expect(byId.linked!.source).toMatch(/^link:/);
      expect(byId.dangling).toMatchObject({ linked: true, error: "linked folder is missing" });

      expect(reg.get("alpha")).toBeDefined();
      expect(reg.get("gamma")).toBeUndefined();
      expect(reg.has("gamma")).toBe(true);
      expect(reg.has("nope")).toBe(false);

      // A rescan sees a new folder.
      makeTheme(path.join(themes, "late"));
      expect(reg.get("late")).toBeUndefined();
      reg.scan();
      expect(reg.get("late")).toBeDefined();
    } finally {
      tmp.cleanup();
    }
  });

  it("is empty for a missing folder", () => {
    expect(new ThemeRegistry("/nonexistent/spgui-themes", { bundledDir: "/nonexistent/bundled" }).list()).toEqual([]);
  });

  it("lists bundled views after the person's own, an install of the same id winning; disabled ones stay listed", () => {
    const tmp = tempDir();
    try {
      const themes = path.join(tmp.dir, "themes");
      const bundled = path.join(tmp.dir, "bundled", "views");
      makeTheme(path.join(bundled, "canvas"), { name: "Canvas (bundled)", version: "1.0.0", experimental: true });
      makeTheme(path.join(bundled, "office"), { name: "Office", version: "1.0.0" });
      makeTheme(path.join(themes, "canvas"), { name: "Canvas (mine)", version: "2.0.0" });
      makeTheme(path.join(themes, "zeta"));
      let off: string[] = [];
      const reg = new ThemeRegistry(themes, { bundledDir: bundled, disabled: () => off });
      expect(reg.list().map((t) => [t.id, t.name, t.bundled ?? false])).toEqual([
        ["canvas", "Canvas (mine)", false],
        ["zeta", "Theme zeta", false],
        ["office", "Office", true],
      ]);
      expect(reg.get("office")).toMatchObject({ source: "bundled", bundled: true, dir: path.join(bundled, "office") });
      expect(reg.get("canvas")!.version).toBe("2.0.0");
      expect(reg.isBundled("canvas")).toBe(true);
      expect(reg.isBundled("zeta")).toBe(false);
      // Disabled: listed, flagged, but not loadable.
      off = ["view:office", "view:zeta"];
      reg.scan();
      expect(
        reg
          .list()
          .filter((t) => t.disabled)
          .map((t) => t.id),
      ).toEqual(["zeta", "office"]);
      expect(reg.get("office")).toBeUndefined();
      expect(reg.has("office")).toBe(true);
      off = [];
      reg.scan();
      expect(reg.get("office")).toBeDefined();
      // Removing a bundled view says to disable it instead; removing an install of the same id works.
      expect(() => removeTheme(themes, "office", { bundledDir: bundled })).toThrow(
        /bundled with sessionpipe-gui.*view disable office/,
      );
      expect(removeTheme(themes, "canvas", { bundledDir: bundled }).message).toBe("removed canvas");
      expect(new ThemeRegistry(themes, { bundledDir: bundled }).get("canvas")!.name).toBe("Canvas (bundled)");
      const out = formatList(themes, listThemes(themes, { bundledDir: bundled, disabled: () => ["view:office"] }));
      expect(out).toMatch(/^canvas\s+Canvas \(bundled\) 1\.0\.0\s+\[bundled, experimental\]/m);
      expect(out).toMatch(/^office\s+Office 1\.0\.0\s+\[bundled, disabled\]/m);
    } finally {
      tmp.cleanup();
    }
  });

  it("publicTheme keeps dir for loopback only", () => {
    const t = { id: "a", name: "A", version: "1", api: 1, url: "/themes/a/", dir: "/x/a" };
    expect(publicTheme(t, true)).toHaveProperty("dir", "/x/a");
    expect(publicTheme(t, false)).not.toHaveProperty("dir");
  });
});

describe("resolveInside", () => {
  it("serves only regular files under the theme's real folder", () => {
    const tmp = tempDir();
    try {
      const dir = makeTheme(path.join(tmp.dir, "t"), {}, { "a.css": "" });
      mkdirSync(path.join(dir, "sub"), { recursive: true });
      writeFileSync(path.join(dir, "sub", "x.png"), "png");
      writeFileSync(path.join(tmp.dir, "secret.txt"), "s");
      symlinkSync(path.join(tmp.dir, "secret.txt"), path.join(dir, "leak.txt"));
      // macOS: the temp dir is a symlink, so the real path is what comes back.
      const real = realpathSync(dir);
      expect(resolveInside(dir, "index.js")).toBe(path.join(real, "index.js"));
      expect(resolveInside(dir, "sub/x.png")).toBe(path.join(real, "sub", "x.png"));
      expect(resolveInside(dir, "")).toBeNull();
      expect(resolveInside(dir, "sub")).toBeNull();
      expect(resolveInside(dir, "../secret.txt")).toBeNull();
      expect(resolveInside(dir, "sub/../../secret.txt")).toBeNull();
      expect(resolveInside(dir, "./index.js")).toBeNull();
      expect(resolveInside(dir, "sub\\..\\index.js")).toBeNull();
      expect(resolveInside(dir, "leak.txt")).toBeNull();
      expect(resolveInside(dir, "missing.js")).toBeNull();
    } finally {
      tmp.cleanup();
    }
  });
});

describe("theme routes", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  let themes: string;

  beforeAll(async () => {
    tmp = tempDir();
    themes = path.join(tmp.dir, "themes");
    makeTheme(
      path.join(themes, "one"),
      { style: "one.css" },
      { "one.css": ".one{}", "data.json": "{}", "pic.png": "png", "blob.bin": "x" },
    );
    makeTheme(path.join(themes, "broken"), { api: 42 });
    writeFileSync(path.join(tmp.dir, "secret.txt"), "secret");
    symlinkSync(path.join(tmp.dir, "secret.txt"), path.join(themes, "one", "leak.txt"));
    makeTheme(path.join(tmp.dir, "bundled", "views", "shipped"), { name: "Shipped" });
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

  it("disables and enables a view on POST (loopback), remembered in config.json", async () => {
    const list = async () =>
      ((await (await fetch(url(THEME_ROUTES.list))).json()) as { themes: InstalledTheme[] }).themes;
    expect((await list()).find((t) => t.id === "shipped")).toMatchObject({ bundled: true, source: "bundled" });
    expect((await fetch(url("/themes/shipped/index.js"))).status).toBe(200);
    const res = await fetch(url(`${THEME_ROUTES.toggle}/shipped/disable`), { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { themes: InstalledTheme[] }).themes.find((t) => t.id === "shipped")!.disabled).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(path.join(tmp.dir, "config.json"), "utf8")).disabled).toEqual(["view:shipped"]);
    expect((await fetch(url("/themes/shipped/index.js"))).status).toBe(404);
    expect(app.config().disabled).toEqual(["view:shipped"]);
    const on = await fetch(url(`${THEME_ROUTES.toggle}/shipped/enable`), { method: "POST" });
    expect(
      ((await on.json()) as { themes: InstalledTheme[] }).themes.find((t) => t.id === "shipped")!.disabled,
    ).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(tmp.dir, "config.json"), "utf8")).disabled).toBeUndefined();
    expect((await fetch(url(`${THEME_ROUTES.toggle}/nope/disable`), { method: "POST" })).status).toBe(404);
    expect((await fetch(url(`${THEME_ROUTES.toggle}/Nope!/disable`), { method: "POST" })).status).toBe(400);
  });

  it("lists installed themes, with dir on loopback and errors kept", async () => {
    const res = await fetch(url(THEME_ROUTES.list));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { themes: list } = (await res.json()) as { themes: InstalledTheme[] };
    expect(list.map((t) => t.id)).toEqual(["broken", "one", "shipped"]);
    expect(list[1]).toMatchObject({ name: "Theme one", url: "/themes/one/", dir: path.join(themes, "one") });
    expect(list[0]!.error).toMatch(/api 42/);
  });

  it("reloads on POST (loopback) and sees a new theme", async () => {
    makeTheme(path.join(themes, "two"));
    let list = ((await (await fetch(url(THEME_ROUTES.list))).json()) as { themes: InstalledTheme[] }).themes;
    expect(list.map((t) => t.id)).toEqual(["broken", "one", "shipped"]);
    const res = await fetch(url(THEME_ROUTES.reload), { method: "POST" });
    expect(res.status).toBe(200);
    list = ((await res.json()) as { themes: InstalledTheme[] }).themes;
    expect(list.map((t) => t.id)).toEqual(["broken", "one", "two", "shipped"]);
    expect((await fetch(url(THEME_ROUTES.reload))).status).toBe(405);
  });

  it("keeps per-theme state: 204 when empty, PUT then GET, limits and errors", async () => {
    const state = url(`${THEME_ROUTES.state}/one/state`);
    expect((await fetch(state)).status).toBe(204);
    const put = (body: BodyInit, headers: Record<string, string> = {}) =>
      fetch(state, { method: "PUT", body, headers: { "content-type": "application/json", ...headers } });
    expect((await put(JSON.stringify({ layout: "grid", n: 2 }))).status).toBe(204);
    const got = await fetch(state);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await got.json()).toEqual({ layout: "grid", n: 2 });
    expect(readFileSync(path.join(tmp.dir, "themes-state", "one.json"), "utf8")).toBe('{"layout":"grid","n":2}');
    // Any JSON value, not only objects.
    expect((await put("[1,2]")).status).toBe(204);
    expect(await (await fetch(state)).json()).toEqual([1, 2]);
    expect((await put("not json")).status).toBe(400);
    expect((await put(JSON.stringify("x".repeat(STATE_MAX_BYTES)))).status).toBe(413);
    expect((await put(JSON.stringify("x".repeat(STATE_MAX_BYTES - 2)))).status).toBe(204);
    expect((await fetch(url(`${THEME_ROUTES.state}/nope/state`))).status).toBe(404);
    expect((await fetch(url(`${THEME_ROUTES.state}/Nope!/state`))).status).toBe(400);
    // A broken theme still has a state slot (its data survives a fix).
    expect((await fetch(url(`${THEME_ROUTES.state}/broken/state`))).status).toBe(204);
  });

  it("versions the state: an ETag on read and write, If-Match refuses a stale write with 412", async () => {
    const state = url(`${THEME_ROUTES.state}/shipped/state`);
    const empty = await fetch(state);
    expect(empty.status).toBe(204);
    expect(empty.headers.get("etag")).toBe('"0"');
    const put = (body: unknown, ifMatch?: string) =>
      fetch(state, {
        method: "PUT",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...(ifMatch ? { "if-match": ifMatch } : {}) },
      });
    const first = await put({ n: 1 }, '"0"');
    expect(first.status).toBe(204);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[\w-]{16}"$/);
    expect((await fetch(state)).headers.get("etag")).toBe(etag);
    // A second device that read before the first write must merge, not overwrite.
    const stale = await put({ n: 2 }, '"0"');
    expect(stale.status).toBe(412);
    expect(await stale.json()).toEqual({ reason: "conflict" });
    expect(stale.headers.get("etag")).toBe(etag);
    expect(await (await fetch(state)).json()).toEqual({ n: 1 });
    expect((await put({ n: 3 }, etag)).status).toBe(204);
    // Without If-Match a write is blind, as before.
    expect((await put({ n: 4 })).status).toBe(204);
    expect(await (await fetch(state)).json()).toEqual({ n: 4 });
  });

  it("serves theme files with the right types and caching, and nothing outside", async () => {
    const js = await fetch(url("/themes/one/index.js"));
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("no-cache");
    expect(await js.text()).toContain("mount()");
    const css = await fetch(url("/themes/one/one.css"));
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("cache-control")).toBe("no-cache");
    const json = await fetch(url("/themes/one/data.json"));
    expect(json.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(json.headers.get("cache-control")).toBe("no-cache");
    const png = await fetch(url("/themes/one/pic.png"));
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await fetch(url("/themes/one/blob.bin"))).headers.get("content-type")).toBe("application/octet-stream");
    const head = await fetch(url("/themes/one/index.js"), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(js.headers.get("content-length"));

    expect((await fetch(url("/themes/one/missing.js"))).status).toBe(404);
    expect((await fetch(url("/themes/one/"))).status).toBe(404);
    expect((await fetch(url("/themes/one"))).status).toBe(404);
    expect((await fetch(url("/themes/broken/index.js"))).status).toBe(404);
    expect((await fetch(url("/themes/nope/index.js"))).status).toBe(404);
    // A symlink inside the theme pointing outside it is refused.
    expect((await fetch(url("/themes/one/leak.txt"))).status).toBe(404);
    // Traversal: the URL parser collapses `..` (encoded or not) before routing, so the
    // request lands on the SPA fallback, never on a file above the theme.
    for (const p of [
      "/themes/one/../../secret.txt",
      "/themes/one/%2e%2e/%2e%2e/secret.txt",
      "/themes/one/..%2fsecret.txt",
    ]) {
      const r = await fetch(url(p));
      expect([404, 200, 503]).toContain(r.status); // 503: no built web app in this test
      expect(await r.text()).not.toContain("secret");
    }
  });

  it("needs the UI key away from loopback", async () => {
    // The LAN case is covered by uiAuth's own tests; here only that the guard is wired.
    const ctx = { remote: { ip: "10.0.0.2", loopback: false }, url: new URL("http://x/"), cookies: () => ({}) };
    expect(app.router.match("GET", THEME_ROUTES.list)).not.toBeNull();
    const reply = await app.router.match("GET", THEME_ROUTES.list)!.handler(ctx as never);
    expect(reply).toMatchObject({ status: 401 });
    const files = await app.router
      .match("GET", "/themes/one/index.js")!
      .handler({ ...ctx, params: { id: "one", rest: "index.js" } } as never);
    expect(files).toMatchObject({ status: 401 });
  });
});

describe("theme install", () => {
  let tmp: { dir: string; cleanup: () => void };
  let themes: string;
  beforeAll(() => {
    tmp = tempDir();
    themes = path.join(tmp.dir, "themes");
  });
  afterAll(() => tmp.cleanup());

  it("adds a folder by copying it and records the source", async () => {
    const src = makeTheme(path.join(tmp.dir, "src-folder"), { id: "folder", name: "From folder" }, { "a.css": "" });
    const r = await addTheme(themes, src);
    expect(r.replaced).toBe(false);
    expect(r.dir).toBe(path.join(themes, "folder"));
    expect(r.message).toMatch(/^installed folder \(From folder 1\.0\.0\) from /);
    expect(existsSync(path.join(themes, "folder", "a.css"))).toBe(true);
    const installed = JSON.parse(readFileSync(path.join(themes, "folder", "theme.json"), "utf8"));
    expect(installed).toMatchObject({ id: "folder", source: src, entry: "index.js" });
    // Again: replaced, and the copy is fresh.
    writeFileSync(path.join(src, "b.css"), "");
    const again = await addTheme(themes, src);
    expect(again.replaced).toBe(true);
    expect(again.message).toMatch(/^replaced folder/);
    expect(existsSync(path.join(themes, "folder", "b.css"))).toBe(true);
  });

  it("adds a .tgz made with tar, finding theme.json one level down", async () => {
    const src = makeTheme(path.join(tmp.dir, "pack", "package"), { id: "packed", name: "Packed", version: "2.0.0" });
    const tgz = path.join(tmp.dir, "packed-2.0.0.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", path.dirname(src), "package"]);
    const r = await addTheme(themes, tgz);
    expect(r.manifest).toMatchObject({ id: "packed", version: "2.0.0", source: tgz });
    expect(r.message).toContain(`from ${tgz}`);
    expect(readFileSync(path.join(themes, "packed", "index.js"), "utf8")).toContain("mount");
    expect(listThemes(themes).find((t) => t.id === "packed")).toMatchObject({ source: tgz });
  });

  it("links a folder as a symlink and removes the link only", () => {
    const src = makeTheme(path.join(tmp.dir, "dev"), { id: "dev", name: "Dev" });
    const r = linkTheme(themes, src);
    expect(r.message).toMatch(/^linked dev \(Dev 1\.0\.0\) → /);
    expect(lstatSync(path.join(themes, "dev")).isSymbolicLink()).toBe(true);
    expect(listThemes(themes).find((t) => t.id === "dev")).toMatchObject({ linked: true });
    // An edit shows without reinstalling.
    writeFileSync(path.join(src, "theme.json"), JSON.stringify({ id: "dev", name: "Dev 2", version: "1.1.0", api: 1 }));
    expect(listThemes(themes).find((t) => t.id === "dev")).toMatchObject({ name: "Dev 2", version: "1.1.0" });
    const rm = removeTheme(themes, "dev");
    expect(rm.message).toMatch(/^removed dev \(the link/);
    expect(existsSync(path.join(themes, "dev"))).toBe(false);
    expect(existsSync(path.join(src, "index.js"))).toBe(true);
  });

  it("removes an installed copy, and refuses what is not there", () => {
    expect(removeTheme(themes, "packed").message).toBe("removed packed");
    expect(existsSync(path.join(themes, "packed"))).toBe(false);
    expect(() => removeTheme(themes, "packed")).toThrow(ThemeInstallError);
    expect(() => removeTheme(themes, "../folder")).toThrow(/no theme/);
    expect(existsSync(path.join(themes, "folder"))).toBe(true);
  });

  it("refuses sources it cannot read", async () => {
    await expect(addTheme(themes, path.join(tmp.dir, "nothing-here"))).rejects.toThrow(/does not exist/);
    mkdirSync(path.join(tmp.dir, "no-manifest"));
    await expect(addTheme(themes, path.join(tmp.dir, "no-manifest"))).rejects.toThrow(/no theme.json/);
    const bad = makeTheme(path.join(tmp.dir, "bad-id"), { id: "Bad Id" });
    await expect(addTheme(themes, bad)).rejects.toThrow(/id "Bad Id"/);
    await expect(addTheme(themes, "")).rejects.toThrow(/needs a source/);
    expect(() => linkTheme(themes, path.join(tmp.dir, "nothing-here"))).toThrow(/not a folder/);
  });

  it("formats the list for the terminal", () => {
    makeTheme(path.join(themes, "broken"), { api: 7 });
    const out = formatList(themes, listThemes(themes));
    expect(out).toMatch(/^broken\s+\(broken: theme.json: api 7 is newer/m);
    expect(out).toMatch(/^folder\s+From folder 1\.0\.0\s+← /m);
    expect(out).toContain(path.join(themes, "folder"));
    expect(formatList(themes, [])).toBe(`no themes installed in ${themes}\n`);
  });
});
