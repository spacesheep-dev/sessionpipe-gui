// SPDX-License-Identifier: Apache-2.0
// sessionpipe 0.10.0 on the demo server (server/demo/machine.ts, sim.ts): lab-mac is paired
// in inherit mode with an ACP agent and an api.z.ai account; its sessions wait on
// background work, take a scheduled turn and run unattended. The well-known says
// `control.inherit`. Desktop only; the phone's layout of the same rows is mobile.spec.ts's.
import { expect, type Page, test } from "@playwright/test";
import { openBoard, openPage, WELL_KNOWN } from "./helpers.js";

test.skip(({ isMobile }) => isMobile, "desktop project");

interface Snap {
  sessions: {
    harness: string;
    id: string;
    machine?: string;
    attended?: boolean;
    state: string;
    background?: { tasks: number };
    title?: string;
    counts: { turns: number };
  }[];
}
const snap = async (page: Page): Promise<Snap> => (await (await page.request.get("/api/ui/snapshot")).json()) as Snap;

test("the well-known says this receiver shows inherit mode", async ({ request }) => {
  const wk = (await (await request.get(WELL_KNOWN)).json()) as { control: { inherit?: boolean } };
  expect(wk.control.inherit).toBe(true);
});

test("Machines: lab-mac in inherit mode, its ACP agent and its account on another API", async ({ page }) => {
  await openPage(page, "/machines");
  const lab = page.locator("section.machine[aria-label='lab-mac']");
  await expect(lab.locator(".machine-control")).toContainText("Paired · inherit mode");
  await expect(lab.locator(".machine-caution")).toHaveText(/^Sessions run as your own do on lab-mac/);
  await expect(lab.locator(".machine-harness", { hasText: "goose" })).toBeVisible();
  await expect(lab.locator(".machine-accounts")).toContainText("api.z.ai · Claude Code, API");
  await expect(lab.locator(".machine-accounts")).toContainText("dev@example.com · Claude Code");
});

test("New session on lab-mac: its own default first, read and safe; goose takes no options", async ({ page }) => {
  await openPage(page, "/?new=1&machine=lab-mac");
  const sheet = page.locator("[data-new-session]");
  await expect(sheet.locator("[data-ns-row=permission] button.sel")).toContainText(
    "As your own sessions on this machine",
  );
  await sheet.locator("[data-ns-row=permission] button.sel").click();
  await expect(page.locator(".sel-opt")).toHaveText([/As your own sessions/, /Read only/, /^Safe/]);
  await page.keyboard.press("Escape");
  await sheet.locator("[data-ns-row=agent] button.sel").click();
  await page.locator(".sel-opt", { hasText: "goose" }).click();
  await expect(sheet.locator("[data-ns-row=permission]")).toHaveCount(0);
  await expect(sheet.locator("[data-ns-row=model]")).toHaveCount(0);
});

test("a session waiting on its own background work stays working, and says on what", async ({ page }) => {
  await expect
    .poll(async () => (await snap(page)).sessions.find((s) => (s.background?.tasks ?? 0) > 0)?.state, {
      timeout: 30_000,
    })
    .toBe("working");
  await openBoard(page);
  await expect(page.locator("article.card .card-run", { hasText: /^waiting on \d background tasks?$/ })).toBeVisible();
  const s = (await snap(page)).sessions.find((x) => (x.background?.tasks ?? 0) > 0)!;
  await openPage(page, `/s/${s.harness}/${s.id}`);
  await expect(page.locator(".sess-waiting")).toHaveText(/^Waiting on \d background tasks?; each one wakes/);
  // It was started from here: what the machine ran it with is in the bar.
  await expect(page.locator(".sess-applied")).toHaveText("As your own sessions");
});

test("a short unattended run is quiet on the board", async ({ page }) => {
  await expect
    .poll(async () => (await snap(page)).sessions.some((s) => s.attended === false && s.state === "done"), {
      timeout: 30_000,
    })
    .toBe(true);
  await openBoard(page);
  const done = page.locator("button", { hasText: /^Done/ }).first();
  if ((await page.locator("article.card--quiet").count()) === 0) await done.click();
  await expect(page.locator("article.card.card--quiet .card-run").first()).toHaveText("unattended");
});

test("a scheduled turn says so under its prompt", async ({ page }) => {
  await expect
    .poll(
      async () =>
        (await snap(page)).sessions.find((s) => s.title?.startsWith("Every 30 minutes") && s.counts.turns >= 2)?.id,
      { timeout: 40_000 },
    )
    .toBeTruthy();
  const s = (await snap(page)).sessions.find((x) => x.title?.startsWith("Every 30 minutes") && x.counts.turns >= 2)!;
  await openPage(page, `/s/${s.harness}/${s.id}`);
  await expect(page.locator(".prompt-via", { hasText: "Scheduled" })).toBeVisible();
});

test("goose's run over ACP: the reply from the ack, delivered over api", async ({ page }) => {
  await openPage(page, "/s/goose/01K8DEMO0ACP0GOOSE0000000");
  await expect(page.locator(".sess-where")).toHaveText("lab-mac · goose · /Users/demo/code/billing");
  await expect(page.getByText("Ran on lab-mac.")).toBeVisible();
  await expect(page.getByText("#412 is the oldest.")).toBeVisible();
});
