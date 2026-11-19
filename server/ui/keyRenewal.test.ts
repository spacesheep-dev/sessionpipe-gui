// SPDX-License-Identifier: Apache-2.0
// The board's key found in the text the receiver keeps, or takes in, is replaced: on
// arrival (store and control), and by the look after each start; the first at once and
// later ones backed off, without a word, never twice for the same key, and nothing changes
// for loopback, sinks or the daemon.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Info, ROUTES, type StoredEvent, UI_KEY_COOKIE } from "../../shared/api.js";
import { Session, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { readGuiConfig } from "../config.js";
import { CHUNK } from "../search/sources/prefilter.js";
import { holdsText, keptTextFiles, keptTextHolds, watchUiKey } from "./keyRenewal.js";

const PUBLIC = "https://laptop.tail1234.ts.net";
/** A visitor through the proxy: never this machine, so it needs the key. */
const VISITOR = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };

let tmp: { dir: string; cleanup: () => void };
const apps: App[] = [];
beforeEach(() => {
  tmp = tempDir("spgui-key-");
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  tmp.cleanup();
  vi.restoreAllMocks();
});

async function boot(o: { testDoor?: boolean; publicUrl?: string | null } = {}): Promise<App> {
  const web = path.join(tmp.dir, "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>board</title>");
  const app = await createApp({
    port: 0,
    stateDir: tmp.dir,
    outbox: false,
    quiet: true,
    webDir: web,
    publicUrl: o.publicUrl === undefined ? PUBLIC : o.publicUrl,
    testDoor: o.testDoor ?? false,
  });
  apps.push(app);
  return app;
}

/** What a visitor with `key` (as the cookie) gets from `p`. */
const asVisitor = (app: App, p: string, key: string) =>
  fetch(`${app.url}${p}`, { headers: { ...VISITOR, cookie: `${UI_KEY_COOKIE}=${key}` }, redirect: "manual" });

/** A prompt that carries a link with the board's key in it. */
const promptWith = (s: Session, key: string) =>
  s.ev("prompt.submitted", { text: `the board is at http://192.168.1.20:7373/?k=${key}` });

