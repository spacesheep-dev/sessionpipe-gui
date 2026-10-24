// SPDX-License-Identifier: Apache-2.0
// Images beside a prompt, end to end (control/Attachments.tsx, server/ui/attachments.ts):
// the same built server on a free port and virtual-passkey pairing as control.spec.ts,
// with the fake daemon named after this machine, so the prompt's block carries absolute
// paths. Paste → thumbnail → send → the daemon's polled `cmd.text` ends with the block
// and the file is on disk; drag and drop; a 9 MB image refused; the Session view draws
// the sent prompt's thumbnail.
//
//   node scripts/build.mjs && npx vite build --config web/vite.config.ts
//   npx playwright test -c web/e2e/playwright.config.ts attach
//
// ATTACH_SHOTS=<dir> also writes screenshots of the composer (desktop + 390 px).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const CONTROL = "/api/sessionpipe/v1/control";
const EVENTS = "/api/sessionpipe/v1/events";
const SHOTS = process.env.ATTACH_SHOTS;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(t = Date.now()): string {
  let time = "";
  let n = t;
  for (let i = 0; i < 10; i++) {
    time = B32[n % 32] + time;
    n = Math.floor(n / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) rand += B32[Math.floor(Math.random() * 32)];
  return time + rand;
}

// ---------- a real PNG of one colour, so the browser can draw the thumbnail ----------

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
function png(width: number, height: number, rgb: [number, number, number]): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) {
    // A soft diagonal gradient, so the thumbnail reads as a picture and not a swatch.
    const k = Math.round((x / width) * 40);
    row.set([rgb[0] - k, rgb[1] - k, rgb[2]], 1 + x * 3);
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

/** The machine's daemon, as far as this test needs it. */
class Daemon {
  machine = "";
  token = "";
  constructor(
    readonly base: string,
    readonly sinkToken: string,
    readonly name: string,
  ) {}
  private facts() {
    return {
      name: this.name,
      harnesses: ["claude-code"],
      modes: ["sdk", "resume"],
      version: "0.7.0",
      folders: ["/tmp/proj"],
      mode: "safe",
    };
  }
  async pair(): Promise<{ machine: string; code: string; check: string }> {
    const res = await fetch(`${this.base}${CONTROL}/pair`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.sinkToken}`, "content-type": "application/json" },
      body: JSON.stringify(this.facts()),
    });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { machine: string; code: string; check: string };
    this.machine = j.machine;
    return j;
  }
  async pairStatus(code: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}${CONTROL}/pair?code=${encodeURIComponent(code)}`, {
      headers: { authorization: `Bearer ${this.sinkToken}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }
  async hello(): Promise<void> {
    const res = await fetch(`${this.base}${CONTROL}/hello`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...this.facts(), waiting: [] }),
    });
    expect(res.status).toBe(204);
  }
  async poll(waitS = 1): Promise<Record<string, unknown>[]> {
    const res = await fetch(`${this.base}${CONTROL}?machine=${this.machine}&wait=${waitS}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (res.status === 204) return [];
    expect(res.status).toBe(200);
    return ((await res.json()) as { messages: Record<string, unknown>[] }).messages;
  }
  async next(): Promise<{ id: string; cmd: Record<string, unknown> }> {
    for (let i = 0; i < 20; i++) {
      const msgs = await this.poll(1);
      if (msgs.length) {
        const m = msgs[msgs.length - 1]!;
        return { id: m.id as string, cmd: JSON.parse(m.cmd as string) as Record<string, unknown> };
      }
    }
    throw new Error("no message reached the daemon");
  }
  async ack(id: string, outcome: string, extra: Record<string, unknown> = {}): Promise<void> {
    const res = await fetch(`${this.base}${CONTROL}/ack`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ acks: [{ id, outcome, at: new Date().toISOString(), mode: "sdk", ...extra }] }),
    });
    expect(res.status).toBe(202);
  }
}

/** One session's events, posted to the receiver like a sink would. */
class Events {
  seq = 0;
  constructor(
    readonly base: string,
    readonly sinkToken: string,
    readonly sid: string,
    readonly machine: string,
  ) {}
  ev(type: string, data: Record<string, unknown> = {}) {
    const t = Date.now() - 5000 + this.seq;
    return {
      protocol: 1,
      id: ulid(t),
      type,
      time: new Date(t).toISOString(),
      tier: 3,
      harness: { name: "claude-code", version: "2.1.296", event: "Hook" },
      session: { id: this.sid, seq: this.seq++, machine: this.machine, cwd: "/tmp/proj", title: "Attach e2e" },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  }
  async post(...events: ReturnType<Events["ev"]>[]): Promise<void> {
    const res = await fetch(`${this.base}${EVENTS}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.sinkToken}`,
        "content-type": "application/json",
        "sessionpipe-protocol": "1",
      },
      body: JSON.stringify({ events }),
    });
    expect([200, 202]).toContain(res.status);
  }
}

