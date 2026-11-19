// SPDX-License-Identifier: Apache-2.0
// This Mac's background service behind the app, in the app: Settings › About's row under
// the app's own update (native/receiverUpdate.ts serviceRow), and Settings › Data ›
// "spacesheep" against a receiver older than the option (web/src/lib/serverAge.ts,
// components/OlderReceiverNotice.tsx). A fake shell (as native-shell.spec.ts has one) and
// the receiver's info and spacesheep route stubbed, so the page's half is pinned: the
// sentences, Connect off, Update with its progress and failure words, the version read
// again after it, an update already running when the window opens, a stale receiver's 404
// kept through focus and reconnects until another process answers, the receiver's own 404
// against the proxy's, and a receiver that isn't this computer's.
import { expect, type Page, test } from "@playwright/test";

/** How the fake rx_update_local ends: it updates, or fails as the installer's exit 4
 *  (the old receiver stopped, the new one not running), or fails otherwise. */
type Mode = "ok" | "notRunning" | "failed";
interface Fake {
  /** What rx_local_update says: this computer's receiver is the one shown, or not known. */
  local: boolean;
  mode?: Mode;
  /** rx_local_update says an update is running for its first this many asks. */
  busyFor?: number;
  /** What the launch check found (rx_local_update's state); "click" by default. */
  state?: "click" | "failed" | "unchanged";
  /** The service's version and the app's (0.7.2 and 0.8.1 by default). */
  running?: string;
  app?: string;
  /** The page to open (Settings › Data by default). */
  path?: string;
}

interface Receiver {
  info: string;
  post?: "json404" | "text404";
}

/** The receiver's info as the page reads it: its version, and the process's startedAt. */
async function open(page: Page, fake: Fake, receiver: Receiver) {
  const state = { version: receiver.info, startedAt: "2026-11-12T10:00:00.000Z" };
  // A read still on its way when the test ends finds its response disposed: let it go.
  await page.route("**/api/ui/info", async (route) => {
    try {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), ...state } });
    } catch {
      await route.abort().catch(() => {});
    }
  });
  await page.route("**/api/ui/spacesheep", (route) => {
    if (route.request().method() === "POST" && receiver.post === "text404")
      return route.fulfill({ status: 404, contentType: "text/plain", body: "unknown receiver" });
    return route.fulfill({ status: 404, json: { reason: "not_found" } });
  });
  // The fake shell's update (or the run that was busy) ends by asking for this: from then
  // on another process, at the app's version, answers.
  const app = fake.app ?? "0.8.1";
  const running = fake.running ?? "0.7.2";
  await page.route("**/__fake/updated", (route) => {
    Object.assign(state, { version: app, startedAt: "2026-11-12T10:05:00.000Z" });
    return route.fulfill({ status: 204 });
  });
  await page.addInitScript(
    ([local, mode, busyFor, launch, running, app]) => {
      const w = window as unknown as Record<string, unknown>;
      w.sessionpipeShell = {
        v: 1,
        platform: "macos",
        appVersion: app,
        features: ["updater"],
        receiver: { id: "e2erx00002", name: "studio-mac", origin: location.origin, local: true },
        rxBase: "",
      };
      const callbacks = new Map<number, (raw: unknown) => void>();
      let next = 1;
      let asks = 0;
      // What the launch check found, and after an update ran, what that run left.
      let found: Record<string, unknown> = { running, state: launch };
      const send = (id: number, raw: unknown) => callbacks.get(id)?.(raw);
      const streams: ((m: unknown) => void)[] = [];
      /** Drops the live stream, as a receiver restart does; the page reconnects. */
      w.__drop = () => {
        for (const out of streams.splice(0)) out({ event: "error", retryInMs: 100 });
      };
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
          switch (cmd) {
            case "rx_stream": {
              w.__opened = ((w.__opened as number) ?? 0) + 1;
              const ch = (args.onFrame as { id: number }).id;
              let index = 0;
              const es = new EventSource(args.path as string);
              const out = (message: unknown) => send(ch, { index: index++, message });
              streams.push((m) => {
                es.close();
                out(m);
              });
              es.onopen = () => out({ event: "open" });
              for (const k of ["snapshot", "event", "session", "machine", "stats", "control", "viewers", "labels"])
                es.addEventListener(k, (e) => out({ event: k, data: (e as MessageEvent).data }));
              return next++;
            }
            case "rx_stream_close":
              return null;
            case "rx_local_update": {
              if (!local) return null;
              const busy = asks++ < busyFor;
              if (!busy && busyFor > 0 && asks === busyFor + 1) {
                await fetch("/__fake/updated");
                found = { running: app, state: "current" };
              }
              return {
                origin: location.origin,
                app,
                ...found,
                busy,
                ...(busy ? { progress: `Updating sessionpipe ${running} → ${app}…` } : {}),
              };
            }
            case "rx_update_local": {
              const ch = (args.onProgress as { id: number }).id;
              let index = 0;
              const say = (message: string) => send(ch, { index: index++, message: { step: "install", message } });
              say("Looking for Node…");
              await new Promise((r) => setTimeout(r, 400));
              say(`Updating sessionpipe ${running} → ${app}…`);
              await new Promise((r) => setTimeout(r, 600));
              if (mode === "notRunning") {
                // As the shell does: a run that failed read no version after it.
                found = { running: "", state: "failed", why: "not running" };
                throw {
                  kind: "notRunning",
                  line: `${app} isn't running on :7373 after 90 s, and the old receiver was stopped for the update: see ~/.local/state/sessionpipe-gui/service.log`,
                  log: "~/.local/state/sessionpipe-gui/service.log",
                };
              }
              if (mode === "failed") {
                found = { running: "", state: "failed", why: "couldn't download" };
                throw {
                  kind: "download",
                  line: "couldn't download sessionpipe (npm error network request failed); nothing was changed",
                };
              }
              await fetch("/__fake/updated");
              found = { running: app, state: "current" };
              return { origin: location.origin, running: app, app, state: "current", busy: false };
            }
            case "plugin:event|listen":
              return next++;
            case "app_settings_get":
              return {
                firstRunDone: true,
                autoUpdate: true,
                notifications: { enabled: false, kinds: {}, pausedUntil: null },
              };
            case "app_update_status":
              return { state: "idle", lastChecked: new Date().toISOString() };
            default:
              return null;
          }
        },
      };
    },
    [fake.local, fake.mode ?? "ok", fake.busyFor ?? 0, fake.state ?? "click", running, app] as const,
  );
  await page.goto(fake.path ?? "/settings?section=data");
}

