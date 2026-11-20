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
// is account.spec.ts's: it has the account.) Every picture is made smaller before it goes
// (web/src/control/shrink.ts): a big photo or screenshot goes as a WebP 2560 px on its long
// edge, and a HEIC as a JPEG where the engine can draw one (WebKit), with words where not.
// A sent message shows what it carried as thumbnails: before the session's turn arrives,
// after (from the list of saved files the machine adds to the words, which is never drawn
// as text), and after a reload.
// With ATT_SHOTS=<dir> it also writes the review screenshots, 1440, 834 and 390 wide.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { type BrowserContext, expect, type Locator, type Page, type Route, test, webkit } from "@playwright/test";
import { humanSize } from "../../shared/attachments.js";
import {
  CONTROL_BASE,
  type FakeDaemon,
  fakeDaemon,
  HEIC,
  passkeyPage,
  postSession,
  type StartScript,
  seenSetupHere,
  sinkToken,
} from "./control-helpers.js";
import { composer, sessionUrl, ulid } from "./helpers.js";

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
/** A PNG of noise, 1.4 MB that do not shrink: long enough on a slow link to be seen going. */
function noisePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  let x = 0x2545f491;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let i = 0; i < rows.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    rows[i] = i % (1 + width * 3) === 0 ? 0 : x & 0xff;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const BIRCH = png(80, 60, [0xe8, 0xe2, 0xd0]);
const ONYX = png(96, 54, [0x1c, 0x1c, 0x1e]);
/** Seven more, each its own colour (and so its own hash). */
const SEVEN = Array.from({ length: 7 }, (_, i) => png(40 + i, 30, [30 * i, 200 - 20 * i, 90 + 10 * i]));
const HEIC_WORDS = "This browser can't open HEIC photos. Export it as JPEG (Photos › File › Export) and attach that.";
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

/** Paste a picture the page draws itself, `width`×`height` (a gradient with a little grain,
 *  as a photo has), written as `type` and padded with zeros after its end to `padTo` bytes,
 *  which every decoder reads past: a 13 MB photo without 13 MB through the test. */
function pasteDrawn(
  page: Page,
  o: { name: string; type: "image/jpeg" | "image/png"; width: number; height: number; padTo: number },
): Promise<number> {
  return page.evaluate(async (o) => {
    const cv = new OffscreenCanvas(o.width, o.height);
    const cx = cv.getContext("2d")!;
    const g = cx.createLinearGradient(0, 0, o.width, o.height);
    g.addColorStop(0, "#2f6f4e");
    g.addColorStop(1, "#d9c27a");
    cx.fillStyle = g;
    cx.fillRect(0, 0, o.width, o.height);
    for (let i = 0; i < 400; i++) {
      cx.fillStyle = `hsl(${(i * 37) % 360} 40% 50% / 0.35)`;
      cx.beginPath();
      cx.arc((i * 7919) % o.width, (i * 104729) % o.height, 20 + (i % 60), 0, Math.PI * 2);
      cx.fill();
    }
    const drawn = await cv.convertToBlob({ type: o.type, quality: 0.92 });
    const file = new File([drawn, new Uint8Array(Math.max(0, o.padTo - drawn.size))], o.name, { type: o.type });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector<HTMLTextAreaElement>(".ctl-ask textarea")!.dispatchEvent(ev);
    return file.size;
  }, o);
}

/** The size of every upload the page makes, in order. */
function uploadSizes(page: Page): { bytes: number; type: string; name: string }[] {
  const out: { bytes: number; type: string; name: string }[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (r.method() !== "POST" || u.pathname !== "/api/ui/control/files") return;
    out.push({
      bytes: r.postDataBuffer()?.length ?? -1,
      type: r.headers()["content-type"] ?? "",
      name: u.searchParams.get("name") ?? "",
    });
  });
  return out;
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
  o: { takes: boolean; title: string; saves?: boolean; script?: StartScript },
): Promise<{ d: FakeDaemon; uiKey: string; asked: string[]; board: string; s: { harness: string; id: string } }> {
  await seenSetupHere(context);
  const key = await passkeyPage(context, page);
  const d = await fakeDaemon(
    key,
    {
      name: `pictures-${tag()}`,
      harnesses: ["claude-code"],
      folders: [CWD],
      mode: "auto",
      ...(o.takes ? { files: true, prompt_files: true, version: "0.17.0" } : { version: "0.9.4" }),
    },
    { ...(o.saves ? { saves: true, sinkToken: await sinkToken() } : {}), ...(o.script ? { script: o.script } : {}) },
  );
  daemons.push(d);
  const s = await postSession(await sinkToken(), { machine: d.name, cwd: CWD, title: o.title });
  const info = (await (await fetch(`${CONTROL_BASE}/api/ui/info`)).json()) as { uiKey: string; hostname: string };
  /** Every request the page makes from here on, by path and query. */
  const asked: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    asked.push(`${r.method()} ${u.pathname}${u.search}`);
  });
  await page.goto(`${CONTROL_BASE}${sessionUrl(s.harness, s.id)}`);
  await expect(composer(page)).toBeEnabled();
  // The board an upload's words name: the receiver's machine, as its Info says it.
  return { d, uiKey: info.uiKey, asked, board: info.hostname, s };
}

const tray = (page: Page) => page.locator(".att-item");

/** A tray item whose picture can't be drawn still shows its frame: a 44 px square (the
 *  size of a frame not drawn yet), visible, on its own background, with the picture glyph
 *  in it. */
