// SPDX-License-Identifier: Apache-2.0
// The web UI inside the native app, driven in a browser with a fake shell: an init script
// sets window.sessionpipeShell (rxBase "" so requests reach the receiver that serves the
// page) and a stand-in __TAURI_INTERNALS__ whose rx_stream opens the receiver's own SSE
// stream and forwards each frame over the channel, and whose app_* commands live in memory.
// The real shell (apps/desktop) is checked by hand and in screenshots; this pins the page's
// half of the contract (NATIVE-SPEC §2.5, §11.1). The last test proves a browser without
// the flag never loads a byte of the native code.
import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { EVENTS, INFO, sessionUrl, ulid } from "./helpers.js";
import { openInPhone } from "./phone-shell.js";

interface FakeOptions {
  receiver?: boolean;
  firstRunDone?: boolean;
  features?: string[];
  /** No receiver at first, and rx_discover finds this Mac's: "switch" plays the shell
   *  building a new window on it (a reload with the contract set), "stay" plays 0.3.1's
   *  shell, which kept the welcome window and its first frame. */
  discover?: "switch" | "stay";
  /** The stream: "big" grows the receiver's snapshot past 400 KB (sessions cloned) on its
   *  way through the channel, as a busy Mac's is; "silent" opens and sends nothing;
   *  "down" fails every attempt. */
  stream?: "real" | "big" | "silent" | "down";
  /** The shell's platform; "macos" unless a test plays another computer. */
  platform?: string;
}

/** The fake shell, as an init script (runs before any page script, as the shell's does). */
type FakeArgs = [boolean, boolean, string[] | undefined, FakeOptions["discover"], FakeOptions["stream"], string];

