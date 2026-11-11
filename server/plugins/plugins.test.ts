// SPDX-License-Identifier: Apache-2.0
// Plugins: manifest validation, the host (activate / deactivate / reload, settings with
// masked secrets, the suggestion stream, error isolation, log masking), the routes, the
// bundled plugins that ship with the GUI (listed, off until enabled, overridable, not
// removable) and the installer bound to the plugin kind. A fixture plugin is written into
// a temp dir.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ROUTES, type Snapshot, type StreamMessage } from "../../shared/api.js";
import { type InstalledPlugin, PLUGIN_ROUTES } from "../../shared/plugin-api.js";
import { Session, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { readGuiConfig, setDisabled, setEnabled } from "../config.js";
import { addPlugin, linkPlugin, listPlugins, removePlugin } from "./install.js";
import { validatePluginManifest } from "./registry.js";

/** The install tests look at their own folder alone, not the skins/plugins that ship in dist/bundled. */
const NO_BUNDLED = { bundledDir: "/nonexistent/spgui-bundled" };

declare global {
  var __fixturePlugin:
    | {
        activations: number;
        deactivations: number;
        settings: Record<string, unknown>[];
        errors: string[];
        events: number;
        host?: { name: string; version: string };
        url?: string;
        stored?: unknown;
      }
    | undefined;
}

/** A plugin that counts its lifecycle, suggests "allow" for every open permission it sees
 *  (unless told not to), records settings changes, and can be told to throw in a listener. */
const FIXTURE_JS = `
const g = globalThis;
g.__fixturePlugin ??= { activations: 0, deactivations: 0, settings: [], errors: [], events: 0 };
export default {
  async activate(api) {
    const s = g.__fixturePlugin;
    s.activations++;
    s.host = api.host;
    api.log("info", "token is " + api.settings.get().token);
    const offSettings = api.settings.onChange((v) => s.settings.push(v));
    const off = api.events.subscribe((m) => {
      s.events++;
      if (api.settings.get().throwOnEvent) throw new Error("fixture listener boom");
      if (m.kind !== "event") return;
      s.url = api.sessions.url(m.session.key);
      for (const a of m.session.openAttentions) {
        if (a.kind !== "permission" || !a.answerable || api.settings.get().autoSuggest === false) continue;
        try {
          api.suggest({ session: m.session.key, attentionId: a.attentionId, decision: "allow", by: "Fixture on Test", note: "looks fine" });
        } catch (e) { s.errors.push(e.message); }
      }
      if (m.event.type === "session.started") {
        try { api.suggest({ session: m.session.key, attentionId: "nope", decision: "allow", by: "x" }); } catch (e) { s.errors.push(e.message); }
      }
    });
    await api.storage.set({ n: 1 });
    s.stored = await api.storage.get();
    return { deactivate() { s.deactivations++; off(); offSettings(); } };
  },
};
`;

const FIXTURE_MANIFEST = {
  id: "fixture",
  name: "Fixture",
  version: "1.2.3",
  kind: "plugin",
  api: 1,
  description: "Counts things.",
  settings: [
    { key: "token", label: "Token", type: "secret", help: "never shown" },
    { key: "level", label: "Level", type: "select", options: ["low", "high"], default: "low" },
    { key: "tags", label: "Tags", type: "multiselect", options: ["a", "b", "c"], default: ["a"] },
    { key: "n", label: "N", type: "number", default: 20 },
    { key: "autoSuggest", label: "Auto", type: "boolean", default: true },
    { key: "throwOnEvent", label: "Throw", type: "boolean", default: false },
    { key: "name", label: "Name", type: "string" },
  ],
};

function makePlugin(dir: string, manifest: Record<string, unknown> = {}, js = FIXTURE_JS): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({ ...FIXTURE_MANIFEST, id: path.basename(dir), ...manifest }),
  );
  writeFileSync(path.join(dir, "index.js"), js);
  return dir;
}