async function shot(page: Page, name: string, selector?: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${name}.png`);
  if (selector) await page.locator(selector).screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: false });
}

async function virtualPasskey(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

interface Img {
  name: string;
  type: string;
  base64: string;
  /** Pad the file to this many bytes (a big file, without a big base64 string). */
  padTo?: number;
}

/** Paste `files` into the textarea: a ClipboardEvent with a DataTransfer that carries them. */
async function paste(page: Page, files: Img[]): Promise<void> {
  await page.evaluate((imgs: Img[]) => {
    const toFile = (i: Img) => {
      const bin = atob(i.base64);
      const bytes = new Uint8Array(i.padTo ? Math.max(i.padTo, bin.length) : bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      return new File([bytes], i.name, { type: i.type });
    };
    const dt = new DataTransfer();
    for (const i of imgs) dt.items.add(toFile(i));
    const box = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message for the next turn"]')!;
    let ev: ClipboardEvent;
    try {
      ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    } catch {
      ev = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    }
    if (!ev.clipboardData) Object.defineProperty(ev, "clipboardData", { value: dt });
    box.dispatchEvent(ev);
  }, files);
}

/** Drag `files` over the composer, then drop them. */
async function drop(page: Page, files: Img[]): Promise<void> {
  await page.evaluate(async (imgs: Img[]) => {
    const toFile = (i: Img) => {
      const bin = atob(i.base64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      return new File([bytes], i.name, { type: i.type });
    };
    const dt = new DataTransfer();
    for (const i of imgs) dt.items.add(toFile(i));
    const form = document.querySelector<HTMLFormElement>('form[aria-label="Control"]')!;
    form.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    // Let React paint the highlight before looking for it.
    await new Promise((r) => setTimeout(r, 60));
    (window as unknown as { __dropHighlighted: boolean }).__dropHighlighted = form.classList.contains("ctl--drop");
    form.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

test.describe.configure({ mode: "serial" });

let server: ChildProcess;
let base: string;
let stateDir: string;
let sinkToken: string;
let hostname: string;
let context: BrowserContext;
let page: Page;
let daemon: Daemon;
let events: Events;
const SID = "4e2b7c1d-9a3f-4f6e-8b21-7c5d2e9f0a11";
const SCREEN = png(1440, 900, [0x5a, 0x7a, 0xd0]);
const PHOTO = png(640, 480, [0xd0, 0x8a, 0x5a]);
/** The text test 1 sent, for the Session view test. */
let sentText = "";

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  for (const f of ["dist/cli.js", "dist/web/index.html"])
    if (!existsSync(path.join(root, f)))
      throw new Error(`${f} is missing: run node scripts/build.mjs && npx vite build --config web/vite.config.ts`);
  const port = await freePort();
  base = `http://localhost:${port}`;
  stateDir = mkdtempSync(path.join(os.tmpdir(), "spgui-attach-e2e-"));
  server = spawn(
    process.execPath,
    ["dist/cli.js", "--port", String(port), "--state", stateDir, "--no-outbox", "--test-door", "--quiet"],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
  );
  server.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
  const deadline = Date.now() + 20_000;
  let info: { sinkToken: string; hostname: string } | null = null;
  while (!info && Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/ui/info`);
      if (r.ok) info = (await r.json()) as { sinkToken: string; hostname: string };
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!info) throw new Error("the server did not come up");
  sinkToken = info.sinkToken;
  hostname = info.hostname;
  expect(hostname).toBeTruthy();
  // The daemon is this machine's: its name is what sessionpipe calls this host.
  daemon = new Daemon(base, sinkToken, hostname);
  events = new Events(base, sinkToken, SID, hostname);
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: base });
  page = await context.newPage();
  await virtualPasskey(context, page);

  // Pair with the passkey, collect the token, say hello.
  const started = await daemon.pair();
  await page.goto(`/pair?code=${encodeURIComponent(started.code)}`);
  await expect(page.locator("[data-check]")).toHaveAttribute("data-check", started.check);
  await page.getByRole("button", { name: "Approve with passkey" }).click();
  await expect(page.locator(".pair-note--ok")).toContainText("Approved", { timeout: 20_000 });
  const paired = (await daemon.pairStatus(started.code)) as { status: string; token: string };
  expect(paired.status).toBe("paired");
  daemon.token = paired.token;
  await daemon.hello();
  expect(await daemon.poll(0)).toEqual([]); // the first poll is what makes it "online"

  await events.post(
    events.ev("session.started", { source: "startup" }),
    events.ev("turn.started", { turn_id: "t1", prompt_chars: 12 }),
    events.ev("turn.ended", { reason: "stop", ms: 1200 }),
  );
});

test.afterAll(async () => {
  await context?.close();
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

test("a pasted screenshot becomes a thumbnail; the sent text ends with the block naming its path on disk", async () => {
  await page.goto(`/s/claude-code/${SID}`);
  const box = page.getByLabel("Message for the next turn");
  await expect(box).toBeEnabled();
  // Ready: the one line under the field is the day grant's (paired, trusted, online).
  await expect(page.locator(".ctl-foot[data-reason=passkey] .ctl-hint")).toHaveText(
    "The first send today asks for your passkey.",
  );
  await expect(page.getByLabel("Attach images")).toBeAttached();

  await box.fill("Make the header look like this");
  await paste(page, [{ name: "Screenshot.png", type: "image/png", base64: SCREEN }]);
  const item = page.locator(".att-item");
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  // Its name, size and bytes are the thumbnail's tooltip (no meta line under it).
  await expect(item).toHaveAttribute("title", /Screenshot\.png · 1440×900 · \d+ KB/);
  const id = await item.getAttribute("data-attachment");
  expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  // The pasted text did not land in the box.
  await expect(box).toHaveValue("Make the header look like this");
  await shot(page, "composer-thumbnail-desktop", ".sess-ctl");

  await box.press("Enter");
  // The message is drawn in the timeline where its turn will be, with its status row.
  const status = page.locator(".page.session .status-row[data-sent-state]").last();
  await expect(status).toHaveAttribute("data-sent-state", "queued", { timeout: 20_000 });
  await expect(box).toHaveValue("");
  await expect(page.locator(".att-item")).toHaveCount(0);

  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({ kind: "prompt", session: `claude-code:${SID}` });
  sentText = String(msg.cmd.text);
  const m =
    /^Make the header look like this\n\nAttached images \(open them with your file-reading tool\):\n- (\/\S+\/attachments\/([0-9A-HJKMNP-TV-Z]{26})\.png) \(1440×900\)$/.exec(
      sentText,
    );
  expect(m, sentText).not.toBeNull();
  expect(m![2]).toBe(id);
  expect(m![1]).toBe(path.join(stateDir, "attachments", `${id}.png`));
  expect(existsSync(m![1]!)).toBe(true);
  expect(sentText.length).toBeLessThanOrEqual(20_000);

  // The sent message shows its words and a thumbnail, not the block.
  const sent = page.locator(".page.session blockquote").last();
  await expect(sent).toContainText("Make the header look like this");
  await expect(sent).not.toContainText("Attached images");
  const thumb = sent.locator(".att-thumbs img");
  await expect(thumb).toHaveCount(1);
  await expect(thumb).toHaveAttribute("src", `/attachments/${id}.png`);
  await expect(sent.locator(".att-thumbs a")).toHaveAttribute("target", "_blank");
  expect(await thumb.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1440);
  await daemon.ack(msg.id, "delivered", { reply: "Matched the header." });
  await expect(status).toHaveAttribute("data-sent-state", "delivered");
  await shot(page, "activity-thumbnail-desktop", ".page.session");
});

test("dropped files highlight the composer and attach; × takes one back; images alone send as the block", async () => {
  await drop(page, [
    { name: "a.png", type: "image/png", base64: SCREEN },
    { name: "b.png", type: "image/png", base64: PHOTO },
  ]);
  expect(await page.evaluate(() => (window as unknown as { __dropHighlighted: boolean }).__dropHighlighted)).toBe(true);
  await expect(page.locator("form[aria-label='Control']")).not.toHaveClass(/ctl--drop/);
  const items = page.locator(".att-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await expect(items.nth(1)).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await expect(items.nth(1)).toHaveAttribute("title", / · 640×480 · /);
  const dropped = await items.nth(0).getAttribute("data-attachment");
  const kept = await items.nth(1).getAttribute("data-attachment");
  await shot(page, "composer-two-thumbnails-desktop", ".sess-ctl");

  await items.nth(0).getByRole("button", { name: "Remove image" }).click();
  await expect(items).toHaveCount(1);
  await expect.poll(async () => (await fetch(`${base}/attachments/${dropped}.png`)).status).toBe(404);
  expect((await fetch(`${base}/attachments/${kept}.png`)).status).toBe(200);

  // No words, one image: the block alone is the message.
  const send = page.locator("form[aria-label='Control'] button[type=submit]");
  await expect(send).toBeEnabled();
  await send.click();
  const msg = await daemon.next();
  expect(String(msg.cmd.text)).toBe(
    `Attached images (open them with your file-reading tool):\n- ${path.join(stateDir, "attachments", `${kept}.png`)} (640×480)`,
  );
  const sent = page.locator(".page.session blockquote").last();
  await expect(sent.locator(".att-thumbs img")).toHaveCount(1);
  await expect(sent).not.toContainText("Attached images");
  await daemon.ack(msg.id, "delivered");
});

test("a 9 MB image is refused before and at the server", async () => {
  await paste(page, [{ name: "huge.png", type: "image/png", base64: SCREEN, padTo: 9 * 1024 * 1024 }]);
  const item = page.locator(".att-item");
  await expect(item).toHaveAttribute("data-state", "error");
  await expect(item.locator(".att-meta")).toHaveText("too large: 9 MB, limit 8 MB");
  // Nothing was uploaded for it, and Send will not take it.
  const before = (await (await fetch(`${base}/api/ui/info`)).json()) as { storage: { attachments: number } };
  await page.getByLabel("Message for the next turn").fill("try anyway");
  await page.getByLabel("Message for the next turn").press("Enter");
  await expect(page.locator(".att-note")).toContainText("remove the image that could not be attached");
  expect(await daemon.poll(0)).toEqual([]);
  await item.getByRole("button", { name: "Remove image" }).click();
  await expect(item).toHaveCount(0);
  await page.getByLabel("Message for the next turn").fill("");

  // Straight at the API, the server says the same.
  const big = new Uint8Array(9 * 1024 * 1024);
  big.set(Buffer.from(SCREEN, "base64").subarray(0, 64));
  const res = await fetch(`${base}/api/ui/attachments`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: big,
  });
  expect(res.status).toBe(413);
  expect(await res.json()).toMatchObject({ reason: "too_large", limit: 8 * 1024 * 1024 });
  const after = (await (await fetch(`${base}/api/ui/info`)).json()) as { storage: { attachments: number } };
  expect(after.storage.attachments).toBe(before.storage.attachments);
});

test("the Session view draws the sent prompt's image as a thumbnail", async () => {
  // The daemon framed the text into the session; the transcript carries it back.
  await events.post(
    events.ev("turn.started", { turn_id: "t2", prompt_chars: sentText.length }),
    events.ev("turn.transcript", { turn: 2, user: sentText, assistant: "Done: the header matches." }),
    events.ev("turn.ended", { reason: "stop", ms: 800 }),
  );
  // The turn's own bubble (an images-only message sent earlier may still be drawn below).
  const bubble = page
    .locator("blockquote")
    .filter({ has: page.locator(".att-thumbs"), hasText: "Make the header look like this" })
    .last();
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText("Make the header look like this");
  await expect(bubble).not.toContainText("Attached images");
  const img = bubble.locator(".att-thumbs img");
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute("src", /^\/attachments\/[0-9A-HJKMNP-TV-Z]{26}\.png$/);
  expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1440);
  await shot(page, "session-prompt-thumbnail-desktop");
});

test("a 390 px phone composes with the native picker and the same thumbnails", async ({
  browser,
}: {
  browser: Browser;
}) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: base, isMobile: true });
  const p = await phone.newPage();
  await p.goto(`/s/claude-code/${SID}`);
  const input = p.locator("input[data-attach-input]");
  await expect(input).toBeAttached();
  await expect(input).toHaveAttribute("accept", "image/*");
  await expect(input).toHaveAttribute("multiple", "");
  await input.setInputFiles({ name: "IMG_0412.png", mimeType: "image/png", buffer: Buffer.from(PHOTO, "base64") });
  const item = p.locator(".att-item");
  await expect(item).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await expect(item).toHaveAttribute("title", / · 640×480 · /);
  await p.getByLabel("Message for the next turn").fill("From the phone");
  await shot(p, "composer-thumbnail-phone", ".sess-ctl");
  await shot(p, "session-phone");
  await item.getByRole("button", { name: "Remove image" }).click();
  await expect(item).toHaveCount(0);
  await phone.close();
});
