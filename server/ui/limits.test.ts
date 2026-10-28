// SPDX-License-Identifier: Apache-2.0
// Usage limits: what the store keeps of each limits.observed, its file, and the routes,
// frames and demo mode around it.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LIMITS_MAX,
  type LimitsEntry,
  ROUTES,
  type Snapshot,
  type StoredEvent,
  type StreamMessage,
} from "../../shared/api.js";
import { Session, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { Router } from "../http/router.js";
import { Store } from "../store/store.js";
import { uiGuard } from "./index.js";
import { LimitsStore, registerLimits } from "./limits.js";

const FIVE = { id: "five_hour", used_percent: 23.5, window_minutes: 300, resets_at: "2026-10-28T19:43:49.000Z" };
const WEEK = { id: "seven_day", used_percent: 41.2, window_minutes: 10_080, resets_at: "2026-10-31T11:30:29.000Z" };

/** A limits.observed as the store hands it on: arrived and filed. */
function observed(
  data: Record<string, unknown>,
  o: { harness?: string; account?: string; machine?: string; time?: string; source?: StoredEvent["source"] } = {},
): StoredEvent {
  const s = new Session(`s-${Math.random().toString(36).slice(2)}`, o.harness ?? "claude-code");
  const ev = s.ev("limits.observed", data, {
    tier: 1,
    ...(o.time ? { time: o.time } : {}),
    session: { machine: o.machine ?? "lab-mac", ...(o.account ? { account_id: o.account } : {}) },
  });
  return { ...ev, arrivedAt: new Date().toISOString(), source: o.source ?? "http" };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe("LimitsStore", () => {
  let tmp: { dir: string; cleanup: () => void };
  let limits: LimitsStore;
  let frames: StreamMessage[];
  beforeEach(() => {
    tmp = tempDir();
    limits = new LimitsStore(tmp.dir);
    frames = [];
    limits.subscribe((m) => frames.push(m));
  });
  afterEach(() => tmp.cleanup());

  it("keeps one entry per (harness, account), or per machine when the event has no account", () => {
    expect(limits.observe(observed({ windows: [FIVE, WEEK] }, { account: "acc-1" }))).toBe(true);
    limits.observe(observed({ windows: [FIVE] }, { account: "acc-2" }));
    limits.observe(
      observed(
        { windows: [{ id: "primary", used_percent: 12, window_minutes: 300 }], plan: "pro" },
        {
          harness: "codex",
        },
      ),
    );
    expect(limits.list().map((e) => e.key)).toEqual(["claude-code a:acc-1", "claude-code a:acc-2", "codex m:lab-mac"]);
    expect(limits.list()[0]).toEqual({
      key: "claude-code a:acc-1",
      harness: "claude-code",
      accountId: "acc-1",
      machine: "lab-mac",
      machines: ["lab-mac"],
      windows: [
        { id: "five_hour", usedPercent: 23.5, windowMinutes: 300, resetsAt: FIVE.resets_at },
        { id: "seven_day", usedPercent: 41.2, windowMinutes: 10_080, resetsAt: WEEK.resets_at },
      ],
      observedAt: expect.any(String),
    } satisfies LimitsEntry);
    expect(limits.list()[2]).toMatchObject({ harness: "codex", plan: "pro", machine: "lab-mac" });
    expect(limits.list()[2]?.accountId).toBeUndefined();
    expect(frames).toHaveLength(3);
    expect(frames.at(-1)).toEqual({ kind: "limits", limits: limits.list() });
  });

  it("takes each newer event as the whole set, ignores an older one, and collects the machines", () => {
    limits.observe(observed({ windows: [FIVE, WEEK] }, { account: "a", time: minutesAgo(10) }));
    limits.observe(
      observed(
        { windows: [{ ...WEEK, used_percent: 50 }] },
        { account: "a", machine: "build-box", time: minutesAgo(5) },
      ),
    );
    // Five minutes later than the first, five earlier than the second: ignored, no frame.
    expect(limits.observe(observed({ windows: [FIVE] }, { account: "a", time: minutesAgo(8) }))).toBe(false);
    const [e] = limits.list();
    expect(e?.windows).toEqual([{ id: "seven_day", usedPercent: 50, windowMinutes: 10_080, resetsAt: WEEK.resets_at }]);
    expect(e?.machine).toBe("build-box");
    expect(e?.machines).toEqual(["build-box", "lab-mac"]);
    limits.observe(observed({ windows: [WEEK] }, { account: "a", machine: "lab-mac", time: minutesAgo(1) }));
    expect(limits.list()[0]?.machines).toEqual(["lab-mac", "build-box"]);
    expect(frames).toHaveLength(3);
  });

  it("skips windows that do not validate; an event with none changes nothing", () => {
    const bad = [
      { id: "Five Hour", used_percent: 1 },
      { id: "x", used_percent: -1 },
      { id: "x", used_percent: 10_001 },
      { id: "x", used_percent: "12" },
      { id: "x", used_percent: 1, resets_at: "tomorrow" },
      { id: "x", used_percent: 1, window_minutes: 2.5 },
      { id: "x", used_percent: 1, window_minutes: 0 },
      null,
    ];
    expect(limits.observe(observed({ windows: bad }, { account: "a" }))).toBe(false);
    expect(limits.observe(observed({ windows: "five_hour" }, { account: "a" }))).toBe(false);
    expect(limits.list()).toEqual([]);
    expect(frames).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, used_percent: i }));
    limits.observe(
      observed(
        { windows: [...bad, { id: "spend_limit", used_percent: 112 }, ...many], plan: "x".repeat(65) },
        { account: "a" },
      ),
    );
    const [e] = limits.list();
    expect(e?.windows.map((w) => w.id)).toEqual(["spend_limit", "w0", "w1", "w2", "w3", "w4", "w5", "w6"]);
    expect(e?.windows[0]).toEqual({ id: "spend_limit", usedPercent: 112 });
    expect(e?.plan).toBeUndefined();
  });

  it(`keeps ${LIMITS_MAX} entries, dropping the one reported longest ago`, () => {
    for (let i = 0; i <= LIMITS_MAX; i++)
      limits.observe(observed({ windows: [FIVE] }, { account: `acc-${i}`, time: minutesAgo(LIMITS_MAX + 10 - i) }));
    expect(limits.list()).toHaveLength(LIMITS_MAX);
    expect(limits.list().some((e) => e.accountId === "acc-0")).toBe(false);
    expect(limits.list().some((e) => e.accountId === `acc-${LIMITS_MAX}`)).toBe(true);
  });

  it("writes limits.json atomically and privately, and reads it back after a restart", () => {
    limits.observe(observed({ windows: [FIVE, WEEK] }, { account: "a" }));
    limits.observe(observed({ windows: [FIVE], plan: "plus" }, { harness: "codex" }));
    const file = path.join(tmp.dir, "limits.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(tmp.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const doc = JSON.parse(readFileSync(file, "utf8")) as { version: number; entries: LimitsEntry[] };
    expect(doc.version).toBe(1);
    expect(doc.entries).toHaveLength(2);
    expect(new LimitsStore(tmp.dir).list()).toEqual(limits.list());
  });

  it("sets a broken file aside and starts empty", () => {
    writeFileSync(path.join(tmp.dir, "limits.json"), "{nope");
    expect(new LimitsStore(tmp.dir).list()).toEqual([]);
    expect(readdirSync(tmp.dir).some((f) => f.startsWith("limits.json.bad-"))).toBe(true);
  });

  it("forgets an entry until its next report, with one frame", () => {
    limits.observe(observed({ windows: [FIVE] }, { account: "a" }));
    frames.length = 0;
    expect(limits.forget("claude-code a:a")).toBe(true);
    expect(limits.forget("claude-code a:a")).toBe(false);
    expect(limits.list()).toEqual([]);
    expect(frames).toEqual([{ kind: "limits", limits: [] }]);
    expect(JSON.parse(readFileSync(path.join(tmp.dir, "limits.json"), "utf8")).entries).toEqual([]);
    limits.observe(observed({ windows: [FIVE] }, { account: "a" }));
    expect(limits.list()).toHaveLength(1);
  });

  it("keeps the demo's numbers in memory only, under a real report, and drops them with demo mode", () => {
    limits.observe(observed({ windows: [FIVE] }, { account: "demo", source: "demo" }));
    expect(limits.list().map((e) => e.key)).toEqual(["claude-code a:demo"]);
    expect(existsSync(path.join(tmp.dir, "limits.json"))).toBe(false);
    limits.observe(observed({ windows: [WEEK] }, { account: "real" }));
    expect(
      JSON.parse(readFileSync(path.join(tmp.dir, "limits.json"), "utf8")).entries.map((e: LimitsEntry) => e.key),
    ).toEqual(["claude-code a:real"]);
    frames.length = 0;
    limits.dropDemo();
    expect(limits.list().map((e) => e.key)).toEqual(["claude-code a:real"]);
    expect(frames).toHaveLength(1);
    limits.dropDemo();
    expect(frames).toHaveLength(1);
    expect(new LimitsStore(tmp.dir).list().map((e) => e.key)).toEqual(["claude-code a:real"]);
  });

  it("follows the store: accepted events only, and forgetting the session keeps the numbers", async () => {
    const store = new Store(tmp.dir);
    try {
      limits.follow(store);
      const s = new Session("s1", "codex");
      const report = s.ev("limits.observed", { windows: [FIVE], plan: "plus" }, { tier: 1 });
      store.ingest([s.ev("session.started", { source: "startup" }), report], "http");
      expect(limits.list().map((e) => e.key)).toEqual(["codex m:misha-air"]);
      // The same event again is a duplicate the store never hands on.
      frames.length = 0;
      store.ingest([report], "http");
      expect(frames).toEqual([]);
      expect(store.forget("codex:s1")).toBe(true);
      expect(limits.list()).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
});

describe("limits routes", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  const url = (p: string) => `${app.url}${p}`;
  const forget = (body: unknown, type = "application/json") =>
    fetch(url(ROUTES.ui.limitsForget), {
      method: "POST",
      headers: { "content-type": type },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    tmp = tempDir();
    app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true });
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  it("GET reads, the snapshot and the stream carry them, POST forget drops one", async () => {
    const res = await fetch(url(ROUTES.ui.stream));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const next = async (kind: string): Promise<StreamMessage> => {
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split("\n").find((l) => l.startsWith("data: "));
          const m = data ? (JSON.parse(data.slice(6)) as StreamMessage) : null;
          if (m?.kind === kind) return m;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += dec.decode(value, { stream: true });
      }
    };
    expect(((await next("snapshot")) as { snapshot: Snapshot }).snapshot.limits).toEqual([]);

    const s = new Session("s1");
    app.store.ingest(
      [
        s.ev("session.started", { source: "startup" }),
        s.ev("limits.observed", { windows: [FIVE, WEEK] }, { tier: 1, session: { account_id: "acc-1" } }),
      ],
      "http",
    );
    const frame = (await next("limits")) as { limits: LimitsEntry[] };
    expect(frame.limits.map((e) => e.key)).toEqual(["claude-code a:acc-1"]);
    expect(await (await fetch(url(ROUTES.ui.limits))).json()).toEqual({ limits: frame.limits });
    expect(((await (await fetch(url(ROUTES.ui.snapshot))).json()) as Snapshot).limits).toEqual(frame.limits);

    expect((await forget({ key: "claude-code a:acc-1" }, "text/plain")).status).toBe(415);
    expect((await forget({ nope: 1 })).status).toBe(400);
    expect((await forget({ key: "claude-code a:nope" })).status).toBe(404);
    expect((await forget({ key: "claude-code a:acc-1" })).status).toBe(204);
    expect(((await next("limits")) as { limits: LimitsEntry[] }).limits).toEqual([]);
    expect(await (await fetch(url(ROUTES.ui.limits))).json()).toEqual({ limits: [] });
    await reader.cancel();
  });

  it("refuses a page off this machine without the UI key", async () => {
    const router = new Router();
    registerLimits(
      router,
      new LimitsStore(tmp.dir),
      uiGuard(() => "key"),
    );
    const ctx = { remote: { ip: "192.168.1.9", loopback: false }, url: new URL("http://x/"), cookies: () => ({}) };
    for (const [method, route] of [
      ["GET", ROUTES.ui.limits],
      ["POST", ROUTES.ui.limitsForget],
    ] as const) {
      const reply = await router.match(method, route)!.handler(ctx as never);
      expect(reply).toEqual({ status: 401, json: { reason: "unauthorized" } });
    }
  });

  it("keeps none of the demo's numbers in the file, and none after demo mode stops", async () => {
    const demo = (on: boolean) => fetch(url(ROUTES.ui.demo), { method: "POST", body: JSON.stringify({ on }) });
    const keys = async () =>
      ((await (await fetch(url(ROUTES.ui.limits))).json()) as { limits: LimitsEntry[] }).limits.map((e) => e.key);
    await demo(true);
    const s = new Session("pretend");
    app.store.ingest(
      [
        s.ev("session.started", { source: "startup" }),
        s.ev("limits.observed", { windows: [FIVE] }, { tier: 1, session: { account_id: "pretend" } }),
      ],
      "demo",
    );
    expect(await keys()).toContain("claude-code a:pretend");
    const file = path.join(tmp.dir, "limits.json");
    const inFile = () =>
      existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).entries.map((e: LimitsEntry) => e.key) : [];
    expect(inFile()).toEqual([]);
    await demo(false);
    expect(await keys()).toEqual([]);
    expect(inFile()).toEqual([]);
  });
});