describe("plugin manifest validation", () => {
  it("accepts a full manifest and fills the entry", () => {
    const m = validatePluginManifest(FIXTURE_MANIFEST);
    expect(m).toMatchObject({ id: "fixture", kind: "plugin", entry: "index.js", api: 1 });
    expect(m.settings).toHaveLength(7);
  });
  it("refuses other kinds, a newer api, bad settings", () => {
    const base = { id: "ok", name: "Ok", version: "1", kind: "plugin", api: 1 };
    expect(() => validatePluginManifest({ ...base, kind: "view" })).toThrow(/kind "view" is not "plugin"/);
    expect(() => validatePluginManifest({ ...base, kind: undefined })).toThrow(/"kind" is required/);
    expect(() => validatePluginManifest({ ...base, api: 2 })).toThrow(/api 2 is newer/);
    expect(() => validatePluginManifest({ ...base, entry: "../x.js" })).toThrow(/entry/);
    expect(() => validatePluginManifest({ ...base, settings: "x" })).toThrow(/"settings" must be an array/);
    expect(() => validatePluginManifest({ ...base, settings: [{ key: "a", label: "A", type: "colour" }] })).toThrow(
      /unknown type "colour"/,
    );
    expect(() => validatePluginManifest({ ...base, settings: [{ key: "a", label: "A", type: "select" }] })).toThrow(
      /needs "options"/,
    );
    expect(() =>
      validatePluginManifest({ ...base, settings: [{ key: "a", label: "A", type: "number", default: "5" }] }),
    ).toThrow(/default must be a number/);
    expect(() =>
      validatePluginManifest({
        ...base,
        settings: [
          { key: "a", label: "A", type: "string" },
          { key: "a", label: "B", type: "string" },
        ],
      }),
    ).toThrow(/listed twice/);
  });
});

/** The plugin folders must sit inside the repository: vitest's module loader (vite-node)
 *  serves `import()` only from under the project root. The real host imports from anywhere. */
