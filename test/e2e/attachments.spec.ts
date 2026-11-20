// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The composer's pictures, end to end (web/src/control/Attachments.tsx): to a machine whose
// sessionpipe takes files on a prompt they go as the signed command's `files`, which the
// fake daemon fetches with its own token and holds to the signed size and hash, and nothing
// of them, of the board's address or of its key is in what is signed. A message of pictures
// alone is signed with words. A machine that takes none, on another computer, shows no
// paperclip and answers a pasted or dropped picture under the field; a dropped file of any
// kind never leaves the page. Against the second e2e instance (test door on, rp id
// localhost), on the desktop and the phone projects. (A computer reached through spacesheep
// is account.spec.ts's: it has the account.)
// With ATT_SHOTS=<dir> it also writes the review screenshots, 1440, 834 and 390 wide.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { type BrowserContext, expect, type Page, type Route, test } from "@playwright/test";
import {
  CONTROL_BASE,
  type FakeDaemon,
  fakeDaemon,
  passkeyPage,
  postSession,
  seenSetupHere,
  sinkToken,
} from "./control-helpers.js";
import { composer, sessionUrl } from "./helpers.js";

const SHOTS = process.env.ATT_SHOTS ?? "";
const CWD = "/Users/e2e/code";
const tag = () => randomUUID().slice(0, 6);

// ---------- real PNGs of one colour each, so the tray can draw them ----------

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer): number => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const KIWI = png(64, 48, [0xd9, 0x3a, 0x2b]);
const BIRCH = png(80, 60, [0xe8, 0xe2, 0xd0]);
const ONYX = png(96, 54, [0x1c, 0x1c, 0x1e]);
/** Seven more, each its own colour (and so its own hash). */
const SEVEN = Array.from({ length: 7 }, (_, i) => png(40 + i, 30, [30 * i, 200 - 20 * i, 90 + 10 * i]));
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("base64url");
const entry = (name: string, b: Buffer) => ({ name, type: "image/png", size: b.length, sha256: sha(b) });

interface Given {
  name: string;
  type: string;
  base64: string;
}
const given = (name: string, b: Buffer, type = "image/png"): Given => ({ name, type, base64: b.toString("base64") });

/** Paste into the message field: a ClipboardEvent whose DataTransfer carries `files` and,
 *  with `words`, plain text. Answers whether the page prevented the paste. */
function paste(page: Page, files: Given[], words?: string): Promise<boolean> {
  return page.evaluate(
    ([list, text]) => {
      const dt = new DataTransfer();
      for (const f of list) {
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      if (text) dt.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector<HTMLTextAreaElement>(".ctl-ask textarea")!.dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    [files, words ?? ""] as const,
  );
}

/** Drag `files` over the composer, then drop them. Answers what the page did with each
 *  event, and whether the field showed its drop highlight in between. */
function drop(page: Page, files: Given[]): Promise<{ over: boolean; dropped: boolean; highlighted: boolean }> {
  return page.evaluate(async (list) => {
    const dt = new DataTransfer();
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    const form = document.querySelector<HTMLFormElement>("form.ctl")!;
    const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
    form.dispatchEvent(over);
    // Let React paint the highlight before looking for it.
    await new Promise((r) => setTimeout(r, 80));
    const highlighted = form.classList.contains("ctl--drop");
    const dropped = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
    form.dispatchEvent(dropped);
    return { over: over.defaultPrevented, dropped: dropped.defaultPrevented, highlighted };
  }, files);
}

const daemons: FakeDaemon[] = [];
test.afterAll(async () => {
  await Promise.all(daemons.map((d) => d.stop()));
});

/** A paired machine with one session, its page open and its composer on. `takes`: its
 *  sessionpipe takes files on a prompt (0.10 or later). */
async function open(
  context: BrowserContext,
  page: Page,
  o: { takes: boolean; title: string },
): Promise<{ d: FakeDaemon; uiKey: string; asked: string[] }> {
  await seenSetupHere(context);
  const key = await passkeyPage(context, page);
  const d = await fakeDaemon(key, {
    name: `pictures-${tag()}`,
    harnesses: ["claude-code"],
    folders: [CWD],
    mode: "auto",
    ...(o.takes ? { files: true, prompt_files: true, version: "0.17.0" } : { version: "0.9.4" }),
  });
  daemons.push(d);
  const s = await postSession(await sinkToken(), { machine: d.name, cwd: CWD, title: o.title });
  const info = (await (await fetch(`${CONTROL_BASE}/api/ui/info`)).json()) as { uiKey: string };
  /** Every request the page makes from here on, by path and query. */
  const asked: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    asked.push(`${r.method()} ${u.pathname}${u.search}`);
  });
  await page.goto(`${CONTROL_BASE}${sessionUrl(s.harness, s.id)}`);
  await expect(composer(page)).toBeEnabled();
  return { d, uiKey: info.uiKey, asked };
}

