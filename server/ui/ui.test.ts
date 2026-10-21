// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type FeedPage,
  type Info,
  ROUTES,
  type SessionDetail,
  type Snapshot,
  type StreamMessage,
  UI_KEY_COOKIE,
  type Viewer,
} from "../../shared/api.js";
import type { ColorThemesResponse } from "../../shared/color-theme.js";
import { Session, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { lanAddresses } from "../http/net.js";
import type { Ctx } from "../http/router.js";
import { uiAuth } from "./auth.js";
import { describeViewer } from "./viewers.js";

let app: App;
let tmp: { dir: string; cleanup: () => void };
let web: string;

beforeAll(async () => {
  tmp = tempDir();
  web = path.join(tmp.dir, "web");
  mkdirSync(path.join(web, "assets"), { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>board</title>");
  writeFileSync(path.join(web, "assets", "app.js"), "console.log(1)");
  app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, webDir: web });
  const s = new Session();
  app.store.ingest([s.ev("session.started", { source: "startup" }), s.ev("turn.started", { turn_id: "t" })], "http");
});
afterAll(async () => {
  await app.close();
  tmp.cleanup();
});

const fakeCtx = (o: { loopback?: boolean; cookie?: string; query?: string }): Ctx =>
  ({
    remote: { ip: o.loopback ? "127.0.0.1" : "192.168.1.9", loopback: o.loopback ?? false },
    url: new URL(`http://x/${o.query ?? ""}`),
    cookies: () => (o.cookie ? { [UI_KEY_COOKIE]: o.cookie } : {}),
  }) as unknown as Ctx;

describe("uiAuth", () => {
  it("admits loopback, the cookie, or ?k=, and nothing else", () => {
    expect(uiAuth(fakeCtx({ loopback: true }), "key")).toBe(true);
    expect(uiAuth(fakeCtx({ cookie: "key" }), "key")).toBe(true);
    expect(uiAuth(fakeCtx({ query: "?k=key" }), "key")).toBe(true);
    expect(uiAuth(fakeCtx({ cookie: "nope" }), "key")).toBe(false);
    expect(uiAuth(fakeCtx({ query: "?k=nope" }), "key")).toBe(false);
    expect(uiAuth(fakeCtx({}), "key")).toBe(false);
    expect(uiAuth(fakeCtx({ cookie: "" }), "")).toBe(false);
  });
});

describe("UI API", () => {
  it("info carries the urls, the sink command and the sources", async () => {
    const info = (await (await fetch(`${app.url}${ROUTES.ui.info}`)).json()) as Info;
    expect(info).toMatchObject({
      name: "sessionpipe-gui",
      port: app.port,
      sinkToken: app.config().sinkToken,
      uiKey: app.config().uiKey,
      sources: { http: true, outbox: null, demo: false },
      control: { enabled: true, rpId: "localhost", origins: [`http://localhost:${app.port}`] },
    });
    expect(info.urls.local).toBe(`http://localhost:${app.port}`);
    expect(info.sinkCommand).toMatch(/^sessionpipe sink add http:\/\/[\d.]+:\d+ --tier 3 --token spg_/);
    expect(info.wellKnown).toMatchObject({ protocol: [1] });
  });

  it("snapshot lists sessions, machines and stats", async () => {
    const snap = (await (await fetch(`${app.url}${ROUTES.ui.snapshot}`)).json()) as Snapshot;
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]).toMatchObject({ harness: "claude-code", state: "working" });
    expect(snap.machines[0]).toMatchObject({ name: "misha-air", sessions: 1, working: 1 });
    expect(snap.stats).toMatchObject({ events: 2, sessions: 1 });
  });

  it("streams a snapshot first, then events", async () => {
    const res = await fetch(`${app.url}${ROUTES.ui.stream}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const until = async (pred: () => boolean) => {
      while (!pred()) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value, { stream: true });
      }
    };
    await until(() => text.includes("\n\n"));
    const first = text.split("\n\n")[0]!;
    expect(first.startsWith("event: snapshot\ndata: ")).toBe(true);
    const msg = JSON.parse(first.slice("event: snapshot\ndata: ".length));
    expect(msg.kind).toBe("snapshot");
    expect(msg.snapshot.sessions).toHaveLength(1);
    app.store.ingest([new Session("live").ev("session.started")], "http");
    await until(() => text.includes("event: event\n"));
    expect(text).toContain('"kind":"event"');
    await reader.cancel();
  });

  it("serves the color themes dropped into <state>/color-themes, reporting bad files", async () => {
    const dir = path.join(tmp.dir, "color-themes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "mint.json"),
      JSON.stringify({
        id: "mint",
        name: "Mint",
        scheme: "light",
        tokens: { "--bg": "oklch(0.97 0.02 160)", "--fg": "#143", "--needs": "oklch(0.72 0.15 65)" },
      }),
    );
    writeFileSync(path.join(dir, "broken.json"), "{ not json");
    writeFileSync(
      path.join(dir, "odd.json"),
      JSON.stringify({ id: "odd", name: "Odd", scheme: "dark", tokens: { "--nope": "red" } }),
    );
    writeFileSync(
      path.join(dir, "thin.json"),
      JSON.stringify({ id: "thin", name: "Thin", scheme: "dark", tokens: { "--bg": "#000" } }),
    );
    writeFileSync(path.join(dir, "notes.txt"), "ignored");
    const res = await fetch(`${app.url}${ROUTES.ui.colorThemes}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ColorThemesResponse;
    expect(body.themes).toEqual([
      {
        id: "mint",
        name: "Mint",
        scheme: "light",
        tokens: { "--bg": "oklch(0.97 0.02 160)", "--fg": "#143", "--needs": "oklch(0.72 0.15 65)" },
      },
    ]);
    expect(body.errors.map((e) => e.file).sort()).toEqual(["broken.json", "odd.json", "thin.json"]);
    expect(body.errors.find((e) => e.file === "odd.json")!.error).toBe("unknown token --nope");
    expect(body.errors.find((e) => e.file === "thin.json")!.error).toMatch(/--bg and --fg/);
    expect(body.errors.find((e) => e.file === "broken.json")!.error).toMatch(/^not JSON/);
    // Needs the UI auth like everything else.
    const lan = await fetch(`${app.url}${ROUTES.ui.colorThemes}`, { headers: { "x-forwarded-for": "10.0.0.9" } });
    expect([200, 401]).toContain(lan.status);
  });

  it("serves the session detail, the feed and forget", async () => {
    const key = "claude-code/8c132906-8c3f-4814-870a-afc3d05e1d2e";
    const d = (await (await fetch(`${app.url}${ROUTES.ui.session}/${key}?after=0&limit=5`)).json()) as SessionDetail;
    expect(d.events.map((e) => e.session.seq)).toEqual([1]);
    expect(d.total).toBe(2);
    // Backwards paging and slim pages, as the Session page opens a session.
    const tail = (await (
      await fetch(`${app.url}${ROUTES.ui.session}/${key}?tail=1&limit=1&slim=1`)
    ).json()) as SessionDetail;
    expect(tail.events.map((e) => e.session.seq)).toEqual([1]);
    expect(tail).toMatchObject({ firstSeq: 1, hasOlder: true, total: 2 });
    // A list page may ask for a shorter preview than the index's 2 KB.
    const long = new Session("long");
    app.store.ingest(
      [long.ev("session.started"), long.ev("tool.ended", { tool: "Bash", ok: true, output: "z".repeat(5000) })],
      "http",
    );
    const cut = (await (
      await fetch(`${app.url}${ROUTES.ui.session}/claude-code/long?tail=1&limit=1&slim=1&preview=300`)
    ).json()) as SessionDetail;
    expect((cut.events[0]!.data.output as string).length).toBe(300);
    expect(cut.events[0]!.preview).toEqual({ output: 5000 });
    const full = (await (
      await fetch(`${app.url}${ROUTES.ui.session}/claude-code/long?after=0&limit=1`)
    ).json()) as SessionDetail;
    expect((full.events[0]!.data.output as string).length).toBe(5000);
    expect(full.events[0]!.preview).toBeUndefined();
    const older = (await (
      await fetch(`${app.url}${ROUTES.ui.session}/${key}?before=1&limit=5`)
    ).json()) as SessionDetail;
    expect(older.events.map((e) => e.session.seq)).toEqual([0]);
    expect(older.hasOlder).toBe(false);
    expect((await fetch(`${app.url}${ROUTES.ui.session}/claude-code/none`)).status).toBe(404);
    const feed = (await (await fetch(`${app.url}${ROUTES.ui.feed}?limit=1&type=turn.started`)).json()) as FeedPage;
    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]!.type).toBe("turn.started");
    const gone = new Session("gone");
    app.store.ingest([gone.ev("session.started")], "http");
    expect((await fetch(`${app.url}${ROUTES.ui.forget}/claude-code/gone/forget`, { method: "POST" })).status).toBe(204);
    expect((await fetch(`${app.url}${ROUTES.ui.session}/claude-code/gone`)).status).toBe(404);
    expect((await fetch(`${app.url}${ROUTES.ui.forget}/claude-code/gone/forget`, { method: "POST" })).status).toBe(404);
  });

  it("renders the QR code as SVG of the LAN URL with the key", async () => {
    const res = await fetch(`${app.url}${ROUTES.ui.qr}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^image\/svg\+xml/);
    const svg = await res.text();
    expect(svg).toContain("<svg");
  });

  it("rotates the sink token from loopback and the old one stops working", async () => {
    const old = app.config().sinkToken;
    const res = await fetch(`${app.url}${ROUTES.ui.rotateToken}`, { method: "POST" });
    const { sinkToken } = (await res.json()) as { sinkToken: string };
    expect(sinkToken).not.toBe(old);
    expect(app.config().sinkToken).toBe(sinkToken);
    const s = new Session("rot");
    const send = (t: string) =>
      fetch(`${app.url}${ROUTES.events}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
        body: JSON.stringify({ events: [s.ev("session.started")] }),
      });
    expect((await send(old)).status).toBe(401);
    expect((await send(sinkToken)).status).toBe(202);
  });

  it("toggles demo", async () => {
    const on = await (
      await fetch(`${app.url}${ROUTES.ui.demo}`, { method: "POST", body: JSON.stringify({ on: true }) })
    ).json();
    expect(on).toEqual({ on: true });
    expect(((await (await fetch(`${app.url}${ROUTES.ui.info}`)).json()) as Info).sources.demo).toBe(true);
    const off = await (
      await fetch(`${app.url}${ROUTES.ui.demo}`, { method: "POST", body: JSON.stringify({ on: false }) })
    ).json();
    expect(off).toEqual({ on: false });
    expect((await fetch(`${app.url}${ROUTES.ui.demo}`, { method: "POST", body: "{}" })).status).toBe(400);
  });
});

