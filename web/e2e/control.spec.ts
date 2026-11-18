// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The control channel end to end, in one browser with a virtual
// passkey (CDP WebAuthn) against the built server on a free port, with the machine's
// daemon played by fetch: pair → approve on /pair → the daemon collects key, proof and
// token → hello → a session's events → a prompt from the Session page reaches the
// daemon's poll as a verified command → taken / delivered acks show under the strip;
// then Allow on an open permission, Cancel on a working turn, the Board's rows answered
// with a and d and from their menus, a start from /machines (its New session… sheet),
// and a theme sending through api.control.
//
//   node scripts/build.mjs && npx vite build --config web/vite.config.ts
//   npx playwright test -c web/e2e/playwright.config.ts
//
// CONTROL_SHOTS=<dir> also writes screenshots of /pair and the strip (desktop + 390 px).
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, type CDPSession, expect, type Page, test } from "@playwright/test";
import { composer } from "../../test/e2e/helpers.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const CONTROL = "/api/sessionpipe/v1/control";
const EVENTS = "/api/sessionpipe/v1/events";
const SHOTS = process.env.CONTROL_SHOTS;

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
      accounts: [{ harness: "claude-code", id: "acc_1", email: "dev@example.com" }],
    };
  }
  async pair(): Promise<{ machine: string; code: string; check: string; url: string }> {
    const res = await fetch(`${this.base}${CONTROL}/pair`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.sinkToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...this.facts(), ...(this.machine ? { machine: this.machine } : {}) }),
    });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { machine: string; code: string; check: string; url: string };
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
  async hello(waiting: string[] = []): Promise<void> {
    const res = await fetch(`${this.base}${CONTROL}/hello`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...this.facts(), waiting }),
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
  /** Poll until a message arrives (the queue hands it out at once once it is there). */
  async next(): Promise<{ id: string; cmd: Record<string, unknown>; raw: Record<string, unknown> }> {
    for (let i = 0; i < 20; i++) {
      const msgs = await this.poll(1);
      if (msgs.length) {
        const m = msgs[msgs.length - 1]!;
        return { id: m.id as string, cmd: JSON.parse(m.cmd as string) as Record<string, unknown>, raw: m };
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
    readonly title = "Control e2e",
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
      session: { id: this.sid, seq: this.seq++, machine: this.machine, cwd: "/tmp/proj", title: this.title },
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

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

async function virtualPasskey(context: BrowserContext, page: Page): Promise<CDPSession> {
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
  return cdp;
}

/** A theme that asks api.control whether it may send, and sends one prompt on a click. */
const THEME_JS = (session: string) => `export default {
  mount(el, api) {
    el.innerHTML = \`<p data-avail></p><p data-avail-unpaired></p><p data-avail-unknown></p>
      <button type="button" data-send>send</button><p data-result></p><p data-outcome></p>\`;
    let sentId = null;
    const say = (sel, a) => { el.querySelector(sel).textContent = a.ok ? "ok" : a.reason; };
    const draw = (s) => {
      say("[data-avail]", api.control.availability({ session: ${JSON.stringify(session)} }));
      say("[data-avail-unpaired]", api.control.availability({ machineId: "m_nobody" }));
      say("[data-avail-unknown]", api.control.availability({ session: "codex:nope" }));
      const mine = sentId && s.control.find((c) => c.id === sentId);
      el.querySelector("[data-outcome]").textContent = mine ? (mine.outcome ?? "queued") : "";
    };
    draw(api.state.get());
    const stop = api.state.subscribe(draw);
    el.querySelector("[data-send]").addEventListener("click", async () => {
      try {
        const a = await api.control.send(${JSON.stringify(session)}, "From the theme");
        sentId = a.id;
        el.querySelector("[data-result]").textContent = "sent " + a.id;
        draw(api.state.get());
      } catch (e) {
        el.querySelector("[data-result]").textContent = e.message;
      }
    });
    return stop;
  },
};
`;

test.describe.configure({ mode: "serial" });

/** A reply in the session view: the chat's card (Simple, the default) or the timeline's row. */
const REPLY_IN = "li.reply, .chat-card";
const REPLY = ".page.session li.reply, .page.session .chat-card";

let server: ChildProcess;
let base: string;
let stateDir: string;
let sinkToken: string;
let context: BrowserContext;
let page: Page;
let daemon: Daemon;
let events: Events;
const SID = "7d1a6b1e-2f7c-4c2a-9a3e-5b1c2d3e4f50";
const MACHINE = "e2e-mac";

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  for (const f of ["dist/cli.js", "dist/web/index.html"])
    if (!existsSync(path.join(root, f)))
      throw new Error(`${f} is missing: run node scripts/build.mjs && npx vite build --config web/vite.config.ts`);
  const port = await freePort();
  base = `http://localhost:${port}`;
  stateDir = mkdtempSync(path.join(os.tmpdir(), "spgui-control-e2e-"));
  server = spawn(
    process.execPath,
    // --search-home names a folder that holds no history: a test never reads this machine's.
    [
      "dist/cli.js",
      "--port",
      String(port),
      "--state",
      stateDir,
      "--no-outbox",
      "--test-door",
      "--quiet",
      "--search-home",
      path.join(stateDir, "no-history"),
    ],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
  );
  server.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
  const deadline = Date.now() + 20_000;
  let info: { sinkToken: string } | null = null;
  while (!info && Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/ui/info`);
      if (r.ok) info = (await r.json()) as { sinkToken: string };
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!info) throw new Error("the server did not come up");
  sinkToken = info.sinkToken;
  daemon = new Daemon(base, sinkToken, MACHINE);
  events = new Events(base, sinkToken, SID, MACHINE);
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: base });
  page = await context.newPage();
  await virtualPasskey(context, page);
});

test.afterAll(async () => {
  await context?.close();
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

test("a terminal's pairing is approved with a passkey and the daemon collects its token", async () => {
  const started = await daemon.pair();
  expect(started.url).toContain(`/pair?code=${encodeURIComponent(started.code)}`);
  expect(await daemon.pairStatus(started.code)).toEqual({ status: "pending" });

  // /machines lists the pending pairing with a link to the approval page.
  await page.goto("/machines");
  const pending = page.locator(`.pending-item[data-code="${started.code}"]`);
  await expect(pending).toBeVisible();
  await expect(pending).toContainText(MACHINE);
  await expect(pending).toContainText(`${started.check.slice(0, 3)} ${started.check.slice(3)}`);
  await shot(page, "machines-pending-desktop");
  await pending.getByRole("link", { name: /Approve/ }).click();
  await expect(page).toHaveURL(new RegExp(`/pair\\?code=${started.code}`));

  // The six digits match the terminal's; the facts are there.
  await expect(page.locator("[data-check]")).toHaveAttribute("data-check", started.check);
  await expect(page.getByText("first pairing", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("127.0.0.1").first()).toBeVisible();
  await shot(page, "pair-desktop");

  await page.getByRole("button", { name: "Approve with passkey" }).click();
  const status = page.locator(".pair-note--ok");
  await expect(status).toContainText("Approved", { timeout: 20_000 });
  await expect(status).toContainText("finish by itself");
  await shot(page, "pair-approved-desktop");

  // The daemon's status poll now carries key, proof and the machine's token.
  const paired = (await daemon.pairStatus(started.code)) as {
    status: string;
    key: { id: string; alg: number; spki: string };
    proof: { cred: string; ad: string; cd: string; sig: string };
    token: string;
  };
  expect(paired.status).toBe("paired");
  expect(paired.key.alg).toBe(-7);
  expect(paired.key.id).toBe(paired.proof.cred);
  expect(paired.key.spki.length).toBeGreaterThan(40);
  expect(paired.token).toMatch(/^mt_/);
  daemon.token = paired.token;
  await daemon.hello();
  expect(await daemon.poll(0)).toEqual([]);

  // A spent code answers 404 from then on.
  const again = await fetch(`${base}${CONTROL}/pair?code=${started.code}`, {
    headers: { authorization: `Bearer ${sinkToken}` },
  });
  expect(again.status).toBe(404);
});

test("a prompt from the Session page reaches the daemon signed, and its reply comes back", async () => {
  await events.post(
    events.ev("session.started", { source: "startup" }),
    events.ev("turn.started", { turn_id: "t1", prompt_chars: 12 }),
    events.ev("turn.ended", { reason: "stop", ms: 1200 }),
  );
  await page.goto(`/s/claude-code/${SID}`);
  const box = composer(page);
  await expect(box).toBeEnabled();
  // Ready, with the one line under the field: the day grant's (paired, trusted, online,
  // no grant yet today), and Unlock now to take it ahead.
  const foot = page.locator(".ctl-foot[data-reason=passkey]");
  await expect(foot.locator(".ctl-hint")).toHaveText("The first send today asks for your passkey.");
  await expect(foot.getByRole("button", { name: "Unlock now" })).toBeVisible();
  await shot(page, "strip-ready-desktop");
  // A desktop's line stays quiet: its way on is graphite at 500 (a phone's is the tint at
  // 600, mobile.spec.ts), at the caption's size; and Return sends.
  const quiet = await foot.getByRole("button", { name: "Unlock now" }).evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--fg-2)";
    el.parentElement!.append(probe);
    const fg2 = getComputedStyle(probe).color;
    probe.remove();
    const s = getComputedStyle(el);
    return { color: s.color === fg2, weight: s.fontWeight, size: getComputedStyle(el.parentElement!).fontSize };
  });
  expect(quiet).toEqual({ color: true, weight: "500", size: "12px" });
  await expect(box).toHaveAttribute("enterkeyhint", "send");
  /** The next passkey prompt ends with `name` instead of a passkey. */
  const failNext = (name: string, message: string) =>
    page.evaluate(
      ([name, message]) => {
        const real = navigator.credentials.get.bind(navigator.credentials);
        navigator.credentials.get = () => {
          navigator.credentials.get = real;
          return Promise.reject(new DOMException(message, name));
        };
      },
      [name, message],
    );
  // Unlock now, and the prompt closed: the line is as it was, Unlock now with it, no refusal.
  await failNext("NotAllowedError", "The operation either timed out or was not allowed.");
  await foot.getByRole("button", { name: "Unlock now" }).click();
  await expect(foot.locator(".ctl-hint")).toHaveText("The first send today asks for your passkey.");
  await expect(foot.getByRole("button", { name: "Unlock now" })).toBeVisible();
  await expect(page.getByText(/not sent|dismissed/i)).toHaveCount(0);
  // Unlock now refused: said as a refusal, until a send takes the day grant.
  await failNext("NotSupportedError", "x");
  await foot.getByRole("button", { name: "Unlock now" }).click();
  await expect(page.locator(".ctl-foot[data-reason=error] .ctl-hint")).toHaveText(
    "Not sent: This browser cannot make a passkey of a kind the machine accepts.",
  );

  await box.fill("Add the Oct 8 row");
  await box.press("Shift+Enter");
  await box.type("and run the tests");
  await box.press("Enter");

  // The message is drawn in the timeline where its turn will be: the person's words, and
  // the one status row under them as the acks move it (the receiver's words its tooltip).
  const status = page.locator(".page.session .status-row[data-sent-state]").last();
  await expect(status).toHaveAttribute("data-sent-state", "queued", { timeout: 20_000 });
  await expect(status).toHaveText("Sent to e2e-mac");
  await expect(status).toHaveAttribute("title", "queued · waiting for e2e-mac to take it");
  await expect(page.locator(".page.session blockquote").last()).toHaveText(/Add the Oct 8 row\s+and run the tests/);
  await expect(page.locator("li[data-message]")).toHaveCount(0);
  await expect(box).toHaveValue("");
  await shot(page, "strip-queued-desktop");

  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({
    v: 1,
    t: "sessionpipe.control",
    machine: daemon.machine,
    kind: "prompt",
    session: `claude-code:${SID}`,
    text: "Add the Oct 8 row\nand run the tests",
  });
  expect(String(msg.cmd.nonce)).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
  expect(typeof msg.cmd.iat).toBe("number");
  expect(Object.keys(msg.cmd)).toEqual(["v", "t", "machine", "kind", "session", "text", "nonce", "iat"]);
  // Signed by the day key under a passkey grant, and carried byte for byte.
  expect(typeof msg.raw.csig).toBe("string");
  const grant = msg.raw.grant as { str: string; cred: string; ad: string; cd: string; sig: string };
  expect(JSON.parse(grant.str)).toMatchObject({ v: 1, t: "sessionpipe.grant", rp: "localhost" });
  expect(grant.cred).toBeTruthy();

  await daemon.ack(msg.id, "taken");
  await expect(status).toHaveAttribute("data-sent-state", "taken");
  await expect(status).toHaveText("e2e-mac is handing it over…");
  await expect(status).toHaveAttribute("title", /^taken · e2e-mac is delivering it/);
  // The reply the machine streams back is drawn as the turn's reply will be, in its place.
  await daemon.ack(msg.id, "progress", { reply: "Adding the row", seq: 1 });
  await expect(status).toHaveAttribute("data-sent-state", "progress");
  await expect(status).toContainText("Running");
  await expect(page.locator(REPLY).last()).toContainText("Adding the row");
  await daemon.ack(msg.id, "delivered", { reply: "Added the Oct 8 row; 14 tests pass." });
  await expect(status).toHaveAttribute("data-sent-state", "delivered");
  await expect(status).toHaveText("Delivered. Its turn shows here when it begins.");
  await expect(status).toHaveAttribute("title", "delivered · sdk");
  await expect(page.locator(REPLY).last()).toContainText("14 tests pass");
  await shot(page, "strip-delivered-desktop");

  // The second send of the day signs by itself: no passkey line, same grant; and the
  // refused Unlock now is no longer said.
  await expect(page.locator(".ctl-foot[data-reason]")).toHaveCount(0);
});

test("a delivered prompt becomes its turn in the chat, with no row of its own; one that went to a copy links both ways", async () => {
  const box = composer(page);
  await box.fill("What is the coolest feature?");
  await box.press("Enter");
  const msg = await daemon.next();
  await daemon.ack(msg.id, "taken", { mode: "resume" });
  const start = events.ev("turn.started", { turn_id: "t-cool", prompt_chars: 120 });
  await events.post(start);
  // The turn the message became: the person's words, and the reply the machine streams
  // back in the reply's place until the turn's own words arrive.
  const turn = page
    .locator(".page.session ol.timeline > li.turn")
    .filter({ has: page.locator("blockquote", { hasText: "What is the coolest feature?" }) });
  await daemon.ack(msg.id, "progress", { reply: "The control", seq: 1, mode: "resume" });
  await expect(turn.locator("blockquote")).toHaveText("What is the coolest feature?");
  await expect(turn.locator(REPLY_IN)).toContainText("The control");
  await daemon.ack(msg.id, "delivered", { mode: "resume", reply: "The control channel." });
  await expect(turn.locator(REPLY_IN)).toContainText("The control channel.");
  await events.post(
    events.ev("turn.ended", { reason: "stop", ms: 900 }),
    events.ev("turn.transcript", {
      turn: 1,
      user: "Message via localhost (sessionpipe control, signed on the sender's device):\n\nWhat is the coolest feature?",
      assistant: "The control channel.",
      at: start.time,
    }),
  );
  // Its words without the framing, one reply (the turn's own), no status row, and nothing
  // under the composer for it.
  await expect(turn.locator("blockquote")).toHaveText(/^What is the coolest feature\?Sent from localhost$/);
  await expect(turn.locator("blockquote")).not.toContainText("Message via");
  await expect(turn.locator(REPLY_IN)).toHaveCount(1);
  await expect(turn.locator(REPLY_IN)).toContainText("The control channel.");
  await expect(turn.locator(".status-row")).toHaveCount(0);
  await expect(page.locator(`li[data-message="${msg.id}"]`)).toHaveCount(0);

  // Claude Code's idle notice a minute later asks for nothing: the session stays idle.
  await events.post(
    events.ev("attention.needed", {
      attention_id: "notif-idle",
      kind: "idle",
      message: "Claude is waiting for your input",
    }),
  );
  // The state is the title's glyph now (the bar has no state word).
  await expect(page.locator("h1.sess-title .dot")).toHaveClass(/\bdot--idle\b/);
  await expect(page.locator(".ctl-answer")).toHaveCount(0);

  // The session is open in a terminal: the next prompt goes to a copy (a fork).
  const COPY = "9e8d7c6b-5a49-4382-8170-6f5e4d3c2b1a";
  await box.fill("Summarise the repo");
  await box.press("Enter");
  const fork = await daemon.next();
  await daemon.ack(fork.id, "delivered", {
    mode: "fork",
    session: `claude-code:${COPY}`,
    reply: "A receiver with a board.",
  });
  const forkRow = page.locator(`li[data-message="${fork.id}"]`);
  await expect(forkRow).toContainText("delivered · fork");
  await expect(forkRow).not.toHaveAttribute("data-folded");
  await expect(forkRow.locator(".ctl-act-reply")).toContainText("A receiver with a board.");
  const copy = new Events(base, sinkToken, COPY, MACHINE);
  await copy.post(
    copy.ev("session.started", { source: "resume" }),
    copy.ev("turn.started", { prompt_chars: 90 }),
    copy.ev("turn.ended", { reason: "stop", ms: 700 }),
  );
  await forkRow.getByRole("link", { name: "copy of this session" }).click();
  await expect(page).toHaveURL(new RegExp(`/s/claude-code/${COPY}$`));
  const original = page.locator(".sess-copy >> visible=true");
  await expect(original).toHaveText("Copy of Control e2e");
  await original.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/s/claude-code/${SID}$`));
});