const tray = (page: Page) => page.locator(".att-item");
const picker = (page: Page) => page.locator("input[data-attach-input]");
const send = (page: Page) => page.locator(".ctl-send");
const prompts = (d: FakeDaemon) => d.seen.filter((c) => c.kind === "prompt");

/** Nothing of the board is in a signed command: not its key, not an address, not a link to
 *  a file it holds, not a path in its state. */
function nothingOfTheBoard(cmd: string, uiKey: string): void {
  expect(uiKey.length).toBeGreaterThan(8);
  expect(cmd).not.toContain(uiKey);
  expect(cmd).not.toContain("k=");
  expect(cmd).not.toContain("/attachments/");
  expect(cmd).not.toContain("://");
  expect(cmd).not.toContain("localhost");
  expect(cmd).not.toContain("sessionpipe-gui");
}

async function shots(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const was = page.viewportSize();
  const project = test.info().project.name;
  // A phone is the narrow one; a desktop the two wide ones.
  const sizes =
    project === "phone"
      ? [{ width: 390, height: 844 }]
      : [
          { width: 1440, height: 900 },
          { width: 834, height: 1112 },
        ];
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${size.width}.png`) });
  }
  if (was) await page.setViewportSize(was);
}

test("the picker, a paste and a drop each add a picture; they go as the message's files, and nothing of the board is signed", async ({
  context,
  page,
}) => {
  const { d, uiKey, asked } = await open(context, page, { takes: true, title: "What colour is the square" });
  await expect(picker(page)).toBeEnabled();

  await picker(page).setInputFiles({ name: "kiwi.png", mimeType: "image/png", buffer: KIWI });
  await expect(tray(page)).toHaveCount(1);
  // A pasted picture is taken, so the paste is the page's.
  expect(await paste(page, [given("image.png", BIRCH)])).toBe(true);
  await expect(tray(page)).toHaveCount(2);
  // A macOS screenshot's name has a narrow no-break space before PM.
  const dropped = await drop(page, [given("Screenshot 2026-11-17 at 10.41.07 PM.png", ONYX)]);
  expect(dropped).toEqual({ over: true, dropped: true, highlighted: true });
  await expect(page.locator("form.ctl")).not.toHaveClass(/ctl--drop/);
  await expect(tray(page)).toHaveCount(3);
  for (const i of [0, 1, 2]) await expect(tray(page).nth(i)).toHaveAttribute("data-state", "ready");
  // Each under the name it is signed with; its pixels, read by the receiver, in its tooltip.
  await expect(tray(page).nth(0)).toHaveAttribute("title", /^kiwi\.png · 64×48 · \d+ KB$/);
  await expect(tray(page).nth(1)).toHaveAttribute("title", /^image\.png · 80×60 · /);
  await expect(tray(page).nth(2)).toHaveAttribute("data-name", "Screenshot 2026-11-17 at 10.41.07 PM.png");
  await shots(page, "1-three-pictures-ready");

  const words = "What colour is the square in the attached image, and what word is written?";
  await composer(page).fill(words);
  await send(page).click();
  await expect.poll(() => prompts(d).length, { timeout: 20_000 }).toBe(1);
  const cmd = prompts(d)[0]!;
  // CONTROL.md §3.1's order: the files after the text.
  expect(Object.keys(cmd)).toEqual(["v", "t", "machine", "kind", "session", "text", "files", "nonce", "iat"]);
  // The words as typed, and nothing added to them.
  expect(cmd.text).toBe(words);
  // In the tray's order, each by its four fields; the hash is the page's own, of these bytes.
  expect(cmd.files).toEqual([
    entry("kiwi.png", KIWI),
    entry("image.png", BIRCH),
    entry("Screenshot 2026-11-17 at 10.41.07 PM.png", ONYX),
  ]);
  nothingOfTheBoard(d.cmds[0]!, uiKey);
  // The machine got every one of them whole, with its own token.
  expect(d.fetched.map((f) => [f.name, f.ok, f.status, f.contentType, f.bytes])).toEqual([
    ["kiwi.png", true, 200, "image/png", KIWI.length],
    ["image.png", true, 200, "image/png", BIRCH.length],
    ["Screenshot 2026-11-17 at 10.41.07 PM.png", true, 200, "image/png", ONYX.length],
  ]);
  // The composer is clear, and the older way was never used: no upload under /attachments.
  await expect(tray(page)).toHaveCount(0);
  await expect(composer(page)).toHaveValue("");
  expect(asked.filter((a) => a.includes("/attachments"))).toEqual([]);
  const uploads = asked.filter((a) => a.startsWith("POST /api/ui/control/files"));
  expect(uploads).toHaveLength(3);
  for (const u of uploads) expect(u).toContain(`&machine=${d.id}`);
  // Until the session's own record of the turn is drawn, the message names what it carried.
  const sent = page.locator(".starting-files").last();
  await expect(sent.locator(".starting-file")).toHaveCount(3);
  await expect(sent).toContainText("kiwi.png");
  await shots(page, "2-sent-with-three-pictures");
});

test("a picture in a preview tab's composer keeps the tab: the next plain open adds its own", async ({
  context,
  page,
  isMobile,
}) => {
  test.skip(!!isMobile, "a computer's panel: the phone has no tabs");
  // A plain click opens beside, where nothing is chosen.
  await seenSetupHere(context, { mode: "advanced" });
  const key = await passkeyPage(context, page);
  const d = await fakeDaemon(key, {
    name: `pictures-${tag()}`,
    harnesses: ["claude-code"],
    folders: [CWD],
    mode: "auto",
    files: true,
    prompt_files: true,
    version: "0.17.0",
  });
  daemons.push(d);
  const token = await sinkToken();
  const t = tag();
  const one = await postSession(token, { machine: d.name, cwd: CWD, title: `Kept by a picture ${t}` });
  const two = await postSession(token, { machine: d.name, cwd: CWD, title: `Opened after it ${t}` });
  const card = (s: { harness: string; id: string }) =>
    page.locator(`article.card a.card-link[href^="${sessionUrl(s.harness, s.id)}"]`);
  const panel = page.locator("aside.panel");
  const tabs = panel.locator("[role='tablist'] [role='tab']");
  await page.goto(`${CONTROL_BASE}/`);
  await card(one).click();
  await expect(panel).toHaveClass(/panel--open/);
  await expect(composer(page)).toBeEnabled();
  await expect(panel.locator(".panel-title")).toHaveText(`Kept by a picture ${t}`);
  expect(await paste(page, [given("image.png", BIRCH)])).toBe(true);
  await expect(tray(page)).toHaveCount(1);
  await card(two).click();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(0)).not.toHaveClass(/tab--preview/);
  // The kept tab still holds its picture.
  await tabs.nth(0).click();
  await expect(panel.locator(".panel-body:not(.panel-body--off) .att-item")).toHaveCount(1);
});

test("three at once, then seven: six are kept and the cap is said; two upload at a time; pictures alone are signed with words", async ({
  context,
  page,
}) => {
  const { d, uiKey } = await open(context, page, { takes: true, title: "Three, then seven" });
  // Every upload takes a while, so the ones that wait can be seen waiting (and, for the
  // review screenshots, long enough to be drawn at every width).
  let going = 0;
  let most = 0;
  await page.route("**/api/ui/control/files?*", async (route: Route) => {
    going++;
    most = Math.max(most, going);
    await new Promise((r) => setTimeout(r, SHOTS ? 2500 : 300));
    const response = await route.fetch();
    going--;
    await route.fulfill({ response });
  });

  await picker(page).setInputFiles([
    { name: "kiwi.png", mimeType: "image/png", buffer: KIWI },
    { name: "birch.png", mimeType: "image/png", buffer: BIRCH },
    { name: "onyx.png", mimeType: "image/png", buffer: ONYX },
  ]);
  await expect(tray(page)).toHaveCount(3);
  // Two go, the third waits its turn; Send waits for all of them.
  await expect(page.locator(".att-item[data-state=uploading]")).toHaveCount(2);
  await expect(page.locator(".att-item[data-state=waiting]")).toHaveCount(1);
  await expect(send(page)).toBeDisabled();
  await shots(page, "3-two-uploading-one-waiting");
  await expect(page.locator(".att-item[data-state=ready]")).toHaveCount(3);
  await expect(send(page)).toBeEnabled();
  await send(page).click();
  await expect.poll(() => prompts(d).length, { timeout: 20_000 }).toBe(1);
  expect(prompts(d)[0]!.text).toBe("Look at the 3 attached pictures.");
  expect(prompts(d)[0]!.files).toEqual([entry("kiwi.png", KIWI), entry("birch.png", BIRCH), entry("onyx.png", ONYX)]);
  await expect(tray(page)).toHaveCount(0);

  // Seven pasted screenshots, each named image.png by the browser.
  await paste(
    page,
    SEVEN.map((b) => given("image.png", b)),
  );
  await expect(tray(page)).toHaveCount(6);
  await expect(page.locator(".att-note")).toHaveText("6 images per message at most");
  await expect(picker(page)).toBeDisabled();
  await expect(page.locator(".att-item[data-state=ready]")).toHaveCount(6, { timeout: 20_000 });
  expect(most).toBe(2);
  await send(page).click();
  await expect.poll(() => prompts(d).length, { timeout: 20_000 }).toBe(2);
  const six = prompts(d)[1]!;
  expect(six.text).toBe("Look at the 6 attached pictures.");
  // One name each in the message: image.png, image-2.png, …
  expect(six.files).toEqual(SEVEN.slice(0, 6).map((b, i) => entry(i === 0 ? "image.png" : `image-${i + 1}.png`, b)));
  for (const cmd of d.cmds) nothingOfTheBoard(cmd, uiKey);
  expect(d.fetched).toHaveLength(9);
  expect(d.fetched.every((f) => f.ok)).toBe(true);
});

test("a picture alone is signed with 'Look at the attached picture.', and the sent message shows those words", async ({
  context,
  page,
}) => {
  const { d, uiKey } = await open(context, page, { takes: true, title: "A picture and no words" });
  await paste(page, [given("image.png", KIWI)]);
  await expect(tray(page)).toHaveAttribute("data-state", "ready");
  await expect(send(page)).toBeEnabled();
  await send(page).click();
  await expect.poll(() => prompts(d).length, { timeout: 20_000 }).toBe(1);
  const cmd = prompts(d)[0]!;
  expect(cmd.text).toBe("Look at the attached picture.");
  expect(cmd.files).toEqual([entry("image.png", KIWI)]);
  expect(Object.keys((cmd.files as object[])[0]!)).toEqual(["name", "type", "size", "sha256"]);
  nothingOfTheBoard(d.cmds[0]!, uiKey);
  expect(d.fetched).toMatchObject([{ name: "image.png", ok: true }]);
  // What the agent got is what the person reads: the words that were signed, and the file.
  await expect(page.locator(".page.session blockquote").last()).toContainText("Look at the attached picture.");
  await expect(page.locator(".starting-files .starting-file").last()).toContainText("image.png");
});

test("an upload that did not arrive whole, and a file that is not the picture its type says, are refused in words", async ({
  context,
  page,
}) => {
  const { d } = await open(context, page, { takes: true, title: "Not whole" });
  // The receiver answers with a hash that is not the one the page computed of the bytes.
  await page.route("**/api/ui/control/files?*", async (route: Route) => {
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...json, sha256: "A".repeat(43) } });
  });
  await picker(page).setInputFiles({ name: "kiwi.png", mimeType: "image/png", buffer: KIWI });
  await expect(tray(page)).toHaveAttribute("data-state", "error");
  await expect(tray(page).locator(".att-meta")).toHaveText("The picture didn't arrive whole. Try again.");
  // Nothing is signed with it: Send says to take it out.
  await composer(page).fill("try anyway");
  await send(page).click();
  await expect(page.locator(".att-note")).toHaveText("remove the image that could not be attached, or try it again");
  await tray(page).getByRole("button", { name: "Remove image" }).click();
  await expect(tray(page)).toHaveCount(0);
  await page.unroute("**/api/ui/control/files?*");

  // Words in a file called a PNG: the receiver reads the bytes, not the name.
  await picker(page).setInputFiles({
    name: "notes.png",
    mimeType: "image/png",
    buffer: Buffer.from("these are words, not pixels"),
  });
  await expect(tray(page)).toHaveAttribute("data-state", "error");
  await expect(tray(page).locator(".att-meta")).toHaveText("This file isn't the picture its type says.");
  await shots(page, "4-a-picture-refused");
  // A kind of picture the composer does not take is refused before any upload.
  await tray(page).getByRole("button", { name: "Remove image" }).click();
  await paste(page, [given("IMG_0412.heic", KIWI, "image/heic")]);
  await expect(tray(page).locator(".att-meta")).toHaveText(
    "not an image we can send (image/heic); PNG, JPEG, GIF or WebP",
  );
  await page.waitForTimeout(400);
  expect(prompts(d)).toHaveLength(0);
});

test("a machine whose sessionpipe is older than 0.10, on another computer: no paperclip, and a pasted or dropped picture is answered under the field", async ({
  context,
  page,
}) => {
  const { d, asked } = await open(context, page, { takes: false, title: "An older sessionpipe" });
  const line = page.locator(".ctl-foot[data-reason=pictures-off] .ctl-hint");
  const says = `Pictures can't be sent to ${d.name}: its sessionpipe is older than 0.10. Run sessionpipe update there.`;
  await expect(picker(page)).toHaveCount(0);
  await expect(line).toHaveCount(0);

  // Words pasted are the field's own: nothing is prevented and nothing is said.
  expect(await paste(page, [], "just words")).toBe(false);
  await expect(line).toHaveCount(0);
  // A picture is not taken, so the paste is not prevented either, and the line says why.
  expect(await paste(page, [given("image.png", KIWI)], "words beside it")).toBe(false);
  await expect(line).toHaveText(says);
  await expect(line.locator("code")).toHaveText("sessionpipe update");
  await expect(tray(page)).toHaveCount(0);
  await shots(page, "5-pictures-cant-be-sent");
  // It answers the paste; once the person writes on, it goes.
  await composer(page).fill("Then in words: the square is red");
  await expect(line).toHaveCount(0);

  // A drop is taken from the browser, which would open the file, and answered the same way.
  const dropped = await drop(page, [given("kiwi.png", KIWI)]);
  expect(dropped).toEqual({ over: true, dropped: true, highlighted: false });
  await expect(line).toHaveText(says);
  await expect(tray(page)).toHaveCount(0);
  // Nothing was uploaded anywhere, and the words still go.
  expect(asked.filter((a) => a.startsWith("POST") && /attachments|control\/files/.test(a))).toEqual([]);
  await send(page).click();
  await expect.poll(() => prompts(d).length, { timeout: 20_000 }).toBe(1);
  expect(Object.keys(prompts(d)[0]!)).toEqual(["v", "t", "machine", "kind", "session", "text", "nonce", "iat"]);
  expect(prompts(d)[0]!.text).toBe("Then in words: the square is red");
});

