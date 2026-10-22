// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// In-app toasts, driven by events posted to the receiver as a sink would (so the timing is
// ours, not the demo's): a new answerable permission is a card with Allow / Deny (disabled
// with the unpaired reason) that stays until dismissed, leaves with its attention.cleared,
// and opens the session beside the page on a click; a turn that ends with an error is a
// card that leaves by itself; what was open at the first snapshot never toasts; the
// sound of the moment plays through a stubbed AudioContext, and not with sounds off.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { EVENTS, INFO, openPage, ulid } from "./helpers.js";

declare global {
  interface Window {
    __audio: { started: number; types: string[]; buffers: number; allow: boolean };
  }
}

/** A stand-in AudioContext that counts the oscillators started. `locked`: it stays suspended,
 *  as a real one does before a gesture, until the test allows `resume()` to work. */
const stubAudio = (page: Page, o: { locked?: boolean } = {}) =>
  page.addInitScript((locked) => {
    window.__audio = { started: 0, types: [], buffers: 0, allow: !locked };
    class Param {
      setValueAtTime() {
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
        window.__audio.started++;
      }
      stop() {}
    }
    class Gain extends Node {
      gain = new Param();
    }
    class Ctx {
      state = locked ? "suspended" : "running";
      currentTime = 0;
      destination = new Node();
      resume() {
        if (window.__audio.allow) this.state = "running";
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
  }, o.locked ?? false);

/** A session on one machine whose events this spec posts, one at a time. */
function sink(request: APIRequestContext, token: string, title: string) {
  const sessionId = randomUUID();
  const key = `claude-code:${sessionId}`;
  let seq = 0;
  const post = async (type: string, data: Record<string, unknown>, hook: string) => {
    const r = await request.post(EVENTS, {
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "sessionpipe-protocol": "1" },
      data: {
        events: [
          {
            protocol: 1,
            id: ulid(),
            type,
            time: new Date().toISOString(),
            tier: 1,
            harness: { name: "claude-code", version: "2.1.296", event: hook },
            session: {
              id: sessionId,
              seq: seq++,
              machine: "e2e-box",
              cwd: "~/code/e2e",
              title,
              title_source: "custom",
            },
            privacy: { rulesets: ["secrets@1"], pii: false },
            data,
          },
        ],
      },
    });
    expect(r.status()).toBe(202);
  };
  const turn = randomUUID();
  /** Prompts opened and not yet cleared: `done()` clears them, so the inbox spec (which
   *  waits for the open count to reach zero) is not left waiting on this spec's leftovers. */
  const open = new Set<string>();
  const start = async () => {
    await post("session.started", { source: "startup" }, "SessionStart");
    await post("turn.started", { turn_id: turn, prompt_chars: 42 }, "UserPromptSubmit");
  };
  const permission = async (tool: string, message: string) => {
    const id = `perm-${ulid()}`;
    await post("attention.needed", { attention_id: id, kind: "permission", tool, message }, "PermissionRequest");
    open.add(id);
    return id;
  };
  const cleared = async (id: string) => {
    open.delete(id);
    await post("attention.cleared", { attention_id: id, how: "answered" }, "PreToolUse");
  };
  const done = async () => {
    for (const id of [...open]) await cleared(id);
  };
  const failed = (error: string) => post("turn.ended", { turn_id: turn, reason: "error", error, ms: 1200 }, "Stop");
  return { key, start, permission, cleared, done, failed };
}

const token = async (request: APIRequestContext) =>
  ((await (await request.get(INFO)).json()) as { sinkToken: string }).sinkToken;

test.describe("toasts", () => {
  test("a new permission is a card with Allow / Deny that stays, leaves with its clearing, and opens the session", async ({
    page,
    request,
  }) => {
    const s = sink(request, await token(request), `Toast target ${randomUUID().slice(0, 6)}`);
    await openPage(page, "/feed");
    await s.start();
    const card = page.locator(`.toast[data-session="${s.key}"]`);

    await s.permission("Bash", "git push origin main");
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/toast--needs-you/);
    await expect(card.locator(".toast-dot")).toHaveCount(1);
    await expect(card.locator(".toast-title")).toHaveText(/^Toast target/);
    await expect(card.locator(".toast-machine")).toHaveText("e2e-box");
    await expect(card.locator(".toast-label")).toHaveText("permission");
    await expect(card.locator(".toast-body code")).toHaveText("Bash");
    await expect(card.locator(".toast-msg")).toHaveText("git push origin main");
    await expect(card.getByRole("button", { name: "Allow" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Deny" })).toBeDisabled();
    await expect(card.locator(".toast-actions")).toHaveAttribute("data-answer", "unpaired");
    await expect(card.locator(".toast-note")).toHaveText("pair e2e-box to send messages");
    // It waits for a person: no timer on it (the demo's own prompts share the three slots, so
    // a long wait would race their eviction rather than prove anything).
    await expect(card).toHaveAttribute("data-sticky", "true");
    await page.waitForTimeout(2_500);
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: "Dismiss" }).click();
    await expect(card).toHaveCount(0);

    // A second prompt leaves with its clearing, like a row in the inbox.
    const second = await s.permission("Write", "src/app.ts");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-attention", second);
    await s.cleared(second);
    await expect(card).toHaveCount(0);

    // A third opens the session beside the page, and the card is done.
    await s.permission("Read", "~/.ssh/config");
    await expect(card).toBeVisible();
    await card.locator(".toast-main").click();
    await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
    await expect(page.locator("aside.panel .panel-title")).toHaveText(/^Toast target/);
    await expect(page).toHaveURL(/\/feed\?(.*&)?s=/);
    await expect(card).toHaveCount(0);
    await s.done();
  });

  test("a turn that ends with an error is a card that leaves by itself", async ({ page, request }) => {
    const s = sink(request, await token(request), `Toast error ${randomUUID().slice(0, 6)}`);
    await openPage(page, "/feed");
    await s.start();
    await s.failed("rate_limit");
    const card = page.locator(`.toast[data-session="${s.key}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-toast", "error");
    await expect(card.locator(".toast-dot")).toHaveCount(0);
    await expect(card.locator(".toast-label")).toHaveText("error");
    await expect(card.locator(".toast-msg")).toHaveText("The turn ended with an error: rate_limit");
    await expect(card.getByRole("button", { name: "Allow" })).toHaveCount(0);
    await expect(card).toHaveCount(0, { timeout: 12_000 });
  });

  test("what was already open at the first snapshot never toasts", async ({ page, request }) => {
    const s = sink(request, await token(request), `Toast quiet ${randomUUID().slice(0, 6)}`);
    await s.start();
    const id = await s.permission("Bash", "rm -rf build");
    await openPage(page, "/inbox");
    // The inbox lists it; the stack does not.
    await expect(page.locator(`.inbox-row[data-attention="${id}"]`)).toBeVisible();
    await page.waitForTimeout(1_500);
    await expect(page.locator(`.toast[data-session="${s.key}"]`)).toHaveCount(0);
    await s.done();
  });

  test("the sound of the moment plays with the card, and not with sounds off", async ({ page, request }) => {
    await stubAudio(page);
    const s = sink(request, await token(request), `Toast sound ${randomUUID().slice(0, 6)}`);
    await openPage(page, "/feed");
    await s.start();
    const card = page.locator(`.toast[data-session="${s.key}"]`);
    const id = await s.permission("Bash", "npm publish");
    await expect(card).toBeVisible();
    // The default for "needs you" is the two-note chime: two oscillators (the demo's own
    // toasts may add theirs meanwhile).
    await expect.poll(() => page.evaluate(() => window.__audio.started)).toBeGreaterThanOrEqual(2);
    await s.cleared(id);
    await expect(card).toHaveCount(0);

    await page.evaluate(() => localStorage.setItem("sessionpipe-gui.sounds", JSON.stringify({ on: false })));
    await page.reload();
    await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
    await s.permission("Bash", "npm publish --tag next");
    await expect(card).toBeVisible();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__audio.started)).toBe(0);
    await s.done();
  });

  test("a sound due before any click waits for one, and the stack says so", async ({ page, request }) => {
    await stubAudio(page, { locked: true });
    const s = sink(request, await token(request), `Toast locked ${randomUUID().slice(0, 6)}`);
    await openPage(page, "/feed");
    await s.start();
    const id = await s.permission("Bash", "git push origin main");
    const card = page.locator(`.toast[data-session="${s.key}"]`);
    await expect(card).toBeVisible();
    await expect(page.locator(".toasts .toast-unlock")).toHaveText("click anywhere once to enable sound");
    expect(await page.evaluate(() => window.__audio.started)).toBe(0);
    // The first gesture anywhere (a key will do) unlocks audio; the note goes.
    await page.evaluate(() => {
      window.__audio.allow = true;
    });
    await page.keyboard.press("Shift");
    await expect(page.locator(".toasts .toast-unlock")).toHaveCount(0);
    await s.cleared(id);
    await s.done();
  });
});
