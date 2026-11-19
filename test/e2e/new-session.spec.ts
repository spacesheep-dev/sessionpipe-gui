// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// New session (STEER-SPEC B): the compose sheet from every way in (`c`, the palette, a
// session's "New session here", a machine's menu, `?new=1`), the rows a machine's hello
// advertises and the one line an older machine gets instead, a typed folder outside the
// allowed ones, and Start: the signed CONTROL.md §6 `start` carries only what was
// advertised, the page goes straight to the new session in its starting state, follows
// the acks, and turns live at the first hook event on the same surface (one title, the
// person's bubble kept, no remount); an offline machine queues; a refusal says why in
// place, offers Safe where the machine does, and "Edit and start again" brings the draft
// back. Against the second
// e2e instance (test door on, rp id localhost) through fake daemons (control-helpers.ts).
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  CONTROL_BASE,
  type FakeDaemon,
  fakeDaemon,
  HEIC,
  type PageKey,
  passkeyPage,
  postSession,
  seenSetupHere,
  sinkToken,
} from "./control-helpers.js";

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "desktop project; the phone's sheet is in mobile.spec.ts");

const tag = () => randomUUID().slice(0, 6);
const sheet = (page: Page) => page.locator("[data-new-session]");
const rowValue = (page: Page, row: string) => sheet(page).locator(`[data-ns-row=${row}] button.sel`);
const status = (page: Page) => sheet(page).locator(".ns-status");
async function pick(page: Page, row: string, label: string) {
  await rowValue(page, row).click();
  await page.locator(".sel-opt", { hasText: label }).first().click();
}

/** studio-mac on sessionpipe 0.10: every option; build-box: an old daemon (no start, no files). */
const advertising = (name: string) => ({
  name,
  harnesses: ["claude-code", "codex"],
  folders: ["/Users/e2e/code"],
  mode: "auto" as const,
  files: true,
  start: {
    "claude-code": { permissions: ["read", "safe", "edits", "auto"], permission: "auto", any_model: true },
    codex: { permissions: ["read", "safe", "auto"], permission: "auto", models: ["gpt-6-astra"] },
  },
});
const old = (name: string) => ({
  name,
  harnesses: ["claude-code"],
  folders: ["/srv/projects"],
  mode: "safe" as const,
  version: "0.9.0",
});

/** Whether the receiver offers a machine `~/…` folders (its core and the machine both take one). */
async function tildeOn(machine: string): Promise<boolean> {
  const snap = (await (await fetch(`${CONTROL_BASE}/api/ui/snapshot`)).json()) as {
    machines: { name: string; control?: { tilde?: boolean } }[];
  };
  return !!snap.machines.find((x) => x.name === machine)?.control?.tilde;
}

let key: PageKey;
let sink: string;
const daemons: FakeDaemon[] = [];
test.afterAll(async () => {
  await Promise.all(daemons.map((d) => d.stop()));
});

test.beforeEach(async ({ context, page }) => {
  await seenSetupHere(context);
  key = await passkeyPage(context, page);
  sink ??= await sinkToken();
});

