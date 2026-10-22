// SPDX-License-Identifier: Apache-2.0
// The README screenshots, from a GUI running in demo mode (see README.md in this folder):
//   node docs/screenshots/shoot.mjs --base http://localhost:7391 --tls https://localhost:7392 \
//     --themes ../sessionpipe-gui-themes/docs/screenshots [--out docs/screenshots] [--no-gif] \
//     [--scheme dark|light] [--light a.png,b.png]
// Desktop shots are 1440 × 900 at 2×, phone shots an iPhone 13 viewport at 3×, all on the
// default (Spacesheep) skin, which follows the appearance: `--scheme` is the appearance
// every shot gets (dark), `--light` names the shots taken in light instead (by default the
// six the README shows light). Only demo data ever reaches the images: one extra session is
// posted through the receiver so a permission prompt is open for the board, the inbox and
// the sessions, and the demo machine it names is enrolled through the test door so its
// Allow / Deny are live.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { chromium, devices } from "@playwright/test";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) =>
      a.startsWith("--")
        ? [a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]
        : null,
    )
    .filter(Boolean),
);
const BASE = args.base ?? "http://localhost:7391";
const TLS = args.tls ?? "https://localhost:7392";
const OUT = path.resolve(args.out ?? "docs/screenshots");
const THEMES = args.themes ? path.resolve(args.themes) : null;
const GIF = !args["no-gif"];
const DEFAULT_SCHEME = args.scheme === "light" ? "light" : "dark";
const DEFAULT_LIGHT = [
  "board.png",
  "board.gif",
  "session-simple.png",
  "inbox.png",
  "review.png",
  "appearance.png",
  "connect.png",
  "phone-session.png",
  "phone-wifi-desktop.png",
  "phone-waiting-phone.png",
];
const LIGHT = new Set(
  typeof args.light === "string"
    ? args.light
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : args.light === true
      ? []
      : DEFAULT_LIGHT,
);
/** The appearance a shot is taken in. */
const schemeOf = (file) => (LIGHT.has(file) ? "light" : DEFAULT_SCHEME);
mkdirSync(OUT, { recursive: true });
if (THEMES) mkdirSync(THEMES, { recursive: true });

const SETUP_SEEN = "sessionpipe-gui.setup.seen";
const SETTINGS = "sessionpipe-gui.settings";
const THEME = "sessionpipe-gui.theme";

const log = (s) => process.stdout.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- data: one open permission, on a machine the test door paired ----------

const info = await (await fetch(`${BASE}/api/ui/info`)).json();
const CONTROL = `${BASE}/api/sessionpipe/v1/control`;

async function enrollMachine(name) {
  // The door wants a machine id in the protocol's shape; the hello below gives the row its name.
  const id = `m_${name.replace(/[^A-Za-z0-9_-]/g, "_")}_demo_000000000`;
  const r = await fetch(`${CONTROL}/_test/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machine: id, name: "studio passkey" }),
  });
  if (!r.ok) return null;
  const { machine, token } = await r.json();
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${CONTROL}/hello`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      name,
      harnesses: ["claude-code", "codex"],
      modes: ["waiter"],
      mode: "safe",
      folders: ["~/code/billing", "~/code/search-api"],
      keys: [],
      version: "0.7.0",
      waiting: [],
    }),
  }).catch(() => {});
  // One poll marks it online for the next 50 s; keep polling in the background.
  const poll = () =>
    fetch(`${CONTROL}?machine=${encodeURIComponent(machine)}&wait=0`, { headers: auth }).catch(() => {});
  await poll();
  const t = setInterval(poll, 20_000);
  t.unref();
  return machine;
}

let seqNo = 0;
const ulid = () => {
  const C = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = Date.now();
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = C[t % 32] + head;
    t = Math.floor(t / 32);
  }
  let tail = "";
  for (let i = 0; i < 16; i++) tail += C[Math.floor(Math.random() * 32)];
  return head + tail;
};

