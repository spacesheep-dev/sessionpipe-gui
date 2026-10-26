// SPDX-License-Identifier: Apache-2.0
// The README screenshots, from a GUI running in demo mode (see README.md in this folder):
//   node docs/screenshots/shoot.mjs --base http://localhost:7391 \
//     [--themes ../sessionpipe-gui-themes/docs/screenshots] [--out docs/screenshots] [--no-gif] \
//     [--scheme dark|light] [--light a.png,b.png] [--only a.png,b.png]
// Desktop shots are 1440 × 900 at 2×, phone shots an iPhone 13 viewport at 3×, all on the
// default (sessionpipe) skin, which follows the appearance: `--scheme` is the appearance
// every shot gets (dark), `--light` names the shots taken in light instead (by default the
// ones the README shows light), `--only` takes just the named ones. Only demo data ever
// reaches the images: one extra session is posted through the receiver so a permission
// prompt is open for the board, the inbox and the sessions, the demo machine it names is
// enrolled through the test door so its Allow / Deny and New session are live, and search
// reads a generated history home (the server's --search-home), never a real one.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
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
const OUT = path.resolve(args.out ?? "docs/screenshots");
const THEMES = args.themes ? path.resolve(args.themes) : null;
const GIF = !args["no-gif"];
const DEFAULT_SCHEME = args.scheme === "light" ? "light" : "dark";
const DEFAULT_LIGHT = [
  "board.png",
  "board.gif",
  "search.png",
  "session-simple.png",
  "inbox.png",
  "review.png",
  "labels.png",
  "phone-session.png",
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
const ONLY =
  typeof args.only === "string"
    ? new Set(
        args.only
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
const wanted = (file) => !ONLY || ONLY.has(file);
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

/** A passkey the pages "hold" and studio-mac trusts, so New session and the composer read as
 *  they do on a paired device. Its public half only: the shots never sign anything. */
const DEMO_KEY = {
  id: "demo_passkey_studio_0000",
  alg: -7,
  spki: generateKeyPairSync("ec", { namedCurve: "P-256" })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64url"),
};

async function enrollMachine(name) {
  // The door wants a machine id in the protocol's shape; the hello below gives the row its name.
  const id = `m_${name.replace(/[^A-Za-z0-9_-]/g, "_")}_demo_000000000`;
  const r = await fetch(`${CONTROL}/_test/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machine: id, key: DEMO_KEY, name: "studio passkey" }),
  });
  if (!r.ok) return null;
  const { machine, token } = await r.json();
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${CONTROL}/hello`, {
    method: "POST",
    headers: auth,
    // What a sessionpipe 0.9 daemon says: no start options yet (those are 0.10), so New
    // session shows the one line instead of Permission and Model.
    body: JSON.stringify({
      name,
      harnesses: ["claude-code", "codex", "antigravity"],
      modes: ["waiter"],
      mode: "safe",
      home: "/Users/dev",
      folders: ["/Users/dev/code/billing", "/Users/dev/code/search-api"],
      files: true,
      keys: [],
      version: "0.9.0",
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
    ({ SETUP_SEEN, SETTINGS, THEME, mode, scheme, key }) => {
      try {
        localStorage.setItem(SETUP_SEEN, "1");
        localStorage.setItem(SETTINGS, JSON.stringify({ mode }));
        localStorage.setItem(THEME, scheme);
        localStorage.setItem(
          "sessionpipe.passkeys:localhost",
          JSON.stringify([{ ...key, name: "Demo", createdAt: new Date().toISOString() }]),
        );
      } catch {}
    },
    { SETUP_SEEN, SETTINGS, THEME, mode, scheme, key: DEMO_KEY },
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
    ...(opts.clip ? { clip: opts.clip } : {}),
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
await labelSome();
await sleep(1500);

/** The demo's sessions right now (it restarts its scenes, so keys change between runs). */
async function snapshot() {
  return (await (await fetch(`${BASE}/api/ui/snapshot`)).json()).sessions ?? [];
}

/** Colour labels on four rows that hold still (stale ones), so the board shows a few dots. */
async function labelSome() {
  const stale = (await snapshot()).filter((x) => x.state === "stale").slice(0, 4);
  const colors = ["red", "orange", "blue", "green"];
  const sessions = Object.fromEntries(stale.map((x, i) => [x.key, colors[i]]));
  const r = await fetch(`${BASE}/api/ui/labels`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessions, names: { red: "Ship today", blue: "Waiting on review" } }),
  });
  if (!r.ok) log(`labels: ${r.status} ${await r.text()}`);
  return stale[1]?.title;
}

/** Waits for the board's needs-you and working rows (the demo raises them within a minute). */
async function boardReady(page) {
  await page.locator("article.card").first().waitFor();
  await page
    .locator("article.card--needs_you")
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => log("board: no needs-you row in time"));
  await page
    .locator("article.card--working")
    .first()
    .waitFor({ timeout: 60_000 })
    .catch(() => log("board: no working row in time"));
}

/** Takes the focus ring and hover off a page whose field was just used. */
const blur = (page) =>
  page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : null));

const desktopSimple = {
  "board.png": async (page) => {
    await open(page, "/");
    await boardReady(page);
    await shot(page, "board.png");
  },
  "search.png": async (page) => {
    await open(page, "/search?q=webhook");
    await page.locator(".sx-row").first().waitFor({ timeout: 20_000 });
    await sleep(600);
    await blur(page);
    await page.mouse.move(5, 880);
    await shot(page, "search.png");
  },
  "search-palette.png": async (page) => {
    await open(page, "/");
    await page.locator("article.card").first().waitFor();
    await clearToasts(page);
    await page.keyboard.press("Meta+k");
    await page.locator(".pal input").waitFor();
    await page.keyboard.type("webhook", { delay: 30 });
    await page.locator(".pal-section", { hasText: "In transcripts" }).waitFor({ timeout: 20_000 });
    await sleep(300);
    // The first row of "In transcripts", so its preview shows the matched moment.
    const n = await page
      .locator(".pal-row")
      .evaluateAll((els) => els.findIndex((e) => e.dataset.section === "In transcripts"));
    for (let i = 0; i < n; i++) await page.keyboard.press("ArrowDown");
    await sleep(400);
    await shot(page, "search-palette.png");
    await page.keyboard.press("Escape");
  },
  "session-simple.png": async (page) => {
    await open(page, sessionPath(needsKey));
    await page.locator(".timeline--chat").waitFor({ timeout: 20_000 });
    await page.locator(".chat-card, .chat-bubble").first().waitFor({ timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "session-simple.png");
  },
  "new-session.png": async (page) => {
    await open(page, "/");
    await page.locator("article.card").first().waitFor();
    await clearToasts(page);
    await page.keyboard.press("c");
    const sheet = page.locator("[data-new-session]");
    await sheet.waitFor();
    const pick = async (row, label) => {
      await sheet.locator(`[data-ns-row=${row}] button.sel`).click();
      await page.locator(".sel-opt", { hasText: label }).first().click();
    };
    await pick("machine", "studio-mac").catch(() => log("new session: no studio-mac to pick"));
    await pick("agent", "Claude Code").catch(() => log("new session: no Claude Code to pick"));
    await pick("folder", "search-api").catch(() => log("new session: no folder to pick"));
    await sheet
      .locator("textarea")
      .fill("Add a p95 latency panel for the BM25 cache to the staging dashboard, then open a PR.");
    await sleep(400);
    await shot(page, "new-session.png");
    await page.keyboard.press("Escape");
  },
  "inbox.png": async (page) => {
    await open(page, "/inbox");
    await page.locator(".inbox-row").first().waitFor({ timeout: 30_000 });
    // The top of the page: the rows are all there is; the empty rest says nothing.
    await shot(page, "inbox.png", { clip: { x: 0, y: 0, width: 1440, height: 420 } });
  },
  "labels.png": async (page) => {
    const title = await labelSome();
    await open(page, "/");
    await boardReady(page);
    await clearToasts(page);
    const row = page.locator("article.card", { hasText: title ?? "" }).first();
    await row.click({ button: "right", position: { x: 260, y: 14 } });
    const item = page.getByRole("menuitem", { name: /^Label/ }).first();
    await item.waitFor();
    await item.hover();
    await sleep(500);
    await shot(page, "labels.png");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  },
  "subagents.png": async (page) => {
    // The newest run of the demo's subagent scene that has its agents, as a page.
    const s = (await snapshot())
      .filter((x) => (x.agents?.length ?? 0) >= 3)
      .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))[0];
    if (!s) return log("subagents: no session with agents");
    await open(page, sessionPath(s.key));
    await page.locator(".agent-block").first().waitFor({ timeout: 20_000 });
    await page.locator(".agent-block").first().scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const b = document.querySelector(".agent-block");
      if (b) window.scrollBy(0, b.getBoundingClientRect().top - 220);
    });
    await sleep(400);
    await shot(page, "subagents.png");
  },
};