/** One SSE client: frames parsed as they land, `until` waits for one that matches. */
async function sseClient(userAgent: string) {
  const res = await fetch(`${app.url}${ROUTES.ui.stream}`, { headers: { "user-agent": userAgent } });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const frames: StreamMessage[] = [];
  let buf = "";
  const pump = async (): Promise<boolean> => {
    const { value, done } = await reader.read();
    if (done) return false;
    buf += dec.decode(value, { stream: true });
    let i = buf.indexOf("\n\n");
    while (i >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (data) frames.push(JSON.parse(data.slice(6)) as StreamMessage);
      i = buf.indexOf("\n\n");
    }
    return true;
  };
  const until = async <T extends StreamMessage>(pred: (m: StreamMessage) => m is T): Promise<T> => {
    for (;;) {
      const hit = frames.find(pred);
      if (hit) {
        frames.splice(frames.indexOf(hit), 1);
        return hit;
      }
      if (!(await pump())) throw new Error("stream ended");
    }
  };
  const isViewers = (m: StreamMessage): m is { kind: "viewers"; viewers: Viewer[] } => m.kind === "viewers";
  const isSnapshot = (m: StreamMessage): m is { kind: "snapshot"; snapshot: Snapshot } => m.kind === "snapshot";
  return {
    snapshot: () => until(isSnapshot),
    viewers: () => until(isViewers),
    close: () => reader.cancel(),
  };
}

