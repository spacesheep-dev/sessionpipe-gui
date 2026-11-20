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
import {
  dropStream,
  EVENTS,
  holdBoard,
  INFO,
  openPrompt,
  openSessionsUnchosen,
  sessionUrl,
  tapStream,
  tier1Batch,
  ulid,
} from "./helpers.js";
import { openInPhone } from "./phone-shell.js";

interface FakeOptions {
  receiver?: boolean;
  firstRunDone?: boolean;
  /** What the system says of the app's notifications ("undetermined" unless said), and
   *  the app's own switch and pause as settings.json holds them (off, not paused). */
  notify?: { status?: "granted" | "denied"; enabled?: boolean; pausedUntil?: string };
  features?: string[];
  /** No receiver at first, and rx_discover finds this Mac's: "switch" plays the shell
   *  building a new window on it (a reload with the contract set), "stay" plays 0.3.1's
   *  shell, which kept the welcome window and its first frame. "none" finds nothing, and
   *  "later" nothing until Start sessionpipe has been pressed. */
  discover?: "switch" | "stay" | "none" | "later";
  /** What each press of Start sessionpipe ends in, the last one for every press after it:
   *  the failure rx_start_local rejects with (lifecycle/supervisor.rs UpdateFailure),
   *  "hang" for a start that sends one progress line and never ends, or "ok" for one that
   *  sends it and brings this Mac's receiver (the one the window already shows). */
  start?: StartOutcome[];
  /** The stream: "big" grows the receiver's snapshot past 400 KB (sessions cloned) on its
   *  way through the channel, as a busy Mac's is; "silent" opens and sends nothing;
   *  "down" fails every attempt. */
  stream?: "real" | "big" | "silent" | "down";
  /** The shell's platform; "macos" unless a test plays another computer. */
  platform?: string;
  /** What the app's settings.json holds, over the defaults. */
  settings?: Record<string, boolean>;
  /** Where the app's update is (app_update_status): checked a moment ago and up to date
   *  unless said. */
  update?: UpdateOut;
}

/** The shell's word on the app's update (updater.rs UpdateOut). */
type UpdateOut = { state: string; version?: string; lastChecked?: string; error?: string; progress?: number };
/** An update that is downloaded and waits to be installed. */
const READY: UpdateOut = { state: "ready", version: "0.3.1", lastChecked: new Date().toISOString() };

type StartOutcome = { kind: string; line: string; log?: string } | "hang" | "ok";

/** The fake shell, as an init script (runs before any page script, as the shell's does). */
type FakeArgs = [
  boolean,
  boolean,
  string[] | undefined,
  FakeOptions["discover"],
  FakeOptions["stream"],
  string,
  FakeOptions["settings"],
  StartOutcome[] | undefined,
  UpdateOut | undefined,
];

function fakeShell() {
  return ([
    hasReceiver,
    firstRunDone,
    features,
    discover,
    stream = "real",
    platform,
    saved,
    start,
    update,
  ]: FakeArgs) => {
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
    const notify = (w.__notify ?? {}) as NonNullable<FakeOptions["notify"]>;
    const settings = {
      launchAtLogin: false,
      menuBar: true,
      dockBadge: true,
      keepRunning: true,
      menuBarOnly: false,
      hotkey: null as string | null,
      notifications: { enabled: !!notify.enabled, kinds: {}, pausedUntil: notify.pausedUntil ?? null },
      firstRunDone,
      autoUpdate: true,
      ...saved,
    };
    const send = (id: number, raw: unknown) => callbacks.get(id)?.(raw);
    // Where the app's update is: what app_update_status answers, and what each `update`
    // event says, as the shell's own state is (updater.rs publish).
    let updateNow: UpdateOut = update ?? { state: "idle", lastChecked: new Date().toISOString() };
    w.__emit = (event: string, payload: unknown) => {
      if (event === "update") updateNow = payload as UpdateOut;
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
            return notify.status ?? "undetermined";
          case "app_notify_request":
            return notify.status ?? "granted";
          case "app_notify_open_settings":
            return null;
          case "app_update_status":
            return updateNow;
          // A check begins and stays under way: the test says how it ends (an `update` event).
          case "app_update_check":
            updateNow = { state: "checking", lastChecked: updateNow.lastChecked };
            return updateNow;
          case "app_update_restart":
            return null;
          case "rx_discover":
            if (!discover) throw new Error("fake shell: no rx_discover");
            if (discover === "none" || (discover === "later" && !calls.some((c) => c.cmd === "rx_start_local")))
              return { local: null };
            return { local: { id: "e2erx00001", name: "This Mac", origin: location.origin, local: true } };
          case "rx_start_local": {
            if (!start?.length) throw new Error("fake shell: no rx_start_local");
            const nth = calls.filter((c) => c.cmd === "rx_start_local").length - 1;
            const outcome = start[Math.min(nth, start.length - 1)] as StartOutcome;
            if (outcome !== "hang" && outcome !== "ok") throw outcome;
            send((args.onProgress as { id: number }).id, {
              index: 0,
              message: { step: "install", message: "Installing the background service…" },
            });
            if (outcome === "ok")
              return new Promise((done) =>
                setTimeout(
                  () => done({ id: "e2erx00001", name: "This Mac", origin: location.origin, local: true }),
                  300,
                ),
              );
            return new Promise(() => {});
          }
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
          case "plugin:identity|status":
            // The app's device key, as Rust reads it off the keychain (asked only where the
            // shell lists `signer`). No machine of the demo trusts it.
            return {
              available: true,
              key: { id: "e2e-app-key", alg: -7, spki: "e2e", type: "device", store: "hardware", uv: "each-use" },
              grantExp: null,
            };
          default:
            throw new Error(`fake shell: no ${cmd}`);
        }
      },
    };
  };
}

/** What the page's `navigator.platform` reads in a Windows or Linux app. The keys follow it
 *  (lib/shortcuts.ts: ⌘ on a Mac, Ctrl elsewhere), whatever computer runs the test. */
const NAVIGATOR: Record<string, string> = { windows: "Win32", linux: "Linux x86_64" };

async function openInShell(page: Page, path: string, opts: FakeOptions = {}) {
  // Read by the fake shell as it starts (an init script of its own, before the shell's).
  if (opts.notify)
    await page.addInitScript((n) => {
      (window as unknown as { __notify: unknown }).__notify = n;
    }, opts.notify);
  const arg: FakeArgs = [
    opts.receiver ?? true,
    opts.firstRunDone ?? true,
    opts.features,
    opts.discover,
    opts.stream,
    opts.platform ?? "macos",
    opts.settings,
    opts.start,
    opts.update,
  ];
  await page.addInitScript(fakeShell(), arg);
  const os = NAVIGATOR[opts.platform ?? ""];
  if (os) await page.addInitScript((os) => Object.defineProperty(navigator, "platform", { get: () => os }), os);
  await page.goto(path);
}

/** The keys that reach the page's own handlers from here on, by `code` (a modifier alone
 *  is left out): one the key filter hands to the native menu never does. */