const desktopAdvanced = {
  "review.png": async (page) => {
    await open(page, "/review");
    await page
      .getByRole("button", { name: "7 days" })
      .click()
      .catch(() => {});
    await sleep(1200);
    await shot(page, "review.png");
  },
  "canvas.png": async (page) => {
    await open(page, "/t/canvas");
    // The preset bar's "Machine": one window group per machine.
    const byMachine = page.getByText("Machine", { exact: true }).first();
    await byMachine.waitFor({ timeout: 20_000 });
    await sleep(1500);
    await byMachine.click();
    await sleep(600);
    await page
      .getByRole("button", { name: "Fit", exact: true })
      .click()
      .catch(() => {});
    await sleep(1200);
    await shot(page, "canvas.png");
    if (THEMES) await shot(page, "canvas.png", { themes: true });
  },
};

/** The themes repo's own shots: Office both ways, and the plugin's settings form. */
async function themesExtras(page) {
  await open(page, "/t/office");
  await page.locator("section.room").first().waitFor({ timeout: 20_000 });
  await sleep(1500);
  await shot(page, "office-iso.png", { themes: true });
  await page
    .getByRole("button", { name: "figures", exact: true })
    .click()
    .catch(async () => {
      await page.getByText("figures", { exact: true }).click();
    });
  await sleep(1500);
  await shot(page, "office-figures.png", { themes: true });
  await open(page, "/themes");
  // The settings form alone: the row above it prints the plugin's source path on this machine.
  const form = page.locator("section.plugins form").first();
  await form.waitFor({ timeout: 20_000 });
  await form.scrollIntoViewIfNeeded();
  await sleep(500);
  await shot(page, "ping-a-human.png", { themes: true, locator: form });
}

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
  "phone-wifi-phone.png": (page) => phoneShot(page, "phone-wifi-phone.png", "wifi", "phone"),
};