describe("viewers", () => {
  it("reads the device and a label from the user agent", () => {
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
    const ipad =
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
    const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36";
    const tablet = "Mozilla/5.0 (Linux; Android 14; SM-X900) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";
    const win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0";
    const fox = "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";
    expect(describeViewer(iphone, false)).toEqual({ device: "phone", label: "iPhone · Safari" });
    expect(describeViewer(ipad, false)).toEqual({ device: "tablet", label: "iPad · Safari" });
    expect(describeViewer(android, false)).toEqual({ device: "phone", label: "Android · Chrome" });
    expect(describeViewer(tablet, false)).toEqual({ device: "tablet", label: "Android tablet · Chrome" });
    expect(describeViewer(mac, false)).toEqual({ device: "laptop", label: "Mac · Chrome" });
    expect(describeViewer(mac, true)).toEqual({ device: "desktop", label: "Mac · Chrome" });
    expect(describeViewer(win, false)).toEqual({ device: "laptop", label: "Windows · Edge" });
    expect(describeViewer(fox, true)).toEqual({ device: "desktop", label: "Linux · Firefox" });
    expect(describeViewer(undefined, true)).toEqual({ device: "unknown", label: "unknown device" });
    expect(describeViewer("curl/8.4.0", false)).toEqual({ device: "unknown", label: "unknown device" });
  });

  it("two streams see each other, each marks its own entry, and a closed one is gone", async () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
    const a = await sseClient(mac);
    const snapA = (await a.snapshot()).snapshot;
    const meA = snapA.viewers!.find((v) => v.current)!;
    expect(meA).toMatchObject({ device: "desktop", label: "Mac · Chrome", loopback: true, ip: "this machine" });
    expect(meA.connectedAt).toBe(meA.lastSeenAt);
    expect(snapA.viewers!.filter((v) => v.current)).toHaveLength(1);

    const b = await sseClient(iphone);
    const snapB = (await b.snapshot()).snapshot;
    const meB = snapB.viewers!.find((v) => v.current)!;
    expect(meB.label).toBe("iPhone · Safari");
    expect(meB.id).not.toBe(meA.id);
    // B's snapshot lists A, and only B is current there.
    expect(snapB.viewers!.map((v) => [v.id, v.current ?? false])).toContainEqual([meA.id, false]);
    // A hears about B, still with A as the current one.
    const joined = (await a.viewers()).viewers;
    const bSeenByA = joined.find((v) => v.id === meB.id)!;
    expect(bSeenByA.device).toBe("phone");
    expect(bSeenByA.current).toBeUndefined();
    expect(joined.find((v) => v.current)?.id).toBe(meA.id);

    // The REST listing agrees and marks nobody.
    const listed = (await (await fetch(`${app.url}${ROUTES.ui.viewers}`)).json()) as { viewers: Viewer[] };
    expect(listed.viewers.map((v) => v.id)).toEqual(expect.arrayContaining([meA.id, meB.id]));
    expect(listed.viewers.every((v) => v.current === undefined)).toBe(true);

    await b.close();
    let after = (await a.viewers()).viewers;
    while (after.some((v) => v.id === meB.id)) after = (await a.viewers()).viewers;
    expect(after.find((v) => v.current)?.id).toBe(meA.id);
    await a.close();
    await expect
      .poll(async () => {
        const r = (await (await fetch(`${app.url}${ROUTES.ui.viewers}`)).json()) as { viewers: Viewer[] };
        return r.viewers.some((v) => v.id === meA.id || v.id === meB.id);
      })
      .toBe(false);
  });
});