const connect = (page: Page) => page.getByRole("button", { name: "Connect…" });
const focusAgain = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));
const update = (page: Page) => page.getByRole("button", { name: "Update", exact: true });
const HERE = "This Mac's background service is 0.7.2; this option needs 0.7.5.";

test.describe("an option the receiver is too old for, in the app", () => {
  test("this Mac's: the sentence, Connect off, the command inside Run it yourself, and Update brings it current", async ({
    page,
  }) => {
    await open(page, { local: true }, { info: "0.7.2" });
    await expect(page.getByText(HERE)).toBeVisible();
    await expect(connect(page)).toBeDisabled();
    // The update is the one next step: the only primary button.
    await expect(page.getByRole("tabpanel").locator(".btn--primary")).toHaveCount(1);
    await expect(page.getByRole("tabpanel").locator(".btn--primary")).toHaveText("Update");
    // The command is folded away, closed, in one disclosure.
    const yourself = page.locator("details", { has: page.getByText("Run it yourself") });
    await expect(yourself).toHaveCount(1);
    await expect(yourself).not.toHaveAttribute("open", "");
    await expect(page.locator(".cmdwell-text")).toBeHidden();
    await yourself.getByText("Run it yourself").click();
    await expect(yourself.locator(".cmdwell-text")).toBeVisible();
    await expect(yourself.locator(".cmdwell-text")).toContainText(
      "sessionpipe-gui-0.8.1.tgz -- sessionpipe-gui service install",
    );
    await update(page).click();
    // Dimmed and inert while it works, and the focus stays on it.
    await expect(page.getByRole("button", { name: "Updating…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Updating…" })).toBeFocused();
    await expect(page.getByText("Updating sessionpipe 0.7.2 → 0.8.1…")).toBeVisible();
    // Done: the version is read again, the notice goes, Connect is back.
    await expect(page.getByText("this option needs")).toHaveCount(0);
    await expect(connect(page)).toBeEnabled();
  });

  test("an update that stopped the old receiver and didn't start the new one: said so, with the log", async ({
    page,
  }) => {
    await open(page, { local: true, mode: "notRunning" }, { info: "0.7.2" });
    await update(page).click();
    await expect(page.getByRole("alert")).toHaveText(
      "The update didn't finish and the service isn't running. Press Update again.",
    );
    // The log's path is in Run it yourself, above the command.
    await page.getByText("Run it yourself").click();
    await expect(page.locator(".settings-details-line")).toHaveText("~/.local/state/sessionpipe-gui/service.log");
    await expect(update(page)).toBeEnabled();
    await expect(connect(page)).toBeDisabled();
  });

  test("any other failure: Press Update again, with the installer's line in Run it yourself", async ({ page }) => {
    await open(page, { local: true, mode: "failed" }, { info: "0.7.2" });
    await update(page).click();
    await expect(page.getByRole("alert")).toHaveText("Couldn't update it. Press Update again.");
    await expect(page.locator(".settings-details-line")).toBeHidden();
    await page.getByText("Run it yourself").click();
    await expect(page.locator(".settings-details-line")).toHaveText(
      "couldn't download sessionpipe (npm error network request failed); nothing was changed",
    );
  });

  test("an update already running when Settings opens shows as working, and the notice goes when it ends", async ({
    page,
  }) => {
    await open(page, { local: true, busyFor: 2 }, { info: "0.7.2" });
    await expect(page.getByRole("button", { name: "Updating…" })).toBeDisabled();
    await expect(page.getByText("Updating sessionpipe 0.7.2 → 0.8.1…")).toBeVisible();
    await expect(page.getByText("this option needs")).toHaveCount(0, { timeout: 10_000 });
    await expect(connect(page)).toBeEnabled();
  });

  test("a stale receiver whose info names the new version: its own 404 keeps the notice through focus and reconnects, until another process answers", async ({
    page,
  }) => {
    await open(page, { local: true }, { info: "0.8.0" });
    await expect(connect(page)).toBeEnabled();
    await connect(page).click();
    await expect(page.getByText("This Mac's background service is too old for this option.")).toBeVisible();
    await expect(page.getByText("is 0.8.0")).toHaveCount(0);
    await expect(connect(page)).toBeDisabled();
    // The window comes forward, and the stream drops and comes back: the same process answers.
    await focusAgain(page);
    const opened = () => page.evaluate(() => (window as unknown as { __opened: number }).__opened);
    const before = await opened();
    await page.evaluate(() => (window as unknown as { __drop(): void }).__drop());
    await expect.poll(opened).toBeGreaterThan(before);
    await expect(page.locator(".conn--live")).toBeVisible();
    await focusAgain(page);
    await page.waitForTimeout(500);
    await expect(page.getByText("This Mac's background service is too old for this option.")).toBeVisible();
    await expect(connect(page)).toBeDisabled();
    // Another process answers now (restarted at 0.8.1): the 404 was the old one's.
    await page.evaluate(() => fetch("/__fake/updated"));
    await focusAgain(page);
    await expect(page.getByText("too old for this option")).toHaveCount(0);
    await expect(connect(page)).toBeEnabled();
  });

  test("the app's proxy's 404 (no such receiver) is not read as an older receiver", async ({ page }) => {
    await open(page, { local: true }, { info: "0.8.0", post: "text404" });
    await connect(page).click();
    await expect(page.getByText("HTTP 404")).toBeVisible();
    await expect(page.getByText("too old for this option")).toHaveCount(0);
  });

  test("a receiver the launch check didn't find to be this computer's: 'Update it there', no button", async ({
    page,
  }) => {
    await open(page, { local: false }, { info: "0.7.2" });
    await expect(
      page.getByText("sessionpipe on studio-mac is 0.7.2; this option needs 0.7.5. Update it there."),
    ).toBeVisible();
    await expect(update(page)).toHaveCount(0);
    await expect(page.getByText("Run it yourself")).toHaveCount(0);
  });
});