/** Every line written to stdout, stderr and the console while `run` runs. */
async function printed(run: () => Promise<void> | void): Promise<string> {
  const out: string[] = [];
  const take = (...a: unknown[]) => {
    out.push(a.map(String).join(" "));
    return true;
  };
  const spies = [
    vi.spyOn(process.stdout, "write").mockImplementation(take as never),
    vi.spyOn(process.stderr, "write").mockImplementation(take as never),
    vi.spyOn(console, "log").mockImplementation(take),
    vi.spyOn(console, "error").mockImplementation(take),
    vi.spyOn(console, "warn").mockImplementation(take),
    vi.spyOn(console, "info").mockImplementation(take),
  ];
  try {
    await run();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return out.join("\n");
}

describe("holdsText", () => {
  it("finds the needle in any string, at any depth, field names too", () => {
    expect(holdsText({ a: [1, { b: "x KEY y" }] }, "KEY")).toBe(true);
    expect(holdsText({ deep: { deeper: { deepest: ["", "aKEY"] } } }, "KEY")).toBe(true);
    expect(holdsText({ KEYS: 1 }, "KEY")).toBe(true);
    expect(holdsText([{ a: "KE" }, { b: "Y" }], "KEY")).toBe(false);
    expect(holdsText({ a: 12, b: null, c: true }, "12")).toBe(false);
    expect(holdsText({ a: "anything" }, "")).toBe(false);
  });
});

describe("keptTextHolds", () => {
  const line = (text: string) => `${JSON.stringify({ type: "prompt.submitted", data: { text } })}\n`;

  it("reads the session files and the queues of sends, and nothing else", async () => {
    const events = path.join(tmp.dir, "events", "claude-code");
    mkdirSync(events, { recursive: true });
    writeFileSync(path.join(events, "a.jsonl"), line("nothing here"));
    mkdirSync(path.join(tmp.dir, "control", "queue"), { recursive: true });
    writeFileSync(path.join(tmp.dir, "control", "queue", "m_1.json"), '{"v":1,"messages":[{"text":"QKEY1"}]}\n');
    // The key's own home, the pictures, the plugins' storage and the search index are not read.
    writeFileSync(path.join(tmp.dir, "config.json"), '{"uiKey":"CKEY1"}\n');
    for (const d of ["attachments", "plugins-storage", "search"]) {
      mkdirSync(path.join(tmp.dir, d), { recursive: true });
      writeFileSync(path.join(tmp.dir, d, "x.jsonl"), line("SKEY1"));
    }
    expect(keptTextFiles(tmp.dir).map((f) => path.relative(tmp.dir, f))).toEqual([
      path.join("events", "claude-code", "a.jsonl"),
      path.join("control", "queue", "m_1.json"),
    ]);
    expect(await keptTextHolds(tmp.dir, "QKEY1")).toBe(true);
    expect(await keptTextHolds(tmp.dir, "CKEY1")).toBe(false);
    expect(await keptTextHolds(tmp.dir, "SKEY1")).toBe(false);
    appendFileSync(path.join(events, "a.jsonl"), line("http://h:7373/?k=EKEY1"));
    expect(await keptTextHolds(tmp.dir, "EKEY1")).toBe(true);
    expect(await keptTextHolds(path.join(tmp.dir, "missing"), "EKEY1")).toBe(false);
  });

  it("finds a key on a line that spans two reads, in slices, and gives the loop a turn between them", async () => {
    const events = path.join(tmp.dir, "events", "codex");
    mkdirSync(events, { recursive: true });
    const file = path.join(events, "big.jsonl");
    // Lines of filler past several chunks, then one whose key sits across a chunk edge.
    const filler = line("x".repeat(64 * 1024 - 60));
    let text = "";
    while (text.length < 3 * CHUNK) text += filler;
    // The key starts five bytes before the fourth chunk ends: `line` puts its JSON before it.
    const pad = CHUNK * 4 - text.length - (line("").length - 4) - 5;
    text += line(`${"y".repeat(pad)}BOUNDARYKEY`);
    writeFileSync(file, text);
    const edge = text.indexOf("BOUNDARYKEY");
    expect(edge).toBeLessThan(4 * CHUNK);
    expect(edge + "BOUNDARYKEY".length).toBeGreaterThan(4 * CHUNK);
    let turns = 0;
    const ticking = setInterval(() => turns++, 0);
    try {
      expect(await keptTextHolds(tmp.dir, "BOUNDARYKEY", { sliceBytes: CHUNK })).toBe(true);
      expect(await keptTextHolds(tmp.dir, "NOT-THERE", { sliceBytes: CHUNK })).toBe(false);
    } finally {
      clearInterval(ticking);
    }
    expect(turns).toBeGreaterThan(0);
    const stop = new AbortController();
    stop.abort();
    expect(await keptTextHolds(tmp.dir, "BOUNDARYKEY", { signal: stop.signal })).toBe(false);
  });
});

describe("watchUiKey", () => {
  it("replaces the key once for each find: an arrival, a send, and the look after a start", async () => {
    let key = "FIRSTKEY-0123456789";
    let n = 0;
    const renew = () => {
      n++;
      key = `KEY${n}-0123456789abcd`;
    };
    const readers: ((e: readonly unknown[]) => void)[] = [];
    const frames: ((m: { kind: string }) => void)[] = [];
    const w = watchUiKey({
      stateDir: tmp.dir,
      store: {
        onArrival: (r) => {
          readers.push(r);
          return () => {};
        },
      },
      control: {
        subscribe: (l) => {
          frames.push(l);
          return () => {};
        },
      },
      key: () => key,
      renew,
      // No wait here: each find is its own (keyRules.test.ts holds the back-off).
      firstWaitMs: 0,
    });
    expect(await w.looked).toBe(false);
    readers[0]!([{ data: { text: "nothing" } }]);
    expect(n).toBe(0);
    readers[0]!([{ data: { text: "has FIRSTKEY-0123456789 in it" } }]);
    expect(key).toBe("KEY1-0123456789abcd");
    // The same text again holds the old key, which is not the key: no second replacement.
    readers[0]!([{ data: { text: "has FIRSTKEY-0123456789 in it" } }]);
    expect(n).toBe(1);
    // A send as it is queued: the control frame carries its text. Other frames are passed.
    frames[0]!({ kind: "machine", text: "KEY1-0123456789abcd" } as never);
    expect(n).toBe(1);
    frames[0]!({ kind: "control", message: { text: "see ?k=KEY1-0123456789abcd" } } as never);
    expect(key).toBe("KEY2-0123456789abcd");
    w.close();
    readers[0]!([{ data: { text: "KEY2-0123456789abcd" } }]);
    expect(n).toBe(2);
  });
});

describe("the board's key in the receiver", () => {
  it("on arrival: replaced before the event is kept, at once, and nothing printed; the old key is refused, the new one works", async () => {
    const app = await boot();
    await app.keyLooked;
    const old = app.config().uiKey;
    const sink = app.config().sinkToken;
    expect((await asVisitor(app, ROUTES.ui.info, old)).status).toBe(200);
    const s = new Session("arrival");
    const said = await printed(async () => {
      const r = await fetch(`${app.url}${ROUTES.events}`, {
        method: "POST",
        headers: { authorization: `Bearer ${sink}`, "content-type": "application/json" },
        body: JSON.stringify({ events: [s.ev("session.started"), promptWith(s, old)] }),
      });
      expect(r.status).toBeLessThan(300);
    });
    const next = app.config().uiKey;
    expect(next).not.toBe(old);
    expect(next).toMatch(/^[A-Za-z0-9_-]{16}$/);
    // Written, whole: what the next start reads, and no file left beside it.
    expect(readGuiConfig(tmp.dir).uiKey).toBe(next);
    expect(readdirSync(tmp.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // The event is kept as it came.
    expect(app.store.session("claude-code:arrival")?.counts.events).toBe(2);
    // Nothing printed: no key, no line about one.
    expect(said).not.toContain(old);
    expect(said).not.toContain(next);
    expect(said).not.toMatch(/key/i);
    // The old key is refused everywhere a key opens, from now on; the new one works.
    expect((await asVisitor(app, ROUTES.ui.info, old)).status).toBe(401);
    expect((await asVisitor(app, ROUTES.ui.snapshot, old)).status).toBe(401);
    expect((await fetch(`${app.url}${ROUTES.ui.info}?k=${old}`, { headers: VISITOR })).status).toBe(401);
    expect((await fetch(`${app.url}/?k=${old}`, { headers: VISITOR, redirect: "manual" })).status).toBe(401);
    expect((await asVisitor(app, ROUTES.ui.info, next)).status).toBe(200);
    const page = await fetch(`${app.url}/?k=${next}`, { headers: VISITOR, redirect: "manual" });
    expect(page.status).toBe(302);
    // This machine needs no key, before or after.
    expect((await fetch(`${app.url}${ROUTES.ui.info}`)).status).toBe(200);
    // The sink token is the sink's own: the same, and still taken.
    expect(app.config().sinkToken).toBe(sink);
    const more = await fetch(`${app.url}${ROUTES.events}`, {
      method: "POST",
      headers: { authorization: `Bearer ${sink}`, "content-type": "application/json", ...VISITOR },
      body: JSON.stringify({ events: [s.ev("turn.started", { turn_id: "t" })] }),
    });
    expect(more.status).toBeLessThan(300);
    expect(app.config().uiKey).toBe(next);
  });

  it("a key that does not open the board gets the page that asks for the link; with no key it says where the link is", async () => {
    const app = await boot();
    const old = app.config().uiKey;
    app.renewUiKey();
    const stale = await asVisitor(app, "/sessions", old);
    expect(stale.status).toBe(401);
    const words = await stale.text();
    expect(words).toContain("Open the board's link again");
    expect(words).toContain("Connect");
    expect(words).not.toContain(app.config().uiKey);
    expect(words).not.toContain("any more");
    // A key that never was the board's gets the same words.
    const never = await asVisitor(app, "/", "never-this-boards-key");
    expect(never.status).toBe(401);
    expect(await never.text()).toContain("The key this browser has does not open this board");
    const viaQr = await fetch(`${app.url}${ROUTES.trust}?k=${old}`, { headers: VISITOR });
    expect(viaQr.status).toBe(401);
    expect(await viaQr.text()).toContain("Open the board's link again");
    const none = await fetch(`${app.url}/`, { headers: VISITOR });
    expect(none.status).toBe(401);
    expect(await none.text()).toContain("This board needs its key");
  });

  it("ends a stream opened with the old key; a stream on this machine stays and is told", async () => {
    const app = await boot();
    const old = app.config().uiKey;
    const open = async (headers: Record<string, string>) => {
      const res = await fetch(`${app.url}${ROUTES.ui.stream}`, { headers });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let text = "";
      let ended = false;
      const pump = (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            ended = true;
            return;
          }
          text += dec.decode(value, { stream: true });
        }
      })().catch(() => {
        ended = true;
      });
      return { text: () => text, ended: () => ended, pump, cancel: () => reader.cancel().catch(() => {}) };
    };
    const away = await open({ ...VISITOR, cookie: `${UI_KEY_COOKIE}=${old}` });
    const here = await open({});
    const until = async (cond: () => boolean) => {
      const t = Date.now() + 5000;
      while (!cond() && Date.now() < t) await new Promise((r) => setTimeout(r, 20));
      return cond();
    };
    expect(await until(() => away.text().includes("event: snapshot") && here.text().includes("event: snapshot"))).toBe(
      true,
    );
    app.renewUiKey();
    expect(await until(() => away.ended())).toBe(true);
    expect(away.text()).not.toContain("event: info");
    expect(await until(() => here.text().includes("event: info"))).toBe(true);
    expect(here.ended()).toBe(false);
    // The frame says only that Info changed: the key is read from /api/ui/info.
    expect(here.text()).not.toContain(app.config().uiKey);
    await here.cancel();
  });

  it("at start-up: found in what was kept, replaced once; the next start finds the old key only and changes nothing", async () => {
    const first = await boot();
    const old = first.config().uiKey;
    await first.close();
    apps.splice(0);
    // A prompt kept before this start, as it is on disk.
    const s = new Session("kept");
    const stored = (e: ReturnType<Session["ev"]>): StoredEvent => ({
      ...e,
      arrivedAt: new Date().toISOString(),
      source: "http",
    });
    const dir = path.join(tmp.dir, "events", "claude-code");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "kept.jsonl"),
      `${JSON.stringify(stored(s.ev("session.started")))}\n${JSON.stringify(stored(promptWith(s, old)))}\n`,
    );
    let second!: App;
    const said = await printed(async () => {
      second = await boot();
      expect(await second.keyLooked).toBe(true);
    });
    const next = second.config().uiKey;
    expect(next).not.toBe(old);
    expect(readGuiConfig(tmp.dir).uiKey).toBe(next);
    expect(said).not.toContain(old);
    expect(said).not.toContain(next);
    expect((await asVisitor(second, ROUTES.ui.info, old)).status).toBe(401);
    expect((await asVisitor(second, ROUTES.ui.info, next)).status).toBe(200);
    expect(second.store.session("claude-code:kept")?.counts.events).toBe(2);
    await second.close();
    apps.splice(0);
    // Again, and again: the kept text holds the old key, which is not the key.
    for (let i = 0; i < 2; i++) {
      const again = await boot();
      expect(await again.keyLooked).toBe(false);
      expect(again.config().uiKey).toBe(next);
      await again.close();
      apps.splice(0);
    }
  });

  it("a send that carries the key, as it is queued; the daemon's token goes on working", async () => {
    // The test door signs for the rp id "localhost": no public url here.
    const app = await boot({ testDoor: true, publicUrl: null });
    await app.keyLooked;
    const old = app.config().uiKey;
    const call = (p: string, body: unknown, bearer?: string) =>
      fetch(`${app.url}${ROUTES.control}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      });
    const enrolled = await call("/_test/enroll", { machine: "m_testmachine0000000001" });
    expect(enrolled.status).toBe(201);
    const { token } = (await enrolled.json()) as { token: string };
    const hello = { name: "box", harnesses: ["claude-code"], modes: ["waiter", "turn"], version: "0.13.6" };
    expect((await call("/hello", hello, token)).status).toBeLessThan(300);
    const queued = await call("/_test/enqueue", {
      machine: "m_testmachine0000000001",
      message: { kind: "prompt", session: `claude-code:${randomUUID()}`, text: `the board: ${PUBLIC}/?k=${old}` },
    });
    expect(`${queued.status} ${await queued.text()}`).toMatch(/^201 /);
    const next = app.config().uiKey;
    expect(next).not.toBe(old);
    // The daemon's own token: its hello and its poll answer as before.
    expect((await call("/hello", hello, token)).status).toBeLessThan(300);
    const poll = await fetch(`${app.url}${ROUTES.control}?machine=m_testmachine0000000001&wait=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(poll.status).toBe(200);
    // A new pairing with the sink token still starts; its link carries the code alone.
    const pair = await call("/pair", hello, app.config().sinkToken);
    expect(pair.status).toBe(201);
    const answer = await pair.text();
    expect(answer).not.toContain(next);
    expect((JSON.parse(answer) as { url: string }).url).toMatch(/\/pair\?code=[^&]+$/);
  });

  it("POST /api/ui/key/renew: this computer only; it answers no key, and the new one is in use at once", async () => {
    const app = await boot();
    const old = app.config().uiKey;
    const away = await fetch(`${app.url}${ROUTES.ui.renewKey}?k=${old}`, { method: "POST", headers: VISITOR });
    expect(away.status).toBe(403);
    expect((await fetch(`${app.url}${ROUTES.ui.renewKey}`, { method: "POST", headers: VISITOR })).status).toBe(401);
    expect(app.config().uiKey).toBe(old);
    const r = await fetch(`${app.url}${ROUTES.ui.renewKey}`, { method: "POST" });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    const uiKey = app.config().uiKey;
    expect(uiKey).not.toBe(old);
    const info = (await (await fetch(`${app.url}${ROUTES.ui.info}`)).json()) as Info;
    expect(info.uiKey).toBe(uiKey);
    expect(existsSync(path.join(tmp.dir, "config.json"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(tmp.dir, "config.json"), "utf8")).uiKey).toBe(uiKey);
  });
});