async function framed(item: Locator): Promise<void> {
  const frame = item.locator(".att-thumb--none");
  await expect(frame).toBeVisible();
  const box = await frame.boundingBox();
  expect(box && Math.round(box.width)).toBe(44);
  expect(box && Math.round(box.height)).toBe(44);
  const look = await frame.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { visibility: cs.visibility, opacity: Number(cs.opacity), background: cs.backgroundColor };
  });
  expect(look.visibility).toBe("visible");
  expect(look.opacity).toBeGreaterThan(0.3);
  expect(look.background).not.toBe("rgba(0, 0, 0, 0)");
  await expect(frame.locator("svg")).toBeVisible();
}
/** The one line under the whole tray. */
const trayLine = (page: Page) => page.locator(".ctl-field > .att > .att-tray + .att-note");
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
  // The machine got every one of them whole, with its own token (after it took the command).
  await expect
    .poll(() => d.fetched.map((f) => [f.name, f.ok, f.status, f.contentType, f.bytes]))
    .toEqual([
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
  // Until the session's own record of the turn is drawn, the message shows what it carried.
  const sent = page.locator(".page.session [data-sent-files]").last();
  await expect(sent.locator("[data-sent-picture]")).toHaveCount(3);
  await expect(sent.locator("[data-sent-picture]").first()).toHaveAttribute("data-sent-picture", "kiwi.png");
  await shots(page, "2-sent-with-three-pictures");
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
  await expect(page.locator(".att-note")).toHaveText("6 pictures per message at most.");
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
  await expect.poll(() => d.fetched.length).toBe(9);
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
  await expect.poll(() => d.fetched.map((f) => [f.name, f.ok])).toEqual([["image.png", true]]);
  // What the agent got is what the person reads: the words that were signed, and the file.
  await expect(page.locator(".page.session blockquote").last()).toContainText("Look at the attached picture.");
  await expect(page.locator(".page.session [data-sent-picture]").last()).toHaveAttribute(
    "data-sent-picture",
    "image.png",
  );
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
  // Said once, on a line under the whole tray; nothing is written inside the tray.
  await expect(trayLine(page)).toHaveText("The picture didn't arrive whole. Try again.");
  expect(await tray(page).textContent()).toBe("");
  // Nothing is signed with it: Send is off and says to take it out or try it again.
  await composer(page).fill("try anyway");
  await expect(send(page)).toBeDisabled();
  await expect(send(page)).toHaveAttribute("data-tip", "Remove or retry the picture that didn't upload.");
  // ⌘↩ (or Ctrl+Return) sends from the keyboard on a touch screen too.
  await composer(page).press("ControlOrMeta+Enter");
  await expect(page.locator(".att-note")).toHaveText("Remove or retry the picture that didn't upload.");
  await tray(page).getByRole("button", { name: "Remove picture" }).click();
  await expect(tray(page)).toHaveCount(0);
  await page.unroute("**/api/ui/control/files?*");

  // Words in a file called a PNG: the receiver reads the bytes, not the name.
  await picker(page).setInputFiles({
    name: "notes.png",
    mimeType: "image/png",
    buffer: Buffer.from("these are words, not pixels"),
  });
  await expect(tray(page)).toHaveAttribute("data-state", "error");
  await expect(trayLine(page)).toHaveText("That file isn't a picture.");
  // It can't be drawn, so its frame is.
  await framed(tray(page));
  // Trying the same bytes again would only be refused again: no Retry.
  await expect(tray(page).getByRole("button", { name: "Try again" })).toHaveCount(0);
  await shots(page, "4-a-picture-refused");
  // A kind of picture the composer does not take is refused before any upload.
  await tray(page).getByRole("button", { name: "Remove picture" }).click();
  await paste(page, [given("scan.tiff", KIWI, "image/tiff")]);
  await expect(trayLine(page)).toHaveText("Only PNG, JPEG, GIF, WebP or HEIC pictures can be sent.");
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
  await expect(page.locator(".att-note")).toHaveText("Only pictures can be dropped here.");
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

test("a 13.5 MB photo is made smaller before it goes: a WebP of at most 3 MB, 2560 px on its long edge", async ({
  context,
  page,
}) => {
  const { d, uiKey } = await open(context, page, { takes: true, title: "A big photo" });
  const uploads = uploadSizes(page);
  const was = await pasteDrawn(page, {
    name: "IMG_0412.jpg",
    type: "image/jpeg",
    width: 4032,
    height: 3024,
    padTo: 13_500_000,
  });
  expect(was).toBe(13_500_000);
  await expect(tray(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  // Under its new name, at its new size, with what it was.
  await expect(tray(page)).toHaveAttribute("data-name", "IMG_0412.webp");
  await expect(tray(page)).toHaveAttribute("title", /^IMG_0412\.webp · 2560×1920 · [\d.]+ (KB|MB) \(was 13 MB\)$/);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.type).toBe("image/webp");
  expect(uploads[0]!.bytes).toBeGreaterThan(0);
  expect(uploads[0]!.bytes).toBeLessThanOrEqual(3 * 1024 * 1024);
  await shots(page, "6-a-big-photo-made-smaller");

  await send(page).click();
  await expect.poll(() => prompts(d).length, { timeout: 20_000 }).toBe(1);
  const cmd = prompts(d)[0]!;
  expect(cmd.text).toBe("Look at the attached picture.");
  expect(cmd.files).toEqual([
    expect.objectContaining({ name: "IMG_0412.webp", type: "image/webp", size: uploads[0]!.bytes }),
  ]);
  nothingOfTheBoard(d.cmds[0]!, uiKey);
  // The fake daemon notes a command once it has fetched the command's files.
  await expect.poll(() => d.fetched.length).toBe(1);
  expect(d.fetched).toMatchObject([{ name: "IMG_0412.webp", ok: true, contentType: "image/webp" }]);
});

test("a 30 MB screenshot, over a file's 25 MB, is made smaller and sent", async ({ context, page }) => {
  const { d } = await open(context, page, { takes: true, title: "A huge screenshot" });
  const uploads = uploadSizes(page);
  await pasteDrawn(page, { name: "image.png", type: "image/png", width: 3200, height: 3200, padTo: 30_700_000 });
  await expect(tray(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(tray(page)).toHaveAttribute("title", /^image\.webp · 2560×2560 · [\d.]+ (KB|MB) \(was 29 MB\)$/);
  expect(uploads.map((u) => u.type)).toEqual(["image/webp"]);
  expect(uploads[0]!.bytes).toBeLessThan(26_214_400);
  await composer(page).fill("What does this screen say?");
  await send(page).click();
  await expect.poll(() => prompts(d).length, { timeout: 20_000 }).toBe(1);
  // The fake daemon notes a command once it has fetched the command's files.
  await expect.poll(() => d.fetched.length).toBe(1);
  expect(d.fetched).toMatchObject([{ name: "image.webp", ok: true, bytes: uploads[0]!.bytes }]);
});

test("a HEIC this browser can't draw is refused in words, before any upload", async ({ context, page }) => {
  const { asked } = await open(context, page, { takes: true, title: "A HEIC photo" });
  await paste(page, [given("IMG_0412.heic", HEIC, "image/heic")]);
  await expect(tray(page)).toHaveAttribute("data-state", "error");
  await expect(trayLine(page)).toHaveText(HEIC_WORDS);
  await shots(page, "7-a-heic-refused");
  await tray(page).getByRole("button", { name: "Remove picture" }).click();
  // From Files or Finder a HEIC may come with no type at all: its name says what it is.
  const dropped = await drop(page, [given("IMG_0413.HEIC", HEIC, "")]);
  expect(dropped.dropped).toBe(true);
  await expect(trayLine(page)).toHaveText(HEIC_WORDS);
  expect(asked.filter((a) => a.startsWith("POST /api/ui/control/files"))).toEqual([]);
});

test("in WebKit a HEIC is drawn and goes as a JPEG", async ({ context, page }, info) => {
  test.skip(info.project.name !== "desktop", "one browser of its own is enough");
  test.skip(process.platform !== "darwin" || !existsSync(webkit.executablePath()), "WebKit draws HEIC on macOS");
  const { d } = await open(context, page, { takes: true, title: "A HEIC in WebKit" });
  const url = page.url();
  const state = await context.storageState();
  const wk = await webkit.launch();
  try {
    const other = await wk.newContext({ storageState: state, locale: "en-US", timezoneId: "UTC" });
    const p = await other.newPage();
    const uploads = uploadSizes(p);
    await p.goto(url);
    await expect(composer(p)).toBeEnabled();
    await expect(picker(p)).toBeEnabled();
    await picker(p).setInputFiles({ name: "IMG_0412.heic", mimeType: "image/heic", buffer: HEIC });
    await expect(tray(p)).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
    await expect(tray(p)).toHaveAttribute("data-name", "IMG_0412.jpg");
    await expect(tray(p)).toHaveAttribute("title", /^IMG_0412\.jpg · 64×48 · /);
    expect(uploads).toMatchObject([{ type: "image/jpeg", name: "IMG_0412.jpg" }]);
    await other.close();
  } finally {
    await wk.close();
  }
  expect(prompts(d)).toHaveLength(0);
});

// ---------- what a sent message carried, shown ----------

/** The thumbnails in `scope`, each drawn from its bytes (an image that loaded). */
async function drawn(scope: ReturnType<Page["locator"]>): Promise<number[]> {
  return scope
    .locator("[data-sent-picture] img")
    .evaluateAll((imgs) => (imgs as HTMLImageElement[]).map((i) => (i.complete ? i.naturalWidth : 0)));
}

/** Nothing of the machine's list of saved files is drawn as words. */
async function noPathsDrawn(page: Page): Promise<void> {
  const html = await page.content();
  expect(html).not.toContain(".sessionpipe/files");
  expect(html).not.toContain("Attached files (saved in this folder)");
}

/** Acks that take a while, so the message is seen on its way before its turn arrives. */
const slowly: StartScript = (c) => ({
  pauseMs: 3000,
  events: true,
  acks: [
    { outcome: "taken", mode: "sdk" },
    { outcome: "delivered", mode: "sdk", session: c.session },
  ],
});

test("a message's pictures are thumbnails before its turn arrives, after, and after a reload; the saved paths are never words", async ({
  context,
  page,
}) => {
  const { d } = await open(context, page, {
    takes: true,
    title: "Pictures, then the turn",
    saves: true,
    script: slowly,
  });
  await picker(page).setInputFiles([
    { name: "kiwi.png", mimeType: "image/png", buffer: KIWI },
    { name: "birch.png", mimeType: "image/png", buffer: BIRCH },
    { name: "onyx.png", mimeType: "image/png", buffer: ONYX },
  ]);
  await expect(page.locator(".att-item[data-state=ready]")).toHaveCount(3);
  await composer(page).fill("Which of these is the darkest?");
  await send(page).click();

  // On its way: the message as signed, its pictures from the files it signed.
  const bubble = page.locator(".page.session blockquote", { hasText: "Which of these is the darkest?" }).last();
  await expect(bubble.locator("[data-sent-picture]")).toHaveCount(3);
  await expect(bubble.locator(".prompt-via")).toHaveCount(0);
  await expect.poll(() => drawn(bubble)).toEqual([64, 80, 96]);
  await shots(page, "8-sent-pictures-on-their-way");

  // The turn arrived: the words as the machine handed them over (framed, so "Sent from"),
  // the same three pictures, found again from its list of saved files.
  await expect(bubble.locator(".prompt-via")).toContainText("Sent from", { timeout: 20_000 });
  expect(prompts(d)).toHaveLength(1);
  await expect(bubble.locator("[data-sent-picture]")).toHaveCount(3);
  await expect.poll(() => drawn(bubble)).toEqual([64, 80, 96]);
  await expect(bubble.locator("[data-sent-picture]").nth(2)).toHaveAttribute("data-sent-picture", "onyx.png");
  await expect(page.locator(".page.session [data-sent-picture]")).toHaveCount(3);
  await noPathsDrawn(page);
  await shots(page, "9-sent-pictures-in-the-turn");

  await page.reload();
  const again = page.locator(".page.session blockquote", { hasText: "Which of these is the darkest?" }).last();
  await expect(again.locator(".prompt-via")).toContainText("Sent from");
  await expect(again.locator("[data-sent-picture]")).toHaveCount(3);
  await expect.poll(() => drawn(again)).toEqual([64, 80, 96]);
  await noPathsDrawn(page);
});

test("a picture no longer kept here is a chip with its name, type and size", async ({ context, page }) => {
  await open(context, page, { takes: true, title: "Kept no more", saves: true });
  // The receiver answers every picture as gone.
  await page.route("**/api/ui/control/files/*", (route: Route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: '{"reason":"gone"}' }),
  );
  await picker(page).setInputFiles({ name: "kiwi.png", mimeType: "image/png", buffer: KIWI });
  await expect(tray(page)).toHaveAttribute("data-state", "ready");
  await composer(page).fill("Is this still here?");
  await send(page).click();
  const bubble = page.locator(".page.session blockquote", { hasText: "Is this still here?" }).last();
  await expect(bubble.locator(".prompt-via")).toContainText("Sent from", { timeout: 20_000 });
  const chip = bubble.locator("[data-sent-file]");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute("title", `kiwi.png · PNG · ${KIWI.length} B`);
  await expect(chip).toHaveText(`kiwi.pngPNG · ${KIWI.length} B`);
  await noPathsDrawn(page);
  await shots(page, "10-a-picture-kept-no-more");
});

test("a start with two pictures shows them before its first turn arrives and after", async ({
  context,
  page,
  isMobile,
}) => {
  test.skip(isMobile, "the phone's sheet is mobile.spec.ts's");
  await seenSetupHere(context);
  const key = await passkeyPage(context, page);
  const d = await fakeDaemon(
    key,
    {
      name: `start-pictures-${tag()}`,
      harnesses: ["claude-code"],
      folders: [CWD],
      mode: "auto",
      files: true,
      prompt_files: true,
      version: "0.17.0",
      start: { "claude-code": { permissions: ["safe", "auto"], permission: "auto", any_model: true } },
    },
    { sinkToken: await sinkToken(), saves: true, script: slowly },
  );
  daemons.push(d);
  await page.goto(`${CONTROL_BASE}/?new=1&machine=${d.name}`);
  await page.locator("[data-new-session] [data-ns-text]").fill("Make the header match these two.");
  await page.locator("input[data-ns-files]").setInputFiles([
    { name: "kiwi.png", mimeType: "image/png", buffer: KIWI },
    { name: "birch.png", mimeType: "image/png", buffer: BIRCH },
  ]);
  await expect(page.locator(".ns-file[data-file-state=held]")).toHaveCount(2);
  await page.locator("[data-new-session] [data-ns-start]").click();
  await expect(page).toHaveURL(/\/s\/claude-code\/[0-9a-f-]{36}$/, { timeout: 20_000 });

  const bubble = page.locator(".page.session blockquote", { hasText: "Make the header match these two." }).last();
  await expect(page.locator(".page.session.starting")).toBeVisible();
  await expect(bubble.locator("[data-sent-picture]")).toHaveCount(2);
  await expect.poll(() => drawn(bubble)).toEqual([64, 80]);

  await expect(page.locator(".page.session:not(.starting)")).toBeVisible({ timeout: 20_000 });
  await expect(bubble.locator(".prompt-via")).toContainText("Sent from", { timeout: 20_000 });
  await expect(bubble.locator("[data-sent-picture]")).toHaveCount(2);
  await expect.poll(() => drawn(bubble)).toEqual([64, 80]);
  await noPathsDrawn(page);

  await page.reload();
  const again = page.locator(".page.session blockquote", { hasText: "Make the header match these two." }).last();
  await expect(again.locator(".prompt-via")).toContainText("Sent from");
  await expect.poll(() => drawn(again)).toEqual([64, 80]);
  await noPathsDrawn(page);
});

test("the row of a message that went to a copy of the session shows its pictures, also after a reload", async ({
  context,
  page,
  isMobile,
}) => {
  const copy = `claude-code:${randomUUID()}`;
  await open(context, page, {
    takes: true,
    title: "Sent to a copy",
    script: () => ({
      pauseMs: 300,
      events: false,
      acks: [
        { outcome: "taken", mode: "fork" },
        { outcome: "delivered", mode: "fork", session: copy, detail: "the session was busy" },
      ],
    }),
  });
  await picker(page).setInputFiles({ name: "kiwi.png", mimeType: "image/png", buffer: KIWI });
  await expect(tray(page)).toHaveAttribute("data-state", "ready");
  await composer(page).fill("And this one?");
  await send(page).click();
  const row = page.locator(".ctl-act", { hasText: "And this one?" });
  await expect(row.locator(".ctl-act-copy")).toBeVisible({ timeout: 20_000 });
  await expect(row.locator("[data-sent-picture]")).toHaveCount(1);
  // Under the composer, which on a phone may be below the fold: a thumbnail loads in view.
  await row.scrollIntoViewIfNeeded();
  await expect.poll(() => drawn(row)).toEqual([64]);
  // Under a finger the row's small thumbnail is a 44 px target.
  if (isMobile) {
    const hit = await hitBox(row.locator("[data-sent-picture]"));
    expect(hit.right - hit.left).toBeGreaterThanOrEqual(42);
    expect(hit.bottom - hit.top).toBeGreaterThanOrEqual(42);
  }
  await page.reload();
  await expect(row.locator("[data-sent-picture]")).toHaveCount(1);
  await row.scrollIntoViewIfNeeded();
  await expect.poll(() => drawn(row)).toEqual([64]);
});

const FILES_ROUTE = "**/api/ui/control/files?*";
const line = (page: Page) => page.locator(".att-note");
const retryOf = (page: Page) => tray(page).getByRole("button", { name: "Try again" });

test("an upload that fails says why in words; Retry sends the same bytes again; Send is off until then", async ({
  context,
  page,
}) => {
  const { d, board } = await open(context, page, { takes: true, title: "Uploads that fail" });
  expect(board.length).toBeGreaterThan(0);
  // The network fails: the receiver can't be reached.
  await page.route(FILES_ROUTE, (route) => route.abort("connectionrefused"));
  await paste(page, [given("image.png", KIWI)]);
  await expect(tray(page)).toHaveAttribute("data-state", "error");
  await expect(line(page)).toHaveText(`The picture didn't upload: ${board} can't be reached. Try again.`);
  await composer(page).fill("What colour is it?");
  await expect(send(page)).toBeDisabled();
  await expect(send(page)).toHaveAttribute("data-tip", "Remove or retry the picture that didn't upload.");
  await shots(page, "6-upload-failed-retry");
  // Retry, now that it can be reached: the same picture, under the same name.
  await page.unroute(FILES_ROUTE);
  await retryOf(page).click();
  await expect(tray(page)).toHaveAttribute("data-state", "ready");
  await expect(line(page)).toHaveCount(0);
  await expect(send(page)).toBeEnabled();
  await send(page).click();
  await expect.poll(() => prompts(d).length, { timeout: 20_000 }).toBe(1);
  expect(prompts(d)[0]!.files).toEqual([entry("image.png", KIWI)]);

  // The receiver's answers, each in its words; Retry only where trying again can help.
  const answers: { status: number; json: object; headers?: Record<string, string>; words: string; retry: boolean }[] = [
    { status: 500, json: { reason: "internal" }, words: `${board} couldn't save the picture. Try again.`, retry: true },
    {
      status: 507,
      json: { reason: "full", error: "Too many files are held here; try again tomorrow." },
      words: `${board} has no room for more files today.`,
      retry: false,
    },
    {
      status: 429,
      json: { reason: "rate_limited" },
      headers: { "retry-after": "300" },
      words: "That's a lot of pictures in a short time. Try again in 5 minutes.",
      // Not until the five minutes are over (the next test).
      retry: false,
    },
  ];
  for (const a of answers) {
    await page.route(FILES_ROUTE, (route) =>
      route.fulfill({ status: a.status, json: a.json, ...(a.headers ? { headers: a.headers } : {}) }),
    );
    await paste(page, [given("image.png", BIRCH)]);
    await expect(tray(page)).toHaveAttribute("data-state", "error");
    await expect(line(page)).toHaveText(a.words);
    await expect(retryOf(page)).toHaveCount(a.retry ? 1 : 0);
    // Send says what to do: retry only where Retry is there.
    await expect(send(page)).toHaveAttribute(
      "data-tip",
      a.retry ? "Remove or retry the picture that didn't upload." : "Remove the picture that didn't upload.",
    );
    await tray(page).getByRole("button", { name: "Remove picture" }).click();
    await expect(tray(page)).toHaveCount(0);
    await page.unroute(FILES_ROUTE);
  }
  expect(prompts(d)).toHaveLength(1);
});

test("too many pictures at once: Retry comes back only once the wait the words say is over", async ({
  context,
  page,
}) => {
  // The page's clock, moved on by hand (nothing is signed on it here).
  await page.clock.install();
  await open(context, page, { takes: true, title: "Too many at once" });
  await page.route(FILES_ROUTE, (route) =>
    route.fulfill({ status: 429, json: { reason: "rate_limited" }, headers: { "retry-after": "300" } }),
  );
  await paste(page, [given("image.png", KIWI)]);
  await expect(tray(page)).toHaveAttribute("data-state", "error");
  await expect(line(page)).toHaveText("That's a lot of pictures in a short time. Try again in 5 minutes.");
  // Only × until then: a Retry now would only be refused again.
  await expect(retryOf(page)).toHaveCount(0);
  await expect(tray(page).getByRole("button", { name: "Remove picture" })).toBeVisible();
  await composer(page).fill("And this one?");
  await expect(send(page)).toHaveAttribute("data-tip", "Remove the picture that didn't upload.");
  await page.clock.fastForward("04:50");
  await expect(retryOf(page)).toHaveCount(0);
  await page.clock.fastForward("00:15");
  await expect(retryOf(page)).toHaveCount(1);
  await expect(send(page)).toHaveAttribute("data-tip", "Remove or retry the picture that didn't upload.");
  // The words stay as they were; Retry now goes.
  await expect(line(page)).toHaveText("That's a lot of pictures in a short time. Try again in 5 minutes.");
  await page.unroute(FILES_ROUTE);
  await retryOf(page).click();
  await expect(tray(page)).toHaveAttribute("data-state", "ready");
  await expect(send(page)).toBeEnabled();
});

test("Send while a picture uploads says it waits for it, and the line goes once the upload is in", async ({
  context,
  page,
}) => {
  const { d } = await open(context, page, { takes: true, title: "Send while it uploads" });
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(FILES_ROUTE, async (route) => {
    await held;
    await route.fulfill({ response: await route.fetch() });
  });
  await paste(page, [given("image.png", KIWI), given("image.png", BIRCH)]);
  await expect(page.locator(".att-item[data-state=uploading]")).toHaveCount(2);
  await composer(page).fill("Here are two");
  // Send is there to press: it waits for the uploads, and says so.
  await expect(send(page)).toBeEnabled();
  await send(page).click();
  await expect(page.locator("[data-upload-line]")).toHaveText("Waiting for 2 pictures to finish uploading.");
  await shots(page, "7-send-waits-for-uploads");
  release();
  await expect(page.locator(".att-item[data-state=ready]")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator("[data-upload-line]")).toHaveCount(0);
  await expect(line(page)).toHaveCount(0);
  // Nothing went while they uploaded; the words are still there to send.
  expect(prompts(d)).toHaveLength(0);
  await expect(composer(page)).toHaveValue("Here are two");
  // Removing one while it uploads stops its upload.
  let aborted = false;
  await page.route(FILES_ROUTE, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await route.fulfill({ response: await route.fetch() });
    } catch {
      aborted = true;
    }
  });
  page.on("requestfailed", (r) => {
    if (r.url().includes("/api/ui/control/files")) aborted = true;
  });
  await paste(page, [given("image.png", ONYX)]);
  await expect(page.locator(".att-item[data-state=uploading]")).toHaveCount(1);
  await page.locator(".att-item[data-state=uploading]").getByRole("button", { name: "Remove picture" }).click();
  await expect(tray(page)).toHaveCount(2);
  await expect.poll(() => aborted, { timeout: 5_000 }).toBe(true);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a file dropped anywhere on the session's page comes to the composer; one that is no picture never opens", async ({
  context,
  page,
}) => {
  const { d } = await open(context, page, { takes: true, title: "Dropped on the conversation" });
  const here = page.url();
  /** Drag over the conversation (outside the composer), then drop there. */
  const onPage = (files: Given[]) =>
    page.evaluate(async (list) => {
      const dt = new DataTransfer();
      for (const f of list) {
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      const at = document.querySelector<HTMLElement>(".page.session .sess-title, .page.session h1, .page.session")!;
      const form = document.querySelector<HTMLFormElement>("form.ctl")!;
      if (form.contains(at)) throw new Error("not outside the composer");
      const over = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
      at.dispatchEvent(over);
      await new Promise((r) => setTimeout(r, 80));
      const highlighted = form.classList.contains("ctl--drop");
      const dropped = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
      at.dispatchEvent(dropped);
      return { over: over.defaultPrevented, dropped: dropped.defaultPrevented, highlighted };
    }, files);
  expect(await onPage([given("kiwi.png", KIWI)])).toEqual({ over: true, dropped: true, highlighted: true });
  await expect(page.locator("form.ctl")).not.toHaveClass(/ctl--drop/);
  await expect(tray(page)).toHaveCount(1);
  await expect(tray(page)).toHaveAttribute("data-state", "ready");
  await expect(tray(page)).toHaveAttribute("data-name", "kiwi.png");
  // A text file: taken from the browser, which would open it, and said to be no picture.
  const notes = given("notes.txt", Buffer.from("the date picker is off by one\n"), "text/plain");
  expect(await onPage([notes])).toEqual({ over: true, dropped: true, highlighted: true });
  await expect(line(page)).toHaveText("Only pictures can be dropped here.");
  await expect(tray(page)).toHaveCount(1);
  expect(page.url()).toBe(here);
  await shots(page, "8-only-pictures-dropped");
  // A picture and a text file at once: the picture comes, the line says the other didn't,
  // and goes once the picture is in.
  await tray(page).getByRole("button", { name: "Remove picture" }).click();
  await page.route("**/api/ui/control/files?*", async (route: Route) => {
    await new Promise((r) => setTimeout(r, 600));
    await route.fulfill({ response: await route.fetch() });
  });
  expect(await onPage([given("birch.png", BIRCH), notes])).toEqual({ over: true, dropped: true, highlighted: true });
  await expect(line(page)).toHaveText("Only pictures can be dropped here.");
  await expect(tray(page)).toHaveAttribute("data-state", "ready");
  await expect(line(page)).toHaveCount(0);
  expect(prompts(d)).toHaveLength(0);
});

test("a reload keeps the pictures of the draft with its words, and they still go", async ({ context, page }) => {
  // Two page loads and a send.
  test.slow();
  const { d } = await open(context, page, { takes: true, title: "A draft with pictures" });
  await paste(page, [given("image.png", KIWI), given("image.png", BIRCH)]);
  await expect(page.locator(".att-item[data-state=ready]")).toHaveCount(2);
  await composer(page).fill("Which one is lighter?");
  // The words are kept 300 ms after the last key, the pictures once they are in.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const kept = (prefix: string) =>
          Object.keys(localStorage)
            .filter((k) => k.startsWith(prefix))
            .map((k) => localStorage.getItem(k));
        return {
          words: kept("sessionpipe-gui.draft:"),
          pictures: kept("sessionpipe-gui.draft-pictures:").map((v) => (JSON.parse(v ?? "[]") as unknown[]).length),
        };
      }),
    )
    .toEqual({ words: ["Which one is lighter?"], pictures: [2] });
  // A receiver that can't show its copy of one (an older one, say) still draws its frame.
  await page.route(`**/api/ui/control/files/${sha(BIRCH)}`, (route) => route.fulfill({ status: 404 }));
  await page.reload();
  await expect(composer(page)).toBeEnabled();
  await expect(composer(page)).toHaveValue("Which one is lighter?");
  await expect(tray(page)).toHaveCount(2);
  for (const i of [0, 1]) {
    await expect(tray(page).nth(i)).toHaveAttribute("data-state", "ready");
    await expect(tray(page).nth(i)).toHaveAttribute("data-restored", "");
  }
  await expect(tray(page).nth(0)).toHaveAttribute("data-name", "image.png");
  await expect(tray(page).nth(1)).toHaveAttribute("data-name", "image-2.png");
  // Each thumbnail is the receiver's copy, by its hash.
  await expect(tray(page).nth(0).locator("img")).toHaveAttribute("src", `/api/ui/control/files/${sha(KIWI)}`);
  await expect(tray(page).nth(1).locator("img")).toHaveAttribute("data-broken", "");
  await framed(tray(page).nth(1));
  await shots(page, "9-draft-kept-after-reload");
  await send(page).click();
  await expect.poll(() => prompts(d).length, { timeout: 20_000 }).toBe(1);
  expect(prompts(d)[0]!.text).toBe("Which one is lighter?");
  expect(prompts(d)[0]!.files).toEqual([entry("image.png", KIWI), entry("image-2.png", BIRCH)]);
  // The machine fetches them after it took the command: both, whole.
  await expect.poll(() => d.fetched.map((f) => f.ok)).toEqual([true, true]);
  // Sent: the draft is gone, pictures and all.
  await expect(tray(page)).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.reload();
  await expect(composer(page)).toBeEnabled();
  await expect(tray(page)).toHaveCount(0);
});