/** Settings › About, the app at 0.8.4 and this Mac's service at 0.8.3. */
const about = (fake: Partial<Fake> = {}): [Fake, Receiver] => [
  { local: true, running: "0.8.3", app: "0.8.4", path: "/settings?section=about", ...fake },
  { info: fake.running ?? "0.8.3" },
];
const pane = (page: Page) => page.getByRole("tabpanel", { name: "About" });
const serviceRow = (page: Page) => pane(page).locator(".service-row");

test.describe("this Mac's background service behind the app, in Settings › About", () => {
  test("behind: one row under the app's, with Update, in place of the head's line", async ({ page }) => {
    await open(page, ...about());
    const row = serviceRow(page);
    await expect(row).toContainText("The background service runs 0.8.3");
    await expect(row).toContainText("Update it to 0.8.4 to match the app.");
    await expect(row.getByRole("button", { name: "Update", exact: true })).toHaveClass(/btn--primary/);
    // Under the app's own update row, in its group.
    await expect(pane(page).locator(".settings-cells").first().locator(".settings-row").nth(1)).toHaveClass(
      /service-row/,
    );
    await expect(pane(page).getByText("This Mac's background service runs 0.8.3.")).toHaveCount(0);
  });

  test("a run shows its progress, then the row says the new version until the window closes", async ({ page }) => {
    await open(page, ...about());
    const row = serviceRow(page);
    await row.getByRole("button", { name: "Update", exact: true }).click();
    await expect(row.getByRole("button", { name: "Updating…" })).toBeDisabled();
    await expect(row.getByRole("button", { name: "Updating…" })).toBeFocused();
    await expect(row.getByRole("status")).toHaveText("Updating sessionpipe 0.8.3 → 0.8.4…");
    await expect(row).toHaveText("The background service runs 0.8.4");
    await expect(row.getByRole("button")).toHaveCount(0);
    await expect(pane(page).getByText("background service runs 0.8.3")).toHaveCount(0);
    // A visit to another section and back: still there.
    await page.getByRole("tab", { name: "General" }).click();
    await page.getByRole("tab", { name: "About" }).click();
    await expect(serviceRow(page)).toHaveText("The background service runs 0.8.4");
    // The next time Settings opens, there is nothing to say.
    await page.goto("/");
    await page.goto("/settings?section=about");
    await expect(pane(page).locator(".app-update-ctl")).toBeAttached();
    await expect(serviceRow(page)).toHaveCount(0);
  });

  test("a run that stopped the old service and didn't start the new one: said so, with the log in Details", async ({
    page,
  }) => {
    await open(page, ...about({ mode: "notRunning" }));
    const row = serviceRow(page);
    await row.getByRole("button", { name: "Update", exact: true }).click();
    await expect(row.getByRole("alert")).toHaveText(
      "The update didn't finish and the service isn't running. Press Update again.",
    );
    // The check read no version after the run: the row still says the one it was behind at.
    await expect(row.locator(".settings-label")).toHaveText("The background service runs 0.8.3");
    await expect(row.getByRole("button", { name: "Update", exact: true })).toBeEnabled();
    const details = row.locator("details");
    await expect(details).not.toHaveAttribute("open", "");
    await details.getByText("Details").click();
    await expect(details.locator(".settings-details-line")).toHaveText("~/.local/state/sessionpipe-gui/service.log");
    await expect(details).toContainText("Or run this in a terminal:");
    await expect(details.locator(".cmdwell-text")).toContainText(
      "sessionpipe-gui-0.8.4.tgz -- sessionpipe-gui service install",
    );
  });

  test("any other failed run: Couldn't update it, and the installer's line in Details", async ({ page }) => {
    await open(page, ...about({ mode: "failed" }));
    const row = serviceRow(page);
    await row.getByRole("button", { name: "Update", exact: true }).click();
    await expect(row.getByRole("alert")).toHaveText("Couldn't update it. Press Update again.");
    await expect(row.locator(".settings-label")).toHaveText("The background service runs 0.8.3");
    // Again, after a visit to another section, and while it runs again.
    await page.getByRole("tab", { name: "General" }).click();
    await page.getByRole("tab", { name: "About" }).click();
    await expect(row.locator(".settings-label")).toHaveText("The background service runs 0.8.3");
    await row.getByRole("button", { name: "Update", exact: true }).click();
    await expect(row.getByRole("button", { name: "Updating…" })).toBeVisible();
    await expect(row.locator(".settings-label")).toHaveText("The background service runs 0.8.3");
    await expect(row.getByRole("alert")).toHaveText("Couldn't update it. Press Update again.");
    await row.getByText("Details").click();
    await expect(row.locator(".settings-details-line")).toHaveText(
      "couldn't download sessionpipe (npm error network request failed); nothing was changed",
    );
  });

  test("the launch's update failed: the same row, with Update", async ({ page }) => {
    await open(page, ...about({ state: "failed" }));
    const row = serviceRow(page);
    await expect(row).toContainText("The background service runs 0.8.3");
    await expect(row.getByRole("alert")).toHaveText("Couldn't update it. Press Update again.");
    await expect(row.getByRole("button", { name: "Update", exact: true })).toBeEnabled();
  });

  test("nothing to say: no service of ours (unchanged), or not this Mac's receiver checked", async ({ page }) => {
    await open(page, ...about({ state: "unchanged" }));
    await expect(pane(page).locator(".app-update-ctl")).toBeAttached();
    await page.waitForTimeout(300);
    await expect(serviceRow(page)).toHaveCount(0);
    // The head's quiet line is back in its place.
    await expect(pane(page).getByText("This Mac's background service runs 0.8.3.")).toBeVisible();
  });

  test("updated from a terminal since launch: this window's receiver answers the app's version, no row", async ({
    page,
  }) => {
    await open(
      page,
      { local: true, running: "0.8.3", app: "0.8.4", path: "/settings?section=about" },
      { info: "0.8.4" },
    );
    await expect(pane(page).locator(".app-update-ctl")).toBeAttached();
    await page.waitForTimeout(300);
    await expect(serviceRow(page)).toHaveCount(0);
  });
});
