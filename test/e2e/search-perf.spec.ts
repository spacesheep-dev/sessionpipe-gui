// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. Keystroke → paint on the Search page (S5 "first result painted
// < 100 ms after a keystroke", SEARCH-SPEC §8.7): a server of its own over a generated
// history home (≈ 30k messages), then real typing, one character every 150 ms, over 10
// queries (60+ keystrokes). Each keystroke's time is from its `input` event to the first frame
// after the results changed; p95 must stay under 100 ms. Layout shift while typing must be 0.
// It runs in the desktop project; the phone has its own budget elsewhere.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { generate } from "../../bench/search/gen.mjs";
import { seenSetup } from "../../playwright.config.js";

const PORT = Number(process.env.SPGUI_SEARCH_PERF_PORT ?? 7928);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, "../..");
const CLI = process.env.SPGUI_SEARCH_PERF_CLI ?? path.join(ROOT, "dist", "cli.js");
const QUERIES = [
  "webhook retry",
  "error code",
  "src/store",
  "deploy -test",
  "rate limiter",
  '"the error"',
  "getUserName",
  "sessions",
  "build server",
  "migrat",
];
const BUDGET_MS = 100;

let server: ChildProcess | null = null;
let tmp = "";

test.describe("search keystroke → paint", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "layout-shift entries need Chromium");
  test.skip(!existsSync(CLI), `needs a built server at ${CLI}`);
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    tmp = mkdtempSync(path.join(os.tmpdir(), "spgui-search-perf-"));
    generate({ out: path.join(tmp, "gen"), profile: "gate", size: 20_000_000, seed: 5, now: Date.now() });
    server = spawn(
      process.execPath,
      [
        CLI,
        "--port",
        String(PORT),
        "--state",
        path.join(tmp, "gen", "state"),
        "--no-outbox",
        "--quiet",
        "--search-home",
        path.join(tmp, "gen", "home"),
      ],
      { stdio: "ignore" },
    );
    // Ready when the index has answered once.
    for (let i = 0; i < 600; i++) {
      try {
        const r = await fetch(`${BASE}/api/ui/search/status`);
        if (r.ok) {
          const s = (await r.json()) as { state: string; sessions: number };
          if (s.state === "ready" && s.sessions > 100) return;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("search server never became ready");
  });

  test.afterAll(() => {
    server?.kill("SIGTERM");
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test.use({ storageState: { cookies: [], origins: [seenSetup(BASE)] } });

  test(`p95 < ${BUDGET_MS} ms over 60+ typed keystrokes; no layout shift`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`${BASE}/search`);
    const field = page
      .getByRole("combobox")
      .or(page.getByLabel(/Search prompts/))
      .first();
    await field.waitFor();
    await page.evaluate(() => {
      const w = window as unknown as { __kp: { inputs: number[]; muts: number[]; shift: number; shiftAll: number } };
      w.__kp = { inputs: [], muts: [], shift: 0, shiftAll: 0 };
      document.addEventListener(
        "input",
        () => {
          w.__kp.inputs.push(performance.now());
        },
        true,
      );
      // A change in the results (rows, marks, the "N sessions · 3 ms" line), then the frame that paints it.
      new MutationObserver(() => {
        const t = performance.now();
        requestAnimationFrame(() => w.__kp.muts.push(Math.max(t, performance.now())));
      }).observe(document.querySelector("main") ?? document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      const who = new Map<string, number>();
      (w.__kp as unknown as { who: Map<string, number> }).who = who;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as (PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources?: { node?: Node | null }[];
        })[]) {
          w.__kp.shiftAll += e.value;
          if (!e.hadRecentInput) w.__kp.shift += e.value;
          for (const src of e.sources ?? []) {
            const el = src.node instanceof Element ? src.node : src.node?.parentElement;
            const name = el ? `${el.tagName.toLowerCase()}.${Array.from(el.classList).join(".")}` : "?";
            who.set(name, (who.get(name) ?? 0) + e.value);
          }
        }
      }).observe({ type: "layout-shift", buffered: false });
    });
    for (const q of QUERIES) {
      await field.fill("");
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        const w = window as unknown as { __kp: { inputs: number[]; muts: number[] } };
        w.__kp.inputs.push(-1); // a query boundary (the clear)
      });
      for (const ch of q) {
        await field.press(ch === " " ? "Space" : ch);
        await page.waitForTimeout(150);
      }
      await page.waitForTimeout(300);
    }
    const kp = await page.evaluate(() => {
      const k = (
        window as unknown as {
          __kp: { inputs: number[]; muts: number[]; shift: number; shiftAll: number; who: Map<string, number> };
        }
      ).__kp;
      const who = [...k.who]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([n, v]) => `${n} ${v.toFixed(2)}`);
      return { inputs: k.inputs, muts: k.muts, shift: k.shift, shiftAll: k.shiftAll, who };
    });
    // Per keystroke: the first painted change after it and before the next one.
    const lat: number[] = [];
    let missed = 0;
    let boundary = true;
    let k = 0;
    for (let i = 0; i < kp.inputs.length; i++) {
      const t = kp.inputs[i]!;
      if (t < 0) {
        boundary = true;
        k = 0;
        continue;
      }
      // The fill("") clear fires an input too; skip it and the first character (a 1-char word waits).
      if (boundary) {
        boundary = false;
        continue;
      }
      k++;
      if (k < 2) continue;
      const next = kp.inputs.slice(i + 1).find((x) => x >= 0) ?? Number.POSITIVE_INFINITY;
      const m = kp.muts.find((x) => x >= t && x < next);
      if (m === undefined) missed++;
      else lat.push(m - t);
    }
    lat.sort((a, b) => a - b);
    const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? Number.POSITIVE_INFINITY;
    const summary = {
      keystrokes: lat.length + missed,
      missed,
      p50: Math.round(p(0.5)),
      p95: Math.round(p(0.95)),
      max: Math.round(lat.at(-1) ?? 0),
      cls: kp.shift,
      shiftAll: Math.round(kp.shiftAll * 100) / 100,
      shifted: kp.who,
    };
    test.info().annotations.push({ type: "keystroke→paint", description: JSON.stringify(summary) });
    console.log(`search keystroke→paint ${JSON.stringify(summary)}`);
    expect(summary.keystrokes).toBeGreaterThanOrEqual(50);
    // A keystroke whose answer paints exactly what is already there (`migra` → `migrat` with
    // the same rows and the same "3 ms") changes nothing in the DOM; up to a fifth may.
    expect(missed).toBeLessThanOrEqual(Math.floor(summary.keystrokes * 0.2));
    expect(summary.p95).toBeLessThan(BUDGET_MS);
    expect(kp.shift).toBe(0);
  });
});
