// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The control channel end to end, in one browser with a virtual
// passkey (CDP WebAuthn) against the built server on a free port, with the machine's
// daemon played by fetch: pair → approve on /pair → the daemon collects key, proof and
// token → hello → a session's events → a prompt from the Session page reaches the
// daemon's poll as a verified command → taken / delivered acks show under the strip;
// then Allow on an open permission, Cancel on a working turn, a start from /machines,
// and a theme sending through api.control.
//
//   node scripts/build.mjs && npx vite build --config web/vite.config.ts
//   npx playwright test -c web/e2e/playwright.config.ts
//
// CONTROL_SHOTS=<dir> also writes screenshots of /pair and the strip (desktop + 390 px).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, type CDPSession, expect, type Page, test } from "@playwright/test";

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
      session: { id: this.sid, seq: this.seq++, machine: this.machine, cwd: "/tmp/proj", title: "Control e2e" },
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
    ["dist/cli.js", "--port", String(port), "--state", stateDir, "--no-outbox", "--test-door", "--quiet"],
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
  const box = page.getByLabel("Message for the next turn");
  await expect(box).toBeEnabled();
  await expect(page.locator(".ctl-hint")).toContainText(`${MACHINE} is listening`);
  // The day-grant note lives in the chat context line (Simple mode, the default) or in
  // the strip's note (Advanced): either wording is the same promise.
  await expect(
    page
      .locator(".ctl-context, .ctl-note")
      .filter({ hasText: /passkey once/ })
      .first(),
  ).toBeVisible();
  await shot(page, "strip-ready-desktop");

  await box.fill("Add the Oct 8 row");
  await box.press("Shift+Enter");
  await box.type("and run the tests");
  await box.press("Enter");

  const row = page.locator("li[data-message]").first();
  await expect(row).toHaveAttribute("data-outcome", "queued", { timeout: 20_000 });
  await expect(row).toContainText("waiting for e2e-mac");
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
  await expect(row).toHaveAttribute("data-outcome", "taken");
  await expect(row).toContainText("delivering");
  await daemon.ack(msg.id, "progress", { reply: "Adding the row", seq: 1 });
  await expect(row).toHaveAttribute("data-outcome", "progress");
  await expect(row.locator(".ctl-act-reply")).toContainText("Adding the row");
  await daemon.ack(msg.id, "delivered", { reply: "Added the Oct 8 row; 14 tests pass." });
  await expect(row).toHaveAttribute("data-outcome", "delivered");
  await expect(row).toContainText("delivered · sdk");
  await expect(row.locator(".ctl-act-reply")).toContainText("14 tests pass");
  await shot(page, "strip-delivered-desktop");

  // The second send of the day signs by itself: no passkey hint, same grant.
  await expect(page.locator(".ctl-note")).toHaveCount(0);
});

test("a delivered prompt whose turn is in the chat folds to one line; one that went to a copy links both ways", async () => {
  const box = page.getByLabel("Message for the next turn");
  await box.fill("What is the coolest feature?");
  await box.press("Enter");
  const msg = await daemon.next();
  const row = page.locator(`li[data-message="${msg.id}"]`);
  await daemon.ack(msg.id, "taken", { mode: "resume" });
  const start = events.ev("turn.started", { turn_id: "t-cool", prompt_chars: 120 });
  await events.post(start);
  // The reply stays while it is being written, and once delivered until its turn's words arrive.
  await daemon.ack(msg.id, "progress", { reply: "The control", seq: 1, mode: "resume" });
  await expect(row.locator(".ctl-act-reply")).toContainText("The control");
  await daemon.ack(msg.id, "delivered", { mode: "resume", reply: "The control channel." });
  await expect(row).toHaveAttribute("data-outcome", "delivered");
  await expect(row.locator(".ctl-act-reply")).toContainText("The control channel.");
  await events.post(
    events.ev("turn.ended", { reason: "stop", ms: 900 }),
    events.ev("turn.transcript", {
      turn: 1,
      user: "Message via localhost (sessionpipe control, signed on the sender's device):\n\nWhat is the coolest feature?",
      assistant: "The control channel.",
      at: start.time,
    }),
  );
  await expect(row).toHaveAttribute("data-folded");
  await expect(row.locator(".ctl-act-reply")).toHaveCount(0);
  await expect(row).toContainText("What is the coolest feature?");
  await expect(row).toContainText("delivered · resume");

  // Claude Code's idle notice a minute later asks for nothing: the session stays idle.
  await events.post(
    events.ev("attention.needed", {
      attention_id: "notif-idle",
      kind: "idle",
      message: "Claude is waiting for your input",
    }),
  );
  await expect(page.locator(".sess-state >> visible=true")).toHaveText("Idle");
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
  await daemon.ack(msg.id, "delivered", { mode: "waiter" });
  const row = page.locator(`li[data-message="${msg.id}"]`);
  await expect(row).toContainText("answer");
  await expect(row).toContainText("allow");
  await expect(row).toHaveAttribute("data-outcome", "delivered");
});