test("a picture still uploading when another session opens lands in its own session's draft", async ({
  context,
  page,
}) => {
  test.slow();
  const { d, s } = await open(context, page, { takes: true, title: "Left while uploading" });
  const other = await postSession(await sinkToken(), { machine: d.name, cwd: CWD, title: "The other session" });
  const go = (to: { harness: string; id: string }) =>
    page.evaluate(
      (url) => {
        history.pushState(null, "", url);
        dispatchEvent(new PopStateEvent("popstate"));
      },
      sessionUrl(to.harness, to.id),
    );
  const keptHere = () =>
    page.evaluate((id) => {
      const k = Object.keys(localStorage).find(
        (k) => k.startsWith("sessionpipe-gui.draft-pictures:") && k.includes(id),
      );
      return k ? (JSON.parse(localStorage.getItem(k) ?? "[]") as { name: string }[]).map((p) => p.name) : [];
    }, s.id);
  // Each upload takes its time: the first is in while the other session is open, the
  // second only once this one is open again.
  const waits = [800, 3500];
  await page.route("**/api/ui/control/files?*", async (route: Route) => {
    await new Promise((r) => setTimeout(r, waits.shift() ?? 0));
    await route.fulfill({ response: await route.fetch() });
  });
  await paste(page, [given("image.png", KIWI), given("image.png", BIRCH)]);
  await expect(page.locator(".att-item[data-state=uploading]")).toHaveCount(2);
  await go(other);
  await expect(page.locator(".page.session")).toContainText("The other session");
  await expect(tray(page)).toHaveCount(0);
  await expect.poll(keptHere, { timeout: 10_000 }).toEqual(["image.png"]);
  await go(s);
  await expect(page.locator(".page.session")).toContainText("Left while uploading");
  await expect(tray(page)).toHaveCount(1);
  await expect(tray(page)).toHaveCount(2, { timeout: 15_000 });
  for (const i of [0, 1]) await expect(tray(page).nth(i)).toHaveAttribute("data-state", "ready");
  await expect.poll(keptHere).toEqual(["image.png", "image-2.png"]);
  await send(page).click();
  await expect.poll(() => prompts(d).length, { timeout: 20_000 }).toBe(1);
  expect(prompts(d)[0]!.files).toEqual([entry("image.png", KIWI), entry("image-2.png", BIRCH)]);
});