test("Allow on an open permission sends a permission.answer naming the attention", async () => {
  await events.post(
    events.ev("turn.started", { turn_id: "t2", prompt_chars: 20 }),
    events.ev("attention.needed", {
      attention_id: "perm-1",
      kind: "permission",
      tool: "Bash",
      message: "rm -rf dist && npm run build",
    }),
  );
  const answer = page.locator('.ctl-answer[data-attention="perm-1"]');
  await expect(answer).toBeVisible();
  await expect(answer).toContainText("Bash");
  await expect(answer).toHaveAttribute("data-answer", "open");
  // Claude Code also raises a Notification about the same prompt a few seconds later:
  // nobody can answer that one, so it adds no row of its own.
  await events.post(events.ev("attention.needed", { attention_id: "notif-1", kind: "permission" }));
  await expect(page.locator(".ctl-answer")).toHaveCount(1);
  await expect(page.locator('.ctl-answer[data-attention="notif-1"]')).toHaveCount(0);
  await shot(page, "strip-permission-desktop");
  await answer.getByRole("button", { name: "Allow" }).click();

  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({
    kind: "permission.answer",
    session: `claude-code:${SID}`,
    for: "perm-1",
    decision: "allow",
  });
  expect(msg.cmd).not.toHaveProperty("text");
  // On its way, the card says which answer went and what it waits for, in the pair's place,
  // and nothing under the composer says it again.
  const receipt = answer.locator(".ctl-answer-receipt");
  await expect(receipt).toHaveText(`Allowed · waiting for ${MACHINE}`);
  await expect(answer).toHaveAttribute("data-answer", "sent");
  await expect(answer.getByRole("button")).toHaveCount(0);
  await expect(page.locator(`li[data-message="${msg.id}"]`)).toHaveCount(0);
  // Delivered, it stays said until the prompt clears: nothing to answer twice.
  await daemon.ack(msg.id, "delivered", { mode: "waiter" });
  await expect(receipt).toHaveText(`Allowed · waiting for ${MACHINE}`);
  // A reload knows it too, from the answer's row.
  await page.reload();
  await expect(answer.locator(".ctl-answer-receipt")).toHaveText(`Allowed · waiting for ${MACHINE}`);
  await expect(answer.getByRole("button")).toHaveCount(0);
});

