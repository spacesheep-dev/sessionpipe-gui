// SPDX-License-Identifier: Apache-2.0
// The rules around the board's key: one rule for "this computer"; a key or token this
// receiver replaced never comes back from config.json, nor does a short or empty one; a
// setting writes only its own field; an empty credential opens nothing; and the receiver's
// own new keys back off: the first at once, then after 30 seconds, doubling up to ten minutes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES, UI_KEY_COOKIE } from "../shared/api.js";
import { tempDir } from "../test/events.js";
import { type App, createApp } from "./app.js";
import { hashSecret, readGuiConfig, setEnabled } from "./config.js";
import { isLoopback, onThisComputer, ownAddresses } from "./http/net.js";
import type { Ctx } from "./http/router.js";
import { actsHere } from "./setup/local.js";
import { watchUiKey } from "./ui/keyRenewal.js";

const PUBLIC = "https://laptop.tail1234.ts.net";
const VISITOR = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };

let tmp: { dir: string; cleanup: () => void };
let app: App | null = null;
beforeEach(() => {
  tmp = tempDir("spgui-keyrules-");
});
afterEach(async () => {
  await app?.close();
  app = null;
  tmp.cleanup();
  vi.useRealTimers();
}, 60_000);

async function boot(): Promise<App> {
  app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, publicUrl: PUBLIC });
  await app.keyLooked;
  return app;
}
const file = () => path.join(tmp.dir, "config.json");
const disk = () => JSON.parse(readFileSync(file(), "utf8")) as { uiKey: string; sinkToken: string };
const visitor = async (a: App, key: string) =>
  (await fetch(`${a.url}${ROUTES.ui.info}`, { headers: { ...VISITOR, cookie: `${UI_KEY_COOKIE}=${key}` } })).status;
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  expect(cond()).toBe(true);
}
const settle = () => new Promise((r) => setTimeout(r, 3500));

describe("this computer", () => {
  it("is loopback not through the proxy; a bound address that is not loopback only when the receiver is bound to it alone", () => {
    expect(onThisComputer({ ip: "127.0.0.1", forwarded: false }, null)).toBe(true);
    expect(onThisComputer({ ip: "::ffff:127.0.0.1", forwarded: false }, null)).toBe(true);
    expect(onThisComputer({ ip: "127.0.0.1", forwarded: true }, null)).toBe(false);
    // Every address bound: this machine's own LAN address is not this computer.
    expect(onThisComputer({ ip: "192.0.2.10", forwarded: false }, null)).toBe(false);
    // Bound to 192.0.2.10 alone: that address is, another device's is not, the proxy's never.
    expect(onThisComputer({ ip: "192.0.2.10", forwarded: false }, "192.0.2.10")).toBe(true);
    expect(onThisComputer({ ip: "::ffff:192.0.2.10", forwarded: false }, "192.0.2.10")).toBe(true);
    expect(onThisComputer({ ip: "192.0.2.11", forwarded: false }, "192.0.2.10")).toBe(false);
    expect(onThisComputer({ ip: "192.0.2.10", forwarded: true }, "192.0.2.10")).toBe(false);
    // Bound to a loopback address: loopback alone, as with every address.
    expect(onThisComputer({ ip: "192.0.2.10", forwarded: false }, "127.0.0.1")).toBe(false);
  });
});