const inRepoTempDir = (): { dir: string; cleanup: () => void } => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  mkdirSync(path.join(root, "test", ".tmp"), { recursive: true }); // .gitignore has .tmp/
  const dir = mkdtempSync(path.join(root, "test", ".tmp", "plugins-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

describe("plugin host and routes", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  let local: { dir: string; cleanup: () => void };
  let plugins: string;
  let stderr: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);

  beforeAll(async () => {
    tmp = tempDir();
    local = inRepoTempDir();
    plugins = path.join(local.dir, "plugins");
    makePlugin(path.join(plugins, "fixture"));
    makePlugin(
      path.join(plugins, "throws"),
      { settings: [] },
      "export default { activate() { throw new Error('no config, run setup'); } };",
    );
    makePlugin(path.join(plugins, "noactivate"), { settings: [] }, "export default { mount() {} };");
    makePlugin(path.join(plugins, "wrongkind"), { kind: "view", settings: [] });
    mkdirSync(path.join(tmp.dir, "plugins-settings"), { recursive: true });
    writeFileSync(path.join(tmp.dir, "plugins-settings", "fixture.json"), JSON.stringify({ token: "secret-abcd1234" }));
    globalThis.__fixturePlugin = undefined;
    stderr = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      app = await createApp({
        port: 0,
        stateDir: tmp.dir,
        pluginsDir: plugins,
        outbox: false,
        quiet: true,
        webDir: tmp.dir,
        // No bundled plugins beside this views dir: the list is the fixtures alone.
        bundledDir: path.join(local.dir, "bundled", "views"),
      });
    } finally {
      process.stderr.write = realWrite;
    }
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
    local.cleanup();
  });

  const url = (p: string) => `${app.url}${p}`;
  const list = async (): Promise<InstalledPlugin[]> =>
    ((await (await fetch(url(PLUGIN_ROUTES.list))).json()) as { plugins: InstalledPlugin[] }).plugins;
  const byId = async () => Object.fromEntries((await list()).map((p) => [p.id, p]));

  it("activates the good plugin, lists the broken ones with their error, and never crashes", async () => {
    const p = await byId();
    expect(p.fixture).toMatchObject({
      status: "active",
      name: "Fixture",
      version: "1.2.3",
      dir: path.join(plugins, "fixture"),
    });
    expect(p.fixture!.error).toBeUndefined();
    expect(p.throws).toMatchObject({ status: "error", error: "no config, run setup" });
    expect(p.noactivate).toMatchObject({ status: "error", error: expect.stringMatching(/no activate\(api\)/) });
    expect(p.wrongkind).toMatchObject({ status: "error", error: expect.stringMatching(/kind "view"/) });
    const g = globalThis.__fixturePlugin!;
    expect(g.activations).toBe(1);
    expect(g.host).toMatchObject({ name: "sessionpipe-gui" });
    expect(g.stored).toEqual({ n: 1 });
    expect(existsSync(path.join(tmp.dir, "plugins-storage", "fixture.json"))).toBe(true);
  });

  it("masks secrets in the listing and in the log, fills defaults", async () => {
    const p = (await byId()).fixture!;
    expect(p.values).toEqual({
      token: "••••1234",
      level: "low",
      tags: ["a"],
      n: 20,
      autoSuggest: true,
      throwOnEvent: false,
    });
    const logged = stderr.join("");
    expect(logged).toContain("[plugin:fixture] info: token is ••••");
    expect(logged).not.toContain("secret-abcd1234");
    expect(logged).toContain("[plugin:throws] error: failed to start: no config, run setup");
  });

  it("saves settings from loopback: the plugin is told, a masked secret stays, bad values are refused", async () => {
    const put = (id: string, body: unknown) =>
      fetch(url(`${PLUGIN_ROUTES.settings}/${id}/settings`), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const res = await put("fixture", { token: "••••1234", level: "high", n: 5, tags: ["b", "c"], name: "Misha" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { settings: Record<string, unknown> }).settings).toMatchObject({
      token: "••••1234",
      level: "high",
      n: 5,
      tags: ["b", "c"],
      name: "Misha",
    });
    const g = globalThis.__fixturePlugin!;
    expect(g.settings.at(-1)).toMatchObject({ token: "secret-abcd1234", level: "high", n: 5 });
    const file = path.join(tmp.dir, "plugins-settings", "fixture.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      token: "secret-abcd1234",
      level: "high",
      n: 5,
      tags: ["b", "c"],
      name: "Misha",
    });
    // A new secret replaces; an empty one removes.
    expect((await put("fixture", { token: "fresh-token-9876" })).status).toBe(200);
    expect((await byId()).fixture!.values!.token).toBe("••••9876");
    expect((await put("fixture", { token: "" })).status).toBe(200);
    expect((await byId()).fixture!.values!.token).toBe("");
    // Refusals.
    const bad = await put("fixture", { level: "medium" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ reason: "bad_value", field: "level" });
    expect((await put("fixture", { n: "five" })).status).toBe(400);
    expect((await put("fixture", { tags: ["z"] })).status).toBe(400);
    expect((await put("nope", { a: 1 })).status).toBe(404);
    expect((await put("Bad!", { a: 1 })).status).toBe(400);
    expect((await put("fixture", "[]")).status).toBe(400);
    // A plugin that failed gets another go after a save (status stays error here: it still throws).
    expect((await put("throws", {})).status).toBe(200);
    expect((await byId()).throws!.status).toBe("error");
  });

  it("streams a suggestion for an open permission, lists it in the snapshot, drops it when the attention clears", async () => {
    const res = await fetch(url(ROUTES.ui.stream));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const until = async (pred: () => boolean) => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > 5000) throw new Error(`timeout; got:\n${text}`);
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
    };
    await until(() => text.includes("event: snapshot"));
    const s = new Session("sugg");
    app.store.ingest([s.ev("session.started")], "http");
    app.store.ingest(
      [s.ev("attention.needed", { attention_id: "perm-1", kind: "permission", tool: "Bash", message: "rm -rf dist" })],
      "http",
    );
    await until(() => text.includes("event: suggestion"));
    const frame = text.split("\n\n").find((f) => f.startsWith("event: suggestion"))!;
    const msg = JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as StreamMessage & { kind: "suggestion" };
    expect(msg.suggestion).toMatchObject({
      session: "claude-code:sugg",
      attentionId: "perm-1",
      decision: "allow",
      by: "Fixture on Test",
      plugin: "fixture",
      note: "looks fine",
    });
    const snap = (await (await fetch(url(ROUTES.ui.snapshot))).json()) as Snapshot;
    expect(snap.suggestions).toHaveLength(1);
    expect(snap.suggestions![0]).toMatchObject({ attentionId: "perm-1" });
    // A fresh stream gets it on the first frame.
    const second = await fetch(url(ROUTES.ui.stream));
    const r2 = second.body!.getReader();
    let t2 = "";
    while (!t2.includes("\n\n")) t2 += dec.decode((await r2.read()).value!, { stream: true });
    const first = JSON.parse(t2.split("\n\n")[0]!.slice("event: snapshot\ndata: ".length)) as { snapshot: Snapshot };
    expect(first.snapshot.suggestions).toHaveLength(1);
    await r2.cancel();
    // The plugin's bad call was refused with a reason, not swallowed.
    expect(globalThis.__fixturePlugin!.errors).toContainEqual(expect.stringMatching(/not an open permission/));
    // Cleared: gone from the snapshot; a notification twin never gets one.
    app.store.ingest([s.ev("attention.cleared", { attention_id: "perm-1" })], "http");
    await new Promise((r) => setTimeout(r, 50));
    const after = (await (await fetch(url(ROUTES.ui.snapshot))).json()) as Snapshot;
    expect(after.suggestions ?? []).toEqual([]);
    const url1 = globalThis.__fixturePlugin!.url!;
    expect(url1).toMatch(/^http:\/\/.+\/s\/claude-code\/sugg\?k=/);
    await reader.cancel();
  });

  it("a listener that throws is logged and the stream goes on", async () => {
    const put = (body: unknown) =>
      fetch(url(`${PLUGIN_ROUTES.settings}/fixture/settings`), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    await put({ throwOnEvent: true });
    const lines: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const s = new Session("boom");
      const r = app.store.ingest([s.ev("session.started")], "http");
      expect(r.accepted).toBe(1);
      expect(app.store.session("claude-code:boom")).toBeDefined();
    } finally {
      process.stderr.write = realWrite;
    }
    expect(lines.join("")).toContain("[plugin:fixture] error: listener threw: fixture listener boom");
    await put({ throwOnEvent: false });
  });

  it("reloads on POST (loopback): deactivates, re-reads the folder, imports afresh", async () => {
    const g = globalThis.__fixturePlugin!;
    expect(g.deactivations).toBe(0);
    makePlugin(
      path.join(plugins, "late"),
      { settings: [] },
      "export default { activate() { return { deactivate() {} }; } };",
    );
    const res = await fetch(url(PLUGIN_ROUTES.reload), { method: "POST" });
    expect(res.status).toBe(200);
    const after = Object.fromEntries(
      ((await res.json()) as { plugins: InstalledPlugin[] }).plugins.map((p) => [p.id, p]),
    );
    expect(after.late).toMatchObject({ status: "active" });
    expect(after.fixture).toMatchObject({ status: "active" });
    expect(g.deactivations).toBe(1);
    expect(g.activations).toBe(2);
    expect((await fetch(url(PLUGIN_ROUTES.reload))).status).toBe(405);
  });

  it("needs the UI key away from loopback, and refuses reload and settings from the LAN", async () => {
    const ctx = { remote: { ip: "10.0.0.2", loopback: false }, url: new URL("http://x/"), cookies: () => ({}) };
    const reply = await app.router.match("GET", PLUGIN_ROUTES.list)!.handler(ctx as never);
    expect(reply).toMatchObject({ status: 401 });
    const key = app.config().uiKey;
    const authed = { ...ctx, cookies: () => ({ spgui: key }) };
    const listed = (await app.router.match("GET", PLUGIN_ROUTES.list)!.handler({ ...authed, params: {} } as never)) as {
      status: number;
      json: { plugins: InstalledPlugin[] };
    };
    expect(listed.status).toBe(200);
    expect(listed.json.plugins[0]!.dir).toBeUndefined();
    expect(
      await app.router.match("POST", PLUGIN_ROUTES.reload)!.handler({ ...authed, params: {} } as never),
    ).toMatchObject({
      status: 403,
    });
    expect(
      await app.router
        .match("PUT", `${PLUGIN_ROUTES.settings}/fixture/settings`)!
        .handler({ ...authed, params: { id: "fixture" } } as never),
    ).toMatchObject({ status: 403 });
  });

  it("stops every plugin at close", async () => {
    const g = globalThis.__fixturePlugin!;
    const before = g.deactivations;
    await app.plugins.stop();
    expect(g.deactivations).toBe(before + 1);
    expect((await byId()).fixture!.status).toBe("inactive");
    await app.plugins.start();
    expect((await byId()).fixture!.status).toBe("active");
  });
});