test("Cancel on a working turn sends a cancel", async () => {
  await events.post(events.ev("attention.cleared", { attention_id: "perm-1", how: "answered" }));
  await expect(page.locator(".ctl-answer")).toHaveCount(0);
  const cancel = page.getByRole("button", { name: "Stop the turn", exact: true });
  await expect(cancel).toBeVisible();
  await cancel.click();
  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({ kind: "cancel", session: `claude-code:${SID}` });
  await daemon.ack(msg.id, "refused", { code: "no_session", detail: "gone" });
  const row = page.locator(`li[data-message="${msg.id}"]`);
  await expect(row).toHaveAttribute("data-outcome", "refused");
  await expect(row).toContainText("no such session");
});

test("a refused no_attention closes the prompt here: the pair goes, the words stay, nothing is sent twice", async () => {
  await events.post(
    events.ev("attention.needed", { attention_id: "perm-2", kind: "permission", tool: "Write", message: "notes.md" }),
  );
  const answer = page.locator('.ctl-answer[data-attention="perm-2"]');
  await expect(answer).toHaveAttribute("data-answer", "open");
  await answer.getByRole("button", { name: "Allow" }).click();
  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({ kind: "permission.answer", for: "perm-2", decision: "allow" });
  // While the answer is out the receipt stands in the pair's place: nothing to press twice.
  await expect(answer).toHaveAttribute("data-answer", "sent");
  await expect(answer.getByRole("button")).toHaveCount(0);
  await expect(answer.locator(".ctl-answer-receipt")).toHaveText(`Allowed · waiting for ${MACHINE}`);
  // The terminal had answered first: the daemon says the prompt is no longer open.
  await daemon.ack(msg.id, "refused", { code: "no_attention" });
  await expect(answer).toHaveAttribute("data-answer", "closed");
  await expect(answer.getByRole("button")).toHaveCount(0);
  await expect(answer).toContainText("already answered, or timed out");
  await expect(page.locator(`li[data-message="${msg.id}"]`)).toHaveCount(0);
  expect(await daemon.poll(0)).toEqual([]);
  await events.post(events.ev("attention.cleared", { attention_id: "perm-2", how: "answered" }));
  await expect(answer).toHaveCount(0);
});