test("on a slow link (2 Mbit/s) the tray says how far the upload is", async ({ context, page }) => {
  // Noise is made smaller to a WebP of about 1 MB, which at 2 Mbit/s is some seconds by itself.
  test.slow();
  const { d } = await open(context, page, { takes: true, title: "A slow link" });
  const big = noisePng(1240, 1200);
  expect(big.length).toBeGreaterThan(4_000_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: 250_000,
    uploadThroughput: 250_000,
  });
  await picker(page).setInputFiles({ name: "noise.png", mimeType: "image/png", buffer: big });
  const going = page.locator("[data-upload-line]");
  // How far, in the size that goes (the WebP, not the 4 MB the page was given).
  await expect(going).toHaveText(/^Uploading [\d.]+ of [\d.]+ (KB|MB)…$/, { timeout: 30_000 });
  const first = await going.textContent();
  const [, n, unit] = /of ([\d.]+) (KB|MB)/.exec(first ?? "")!;
  expect(Number(n) * (unit === "MB" ? 1024 * 1024 : 1024)).toBeLessThan(big.length / 2);
  await shots(page, "10-upload-progress");
  await expect.poll(async () => (await going.textContent()) ?? "", { timeout: 15_000 }).not.toBe(first);
  await expect(tray(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(going).toHaveCount(0);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  expect(prompts(d)).toHaveLength(0);
});

/** Each picture's frame as drawn: its size, rounded, and how the picture fits it. */
function frames(scope: ReturnType<Page["locator"]>): Promise<{ w: number; h: number; fit: string }[]> {
  return scope.evaluateAll((imgs) =>
    imgs.map((i) => {
      const r = i.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), fit: getComputedStyle(i).objectFit };
    }),
  );
}