test("a dropped file that is no picture never leaves the page, whatever the composer can do", async ({
  context,
  page,
}) => {
  const notes = given("notes.txt", Buffer.from("the date picker is off by one\n"), "text/plain");
  const { d } = await open(context, page, { takes: true, title: "A text file dropped" });
  const here = page.url();
  // The browser's own answer to a file let fall is to open it in the page's place.
  expect(await drop(page, [notes])).toEqual({ over: true, dropped: true, highlighted: true });
  await expect(tray(page)).toHaveCount(0);
  await expect(page.locator(".att-note")).toHaveCount(0);
  expect(page.url()).toBe(here);
  await expect(composer(page)).toBeEnabled();

  // And on a composer that is off: a session on a machine nobody paired.
  const lone = await postSession(await sinkToken(), { machine: `unpaired-${tag()}`, cwd: CWD, title: "Nobody paired" });
  await page.goto(`${CONTROL_BASE}${sessionUrl(lone.harness, lone.id)}`);
  await expect(page.locator(".ctl-foot[data-reason=unpaired]")).toBeVisible();
  await expect(composer(page)).toBeDisabled();
  const off = page.url();
  expect(await drop(page, [notes])).toEqual({ over: true, dropped: true, highlighted: false });
  expect(await drop(page, [given("kiwi.png", KIWI)])).toEqual({ over: true, dropped: true, highlighted: false });
  await expect(tray(page)).toHaveCount(0);
  expect(page.url()).toBe(off);
  expect(prompts(d)).toHaveLength(0);
});