/** A Claude Code session on studio-mac that has just asked before running a deploy. */
async function postNeedsYou() {
  const id = "4f1c2a9e-7d3b-4e8a-9c21-5b6d7e8f9a01";
  const turnId = "01J9ZK3Q7WXYZ0123456789ABC";
  const callId = "toolu_01Deploy7h2k9m4n6p8q";
  const start = Date.now() - 95_000;
  const session = {
    id,
    machine: "studio-mac",
    cwd: "~/code/search-api",
    repo: "github.com/acme/search-api",
    branch: "perf/bm25-cache",
    model: "claude-fable-5-1",
    title: "Ship the BM25 cache to staging",
    title_source: "custom",
  };
  const ev = (type, data, offset, hook) => ({
    protocol: 1,
    id: ulid(),
    type,
    time: new Date(start + offset).toISOString(),
    tier: 3,
    harness: { name: "claude-code", version: "2.1.296", event: hook },
    session: { ...session, seq: seqNo++ },
    privacy: { rulesets: ["secrets@1"], pii: false },
    data,
  });
  const events = [
    ev("session.started", { source: "startup" }, 0, "SessionStart"),
    ev("turn.started", { turn_id: turnId, prompt_chars: 142 }, 2_000, "UserPromptSubmit"),
    ev(
      "tool.started",
      { tool: "Read", call_id: "toolu_01Read0001", turn_id: turnId, input: { file_path: "src/search/bm25.ts" } },
      4_000,
      "PreToolUse",
    ),
    ev(
      "tool.ended",
      {
        tool: "Read",
        call_id: "toolu_01Read0001",
        turn_id: turnId,
        ms: 310,
        ok: true,
        input: { file_path: "src/search/bm25.ts" },
        output: "export class Bm25Cache { … }",
      },
      4_400,
      "PostToolUse",
    ),
    ev(
      "tool.started",
      { tool: "Bash", call_id: "toolu_01Test0002", turn_id: turnId, input: { command: "npm test -- bm25" } },
      6_000,
      "PreToolUse",
    ),
    ev(
      "tool.ended",
      {
        tool: "Bash",
        call_id: "toolu_01Test0002",
        turn_id: turnId,
        ms: 18_400,
        ok: true,
        input: { command: "npm test -- bm25" },
        output: "Tests: 41 passed, 41 total\nTime: 17.9 s",
      },
      24_500,
      "PostToolUse",
    ),
    ev(
      "turn.progress",
      {
        turn_id: turnId,
        user: "Cache the BM25 scores per query and ship it to staging so we can compare p95 against prod.",
        assistant:
          "Tests pass with the cache on (41/41). Deploying the branch to the staging target now; I will compare p95 latency once it is up.",
      },
      60_000,
      "Progress",
    ),
    ev(
      "tool.started",
      { tool: "Bash", call_id: callId, turn_id: turnId, input: { command: "npm run deploy -- --target staging" } },
      90_000,
      "PreToolUse",
    ),
    ev(
      "attention.needed",
      { attention_id: "att_01Deploy", kind: "permission", tool: "Bash", message: "npm run deploy -- --target staging" },
      90_500,
      "PermissionRequest",
    ),
  ];
  // A previous run left the same session behind: forget it first, so these events are not
  // dropped as duplicates and the prompt is raised after the machine's hello (else the GUI
  // reads it as pre-pairing and Allow / Deny stay off).
  await fetch(`${BASE}/api/ui/sessions/claude-code/${id}/forget`, { method: "POST" }).catch(() => {});
  await sleep(300);
  const r = await fetch(`${BASE}/api/sessionpipe/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${info.sinkToken}`, "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
  if (!r.ok) log(`events: ${r.status} ${await r.text()}`);
  return `claude-code:${id}`;
}

// ---------- browser helpers ----------

const browser = await chromium.launch();

/** A context of one kind (desktop / phone), one mode (advanced / simple) and one appearance. */
async function context(kind, mode, scheme = "dark", extra = {}) {
  const base =
    kind === "phone"
      ? { ...devices["iPhone 13"], browserName: undefined, defaultBrowserType: undefined }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
  const ctx = await browser.newContext({
    ...base,
    colorScheme: scheme,
    locale: "en-US",
    timezoneId: "UTC",
    ignoreHTTPSErrors: true,
    ...extra,
  });
  await ctx.addInitScript(
    ({ SETUP_SEEN, SETTINGS, THEME, mode, scheme }) => {
      try {
        localStorage.setItem(SETUP_SEEN, "1");
        localStorage.setItem(SETTINGS, JSON.stringify({ mode }));
        localStorage.setItem(THEME, scheme);
      } catch {}
    },
    { SETUP_SEEN, SETTINGS, THEME, mode, scheme },
  );
  return ctx;
}

async function open(page, url) {
  await page.goto(url.startsWith("http") ? url : `${BASE}${url}`);
  // The pill is in the DOM on every device but visible only on the rail; its class says the state.
  await page.locator(".conn").first().waitFor({ state: "attached", timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector(".conn")?.classList.contains("conn--live"), null, {
    timeout: 20_000,
  });
}

async function settle(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}

/** The live demo raises prompts while we work; their toasts would cover a shot. */
async function clearToasts(page) {
  for (const x of await page.locator(".toasts .toast-x").all()) await x.click().catch(() => {});
}

async function shot(page, file, opts = {}) {
  if (!opts.keepToasts) await clearToasts(page);
  await settle(page);
  const target = opts.themes ? path.join(THEMES ?? OUT, file) : path.join(OUT, file);
  await (opts.locator ?? page).screenshot({
    path: target,
    animations: "disabled",
    ...(opts.locator ? {} : { fullPage: false }),
  });
  const kb = Math.round(statSync(target).size / 1024);
  log(`${path.relative(process.cwd(), target)}  ${kb} KB  ${opts.themes ? "" : schemeOf(file)}`);
}

const sessionPath = (key) => {
  const i = key.indexOf(":");
  return `/s/${encodeURIComponent(key.slice(0, i))}/${encodeURIComponent(key.slice(i + 1))}`;
};

// ---------- the shots, one function each, so a shot can run in either appearance ----------

const machineId = await enrollMachine("studio-mac");
log(
  machineId
    ? `test door: studio-mac enrolled as ${machineId}`
    : "test door: not available (start with --test-door); Allow / Deny will read unpaired",
);
const needsKey = await postNeedsYou();
await sleep(1500);

const desktopAdvanced = {
  "board.png": async (page) => {
    await open(page, "/");
    await page.locator("article.card").first().waitFor();
    await page
      .locator("article.card--needs_you")
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => log("board: no needs-you card in time"));
    await page
      .locator("article.card--working")
      .first()
      .waitFor({ timeout: 60_000 })
      .catch(() => log("board: no working card in time"));
    await shot(page, "board.png");
  },
  "appearance.png": async (page) => {
    await open(page, "/");
    await page.locator("article.card").first().waitFor();
    await page.getByRole("button", { name: "Quick settings" }).click();
    await page.locator(".qs-pop").waitFor();
    await shot(page, "appearance.png");
    await page.keyboard.press("Escape");
    await page.locator(".qs-pop").waitFor({ state: "hidden" });
  },
  "keyboard.png": async (page) => {
    await open(page, "/");
    await page.locator("article.card").first().waitFor();
    await page.keyboard.press("?");
    await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
    await shot(page, "keyboard.png");
    await page.keyboard.press("Escape");
  },
  "inbox.png": async (page) => {
    await open(page, "/inbox");
    await page.locator(".inbox-row").first().waitFor({ timeout: 30_000 });
    await shot(page, "inbox.png");
  },
  "session-advanced.png": async (page) => {
    // The timeline of the session with the open prompt (it has tools, a transcript and the prompt).
    await open(page, sessionPath(needsKey));
    await page.locator("h1.sess-title").waitFor();
    await page.locator("li.tool").first().waitFor({ timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "session-advanced.png");
  },
  "review.png": async (page) => {
    await open(page, "/review");
    await page.getByLabel(/Search transcripts/).fill("webhook");
    await page
      .locator(".rv-hit, .hit, [class*=hit]")
      .first()
      .waitFor({ timeout: 20_000 })
      .catch(() => log("review: no hits rendered"));
    await sleep(800);
    await shot(page, "review.png");
  },
  "connect.png": async (page) => {
    await open(page, "/connect");
    await page.locator(".cmd-text").filter({ hasText: "sessionpipe sink add" }).first().waitFor();
    const qr = page.getByRole("img", { name: /^QR code/ });
    await qr.waitFor();
    await page.waitForFunction((el) => el.naturalWidth > 0, await qr.elementHandle());
    await shot(page, "connect.png");
  },
  "setup.png": async (page) => {
    await open(page, "/setup");
    await sleep(2500); // two polls of the status
    await shot(page, "setup.png");
  },
  "canvas.png": async (page) => {
    await open(page, "/t/canvas");
    const mapBtn = page.getByRole("button", { name: "Map", exact: true });
    await mapBtn.waitFor({ timeout: 20_000 });
    await sleep(1500);
    // The map's on/off lives in the view's server-side storage, so it survives between runs:
    // read the button's state instead of assuming it is off.
    const mapOn = async () => ((await mapBtn.getAttribute("class")) ?? "").includes("is-on");
    if (!(await mapOn())) await mapBtn.click();
    await sleep(400);
    if (!(await mapOn())) log("canvas: the Map toggle did not take");
    await page.getByRole("button", { name: "Tidy", exact: true }).click();
    await sleep(400);
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await sleep(1200);
    await shot(page, "canvas.png");
    if (THEMES) await shot(page, "canvas.png", { themes: true });
  },
  "office.png": async (page) => {
    await open(page, "/t/office");
    await page.locator("section.room").first().waitFor({ timeout: 20_000 });
    await sleep(1500);
    await shot(page, "office.png");
    if (THEMES) {
      await shot(page, "office-iso.png", { themes: true });
      await page
        .getByRole("button", { name: "figures", exact: true })
        .click()
        .catch(async () => {
          await page.getByText("figures", { exact: true }).click();
        });
      await sleep(1500);
      await shot(page, "office-figures.png", { themes: true });
    }
  },
};

/** The themes repo's own shot: the plugin's settings form. */
async function themesExtras(page) {
  await open(page, "/themes");
  // The settings form alone: the row above it prints the plugin's source path on this machine.
  const form = page.locator("section.plugins form").first();
  await form.waitFor({ timeout: 20_000 });
  await form.scrollIntoViewIfNeeded();
  await sleep(500);
  await shot(page, "ping-a-human.png", { themes: true, locator: form });
}

const desktopSimple = {
  "session-simple.png": async (page) => {
    await open(page, sessionPath(needsKey));
    await page.locator(".timeline--chat").waitFor({ timeout: 20_000 });
    await page.locator(".chat-card, .chat-bubble").first().waitFor({ timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "session-simple.png");
  },
};

const phoneSimple = {
  "phone-board.png": async (page) => {
    await open(page, "/");
    await page.locator("article.card").first().waitFor();
    await shot(page, "phone-board.png");
  },
  "phone-session.png": async (page) => {
    await open(page, sessionPath(needsKey));
    await page.locator(".timeline--chat").waitFor({ timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "phone-session.png");
  },
  "phone-trust.png": async (page) => {
    // The trust page of the TLS instance, over plain http (how the QR opens it).
    const tlsHttp = TLS.replace(/^https:\/\/[^/]+/, (m) => `http://127.0.0.1:${new URL(m).port}`);
    const tlsInfo = await (await fetch(`${tlsHttp}/api/ui/info`)).json().catch(() => null);
    if (!tlsInfo) return log("tls instance: not reachable; phone-trust.png skipped");
    await page.goto(`${tlsHttp}/trust?k=${tlsInfo.uiKey}`);
    await page.locator("h1").first().waitFor();
    // The page names the machine the GUI runs on (its mDNS name); the shot shows a demo
    // machine's name instead. Text nodes only; nothing else about the page changes.
    const realHost = tlsInfo.tls?.hostname?.replace(/\.local$/, "") ?? tlsInfo.hostname;
    if (realHost) {
      await page.evaluate((host) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode())
          if (n.nodeValue?.includes(host)) n.nodeValue = n.nodeValue.split(host).join("studio-mac");
      }, realHost);
    }
    await shot(page, "phone-trust.png");
  },
};

// ---------- /phone: each lane state from demo data, the routes answered in the page ----------

/** PhoneInfo for one state of the page (the same scenes web/src/mock/phone.ts knows). */
function phoneInfo(scene, rp = "studio-mac.local") {
  const serving = scene === "serving";
  const ts = scene === "tailscale" || serving;
  const at = Date.now();
  return {
    lan: { url: "http://192.168.1.20:7373/?k=uik_demo0000000000000000", qr: `${BASE}/api/ui/qr.svg` },
    rpId: serving ? "studio-mac.tail1234.ts.net" : rp,
    tls: true,
    publicUrl: serving ? "https://studio-mac.tail1234.ts.net" : null,
    tailscale: ts
      ? { installed: true, running: true, name: "studio-mac.tail1234.ts.net", serving }
      : { installed: false, running: false, name: null, serving: false },
    trusted: scene === "trusted" ? [{ id: "k1", name: "iPhone", addedAt: new Date(at - 95_000).toISOString() }] : [],
    pending:
      scene === "waiting"
        ? [{ id: "req1", name: "iPhone", digits: "482913", since: new Date(at - 20_000).toISOString() }]
        : [],
  };
}

/** Answers the phone routes in the page with one scene; `side: "phone"` makes the page read
 *  as the phone's own view (the setup status says "not this machine"). The phone's https
 *  states are shot on the TLS instance, whose rp id is `localhost`, so `rp` names it then. */
async function stubPhone(page, scene, side = "laptop", rp = "studio-mac.local") {
  const info = phoneInfo(scene, rp);
  const origin = info.publicUrl ?? (rp === "localhost" ? TLS : "https://studio-mac.local:7373");
  await page.route("**/api/ui/phone", (r) => r.fulfill({ json: info }));
  await page.route("**/api/ui/phone/device/*", (r) =>
    r.fulfill({
      json:
        scene === "trusted"
          ? { state: "trusted", digits: "482913", machine: "studio-mac" }
          : { state: "pending", digits: "482913", machine: null },
    }),
  );
  await page.route("**/api/ui/info", async (r) => {
    const real = await (await r.fetch()).json();
    await r.fulfill({ json: { ...real, control: { ...real.control, rpId: info.rpId, origins: [origin] } } });
  });
  await page.route("**/api/ui/control/devices", (r) =>
    r.fulfill({
      json: {
        devices: info.pending.map((p) => ({
          requestId: p.id,
          check: p.digits,
          key: { id: "c1", alg: -7, spki: "" },
          name: p.name,
          device: "iPhone · Safari",
          fromIp: "192.168.1.31",
          createdAt: p.since,
          expiresAt: new Date(Date.parse(p.since) + 600_000).toISOString(),
          status: "pending",
        })),
      },
    }),
  );
  if (side === "phone")
    await page.route("**/api/ui/setup/status", (r) => r.fulfill({ status: 403, json: { reason: "not_this_machine" } }));
}

/** A phone that reloaded mid-wait: the request it filed is remembered for the tab. */
const WAITING_REQUEST = JSON.stringify({
  requestId: "req1",
  check: "482913",
  key: { id: "c1", alg: -7, spki: "" },
  name: "iPhone",
  device: "iPhone · Safari",
  fromIp: "192.168.1.31",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  status: "pending",
});

async function phoneShot(page, file, scene, side, path = "/phone", rp) {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await stubPhone(page, scene, side, rp);
  await open(page, path);
  await page.locator(".phone-page .steps, .ctl-hint[data-wrong-origin]").first().waitFor({ timeout: 20_000 });
  await sleep(600);
  // Step 3 is the point of these two; on the laptop it sits under the Wi-Fi lane's steps.
  if (scene === "waiting" || scene === "trusted")
    await page.evaluate(() => document.querySelector("[data-phone-step='3']")?.scrollIntoView({ block: "end" }));
  await shot(page, file);
}

const phoneDesktop = {
  "phone-tailscale-desktop.png": (page) => phoneShot(page, "phone-tailscale-desktop.png", "tailscale", "laptop"),
  "phone-wifi-desktop.png": (page) => phoneShot(page, "phone-wifi-desktop.png", "wifi", "laptop"),
  "phone-waiting-desktop.png": (page) => phoneShot(page, "phone-waiting-desktop.png", "waiting", "laptop"),
  "phone-trusted-desktop.png": (page) => phoneShot(page, "phone-trusted-desktop.png", "trusted", "laptop"),
  "phone-wrong-origin-desktop.png": (page) =>
    phoneShot(page, "phone-wrong-origin-desktop.png", "wifi", "laptop", sessionPath(needsKey)),
};
// The phone's own waits happen on the https origin: here the TLS instance, whose rp id is localhost.
const phonePhone = {
  "phone-tailscale-phone.png": (page) => phoneShot(page, "phone-tailscale-phone.png", "serving", "phone"),
  "phone-wifi-phone.png": (page) => phoneShot(page, "phone-wifi-phone.png", "wifi", "phone"),
  "phone-waiting-phone.png": async (page) => {
    await page.context().addInitScript((v) => sessionStorage.setItem("sessionpipe.device-request", v), WAITING_REQUEST);
    await phoneShot(page, "phone-waiting-phone.png", "waiting", "phone", `${TLS}/phone`, "localhost");
    await page.evaluate(() => sessionStorage.removeItem("sessionpipe.device-request"));
  },
  "phone-trusted-phone.png": async (page) => {
    await page.context().addInitScript((v) => sessionStorage.setItem("sessionpipe.device-request", v), WAITING_REQUEST);
    await phoneShot(page, "phone-trusted-phone.png", "trusted", "phone", `${TLS}/phone`, "localhost");
    await page
      .locator("[data-added]")
      .waitFor({ timeout: 10_000 })
      .catch(() => log("phone: trusted did not land"));
    await shot(page, "phone-trusted-phone.png");
    await page.evaluate(() => sessionStorage.removeItem("sessionpipe.device-request"));
  },
  "phone-wrong-origin-phone.png": (page) =>
    phoneShot(page, "phone-wrong-origin-phone.png", "wifi", "phone", sessionPath(needsKey)),
};

/** Runs each group's shots, one context per appearance that any of them wants. */
async function runGroup(kind, mode, shots, after) {
  for (const scheme of ["dark", "light"]) {
    const names = Object.keys(shots).filter((f) => schemeOf(f) === scheme);
    const extras = after && scheme === DEFAULT_SCHEME;
    if (names.length === 0 && !extras) continue;
    const ctx = await context(kind, mode, scheme);
    const page = await ctx.newPage();
    for (const f of names) await shots[f](page);
    if (extras) await after(page);
    await ctx.close();
  }
}

await runGroup("desktop", "advanced", desktopAdvanced, THEMES ? themesExtras : null);
await runGroup("desktop", "simple", desktopSimple);
await runGroup("phone", "simple", phoneSimple);
await runGroup("desktop", "advanced", phoneDesktop);
await runGroup("phone", "simple", phonePhone);

// The GIF: six seconds of the board, recorded at 1×, cut from the moment a needs-you card
// is on the board, so the accent reads on the surface it is shot on.
if (GIF) {
  const has = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  if (!has) log("ffmpeg not found; board.gif skipped");
  else {
    const vdir = path.join(OUT, ".video");
    rmSync(vdir, { recursive: true, force: true });
    const ctx = await context("desktop", "advanced", schemeOf("board.gif"), {
      deviceScaleFactor: 1,
      recordVideo: { dir: vdir, size: { width: 1440, height: 900 } },
    });
    const page = await ctx.newPage();
    const t0 = Date.now();
    await open(page, "/");
    await page.locator("article.card").first().waitFor();
    await page
      .locator("article.card--needs_you")
      .first()
      .waitFor({ timeout: 30_000 })
      .catch(() => log("gif: no needs-you card in time"));
    await clearToasts(page);
    const from = ((Date.now() - t0) / 1000 + 0.5).toFixed(1);
    await sleep(8000);
    await ctx.close();
    const video = readdirSync(vdir).find((f) => f.endsWith(".webm"));
    const src = path.join(vdir, video);
    const palette = path.join(vdir, "palette.png");
    const gif = path.join(OUT, "board.gif");
    const filters = "fps=10,scale=960:-1:flags=lanczos";
    spawnSync(
      "ffmpeg",
      ["-y", "-ss", from, "-t", "6", "-i", src, "-vf", `${filters},palettegen=stats_mode=diff`, palette],
      { stdio: "ignore" },
    );
    spawnSync(
      "ffmpeg",
      [
        "-y",
        "-ss",
        from,
        "-t",
        "6",
        "-i",
        src,
        "-i",
        palette,
        "-lavfi",
        `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
        gif,
      ],
      { stdio: "ignore" },
    );
    rmSync(vdir, { recursive: true, force: true });
    log(`${path.relative(process.cwd(), gif)}  ${Math.round(statSync(gif).size / 1024)} KB`);
  }
}

await browser.close();