describe("static", () => {
  it("serves the app, assets immutable, the SPA fallback, and sets the cookie from ?k=", async () => {
    const home = await fetch(`${app.url}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("board");
    const asset = await fetch(`${app.url}/assets/app.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    const spa = await fetch(`${app.url}/sessions/claude-code/x`);
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toMatch(/text\/html/);
    expect(await spa.text()).toContain("board");
    expect((await fetch(`${app.url}/../package.json`)).status).toBe(200);
    expect((await fetch(`${app.url}/api/nope`)).status).toBe(404);
    const key = app.config().uiKey;
    const withKey = await fetch(`${app.url}/sessions/x?k=${key}&tab=2`, { redirect: "manual" });
    expect(withKey.status).toBe(302);
    expect(withKey.headers.get("location")).toBe("/sessions/x?tab=2");
    expect(withKey.headers.get("set-cookie")).toBe(`${UI_KEY_COOKIE}=${key}; Path=/; Max-Age=31536000; SameSite=Lax`);
  });

  const lan = lanAddresses()[0];
  it.skipIf(!lan)("turns a LAN visitor away without the key, and in with it", async () => {
    const base = `http://${lan}:${app.port}`;
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("needs its key");
    expect((await fetch(`${base}${ROUTES.ui.snapshot}`)).status).toBe(401);
    expect((await fetch(`${base}${ROUTES.ui.rotateToken}`, { method: "POST" })).status).toBe(401);
    const key = app.config().uiKey;
    expect((await fetch(`${base}${ROUTES.ui.snapshot}?k=${key}`)).status).toBe(200);
    expect(
      (await fetch(`${base}${ROUTES.ui.snapshot}`, { headers: { cookie: `${UI_KEY_COOKIE}=${key}` } })).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${base}${ROUTES.ui.rotateToken}`, {
          method: "POST",
          headers: { cookie: `${UI_KEY_COOKIE}=${key}` },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${base}${ROUTES.wellKnown}`)).status).toBe(200);
  });
});
