// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The board before its first session, on a receiver of its own that has heard nothing and
// has no machine paired (the suite's demo server has sessions, and tls.spec.ts pairs a
// machine on the other): the sentence names the agent whose hooks are on and the command
// that starts it, the wait names the hooked agents alone, the two ways on are quiet, and
// the view menu offers only what acts with no row to act on. Which agents this machine has
// is the test's to say: the setup status is stubbed.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { seenSetup } from "../../playwright.config.js";
import { openBoard } from "./helpers.js";

const CLI = path.resolve(import.meta.dirname, "../..", "dist", "cli.js");
const STATUS = "/api/ui/setup/status";
const LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  antigravity: "Antigravity",
};

let rx: ChildProcess | null = null;
let tmp = "";
let base = "";

/** The view menu's rows, as it lists them. */
const menuRows = (page: Page) => page.getByRole("menu").first().locator(".menu-label");

/** The empty board on a machine named studio-mac with sessionpipe installed and these
 *  agents, in this order; `on` are the ones whose hooks are written. */
async function openEmpty(page: Page, on: string[], installed = Object.keys(LABEL)): Promise<void> {
  const real = (await (await page.request.get(`${base}${STATUS}`)).json()) as {
    sessionpipe: object;
    daemon: object;
  };
  const status = {
    ...real,
    sessionpipe: { ...real.sessionpipe, installed: true },
    daemon: { ...real.daemon, name: "studio-mac" },
    harnesses: installed.map((name) => ({
      name,
      label: LABEL[name],
      installed: true,
      hooks: on.includes(name) ? "on" : "off",
      configPath: `~/.${name}/hooks.json`,
      sessions: 0,
    })),
  };
  await page.route(`${base}${STATUS}`, (route) => route.fulfill({ json: status }));
  // A device that has seen setup, in the full interface, as the suite's other origins are.
  await page.addInitScript((items) => {
    for (const i of items) localStorage.setItem(i.name, i.value);
  }, seenSetup(base).localStorage);
  await page.goto(`${base}/`);
  await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Waiting for your first session" })).toBeVisible();
}

test.describe("the board before its first session", () => {
  test.describe.configure({ mode: "default" });

  test.beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "spgui-board-empty-"));
    const state = path.join(tmp, "state");
    // Port 0: whichever is free; run.json says which it took. No history but its own.
    const args = ["--port", "0", "--host", "127.0.0.1", "--state", state, "--no-outbox", "--quiet"];
    rx = spawn(process.execPath, [CLI, ...args, "--search-home", path.join(tmp, "no-history")], { stdio: "ignore" });
    await expect
      .poll(
        () => {
          try {
            base = (JSON.parse(readFileSync(path.join(state, "run.json"), "utf8")) as { url: string }).url;
          } catch {
            // not listening yet
          }
          return base;
        },
        { timeout: 20_000 },
      )
      .toMatch(/^http:/);
  });

  test.afterAll(() => {
    rx?.kill("SIGTERM");
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test("Codex alone hooked: the sentence and the command are Codex's, and nothing says claude", async ({ page }) => {
    await openEmpty(page, ["codex"]);
    const empty = page.locator(".board-empty");
    await expect(empty.locator(".state-text p").first()).toHaveText(
      "Start a new Codex session in any terminal on studio-mac.",
    );
    await expect(empty.locator(".cmdwell-text")).toHaveText("$ codex");
    await expect(empty.locator(".listening")).toHaveText("Listening · Codex");
    await expect(empty).not.toContainText(/claude/i);
  });

  test("an agent with no command to type: no terminal in the sentence, and no command", async ({ page }) => {
    await openEmpty(page, ["antigravity"]);
    const empty = page.locator(".board-empty");
    await expect(empty.locator(".state-text p").first()).toHaveText("Start a new Antigravity session on studio-mac.");
    await expect(empty.locator(".cmdwell")).toHaveCount(0);
    await expect(empty.locator(".listening")).toHaveText("Listening · Antigravity");
  });

  test("the first hooked agent that has a command leads, whatever is listed before it", async ({ page }) => {
    await openEmpty(
      page,
      ["antigravity", "gemini-cli", "codex"],
      ["antigravity", "claude-code", "gemini-cli", "codex"],
    );
    const empty = page.locator(".board-empty");
    await expect(empty.locator(".state-text p").first()).toHaveText(
      "Start a new Gemini session in any terminal on studio-mac.",
    );
    await expect(empty.locator(".cmdwell-text")).toHaveText("$ gemini");
    // The wait names every hooked agent, and only those.
    await expect(empty.locator(".listening")).toHaveText("Listening · Antigravity, Gemini, Codex");
  });

  test("nothing hooked: Claude Code stands in, and the wait names no agent", async ({ page }) => {
    await openEmpty(page, []);
    const empty = page.locator(".board-empty");
    await expect(empty.locator(".state-text p").first()).toHaveText(
      "Start a new Claude Code session in any terminal on studio-mac.",
    );
    await expect(empty.locator(".cmdwell-text")).toHaveText("$ claude");
    await expect(empty.locator(".listening")).toHaveText("Listening");
  });

  test("the two ways on are quiet buttons: Try the demo, then Pair another machine", async ({ page }) => {
    await openEmpty(page, ["claude-code", "codex"]);
    const actions = page.locator(".board-empty .state-actions .btn");
    await expect(actions).toHaveText(["Try the demo", "Pair another machine"]);
    for (const b of await actions.all()) await expect(b).toHaveClass(/btn--ghost/);
    await expect(page.getByRole("link", { name: "Pair another machine" })).toHaveAttribute("href", "/connect");
    await expect(page.getByText(/sample sessions/)).toHaveCount(0);
    // The demo it opens is the one the yellow bar leaves.
    await page.getByRole("button", { name: "Try the demo" }).click();
    await expect(page).toHaveURL(/\?mock=1$/);
    await expect(page.locator("[data-demo-banner]").getByRole("link", { name: "Leave the demo" })).toBeVisible();
  });

  test("the view menu, from a right-click and from ⋯, is how sessions open and the mode", async ({ page }) => {
    await openEmpty(page, ["claude-code"]);
    // The page's empty space, clear of the words in its middle.
    const box = (await page.locator(".page.board").boundingBox())!;
    await page.mouse.click(box.x + 60, box.y + box.height - 60, { button: "right" });
    await expect(menuRows(page)).toHaveText(["Open sessions", "Mode"]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.getByRole("button", { name: "View options" }).click();
    await expect(menuRows(page)).toHaveText(["Open sessions", "Mode"]);
  });

  test("with rows on the board the view menu has all of it", async ({ page }) => {
    await openBoard(page);
    await page.getByRole("button", { name: "View options" }).click();
    await expect(menuRows(page)).toHaveText([
      "Find…",
      "Show done sessions",
      "Show counts",
      "Edit labels…",
      "Mark all as read",
      "Open sessions",
      "Tier lens",
      "Mode",
    ]);
  });
});