test("Cancel on a working turn sends a cancel", async () => {
  await events.post(events.ev("attention.cleared", { attention_id: "perm-1", how: "answered" }));
  await expect(page.locator(".ctl-answer")).toHaveCount(0);
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
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
  // While the answer is out the pair stays, disabled, and a second click goes nowhere.
  await expect(answer).toHaveAttribute("data-answer", "sent");
  await expect(answer.getByRole("button", { name: "Allow" })).toBeDisabled();
  await expect(answer).toContainText("answer sent");
  // The terminal had answered first: the daemon says the prompt is no longer open.
  await daemon.ack(msg.id, "refused", { code: "no_attention" });
  await expect(answer).toHaveAttribute("data-answer", "closed");
  await expect(answer.getByRole("button")).toHaveCount(0);
  await expect(answer).toContainText("answered in the terminal, or expired");
  await expect(page.locator(`li[data-message="${msg.id}"]`)).toContainText("no longer open");
  expect(await daemon.poll(0)).toEqual([]);
  await events.post(events.ev("attention.cleared", { attention_id: "perm-2", how: "answered" }));
  await expect(answer).toHaveCount(0);
});

test("a prompt raised before the daemon's hello cannot be answered here; a tier-0 copy still has a label", async () => {
  // Raised an hour ago, long before this daemon said hello; and with no tool or message.
  const old = events.ev("attention.needed", { attention_id: "perm-3", kind: "permission" });
  old.time = new Date(Date.now() - 3600_000).toISOString();
  await events.post(old);
  const answer = page.locator('.ctl-answer[data-attention="perm-3"]');
  await expect(answer).toBeVisible();
  await expect(answer).toHaveAttribute("data-answer", "pre-hello");
  await expect(answer).toContainText("Allow this?");
  await expect(answer).toContainText("a permission request");
  await expect(answer.getByRole("button", { name: "Allow" })).toBeDisabled();
  await expect(answer.getByRole("button", { name: "Deny" })).toBeDisabled();
  await expect(answer).toContainText("raised before this machine was paired; answer it in its terminal");
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

test("a session is started from /machines in one of the machine's folders", async () => {
  await page.goto("/machines");
  const block = page.getByRole("region", { name: MACHINE });
  await expect(block).toContainText(/paired/i);
  await expect(block).toContainText("daemon online");
  const form = block.getByRole("form", { name: `Start a session on ${MACHINE}` });
  // Custom selects (components/Select.tsx): the trigger carries its value in data-value.
  await expect(form.getByLabel("harness")).toHaveAttribute("data-value", "claude-code");
  await expect(form.getByLabel("folder")).toHaveAttribute("data-value", "/tmp/proj");
  await form.getByLabel("first message").fill("Set up the Oct release branch");
  await shot(page, "machines-start-desktop");
  await form.getByRole("button", { name: "Start session" }).click();

  const msg = await daemon.next();
  expect(msg.cmd).toMatchObject({ kind: "start", text: "Set up the Oct release branch", cwd: "/tmp/proj" });
  const session = String(msg.cmd.session);
  expect(session).toMatch(/^claude-code:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(Object.keys(msg.cmd)).toEqual(["v", "t", "machine", "kind", "session", "text", "cwd", "nonce", "iat"]);
  await daemon.ack(msg.id, "taken");
  await expect(block.locator(`li[data-message="${msg.id}"]`)).toHaveAttribute("data-outcome", "taken");
  await daemon.ack(msg.id, "delivered", { session, reply: "Session started." });
  const link = block.getByRole("link", { name: /Open the new session/ });
  await expect(link).toBeVisible();
  const sid = session.slice("claude-code:".length);
  await expect(link).toHaveAttribute("href", `/s/claude-code/${sid}`);
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

  // A secure page whose browser holds no passkey the machine trusts: the line under the
  // strip says so and points at /add-device.
  await phone.goto(`/s/claude-code/${SID}`);
  const hint = phone.locator(".ctl-untrusted");
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
  const box = phone.getByLabel("Message for the next turn");
  await expect(box).toBeEnabled();
  await expect(phone.locator(".ctl-untrusted")).toHaveCount(0);
  await box.fill("From the phone");
  await box.press("Enter");
  const sent = await daemon.next();
  expect(sent.cmd).toMatchObject({ kind: "prompt", session: `claude-code:${SID}`, text: "From the phone" });
  expect((sent.raw.grant as { cred: string }).cred).toBe(key.id);
  await daemon.ack(sent.id, "delivered", { reply: "Heard from the phone." });
  await expect(phone.locator(`li[data-message="${sent.id}"]`)).toHaveAttribute("data-outcome", "delivered");

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
  await expect(p.getByLabel("Message for the next turn")).toBeDisabled();
  await expect(p.locator(".ctl-hint")).toContainText(/passkeys need https or localhost/i);
  await shot(p, "strip-insecure-desktop");
  const renewed = await daemon.pair();
  await p.goto(`${lan}/pair?code=${encodeURIComponent(renewed.code)}`);
  await expect(p.locator("[data-check]")).toHaveAttribute("data-check", renewed.check);
  await expect(p.getByRole("button", { name: "Approve with passkey" })).toBeDisabled();
  await expect(p.locator(".pair-note--err")).toContainText(/passkeys need https or localhost/i);
  await p.goto(`${lan}/machines`);
  await expect(p.getByRole("region", { name: MACHINE })).toContainText(/passkeys need https or localhost/i);
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
  await expect(p.getByLabel("Message for the next turn")).toBeEnabled();
  await expect(p.locator("li[data-message]").first()).toBeVisible();
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