describe("bundled plugins", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  let local: { dir: string; cleanup: () => void };
  let plugins: string;
  let bundled: string;
  const JS = `
const g = globalThis;
g.__bundledPlugin ??= { activations: 0, deactivations: 0 };
export default { activate() { g.__bundledPlugin.activations++; return { deactivate() { g.__bundledPlugin.deactivations++; } }; } };
`;
  const counts = () =>
    (globalThis as { __bundledPlugin?: { activations: number; deactivations: number } }).__bundledPlugin;

  beforeAll(async () => {
    tmp = tempDir();
    local = inRepoTempDir();
    plugins = path.join(local.dir, "plugins");
    bundled = path.join(local.dir, "bundled", "plugins");
    makePlugin(
      path.join(bundled, "shipped"),
      { name: "Shipped", settings: [{ key: "token", label: "Token", type: "secret" }] },
      JS,
    );
    makePlugin(path.join(bundled, "other"), { name: "Other", settings: [] }, JS);
    app = await createApp({
      port: 0,
      stateDir: tmp.dir,
      pluginsDir: plugins,
      outbox: false,
      quiet: true,
      webDir: tmp.dir,
      bundledDir: path.join(local.dir, "bundled", "views"),
    });
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
    local.cleanup();
  });

  const url = (p: string) => `${app.url}${p}`;
  const byId = async (): Promise<Record<string, InstalledPlugin>> =>
    Object.fromEntries(
      ((await (await fetch(url(PLUGIN_ROUTES.list))).json()) as { plugins: InstalledPlugin[] }).plugins.map((p) => [
        p.id,
        p,
      ]),
    );
  const config = () =>
    JSON.parse(readFileSync(path.join(tmp.dir, "config.json"), "utf8")) as { enabled?: string[]; disabled?: string[] };

  it("are listed as bundled and disabled, and never start on their own", async () => {
    const p = await byId();
    expect(Object.keys(p)).toEqual(["other", "shipped"]);
    expect(p.shipped).toMatchObject({
      bundled: true,
      disabled: true,
      status: "inactive",
      source: "bundled",
      dir: path.join(bundled, "shipped"),
    });
    expect(p.shipped!.error).toBeUndefined();
    expect(counts()).toBeUndefined();
    expect(config().enabled).toBeUndefined();
  });

  it("saving settings on a disabled plugin keeps it off", async () => {
    const res = await fetch(url(`${PLUGIN_ROUTES.settings}/shipped/settings`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "tok-abcd1234" }),
    });
    expect(res.status).toBe(200);
    expect((await byId()).shipped).toMatchObject({ status: "inactive", disabled: true, values: { token: "••••1234" } });
    expect(counts()).toBeUndefined();
  });

  it("enable on POST (loopback) starts it and is remembered; disable stops it", async () => {
    const on = await fetch(url(`${PLUGIN_ROUTES.toggle}/shipped/enable`), { method: "POST" });
    expect(on.status).toBe(200);
    const listed = ((await on.json()) as { plugins: InstalledPlugin[] }).plugins.find((p) => p.id === "shipped")!;
    expect(listed).toMatchObject({ status: "active", bundled: true });
    expect(listed.disabled).toBeUndefined();
    expect(counts()).toEqual({ activations: 1, deactivations: 0 });
    expect(config().enabled).toEqual(["plugin:shipped"]);
    // A reload keeps the choice: the enabled one comes back, the other stays off.
    await fetch(url(PLUGIN_ROUTES.reload), { method: "POST" });
    expect((await byId()).shipped!.status).toBe("active");
    expect((await byId()).other).toMatchObject({ status: "inactive", disabled: true });
    expect(counts()).toEqual({ activations: 2, deactivations: 1 });

    const off = await fetch(url(`${PLUGIN_ROUTES.toggle}/shipped/disable`), { method: "POST" });
    expect(off.status).toBe(200);
    expect((await byId()).shipped).toMatchObject({ status: "inactive", disabled: true });
    expect(counts()).toEqual({ activations: 2, deactivations: 2 });
    expect(config().enabled).toBeUndefined();
    expect(config().disabled).toEqual(["plugin:shipped"]);
    // Enabling again clears the disabled entry.
    await fetch(url(`${PLUGIN_ROUTES.toggle}/shipped/enable`), { method: "POST" });
    expect(config()).toMatchObject({ enabled: ["plugin:shipped"] });
    expect(config().disabled).toBeUndefined();
    expect((await byId()).shipped!.status).toBe("active");
  });

  it("answers 404 for an unknown id, 400 for a bad one, 403 away from loopback", async () => {
    expect((await fetch(url(`${PLUGIN_ROUTES.toggle}/nope/enable`), { method: "POST" })).status).toBe(404);
    expect((await fetch(url(`${PLUGIN_ROUTES.toggle}/Bad_Id/enable`), { method: "POST" })).status).toBe(400);
    const ctx = {
      remote: { ip: "10.0.0.2", loopback: false },
      url: new URL("http://x/"),
      cookies: () => ({ spgui: app.config().uiKey }),
      params: { id: "shipped" },
    };
    expect(
      await app.router.match("POST", `${PLUGIN_ROUTES.toggle}/shipped/disable`)!.handler(ctx as never),
    ).toMatchObject({ status: 403 });
  });

  it("an install of the same id overrides the bundled copy; removing a bundled one says to disable it", async () => {
    makePlugin(path.join(plugins, "shipped"), { name: "Shipped (mine)", settings: [] }, JS);
    await fetch(url(PLUGIN_ROUTES.reload), { method: "POST" });
    const mine = (await byId()).shipped!;
    expect(mine).toMatchObject({ name: "Shipped (mine)", status: "active", dir: path.join(plugins, "shipped") });
    expect(mine.bundled).toBeUndefined();
    expect(mine.source).toBeUndefined();
    const opts = { bundledDir: bundled };
    expect(() => removePlugin(plugins, "other", opts)).toThrow(/bundled with sessionpipe-gui.*plugin disable other/);
    expect(removePlugin(plugins, "shipped", opts).message).toBe("removed shipped");
    const back = listPlugins(plugins, opts).find((p) => p.id === "shipped")!;
    expect(back).toMatchObject({ bundled: true, disabled: true });
    expect(back.manifest).toMatchObject({ name: "Shipped", source: "bundled" });
    expect(
      listPlugins(plugins, { ...opts, enabled: () => ["plugin:shipped"] }).find((p) => p.id === "shipped")!.disabled,
    ).toBeUndefined();
    expect(() => removePlugin(plugins, "nope", opts)).toThrow(/no plugin "nope"/);
  });
});