test("a picture is whole in the tray and the message, and a sent one opens whole in the page: the arrows move, Esc, a tap outside and × close it", async ({
  context,
  page,
  isMobile,
}) => {
  const { d } = await open(context, page, { takes: true, title: "Whole pictures" });
  // A 4:3 photo and a 16:9 screenshot: each frame the picture's shape, within 120×88
  // (in a phone's tray, within 88×64).
  const FOUR_THREE = png(640, 480, [0xd9, 0x3a, 0x2b]);
  const WIDE = png(960, 540, [0x2a, 0x4d, 0x8f]);
  const whole = [
    { w: 117, h: 88, fit: "contain" },
    { w: 120, h: 68, fit: "contain" },
  ];
  const inTray = isMobile
    ? [
        { w: 85, h: 64, fit: "contain" },
        { w: 88, h: 50, fit: "contain" },
      ]
    : whole;
  await picker(page).setInputFiles([
    { name: "four-three.png", mimeType: "image/png", buffer: FOUR_THREE },
    { name: "wide.png", mimeType: "image/png", buffer: WIDE },
  ]);
  await expect(page.locator(".att-item[data-state=ready]")).toHaveCount(2);
  await expect.poll(() => frames(page.locator(".att-thumb"))).toEqual(inTray);
  await shots(page, "11-whole-pictures-in-the-tray");
  await composer(page).fill("Which of the two is wider?");
  await send(page).click();
  await expect.poll(() => prompts(d).length, { timeout: 20_000 }).toBe(1);
  const bubble = page.locator(".page.session blockquote", { hasText: "Which of the two is wider?" }).last();
  const thumbs = bubble.locator("[data-sent-picture]");
  await expect(thumbs).toHaveCount(2);
  await expect.poll(() => drawn(bubble)).toEqual([640, 960]);
  await expect.poll(() => frames(bubble.locator("[data-sent-picture] img"))).toEqual(whole);
  // The picture's name is the link's; no words are drawn inside its frame.
  await expect(thumbs.first()).toHaveAttribute("aria-label", `four-three.png · PNG · ${humanSize(FOUR_THREE.length)}`);
  await expect(thumbs.first().locator("img")).toHaveAttribute("alt", "");

  const tabs: Page[] = [];
  context.on("page", (p) => tabs.push(p));
  const url = page.url();
  const box = page.locator("[data-lightbox]");
  const src = (i: number) => thumbs.nth(i).locator("img").getAttribute("src");
  await thumbs.first().click();
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute("role", "dialog");
  await expect(box).toHaveAttribute("aria-label", "four-three.png");
  await expect(box.locator(".lb-img")).toHaveAttribute("src", (await src(0))!);
  await expect(box.locator(".lb-count")).toHaveText("1 of 2");
  await shots(page, "12-lightbox");
  // The arrows move through the message's pictures, and round.
  await page.keyboard.press("ArrowRight");
  await expect(box).toHaveAttribute("aria-label", "wide.png");
  await expect(box.locator(".lb-img")).toHaveAttribute("src", (await src(1))!);
  await expect(box.locator(".lb-count")).toHaveText("2 of 2");
  await page.keyboard.press("ArrowRight");
  await expect(box.locator(".lb-count")).toHaveText("1 of 2");
  await page.keyboard.press("ArrowLeft");
  await expect(box.locator(".lb-count")).toHaveText("2 of 2");
  // Esc closes it, and only it: the page stays where it was.
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  expect(page.url()).toBe(url);
  // A tap outside the picture.
  await thumbs.nth(1).click();
  await expect(box).toHaveAttribute("aria-label", "wide.png");
  await box.click({ position: { x: 4, y: 200 } });
  await expect(box).toHaveCount(0);
  // ×, and the chevrons.
  await thumbs.first().click();
  await box.getByRole("button", { name: "Next picture" }).click();
  await expect(box.locator(".lb-count")).toHaveText("2 of 2");
  if (isMobile) {
    // Under a finger each is 44 px, on a tablet as on a phone.
    for (const size of [
      { width: 834, height: 1112 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      for (const name of ["Close", "Previous picture", "Next picture"]) {
        const b = await box.getByRole("button", { name }).boundingBox();
        expect([size.width, name, Math.round(b!.width), Math.round(b!.height)]).toEqual([size.width, name, 44, 44]);
      }
    }
  }
  await box.getByRole("button", { name: "Close" }).click();
  await expect(box).toHaveCount(0);
  // No tab was opened, and nothing left the page.
  expect(tabs).toHaveLength(0);
  expect(page.url()).toBe(url);
});

test("a phone's browser on the board's plain-http LAN or tailnet address is told the app, /connect or HTTPS, also beside the greyed paperclip", async ({
  context,
  page,
  isMobile,
}) => {
  const { s } = await open(context, page, { takes: true, title: "From the Wi-Fi" });
  const info = (await (await fetch(`${CONTROL_BASE}/api/ui/info`)).json()) as {
    uiKey: string;
    urls: { lan: string[] };
  };
  const lan = info.urls.lan.find((u) => u.startsWith("http:"));
  test.skip(!lan, "this machine reports no LAN IPv4 address (GET /api/ui/info urls.lan is empty)");
  // A board with no TLS mode and no other address to send from, as a receiver started
  // without --tls is.
  await page.route("**/api/ui/info", async (route: Route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { control?: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { ...json, tls: null, remote: null, control: { ...json.control, origins: [] } },
    });
  });
  const lanOrigin = new URL(lan!).origin;
  await page.goto(`${lanOrigin}${sessionUrl(s.harness, s.id)}?k=${info.uiKey}`);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  await expect(composer(page)).toBeDisabled();
  const foot = page.locator(".ctl-foot");
  const clip = page.locator(".att-btn");
  await expect(clip).toHaveAttribute("aria-disabled", "true");
  if (isMobile) {
    const words =
      "To send from this phone, use the sessionpipe app (scan the code on /connect) or open this board over HTTPS (start it with --tls).";
    await expect(foot).toHaveAttribute("data-reason", "phone-http");
    await expect(foot.locator(".ctl-hint")).toHaveText(words);
    await expect(foot.getByRole("link", { name: "/connect" })).toHaveAttribute("href", "/connect");
    await expect(clip).toHaveAttribute("title", words);
    await shots(page, "13-phone-on-plain-http");
  } else {
    // A computer's browser keeps the passkey's words.
    await expect(foot).toHaveAttribute("data-reason", "blocked");
    await expect(foot.locator(".ctl-hint")).toContainText(/passkeys need https or localhost/);
    await expect(clip).toHaveAttribute("title", "Attach pictures");
  }
});

test("an agent's reply of three lines is drawn as three lines", async ({ context, page }) => {
  await seenSetupHere(context);
  const sink = await sinkToken();
  const id = randomUUID();
  let seq = 0;
  let clock = Date.now() - 60_000;
  const ev = (type: string, data: Record<string, unknown>, hook: string) => {
    clock += 500;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 2,
      harness: { name: "claude-code", version: "2.1.296", event: hook },
      session: { id, seq: seq++, machine: `lines-${tag()}`, cwd: CWD, title: "Three lines", title_source: "custom" },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const reply = "Purple, Iris\nGreen, Thyme\nBrown, Copper";
  await fetch(`${CONTROL_BASE}/api/sessionpipe/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sink}`, "sessionpipe-protocol": "1" },
    body: JSON.stringify({
      events: [
        ev("session.started", { source: "startup" }, "SessionStart"),
        ev("turn.started", { turn_id: "t1", prompt_chars: 30 }, "UserPromptSubmit"),
        ev(
          "turn.transcript",
          { turn: 1, turn_id: "t1", user: "Name each colour and a word.", assistant: reply },
          "Stop",
        ),
        ev("turn.ended", { turn_id: "t1", reason: "stop", ms: 900 }, "Stop"),
      ],
    }),
  });
  await page.goto(`${CONTROL_BASE}${sessionUrl("claude-code", id)}`);
  const said = page.locator(".page.session .md p", { hasText: "Purple, Iris" }).first();
  await expect(said).toBeVisible();
  await expect(said.locator("br")).toHaveCount(2);
  // Each line its own text, a <br> between.
  const lines = await said.evaluate((p) =>
    Array.from(p.childNodes, (n) => (n.nodeName === "BR" ? "\n" : n.textContent)).join(""),
  );
  expect(lines).toBe("Purple, Iris\nGreen, Thyme\nBrown, Copper");
});