test("an answer the machine refused for another reason gives the pair back, and says why", async () => {
  await events.post(
    events.ev("attention.needed", { attention_id: "perm-4", kind: "permission", tool: "Bash", message: "make" }),
  );
  const answer = page.locator('.ctl-answer[data-attention="perm-4"]');
  await answer.getByRole("button", { name: "Deny" }).click();
  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({ kind: "permission.answer", for: "perm-4", decision: "deny" });
  await expect(answer.locator(".ctl-answer-receipt")).toHaveText(`Denied · waiting for ${MACHINE}`);
  await daemon.ack(msg.id, "refused", { code: "nonce_store" });
  await expect(answer).toHaveAttribute("data-answer", "open");
  await expect(answer.getByRole("button", { name: "Allow" })).toBeEnabled();
  await expect(page.locator(".ctl-foot[data-reason='error']")).toHaveText(
    "Not sent: the machine could not record the nonce, so it did not run it",
  );
  await events.post(events.ev("attention.cleared", { attention_id: "perm-4", how: "answered" }));
  await expect(answer).toHaveCount(0);
  await expect(page.locator(".ctl-foot[data-reason='error']")).toHaveCount(0);
});

test("against a receiver whose rows do not say which prompt they answer, the page that pressed still knows", async () => {
  // A receiver from before ControlActivity.answer: none on the stream's frames, on GET
  // /activity or on the send's own answer. The frames it strips are counted by id.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("e2e-older-receiver")) return;
    const seen: string[] = [];
    (window as unknown as { olderFrames: string[] }).olderFrames = seen;
    const Real = window.EventSource;
    window.EventSource = class extends Real {
      addEventListener(kind: string, fn: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) {
        if (kind !== "control" || typeof fn !== "function") return super.addEventListener(kind, fn, o);
        return super.addEventListener(
          kind,
          (e: Event) => {
            const m = JSON.parse((e as MessageEvent).data);
            if (m.message?.answer) {
              delete m.message.answer;
              seen.push(`${m.message.id}:${m.message.outcome ?? ""}`);
            }
            fn(new MessageEvent(e.type, { data: JSON.stringify(m), lastEventId: (e as MessageEvent).lastEventId }));
          },
          o,
        );
      }
    } as typeof EventSource;
  });
  const strip = (x: unknown): unknown => {
    if (Array.isArray(x)) for (const y of x) strip(y);
    else if (x && typeof x === "object") {
      delete (x as { answer?: unknown }).answer;
      for (const y of Object.values(x)) strip(y);
    }
    return x;
  };
  let sends = 0;
  await page.route("**/api/ui/control/activity**", async (r) => {
    const res = await r.fetch();
    await r.fulfill({ response: res, json: strip(await res.json()) });
  });
  await page.route("**/api/ui/control/send", async (r) => {
    sends++;
    const res = await r.fetch();
    await r.fulfill({ response: res, json: strip(await res.json()) });
  });
  await page.evaluate(() => sessionStorage.setItem("e2e-older-receiver", "1"));
  await page.reload();
  const frames = (id: string) =>
    expect.poll(() => page.evaluate(() => (window as unknown as { olderFrames: string[] }).olderFrames), {
      message: `the stream's frames for ${id}`,
    });

  await events.post(
    events.ev("attention.needed", { attention_id: "perm-5", kind: "permission", tool: "Bash", message: "make deploy" }),
  );
  const answer = page.locator('.ctl-answer[data-attention="perm-5"]');
  await expect(answer).toHaveAttribute("data-answer", "open");
  await answer.getByRole("button", { name: "Allow" }).click();
  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({ kind: "permission.answer", for: "perm-5", decision: "allow" });
  const receipt = answer.locator(".ctl-answer-receipt");
  await expect(receipt).toHaveText(`Allowed · waiting for ${MACHINE}`);
  // Its row on the stream says nothing of perm-5: this page reads it as its own press's.
  await daemon.ack(msg.id, "delivered", { mode: "waiter" });
  await frames(msg.id).toContain(`${msg.id}:delivered`);
  await expect(receipt).toHaveText(`Allowed · waiting for ${MACHINE}`);
  await expect(answer).toHaveAttribute("data-answer", "sent");
  await expect(answer.getByRole("button")).toHaveCount(0);
  // Nothing to press twice: Deny's key finds no Deny, and no second answer goes.
  await page.keyboard.press("d");
  expect(await daemon.poll(1)).toEqual([]);
  expect(sends).toBe(1);

  // Refused for a reason of its own: the pair back, and why.
  await events.post(
    events.ev("attention.needed", { attention_id: "perm-6", kind: "permission", tool: "Bash", message: "make" }),
  );
  const other = page.locator('.ctl-answer[data-attention="perm-6"]');
  await other.getByRole("button", { name: "Deny" }).click();
  const refused = await daemon.next();
  await expect(other.locator(".ctl-answer-receipt")).toHaveText(`Denied · waiting for ${MACHINE}`);
  await daemon.ack(refused.id, "refused", { code: "nonce_store" });
  await frames(refused.id).toContain(`${refused.id}:refused`);
  await expect(other).toHaveAttribute("data-answer", "open");
  await expect(other.getByRole("button", { name: "Allow" })).toBeEnabled();
  await expect(page.locator(".ctl-foot[data-reason='error']")).toHaveText(
    "Not sent: the machine could not record the nonce, so it did not run it",
  );

  await events.post(
    events.ev("attention.cleared", { attention_id: "perm-5", how: "answered" }),
    events.ev("attention.cleared", { attention_id: "perm-6", how: "answered" }),
  );
  await expect(page.locator(".ctl-answer")).toHaveCount(0);
  await page.unrouteAll();
  await page.evaluate(() => sessionStorage.removeItem("e2e-older-receiver"));
  await page.reload();
});