test("c opens the sheet for the board's context, and so does the palette", async ({ page }) => {
  const m = await fakeDaemon(key, advertising(`ns-c-${tag()}`), { sinkToken: sink });
  daemons.push(m);
  await page.goto(`${CONTROL_BASE}/`);
  await expect(page.locator(".conn").first()).toHaveText("live");
  await page.keyboard.press("c");
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole("heading", { name: "New session" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("new session");
  await page.locator(".pal-row, [role=option]", { hasText: "New session…" }).first().click();
  await expect(sheet(page)).toBeVisible();
  // The compose glyph in the sidebar header too.
  await page.keyboard.press("Escape");
  await page.locator("nav.rail [data-compose]").click();
  await expect(sheet(page)).toBeVisible();
});

test("right-click a session: New session here, prefilled; a machine's menu: New session on it", async ({ page }) => {
  const name = `ns-here-${tag()}`;
  const m = await fakeDaemon(key, advertising(name), { sinkToken: sink });
  daemons.push(m);
  await postSession(sink, { machine: name, harness: "codex", cwd: "~/code/billing", title: `Billing ${name}` });
  await page.goto(`${CONTROL_BASE}/`);
  const card = page.locator("article.card", { hasText: `Billing ${name}` });
  await card.locator(".card-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: "New session here" }).click();
  await expect(rowValue(page, "machine")).toHaveAttribute("data-value", name);
  await expect(rowValue(page, "agent")).toHaveAttribute("data-value", "codex");
  // sessionpipe 0.10's hello names no home folder: the session's own `~/…` folder is what
  // the sheet carries (CONTROL.md §3.1), and it can be sent where both this receiver's core
  // and the machine take one (`MachineControl.tilde`); elsewhere it asks for the full path.
  await expect(rowValue(page, "folder")).toHaveAttribute("data-value", "~/code/billing");
  await expect(rowValue(page, "folder")).toContainText("~/code/billing");
  if (!(await tildeOn(name)))
    await expect(status(page)).toHaveText(`${name} needs the full path; type it starting with /`);
  await page.keyboard.press("Escape");

  await page.goto(`${CONTROL_BASE}/machines`);
  await page.locator(`section.machine[aria-label="${name}"] .machine-head`).click({ button: "right" });
  await page.getByRole("menuitem", { name: `New session on ${name}…` }).click();
  await expect(rowValue(page, "machine")).toHaveAttribute("data-value", name);
});

test("the advertised rows on a 0.10 machine; one line, and no rows, on an old one", async ({ page }) => {
  const a = await fakeDaemon(key, advertising(`ns-adv-${tag()}`), { sinkToken: sink });
  const b = await fakeDaemon(key, old(`ns-old-${tag()}`), { sinkToken: sink });
  daemons.push(a, b);
  await page.goto(`${CONTROL_BASE}/?new=1&machine=${a.name}`);
  await expect(rowValue(page, "machine")).toHaveAttribute("data-value", a.name);
  await expect(sheet(page).locator("[data-ns-row=permission]")).toBeVisible();
  await expect(sheet(page).locator("[data-ns-row=model]")).toBeVisible();
  await expect(sheet(page).getByRole("button", { name: "Add files" })).toBeVisible();
  await rowValue(page, "permission").click();
  await expect(page.locator(".sel-opt")).toHaveText([/Read only/, /Safe/, /Accept edits/, /Auto/]);
  await page.keyboard.press("Escape");

  // The machine picker says what each one offers.
  await rowValue(page, "machine").click();
  await expect(page.locator(".sel-opt", { hasText: a.name })).toContainText("auto");
  await expect(page.locator(".sel-opt", { hasText: b.name })).toContainText("0.9 · no model choice");
  await page.keyboard.press("Escape");

  await pick(page, "machine", b.name);
  await expect(sheet(page).locator("[data-ns-row=permission]")).toHaveCount(0);
  await expect(sheet(page).locator("[data-ns-row=model]")).toHaveCount(0);
  await expect(sheet(page).getByRole("button", { name: "Add files" })).toHaveCount(0);
  // The row stays, so the sheet keeps its height: the machine sets the level, in the
  // pop-up's word, and says so to a pointer.
  await expect(sheet(page).locator("[data-ns-row=options]")).toHaveText(/^Permission\s*Safe$/);
  await expect(sheet(page).locator("[data-ns-row=options] .ns-fixed")).toHaveAttribute("title", `Set on ${b.name}`);
  await sheet(page).locator("[data-ns-text]").fill("Look around.");
  // The status line is for what is happening; the passkey is Start's own note.
  await expect(status(page)).toHaveText(`${b.name} is listening.`);
});

test("a typed folder outside the allowed ones disables Start, with the reason", async ({ page }) => {
  const m = await fakeDaemon(key, advertising(`ns-dir-${tag()}`), { sinkToken: sink });
  daemons.push(m);
  await page.goto(`${CONTROL_BASE}/?new=1&machine=${m.name}`);
  await sheet(page).locator("[data-ns-text]").fill("Anything");
  await rowValue(page, "folder").click();
  await page.keyboard.type("/Users/e2e/codex");
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText(`${m.name} doesn't allow that folder`);
  await expect(sheet(page).locator("[data-ns-start]")).toBeDisabled();
  await rowValue(page, "folder").click();
  await page.keyboard.type("/Users/e2e/code/web");
  await page.keyboard.press("Enter");
  await expect(rowValue(page, "folder")).toHaveAttribute("data-value", "/Users/e2e/code/web");
  await expect(sheet(page).locator("[data-ns-start]")).toBeEnabled();
  await rowValue(page, "folder").click();
  await page.keyboard.type("~/code/web");
  await page.keyboard.press("Enter");
  await expect(rowValue(page, "folder")).toHaveAttribute("data-value", "~/code/web");
  if (await tildeOn(m.name)) await expect(sheet(page).locator("[data-ns-start]")).toBeEnabled();
  else await expect(sheet(page).locator("[data-ns-start]")).toBeDisabled();
});

test("Start: the starting state, then taken, then live; only advertised options are signed", async ({ page }) => {
  const m = await fakeDaemon(key, advertising(`ns-go-${tag()}`), {
    sinkToken: sink,
    script: (c) => ({
      pauseMs: 1500,
      events: true,
      acks: [
        { outcome: "taken", mode: "sdk", applied: { permission: c.permission ?? "auto", model: c.model } },
        {
          outcome: "delivered",
          mode: "sdk",
          session: c.session,
          applied: { permission: c.permission ?? "auto", model: c.model },
        },
      ],
    }),
  });
  daemons.push(m);
  await page.goto(`${CONTROL_BASE}/?new=1&machine=${m.name}&cwd=/Users/e2e/code/billing`);
  await pick(page, "permission", "Accept edits");
  await rowValue(page, "model").click();
  await page.keyboard.type("sonnet");
  await page.keyboard.press("Enter");
  await sheet(page).locator("[data-ns-text]").fill("Fix the rounding in refunds.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page).toHaveURL(/\/s\/claude-code\/[0-9a-f-]{36}$/);
  await expect(page.locator(".starting")).toBeVisible();
  await expect(page.locator(".starting .chat-bubble")).toHaveText("Fix the rounding in refunds.");
  await expect(page.locator("h1.sess-title")).toHaveText("Fix the rounding in refunds.");
  // Mark the surface: the live session must be this same element, not a remount.
  await page.locator(".page.session").evaluate((el) => {
    el.setAttribute("data-e2e-surface", "1");
  });
  await expect(page.locator(".starting[data-starting=taken]")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".starting .starting-state")).toHaveText(/^Starting claude on .+…$/);
  await expect(page.locator(".sess-bar")).toContainText("Accept edits · sonnet");
  // The first hook event: the ordinary live page, on the same surface, the same title and
  // the person's bubble kept; the start is in the timeline, not under the composer.
  await expect(page.locator(".page.session:not(.starting)")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".page.session")).toHaveAttribute("data-e2e-surface", "1");
  await expect(page.locator("h1.sess-title")).toHaveText("Fix the rounding in refunds.");
  await expect(page.locator("[data-start-message]")).toHaveText("Fix the rounding in refunds.");
  await expect(page.locator(".sess-ctl")).toBeVisible();
  await expect(page.locator(".ctl-act")).toHaveCount(0);
  const cmd = m.seen.find((c) => c.kind === "start")!;
  expect(cmd).toMatchObject({ cwd: "/Users/e2e/code/billing", permission: "edits", model: "sonnet" });
});

test("an old machine is sent no options at all", async ({ page }) => {
  const m = await fakeDaemon(key, old(`ns-plain-${tag()}`), { sinkToken: sink });
  daemons.push(m);
  await page.goto(`${CONTROL_BASE}/?new=1&machine=${m.name}`);
  await sheet(page).locator("[data-ns-text]").fill("Just look.");
  await sheet(page).locator("[data-ns-start]").click();
  await expect(page).toHaveURL(/\/s\/claude-code\//);
  await expect.poll(() => m.seen.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(Object.keys(m.seen[0]!).sort()).toEqual([
    "cwd",
    "iat",
    "kind",
    "machine",
    "nonce",
    "session",
    "t",
    "text",
    "v",
  ]);
});

test("an offline machine can be chosen; the start waits for it", async ({ page }) => {
  const m = await fakeDaemon(key, old(`ns-off-${tag()}`), { offline: true });
  daemons.push(m);
  await page.goto(`${CONTROL_BASE}/?new=1&machine=${m.name}`);
  await rowValue(page, "machine").click();
  await expect(page.locator(".sel-opt", { hasText: m.name })).toContainText("offline");
  await page.keyboard.press("Escape");
  await sheet(page).locator("[data-ns-text]").fill("When you are back.");
  await sheet(page).locator("[data-ns-start]").click();
  await expect(page.locator(".starting .starting-state")).toHaveText(
    `Waiting for ${m.name}. It starts when the machine is back.`,
  );
});

test("a refused permission says why, and Edit and start again restores the draft", async ({ page }) => {
  const m = await fakeDaemon(key, advertising(`ns-no-${tag()}`), {
    sinkToken: sink,
    script: () => ({
      acks: [{ outcome: "refused", code: "permission", detail: "this machine runs in safe mode" }],
    }),
  });
  daemons.push(m);
  await page.goto(`${CONTROL_BASE}/?new=1&machine=${m.name}`);
  await sheet(page).locator("[data-ns-text]").fill("Upgrade the date library.");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.locator(".starting-failed")).toContainText(
    `${m.name} won't start this: this machine runs in safe mode`,
    {
      timeout: 15_000,
    },
  );
  // A policy answer, not a crash: neutral words after one small ✕, and the honest way on.
  await expect(page.locator(".starting-failed .sent-x")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start in Safe instead" })).toBeVisible();
  await page.getByRole("button", { name: "Edit and start again" }).click();
  await expect(sheet(page).locator("[data-ns-text]")).toHaveValue("Upgrade the date library.");
  await expect(rowValue(page, "machine")).toHaveAttribute("data-value", m.name);
  await expect(rowValue(page, "permission")).toHaveAttribute("data-value", "auto");
});

test("?new=1 with machine, harness and cwd opens prefilled, and leaves the address", async ({ page }) => {
  const m = await fakeDaemon(key, advertising(`ns-url-${tag()}`), { sinkToken: sink });
  daemons.push(m);
  await page.goto(`${CONTROL_BASE}/feed?new=1&machine=${m.name}&harness=codex&cwd=/Users/e2e/code/api`);
  await expect(rowValue(page, "machine")).toHaveAttribute("data-value", m.name);
  await expect(rowValue(page, "agent")).toHaveAttribute("data-value", "codex");
  await expect(rowValue(page, "folder")).toHaveAttribute("data-value", "/Users/e2e/code/api");
  await expect(page).toHaveURL(`${CONTROL_BASE}/feed`);
  // Esc keeps the draft; the next open has it back.
  await sheet(page).locator("[data-ns-text]").fill("Keep me.");
  await page.keyboard.press("Escape");
  await page.keyboard.press("c");
  await expect(sheet(page).locator("[data-ns-text]")).toHaveValue("Keep me.");
});

test("files on a new session: a big photo is made smaller first, a HEIC this browser can't draw stays a file with a note, others go as they are", async ({
  page,
}) => {
  const m = await fakeDaemon(key, advertising(`ns-files-${tag()}`), { sinkToken: sink });
  daemons.push(m);
  await page.goto(`${CONTROL_BASE}/?new=1&machine=${m.name}&cwd=/Users/e2e/code/billing`);
  await expect(sheet(page).locator("input[data-ns-files]")).toBeAttached();
  // A 13.5 MB photo the page draws itself (padded with zeros after its end), a HEIC and a text file.
  await page.evaluate(async (heic) => {
    const cv = new OffscreenCanvas(4032, 3024);
    const cx = cv.getContext("2d")!;
    const g = cx.createLinearGradient(0, 0, 4032, 3024);
    g.addColorStop(0, "#2f6f4e");
    g.addColorStop(1, "#d9c27a");
    cx.fillStyle = g;
    cx.fillRect(0, 0, 4032, 3024);
    const drawn = await cv.convertToBlob({ type: "image/jpeg", quality: 0.92 });
    const dt = new DataTransfer();
    dt.items.add(new File([drawn, new Uint8Array(13_500_000 - drawn.size)], "IMG_0412.jpg", { type: "image/jpeg" }));
    dt.items.add(
      new File([Uint8Array.from(atob(heic), (c) => c.charCodeAt(0))], "IMG_0413.heic", { type: "image/heic" }),
    );
    dt.items.add(new File(["the date picker is off by one\n"], "notes.txt", { type: "text/plain" }));
    const input = document.querySelector<HTMLInputElement>("input[data-ns-files]")!;
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, HEIC.toString("base64"));
  const chips = sheet(page).locator(".ns-file");
  await expect(chips).toHaveCount(3);
  for (const i of [0, 1, 2]) await expect(chips.nth(i)).toHaveAttribute("data-file-state", "held", { timeout: 30_000 });
  await expect(chips.nth(0).locator(".ns-file-name")).toHaveText("IMG_0412.webp");
  await expect(chips.nth(0)).toHaveAttribute("title", /^IMG_0412\.webp · [\d.]+ (KB|MB) \(was 12\.9 MB\)$/);
  await expect(chips.nth(1).locator(".ns-file-name")).toHaveText("IMG_0413.heic");
  await expect(sheet(page).locator("[data-ns-files-note]")).toHaveText(
    "The agent can't look at HEIC. Export it as JPEG to send it as a picture.",
  );
  await expect(chips.nth(2).locator(".ns-file-name")).toHaveText("notes.txt");

  await sheet(page).locator("[data-ns-text]").fill("What is in these?");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page).toHaveURL(/\/s\/claude-code\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  await expect.poll(() => m.seen.filter((c) => c.kind === "start").length, { timeout: 15_000 }).toBe(1);
  const files = m.seen.find((c) => c.kind === "start")!.files as { name: string; type: string; size: number }[];
  expect(files.map((f) => [f.name, f.type])).toEqual([
    ["IMG_0412.webp", "image/webp"],
    ["IMG_0413.heic", "image/heic"],
    ["notes.txt", "text/plain"],
  ]);
  expect(files[0]!.size).toBeLessThanOrEqual(3 * 1024 * 1024);
  expect(files[1]!.size).toBe(HEIC.length);
});