/** Where a tap lands on `button`, read as the page answers it: from the button's centre
 *  outwards along each axis, every point whose hit is the button (its target, cut by
 *  whatever covers or clips it). */
async function hitBox(button: Locator): Promise<{ left: number; right: number; top: number; bottom: number }> {
  await button.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
  // Where it rests, on the screen: a sheet still rising holds it below.
  const tall = button.page().viewportSize()!.height;
  await expect
    .poll(async () => {
      const a = await button.boundingBox();
      await new Promise((r) => setTimeout(r, 150));
      const b = await button.boundingBox();
      return !!a && !!b && a.y === b.y && b.y > 0 && b.y + b.height < tall;
    })
    .toBe(true);
  return button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const mine = (x: number, y: number) => {
      const at = document.elementFromPoint(x, y);
      return !!at && (at === el || el.contains(at));
    };
    const reach = (dx: number, dy: number) => {
      let n = 0;
      while (n < 80 && mine(cx + dx * (n + 1), cy + dy * (n + 1))) n++;
      return n;
    };
    return { left: cx - reach(-1, 0), right: cx + reach(1, 0), top: cy - reach(0, -1), bottom: cy + reach(0, 1) };
  });
}

async function apartAndBig(a: Locator, b: Locator): Promise<void> {
  const x = await hitBox(a);
  const y = await hitBox(b);
  for (const h of [x, y]) {
    // Read a pixel at a time from the centre: a 44 px target reads 42 or more.
    expect(h.right - h.left, JSON.stringify(h)).toBeGreaterThanOrEqual(42);
    expect(h.bottom - h.top, JSON.stringify(h)).toBeGreaterThanOrEqual(42);
  }
  const overlap = x.left < y.right && y.left < x.right && x.top < y.bottom && y.top < x.bottom;
  expect(overlap, `${JSON.stringify(x)} ${JSON.stringify(y)}`).toBe(false);
}

