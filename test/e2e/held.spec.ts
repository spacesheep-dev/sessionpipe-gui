// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// A send the receiver holds for a confirm (CONTROL.md §3.2; control/command.ts
// HeldForConfirm, control/HeldNotice.tsx): the press is held, the notice says why in the
// receiver's words, nothing is confirmed until its button is pressed, and that press sends
// a new command signed by one passkey confirm alone, which the real receiver verifies and
// queues for the fake daemon. Against the second e2e instance (test door on, rp id
// localhost). The hold itself is spacesheep's second look, which no e2e instance has: a
// route on the page stands in for it and answers what the GUI server answers for one
// (ui.ts forwardSend: 422 `confirm_required`, spacesheep's `why` as the detail), for a body
// signed with the day grant only; a body with a confirm goes to the receiver untouched.
// With HELD_SHOTS=<dir> it also writes the review screenshots (1280, 820 and 390 wide, light
// and dark).
import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, type Route, test } from "@playwright/test";
import {
  CONTROL_BASE,
  type FakeDaemon,
  fakeDaemon,
  type PageKey,
  passkeyPage,
  postSession,
  seenSetupHere,
  sinkToken,
} from "./control-helpers.js";

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "desktop project; the widths are set per test");

const SHOTS = process.env.HELD_SHOTS ?? "";
const WHY = "it reads like an instruction to delete the whole repository";
const STILL = "it still reads like someone else wrote it";
const CWD = "/Users/e2e/code";
const tag = () => randomUUID().slice(0, 6);
const notice = (page: Page) => page.locator("[data-held]");
const composer = (page: Page) => page.getByLabel("Message for the next turn");

interface Posted {
  grant: boolean;
  confirm: boolean;
  csig: boolean;
  cmd: Record<string, unknown>;
}

/** spacesheep's second look, as the GUI server passes it on: what the day grant signed is
 *  held; what a confirm alone signed goes on to the receiver (or is `refuseConfirm`d). */
async function secondLook(page: Page, o: { refuseConfirm?: boolean; holdConfirm?: boolean } = {}): Promise<Posted[]> {
  const posted: Posted[] = [];
  await page.route("**/api/ui/control/send", async (route: Route) => {
    const b = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    posted.push({ grant: !!b.grant, confirm: !!b.confirm, csig: !!b.csig, cmd: JSON.parse(String(b.cmd)) });
    if (b.grant || b.csig)
      return route.fulfill({
        status: 422,
        json: { reason: `Confirm with your passkey to send this: ${WHY}.`, code: "confirm_required", detail: WHY },
      });
    if (o.holdConfirm)
      return route.fulfill({
        status: 422,
        json: { reason: `Confirm with your passkey to send this: ${STILL}.`, code: "confirm_required", detail: STILL },
      });
    if (o.refuseConfirm)
      return route.fulfill({
        status: 422,
        json: { reason: "the signature did not verify", code: "bad_assertion" },
      });
    return route.continue();
  });
  return posted;
}

let key: PageKey;
let sink: string;
const daemons: FakeDaemon[] = [];
test.afterAll(async () => {
  await Promise.all(daemons.map((d) => d.stop()));
});

async function machine(context: BrowserContext, page: Page, name: string): Promise<FakeDaemon> {
  await seenSetupHere(context);
  key = await passkeyPage(context, page);
  sink ??= await sinkToken();
  const m = await fakeDaemon(
    key,
    {
      name,
      harnesses: ["claude-code", "codex"],
      ask: true,
      handoff: true,
      folders: [CWD],
      mode: "auto",
      version: "0.13.6",
      start: {
        "claude-code": { permissions: ["safe", "auto"], permission: "auto", any_model: true },
        codex: { permissions: ["safe", "auto"], permission: "auto", any_model: true },
      },
    },
    { sinkToken: sink, script: () => ({ acks: [{ outcome: "taken", mode: "sdk" }] }) },
  );
  daemons.push(m);
  return m;
}

