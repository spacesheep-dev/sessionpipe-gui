// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// One session: the timeline, the tier lens (in "⋯", and its line while it hides
// something), follow (in "⋯"), back, and Forget (in "⋯").
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { EVENTS, INFO, openBoard, sessionUrl, tier1Batch, ulid } from "./helpers.js";

/** Opens the first working card from the board and returns its href. */
async function openWorking(page: Page): Promise<string> {
  await openBoard(page);
  const link = page.locator("article.card--working a.card-link").first();
  await expect(link).toBeVisible({ timeout: 30_000 });
  const href = (await link.getAttribute("href"))!;
  // Cards re-sort live, so click the one whose href we read rather than "the first".
  await page.locator(`a.card-link[href="${href}"]`).click();
  await expect(page).toHaveURL(href);
  await expect(page.locator("h1.sess-title")).toBeVisible();
  return href;
}

const lens = (page: Page, tier: 0 | 1 | 2 | 3) =>
  page.locator(".lens fieldset.seg label.seg-opt").filter({ hasText: new RegExp(`^${tier}$`) });

/** The session bar's "⋯". */
const more = (page: Page) => page.locator(".sess-bar").getByRole("button", { name: "More actions" });

/** A long tier-1 session: `turns` prompts, each with two tools, sent in batches of 50. */
async function postLongSession(
  request: Parameters<typeof test>[1] extends never ? never : import("@playwright/test").APIRequestContext,
  turns: number,
) {
  const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
  const harness = "claude-code";
  const sessionId = randomUUID();
  const title = `E2E long ${sessionId.slice(0, 8)}`;
  let seq = 0;
  let clock = Date.now() - turns * 10_000 - 60_000;
  const ev = (type: string, data: Record<string, unknown>) => {
    clock += 1000;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 1,
      harness: { name: harness, version: "2.1.296" },
      session: { id: sessionId, seq: seq++, machine: "e2e-box", cwd: "~/code/e2e", title, title_source: "custom" },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const events = [ev("session.started", { source: "startup" })];
  for (let t = 1; t <= turns; t++) {
    const turnId = `t${t}`;
    events.push(ev("turn.started", { turn_id: turnId, prompt_chars: 40 + t }));
    for (const tool of ["Read", "Edit"]) {
      const callId = `c${t}${tool}`;
      events.push(ev("tool.started", { tool, call_id: callId, turn_id: turnId }));
      events.push(ev("tool.ended", { tool, call_id: callId, turn_id: turnId, ms: 120, ok: true }));
    }
    events.push(ev("turn.ended", { turn_id: turnId, reason: "stop", ms: 5000 }));
  }
  for (let i = 0; i < events.length; i += 50) {
    const res = await request.post(EVENTS, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sinkToken}`,
        "sessionpipe-protocol": "1",
      },
      data: { events: events.slice(i, i + 50) },
    });
    expect(res.status()).toBe(202);
  }
  return { harness, sessionId, title, total: events.length, turns };
}

const scrollState = (page: Page) =>
  page.evaluate(() => ({
    top: window.scrollY,
    max: document.documentElement.scrollHeight - window.innerHeight,
  }));

test.describe("session page", () => {
  test("opens at the latest turn in one page, and older turns load above without moving the view", async ({
    page,
    request,
  }) => {
    const long = await postLongSession(request, 60); // 361 events, well over the 100-event first page
    const [detail] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/api/ui/sessions/${long.harness}/${long.sessionId}?`)),
      page.goto(sessionUrl(long.harness, long.sessionId)),
    ]);
    // One slim tail page, not the whole session.
    expect(detail.url()).toMatch(/tail=1/);
    expect(detail.url()).toMatch(/slim=1/);
    const body = (await detail.json()) as { events: unknown[]; total: number; hasOlder: boolean };
    expect(body.events.length).toBeLessThanOrEqual(100);
    expect(body.total).toBe(long.total);
    expect(body.hasOlder).toBe(true);
    await expect(page.locator("h1.sess-title")).toHaveText(long.title);
    // The bar's meta is where it runs; the count is its tooltip's (and a data attribute).
    await expect(page.locator(".sess-where")).toHaveAttribute("data-events", String(long.total));

    // The last turn is on screen and the page sits at the bottom. Its end is the head's
    // duration, not a row of its own.
    const lastTurn = page.locator("ol.timeline li.turn").last();
    await expect(lastTurn.locator(".turn-n")).toHaveText(`Turn ${long.turns}`);
    await expect(lastTurn.locator("li.tool").last()).toBeInViewport();
    await expect(lastTurn.locator(".marker--end")).toHaveCount(0);
    await expect(lastTurn.locator(".turn-dur")).toHaveText("5 s");
    const s1 = await scrollState(page);
    expect(s1.max).toBeGreaterThan(200);
    expect(s1.top, "scrollTop near its maximum").toBeGreaterThanOrEqual(s1.max - 4);
    expect(await page.locator("ol.timeline li.turn").count()).toBeLessThan(long.turns);

    // "Older turns" is at the top; loading keeps what was on screen where it was.
    const older = page.locator("li.older button");
    await expect(older).toHaveText(/^Older turns · \d+ earlier events$/);
    // The button sits at the top, so that is where one is when loading. The first whole
    // turn on screen (its number never changes) must stay where it was.
    await page.evaluate(() => window.scrollTo(0, 0));
    const anchorTurn = page.locator("ol.timeline li.turn").nth(1);
    const anchorLabel = (await anchorTurn.locator(".turn-n").textContent())!;
    expect(anchorLabel).toMatch(/^Turn \d+$/);
    const yBefore = (await anchorTurn.locator(".turn-head").boundingBox())!.y;
    const turnsBefore = await page.locator("ol.timeline li.turn").count();
    await older.click();
    await expect(page.locator("ol.timeline li.turn")).not.toHaveCount(turnsBefore);
    const sameTurn = page
      .locator("ol.timeline li.turn")
      .filter({ has: page.locator(".turn-n", { hasText: new RegExp(`^${anchorLabel}$`) }) });
    const yAfter = (await sameTurn.locator(".turn-head").boundingBox())!.y;
    expect(Math.abs(yAfter - yBefore), "the anchored turn did not move").toBeLessThanOrEqual(2);
    await expect(page.locator(".sess-where")).toHaveAttribute("data-events", String(long.total));
  });

  test("shows the timeline with turns and tool rows; the tier lens hides and reveals", async ({ page }) => {
    await openWorking(page);
    await expect(page.locator("ol.timeline li.turn").first()).toBeVisible();
    await expect(page.locator("li.tool").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".sess-where")).toHaveAttribute("data-events", /^[1-9]\d*$/);
    // Everything (the default): no lens line over the timeline; tool rows expand to input
    // and output.
    await expect(page.locator(".sess-lens")).toHaveCount(0);
    const expandable = page.locator("li.tool.tool--x details");
    await expect(expandable.first()).toBeVisible();
    const first = expandable.first();
    await first.locator("summary").click();
    await expect(first).toHaveAttribute("open", "");
    await expect(first.locator(".tool-io .tool-io-label").first()).toHaveText(/^(Input|Output|Error)$/);
    await expect(first.locator(".tool-io pre").first()).toBeVisible();

    // Lens 0 from "⋯": presence only, no tool rows; its line says how many were hidden.
    await more(page).click();
    await page.getByRole("menuitem", { name: "Tier lens" }).click();
    await page.getByRole("menuitemradio", { name: /^0 · Presence/ }).click();
    await expect(lens(page, 0)).toHaveClass(/seg-on/);
    await expect(page.locator("li.tool")).toHaveCount(0);
    await expect(page.locator(".lens-hint")).toHaveText(/Presence · \d+ hidden/);
    await expect(page.locator("ol.timeline li.turn").first()).toBeVisible();

    // Lens 1: tool names come back, but without input/output to expand.
    await lens(page, 1).click();
    await expect(page.locator("li.tool").first()).toBeVisible();
    await expect(page.locator(".lens-hint")).toHaveText(/^Actions/);
    const expandableAt1 = await page.locator("li.tool.tool--x").count();
    const errorsAt1 = await page.locator("li.tool .tool-err").count();
    expect(expandableAt1, "at tier 1 only a failed tool has something to open (its error)").toBeLessThanOrEqual(
      errorsAt1,
    );
    // Whatever opens at tier 1 holds the error alone: no input, no output.
    await expect(page.locator("li.tool .tool-io-label", { hasNotText: /^Error$/ })).toHaveCount(0);
    // Show all puts the lens back to everything, and its line goes.
    await page.locator(".sess-lens").getByRole("button", { name: "Show all" }).click();
    await expect(page.locator(".sess-lens")).toHaveCount(0);
  });

  test("follow toggles from the menu and back returns to the board", async ({ page, request }) => {
    // A turn of the suite's own that stays open: Follow is for live sessions only, and the
    // demo's working ones can end between the menu's three openings.
    const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
    const b = tier1Batch({ title: `E2E follow ${randomUUID().slice(0, 8)}` });
    const res = await request.post(EVENTS, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sinkToken}`,
        "sessionpipe-protocol": "1",
      },
      data: { events: b.events.slice(0, 2) },
    });
    expect(res.status()).toBe(202);
    await openBoard(page);
    const href = sessionUrl(b.harness, b.sessionId);
    await page.locator(`a.card-link[href="${href}"]`).click();
    await expect(page).toHaveURL(href);
    await more(page).click();
    const follow = page.getByRole("menuitemcheckbox", { name: /Follow the live turn/ });
    await expect(follow).toHaveAttribute("aria-checked", "true");
    await follow.click();
    await more(page).click();
    await expect(follow).toHaveAttribute("aria-checked", "false");
    await follow.click();
    await more(page).click();
    await expect(follow).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("section.group").first()).toBeVisible();
  });

  test("Forget asks first, then POSTs and removes the session from the board", async ({ page, request }) => {
    await openBoard(page);
    // A done session (the demo's backfill) is quiet, so once forgotten it stays gone.
    const toggle = page.locator("section.group--done button.group-toggle");
    await toggle.click();
    const first = page.locator("section.group--done article.card--done a.card-link").first();
    await expect(first).toBeVisible();
    const href = (await first.getAttribute("href"))!;
    const [, harness, id] = /^\/s\/([^/]+)\/(.+)$/.exec(href)!.map(decodeURIComponent) as [string, string, string];
    // The done list re-sorts as sessions end, so click the card by its href, not its position.
    await page.locator(`a.card-link[href="${href}"]`).click();
    await expect(page).toHaveURL(href);

    // Forget is the last item of "⋯", on its own, and it asks first.
    await more(page).click();
    await page.getByRole("menuitem", { name: "Forget…" }).click();
    const dialog = page.getByRole("alertdialog", { name: /^Forget “.+”\?$/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("It leaves the board and the feed here.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(href);

    await more(page).click();
    await page.getByRole("menuitem", { name: "Forget…" }).click();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/forget")),
      page.getByRole("alertdialog").getByRole("button", { name: "Forget" }).click(),
    ]);
    expect(res.status()).toBe(204);
    expect(decodeURIComponent(res.url())).toContain(`/api/ui/sessions/${harness}/${id}/forget`);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(`a.card-link[href="${href}"]`)).toHaveCount(0);
    await page.locator("section.group--done button.group-toggle").click();
    await expect(page.locator(`a.card-link[href="${href}"]`)).toHaveCount(0);
    const gone = await request.get(`/api/ui/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(id)}`);
    expect(gone.status()).toBe(404);
  });
});