test("a prompt its hook stopped waiting on cannot be answered here, and offers nothing; a tier-0 copy still has a label", async () => {
  // Raised an hour ago, long past the 125 s Claude Code's hook waits; and with no tool or message.
  const old = events.ev("attention.needed", { attention_id: "perm-3", kind: "permission" });
  old.time = new Date(Date.now() - 3600_000).toISOString();
  await events.post(old);
  const answer = page.locator('.ctl-answer[data-attention="perm-3"]');
  await expect(answer).toBeVisible();
  await expect(answer).toHaveAttribute("data-answer", "late");
  await expect(answer).toContainText("Allow this?");
  await expect(answer).toContainText("a permission request");
  await expect(answer.getByRole("button")).toHaveCount(0);
  await expect(answer).toContainText(`Too late to answer from here; answer it on ${MACHINE}.`);
  expect(await daemon.poll(0)).toEqual([]);
  await events.post(events.ev("attention.cleared", { attention_id: "perm-3", how: "answered" }));
  await expect(answer).toHaveCount(0);
});

test("a notification-only permission (nothing the daemon can answer) says so, with no buttons", async () => {
  await events.post(events.ev("attention.needed", { attention_id: "notif-9", kind: "permission" }));
  const row = page.locator('.ctl-answer[data-attention="notif-9"]');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-answer", "terminal");
  await expect(row.getByRole("button")).toHaveCount(0);
  await expect(row).toContainText("waiting in the terminal");
  expect(await daemon.poll(0)).toEqual([]);
  await events.post(events.ev("attention.cleared", { attention_id: "notif-9", how: "answered" }));
  await expect(row).toHaveCount(0);
});

// ----- the Board's rows: a and d, the row's line, the row's menu -----

/** 112 characters, a chain of two: more than a row shows beside Allow and Deny (and under
 *  the 120 Claude Code cuts a command at), so it is answered where it is shown whole. */
const LONG_COMMAND =
  "rsync -avz --delete --exclude .env ./dist/ deploy@staging.acme.dev:/srv/billing/new && systemctl restart billing";

/** A session of its own with one open prompt, as its hooks raise it; `clear()` is the
 *  prompt answered on its computer. */
async function prompted(o: { title: string; message: string; tool?: string; machine?: string }) {
  const ev = new Events(base, sinkToken, randomUUID(), o.machine ?? MACHINE, o.title);
  const id = `board-${ev.sid.slice(0, 8)}`;
  await ev.post(
    ev.ev("session.started", { source: "startup" }),
    ev.ev("turn.started", { turn_id: "t1", prompt_chars: 20 }),
    ev.ev("attention.needed", { attention_id: id, kind: "permission", tool: o.tool ?? "Bash", message: o.message }),
  );
  return {
    key: `claude-code:${ev.sid}`,
    id,
    title: o.title,
    clear: () =>
      ev.post(
        ev.ev("attention.cleared", { attention_id: id, how: "answered" }),
        ev.ev("turn.ended", { reason: "stop", ms: 1200 }),
      ),
  };
}

const card = (p: { key: string }) => page.locator(`article.card[data-flip="${p.key}"]`);

/** The board, as a device that has seen Setup, with no banner over its rows. */
async function board(query = ""): Promise<void> {
  await page.evaluate(() => localStorage.setItem("sessionpipe-gui.setup.seen", "1"));
  await page.goto(`/${query}`);
  await page.addStyleTag({ content: ".toasts { display: none !important; }" });
}

/** No tab left beside the page: a session opened as a page keeps the panel's tabs, so the
 *  tests after this one would carry them. */
async function closePanel(): Promise<void> {
  await page.evaluate(() => localStorage.removeItem("sessionpipe-gui.splitTabs"));
  await page.goto("/inbox");
}

/** j and k until the board's cursor is on the row. */
async function cursorTo(p: { key: string }): Promise<void> {
  await expect(card(p)).toBeVisible();
  for (let i = 0; i < 30; i++) {
    const [at, to] = await page.evaluate((key) => {
      const rows = [...document.querySelectorAll("article.card")];
      return [
        rows.findIndex((r) => r.getAttribute("aria-current") === "true"),
        rows.findIndex((r) => r.getAttribute("data-flip") === key),
      ];
    }, p.key);
    if (at === to) break;
    await page.keyboard.press(at < to ? "j" : "k");
  }
  await expect(card(p)).toHaveAttribute("aria-current", "true");
}

test("on the Board, a answers the row under the cursor, once; the row says it went, or why it did not", async () => {
  const deploy = await prompted({
    title: "Ship the BM25 cache to staging",
    message: "npm run deploy -- --target staging",
  });
  await board();
  const line = card(deploy).locator(".card-attn");
  await expect(line).toHaveText("npm run deploy -- --target staging");
  await cursorTo(deploy);

  // Refused on its way: the line says so, in the request's place, and the key works again.
  await page.route("**/api/ui/control/send", (r) =>
    r.fulfill({ status: 422, json: { reason: "refused", code: "nonce_store" } }),
  );
  await page.keyboard.press("a");
  await expect(line).toHaveText("Not sent: the machine could not record the nonce, so it did not run it");
  await expect(line).toHaveAttribute("data-said", "error");
  await expect(card(deploy).locator(".card-state .dot--needs_you")).toBeVisible();
  await page.unroute("**/api/ui/control/send");
  expect(await daemon.poll(0)).toEqual([]);

  // Pressed twice: one answer, for the prompt under the cursor.
  await page.keyboard.press("a");
  await page.keyboard.press("a");
  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({
    kind: "permission.answer",
    session: deploy.key,
    for: deploy.id,
    decision: "allow",
  });
  // The receipt in the request's place, and the working ring in the orange dot's.
  await expect(line).toHaveText(`Allowed · waiting for ${MACHINE}`);
  await expect(line).toHaveAttribute("role", "status");
  await expect(card(deploy).locator(".card-tool")).toHaveText("Bash");
  await expect(card(deploy).locator(".card-state .dot--working")).toBeVisible();
  await expect(card(deploy).locator(".card-state .dot--needs_you")).toHaveCount(0);
  // Nothing to answer twice: taken by the machine, it is the one answer, and neither key
  // sends another.
  await daemon.ack(msg.id, "delivered", { mode: "waiter" });
  await page.keyboard.press("d");
  await page.keyboard.press("a");
  expect(await daemon.poll(1)).toEqual([]);
  await expect(line).toHaveText(`Allowed · waiting for ${MACHINE}`);
  await deploy.clear();
  await expect(card(deploy)).not.toHaveClass(/card--needs_you/);
});