function fakeShell() {
  return ([hasReceiver, firstRunDone, features, discover, stream = "real", platform]: FakeArgs) => {
    const KINDS = [
      "snapshot",
      "event",
      "session",
      "forgotten",
      "machine",
      "stats",
      "control",
      "viewers",
      "suggestion",
      "labels",
      "viewState",
    ];
    const w = window as unknown as Record<string, unknown>;
    // A window the (fake) shell built for the receiver it selected.
    const receiver = hasReceiver || sessionStorage.getItem("fake.selected") === "1";
    w.sessionpipeShell = {
      v: 1,
      platform,
      appVersion: "0.3.0",
      features: features ?? ["tray", "notifications", "hotkey", "autostart", "deeplink", "updater"],
      receiver: receiver ? { id: "e2erx00001", name: "This Mac", origin: location.origin, local: true } : null,
      rxBase: receiver ? "" : null,
    };
    // Before the document exists there is no <html> yet (shell.ts sets the attribute too).
    if (document.documentElement) document.documentElement.dataset.shell = platform;
    const callbacks = new Map<number, (raw: unknown) => void>();
    const listeners = new Map<string, number[]>();
    const streams = new Map<number, EventSource>();
    let next = 1;
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    const settings = {
      launchAtLogin: false,
      menuBar: true,
      dockBadge: true,
      keepRunning: true,
      menuBarOnly: false,
      hotkey: null as string | null,
      notifications: { enabled: false, kinds: {}, pausedUntil: null },
      firstRunDone,
      autoUpdate: true,
    };
    const send = (id: number, raw: unknown) => callbacks.get(id)?.(raw);
    w.__emit = (event: string, payload: unknown) => {
      for (const id of listeners.get(event) ?? []) send(id, { event, id: 0, payload });
    };
    w.__calls = calls;
    w.__TAURI_INTERNALS__ = {
      transformCallback(cb: (raw: unknown) => void) {
        const id = next++;
        callbacks.set(id, cb);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        calls.push({ cmd, args });
        switch (cmd) {
          case "plugin:event|listen": {
            const list = listeners.get(args.event as string) ?? [];
            list.push(args.handler as number);
            listeners.set(args.event as string, list);
            return list.length;
          }
          case "rx_stream": {
            const ch = (args.onFrame as { id: number }).id;
            let index = 0;
            const out = (message: unknown) => send(ch, { index: index++, message });
            const sid = next++;
            if (stream === "silent" || stream === "down") {
              setTimeout(() => out(stream === "down" ? { event: "error", retryInMs: 1000 } : { event: "open" }), 50);
              return sid;
            }
            const es = new EventSource(args.path as string);
            es.onopen = () => out({ event: "open" });
            es.onerror = () => out({ event: "error", retryInMs: 1000 });
            const grow = (data: string) => {
              const m = JSON.parse(data);
              const base = m.snapshot.sessions as { key: string; id: string; harness: string }[];
              for (let i = 0; JSON.stringify(m).length < 400_000; i++) {
                const s = base[i % base.length] as { key: string; id: string; harness: string };
                const id = `${s.id}-copy${i}`;
                m.snapshot.sessions.push({ ...s, id, key: `${s.harness}/${id}` });
              }
              const big = JSON.stringify(m);
              w.__snapshotBytes = big.length;
              w.__snapshotSessions = m.snapshot.sessions.length;
              return big;
            };
            for (const k of KINDS)
              es.addEventListener(k, (e) => {
                const data = (e as MessageEvent).data;
                out({ event: k, data: k === "snapshot" && stream === "big" ? grow(data) : data });
              });
            streams.set(sid, es);
            return sid;
          }
          case "rx_stream_close":
            streams.get(args.streamId as number)?.close();
            return null;
          case "app_settings_get":
            return { ...settings };
          case "app_settings_set":
            Object.assign(settings, args.settings);
            return { ...settings };
          case "app_shortcut_set":
            settings.hotkey = (args.hotkey as string | null) ?? null;
            return { ...settings };
          case "app_first_run_done":
            settings.firstRunDone = true;
            return null;
          case "app_notify_status":
            return "undetermined";
          case "app_notify_request":
            return "granted";
          case "app_update_status":
            return { state: "ready", version: "0.3.1", lastChecked: new Date().toISOString() };
          case "rx_discover":
            if (!discover) throw new Error("fake shell: no rx_discover");
            return { local: { id: "e2erx00001", name: "This Mac", origin: location.origin, local: true } };
          case "rx_select":
            if (discover === "switch")
              setTimeout(() => {
                sessionStorage.setItem("fake.selected", "1");
                location.reload();
              }, 50);
            return null;
          case "rx_list":
            return [{ id: "e2erx00001", name: "This Mac", origin: location.origin, local: true, connected: true }];
          case "app_open_view":
            return null;
          default:
            throw new Error(`fake shell: no ${cmd}`);
        }
      },
    };
  };
}

