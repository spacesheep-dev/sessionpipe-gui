// SPDX-License-Identifier: Apache-2.0
// Settings › Data › "A spacesheep account" in the app against a receiver older than the
// option (web/src/lib/serverAge.ts, components/OlderReceiverNotice.tsx): a fake shell (as
// native-shell.spec.ts has one) and the receiver's info and spacesheep route stubbed, so
// the page's half is pinned: the sentence, Connect off, "Update sessionpipe" with its
// progress and failure words, the version read again after it, an update already running
// when the window opens, a stale receiver's 404 kept through focus and reconnects until
// another process answers, the receiver's own 404 against the proxy's, and a receiver that
// isn't this computer's.
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
}

interface Receiver {
  info: string;
  post?: "json404" | "text404";
}

/** The receiver's info as the page reads it: its version, and the process's startedAt. */
async function open(page: Page, fake: Fake, receiver: Receiver) {
  const state = { version: receiver.info, startedAt: "2026-11-12T10:00:00.000Z" };
  await page.route("**/api/ui/info", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), ...state } });
  });
  await page.route("**/api/ui/spacesheep", (route) => {
    if (route.request().method() === "POST" && receiver.post === "text404")
      return route.fulfill({ status: 404, contentType: "text/plain", body: "unknown receiver" });
    return route.fulfill({ status: 404, json: { reason: "not_found" } });
  });
  // The fake shell's update (or the run that was busy) ends by asking for this: from then
  // on another process, at the app's version, answers.
  await page.route("**/__fake/updated", (route) => {
    Object.assign(state, { version: "0.8.1", startedAt: "2026-11-12T10:05:00.000Z" });
    return route.fulfill({ status: 204 });
  });
  await page.addInitScript(
    ([local, mode, busyFor]) => {
      const w = window as unknown as Record<string, unknown>;
      w.sessionpipeShell = {
        v: 1,
        platform: "macos",
        appVersion: "0.8.1",
        features: [],
        receiver: { id: "e2erx00002", name: "studio-mac", origin: location.origin, local: true },
        rxBase: "",
      };
      const callbacks = new Map<number, (raw: unknown) => void>();
      let next = 1;
      let asks = 0;
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
              if (!busy && busyFor > 0 && asks === busyFor + 1) await fetch("/__fake/updated");
              return {
                origin: location.origin,
                running: "0.7.2",
                app: "0.8.1",
                state: "click",
                busy,
                ...(busy ? { progress: "Updating sessionpipe 0.7.2 → 0.8.1…" } : {}),
              };
            }
            case "rx_update_local": {
              const ch = (args.onProgress as { id: number }).id;
              let index = 0;
              const say = (message: string) => send(ch, { index: index++, message: { step: "install", message } });
              say("Looking for Node…");
              await new Promise((r) => setTimeout(r, 400));
              say("Updating sessionpipe 0.7.2 → 0.8.1…");
              await new Promise((r) => setTimeout(r, 600));
              if (mode === "notRunning")
                throw {
                  kind: "notRunning",
                  line: "0.8.1 isn't running on :7373 after 90 s, and the old receiver was stopped for the update: see ~/.local/state/sessionpipe-gui/service.log",
                  log: "~/.local/state/sessionpipe-gui/service.log",
                };
              if (mode === "failed")
                throw {
                  kind: "download",
                  line: "couldn't download sessionpipe (npm error network request failed); nothing was changed",
                };
              await fetch("/__fake/updated");
              return { origin: location.origin, running: "0.8.1", app: "0.8.1", state: "current", busy: false };
            }
            case "plugin:event|listen":
              return next++;
            case "app_settings_get":
              return { firstRunDone: true, notifications: { enabled: false, kinds: {}, pausedUntil: null } };
            default:
              return null;
          }
        },
      };
    },
    [fake.local, fake.mode ?? "ok", fake.busyFor ?? 0] as const,
  );
  await page.goto("/settings?section=data");
}

const connect = (page: Page) => page.getByRole("button", { name: "Connect…" });
const focusAgain = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));