test("on the Board, a and d never answer a session open beside it; a row that is not answered from the row is, in the panel, once it is the one open there", async () => {
  const beside = await prompted({ title: "Open beside", message: "make deploy" });
  const question = await prompted({ title: "A question", tool: "AskUserQuestion", message: "AskUserQuestion" });
  expect(LONG_COMMAND).toHaveLength(112);
  const long = await prompted({ title: "A long command", message: LONG_COMMAND });
  // Opened beside with no row under the cursor, the focus on the page: the keys are the
  // board's, and answer nothing.
  await board(`?s=${beside.key}`);
  await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
  const allow = page.locator(`aside.panel .ctl-answer[data-attention="${beside.id}"] .btn--allow`);
  await expect(allow).toBeEnabled({ timeout: 15_000 });
  await expect(page.locator("article.card[aria-current='true']")).toHaveCount(0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("a");
  await page.keyboard.press("d");
  // On a question's row and on one whose command the row does not show whole: nothing either.
  for (const p of [question, long]) {
    await cursorTo(p);
    await page.keyboard.press("a");
    await page.keyboard.press("d");
  }
  expect(await daemon.poll(1)).toEqual([]);
  await expect(allow).toBeEnabled();
  await expect(page.locator("aside.panel .ctl-answer-receipt")).toHaveCount(0);

  // Space peeks the row under the cursor: the panel shows its command whole, and a is the
  // panel's, with the focus still on the list.
  await page.keyboard.press("Space");
  await expect(page.locator("aside.panel .panel-title")).toHaveText("A long command");
  const shown = page.locator("aside.panel .panel-body:not(.panel-body--off)");
  await expect(shown.locator(".ctl-cmd-block")).toContainText("systemctl restart billing");
  await expect(card(long)).toHaveAttribute("aria-current", "true");
  expect(await page.evaluate(() => !!document.activeElement?.closest("aside.panel"))).toBe(false);
  await expect(shown.locator(`.ctl-answer[data-attention="${long.id}"] .btn--allow`)).toBeEnabled();
  await page.keyboard.press("a");
  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({ kind: "permission.answer", session: long.key, for: long.id, decision: "allow" });
  await daemon.ack(msg.id, "delivered", { mode: "waiter" });
  expect(await daemon.poll(0)).toEqual([]);
  // The answer went from the panel; the board's row says so too.
  await expect(card(long).locator(".card-attn")).toHaveText(`Allowed · waiting for ${MACHINE}`);
  for (const p of [beside, question, long]) await p.clear();
  await closePanel();
});

test("with two prompts open in one session beside the page, a and d on the one the panel's keys do not answer send nothing, on the Board and in the Inbox", async () => {
  // This receiver keeps one prompt open a session (the next hook event closes it); another
  // may hold two, as parallel subagents ask at once. The stream's frames give this session
  // a question ahead of its command while the command is open: the panel's first Allow is
  // the command's, and the board's row shows the question.
  await page.addInitScript(() => {
    const two = sessionStorage.getItem("e2e-two-prompts");
    if (!two) return;
    const { key, id } = JSON.parse(two) as { key: string; id: string };
    type Row = { key: string; openAttentions: { attentionId: string; at: string }[] };
    const ask = (r: Row | undefined) => {
      const first = r?.key === key ? r.openAttentions[0] : undefined;
      if (!r || !first || first.attentionId === id) return;
      r.openAttentions = [
        {
          attentionId: id,
          kind: "permission",
          tool: "AskUserQuestion",
          message: "AskUserQuestion",
          at: first.at,
          answerable: true,
        },
        ...r.openAttentions,
      ] as Row["openAttentions"];
    };
    const Real = window.EventSource;
    window.EventSource = class extends Real {
      addEventListener(kind: string, fn: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) {
        if (typeof fn !== "function") return super.addEventListener(kind, fn, o);
        return super.addEventListener(
          kind,
          (e: Event) => {
            const m = JSON.parse((e as MessageEvent).data);
            for (const r of m.snapshot?.sessions ?? []) ask(r);
            ask(m.session);
            fn(new MessageEvent(e.type, { data: JSON.stringify(m), lastEventId: (e as MessageEvent).lastEventId }));
          },
          o,
        );
      }
    } as typeof EventSource;
  });
  const bash = await prompted({ title: "Two prompts", message: "make deploy" });
  const question = `${bash.id}-q`;
  await page.evaluate(
    ([key, id]) => sessionStorage.setItem("e2e-two-prompts", JSON.stringify({ key, id })),
    [bash.key, question],
  );
  try {
    // The Board: the row shows the question; its session is open beside it.
    await board(`?s=${bash.key}`);
    const shown = page.locator("aside.panel .panel-body:not(.panel-body--off)");
    await expect(shown.locator(`.ctl-answer[data-attention="${question}"]`)).toHaveAttribute("data-answer", "question");
    const allow = shown.locator(`.ctl-answer[data-attention="${bash.id}"] .btn--allow`);
    await expect(allow).toBeEnabled({ timeout: 15_000 });
    await cursorTo(bash);
    await expect(card(bash).locator(".card-tool")).toHaveText("Question");
    expect(await page.evaluate(() => !!document.activeElement?.closest("aside.panel"))).toBe(false);
    await page.keyboard.press("a");
    await page.keyboard.press("d");
    expect(await daemon.poll(1)).toEqual([]);
    await expect(allow).toBeEnabled();

    // The Inbox: on the question's row, nothing; on the command's, its own answer.
    await page.goto(`/inbox?s=${bash.key}`);
    await page.addStyleTag({ content: ".toasts { display: none !important; }" });
    const row = (id: string) => page.locator(`.inbox-row[data-attention="${id}"]`);
    await expect(allow).toBeEnabled({ timeout: 15_000 });
    await row(question).locator(".inbox-main").focus();
    await expect(row(question)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("a");
    await page.keyboard.press("d");
    expect(await daemon.poll(1)).toEqual([]);
    await row(bash.id).locator(".inbox-main").focus();
    await expect(row(bash.id)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("d");
    const msg = await daemon.next();
    expect(msg.cmd).toMatchObject({ kind: "permission.answer", session: bash.key, for: bash.id, decision: "deny" });
    await daemon.ack(msg.id, "delivered", { mode: "waiter" });
  } finally {
    await page.evaluate(() => sessionStorage.removeItem("e2e-two-prompts"));
    await bash.clear();
    await closePanel();
  }
});

test("on the Board, a on a machine that is not paired sends nothing, and the row says why until the cursor leaves it", async () => {
  const other = await prompted({ title: "Rebuild the cache", message: "make cache", machine: "ci-box" });
  const mine = await prompted({ title: "Run the suite", message: "npm test" });
  await board();
  const line = card(other).locator(".card-attn");
  await expect(line).toHaveText("make cache");
  await cursorTo(other);
  await page.keyboard.press("a");
  await expect(line).toHaveText("Pair ci-box to send messages");
  await expect(line).toHaveAttribute("data-said", "off");
  // Still the orange dot: nothing went.
  await expect(card(other).locator(".card-state .dot--needs_you")).toBeVisible();
  expect(await daemon.poll(1)).toEqual([]);
  // The cursor on another row: the request is back.
  await cursorTo(mine);
  await expect(line).toHaveText("make cache");
  await expect(line).not.toHaveAttribute("data-said");
  expect(await daemon.poll(0)).toEqual([]);
  for (const p of [other, mine]) await p.clear();
});

test("a row's menu leads with Allow and Deny and their keys, on the Board and in the Inbox, and shows no key that does something else", async () => {
  const p = await prompted({ title: "Publish the docs", message: "npm run docs:publish" });
  const items = page.getByRole("menu").getByRole("menuitem");
  const keys = (name: string) => page.getByRole("menuitem", { name, exact: true }).locator(".menu-keys");
  /** The menu's first two are the pair, with a and d beside them; then Open. */
  const leads = async () => {
    await expect(items.nth(0)).toHaveText(/^Allow Bash\s*a$/i);
    await expect(items.nth(1)).toHaveText(/^Deny Bash\s*d$/i);
    await expect(keys("Allow Bash")).toHaveText("a", { ignoreCase: true });
    await expect(keys("Deny Bash")).toHaveText("d", { ignoreCase: true });
  };

  // The Inbox's row.
  await board();
  await page.goto("/inbox");
  await page.addStyleTag({ content: ".toasts { display: none !important; }" });
  await page.locator(`.inbox-row[data-attention="${p.id}"] .inbox-main`).click({ button: "right" });
  await leads();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // The Board's row: the pair, a rule, then Open; C is not beside New session here (it
  // opens the sheet for the board's machine), and this machine's agents cannot be asked.
  await board();
  await card(p).locator(".card-title").click({ button: "right" });
  await leads();
  await expect(items.nth(2)).toHaveText(/^Open as page/);
  await expect(page.getByRole("menuitem", { name: "New session here" })).toBeVisible();
  await expect(keys("New session here")).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Ask another agent…" })).toHaveCount(0);
  // The menu's Deny goes as the key's does, and the row says so.
  await page.getByRole("menuitem", { name: "Deny Bash" }).click();
  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({ kind: "permission.answer", session: p.key, for: p.id, decision: "deny" });
  await expect(card(p).locator(".card-attn")).toHaveText(`Denied · waiting for ${MACHINE}`);
  // With an answer out the menu offers none. (A menu opens no sooner than 400 ms after the
  // last one did.)
  await expect(async () => {
    await card(p).locator(".card-title").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Open as page" })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole("menuitem", { name: /^(Allow|Deny) Bash$/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await daemon.ack(msg.id, "delivered", { mode: "waiter" });
  await p.clear();
});

test("a session is started from /machines in one of the machine's folders", async () => {
  await page.goto("/machines");
  const block = page.getByRole("region", { name: MACHINE });
  await expect(block).toContainText(/paired/i);
  // Online is the normal case and says nothing; only a daemon that is down is named.
  await expect(block).not.toContainText("daemon offline");
  // The machine's ⋯ → New session on it opens the compose sheet (NewSession.tsx) on this
  // machine; its one folder and one harness are already chosen. Custom selects carry
  // data-value.
  await block.getByRole("button", { name: `Actions for ${MACHINE}` }).click();
  await page.getByRole("menuitem", { name: `New session on ${MACHINE}…` }).click();
  const sheet = page.locator("[data-new-session]");
  await expect(sheet.locator("[data-ns-row=machine] button.sel")).toHaveAttribute("data-value", MACHINE);
  await expect(sheet.locator("[data-ns-row=agent] button.sel")).toHaveAttribute("data-value", "claude-code");
  await expect(sheet.locator("[data-ns-row=folder] button.sel")).toHaveAttribute("data-value", "/tmp/proj");
  // A 0.7 daemon advertises no start options: no permission or model rows.
  await expect(sheet.locator("[data-ns-row=permission], [data-ns-row=model]")).toHaveCount(0);
  await sheet.locator("[data-ns-text]").fill("Set up the Oct release branch");
  await shot(page, "machines-start-desktop");
  await sheet.locator("[data-ns-start]").click();

  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({ kind: "start", text: "Set up the Oct release branch", cwd: "/tmp/proj" });
  const session = String(msg.cmd.session);
  expect(session).toMatch(/^claude-code:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(Object.keys(msg.cmd)).toEqual(["v", "t", "machine", "kind", "session", "text", "cwd", "nonce", "iat"]);
  // The page is already the new session, in its starting state, following the acks.
  const sid = session.slice("claude-code:".length);
  await expect(page).toHaveURL(new RegExp(`/s/claude-code/${sid}$`));
  await daemon.ack(msg.id, "taken");
  await expect(page.locator(".starting[data-starting=taken]")).toBeVisible();
  await daemon.ack(msg.id, "delivered", { session, reply: "Session started." });
  await expect(page.locator(".starting[data-starting=delivered]")).toBeVisible();
  await shot(page, "machines-started-desktop");
});

test("a theme sends through api.control: availability says ok on localhost, the prompt reaches the daemon", async () => {
  const dir = path.join(stateDir, "themes", "e2e-control");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "theme.json"),
    JSON.stringify({ id: "e2e-control", name: "E2E Control", version: "0.1.0", api: 1 }),
  );
  writeFileSync(path.join(dir, "index.js"), THEME_JS(`claude-code:${SID}`));
  expect((await fetch(`${base}/api/ui/themes/reload`, { method: "POST" })).status).toBe(200);
  await daemon.poll(0); // freshly online

  await page.goto("/t/e2e-control");
  const host = page.locator("[data-theme-id='e2e-control']");
  await expect(host.locator("[data-avail]")).toHaveText("ok");
  await expect(host.locator("[data-avail-unpaired]")).toHaveText("this machine is not paired here");
  await expect(host.locator("[data-avail-unknown]")).toHaveText("no such session is known here");
  await host.locator("[data-send]").click();

  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({
    v: 1,
    t: "sessionpipe.control",
    machine: daemon.machine,
    kind: "prompt",
    session: `claude-code:${SID}`,
    text: "From the theme",
  });
  expect(Object.keys(msg.cmd)).toEqual(["v", "t", "machine", "kind", "session", "text", "nonce", "iat"]);
  expect(typeof msg.raw.csig).toBe("string");
  await expect(host.locator("[data-result]")).toHaveText(`sent ${msg.id}`);
  await expect(host.locator("[data-outcome]")).toHaveText("queued");
  await daemon.ack(msg.id, "delivered", { reply: "Done." });
  await expect(host.locator("[data-outcome]")).toHaveText("delivered");
});

test("a phone adds its own passkey: the paired browser approves with a key.add, the daemon adds it, the phone sends", async ({
  browser,
}: {
  browser: Browser;
}) => {
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: base, isMobile: true });
  const phone = await phoneCtx.newPage();
  await virtualPasskey(phoneCtx, phone);

  // A secure page whose browser holds no passkey the machine trusts: the one line under
  // the field says so and points at /add-device.
  await phone.goto(`/s/claude-code/${SID}`);
  const hint = phone.locator(".ctl-foot[data-reason=untrusted]");
  await expect(hint).toContainText("trusts no passkey from this browser");
  await hint.getByRole("link", { name: /Add this device/ }).click();
  await expect(phone).toHaveURL(/\/add-device$/);
  await phone.getByLabel("Device name").fill("Misha's iPhone");
  await phone.getByRole("button", { name: "Add this device" }).click();
  const digits = phone.locator("[data-check]");
  await expect(digits).toBeVisible({ timeout: 20_000 });
  const check = (await digits.getAttribute("data-check")) ?? "";
  expect(check).toMatch(/^\d{6}$/);
  await expect(phone.locator(".pair-countdown")).toContainText("Waiting for approval");
  await shot(phone, "add-device-waiting-phone");

  // The paired browser lists the request on /machines with the same digits and approves it.
  await page.goto("/machines");
  const item = page.locator(".pending-devices .pending-item").filter({ hasText: "Misha's iPhone" });
  await expect(item).toBeVisible();
  await expect(item).toContainText(`${check.slice(0, 3)} ${check.slice(3)}`);
  await expect(item).toContainText("iPhone");
  await shot(page, "machines-device-pending-desktop");
  await item.getByRole("button", { name: "Approve" }).click();

  // The daemon polls a key.add naming the key store, carrying the phone's key, signed by
  // the Mac's passkey (under its day grant), not the phone's.
  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({
    v: 1,
    t: "sessionpipe.control",
    machine: daemon.machine,
    kind: "key.add",
    session: "sessionpipe:keys",
    name: "Misha's iPhone",
  });
  expect(Object.keys(msg.cmd)).toEqual(["v", "t", "machine", "kind", "session", "key", "name", "nonce", "iat"]);
  const key = msg.cmd.key as { id: string; alg: number; spki: string };
  expect(key.alg).toBe(-7);
  expect(key.id).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  expect(key.spki.length).toBeGreaterThan(40);
  expect(typeof msg.raw.csig).toBe("string");
  expect((msg.raw.grant as { cred: string }).cred).not.toBe(key.id);
  await expect(phone.locator(".pair-countdown")).toContainText("Approved", { timeout: 10_000 });

  await daemon.ack(msg.id, "delivered");

  // The phone's poll reads added; the Mac's row says so; the machine's device list grew.
  await expect(phone.locator("[data-added]")).toContainText("Done", { timeout: 10_000 });
  await expect(phone.locator("[data-added]")).toContainText("can now answer and send");
  await shot(phone, "add-device-added-phone");
  await expect(page.locator(".pending-devices [data-outcome='delivered']")).toContainText(/added/i);
  const block = page.getByRole("region", { name: MACHINE });
  await expect(block).toContainText("Devices");
  await expect(block).toContainText("Misha's iPhone");
  await expect(block).toContainText("(this one)");
  await shot(page, "machines-device-added-desktop");

  // The phone now sends a prompt itself, under a grant its own passkey signs.
  await phone.goto(`/s/claude-code/${SID}`);
  const box = composer(phone);
  await expect(box).toBeEnabled();
  await expect(phone.locator(".ctl-foot[data-reason=untrusted]")).toHaveCount(0);
  // 390 wide with no touch screen (a narrow window): Return sends, as on any keyboard.
  await expect(box).toHaveAttribute("enterkeyhint", "send");
  await box.fill("From the phone");
  await box.press("Enter");
  const sent = await daemon.next();
  expect(sent.cmd).toMatchObject({ kind: "prompt", session: `claude-code:${SID}`, text: "From the phone" });
  expect((sent.raw.grant as { cred: string }).cred).toBe(key.id);
  await daemon.ack(sent.id, "delivered", { reply: "Heard from the phone." });
  await expect(phone.locator(".page.session .status-row[data-sent-state]").last()).toHaveAttribute(
    "data-sent-state",
    "delivered",
  );
  await expect(phone.locator(REPLY).last()).toContainText("Heard from the phone.");

  // Reject, from the Mac: a second request from another phone is gone at once.
  const other = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: base, isMobile: true });
  const p2 = await other.newPage();
  await virtualPasskey(other, p2);
  await p2.goto("/add-device");
  await p2.getByLabel("Device name").fill("Spare phone");
  await p2.getByRole("button", { name: "Add this device" }).click();
  await expect(p2.locator("[data-check]")).toBeVisible({ timeout: 20_000 });
  const spare = page.locator(".pending-devices .pending-item").filter({ hasText: "Spare phone" });
  await expect(spare).toBeVisible();
  await spare.getByRole("button", { name: "Reject" }).click();
  await expect(spare).toHaveCount(0);
  await expect(p2.locator(".pair-note--quiet")).toContainText("Rejected", { timeout: 10_000 });
  await other.close();
  await phoneCtx.close();
});