async function openInShell(page: Page, path: string, opts: FakeOptions = {}) {
  const arg: FakeArgs = [
    opts.receiver ?? true,
    opts.firstRunDone ?? true,
    opts.features,
    opts.discover,
    opts.stream,
    opts.platform ?? "macos",
  ];
  await page.addInitScript(fakeShell(), arg);
  await page.goto(path);
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __calls: { cmd: string; args: unknown }[] }).__calls.map((c) => c.cmd));
const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(([e, p]) => (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit(e, p), [
    event,
    payload,
  ] as const);

test.describe("inside the native shell", () => {
  test("the board streams through rx_stream", async ({ page }) => {
    await openInShell(page, "/");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await expect(page.locator("section.group").first()).toBeVisible();
    const cmds = await calls(page);
    expect(cmds).toContain("rx_stream");
    expect(cmds.filter((c) => c === "rx_stream")).toHaveLength(1);
  });

  test("the traffic lights' corner holds nothing", async ({ page }) => {
    await openInShell(page, "/");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    // The sidebar (1440 px): the brand steps aside, the compose button sits past the lights.
    await expect(page.locator(".rail-brand")).toBeHidden();
    const corner = () =>
      page.evaluate(() =>
        [16, 30, 44, 56, 70, 80].flatMap((x) =>
          [12, 24, 36].map((y) => {
            const el = document.elementFromPoint(x, y);
            return el?.closest("button, a, input, [role]") ? `${x},${y}: ${el.outerHTML.slice(0, 60)}` : null;
          }),
        ),
      );
    expect((await corner()).filter(Boolean)).toEqual([]);
    const compose = await page.locator(".rail-compose").boundingBox();
    expect(compose!.x).toBeGreaterThanOrEqual(84);
    // The compact rail (1000 px): the compose button steps under the band.
    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(page.locator(".shell--side")).toHaveCount(0);
    expect((await corner()).filter(Boolean)).toEqual([]);
    const compact = await page.locator(".rail-compose").boundingBox();
    expect(compact!.y).toBeGreaterThanOrEqual(48);
    // A narrow window: the page bar's title starts after the lights.
    await page.setViewportSize({ width: 760, height: 800 });
    const title = await page.locator(".main .bar").first().boundingBox();
    const pad = await page
      .locator(".main .bar")
      .first()
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft));
    expect(title).not.toBeNull();
    expect(pad).toBeGreaterThanOrEqual(84);
  });

  test("menu and navigate events drive the page; menu keys fire once", async ({ page }) => {
    await openInShell(page, "/");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await emit(page, "menu", { action: "go-inbox" });
    await expect(page).toHaveURL(/\/inbox$/);
    await emit(page, "navigate", { to: "/feed" });
    await expect(page).toHaveURL(/\/feed$/);
    // Another origin is refused.
    await emit(page, "navigate", { to: "//evil.example/x" });
    await expect(page).toHaveURL(/\/feed$/);
    await emit(page, "menu", { action: "palette" });
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    // ⌘K is the menu's inside the shell: the page lets it pass, so with no native menu
    // here nothing opens (in the app the menu answers, once).
    await page.locator("main").click({ position: { x: 400, y: 300 } });
    await page.keyboard.press("ControlOrMeta+k");
    await page.waitForTimeout(300);
    await expect(palette).toBeHidden();
    await emit(page, "menu", { action: "settings" });
    await expect(page).toHaveURL(/\/settings$/);
    await emit(page, "menu", { action: "toggle-sidebar" });
    await expect(page.locator("html")).toHaveAttribute("data-rail-hidden", "");
    await expect(page.locator(".rail")).toBeHidden();
  });

  test("the first-run sheet: once, nothing asked until a switch is on", async ({ page }) => {
    await openInShell(page, "/", { firstRunDone: false });
    const sheet = page.getByRole("dialog", { name: "sessionpipe is in your menu bar" });
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    expect(await calls(page)).not.toContain("app_notify_request");
    await sheet.getByRole("switch", { name: "Notify me when a session needs me" }).click();
    await expect(sheet.getByRole("switch", { name: "Notify me when a session needs me" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(await calls(page)).toContain("app_notify_request");
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toBeHidden();
    expect(await calls(page)).toContain("app_first_run_done");
  });

  test("on Windows the first-run sheet says system tray and Ctrl+Alt+N, not menu bar and ⌃⌥N", async ({ page }) => {
    await openInShell(page, "/", { firstRunDone: false, platform: "windows" });
    const sheet = page.getByRole("dialog", { name: "sessionpipe is in your system tray" });
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    await expect(sheet.locator("kbd")).toHaveText("Ctrl+Alt+N");
  });

  test("on Windows the shortcut recorder writes Ctrl+Alt+N", async ({ page }) => {
    await openInShell(page, "/settings?section=app", { platform: "windows" });
    const pane = page.getByRole("tabpanel", { name: "App" });
    await expect(pane).toBeVisible({ timeout: 15_000 });
    await pane.getByRole("button", { name: "Record shortcut" }).click();
    await page.keyboard.press("Control+Alt+KeyN");
    await expect(
      pane.getByRole("button", { name: "New session shortcut: Ctrl+Alt+N. Click to record another" }),
    ).toBeVisible();
  });

  test("Settings › App renders", async ({ page }) => {
    await openInShell(page, "/settings?section=app");
    const pane = page.getByRole("tabpanel", { name: "App" });
    await expect(pane).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("tab", { name: "App" })).toHaveAttribute("aria-selected", "true");
    await expect(pane.getByRole("switch", { name: "Open at login" })).toBeVisible();
    await expect(pane.getByText("This Mac", { exact: true })).toBeVisible();
    await expect(pane.getByText("0.3.1 is ready")).toBeVisible();
    await expect(pane.getByText(/^You have .*Last checked just now\.$/)).toBeVisible();
    await expect(pane.getByRole("button", { name: "Install and relaunch" })).toBeVisible();
    const auto = pane.getByRole("switch", { name: "Check for updates automatically" });
    await expect(auto).toHaveAttribute("aria-checked", "true");
    await auto.click();
    await expect(auto).toHaveAttribute("aria-checked", "false");
    expect(await calls(page)).toContain("app_settings_set");
    await pane.getByRole("button", { name: "Record shortcut" }).click();
    await page.keyboard.press("Control+Alt+KeyN");
    await expect(pane.getByRole("button", { name: /New session shortcut: ⌃⌥N/ })).toBeVisible();
    expect(await calls(page)).toContain("app_shortcut_set");
  });

  test("an installed view opens in its own window", async ({ page }) => {
    await openInShell(page, "/t/e2e-counter");
    await expect(page.getByText("Opens in its own window")).toBeVisible({ timeout: 15_000 });
    // Its code never ran in the app's origin.
    await expect(page.locator(".e2e-counter")).toHaveCount(0);
    await page.getByRole("button", { name: "Open" }).click();
    await expect.poll(() => calls(page)).toContain("app_open_view");
  });

  // The 0.3.1 bug: the app found this Mac's running receiver, selected it, and the window
  // stayed on its first frame for good. The shell's half is pinned in apps/desktop
  // (actions::tests); this is the page's half, with a snapshot the size a busy Mac's is.
  test("a receiver found running: the window switches to it and the board fills, big snapshot and all", async ({
    page,
  }) => {
    await openInShell(page, "/", { receiver: false, discover: "switch", stream: "big" });
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await expect(page.locator("section.group").first()).toBeVisible();
    await expect(page.locator(".board-skeleton")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Welcome to sessionpipe" })).toHaveCount(0);
    const big = await page.evaluate(() => {
      const w = window as unknown as { __snapshotBytes: number; __snapshotSessions: number };
      return { bytes: w.__snapshotBytes, sessions: w.__snapshotSessions };
    });
    expect(big.bytes).toBeGreaterThanOrEqual(300_000);
    // They made it onto the board: the groups count the top-level ones (a subagent's
    // session sits under its parent, and the demo keeps starting new ones meanwhile).
    const counted = await page
      .locator("section.group .group-count")
      .evaluateAll((els) => els.reduce((n, el) => n + (Number.parseInt(el.textContent ?? "", 10) || 0), 0));
    expect(counted).toBeGreaterThan(big.sessions * 0.8);
    expect((await calls(page)).filter((c) => c === "rx_stream")).toHaveLength(1);
  });

  test("a hand-over that never comes ends on the welcome, not the first frame", async ({ page }) => {
    await openInShell(page, "/", { receiver: false, discover: "stay" });
    await expect.poll(() => calls(page)).toContain("rx_select");
    await expect(page.getByRole("heading", { name: "Welcome to sessionpipe" })).toBeVisible({ timeout: 12_000 });
  });

  test("a first snapshot that doesn't come is said, with Retry now", async ({ page }) => {
    await openInShell(page, "/", { stream: "silent" });
    await expect(page.locator(".board-skeleton")).toBeVisible();
    const slow = page.getByRole("heading", { name: "Still connecting to the receiver…" });
    await expect(slow).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Retry now" }).first().click();
    await expect.poll(async () => (await calls(page)).filter((c) => c === "rx_stream").length).toBe(2);
  });

  test("a stream that fails says so on the board, with Retry now", async ({ page }) => {
    await openInShell(page, "/", { stream: "down" });
    await expect(page.getByRole("heading", { name: "No connection to the receiver" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator(".board-skeleton")).toHaveCount(0);
    await expect(page.locator("main").getByRole("button", { name: "Retry now" })).toBeVisible();
  });

  test("a refused key: Receivers… opens Settings › App over the screen, and every other page is the screen", async ({
    page,
  }) => {
    // The receiver answers 401 to this window's key (it holds one the board no longer takes).
    await page.route(/\/api\/ui\/info(\?|$)/, (r) =>
      r.fulfill({ status: 401, contentType: "application/json", body: '{"reason":"unauthorized"}' }),
    );
    await openInShell(page, "/", { stream: "down" });
    const screen = page.locator("[data-key-refused]");
    await expect(screen).toBeVisible({ timeout: 20_000 });
    await expect(screen.getByRole("heading", { name: "Open the board's link again" })).toBeVisible();
    await expect(screen).toContainText("Receivers… opens the app's list of boards, where its link is added again.");
    await expect(screen.getByRole("button", { name: "Scan the code" })).toHaveCount(0);
    await screen.getByRole("button", { name: "Receivers…" }).click();
    await expect(page).toHaveURL(/\/settings\?section=app$/);
    const pane = page.getByRole("tabpanel", { name: "App" });
    await expect(pane).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByText("This Mac", { exact: true })).toBeVisible();
    await expect(pane.getByRole("button", { name: "Add…" })).toBeVisible();
    // Any other page is the screen, not the page.
    await page.goto("/machines");
    await expect(page.locator("[data-key-refused]")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".rail")).toHaveCount(0);
  });

  test("no receiver: the welcome; Try the demo works offline", async ({ page }) => {
    const hits: string[] = [];
    page.on("request", (r) => {
      if (/\/(api|themes|skins|attachments)\//.test(new URL(r.url()).pathname)) hits.push(r.url());
    });
    await openInShell(page, "/", { receiver: false });
    await expect(page.getByRole("heading", { name: "Welcome to sessionpipe" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start sessionpipe" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect…" })).toBeVisible();
    // A Mac's welcome names the Mac.
    await expect(page.getByText("This Mac", { exact: true })).toBeVisible();
    await expect(page.getByText("so this Mac's sessions show up here")).toBeVisible();
    await expect(page.getByText("Nothing leaves this Mac.")).toBeVisible();
    expect(hits).toEqual([]);
    // Offline from here on: the demo needs no receiver.
    await page.route(/\/(api|\.well-known|themes|skins|attachments)\//, (r) => r.abort());
    await page.getByRole("button", { name: "Try the demo" }).click();
    await expect(page).toHaveURL(/\?mock=1/);
    await expect(page.locator("section.group").first()).toBeVisible({ timeout: 15_000 });
  });

  test("on Windows the welcome says this computer, not this Mac", async ({ page }) => {
    await openInShell(page, "/", { receiver: false, platform: "windows" });
    await expect(page.getByRole("heading", { name: "Welcome to sessionpipe" })).toBeVisible();
    await expect(page.getByText("This computer", { exact: true })).toBeVisible();
    await expect(page.getByText("so this computer's sessions show up here")).toBeVisible();
    await expect(page.getByText("Nothing leaves this computer.")).toBeVisible();
    await expect(page.locator("main")).not.toContainText("Mac");
  });
});

// The phone app (phone-shell.ts) at a phone's width: its bars are solid, so a list that runs
// under the tab bar, the collapsed navigation bar or the session's control strip never shows
// through them (native/mobile.css).
test.describe("inside the phone app", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  /** The bar's own ground as a pixel's alpha (255: opaque), and what its ::before draws. */
  const ground = (bar: Locator) =>
    bar.evaluate((el) => {
      const c = document.createElement("canvas").getContext("2d")!;
      c.fillStyle = getComputedStyle(el).backgroundColor;
      c.fillRect(0, 0, 1, 1);
      return { alpha: c.getImageData(0, 0, 1, 1).data[3], before: getComputedStyle(el, "::before").content };
    });
  const SOLID = { alpha: 255, before: "none" };

  test("the tab bar, the collapsed bar and the session's strip are solid over a list; a grouped bar keeps its ground", async ({
    page,
    request,
  }) => {
    await openInPhone(page, "/", { receiver: true });
    // A long board: Done open, scrolled so its rows run under the tab bar.
    const done = page.locator("section.group--done button.group-toggle");
    await done.click({ timeout: 15_000 });
    await expect(page.locator("section.group--done article.card").first()).toBeVisible();
    const tabbar = page.locator("nav.tabbar");
    const bar = page.locator(".main > .page > .bar");
    await page.evaluate(() => window.scrollBy(0, 400));
    await expect(bar).toHaveAttribute("data-collapsed", "");
    const under = await tabbar.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return document.elementsFromPoint(r.left + r.width / 2, r.top + 8).some((e) => !!e.closest("article.card"));
    });
    expect(under, "a row of the board is under the tab bar").toBe(true);
    await expect.poll(() => ground(tabbar)).toEqual(SOLID);
    await expect.poll(() => ground(bar)).toEqual(SOLID);

    // A session waiting on a Bash prompt: the command and Allow/Deny sit in the strip.
    const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
    const id = randomUUID();
    const turn = randomUUID();
    let seq = 0;
    const ev = (type: string, data: Record<string, unknown>, hook: string) => ({
      protocol: 1,
      id: ulid(),
      type,
      time: new Date().toISOString(),
      tier: 1,
      harness: { name: "claude-code", version: "2.1.296", event: hook },
      session: { id, seq: seq++, machine: "e2e-box", cwd: "~/code/e2e", title: "Solid bars", title_source: "custom" },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    });
    const post = async (...events: ReturnType<typeof ev>[]) => {
      const res = await request.post(EVENTS, {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sinkToken}`,
          "sessionpipe-protocol": "1",
        },
        data: { events },
      });
      expect(res.status()).toBe(202);
    };
    const attention = `perm-${id.slice(0, 8)}`;
    await post(
      ev("session.started", { source: "startup" }, "SessionStart"),
      ev("turn.started", { turn_id: turn, prompt_chars: 20 }, "UserPromptSubmit"),
      ev(
        "attention.needed",
        { attention_id: attention, kind: "permission", tool: "Bash", message: "npm run deploy" },
        "PermissionRequest",
      ),
    );
    try {
      await page.goto(sessionUrl("claude-code", id));
      const strip = page.locator(".sess-ctl");
      await expect(strip).toContainText("npm run deploy", { timeout: 15_000 });
      await expect(strip.getByRole("button", { name: /^Allow/ })).toBeVisible();
      await expect(bar).toHaveAttribute("data-collapsed", "");
      for (const b of [tabbar, bar, strip]) await expect.poll(() => ground(b)).toEqual(SOLID);
    } finally {
      // Cleared, so the inbox spec, which waits for nothing to be left to answer, is not
      // left waiting on this one.
      await post(
        ev("attention.cleared", { attention_id: attention, how: "answered" }, "PreToolUse"),
        ev("turn.ended", { turn_id: turn, reason: "stop", ms: 1200 }, "Stop"),
      );
    }

    // A grouped page (Machines) keeps its own ground under its collapsed bar: no grey band.
    await page.setViewportSize({ width: 390, height: 420 });
    await page.goto("/machines");
    await expect(page.locator("section.machine").first()).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(bar).toHaveAttribute("data-collapsed", "");
    const grouped = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await expect.poll(() => bar.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(grouped);
  });
});

test("in a browser nothing native loads", async ({ page }) => {
  const scripts: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "script" || r.resourceType() === "stylesheet") scripts.push(new URL(r.url()).pathname);
  });
  await page.goto("/");
  await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
  await page.goto("/settings");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "App" })).toHaveCount(0);
  expect(await page.locator("html").getAttribute("data-shell")).toBeNull();
  const native = scripts.filter((p) =>
    /\/(shell|stream|bridge|menu|appState|Welcome|FirstRun|AppSettings|native)[-.]/.test(p),
  );
  expect(native).toEqual([]);
});
