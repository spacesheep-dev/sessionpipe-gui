// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Notification sounds: the Notifications section of the Settings dialog, where the inbox
// header's "Sounds" link goes. Test plays through the synthesiser (an AudioContext stub
// counts the oscillators it starts and records their shapes); the master switch, the
// volume and each kind's choice persist across a reload; an upload over 500 KB is refused,
// a small one shows its name with Remove, any kind can pick it, and it survives a reload
// through IndexedDB. The demo's own toasts would play too, so the counting tests start
// with the master switch off (Test plays regardless: that is what it is for).
import { expect, type Locator, type Page, test } from "@playwright/test";
import { openPage } from "./helpers.js";

declare global {
  interface Window {
    __audio: { started: number; types: string[]; buffers: number; allow: boolean };
  }
}

const KEY = "sessionpipe-gui.sounds";

const stubAudio = (page: Page, o: { quiet?: boolean } = {}) =>
  page.addInitScript(
    ({ quiet, key }) => {
      // Seeds a fresh device only: this script runs again on every reload, and the reload must
      // find what the test persisted.
      if (quiet && localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ on: false }));
      window.__audio = { started: 0, types: [], buffers: 0, allow: true };
      class Param {
        setValueAtTime() {
          return this;
        }
        linearRampToValueAtTime() {
          return this;
        }
        exponentialRampToValueAtTime() {
          return this;
        }
      }
      class Node {
        connect() {
          return this;
        }
      }
      class Osc extends Node {
        type = "sine";
        frequency = new Param();
        start() {
          window.__audio.started++;
          window.__audio.types.push(this.type);
        }
        stop() {}
      }
      class Gain extends Node {
        gain = new Param();
      }
      class Source extends Node {
        buffer = null;
        start() {
          window.__audio.buffers++;
        }
      }
      class Ctx {
        state = "running";
        currentTime = 0;
        destination = new Node();
        resume() {
          return Promise.resolve();
        }
        addEventListener() {}
        createOscillator() {
          return new Osc();
        }
        createGain() {
          return new Gain();
        }
        createBufferSource() {
          return new Source();
        }
        decodeAudioData() {
          return Promise.resolve({ duration: 0.1 });
        }
      }
      Object.defineProperty(window, "AudioContext", { value: Ctx, configurable: true });
    },
    { quiet: o.quiet ?? false, key: KEY },
  );

/** The section, opened the way a person reaches it: the inbox's bell, then "Sounds". */
const openSection = async (page: Page) => {
  await openPage(page, "/inbox");
  await page.locator(".inbox-head").getByRole("button", { name: "Notifications" }).click();
  await page.getByRole("link", { name: "Sounds" }).click();
  await expect(page).toHaveURL(/\/settings\?section=notifications$/);
  const section = page.locator(".ntf");
  await expect(section).toBeVisible();
  return section;
};
const reopen = async (page: Page) => {
  await openPage(page, "/settings?section=notifications");
  const section = page.locator(".ntf");
  await expect(section).toBeVisible();
  return section;
};

const row = (section: ReturnType<Page["locator"]>, kind: string) => section.locator(`.ntf-row[data-kind="${kind}"]`);
const stored = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), KEY);
/** The sound picks are the custom select (components/Select.tsx): the trigger holds its
 *  value in data-value; opening it lists the options by role, each with its data-value. */
const combo = (r: Locator) => r.getByRole("combobox");
const options = async (page: Page, r: Locator) => {
  await combo(r).click();
  return page.getByRole("listbox").getByRole("option");
};
const pick = async (page: Page, r: Locator, value: string) => {
  await (await options(page, r)).and(page.locator(`[data-value="${value}"]`)).click();
  await expect(combo(r)).toHaveAttribute("data-value", value);
};
const started = (page: Page) => page.evaluate(() => window.__audio.started);