// ---------- /phone: a lane state from demo data, the routes answered in the page ----------

/** PhoneInfo for one state of the page (the same scenes web/src/mock/phone.ts knows). */
function phoneInfo(scene) {
  const serving = scene === "serving";
  const ts = scene === "tailscale" || serving;
  return {
    lan: { url: "http://192.168.1.20:7373/?k=uik_demo0000000000000000", qr: `${BASE}/api/ui/qr.svg` },
    rpId: serving ? "studio-mac.tail1234.ts.net" : "studio-mac.local",
    tls: true,
    publicUrl: serving ? "https://studio-mac.tail1234.ts.net" : null,
    tailscale: ts
      ? { installed: true, running: true, name: "studio-mac.tail1234.ts.net", serving }
      : { installed: false, running: false, name: null, serving: false },
    trusted: [],
    pending: [],
  };
}

/** Answers the phone routes in the page with one scene; `side: "phone"` makes the page read
 *  as the phone's own view (the setup status says "not this machine"). */
async function stubPhone(page, scene, side = "laptop") {
  const info = phoneInfo(scene);
  const origin = info.publicUrl ?? "https://studio-mac.local:7373";
  await page.route("**/api/ui/phone", (r) => r.fulfill({ json: info }));
  await page.route("**/api/ui/info", async (r) => {
    const real = await (await r.fetch()).json();
    await r.fulfill({ json: { ...real, control: { ...real.control, rpId: info.rpId, origins: [origin] } } });
  });
  await page.route("**/api/ui/control/devices", (r) => r.fulfill({ json: { devices: [] } }));
  if (side === "phone")
    await page.route("**/api/ui/setup/status", (r) => r.fulfill({ status: 403, json: { reason: "not_this_machine" } }));
}

async function phoneShot(page, file, scene, side) {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await stubPhone(page, scene, side);
  await open(page, "/phone");
  await page.locator(".phone-page .steps").first().waitFor({ timeout: 20_000 });
  await sleep(600);
  await shot(page, file);
}

/** Runs each group's shots, one context per appearance that any of them wants. */
async function runGroup(kind, mode, shots, after) {
  for (const scheme of ["dark", "light"]) {
    const names = Object.keys(shots).filter((f) => schemeOf(f) === scheme && wanted(f));
    const extras = after && scheme === DEFAULT_SCHEME && !ONLY;
    if (names.length === 0 && !extras) continue;
    const ctx = await context(kind, mode, scheme);
    const page = await ctx.newPage();
    for (const f of names) await shots[f](page);
    if (extras) await after(page);
    await ctx.close();
  }
}

await runGroup("desktop", "simple", desktopSimple);
await runGroup("desktop", "advanced", desktopAdvanced, THEMES ? themesExtras : null);
await runGroup("phone", "simple", phoneSimple);

// The GIF: six seconds of the board, recorded at 1×, cut from the moment a needs-you card
// is on the board, so the accent reads on the surface it is shot on.
if (GIF && wanted("board.gif")) {
  const has = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  if (!has) log("ffmpeg not found; board.gif skipped");
  else {
    const vdir = path.join(OUT, ".video");
    rmSync(vdir, { recursive: true, force: true });
    const ctx = await context("desktop", "simple", schemeOf("board.gif"), {
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
    const filters = "fps=8,scale=800:-1:flags=lanczos";
    spawnSync(
      "ffmpeg",
      ["-y", "-ss", from, "-t", "6", "-i", src, "-vf", `${filters},palettegen=max_colors=48:stats_mode=diff`, palette],
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