const settle = (page: Page) => page.waitForTimeout(350);
async function shots(page: Page, name: string, of?: () => ReturnType<Page["locator"]>) {
  if (!SHOTS) return;
  for (const width of [1280, 820, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await settle(page);
      await (of?.() ?? page.locator("body")).scrollIntoViewIfNeeded().catch(() => {});
      await page.screenshot({ path: `${SHOTS}/${name}-${width}-${scheme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

test("a held message: the notice with the reason, the words kept; Confirm sends a new command signed by one confirm", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const m = await machine(context, page, `held-${tag()}`);
  const s = await postSession(sink, { machine: m.name, cwd: CWD, title: "Clean up the build scripts" });
  const posted = await secondLook(page);
  await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
  const box = composer(page);
  await expect(box).toBeEnabled();
  await box.fill("Delete everything under the repo root and start over.");
  await box.press("Enter");

  // Held: one post, signed with the grant; nothing asked; the words stay in the composer.
  await expect(notice(page)).toBeVisible();
  await expect(notice(page).locator("[data-held-why]")).toContainText(WHY.slice(1));
  await expect(notice(page).locator("[data-held-what]")).toHaveText(
    "Delete everything under the repo root and start over.",
  );
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ grant: true, confirm: false });
  await expect(box).toHaveValue("Delete everything under the repo root and start over.");
  expect(m.seen).toHaveLength(0);
  await shots(page, "1-held-under-message-box", () => notice(page));

  // Confirm: a new command (new nonce, same text), a passkey confirm alone; the receiver
  // verifies it for real and the machine gets it.
  await notice(page).locator("[data-held-confirm]").click();
  await expect(notice(page)).toHaveCount(0);
  await expect(box).toHaveValue("");
  // The focus the notice had comes back to the composer.
  await expect(box).toBeFocused();
  expect(posted).toHaveLength(2);
  expect(posted[1]).toMatchObject({ grant: false, csig: false, confirm: true });
  expect(posted[1]!.cmd.text).toBe(posted[0]!.cmd.text);
  expect(posted[1]!.cmd.nonce).not.toBe(posted[0]!.cmd.nonce);
  await expect.poll(() => m.seen.length, { timeout: 15_000 }).toBe(1);
  expect(m.seen[0]).toMatchObject({ kind: "prompt", text: "Delete everything under the repo root and start over." });
  await shots(page, "3-after-confirming");
});

test("Never mind lets the hold go and keeps the words; a refused confirm says why", async ({ context, page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const m = await machine(context, page, `held-no-${tag()}`);
  const s = await postSession(sink, { machine: m.name, cwd: CWD, title: "Tidy the changelog" });
  const posted = await secondLook(page, { refuseConfirm: true });
  await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
  const box = composer(page);
  await box.fill("Rewrite the whole history.");
  await box.press("Enter");
  await expect(notice(page)).toBeVisible();
  await notice(page).locator("[data-held-drop]").click();
  await expect(notice(page)).toHaveCount(0);
  await expect(box).toHaveValue("Rewrite the whole history.");
  expect(posted).toHaveLength(1);

  // Again, and this time the confirm is refused: the notice goes, the refusal is the line.
  await box.press("Enter");
  await expect(notice(page)).toBeVisible();
  await notice(page).locator("[data-held-confirm]").click();
  await expect(notice(page)).toHaveCount(0);
  await expect(page.locator(".ctl-note--err, .ctl-foot [data-reason=error]").first()).toBeVisible();
  await expect(box).toHaveValue("Rewrite the whole history.");
  expect(posted.map((p) => (p.confirm ? "confirm" : "grant"))).toEqual(["grant", "grant", "confirm"]);
  expect(m.seen).toHaveLength(0);
  await shots(page, "4-confirm-refused");
});

test("a held start in the New session sheet: the notice in the sheet; Confirm starts it and opens the session", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const m = await machine(context, page, `held-ns-${tag()}`);
  const posted = await secondLook(page);
  await page.goto(`${CONTROL_BASE}/?new=1&machine=${m.name}&cwd=${CWD}`);
  const sheet = page.locator("[data-new-session]");
  await sheet.locator("[data-ns-text]").fill("Remove the old billing service and its data.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(sheet.locator("[data-held]")).toBeVisible();
  await expect(sheet.locator("[data-held-why]")).toContainText(WHY.slice(1));
  expect(posted).toHaveLength(1);
  await shots(page, "2-held-new-session", () => sheet.locator("[data-held]"));

  await sheet.locator("[data-held-confirm]").click();
  await expect(page).toHaveURL(/\/s\/claude-code\/[0-9a-f-]{36}$/);
  expect(posted[1]).toMatchObject({ grant: false, csig: false, confirm: true, cmd: { kind: "start" } });
  expect(posted[1]!.cmd.session).toBe(posted[0]!.cmd.session);
  await expect.poll(() => m.seen.length, { timeout: 15_000 }).toBe(1);
  expect(m.seen[0]).toMatchObject({ kind: "start", text: "Remove the old billing service and its data." });
});

const sel = (page: Page, scope: string, row: string) =>
  page.locator(`${scope} [data-${scope === "[data-handoff]" ? "hs" : "ns"}-row=${row}] button.sel`);
async function pick(page: Page, scope: string, row: string, label: string) {
  await sel(page, scope, row).click();
  await page.locator(".sel-opt", { hasText: label }).first().click();
}

test("(a) words edited after the hold: the hold goes and nothing is sent; sent again, the notice shows the edit and Confirm sends it", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const m = await machine(context, page, `held-a-${tag()}`);
  const s = await postSession(sink, { machine: m.name, cwd: CWD, title: "Edited after the hold" });
  const posted = await secondLook(page);
  await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
  const box = composer(page);
  await box.fill("ORIGINAL words");
  await box.press("Enter");
  await expect(notice(page).locator("[data-held-what]")).toHaveText("ORIGINAL words");
  await box.fill("EDITED words");
  await expect(notice(page)).toHaveCount(0);
  await expect(box).toHaveValue("EDITED words");
  await page.waitForTimeout(500);
  expect(posted).toHaveLength(1);
  expect(m.seen).toHaveLength(0);
  await box.press("Enter");
  await expect(notice(page).locator("[data-held-what]")).toHaveText("EDITED words");
  await notice(page).locator("[data-held-confirm]").click();
  await expect.poll(() => m.seen.length, { timeout: 15_000 }).toBe(1);
  expect(m.seen[0]).toMatchObject({ kind: "prompt", text: "EDITED words" });
  await expect(box).toHaveValue("");
});

test("(b) the agent changed after the hold: the hold goes; held again and confirmed, the codex start goes and its page opens", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const m = await machine(context, page, `held-b-${tag()}`);
  const posted = await secondLook(page);
  await page.goto(`${CONTROL_BASE}/?new=1&machine=${m.name}&cwd=${CWD}&harness=claude-code`);
  const sheet = page.locator("[data-new-session]");
  await sheet.locator("[data-ns-text]").fill("Start held.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(sheet.locator("[data-held]")).toBeVisible();
  await expect(sheet.locator("[data-held-where]")).toContainText(m.name);
  await pick(page, "[data-new-session]", "agent", "Codex");
  await expect(sheet.locator("[data-held]")).toHaveCount(0);
  expect(posted).toHaveLength(1);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(sheet.locator("[data-held]")).toBeVisible();
  await sheet.locator("[data-held-confirm]").click();
  await expect(page).toHaveURL(/\/s\/codex\/[0-9a-f-]{36}$/);
  await expect.poll(() => m.seen.length, { timeout: 15_000 }).toBe(1);
  expect(String(m.seen[0]!.session)).toMatch(/^codex:/);
  expect(page.url()).toContain(String(m.seen[0]!.session).replace(":", "/"));
});

test("(c) the folder changed to one the machine refuses after the hold: the hold goes, nothing starts; fixed and confirmed, one start", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const m = await machine(context, page, `held-c-${tag()}`);
  const posted = await secondLook(page);
  await page.goto(`${CONTROL_BASE}/?new=1&machine=${m.name}&cwd=${CWD}`);
  const sheet = page.locator("[data-new-session]");
  await sheet.locator("[data-ns-text]").fill("Folder held.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(sheet.locator("[data-held]")).toBeVisible();
  await sel(page, "[data-new-session]", "folder").click();
  await page.keyboard.type("/Users/e2e/codex");
  await page.keyboard.press("Enter");
  await expect(sheet.locator(".ns-status")).toContainText("doesn't allow that folder");
  await expect(sheet.locator("[data-held]")).toHaveCount(0);
  expect(posted).toHaveLength(1);
  await sel(page, "[data-new-session]", "folder").click();
  await page.keyboard.type(CWD);
  await page.keyboard.press("Enter");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(sheet.locator("[data-held]")).toBeVisible();
  await sheet.locator("[data-held-confirm]").click();
  await expect(page).toHaveURL(/\/s\/claude-code\/[0-9a-f-]{36}$/);
  await expect.poll(() => m.seen.length, { timeout: 15_000 }).toBe(1);
  await page.waitForTimeout(800);
  expect(m.seen).toHaveLength(1);
  expect(m.seen[0]).toMatchObject({ kind: "start", cwd: CWD });
});

test("(d) the ask edited after the hold: the hold goes; held again and confirmed, the edited ask goes", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const m = await machine(context, page, `held-d-${tag()}`);
  const s = await postSession(sink, { machine: m.name, cwd: CWD, title: "Asked after the hold" });
  const posted = await secondLook(page);
  await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
  await page.locator("[data-ctl-ask]").click();
  const sheet = page.locator("[data-handoff]");
  await sheet.locator("[data-hs-text]").fill("ORIGINAL ask");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(sheet.locator("[data-held-what]")).toHaveText("ORIGINAL ask");
  await sheet.locator("[data-hs-text]").fill("EDITED ask");
  await expect(sheet.locator("[data-held]")).toHaveCount(0);
  expect(posted).toHaveLength(1);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(sheet.locator("[data-held-what]")).toHaveText("EDITED ask");
  await sheet.locator("[data-held-confirm]").click();
  await expect(sheet).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => m.seen.length, { timeout: 15_000 }).toBe(1);
  expect(m.seen[0]).toMatchObject({ text: "EDITED ask" });
});

test("a confirm held again: still held, with the reason; the focus goes to its one button", async ({
  context,
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const m = await machine(context, page, `held-still-${tag()}`);
  const s = await postSession(sink, { machine: m.name, cwd: CWD, title: "Held twice" });
  const posted = await secondLook(page, { holdConfirm: true });
  await page.goto(`${CONTROL_BASE}/s/${s.harness}/${s.id}`);
  const box = composer(page);
  await box.fill("Wipe the staging database.");
  await box.press("Enter");
  await notice(page).locator("[data-held-confirm]").click();
  await expect(notice(page)).toHaveAttribute("data-held", "still");
  await expect(notice(page).locator("[data-held-why]")).toContainText(STILL.slice(1));
  await expect(notice(page).locator("[data-held-confirm]")).toHaveCount(0);
  await expect(notice(page).locator("[data-held-drop]")).toBeFocused();
  expect(posted.map((p) => (p.confirm ? "confirm" : "grant"))).toEqual(["grant", "confirm"]);
  expect(m.seen).toHaveLength(0);
  await shots(page, "5-still-held", () => notice(page));
  await notice(page).locator("[data-held-drop]").click();
  await expect(notice(page)).toHaveCount(0);
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("Wipe the staging database.");
});