describe("a plugin or view the CLI turns on or off while the server runs", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  let local: { dir: string; cleanup: () => void };
  const JS = "export default { activate() { return { deactivate() {} }; } };";

  beforeAll(async () => {
    tmp = tempDir();
    local = inRepoTempDir();
    makePlugin(path.join(local.dir, "bundled", "plugins", "shipped"), { name: "Shipped", settings: [] }, JS);
    makePlugin(path.join(local.dir, "plugins", "other"), { name: "Other", settings: [] }, JS);
    app = await createApp({
      port: 0,
      stateDir: tmp.dir,
      pluginsDir: path.join(local.dir, "plugins"),
      outbox: false,
      quiet: true,
      webDir: tmp.dir,
      bundledDir: path.join(local.dir, "bundled", "views"),
    });
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
    local.cleanup();
  });

  const url = (p: string) => `${app.url}${p}`;
  const status = async (id: string) =>
    ((await (await fetch(url(PLUGIN_ROUTES.list))).json()) as { plugins: InstalledPlugin[] }).plugins.find(
      (p) => p.id === id,
    )!.status;
  const file = () =>
    JSON.parse(readFileSync(path.join(tmp.dir, "config.json"), "utf8")) as {
      sinkToken: string;
      uiKey: string;
      enabled?: string[];
      disabled?: string[];
    };
  // What `sessionpipe-gui plugin|view enable|disable` does (server/cli.ts), from its own process.
  const cli = (key: string, on: boolean) =>
    key.startsWith("view:")
      ? setDisabled(tmp.dir, readGuiConfig(tmp.dir), key, !on)
      : setEnabled(tmp.dir, readGuiConfig(tmp.dir), key, on);
  // Each test starts from the server's own file with neither list: nothing on or off.
  beforeEach(async () => {
    const { sinkToken, uiKey, createdAt } = app.config();
    writeFileSync(path.join(tmp.dir, "config.json"), JSON.stringify({ sinkToken, uiKey, createdAt }));
    await fetch(url(PLUGIN_ROUTES.reload), { method: "POST" });
    expect(await status("shipped")).toBe("inactive");
    expect(await status("other")).toBe("active");
  });

  it("Reload plugins starts one the CLI enabled, and a later write of the server's keeps it", async () => {
    expect(await status("shipped")).toBe("inactive");
    cli("plugin:shipped", true);
    await fetch(url(PLUGIN_ROUTES.reload), { method: "POST" });
    expect(await status("shipped")).toBe("active");
    const before = file();
    const rotated = await fetch(url(ROUTES.ui.rotateToken), { method: "POST" });
    const { sinkToken } = (await rotated.json()) as { sinkToken: string };
    expect(file()).toMatchObject({ sinkToken, uiKey: before.uiKey, enabled: ["plugin:shipped"] });
    await fetch(url(PLUGIN_ROUTES.reload), { method: "POST" });
    expect(await status("shipped")).toBe("active");
  });

  it("a view or plugin the CLI turned off stays off through the server's writes", async () => {
    cli("view:canvas", false);
    cli("plugin:shipped", false);
    await fetch(url(PLUGIN_ROUTES.reload), { method: "POST" });
    expect(await status("shipped")).toBe("inactive");
    await fetch(url(ROUTES.ui.rotateToken), { method: "POST" });
    expect(file().disabled).toEqual(["view:canvas", "plugin:shipped"]);
    expect(file().enabled).toBeUndefined();
  });

  it("the server's secrets stay its own, and a bad file, or one with other secrets, changes nothing", async () => {
    cli("view:canvas", false);
    const { sinkToken, uiKey } = app.config();
    const f = path.join(tmp.dir, "config.json");
    const { disabled, enabled } = file();
    writeFileSync(f, "{ not json");
    await fetch(url(PLUGIN_ROUTES.reload), { method: "POST" });
    expect(readFileSync(f, "utf8")).toBe("{ not json");
    expect(app.config()).toMatchObject({ sinkToken, uiKey, disabled });
    expect(app.config().enabled).toEqual(enabled);
    // A file with other secrets than the server's (another install's, or the old token a
    // CLI command wrote back across a rotation): its lists are not an edit of ours, so
    // none is taken from it.
    writeFileSync(f, JSON.stringify({ sinkToken: "spg_test_other", uiKey: "uik_other", enabled: ["plugin:shipped"] }));
    await fetch(url(PLUGIN_ROUTES.reload), { method: "POST" });
    expect(await status("shipped")).toBe("inactive");
    expect(app.config()).toMatchObject({ sinkToken, uiKey, disabled });
    expect(app.config().enabled).toEqual(enabled);
  });

  it("a toggle in the GUI also starts or stops a plugin the CLI turned on or off meanwhile", async () => {
    cli("plugin:shipped", true);
    await fetch(url(PLUGIN_ROUTES.reload), { method: "POST" });
    expect(await status("other")).toBe("active");
    expect(await status("shipped")).toBe("active");
    cli("plugin:shipped", false);
    await fetch(url(`${PLUGIN_ROUTES.toggle}/other/disable`), { method: "POST" });
    expect(await status("other")).toBe("inactive");
    expect(await status("shipped")).toBe("inactive");
    cli("plugin:shipped", true);
    await fetch(url(`${PLUGIN_ROUTES.toggle}/other/enable`), { method: "POST" });
    expect(await status("other")).toBe("active");
    expect(await status("shipped")).toBe("active");
  });
});