test.describe("sounds", () => {
  test("Test plays through the synthesiser; the switch, the volume and each choice persist", async ({ page }) => {
    await stubAudio(page, { quiet: true });
    const section = await openSection(page);
    await expect(section.getByRole("switch", { name: "Notify me" })).toBeVisible();
    const master = section.getByRole("switch", { name: "Sounds" });
    await expect(master).toHaveAttribute("aria-checked", "false");
    // The four kinds, with their defaults.
    for (const [kind, sound] of [
      ["needsYou", "chime"],
      ["question", "blip"],
      ["error", "thud"],
      ["done", "tick"],
    ])
      await expect(row(section, kind!).getByRole("combobox")).toHaveAttribute("data-value", sound!);

    await row(section, "needsYou").getByRole("button", { name: "Test" }).click();
    await expect.poll(() => started(page)).toBe(2); // the two-note chime
    await pick(page, row(section, "question"), "marimba");
    await row(section, "question").getByRole("button", { name: "Test" }).click();
    await expect.poll(() => started(page)).toBe(5); // a fundamental and two partials
    await pick(page, row(section, "done"), "blip");
    await row(section, "done").getByRole("button", { name: "Test" }).click();
    await expect.poll(() => started(page)).toBe(6);
    expect(await page.evaluate(() => window.__audio.types.at(-1))).toBe("triangle");
    await row(section, "error").getByRole("button", { name: "Test" }).click();
    await expect.poll(() => started(page)).toBe(7);

    const volume = section.getByRole("slider", { name: "Volume" });
    await expect(volume).toBeDisabled(); // nothing to hear while sounds are off
    await master.click();
    await expect(master).toHaveAttribute("aria-checked", "true");
    await volume.fill("0.25");
    await expect(section.locator(".ntf-pct")).toHaveText("25 %");
    expect(await stored(page)).toMatchObject({
      on: true,
      volume: 0.25,
      kinds: { needsYou: "chime", question: "marimba", error: "thud", done: "blip" },
    });

    const again = await reopen(page);
    await expect(again.getByRole("switch", { name: "Sounds" })).toHaveAttribute("aria-checked", "true");
    await expect(again.getByRole("slider", { name: "Volume" })).toHaveValue("0.25");
    await expect(row(again, "question").getByRole("combobox")).toHaveAttribute("data-value", "marimba");
    await expect(row(again, "done").getByRole("combobox")).toHaveAttribute("data-value", "blip");
  });

  test("the appearance popover stays appearance only", async ({ page }) => {
    await openPage(page, "/feed");
    await page.locator("nav.rail button[aria-label='Quick settings']").click();
    const qs = page.getByRole("dialog", { name: "Quick settings" });
    await expect(qs.locator(".qs-label").filter({ hasText: "Appearance" })).toHaveCount(1);
    await expect(qs.locator(".ntf")).toHaveCount(0);
    await expect(qs.getByRole("switch", { name: /Notify me|Sounds/ })).toHaveCount(0);
    // Nothing to scroll: the popover is as tall as its content.
    expect(await qs.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  });

  test("an upload over 500 KB is refused; a small one shows with Remove, any kind can pick it, and it survives a reload", async ({
    page,
  }) => {
    await stubAudio(page, { quiet: true });
    const section = await openSection(page);
    const upload = section.locator(".ntf-row[data-row='upload']");
    const file = upload.locator("input[type=file]");
    await expect(file).toHaveAttribute("accept", "audio/*");
    await expect(upload.getByRole("button", { name: "Choose a file…" })).toBeVisible();
    await file.setInputFiles({ name: "big.wav", mimeType: "audio/wav", buffer: Buffer.alloc(600 * 1024) });
    await expect(upload.locator(".ntf-err")).toHaveText("600 KB is too big · files up to 500 KB");
    await expect(upload.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect((await options(page, row(section, "question"))).and(page.locator("[data-value=custom]"))).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");

    await file.setInputFiles({ name: "ding.wav", mimeType: "audio/wav", buffer: Buffer.alloc(2 * 1024, 1) });
    await expect(upload.locator(".ntf-file")).toHaveText("ding.wav · 2 KB");
    await expect(upload.locator(".ntf-err")).toHaveCount(0);
    await expect(upload.getByRole("button", { name: "Remove" })).toBeVisible();
    await expect((await options(page, row(section, "question"))).and(page.locator("[data-value=custom]"))).toHaveText(
      "Your sound · ding.wav",
    );
    await page.keyboard.press("Escape");
    await pick(page, row(section, "question"), "custom");
    await row(section, "question").getByRole("button", { name: "Test" }).click();
    await expect.poll(() => page.evaluate(() => window.__audio.buffers)).toBe(1);
    expect(await stored(page)).toMatchObject({ kinds: { question: "custom" }, custom: { name: "ding.wav" } });

    const again = await reopen(page);
    await expect(row(again, "question").getByRole("combobox")).toHaveAttribute("data-value", "custom");
    await row(again, "question").getByRole("button", { name: "Test" }).click();
    await expect.poll(() => page.evaluate(() => window.__audio.buffers)).toBe(1);
    await again.locator(".ntf-row[data-row='upload']").getByRole("button", { name: "Remove" }).click();
    await expect(row(again, "question").getByRole("combobox")).toHaveAttribute("data-value", "blip");
    await expect(
      again.locator(".ntf-row[data-row='upload']").getByRole("button", { name: "Choose a file…" }),
    ).toBeVisible();
    expect(await stored(page)).toMatchObject({ kinds: { question: "blip" }, custom: null });
  });
});