test("under a finger, Try again and × are each a 44 px target, and the two never overlap", async ({
  context,
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "a touch screen's targets");
  const { d } = await open(context, page, { takes: true, title: "Targets under a finger" });
  await page.route(FILES_ROUTE, (route) => route.fulfill({ status: 500, json: { reason: "internal" } }));
  // A panorama, whose frame is the shortest there is, and an ordinary one.
  for (const [name, b] of [
    ["wide.png", png(400, 100, [0x30, 0x60, 0x90])],
    ["image.png", KIWI],
  ] as const) {
    await paste(page, [given(name, b)]);
    const item = tray(page).last();
    await expect(item).toHaveAttribute("data-state", "error");
    await apartAndBig(
      item.getByRole("button", { name: "Try again" }),
      item.getByRole("button", { name: "Remove picture" }),
    );
  }
  await page.unroute(FILES_ROUTE);

  // New session's file chip.
  await page.goto(`${CONTROL_BASE}/?new=1&machine=${d.name}`);
  const sheet = page.locator("[data-new-session]");
  await expect(sheet.locator("input[data-ns-files]")).toBeAttached();
  await page.route(FILES_ROUTE, (route) => route.fulfill({ status: 500, json: { reason: "internal" } }));
  await sheet
    .locator("input[data-ns-files]")
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("off by one\n") });
  const chip = sheet.locator(".ns-file");
  await expect(chip).toHaveAttribute("data-file-state", "error");
  await apartAndBig(
    chip.getByRole("button", { name: "Try notes.txt again" }),
    chip.getByRole("button", { name: "Remove notes.txt" }),
  );
  // Nor does × reach into the chip beside it.
  await sheet
    .locator("input[data-ns-files]")
    .setInputFiles({ name: "todo.txt", mimeType: "text/plain", buffer: Buffer.from("ship it\n") });
  await expect(chip).toHaveCount(2);
  const x = await hitBox(chip.first().getByRole("button", { name: "Remove notes.txt" }));
  const next = (await chip.nth(1).boundingBox())!;
  expect(x.right, `${JSON.stringify(x)} ${JSON.stringify(next)}`).toBeLessThanOrEqual(next.x + 1);
  await page.unroute(FILES_ROUTE);
});