describe("plugin install (the shared installer, bound to plugin.json)", () => {
  let tmp: { dir: string; cleanup: () => void };
  let plugins: string;
  beforeAll(() => {
    tmp = tempDir();
    plugins = path.join(tmp.dir, "plugins");
  });
  afterAll(() => tmp.cleanup());

  it("adds a folder by copying it and records the source in plugin.json", async () => {
    const src = makePlugin(path.join(tmp.dir, "src-folder"), { id: "copied", name: "Copied" });
    const r = await addPlugin(plugins, src);
    expect(r.message).toMatch(/^installed copied \(Copied 1\.2\.3\) from /);
    const installed = JSON.parse(readFileSync(path.join(plugins, "copied", "plugin.json"), "utf8"));
    expect(installed).toMatchObject({ id: "copied", kind: "plugin", source: src, entry: "index.js" });
    expect(listPlugins(plugins, NO_BUNDLED).map((p) => p.id)).toEqual(["copied"]);
  });

  it("links, lists with the flag, removes the link only", () => {
    const src = makePlugin(path.join(tmp.dir, "dev"), { id: "dev" });
    expect(linkPlugin(plugins, src).message).toMatch(/^linked dev \(Fixture 1\.2\.3\) → /);
    expect(lstatSync(path.join(plugins, "dev")).isSymbolicLink()).toBe(true);
    expect(listPlugins(plugins, NO_BUNDLED).find((p) => p.id === "dev")).toMatchObject({ linked: true });
    expect(removePlugin(plugins, "dev").message).toMatch(/^removed dev \(the link/);
    expect(existsSync(path.join(src, "index.js"))).toBe(true);
    expect(() => removePlugin(plugins, "dev")).toThrow(/no plugin "dev"/);
  });

  it("refuses a view handed to plugin add", async () => {
    const theme = path.join(tmp.dir, "a-theme");
    mkdirSync(theme);
    writeFileSync(path.join(theme, "theme.json"), JSON.stringify({ id: "a-theme", name: "T", version: "1", api: 1 }));
    writeFileSync(path.join(theme, "index.js"), "export default {}");
    await expect(addPlugin(plugins, theme)).rejects.toThrow(/no plugin.json/);
  });
});