describe("acting on this computer (Setup, the phone page's Tailscale, search's index)", () => {
  const own = ownAddresses().find((ip) => !isLoopback(ip) && !ip.startsWith("fe80"));
  const ctx = (o: { ip: string; forwarded?: boolean; key?: string; via?: "cookie" | "k" }): Ctx =>
    ({
      remote: {
        ip: o.ip,
        loopback: isLoopback(o.ip) && !o.forwarded,
        forwarded: o.forwarded ?? false,
        thisComputer: onThisComputer({ ip: o.ip, forwarded: o.forwarded ?? false }, null),
      },
      req: { headers: {} },
      url: new URL(`http://x/api/ui/setup/status${o.key && o.via === "k" ? `?k=${o.key}` : ""}`),
      cookies: () => (o.key && o.via !== "k" ? { [UI_KEY_COOKIE]: o.key } : {}),
    }) as unknown as Ctx;
  const KEY = "TheBoardKey-0123456789";

  it("is this computer, or this machine's own address with the board's key", () => {
    expect(actsHere(ctx({ ip: "127.0.0.1" }), KEY)).toBe(true);
    expect(actsHere(ctx({ ip: "127.0.0.1", forwarded: true, key: KEY }), KEY)).toBe(false);
    expect(actsHere(ctx({ ip: "192.0.2.77", key: KEY }), KEY)).toBe(false);
    expect(actsHere(ctx({ ip: "192.0.2.77", key: KEY, via: "k" }), KEY)).toBe(false);
  });
  it.skipIf(!own)("this machine's own address: refused without the key or with a wrong one, taken with it", () => {
    expect(actsHere(ctx({ ip: own! }), KEY)).toBe(false);
    expect(actsHere(ctx({ ip: own!, key: "not-the-board-key-0000" }), KEY)).toBe(false);
    expect(actsHere(ctx({ ip: own!, key: KEY }), KEY)).toBe(true);
    expect(actsHere(ctx({ ip: own!, key: KEY, via: "k" }), KEY)).toBe(true);
    expect(actsHere(ctx({ ip: own!, key: KEY, forwarded: true }), KEY)).toBe(false);
    expect(actsHere(ctx({ ip: own!, key: "" }), "")).toBe(false);
  });
});