async function keysThePageGets(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __keys: string[] }).__keys = seen;
    document.addEventListener("keydown", (e) => {
      if (!["Control", "Shift", "Alt", "Meta"].includes(e.key)) seen.push(e.code);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __keys: string[] }).__keys);
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __calls: { cmd: string; args: unknown }[] }).__calls.map((c) => c.cmd));
/** The settings the page last sent to app_settings_set. */
const settingsSent = (page: Page) =>
  page.evaluate(() => {
    const all = (window as unknown as { __calls: { cmd: string; args: { settings?: Record<string, unknown> } }[] })
      .__calls;
    return all.filter((c) => c.cmd === "app_settings_set").at(-1)?.args.settings ?? null;
  });
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
    // A narrow window (half a 13-inch screen) keeps the compact rail: the lights are the
    // rail's, so the page bar is padded by the gutter alone, as in the wider window.
    const bar = page.locator(".main .bar").first();
    const padOf = () => bar.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft));
    const wide = await padOf();
    for (const width of [760, 720]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(page.locator(".rail")).toBeVisible();
      await expect(page.locator(".tabbar")).toBeHidden();
      expect((await corner()).filter(Boolean)).toEqual([]);
      expect((await page.locator(".rail").boundingBox())!.width).toBe(80);
      expect((await page.locator(".rail-compose").boundingBox())!.y).toBeGreaterThanOrEqual(48);
      expect(await padOf()).toBe(wide);
      expect(wide).toBeLessThan(84);
    }
    // Narrower than the app's window goes, the phone's layout: no rail, so the page bar's
    // title starts after the lights.
    await page.setViewportSize({ width: 700, height: 800 });
    await expect(page.locator(".rail")).toBeHidden();
    await expect(page.locator(".tabbar")).toBeVisible();
    expect(await padOf()).toBeGreaterThanOrEqual(84);
  });

  test("a window half a 13-inch screen wide is still the Mac app, not the phone's", async ({ page, request }) => {
    await page.setViewportSize({ width: 760, height: 800 });
    await openInShell(page, "/");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await expect(page.locator("section.group").first()).toBeVisible();
    // The desktop's chrome: the rail and no tab bar, the 48 px bar with its title inline.
    await expect(page.locator(".rail")).toBeVisible();
    await expect(page.locator(".tabbar")).toBeHidden();
    const bar = page.locator(".main > .page > .bar");
    await expect(bar).toHaveClass(/bar--inline/);
    expect((await bar.locator(".bar-row, .bar-lead").first().boundingBox())!.height).toBeLessThanOrEqual(48);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bar").trim())).toBe(
      "48px",
    );

    // A row's right-click is a menu at the pointer, not a sheet from the bottom edge, and
    // it keeps what a mouse and a keyboard have: Open beside, with the keys.
    await holdBoard(page);
    const row = page.locator("article.card a.card-link").first();
    const at = (await row.boundingBox())!;
    await row.click({ button: "right", position: { x: 40, y: at.height / 2 } });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(page.locator(".menu-grab")).toHaveCount(0);
    await expect(page.locator(".menu-sheet")).toHaveCount(0);
    const box = (await menu.boundingBox())!;
    expect(Math.abs(box.x - (at.x + 40))).toBeLessThan(24);
    expect(box.width).toBeLessThan(400);
    const beside = menu.getByRole("menuitem", { name: /^Open beside/ });
    await expect(beside).toBeVisible();
    await expect(beside.locator(".menu-keys")).not.toHaveText("");
    await expect(menu.getByRole("menuitem", { name: /^Open in new window/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // A prompt: Allow and Deny at a pointer's size on the question's line, and Back as
    // the chevron alone.
    const prompt = await openPrompt(request, { machine: "e2e-box", title: "A narrow Mac" });
    try {
      await page.goto(sessionUrl(prompt.harness, prompt.sessionId));
      const strip = page.locator(".sess-ctl");
      await expect(strip).toContainText("npm run deploy", { timeout: 15_000 });
      const [allow, deny] = await Promise.all([
        strip.getByRole("button", { name: /^Allow/ }).boundingBox(),
        strip.getByRole("button", { name: /^Deny/ }).boundingBox(),
      ]);
      expect(allow!.height).toBeLessThanOrEqual(32);
      expect(deny!.height).toBeLessThanOrEqual(32);
      expect(Math.round(allow!.y)).toBe(Math.round(deny!.y));
      expect(allow!.width).toBeLessThan(200);
      await expect(page.locator(".bar-back")).toBeVisible();
      await expect(page.locator(".bar-back-label")).toHaveCount(0);
      await expect(page.locator(".tabbar")).toBeHidden();
    } finally {
      // Cleared, so no other spec finds it open.
      await prompt.clear();
    }
  });

  test("in that window a session beside the page covers it, and the window still drags by its band", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 760, height: 800 });
    await openInShell(page, "/");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await holdBoard(page);
    await page
      .locator("article.card a.card-link")
      .first()
      .click({ modifiers: ["Shift"] });
    const panel = page.locator("aside.panel");
    await expect(panel).toHaveClass(/panel--open/);
    await expect(panel).not.toHaveClass(/panel--sheet/);
    // From the rail (80 px, the lights in it) to the window's edge, once it has slid in.
    await expect.poll(async () => Math.round((await panel.boundingBox())!.x)).toBe(80);
    expect(Math.round((await panel.boundingBox())!.width)).toBe(680);
    await expect(page.locator(".rail")).toBeVisible();
    // All there is of the title band past the rail is the panel's head: it drags the window.
    const head = panel.locator(".panel-head");
    const title = (await head.locator(".panel-title").boundingBox())!;
    await page.mouse.move(title.x + title.width + 40, title.y + title.height / 2);
    await page.mouse.down();
    await expect(head).toHaveAttribute("data-tauri-drag-region", "deep");
    await page.mouse.up();
    // The sidebar toggled off (⌃⌘S): the panel has the window, its head after the lights.
    await emit(page, "menu", { action: "toggle-sidebar" });
    await expect(page.locator(".rail")).toBeHidden();
    await expect.poll(async () => Math.round((await panel.boundingBox())!.x)).toBe(0);
    expect(await head.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft))).toBeGreaterThanOrEqual(84);
    await emit(page, "menu", { action: "toggle-sidebar" });
    await expect(page.locator(".rail")).toBeVisible();
  });

  test("⌘, opens Settings over the page you are on; a page from the menu closes it", async ({ page }) => {
    await openInShell(page, "/machines");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    const machines = page.locator(".page .bar-title", { hasText: "Machines" });
    await emit(page, "menu", { action: "settings" });
    await expect(settings).toBeVisible();
    await expect(page).toHaveURL(/\/machines\?settings$/);
    await expect(machines).toBeAttached();
    await expect(page.locator("nav.rail a[data-nav='machines']")).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".board-list")).toHaveCount(0);
    // Again while open: no second window and no second entry, the focus back in it.
    const entries = await page.evaluate(() => history.length);
    await page.locator("nav.rail a[data-nav='inbox']").focus();
    await emit(page, "menu", { action: "settings" });
    await expect(settings).toBeFocused();
    expect(await page.evaluate(() => history.length)).toBe(entries);
    // A deep link to a section (sessionpipe://settings, Check for Updates…) goes to it, in place.
    await emit(page, "navigate", { to: "/settings?section=data" });
    await expect(settings.getByRole("tab", { selected: true })).toHaveText("Data");
    await expect(page).toHaveURL(/\/machines\?settings=data$/);
    // ⌃⌘1 … 5 go where they say, and Settings closes on the way.
    await emit(page, "menu", { action: "go-board" });
    await expect(page).toHaveURL(/\/$/);
    await expect(settings).toHaveCount(0);
    await emit(page, "menu", { action: "settings" });
    await expect(settings).toBeVisible();
    await emit(page, "menu", { action: "go-machines" });
    await expect(page).toHaveURL(/\/machines$/);
    await expect(settings).toHaveCount(0);
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
    await expect(page).toHaveURL(/\/feed\?settings$/);
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/feed$/);
    await emit(page, "menu", { action: "toggle-sidebar" });
    await expect(page.locator("html")).toHaveAttribute("data-rail-hidden", "");
    await expect(page.locator(".rail")).toBeHidden();
  });

  test("a session the app asks for while its window is up opens beside the page, as a preview tab; on Usage it is the page", async ({
    page,
  }) => {
    await openSessionsUnchosen(page);
    await openInShell(page, "/");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await holdBoard(page);
    const links = page.locator("article.card a.card-link");
    await expect.poll(() => links.count()).toBeGreaterThanOrEqual(3);
    const hrefs = await links.evaluateAll((els) => els.slice(0, 3).map((el) => el.getAttribute("href")!));
    const keys = hrefs.map((h) =>
      h
        .replace(/^\/s\//, "")
        .split("/")
        .map(decodeURIComponent)
        .join(":"),
    );
    const panel = page.locator("aside.panel");
    const tabKeys = () =>
      panel
        .locator("[role='tablist'] [role='tab']")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-tab-key")));
    await emit(page, "navigate", { to: `/inbox?s=${encodeURIComponent(`${keys[0]},${keys[1]}`)}` });
    await expect.poll(tabKeys).toEqual([keys[0], keys[1]]);
    // A notification's click (notifications.rs) or the menu bar's session (tray.rs): /s/<h>/<id>.
    await emit(page, "navigate", { to: hrefs[2] });
    await expect.poll(tabKeys).toEqual(keys);
    await expect(panel).toHaveAttribute("data-split", keys[2]!);
    await expect(panel.locator(".tab--preview")).toHaveAttribute("data-tab-key", keys[2]!);
    expect(new URL(page.url()).pathname).toBe("/inbox");
    // Where the panel does not show, the session is its page.
    await emit(page, "navigate", { to: "/usage" });
    await expect(page).toHaveURL(/\/usage/);
    await emit(page, "navigate", { to: hrefs[0] });
    await expect(page).toHaveURL((u) => u.pathname === hrefs[0]);
    // The session already on screen (its banner clicked while the window was behind) stays
    // as it is: no copy of it opens beside its own page.
    const onPage = page.url();
    await emit(page, "navigate", { to: hrefs[0] });
    // With a row to land on, too (the page reads the hash, and drops it).
    await emit(page, "navigate", { to: `${hrefs[0]}#seq-1` });
    await expect(page).toHaveURL(onPage);
    await expect(panel.locator(`[role='tab'][data-tab-key='${keys[0]}']`)).toHaveCount(0);
    // Over Settings the session shows and Settings goes, so the click is seen.
    await emit(page, "navigate", { to: "/inbox" });
    await emit(page, "navigate", { to: "/settings?section=general" });
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings).toBeVisible();
    await emit(page, "navigate", { to: hrefs[1] });
    await expect(page).toHaveURL((u) => u.pathname === hrefs[1] && !u.searchParams.has("settings"));
    await expect(settings).toHaveCount(0);
  });

  test("a machine that doesn't trust the app's key: the palette lists no Allow for it, and its session says Approve this Mac", async ({
    page,
    request,
  }) => {
    // lab-mac is paired in the demo and takes device keys; the app's own is not among its keys.
    const title = `Gate untrusted ${randomUUID().slice(0, 6)}`;
    const s = await openPrompt(request, { machine: "lab-mac", title });
    try {
      await openInShell(page, "/", { features: ["tray", "notifications", "updater", "signer"] });
      await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
      await expect(page.locator(`section.group--needs_you article.card[data-flip="${s.key}"]`)).toBeVisible();
      await emit(page, "menu", { action: "palette" });
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await expect(palette).toBeVisible();
      await page.keyboard.type(title);
      // The session leads, under Sessions: no Allow or Deny that the machine would refuse
      // after Touch ID signed it.
      await expect(palette.locator(".pal-row").first()).toHaveAttribute("data-section", "Sessions");
      await expect(palette.locator(".pal-row[aria-selected='true']")).toContainText(title);
      await expect(palette.getByRole("option", { name: new RegExp(`^(Allow|Deny) .* in ${title}`) })).toHaveCount(0);
      // Enter opens the session, whose composer says the one reason and the way on.
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL((u) => u.pathname === sessionUrl(s.harness, s.sessionId));
      const foot = page.locator('[data-reason="untrusted"]');
      await expect(foot).toContainText("lab-mac doesn't trust this Mac yet.");
      await expect(foot.getByRole("link", { name: "Approve this Mac" })).toBeVisible();
    } finally {
      await s.clear();
    }
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

  // Off a Mac the pages are Ctrl+Shift+1…5, so Ctrl+Alt+1…7 stay the colour labels (and
  // AltGr, which Windows reports as Ctrl+Alt, types its characters).
  test("on Windows Ctrl+Alt+1 labels the row under the cursor, and Ctrl+Shift+2 is the menu's Inbox", async ({
    page,
    request,
  }) => {
    const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
    const b = tier1Batch({ title: "E2E Windows keys" });
    const posted = await request.post(EVENTS, {
      headers: { authorization: `Bearer ${sinkToken}` },
      data: { events: b.events },
    });
    expect(posted.status()).toBe(202);
    // The Windows menu bar, played: View › Inbox answers Ctrl+Shift+2, whatever the page does.
    await page.addInitScript(() => {
      window.addEventListener(
        "keydown",
        (e) => {
          if (!e.ctrlKey || !e.shiftKey || e.altKey || e.code !== "Digit2") return;
          const emit = (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit;
          setTimeout(() => emit("menu", { action: "go-inbox" }));
        },
        true,
      );
    });
    await openInShell(page, "/", { platform: "windows" });
    const card = page.locator(`article.card:has(a.card-link[href^="${sessionUrl(b.harness, b.sessionId)}"])`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    const keys = await keysThePageGets(page);
    // Focus puts the list's cursor on the row.
    await card.locator("a.card-link").focus();
    await expect(card).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Control+Alt+Digit1");
    await expect(card.locator(".card-head .label-dot--red")).toBeVisible();
    await page.keyboard.press("Control+Alt+Digit0");
    await expect(card.locator(".label-dot")).toHaveCount(0);
    // Ctrl+Shift+2 is the menu's: the page lets it pass, and the menu opens the Inbox.
    await page.keyboard.press("Control+Shift+Digit2");
    await expect(page).toHaveURL(/\/inbox$/);
    expect(await keys()).toEqual(["Digit1", "Digit0"]);
  });

  // GTK's menu does not answer Ctrl+Shift+2 where Shift+2 types "@": the key reaches the
  // page, which opens the Inbox itself. Ctrl+K it leaves to the menu, as everywhere.
  test("on Linux Ctrl+Shift+2 opens the Inbox when the menu lets it through", async ({ page }) => {
    await openInShell(page, "/", { platform: "linux" });
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    // The heading, not a card: a plain click on a card opens its session beside.
    await page.getByRole("heading", { name: "Board", exact: true }).click();
    await page.keyboard.press("Control+Shift+Digit2");
    await expect(page).toHaveURL(/\/inbox$/);
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(300);
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
  });

  test("Settings › App renders", async ({ page }) => {
    await openInShell(page, "/settings?section=app", { update: READY });
    const pane = page.getByRole("tabpanel", { name: "App" });
    await expect(pane).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("tab", { name: "App" })).toHaveAttribute("aria-selected", "true");
    await expect(pane.getByRole("switch", { name: "Open at login" })).toBeVisible();
    await expect(pane.getByText("This Mac", { exact: true })).toBeVisible();
    // The app's update is About's: App says nothing of it, with one waiting too.
    await expect(pane.getByText("0.3.1 is ready")).toHaveCount(0);
    await expect(pane.getByRole("switch", { name: "Check for updates automatically" })).toHaveCount(0);
    await expect(pane.getByRole("button", { name: /Check now|Install and relaunch/ })).toHaveCount(0);
    await pane.getByRole("button", { name: "Record shortcut" }).click();
    await page.keyboard.press("Control+Alt+KeyN");
    await expect(pane.getByRole("button", { name: /New session shortcut: ⌃⌥N/ })).toBeVisible();
    expect(await calls(page)).toContain("app_shortcut_set");
  });

  // "Menu bar only" hides the Dock icon, so it needs the menu bar item: with neither, a
  // running app shows nowhere. The shell guards the same pair (settings.rs, normalized).
  test("Settings › App: Menu bar only sits under Show in menu bar and goes with it", async ({ page }) => {
    await openInShell(page, "/settings?section=app");
    const general = page.getByRole("tabpanel", { name: "App" }).getByRole("region", { name: "General" });
    const rows = general.locator(".settings-label");
    await expect(rows).toHaveText([
      "Open at login",
      "Show in menu bar",
      "Menu bar only",
      "Show count on the Dock icon",
      "Keep running when the window is closed",
    ]);
    const only = general.getByRole("switch", { name: "Menu bar only" });
    await expect(only).toBeEnabled();
    await only.click();
    await expect(only).toHaveAttribute("aria-checked", "true");
    // No Dock icon, so no count on it to offer.
    await expect(rows).toHaveText([
      "Open at login",
      "Show in menu bar",
      "Menu bar only",
      "Keep running when the window is closed",
    ]);
    await general.getByRole("switch", { name: "Show in menu bar" }).click();
    await expect(rows).toHaveText([
      "Open at login",
      "Show in menu bar",
      "Show count on the Dock icon",
      "Keep running when the window is closed",
    ]);
    // One patch turns both off: the app is never asked for the pair that hides it.
    expect(await settingsSent(page)).toMatchObject({ menuBar: false, menuBarOnly: false });
    await expect(general.getByRole("switch", { name: "Show count on the Dock icon" })).toBeEnabled();
    // Back on, it comes back off.
    await general.getByRole("switch", { name: "Show in menu bar" }).click();
    await expect(general.getByRole("switch", { name: "Menu bar only" })).toHaveAttribute("aria-checked", "false");
  });

  test("Settings › App: in Menu bar only there is no Dock count to switch", async ({ page }) => {
    await openInShell(page, "/settings?section=app", { settings: { menuBarOnly: true } });
    const general = page.getByRole("tabpanel", { name: "App" }).getByRole("region", { name: "General" });
    await expect(general.getByRole("switch", { name: "Menu bar only" })).toHaveAttribute("aria-checked", "true");
    await expect(general.getByText("Show count on the Dock icon")).toHaveCount(0);
    await expect(general.getByRole("switch", { name: "Keep running when the window is closed" })).toBeVisible();
  });

  test("on Windows Settings › App has no Menu bar only", async ({ page }) => {
    await openInShell(page, "/settings?section=app", { platform: "windows" });
    const general = page.getByRole("tabpanel", { name: "App" }).getByRole("region", { name: "General" });
    await expect(general.locator(".settings-label")).toHaveText([
      "Open at login",
      "Show in menu bar",
      "Show count on the Dock icon",
      "Keep running when the window is closed",
    ]);
    await expect(general.getByRole("switch", { name: "Show count on the Dock icon" })).toBeEnabled();
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

  test("a first snapshot that doesn't come: still connecting to this Mac, with nothing to press", async ({ page }) => {
    await openInShell(page, "/", { stream: "silent" });
    await expect(page.locator(".board-skeleton")).toBeVisible();
    const slow = page.getByRole("heading", { name: "Connecting to sessionpipe on this Mac…" });
    await expect(slow).toBeVisible({ timeout: 10_000 });
    const state = page.locator("main .state");
    await expect(state).toHaveAttribute("role", "status");
    await expect(state.getByRole("button")).toHaveCount(0);
    // A wait, not a failure: nothing on the page offers a retry, and the bar says nothing.
    await expect(page.getByRole("button", { name: /^(Retry|Try again|Start sessionpipe)$/ })).toHaveCount(0);
    await expect(page.locator(".bar-conn")).toHaveCount(0);
  });

  test("a stream that fails names this Mac, offers Start sessionpipe beside Retry, and is said once", async ({
    page,
  }) => {
    await openInShell(page, "/", { stream: "down" });
    await expect(page.getByRole("heading", { name: "Can't reach sessionpipe on this Mac" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator(".board-skeleton")).toHaveCount(0);
    const state = page.locator("main .state");
    await expect(state).toHaveAttribute("role", "status");
    await expect(state.getByRole("button")).toHaveText(["Start sessionpipe", "Retry"]);
    // Before the first snapshot the board's own state is the one statement, with the one Retry.
    await expect(page.getByRole("button", { name: /^(Retry|Try again)$/ })).toHaveCount(1);
    await expect(page.locator(".bar-conn")).toHaveCount(0);
    // The sidebar's foot is its dot, named by its tooltip in the same words: no button.
    const dot = page.locator(".rail .conn");
    await expect(dot).toHaveAttribute("data-tip", "Can't reach sessionpipe on this Mac");
    await expect(dot).toHaveText("");
    await expect(dot.locator("button")).toHaveCount(0);
    await expect(page.getByText(/Reconnecting|receiver/)).toHaveCount(0);
    // Retry asks again at once.
    const asked = (await calls(page)).filter((c) => c === "rx_stream").length;
    await state.getByRole("button", { name: "Retry" }).click();
    await expect.poll(async () => (await calls(page)).filter((c) => c === "rx_stream").length).toBeGreaterThan(asked);
  });

  test("Start sessionpipe on a board that can't reach this Mac: its progress as the title, then this Mac selected and the stream asked again", async ({
    page,
  }) => {
    await openInShell(page, "/", { stream: "down", start: ["ok"] });
    const state = page.locator("main .state");
    await expect(page.getByRole("heading", { name: "Can't reach sessionpipe on this Mac" })).toBeVisible({
      timeout: 10_000,
    });
    const asked = (await calls(page)).filter((c) => c === "rx_stream").length;
    await state.getByRole("button", { name: "Start sessionpipe" }).click();
    // While it works: the installer's line is the title, Start can't be pressed, Retry steps aside.
    await expect(page.getByRole("heading", { name: "Installing the background service…" })).toBeVisible();
    const start = state.getByRole("button", { name: "Start sessionpipe" });
    await expect(start).toHaveAttribute("aria-busy", "true");
    await expect(start).toHaveAttribute("aria-disabled", "true");
    await expect(state.getByRole("button", { name: "Retry" })).toHaveCount(0);
    // It brought this Mac's receiver: selected, then the board connects again.
    await expect.poll(() => calls(page)).toContain("rx_select");
    const all = await calls(page);
    expect(all.indexOf("rx_select")).toBeGreaterThan(all.indexOf("rx_start_local"));
    const select = await page.evaluate(
      () =>
        (window as unknown as { __calls: { cmd: string; args: { id?: string } }[] }).__calls.find(
          (c) => c.cmd === "rx_select",
        )?.args.id,
    );
    expect(select).toBe("e2erx00001");
    await expect.poll(async () => (await calls(page)).filter((c) => c === "rx_stream").length).toBeGreaterThan(asked);
    // The receiver is still away here, so the board says so again, with Start ready to press.
    await expect(page.getByRole("heading", { name: "Can't reach sessionpipe on this Mac" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(state.getByRole("button", { name: "Start sessionpipe" })).not.toHaveAttribute("aria-busy");
  });

  test("a start from the board that fails says it as the welcome does, and Try again starts it again", async ({
    page,
  }) => {
    await openInShell(page, "/", {
      stream: "down",
      start: [{ kind: "download", line: "npm error code E404 sessionpipe-gui" }, "hang"],
    });
    const state = page.locator("main .state");
    await state.getByRole("button", { name: "Start sessionpipe" }).click({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "It didn't start." })).toBeVisible();
    await expect(state.getByRole("button")).toHaveText(["Try again"]);
    await state.locator("summary").click();
    await expect(state.getByText("npm error code E404 sessionpipe-gui")).toBeVisible();
    await state.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: "Installing the background service…" })).toBeVisible();
    expect((await calls(page)).filter((c) => c === "rx_start_local")).toHaveLength(2);
  });

  test("before the first snapshot a page with no loading state of its own says it in its bar", async ({ page }) => {
    await openInShell(page, "/machines", { stream: "silent" });
    const bar = page.locator(".bar .bar-conn");
    await expect(bar).toContainText("Connecting…", { timeout: 5000 });
    await expect(bar.getByRole("button")).toHaveCount(0);
    await expect(page.locator(".rail .conn")).toHaveAttribute("data-tip", "Connecting…");
  });

  test("before the first snapshot a page with no loading state of its own says a failure in its bar, with Retry", async ({
    page,
  }) => {
    await openInShell(page, "/machines", { stream: "down" });
    const bar = page.locator(".bar .bar-conn");
    await expect(bar).toContainText("Can't reach sessionpipe on this Mac", { timeout: 10_000 });
    await expect(bar.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText(/Reconnecting/)).toHaveCount(0);
    await expect(page.locator("[data-conn-announcer]")).toHaveText("Can't reach sessionpipe on this Mac.");
  });

  test("with the sidebar hidden, a dropped stream is said in the page bar, with Retry", async ({ page }) => {
    await tapStream(page);
    await openInShell(page, "/");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await expect(page.locator("section.group").first()).toBeVisible();
    await emit(page, "menu", { action: "toggle-sidebar" });
    await expect(page.locator("html")).toHaveAttribute("data-rail-hidden", "");
    await expect(page.locator("nav.rail")).toBeHidden();

    const back = await dropStream(page);
    // The rows are dimmed, and the bar over them says why: its words, and the one Retry.
    await expect(page.locator(".page.board")).toHaveClass(/board--down/);
    const bar = page.locator(".page.board .bar .bar-conn");
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Reconnecting…");
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(1);
    // Spoken too, though the sidebar and its dot are not drawn.
    await expect(page.locator("[data-conn-announcer]")).toHaveText("Reconnecting.");

    // Retry asks at once (the receiver is still away, so the bar goes on saying so)…
    const asked = (await calls(page)).filter((c) => c === "rx_stream").length;
    await bar.getByRole("button", { name: "Retry", exact: true }).click();
    await expect
      .poll(async () => (await calls(page)).filter((c) => c === "rx_stream").length, { timeout: 700 })
      .toBeGreaterThan(asked);
    await expect(bar).toBeVisible();
    // …and once it answers, the bar is the board's own again.
    await back();
    await page.evaluate(() => document.querySelector<HTMLButtonElement>(".bar-conn button")?.click());
    await expect(page.locator(".bar-conn")).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator(".page.board")).not.toHaveClass(/board--down/);
    await expect(page.locator("[data-conn-announcer]")).toHaveText("Reconnected.");
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

  // Start sessionpipe that didn't start (native/StartHere.tsx): one row, one sentence and
  // one button in every state. The shell's words are lifecycle/supervisor.rs StartError's.
  const startRow = (page: Page) => page.locator('[data-welcome="start"]');
  const starts = async (page: Page) => (await calls(page)).filter((c) => c === "rx_start_local").length;

  test("no Node on this Mac: the welcome says where to get it, and shows no command", async ({ page }) => {
    await openInShell(page, "/", {
      receiver: false,
      start: [{ kind: "noNode", line: "sessionpipe needs Node 22.12 or later, or Node 20 from 20.19 on" }],
    });
    const row = startRow(page);
    await row.getByRole("button", { name: "Start sessionpipe" }).click();
    await expect(row.locator(".form-caption")).toHaveText(
      "Install Node 22.12 or later (or Node 20 from 20.19 on) from nodejs.org, then try again.",
    );
    // Only the site's name is the link, and the shell opens it in the browser (a new window).
    const link = row.getByRole("link");
    await expect(link).toHaveText("nodejs.org");
    await expect(link).toHaveAttribute("href", "https://nodejs.org/en/download");
    await expect(link).toHaveAttribute("target", "_blank");
    // No command to run by hand (the one there was named a package npm doesn't have), no Details.
    await expect(page.locator(".cmdwell")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("npx");
    await expect(row.locator("details")).toHaveCount(0);
    // One button, and it starts again.
    await expect(row.getByRole("button")).toHaveCount(1);
    expect(await starts(page)).toBe(1);
    await row.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => starts(page)).toBe(2);
    await expect(row.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  test("a start that failed: one sentence, the raw line under Details, and Try again starts over", async ({ page }) => {
    const line =
      "couldn't download sessionpipe (npm error 404 Not Found - GET https://github.com/spacesheep-dev/sessionpipe-gui/releases/download/v0.3.0/sessionpipe-gui-0.3.0.tgz); nothing was changed";
    await openInShell(page, "/", { receiver: false, start: [{ kind: "download", line }, "hang"] });
    const row = startRow(page);
    // From the keyboard, as Return on the window's first button.
    await row.getByRole("button", { name: "Start sessionpipe" }).focus();
    await page.keyboard.press("Enter");
    const caption = row.locator(".form-caption");
    await expect(caption).toHaveText("It didn't start.");
    await expect(caption).toHaveClass(/welcome-error/);
    await expect(caption).toHaveAttribute("aria-live", "polite");
    // The button kept the focus through the start (a disabled one would have dropped it).
    const again = row.getByRole("button", { name: "Try again" });
    await expect(again).toBeFocused();
    // The raw line is folded away, outside what is read out, until Details is opened.
    const details = row.locator("details");
    await expect(details).not.toHaveAttribute("open");
    await expect(row.getByText(line)).toBeHidden();
    expect(await caption.evaluate((el) => el.contains(document.querySelector("details")))).toBe(false);
    await details.locator("summary").click();
    await expect(row.getByText(line)).toBeVisible();
    await expect(row.getByRole("button", { name: "Copy details" })).toBeVisible();
    // It wraps inside the row instead of scrolling sideways.
    const well = details.locator(".cmdwell-text");
    expect(await well.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    // Return on the button tries again: back to the progress line, the Details gone, and
    // the focus still on it.
    await again.focus();
    await page.keyboard.press("Enter");
    await expect(caption).toHaveText("Installing the background service…");
    await expect(caption).not.toHaveClass(/welcome-error/);
    await expect(details).toHaveCount(0);
    expect(await starts(page)).toBe(2);
    const working = row.getByRole("button", { name: "Start sessionpipe" });
    await expect(working).toBeDisabled();
    await expect(working).toHaveAttribute("aria-busy", "true");
    await expect(working).toBeFocused();
    // Pressing it while it works starts nothing more.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    expect(await starts(page)).toBe(2);
  });

  test("started, and still loading: said in the caption's own colour, with nothing to unfold", async ({ page }) => {
    await openInShell(page, "/", {
      receiver: false,
      start: [
        {
          kind: "timeout",
          line: "sessionpipe started but isn't answering on port 7373 yet; a big board takes a while to load",
        },
      ],
    });
    const row = startRow(page);
    await row.getByRole("button", { name: "Start sessionpipe" }).click();
    const caption = row.locator(".form-caption");
    await expect(caption).toHaveText("Give it a minute to load, then try again.");
    await expect(caption).not.toHaveClass(/welcome-error/);
    await expect(row.locator("details")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  test("another install at work: the button waits, and the receiver it brings is taken", async ({ page }) => {
    await page.clock.install();
    await openInShell(page, "/", {
      receiver: false,
      discover: "later",
      start: [{ kind: "busy", line: "an install or update is already running" }],
    });
    const row = startRow(page);
    await row.getByRole("button", { name: "Start sessionpipe" }).click();
    // Pressing again would only be refused: it reads as starting, and can't be pressed.
    const button = row.getByRole("button");
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("aria-busy", "true");
    await expect(row.locator(".form-caption")).toHaveText("Starting sessionpipe…");
    expect(await calls(page)).not.toContain("rx_select");
    // Two seconds on it looks for the receiver, finds it and hands the window to it.
    await page.clock.fastForward(2000);
    await expect.poll(() => calls(page)).toContain("rx_select");
    expect(await starts(page)).toBe(1);
  });

  test("another install that brings no receiver in two minutes: it didn't start, Try again", async ({ page }) => {
    await page.clock.install();
    await openInShell(page, "/", {
      receiver: false,
      discover: "none",
      start: [{ kind: "stillRunning", line: "the update is still finishing; it carries on in the background" }],
    });
    const row = startRow(page);
    await row.getByRole("button", { name: "Start sessionpipe" }).click();
    await expect(row.getByRole("button")).toBeDisabled();
    const asked = async () => (await calls(page)).filter((c) => c === "rx_discover").length;
    const atLaunch = await asked();
    await page.clock.fastForward(2000);
    await expect.poll(asked).toBe(atLaunch + 1);
    await expect(row.locator(".form-caption")).toHaveText("Starting sessionpipe…");
    await page.clock.fastForward(120_000);
    await expect(row.locator(".form-caption")).toHaveText("It didn't start.");
    await expect(row.getByRole("button", { name: "Try again" })).toBeEnabled();
    await row.locator("summary").click();
    await expect(row.getByText("the update is still finishing; it carries on in the background")).toBeVisible();
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

// The app's own update has one home, Settings › About, under the version it replaces: one
// sentence a state, the menu's Check for Updates… lands there, and a downloaded update shows
// as a dot on the sidebar's Settings button (NATIVE-SPEC §3.7).
test.describe("the app's update", () => {
  const about = (page: Page) => page.getByRole("tabpanel", { name: "About" });
  /** The update's row: its sentence, its caption, and its button if it has one. */
  const updateRow = (page: Page) => about(page).locator(".settings-row:has(.app-update-ctl)");
  const settingsButton = (page: Page) => page.locator("nav.rail a[data-nav='settings']");

  test("Settings › About in the app: the app's version, the background service's where it differs, and updates that work", async ({
    page,
  }) => {
    const asked: string[] = [];
    page.on("request", (r) => asked.push(new URL(r.url()).pathname));
    await openInShell(page, "/settings?section=about");
    const pane = about(page);
    // The app is 0.3.0 (the fake shell's), whatever the receiver that serves the page runs.
    await expect(pane.getByText("Version 0.3.0", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByText(/^This Mac's background service runs \d+\.\d+\.\d+\S*\.$/)).toBeVisible();
    await expect(pane.getByText("Every coding agent you run, on one board.")).toBeVisible();
    await expect(pane.locator(".about-foot")).toHaveText("Apache-2.0");
    // The row that works stands where the sentence that it can't was.
    await expect(pane.getByText(/doesn't check for updates/)).toHaveCount(0);
    const row = updateRow(page);
    await expect(row.locator(".settings-label")).toHaveText("Up to date");
    await expect(row.locator(".settings-hint")).toHaveText("Checked just now.");
    await expect(row.getByRole("button")).toHaveText("Check now");
    const auto = pane.getByRole("switch", { name: "Check for updates automatically" });
    await expect(auto).toHaveAttribute("aria-checked", "true");
    await auto.click();
    await expect(auto).toHaveAttribute("aria-checked", "false");
    expect(await settingsSent(page)).toMatchObject({ autoUpdate: false });
    // No receiver has an update route: nothing asks for one.
    expect(asked.filter((p) => p.startsWith("/api/ui/update"))).toEqual([]);
  });

  test("a downloaded update says what's new in it, and installs", async ({ page }) => {
    await openInShell(page, "/settings?section=about", { update: READY });
    const row = updateRow(page);
    await expect(row.locator(".settings-label")).toHaveText("0.3.1 is ready", { timeout: 15_000 });
    const notes = row.getByRole("link", { name: "What's new in 0.3.1 ↗" });
    await expect(notes).toHaveAttribute(
      "href",
      "https://github.com/spacesheep-dev/sessionpipe-gui/releases/tag/v0.3.1",
    );
    await expect(notes).toHaveAttribute("target", "_blank");
    await expect(about(page).getByText(/You have/)).toHaveCount(0);
    const install = row.getByRole("button", { name: "Install and relaunch" });
    await expect(install).toHaveClass(/btn--primary/);
    await install.click();
    await expect.poll(() => calls(page)).toContain("app_update_restart");
  });

  test("one sentence for each state, and a button only where there is something to press", async ({ page }) => {
    // Nothing has checked yet (the first seconds of a launch, or the automatic check off).
    await openInShell(page, "/settings?section=about", { update: { state: "idle" } });
    const row = updateRow(page);
    const says = async (label: string, hint: string | null, button: string | null) => {
      await expect(row.locator(".settings-label")).toHaveText(label);
      if (hint === null) await expect(row.locator(".settings-hint")).toHaveCount(0);
      else await expect(row.locator(".settings-hint")).toHaveText(hint);
      if (button === null) await expect(row.getByRole("button")).toHaveCount(0);
      else await expect(row.getByRole("button")).toHaveText(button);
    };
    await expect(row).toBeVisible({ timeout: 15_000 });
    await says("Not checked yet", null, "Check now");
    await emit(page, "update", { state: "checking" });
    await says("Checking…", null, null);
    await emit(page, "update", { state: "downloading", version: "0.3.1", progress: 42 });
    await says("Downloading 0.3.1… 42%", null, null);
    const lastChecked = new Date().toISOString();
    // A download or an install that failed names its version; a check that failed has none.
    await emit(page, "update", {
      state: "error",
      version: "0.3.1",
      error: "The download didn't finish.",
      lastChecked,
    });
    await says("Couldn't update to 0.3.1", "The download didn't finish.", "Try again");
    await emit(page, "update", {
      state: "error",
      error: "You're offline, or GitHub can't be reached.",
      lastChecked,
    });
    await says("Couldn't check for updates", "You're offline, or GitHub can't be reached.", "Try again");
    await row.getByRole("button", { name: "Try again" }).click();
    await says("Checking…", null, null);
    expect(await calls(page)).toContain("app_update_check");
  });

  test("Check now from the keyboard: the focus waits in the row, and is back on the button", async ({ page }) => {
    await openInShell(page, "/settings?section=about");
    const row = updateRow(page);
    await row.getByRole("button", { name: "Check now" }).focus();
    await page.keyboard.press("Enter");
    await expect(row.locator(".settings-label")).toHaveText("Checking…");
    // No button to hold it: the focus stays in the row, so Tab goes on from here.
    await expect(row.locator(".app-update-ctl")).toBeFocused();
    await emit(page, "update", { state: "idle", lastChecked: new Date().toISOString() });
    await expect(row.getByRole("button", { name: "Check now" })).toBeFocused();
    // An update that came of it is not put under the finger: Tab reaches Install and relaunch.
    await page.keyboard.press("Enter");
    await expect(row.locator(".app-update-ctl")).toBeFocused();
    await emit(page, "update", READY);
    await expect(row.getByRole("button", { name: "Install and relaunch" })).toBeVisible();
    await expect(row.locator(".app-update-ctl")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(row.getByRole("button", { name: "Install and relaunch" })).toBeFocused();
  });

  test("a downloaded update puts a dot on the sidebar's Settings button, which opens About", async ({ page }) => {
    await openInShell(page, "/");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    const settings = settingsButton(page);
    await expect(settings).toHaveAttribute("aria-label", "Settings");
    await expect(settings).toHaveAttribute("href", "/?settings");
    await emit(page, "update", { state: "downloading", version: "0.3.1", progress: 10 });
    await expect(settings.locator(".nav-dot")).toHaveCount(0);
    await emit(page, "update", READY);
    await expect(settings).toHaveAttribute("aria-label", "Settings, 0.3.1 is ready");
    await expect(settings).toHaveAttribute("data-tip", "Settings · 0.3.1 is ready");
    // The quiet 6 px dot at the button's top right, in the sidebar and in the compact rail.
    const dot = settings.locator(".nav-dot");
    for (const width of [1440, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(".shell--side")).toHaveCount(width === 1440 ? 1 : 0);
      await expect(dot).toBeVisible();
      const b = (await settings.boundingBox())!;
      const d = (await dot.boundingBox())!;
      expect([d.width, d.height]).toEqual([6, 6]);
      expect(d.x + d.width / 2).toBeGreaterThan(b.x + b.width / 2);
      expect(d.x + d.width).toBeLessThanOrEqual(b.x + b.width);
      expect(d.y + d.height / 2).toBeLessThan(b.y + b.height / 2);
      expect(d.y).toBeGreaterThanOrEqual(b.y);
    }
    await settings.click();
    await expect(page).toHaveURL(/\/\?settings=about$/);
    await expect(updateRow(page).locator(".settings-label")).toHaveText("0.3.1 is ready");
    // Installed, or checked again: the dot goes with it.
    await emit(page, "update", { state: "checking" });
    await expect(dot).toHaveCount(0);
    await expect(settings).toHaveAttribute("aria-label", "Settings");
  });

  test("a window opened after the download knows of it, with Settings never opened", async ({ page }) => {
    await openInShell(page, "/", { update: READY });
    await expect(settingsButton(page)).toHaveAttribute("aria-label", "Settings, 0.3.1 is ready", {
      timeout: 15_000,
    });
    expect((await calls(page)).filter((c) => c === "app_update_status")).toHaveLength(1);
  });

  test("an app that doesn't update itself asks for no update and shows none", async ({ page }) => {
    await openInShell(page, "/settings?section=about", { update: READY, features: ["tray", "notifications"] });
    const pane = about(page);
    await expect(pane.getByText("Version 0.3.0", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByRole("switch", { name: "Check for updates automatically" })).toHaveCount(0);
    await expect(pane.locator(".app-update-ctl")).toHaveCount(0);
    await expect(settingsButton(page)).toHaveAttribute("aria-label", "Settings");
    await expect(settingsButton(page).locator(".nav-dot")).toHaveCount(0);
    expect(await calls(page)).not.toContain("app_update_status");
  });

  // The app menu's item (updater.rs check_from_menu) navigates here and runs the check.
  test("Check for Updates… lands on Settings › About, where the check shows", async ({ page }) => {
    await openInShell(page, "/");
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await emit(page, "navigate", { to: "/settings?section=about" });
    await expect(page.getByRole("tab", { name: "About" })).toHaveAttribute("aria-selected", "true");
    const row = updateRow(page);
    await expect(row.locator(".settings-label")).toHaveText("Up to date");
    await emit(page, "update", { state: "checking" });
    await expect(row.locator(".settings-label")).toHaveText("Checking…");
    await emit(page, "update", READY);
    await expect(row.getByRole("button", { name: "Install and relaunch" })).toBeVisible();
  });
});

// The Mac app posts a prompt's notification itself (apps/desktop macos/notify.rs): there is
// one switch for it, in Settings › Notifications, in the app's own words; the Inbox's bell
// and note follow that switch and what macOS allows; and a prompt macOS sounds for is not
// sounded a second time by its toast.
test.describe("notifications in the Mac app", () => {
  const SWITCH = "Notify me when a session needs me";
  const ON = { status: "granted", enabled: true } as const;

  const openPane = async (page: Page, opts: FakeOptions = {}) => {
    await openInShell(page, "/settings?section=notifications", opts);
    const pane = page.getByRole("tabpanel", { name: "Notifications" });
    await expect(pane.getByText("Sounds for")).toBeVisible({ timeout: 15_000 });
    return pane;
  };
  /** The notifications half of the settings the page last sent to app_settings_set. */
  const sent = (page: Page) =>
    page.evaluate(() => {
      type Call = { cmd: string; args: { settings?: { notifications?: Record<string, unknown> } } };
      const all = (window as unknown as { __calls: Call[] }).__calls;
      return all.filter((c) => c.cmd === "app_settings_set").at(-1)?.args.settings?.notifications ?? null;
    });

  test("Settings › Notifications has the one switch, with Pause and the kinds while it is on; App has none", async ({
    page,
  }) => {
    const pane = await openPane(page);
    await expect(pane.getByRole("switch", { name: /Notify me/ })).toHaveCount(1);
    const one = pane.getByRole("switch", { name: SWITCH, exact: true });
    await expect(one).toHaveAttribute("aria-checked", "false");
    // Off: nothing to pause and no kinds to choose.
    await expect(pane.locator(".settings-label")).toHaveText([
      SWITCH,
      "Sounds",
      "Volume",
      "Permission requests",
      "Questions",
      "Errors",
      "Delivered",
      "Your own sound",
    ]);
    // Turning it on asks macOS then, never before.
    expect(await calls(page)).not.toContain("app_notify_request");
    await one.click();
    await expect(one).toHaveAttribute("aria-checked", "true");
    expect(await calls(page)).toContain("app_notify_request");
    expect(await sent(page)).toMatchObject({ enabled: true });
    await expect(pane.getByRole("combobox", { name: "Pause notifications" })).toHaveText("Not paused");
    const about = pane.getByRole("region", { name: "Notify me about" });
    await expect(about.locator(".settings-label")).toHaveText([
      "Permission requests",
      "Questions",
      "Errors",
      "Finished, waiting for you",
    ]);
    await expect(about.getByRole("switch", { name: "Finished, waiting for you" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await about.getByRole("switch", { name: "Errors" }).click();
    expect(await sent(page)).toMatchObject({ enabled: true, kinds: { error: false } });
    // Four panels: the switch, what it notifies about, then the sounds.
    await expect(pane.locator(".settings-group-label")).toHaveText(["Notify me about", "Sounds for"]);
    await expect(pane.getByRole("switch", { name: "Sounds" })).toBeVisible();
    // Nothing of the page's own switch: no tab, no browser, no site.
    await expect(pane.locator(".ntf-row[data-row='notify']")).toHaveCount(0);
    expect(await pane.innerText()).not.toMatch(/\btab\b|browser|this site/i);

    await page.getByRole("tab", { name: "App" }).click();
    const app = page.getByRole("tabpanel", { name: "App" });
    await expect(app.getByRole("switch", { name: "Open at login" })).toBeVisible();
    await expect(app.getByRole("switch", { name: /Notify me/ })).toHaveCount(0);
    await expect(app.getByRole("region", { name: "Notifications" })).toHaveCount(0);
  });

  test("refused by macOS: one row with Open System Settings, and no switch", async ({ page }) => {
    const pane = await openPane(page, { notify: { status: "denied", enabled: true } });
    const off = pane.locator(".settings-group").first();
    await expect(off.locator(".settings-row")).toHaveCount(1);
    await expect(off.locator(".settings-label")).toHaveText("Notifications are off for sessionpipe");
    await expect(off.locator(".settings-hint")).toHaveCount(0);
    await expect(pane.getByRole("switch", { name: /Notify me/ })).toHaveCount(0);
    await expect(pane.getByRole("region", { name: "Notify me about" })).toHaveCount(0);
    await expect(pane.getByText("Pause")).toHaveCount(0);
    expect(await calls(page)).not.toContain("app_notify_open_settings");
    await off.getByRole("button", { name: "Open System Settings" }).click();
    await expect.poll(() => calls(page)).toContain("app_notify_open_settings");
    // The sounds are the page's own: still there.
    await expect(pane.getByRole("switch", { name: "Sounds" })).toBeVisible();
  });

  test("a pause is one row, Paused until, with Resume", async ({ page }) => {
    const pane = await openPane(page, { notify: ON });
    const pause = pane.getByRole("combobox", { name: "Pause notifications" });
    await pause.click();
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText([
      "Not paused",
      "For 1 hour",
      "Until tomorrow",
    ]);
    await page.getByRole("option", { name: "Until tomorrow" }).click();
    // 8 in the morning, by the day's short name (the suite runs in UTC).
    const row = pane.locator(".settings-row").filter({ hasText: "Paused until" });
    await expect(row.locator(".settings-label")).toHaveText(/^Paused until [A-Z][a-z]{2} 8:00 AM$/);
    await expect(row.locator(".settings-hint")).toHaveCount(0);
    await expect(pause).toHaveCount(0);
    expect(Date.parse((await sent(page))?.pausedUntil as string)).toBeGreaterThan(Date.now());
    // The switch and the kinds stay: it is still on, only quiet for now.
    await expect(pane.getByRole("switch", { name: SWITCH, exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(pane.getByRole("region", { name: "Notify me about" })).toBeVisible();
    await row.getByRole("button", { name: "Resume" }).click();
    await expect(pause).toHaveText("Not paused");
    await expect(row).toHaveCount(0);
    expect(await sent(page)).toMatchObject({ enabled: true, pausedUntil: null });
  });

  test("a pause set elsewhere shows as paused", async ({ page }) => {
    const pausedUntil = new Date(Date.now() + 3_600_000).toISOString();
    const pane = await openPane(page, { notify: { ...ON, pausedUntil } });
    await expect(pane.getByText(/^Paused until /)).toBeVisible();
    await expect(pane.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(pane.getByRole("combobox", { name: "Pause notifications" })).toHaveCount(0);
  });

  test("the Inbox's bell follows the app's switch, and its note macOS", async ({ page }) => {
    await openInShell(page, "/inbox", { notify: ON });
    const head = page.locator(".inbox-head");
    const bell = head.getByRole("button", { name: "Notifications" });
    // On and allowed: not struck through, and nothing said under the bar.
    await expect(bell).toHaveAttribute("data-notify", "on", { timeout: 15_000 });
    const note = page.locator(".inbox-notes .notify-hint");
    await expect(note).toHaveCount(0);
    await bell.click();
    const toggle = head.getByRole("switch", { name: "Notify me" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(head.locator(".notify-hint")).toHaveText("When a prompt needs you and the app is in the background.");
    // Off from here is the same switch: the bell is struck, and still nothing under the bar.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(bell).toHaveAttribute("data-notify", "off");
    expect(await sent(page)).toMatchObject({ enabled: false });
    await expect(note).toHaveCount(0);
  });

  test("the Inbox says it once when the switch is on and macOS refuses", async ({ page }) => {
    await openInShell(page, "/inbox", { notify: { status: "denied", enabled: true } });
    const note = page.locator(".inbox-notes .notify-hint");
    await expect(note).toContainText("Notifications are off for sessionpipe", { timeout: 15_000 });
    await expect(note).not.toContainText("this site");
    await expect(page.locator(".inbox-head").getByRole("button", { name: "Notifications" })).toHaveAttribute(
      "data-notify",
      "off",
    );
    await note.getByRole("button", { name: "Open System Settings" }).click();
    await expect.poll(() => calls(page)).toContain("app_notify_open_settings");
    // In the bell's popover the switch can't be turned on, and says where to allow it.
    await page.locator(".inbox-head").getByRole("button", { name: "Notifications" }).click();
    await expect(page.locator(".inbox-head").getByRole("switch", { name: "Notify me" })).toBeDisabled();
    await expect(page.locator(".inbox-head .notify-hint")).toHaveText("Off for sessionpipe in System Settings.");
  });

  test("on Windows, where the app has no notifier, the pane is the page's own and App has no switch", async ({
    page,
  }) => {
    // What the Windows and Linux shells list (apps/desktop window.rs features).
    const opts = { platform: "windows", features: ["tray", "hotkey", "deeplink", "updater"] };
    await openInShell(page, "/settings?section=notifications", opts);
    const pane = page.getByRole("tabpanel", { name: "Notifications" });
    await expect(pane.getByRole("switch", { name: "Notify me", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(pane.getByRole("switch", { name: SWITCH, exact: true })).toHaveCount(0);
    await expect(pane.getByRole("region", { name: "Notify me about" })).toHaveCount(0);
    await page.getByRole("tab", { name: "App" }).click();
    const app = page.getByRole("tabpanel", { name: "App" });
    await expect(app.getByRole("button", { name: "Record shortcut" })).toBeVisible();
    await expect(app.getByRole("switch", { name: /Notify me/ })).toHaveCount(0);
    await expect(app.getByRole("button", { name: /^Open .*Settings$/ })).toHaveCount(0);
    expect(await calls(page)).not.toContain("app_notify_status");
  });

  // An AudioContext that notes the first frequency of each oscillator it starts, which
  // names the sound: 880 Hz is the two-note chime of a permission request, 150 Hz the thud
  // of an error (web/src/lib/soundSynth.ts). The demo's own toasts sound too, so the
  // tests count by sound, not in all.
  const stubAudio = (page: Page) =>
    page.addInitScript(() => {
      const heard: number[] = [];
      (window as unknown as { __heard: number[] }).__heard = heard;
      class Param {
        first: number | null = null;
        setValueAtTime(v: number) {
          this.first ??= v;
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
          heard.push(this.frequency.first ?? 0);
        }
        stop() {}
      }
      class Gain extends Node {
        gain = new Param();
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
      }
      Object.defineProperty(window, "AudioContext", { value: Ctx, configurable: true });
    });
  const CHIME = 880;
  const THUD = 150;
  const heard = (page: Page, hz: number) =>
    page.evaluate((hz) => (window as unknown as { __heard: number[] }).__heard.filter((f) => f === hz).length, hz);
  /** The window behind another app (or in front again), as document.hasFocus() says it. */
  const inFront = (page: Page, yes: boolean) =>
    page.evaluate((yes) => {
      document.hasFocus = () => yes;
    }, yes);
  /** Behind another app from the first script on, so no sound from a moment in front is
   *  still on its way when the test starts counting. */
  const openBehind = async (page: Page, notify: FakeOptions["notify"]) => {
    await stubAudio(page);
    await page.addInitScript(() => {
      document.hasFocus = () => false;
    });
    await openInShell(page, "/feed", { notify });
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    // The page has the app's switch and the system's answer (lib/systemSound.ts asks as it starts).
    await expect.poll(() => calls(page)).toEqual(expect.arrayContaining(["app_settings_get", "app_notify_status"]));
  };

  /** A session on e2e-box whose events the test posts, as a sink would (toasts.spec.ts). */
  const sink = async (page: Page, title: string) => {
    const { sinkToken } = (await (await page.request.get(INFO)).json()) as { sinkToken: string };
    const id = randomUUID();
    const turn = randomUUID();
    let seq = 0;
    const post = async (type: string, data: Record<string, unknown>, hook: string) => {
      const res = await page.request.post(EVENTS, {
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sinkToken}`,
          "sessionpipe-protocol": "1",
        },
        data: {
          events: [
            {
              protocol: 1,
              id: ulid(),
              type,
              time: new Date().toISOString(),
              tier: 1,
              harness: { name: "claude-code", version: "2.1.296", event: hook },
              session: { id, seq: seq++, machine: "e2e-box", cwd: "~/code/e2e", title, title_source: "custom" },
              privacy: { rulesets: ["secrets@1"], pii: false },
              data,
            },
          ],
        },
      });
      expect(res.status()).toBe(202);
    };
    await post("session.started", { source: "startup" }, "SessionStart");
    await post("turn.started", { turn_id: turn, prompt_chars: 20 }, "UserPromptSubmit");
    const open = new Set<string>();
    return {
      card: page.locator(`.toast[data-session="claude-code:${id}"]`),
      async asks(message: string) {
        const attention = `perm-${ulid()}`;
        open.add(attention);
        await post(
          "attention.needed",
          { attention_id: attention, kind: "permission", tool: "Bash", message },
          "PermissionRequest",
        );
        return attention;
      },
      async answered(attention: string) {
        open.delete(attention);
        await post("attention.cleared", { attention_id: attention, how: "answered" }, "PreToolUse");
      },
      fails: () => post("turn.ended", { turn_id: turn, reason: "error", error: "api_overloaded", ms: 1200 }, "Stop"),
      /** Cleared, so the inbox spec, which waits for nothing to be left to answer, is not left waiting. */
      async done() {
        for (const a of [...open]) await this.answered(a);
      },
    };
  };

  test("a prompt macOS sounds for plays no second sound; in front, and for an error, the toast's own plays", async ({
    page,
  }) => {
    await openBehind(page, ON);
    const s = await sink(page, `One sound ${randomUUID().slice(0, 6)}`);
    try {
      // Behind another app: macOS posts the banner with its sound, so the toast is silent.
      const chimes = await heard(page, CHIME);
      const behind = await s.asks("git push origin main");
      await expect(s.card).toHaveClass(/toast--needs-you/);
      await page.waitForTimeout(500);
      expect(await heard(page, CHIME)).toBe(chimes);
      await s.answered(behind);
      await expect(s.card).toHaveCount(0);
      // In front: macOS posts nothing, and the toast plays its chime.
      await inFront(page, true);
      const front = await s.asks("npm publish");
      await expect(s.card).toHaveClass(/toast--needs-you/);
      await expect.poll(() => heard(page, CHIME)).toBeGreaterThan(chimes);
      await s.answered(front);
      await expect(s.card).toHaveCount(0);
      // An error's notification is posted silently, so its toast still sounds behind another app.
      await inFront(page, false);
      const thuds = await heard(page, THUD);
      await s.fails();
      await expect(s.card).toHaveClass(/toast--error/);
      await expect.poll(() => heard(page, THUD)).toBeGreaterThan(thuds);
    } finally {
      await s.done();
    }
  });

  test("while paused macOS posts nothing, so the toast keeps its sound", async ({ page }) => {
    await openBehind(page, { ...ON, pausedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    const s = await sink(page, `Paused sound ${randomUUID().slice(0, 6)}`);
    try {
      const chimes = await heard(page, CHIME);
      await s.asks("git push origin main");
      await expect(s.card).toHaveClass(/toast--needs-you/);
      await expect.poll(() => heard(page, CHIME)).toBeGreaterThan(chimes);
    } finally {
      await s.done();
    }
  });
});

// A touch screen as wide as a narrow Mac window (an iPad held upright, or beside another
// app) is not one: the width alone gives it the phone's layout, as before.
test.describe("a touch screen 760 px wide", () => {
  test.use({ viewport: { width: 760, height: 800 }, hasTouch: true });

  for (const where of ["the phone app", "a browser"] as const)
    test(`keeps the tab bar in ${where}`, async ({ page }) => {
      if (where === "a browser") await page.goto("/");
      else await openInPhone(page, "/", { receiver: true });
      await expect(page.locator("section.group").first()).toBeVisible({ timeout: 15_000 });
      await expect(page.locator("nav.tabbar")).toBeVisible();
      await expect(page.locator("nav.rail")).toBeHidden();
      await expect(page.locator(".main > .page > .bar")).toHaveClass(/bar--large/);
      expect(
        await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bar").trim()),
      ).toBe("44px");
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

// The phone app updates as the phone's apps do: About says its own version and the
// computer's, and nothing of updates.
test("in the phone app About says the app's version and the computer's, and nothing of updates", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openInPhone(page, "/settings?section=about", { receiver: true });
  const pane = page.getByRole("tabpanel", { name: "About" });
  await expect(pane.getByText("Version 0.6.2", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(pane.getByText(/^studio-mac runs \d+\.\d+\.\d+\S*\.$/)).toBeVisible();
  await expect(pane.getByText("Every coding agent you run, on one board.")).toBeVisible();
  await expect(pane.locator(".about-foot")).toHaveText("Apache-2.0");
  await expect(pane.getByText(/update/i)).toHaveCount(0);
  await expect(pane.getByRole("button")).toHaveCount(0);
});

// A phone or a tablet with a keyboard has no menu bar to answer a menu's key, so the page
// keeps them all: ⌘K opens the palette.
test("in the phone app ⌘K opens the palette", async ({ page }) => {
  await openInPhone(page, "/", { receiver: true });
  await expect(page.locator("section.group").first()).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
});

// The phone's board that never got its first sessions names the computer it reads from,
// with Retry alone: a phone starts nothing, and loads none of the start's code.
test("in the phone app a board that can't reach its computer names it, with Retry", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const scripts: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "script") scripts.push(new URL(r.url()).pathname);
  });
  await page.route(/\/api\/ui\/stream/, (r) => r.abort());
  await openInPhone(page, "/", { receiver: true });
  await expect(page.getByRole("heading", { name: "Can't reach studio-mac" })).toBeVisible({ timeout: 10_000 });
  const state = page.locator("main .state");
  await expect(state).toHaveAttribute("role", "status");
  await expect(state.getByRole("button")).toHaveText(["Retry"]);
  await expect(page.getByRole("button", { name: /^(Retry|Try again)$/ })).toHaveCount(1);
  await expect(page.locator(".phone-conn-sub")).toHaveCount(0);
  expect(scripts.filter((s) => /StartHere/.test(s))).toEqual([]);
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