test.describe("an option the receiver is too old for, in the app", () => {
  test("this computer's: the sentence, Connect off, and Update sessionpipe brings it current", async ({ page }) => {
    await open(page, { local: true }, { info: "0.7.2" });
    await expect(
      page.getByText("sessionpipe on this computer is 0.7.2, which is older than this option."),
    ).toBeVisible();
    await expect(connect(page)).toBeDisabled();
    await expect(page.getByText("Or run this in a terminal:")).toBeVisible();
    await expect(page.locator(".cmdwell-text")).toContainText(
      "sessionpipe-gui-0.8.1.tgz -- sessionpipe-gui service install",
    );
    await page.getByRole("button", { name: "Update sessionpipe" }).click();
    await expect(page.getByRole("button", { name: "Updating…" })).toBeDisabled();
    await expect(page.getByText("Updating sessionpipe 0.7.2 → 0.8.1…")).toBeVisible();
    // Done: the version is read again, the notice goes, Connect is back.
    await expect(page.getByText("which is older than this option")).toHaveCount(0);
    await expect(connect(page)).toBeEnabled();
  });

  test("an update that stopped the old receiver and didn't start the new one: said so, with the log", async ({
    page,
  }) => {
    await open(page, { local: true, mode: "notRunning" }, { info: "0.7.2" });
    await page.getByRole("button", { name: "Update sessionpipe" }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(
      "The update didn't finish, and sessionpipe isn't running right now. Press Update again.",
    );
    await expect(alert.locator(".older-detail")).toHaveText("~/.local/state/sessionpipe-gui/service.log");
    await expect(page.getByRole("button", { name: "Update sessionpipe" })).toBeEnabled();
    await expect(connect(page)).toBeDisabled();
  });

  test("any other failure: Press Update again, or run the command, with the installer's line small", async ({
    page,
  }) => {
    await open(page, { local: true, mode: "failed" }, { info: "0.7.2" });
    await page.getByRole("button", { name: "Update sessionpipe" }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Couldn't update it. Press Update again, or run the command below.");
    await expect(alert.locator(".older-detail")).toHaveText(
      "couldn't download sessionpipe (npm error network request failed); nothing was changed",
    );
  });

  test("an update already running when Settings opens shows as working, and the notice goes when it ends", async ({
    page,
  }) => {
    await open(page, { local: true, busyFor: 2 }, { info: "0.7.2" });
    await expect(page.getByRole("button", { name: "Updating…" })).toBeDisabled();
    await expect(page.getByText("Updating sessionpipe 0.7.2 → 0.8.1…")).toBeVisible();
    await expect(page.getByText("which is older than this option")).toHaveCount(0, { timeout: 10_000 });
    await expect(connect(page)).toBeEnabled();
  });

  test("a stale receiver whose info names the new version: its own 404 keeps the notice through focus and reconnects, until another process answers", async ({
    page,
  }) => {
    await open(page, { local: true }, { info: "0.8.0" });
    await expect(connect(page)).toBeEnabled();
    await connect(page).click();
    await expect(page.getByText("sessionpipe on this computer is older than this option.")).toBeVisible();
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
    await expect(page.getByText("sessionpipe on this computer is older than this option.")).toBeVisible();
    await expect(connect(page)).toBeDisabled();
    // Another process answers now (restarted at 0.8.1): the 404 was the old one's.
    await page.evaluate(() => fetch("/__fake/updated"));
    await focusAgain(page);
    await expect(page.getByText("older than this option")).toHaveCount(0);
    await expect(connect(page)).toBeEnabled();
  });

  test("the app's proxy's 404 (no such receiver) is not read as an older receiver", async ({ page }) => {
    await open(page, { local: true }, { info: "0.8.0", post: "text404" });
    await connect(page).click();
    await expect(page.getByText("HTTP 404")).toBeVisible();
    await expect(page.getByText("older than this option")).toHaveCount(0);
  });

  test("a receiver the launch check didn't find to be this computer's: 'Update it there', no button", async ({
    page,
  }) => {
    await open(page, { local: false }, { info: "0.7.2" });
    await expect(
      page.getByText("sessionpipe on studio-mac is 0.7.2, which is older than this option. Update it there."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Update sessionpipe" })).toHaveCount(0);
    await expect(page.getByText("Or run this in a terminal:")).toHaveCount(0);
  });
});