describe("a key or token this receiver replaced never comes back", () => {
  it("a stale settings write (a copy read before a new key) keeps the new key on disk and in use", async () => {
    const a = await boot();
    const k1 = a.config().uiKey;
    const stale = readGuiConfig(tmp.dir);
    a.renewUiKey();
    const k2 = a.config().uiKey;
    // As `plugin enable` would, with the copy it read before.
    setEnabled(tmp.dir, stale, "plugin:ping-a-human", true);
    expect(disk().uiKey).toBe(k2);
    await settle();
    expect(a.config().uiKey).toBe(k2);
    expect(await visitor(a, k1)).toBe(401);
    expect(await visitor(a, k2)).toBe(200);
  }, 30_000);

  it("a whole stale file (an older receiver's write) puts the old key back nowhere: it is written over", async () => {
    const a = await boot();
    const stale = readFileSync(file(), "utf8");
    const k1 = a.config().uiKey;
    a.renewUiKey();
    const k2 = a.config().uiKey;
    writeFileSync(file(), stale);
    await until(() => disk().uiKey === k2);
    expect(a.config().uiKey).toBe(k2);
    expect(await visitor(a, k1)).toBe(401);
  }, 30_000);

  it("the same for a rotated sink token", async () => {
    const a = await boot();
    const stale = readFileSync(file(), "utf8");
    const t1 = a.config().sinkToken;
    expect((await fetch(`${a.url}${ROUTES.ui.rotateToken}`, { method: "POST" })).status).toBe(200);
    const t2 = a.config().sinkToken;
    expect(t2).not.toBe(t1);
    writeFileSync(file(), stale);
    await until(() => disk().sinkToken === t2);
    expect(a.config().sinkToken).toBe(t2);
    const sent = await fetch(`${a.url}${ROUTES.events}`, {
      method: "POST",
      headers: { authorization: `Bearer ${t1}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(sent.status).toBe(401);
  }, 30_000);

  it("a short or deleted key on disk is left alone while running, and honoured at the next start", async () => {
    let a = await boot();
    const k = a.config().uiKey;
    writeFileSync(file(), JSON.stringify({ ...disk(), uiKey: "a" }));
    await settle();
    // Not taken, and not written over: the owner's value stays on disk.
    expect(a.config().uiKey).toBe(k);
    expect(disk().uiKey).toBe("a");
    // One of 16 or more is the owner's choice, and is taken at once.
    writeFileSync(file(), JSON.stringify({ ...disk(), uiKey: "OwnerChoseThisKey" }));
    await until(() => a.config().uiKey === "OwnerChoseThisKey");
    // Deleted: left alone; the next start makes a new one, as it always did.
    const { uiKey: _drop, ...rest } = disk();
    writeFileSync(file(), JSON.stringify(rest));
    await settle();
    expect(a.config().uiKey).toBe("OwnerChoseThisKey");
    expect("uiKey" in disk()).toBe(false);
    await a.close();
    app = null;
    a = await boot();
    expect(a.config().uiKey).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(a.config().uiKey).not.toBe("OwnerChoseThisKey");
    // A short one at a start is honoured, as it always was.
    await a.close();
    app = null;
    writeFileSync(file(), JSON.stringify({ ...disk(), uiKey: "short" }));
    a = await boot();
    expect(a.config().uiKey).toBe("short");
  }, 60_000);

  it("the retired list is in config.json, as hashes, and holds across a start", async () => {
    let a = await boot();
    const k1 = a.config().uiKey;
    const stale = readFileSync(file(), "utf8");
    a.renewUiKey();
    const k2 = a.config().uiKey;
    const raw = JSON.parse(readFileSync(file(), "utf8")) as { retired: string[] };
    expect(raw.retired).toContain(hashSecret(k1));
    expect(readFileSync(file(), "utf8")).not.toContain(k1);
    await a.close();
    app = null;
    // The stale copy lands while no receiver runs: the next start refuses its key.
    writeFileSync(file(), JSON.stringify({ ...JSON.parse(stale), retired: raw.retired }));
    a = await boot();
    expect(a.config().uiKey).not.toBe(k1);
    expect(a.config().uiKey).not.toBe(k2);
    expect(await visitor(a, k1)).toBe(401);
  }, 60_000);
});

describe("an empty credential opens nothing", () => {
  it("whatever is on disk: empty, broken or wrong-typed secrets change nothing, and no empty k, cookie or bearer is let in", async () => {
    const a = await boot();
    const k = a.config().uiKey;
    const good = readFileSync(file(), "utf8");
    for (const bad of [
      "",
      "{",
      JSON.stringify({ sinkToken: "", uiKey: "" }),
      JSON.stringify({ sinkToken: 1, uiKey: null }),
      JSON.stringify({ ...JSON.parse(good), uiKey: "", sinkToken: "" }),
    ]) {
      writeFileSync(file(), bad);
      await settle();
      expect(a.config().uiKey).toBe(k);
      expect(await visitor(a, "")).toBe(401);
      expect((await fetch(`${a.url}${ROUTES.ui.info}?k=`, { headers: VISITOR })).status).toBe(401);
      const ev = await fetch(`${a.url}${ROUTES.events}`, {
        method: "POST",
        headers: { ...VISITOR, authorization: "Bearer ", "content-type": "application/json" },
        body: JSON.stringify({ events: [] }),
      });
      expect(ev.status).toBe(401);
    }
  }, 90_000);
});

describe("the receiver's own new keys back off", () => {
  const fake = () => {
    let key = "K0-0123456789abcdef";
    let n = 0;
    const at: number[] = [];
    const readers: ((e: readonly unknown[]) => void)[] = [];
    mkdirSync(path.join(tmp.dir, "events"), { recursive: true });
    const w = watchUiKey({
      stateDir: tmp.dir,
      store: {
        onArrival: (r) => {
          readers.push(r);
          return () => {};
        },
      },
      key: () => key,
      renew: () => {
        n++;
        at.push(Math.round(performance.now() / 1000));
        key = `K${n}-0123456789abcdef`;
      },
    });
    return {
      w,
      send: () => readers[0]!([{ data: { text: `the board: http://192.0.2.10:7373/?k=${key}` } }]),
      count: () => n,
      at,
      setKey: (k: string) => {
        key = k;
      },
    };
  };
  const clock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });

  it("twenty batches in a minute: new keys at 0 s, 30 s and 60 s after that, none after without a new find", () => {
    clock();
    const t0 = Math.round(performance.now() / 1000);
    const f = fake();
    for (let i = 0; i < 20; i++) {
      f.send();
      vi.advanceTimersByTime(3000);
    }
    vi.advanceTimersByTime(60 * 60_000);
    expect(f.at.map((t) => t - t0)).toEqual([0, 30, 90]);
    f.w.close();
  });

  it("each further one in a streak waits twice as long, up to ten minutes; a quiet ten minutes starts again at once", () => {
    clock();
    const t0 = Math.round(performance.now() / 1000);
    const f = fake();
    // A find every second for two hours.
    for (let i = 0; i < 2 * 3600; i++) {
      f.send();
      vi.advanceTimersByTime(1000);
    }
    const gaps = f.at.slice(1).map((t, i) => t - f.at[i]!);
    expect(gaps.slice(0, 6)).toEqual([30, 60, 120, 240, 480, 600]);
    expect(gaps.slice(6).every((g) => g === 600)).toBe(true);
    // The last find waits its turn; then ten quiet minutes: the next find is made at once.
    vi.advanceTimersByTime(10 * 60_000);
    vi.advanceTimersByTime(10 * 60_000);
    const before = f.count();
    const now = Math.round(performance.now() / 1000);
    f.send();
    expect(f.count()).toBe(before + 1);
    expect(f.at.at(-1)! - now).toBe(0);
    expect(t0).toBeLessThanOrEqual(f.at[0]!);
    f.w.close();
  });

  it("a wall clock set back an hour changes nothing", () => {
    clock();
    const f = fake();
    f.send();
    expect(f.count()).toBe(1);
    vi.setSystemTime(Date.now() - 3600_000);
    f.send();
    vi.advanceTimersByTime(29_000);
    expect(f.count()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(f.count()).toBe(2);
    f.w.close();
  });

  it("a find that waits is dropped when the key was replaced by hand meanwhile", () => {
    clock();
    const f = fake();
    f.send();
    f.send();
    expect(f.count()).toBe(1);
    f.setKey("ByHand-0123456789abcd");
    vi.advanceTimersByTime(11 * 60_000);
    expect(f.count()).toBe(1);
    f.w.close();
  });

  it("a key shorter than 16 characters is not looked for", () => {
    clock();
    const f = fake();
    f.setKey("short");
    f.send();
    expect(f.count()).toBe(0);
    f.w.close();
  });

  it("the look at start counts as the streak's first", async () => {
    const key = "Start-0123456789abcd";
    const d = path.join(tmp.dir, "events", "claude-code");
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, "s.jsonl"), `${JSON.stringify({ data: { text: `?k=${key}` } })}\n`);
    let current = key;
    let n = 0;
    const readers: ((e: readonly unknown[]) => void)[] = [];
    const w = watchUiKey({
      stateDir: tmp.dir,
      store: {
        onArrival: (r) => {
          readers.push(r);
          return () => {};
        },
      },
      key: () => current,
      renew: () => {
        n++;
        current = `After${n}-0123456789abcd`;
      },
    });
    expect(await w.looked).toBe(true);
    expect(n).toBe(1);
    readers[0]!([{ text: current }]);
    expect(n).toBe(1);
    w.close();
  });

  it("by hand there is no limit", async () => {
    const a = await boot();
    const keys = new Set<string>();
    for (let i = 0; i < 5; i++) {
      expect((await fetch(`${a.url}${ROUTES.ui.renewKey}`, { method: "POST" })).status).toBe(204);
      keys.add(a.config().uiKey);
    }
    expect(keys.size).toBe(5);
  });
});