test("over plain LAN http every control affordance says passkeys need https or localhost", async ({
  browser,
}: {
  browser: Browser;
}) => {
  const info = (await (await fetch(`${base}/api/ui/info`)).json()) as { uiKey: string; urls: { lan: string[] } };
  const lan = info.urls.lan[0];
  test.skip(!lan, "no LAN address on this machine");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  // ?k= sets the cookie and redirects; the origin is a LAN ip, so isSecureContext is false.
  await p.goto(`${lan}/s/claude-code/${SID}?k=${info.uiKey}`);
  expect(await p.evaluate(() => window.isSecureContext)).toBe(false);
  await expect(composer(p)).toBeDisabled();
  await expect(p.locator(".ctl-hint")).toContainText(/passkeys need https or localhost/i);
  await shot(p, "strip-insecure-desktop");
  const renewed = await daemon.pair();
  await p.goto(`${lan}/pair?code=${encodeURIComponent(renewed.code)}`);
  await expect(p.locator("[data-check]")).toHaveAttribute("data-check", renewed.check);
  await expect(p.getByRole("button", { name: "Approve with passkey" })).toBeDisabled();
  await expect(p.locator(".pair-note--err")).toContainText(/passkeys need https or localhost/i);
  await p.goto(`${lan}/machines`);
  // Said once above the paired machines, not in each.
  await expect(p.locator(".machines-note")).toContainText(/passkeys need https or localhost/i);
  await p.goto(`${lan}/t/e2e-control`);
  await expect(p.locator("[data-theme-id='e2e-control'] [data-avail]")).toContainText(
    /passkeys need https or localhost/i,
  );
  await ctx.close();
});

test("a 390 px phone sees the same pages", async ({ browser }: { browser: Browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: base, isMobile: true });
  const p = await phone.newPage();
  await p.goto(`/s/claude-code/${SID}`);
  await expect(composer(p)).toBeEnabled();
  await expect(p.locator(".page.session ol.timeline > li.turn").first()).toBeVisible();
  await shot(p, "strip-phone");
  // A renewed code from the same terminal: the pair page at phone width.
  const renewed = await daemon.pair();
  await p.goto(`/pair?code=${encodeURIComponent(renewed.code)}`);
  await expect(p.locator("[data-check]")).toHaveAttribute("data-check", renewed.check);
  await expect(p.getByRole("button", { name: /Approve with passkey/ })).toBeVisible();
  await shot(p, "pair-phone");
  await p.getByRole("button", { name: "Reject" }).click();
  await expect(p.locator(".pair-note--quiet")).toContainText("Rejected");
  const gone = await fetch(`${base}${CONTROL}/pair?code=${renewed.code}`, {
    headers: { authorization: `Bearer ${sinkToken}` },
  });
  expect(gone.status).toBe(404);
  await phone.close();
});
