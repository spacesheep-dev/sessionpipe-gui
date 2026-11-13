// SPDX-License-Identifier: Apache-2.0
// How the page on an account does with a relay as full as a relay gets: a first connect
// (the whole backlog), then a restart from what it kept, on a slowed CPU. The relay is the
// fake one holding the events of a file; the page, its store, its cache and IndexedDB are
// the real ones. It prints one line of numbers a run. See manual.config.ts.
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test } from "@playwright/test";
import { FakeSpacesheep } from "./fake-spacesheep.js";
import { HubStandIn } from "./hub.js";
import { startAccountServer } from "./serve.js";
import { fakeShell } from "./shell-init.js";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/web");
const EVENTS = process.env.ACCOUNT_BENCH_EVENTS ?? "";
const THROTTLE = Number(process.env.ACCOUNT_BENCH_THROTTLE ?? 4);
const LATENCY = Number(process.env.ACCOUNT_BENCH_LATENCY_MS ?? 0);

interface View {
  catching: boolean;
  cache: string;
  firstBoardMs: number | null;
  caughtUpMs: number | null;
  restored: { events: number; pages: number; readMs: number; bootMs: number } | null;
  store: { events: number; sessions: number; bytes: number };
  relay: { state: string; cursor: number };
}

test("a first connect and a restart with a full relay", async () => {
  test.skip(!EVENTS, "set ACCOUNT_BENCH_EVENTS (see manual.config.ts)");
  const events = JSON.parse(readFileSync(EVENTS, "utf8")) as { time: string }[];
  // As a relay holds them: nothing older than its week. The file's times are moved so
  // that its newest event is a minute old and its span is at most six days.
  const times = events.map((e) => Date.parse(e.time));
  const newest = Math.max(...times);
  const span = Math.max(1, newest - Math.min(...times));
  const scale = Math.min(1, (6 * 86_400_000) / span);
  const end = Date.now() - 60_000;
  events.forEach((e, i) => {
    e.time = new Date(end - (newest - times[i]!) * scale).toISOString();
  });
  const ss = new FakeSpacesheep();
  ss.machines = [
    {
      id: "m_bench0123456789abcd",
      name: "bench",
      online: true,
      agents: ["claude-code"],
      modes: ["waiter"],
      passkey_ids: ["k"],
    },
  ];
  ss.push(events);
  const hub = new HubStandIn({ upstream: { origin: "https://spacesheep.test", ask: (req) => ss.handle(req) } });
  hub.latencyMs = LATENCY;
  hub.add("bench@example.com", ss.key);
  const server = await startAccountServer({ web: WEB, hub });
  const profile = mkdtempSync(path.join(tmpdir(), "spgui-account-bench-"));
  const longTasks = () => {
    const w = window as unknown as { __long: number[] };
    w.__long = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__long.push(Math.round(e.duration));
      }).observe({ entryTypes: ["longtask"] });
    } catch {
      /* no long task entries here */
    }
  };

  const run = async (kind: "cold" | "restart") => {
    const context = await chromium.launchPersistentContext(profile, {
      headless: true,
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      args: ["--enable-precise-memory-info"],
    });
    await context.addInitScript(fakeShell, {});
    await context.addInitScript(longTasks);
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
    const view = () =>
      page.evaluate(
        () =>
          (window as unknown as { __sessionpipeAccount?: { view(): unknown } }).__sessionpipeAccount?.view() ?? null,
      ) as Promise<View | null>;
    const t0 = Date.now();
    await page.goto(server.url, { waitUntil: "commit" });
    // The board is on screen when a group of sessions is.
    await page.locator(".board-list .group-head, .board-list [data-session]").first().waitFor({ timeout: 300_000 });
    const rowsMs = Date.now() - t0;
    await expect.poll(async () => (await view())?.catching, { timeout: 600_000, intervals: [50] }).toBe(false);
    const inMs = Date.now() - t0;
    await page.evaluate(() =>
      (window as unknown as { __sessionpipeAccount: { flushed(): Promise<void> } }).__sessionpipeAccount.flushed(),
    );
    await page.waitForTimeout(1500);
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(300);
    const heap = await cdp.send("Runtime.getHeapUsage");
    const v = (await view())!;
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    const reads = await page.evaluate(async () => {
      const b = (
        window as unknown as {
          __sessionpipeAccount: {
            transport: {
              feed(q: object): Promise<{ events: { harness: { name: string }; session: { id: string } }[] }>;
              session(h: string, id: string, q: object): Promise<unknown>;
            };
          };
        }
      ).__sessionpipeAccount;
      const t = performance.now();
      const f = await b.transport.feed({ limit: 50 });
      const feedMs = performance.now() - t;
      const e = f.events[0]!;
      const t2 = performance.now();
      await b.transport.session(e.harness.name, e.session.id, { tail: true, limit: 200 });
      return { feedMs: Math.round(feedMs * 10) / 10, sessionMs: Math.round((performance.now() - t2) * 10) / 10 };
    });
    await context.close();
    const disk =
      Number(
        execSync(`du -sk "${path.join(profile, "Default", "IndexedDB")}"`)
          .toString()
          .trim()
          .split(/\s+/)[0],
      ) / 1024;
    return {
      kind,
      throttle: THROTTLE,
      latencyMs: LATENCY,
      boardOnScreenMs: rowsMs,
      backendFirstBoardMs: v.firstBoardMs && Math.round(v.firstBoardMs),
      allInMs: kind === "cold" ? inMs : undefined,
      backendCaughtUpMs: v.caughtUpMs && Math.round(v.caughtUpMs),
      restored: v.restored && {
        ...v.restored,
        readMs: Math.round(v.restored.readMs),
        bootMs: Math.round(v.restored.bootMs),
      },
      events: v.store.events,
      sessions: v.store.sessions,
      heapMB: Math.round((heap.usedSize / 1048576) * 10) / 10,
      indexedDbMB: Math.round(disk * 10) / 10,
      longTasks: { n: long.length, max: Math.max(0, ...long) },
      relayReads: ss.relayReads,
      ...reads,
    };
  };
  try {
    console.log(`BENCH ${JSON.stringify(await run("cold"))}`);
    console.log(`BENCH ${JSON.stringify(await run("restart"))}`);
  } finally {
    await server.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
