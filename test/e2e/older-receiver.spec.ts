// SPDX-License-Identifier: Apache-2.0
// Settings › Data › "A spacesheep account" in the app against a receiver older than the
// option (web/src/lib/serverAge.ts, components/OlderReceiverNotice.tsx): a fake shell (as
// native-shell.spec.ts has one) and the receiver's info and spacesheep route stubbed, so
// the page's half is pinned: the sentence, Connect off, "Update sessionpipe" with its
// progress and failure lines, the version read again after it, the receiver's own 404
// against the proxy's, and a receiver that isn't this computer's.
import { expect, type Page, test } from "@playwright/test";

type Mode = "ok" | "fail";
interface Fake {
  /** What rx_local_update says: this computer's receiver is the one shown, or not known. */
  local: boolean;
  mode?: Mode;
}

async function open(page: Page, fake: Fake, receiver: { info: string; post?: "json404" | "text404" }) {
  let info = receiver.info;
  await page.route("**/api/ui/info", async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...(await res.json()), version: info } });
  });
  await page.route("**/api/ui/spacesheep", (route) => {
    if (route.request().method() === "POST" && receiver.post === "text404")
      return route.fulfill({ status: 404, contentType: "text/plain", body: "unknown receiver" });
    return route.fulfill({ status: 404, json: { reason: "not_found" } });
  });
  // The fake shell's update ends by asking for this: from then on the receiver is the app's version.
  await page.route("**/__fake/updated", (route) => {
    info = "0.8.1";
    return route.fulfill({ status: 204 });
  });
  await page.addInitScript(
    ([local, mode]) => {
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
      const send = (id: number, raw: unknown) => callbacks.get(id)?.(raw);
      const calls: string[] = [];
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
          calls.push(cmd);
          switch (cmd) {
            case "rx_stream": {
              const ch = (args.onFrame as { id: number }).id;
              let index = 0;
              const es = new EventSource(args.path as string);
              const out = (message: unknown) => send(ch, { index: index++, message });
              es.onopen = () => out({ event: "open" });
              for (const k of ["snapshot", "event", "session", "machine", "stats", "control", "viewers", "labels"])
                es.addEventListener(k, (e) => out({ event: k, data: (e as MessageEvent).data }));
              return next++;
            }
            case "rx_local_update":
              return local ? { origin: location.origin, running: "0.7.2", app: "0.8.1", state: "click" } : null;
            case "rx_update_local": {
              const ch = (args.onProgress as { id: number }).id;
              let index = 0;
              const say = (message: string) => send(ch, { index: index++, message: { step: "install", message } });
              say("Looking for Node…");
              await new Promise((r) => setTimeout(r, 400));
              say("Updating sessionpipe 0.7.2 → 0.8.1…");
              await new Promise((r) => setTimeout(r, 600));
              if (mode === "fail")
                throw "0.8.1 isn't running on :7373 after 90 s, and the old receiver was stopped for the update: see ~/.local/state/sessionpipe-gui/service.log";
              await fetch("/__fake/updated");
              return { origin: location.origin, running: "0.8.1", app: "0.8.1", state: "current" };
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
    [fake.local, fake.mode ?? "ok"] as const,
  );
  await page.goto("/settings?section=data");
}

const connect = (page: Page) => page.getByRole("button", { name: "Connect…" });

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

  test("a failed update says its last line, and the notice stays", async ({ page }) => {
    await open(page, { local: true, mode: "fail" }, { info: "0.7.2" });
    await page.getByRole("button", { name: "Update sessionpipe" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Couldn't update it: 0.8.1 isn't running on :7373 after 90 s, and the old receiver was stopped for the update: see ~/.local/state/sessionpipe-gui/service.log",
    );
    await expect(page.getByRole("button", { name: "Update sessionpipe" })).toBeEnabled();
    await expect(connect(page)).toBeDisabled();
  });

  test("a stale receiver whose info names the new version: its own 404 shows the notice, without that version", async ({
    page,
  }) => {
    await open(page, { local: true }, { info: "0.8.0" });
    await expect(connect(page)).toBeEnabled();
    await connect(page).click();
    await expect(page.getByText("sessionpipe on this computer is older than this option.")).toBeVisible();
    await expect(page.getByText("is 0.8.0")).toHaveCount(0);
    await expect(connect(page)).toBeDisabled();
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