test("on a phone the tray is one row that scrolls sideways, and the conversation keeps its room", async ({
  context,
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "a phone's tray");
  await open(context, page, { takes: true, title: "A phone's tray" });
  await picker(page).setInputFiles(
    SEVEN.slice(0, 6).map((b, i) => ({ name: `shot-${i + 1}.png`, mimeType: "image/png", buffer: b })),
  );
  await expect(page.locator(".att-item[data-state=ready]")).toHaveCount(6);
  const row = page.locator(".att-tray");
  const tops = await tray(page).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  const scroll = await row.evaluate((el) => ({ width: el.scrollWidth, shown: el.clientWidth }));
  expect(scroll.width).toBeGreaterThan(scroll.shown);
  // Each frame within 88×64, so the tray stays one row's height.
  for (const f of await frames(page.locator(".att-thumb"))) {
    expect(f.w).toBeLessThanOrEqual(88);
    expect(f.h).toBeLessThanOrEqual(64);
  }
  const field = await page.locator(".ctl-field").boundingBox();
  expect(field!.height).toBeLessThan(200);
  // Scrolled part way, the row still ends inside the field's border, on both sides.
  await row.evaluate((el) => {
    el.scrollLeft = 120;
  });
  const inside = () =>
    page.evaluate(() => {
      const f = document.querySelector(".ctl-field")!.getBoundingClientRect();
      const r = document.querySelector(".att-tray")!.getBoundingClientRect();
      return r.left >= f.left + 1 && r.right <= f.right - 1;
    });
  expect(await inside()).toBe(true);
  // The last picture's × keeps its whole target at the row's end.
  const last = tray(page).last().getByRole("button", { name: "Remove picture" });
  const hit = await hitBox(last);
  expect(hit.right - hit.left, JSON.stringify(hit)).toBeGreaterThanOrEqual(42);
  expect(hit.bottom - hit.top, JSON.stringify(hit)).toBeGreaterThanOrEqual(42);
  // A tablet held sideways keeps the one row: no picture's buttons over a row below.
  await page.setViewportSize({ width: 1180, height: 820 });
  const wide = await tray(page).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(wide).size).toBe(1);
  expect(await inside()).toBe(true);
});

/** The page's decoder made slow, so a picture is seen being made smaller. */
const slowDecode = (page: Page, ms: number) =>
  page.evaluate((ms) => {
    const own = window.createImageBitmap.bind(window);
    window.createImageBitmap = (async (...a: Parameters<typeof createImageBitmap>) => {
      await new Promise((r) => setTimeout(r, ms));
      return own(...a);
    }) as typeof createImageBitmap;
  }, ms);

test("a picture being made smaller says so in the tray's line, not only in a tooltip", async ({ context, page }) => {
  await open(context, page, { takes: true, title: "Made smaller, said" });
  await slowDecode(page, 2000);
  await pasteDrawn(page, { name: "IMG_0412.jpg", type: "image/jpeg", width: 4032, height: 3024, padTo: 5_000_000 });
  await expect(tray(page)).toHaveAttribute("data-state", "shrinking");
  await expect(trayLine(page)).toHaveText("Making it smaller…");
  await expect(trayLine(page)).toHaveAttribute("role", "status");
  await expect(tray(page)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(trayLine(page)).toHaveCount(0);
});
