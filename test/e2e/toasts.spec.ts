// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// In-app toasts, driven by events posted to the receiver as a sink would (so the timing is
// ours, not the demo's): a new answerable permission is a card with Allow / Deny (disabled
// with the unpaired reason) that stays until dismissed, leaves with its attention.cleared,
// and opens the session beside the page on a click; a turn that ends with an error is a
// card that leaves by itself; what was open at the first snapshot never toasts; the
// sound of the moment plays through a stubbed AudioContext, and not with sounds off. On a
// paired machine, a prompt whose hook stopped waiting has nothing to press.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { CONTROL_BASE, fakeDaemon, passkeyPage, postPrompt, seenSetupHere, sinkToken } from "./control-helpers.js";
import { EVENTS, INFO, openPage, openSessionsUnchosen, ulid } from "./helpers.js";

declare global {
  interface Window {
    __audio: { started: number; types: string[]; buffers: number; allow: boolean };
    /** keepOurs: the sessions and machines whose cards stay, and how many others it took. */
    __keep: { keys: string[]; swept: number };
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

/** A session on one machine whose events this spec posts, one at a time (to the demo's
 *  instance, or to `events` on another). */
function sink(request: APIRequestContext, token: string, title: string, events = EVENTS) {
  const sessionId = randomUUID();
  const key = `claude-code:${sessionId}`;
  let seq = 0;
  const post = async (type: string, data: Record<string, unknown>, hook: string) => {
    const r = await request.post(events, {
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

/** The pointer off the stack: a stack under the pointer holds still (a card that goes
 *  keeps its room, a new one waits) until the pointer leaves it. */
const away = (page: Page) => page.mouse.move(300, 850);

test.describe("toasts", () => {
  test("a new permission is a card with Allow / Deny that stays, leaves with its clearing, and opens the session", async ({
    page,
    request,
  }) => {
    const s = sink(request, await token(request), `Toast target ${randomUUID().slice(0, 6)}`);
    // Its click opens the session the way Settings says: beside, where nothing is chosen.
    await openSessionsUnchosen(page);
    await openPage(page, "/feed");
    await s.start();
    const card = page.locator(`.toast[data-session="${s.key}"]`);

    await s.permission("Bash", "git push origin main");
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/toast--needs-you/);
    await expect(card.locator(".toast-dot")).toHaveCount(1);
    // It leads with what happened, then the session.
    await expect(card.locator(".toast-head")).toHaveText("Needs you on e2e-box");
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
    await away(page);
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

  test("its tooltip says where a click goes: with As a page chosen, the session's page", async ({ page, request }) => {
    const s = sink(request, await token(request), `Toast page ${randomUUID().slice(0, 6)}`);
    await openPage(page, "/feed");
    await s.start();
    const card = page.locator(`.toast[data-session="${s.key}"]`);
    await s.permission("Bash", "git status");
    await expect(card).toBeVisible();
    await expect(card.locator(".toast-main")).toHaveAttribute("title", "Open the session");
    await card.locator(".toast-main").click();
    const [harness, id] = s.key.split(":");
    await expect(page).toHaveURL((u) => u.pathname === `/s/${harness}/${id}`);
    await expect(page.locator("aside.panel")).not.toHaveClass(/panel--open/);
    await s.done();
  });

  test("over Settings a click shows the session in Settings' place, and Back is the page it was over", async ({
    page,
    request,
  }) => {
    const s = sink(request, await token(request), `Toast over ${randomUUID().slice(0, 6)}`);
    // Beside, where nothing is chosen: a tab beside would open hidden under Settings.
    await openSessionsUnchosen(page);
    await openPage(page, "/feed");
    await s.start();
    await page.locator('[data-nav="settings"]').click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings).toBeVisible();
    const card = page.locator(`.toast[data-session="${s.key}"]`);
    await s.permission("Bash", "git status");
    await expect(card).toBeVisible();
    await expect(card.locator(".toast-main")).toHaveAttribute("title", "Open the session");
    await card.locator(".toast-main").click();
    const [harness, id] = s.key.split(":");
    await expect(page).toHaveURL((u) => u.pathname === `/s/${harness}/${id}` && !u.searchParams.has("settings"));
    await expect(settings).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL((u) => u.pathname === "/feed" && !u.searchParams.has("settings"));
    await expect(settings).toHaveCount(0);
    await s.done();
  });

  test("on a phone the banner fits the screen, 8 px from each edge, its lines cut inside it", async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const s = sink(
      request,
      await token(request),
      `A toast with a title long enough to run past the edge of any phone ${randomUUID().slice(0, 6)}`,
    );
    await openPage(page, "/feed");
    await s.start();
    const card = page.locator(`.toast[data-session="${s.key}"]`);
    await s.permission("Bash", "git push origin main --force-with-lease");
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/toast--banner/);
    // Once its entrance has played.
    await page.waitForTimeout(500);
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(390 - 8 + 0.5);
    // Both lines end inside the banner (an ellipsis), not past it.
    const inside = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return Array.from(el.querySelectorAll(".toast-head, .toast-top")).every((n) => {
        const b = n.getBoundingClientRect();
        return b.right <= r.right + 0.5 && b.left >= r.left - 0.5;
      });
    });
    expect(inside).toBe(true);
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
    await expect(card.locator(".toast-head")).toHaveText("Failed on e2e-box");
    await expect(card.locator(".toast-label")).toHaveText("error");
    await expect(card.locator(".toast-msg")).toHaveText("The turn ended with an error: rate_limit");
    await expect(card.getByRole("button", { name: "Allow" })).toHaveCount(0);
    await expect(card).toHaveCount(0, { timeout: 12_000 });
  });

  test("no banner for the session already on screen", async ({ page, request }) => {
    const s = sink(request, await token(request), `Toast seen ${randomUUID().slice(0, 6)}`);
    await s.start();
    const [harness, id] = s.key.split(":");
    await openPage(page, `/s/${harness}/${id}`);
    await s.permission("Bash", "git status");
    await page.waitForTimeout(1_500);
    await expect(page.locator(`.toast[data-session="${s.key}"]`)).toHaveCount(0);
    await s.done();
  });

  test("Hide acts at once with Undo, and Undo brings the row back", async ({ page, request }) => {
    const s = sink(request, await token(request), `Toast hide ${randomUUID().slice(0, 6)}`);
    await s.start();
    await openPage(page, "/");
    const row = page.locator(`article.card[data-flip="${s.key}"]`);
    await expect(row).toBeVisible();
    await row.locator("a.card-link").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Hide", exact: true }).click();
    await away(page);
    const undo = page.locator('.toast[data-toast="undo"]');
    await expect(undo).toContainText("Hidden");
    await expect(row).toHaveCount(0);
    await undo.getByRole("button", { name: "Undo" }).click();
    await away(page);
    await expect(row).toBeVisible();
    await expect(undo).toHaveCount(0);
    // ⌘Z / ctrl+Z does the same.
    await row.locator("a.card-link").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Hide", exact: true }).click();
    await expect(row).toHaveCount(0);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("ControlOrMeta+z");
    await expect(row).toBeVisible();
    await s.done();
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

// The test-door instance, which runs no demo: no card but this spec's (and the odd prompt
// another spec raises there) comes and goes while a card is measured. The tests here that
// post to it share a lock, so none of them pushes another's card out.
const CONTROL_EVENTS = `${CONTROL_BASE}/api/sessionpipe/v1/events`;
const TEST_DOOR = { lock: "toasts-test-door" };
const tag = () => randomUUID().slice(0, 6);

/** Keep only this test's cards on the page: every page on the test-door instance gets a
 *  card for each prompt another spec raises there, which would take the three places (a
 *  passing card goes first) or move the card measured. Those are dismissed as they come,
 *  by their ×. `keys`: session keys or machine names, more added later by `keep`. */
async function keepOurs(page: Page, keys: string[]) {
  await page.evaluate((keys) => {
    window.__keep = { keys, swept: 0 };
    const ours = (el: HTMLElement) =>
      window.__keep.keys.includes(el.dataset.session ?? "") ||
      window.__keep.keys.includes(el.querySelector(".toast-machine")?.textContent ?? "");
    const sweep = () => {
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>(".toast-slot:not([data-closing]) .toast[data-session]"),
      ))
        if (!ours(el)) {
          const x = Array.from(el.querySelectorAll<HTMLButtonElement>("button")).find(
            (b) => (b.getAttribute("aria-label") ?? b.textContent) === "Dismiss",
          );
          if (!x) continue;
          window.__keep.swept++;
          x.click();
        }
    };
    sweep();
    new MutationObserver(sweep).observe(document.body, { childList: true, subtree: true });
  }, keys);
}
const keep = (page: Page, ...keys: string[]) =>
  page.evaluate((keys) => {
    window.__keep.keys.push(...keys);
  }, keys);

/** The test-door page, live, keeping only this test's cards. */
async function openOurs(page: Page, url: string, keys: string[]) {
  await openPage(page, url);
  await keepOurs(page, keys);
}

/** Every card's entrance (and exit) played out. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(
      Array.from(document.querySelectorAll(".toasts"))
        .flatMap((el) => el.getAnimations({ subtree: true }))
        .map((a) => a.finished.catch(() => null)),
    ).then(() => null),
  );

// A paired machine (the test-door instance, control-helpers.ts): Claude Code's hook waits
// 125 s for an answer, so past 120 s a banner offers nothing to press, and says why.
test.describe("toasts: a prompt's answer window", TEST_DOOR, () => {
  test("a prompt its hook stopped waiting on has no Allow / Deny, and a fresh one loses them as its window runs out", async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000);
    await seenSetupHere(context);
    const key = await passkeyPage(context, page);
    const bearer = await sinkToken();
    const d = await fakeDaemon(key, { name: `window-${randomUUID().slice(0, 6)}`, harnesses: ["claude-code"] });
    const posted: { clear: () => Promise<void> }[] = [];
    try {
      await page.goto(`${CONTROL_BASE}/feed`);
      await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
      // Another spec's prompt on this instance would take the fresh card's place (three at
      // most, the oldest prompt first) before its window runs out.
      await keepOurs(page, [d.name]);
      const words = `too late to answer from here; answer it on ${d.name}`;
      const late = await postPrompt(bearer, { machine: d.name, title: "Asked 130 s ago", agoMs: 130_000 });
      posted.push(late);
      const card = page.locator(`.toast[data-attention="${late.attention}"]`);
      await expect(card.locator(".toast-actions")).toHaveAttribute("data-answer", "late");
      await expect(card.locator(".toast-note")).toHaveText(words);
      await expect(card.getByRole("button", { name: /^(Allow|Deny)$/ })).toHaveCount(0);
      await card.getByRole("button", { name: "Dismiss" }).click();
      await away(page);
      // Inside its window, Allow is there to press until the window runs out.
      const fresh = await postPrompt(bearer, { machine: d.name, title: "Asked 112 s ago", agoMs: 112_000 });
      posted.push(fresh);
      const next = page.locator(`.toast[data-attention="${fresh.attention}"]`);
      await expect(next.locator(".toast-actions")).toHaveAttribute("data-answer", "open");
      await expect(next.getByRole("button", { name: "Allow" })).toBeEnabled();
      await expect(next.locator(".toast-actions")).toHaveAttribute("data-answer", "late", { timeout: 20_000 });
      await expect(next.locator(".toast-note")).toHaveText(words);
      await expect(next.getByRole("button", { name: /^(Allow|Deny)$/ })).toHaveCount(0);
    } finally {
      for (const p of posted) await p.clear();
      await d.stop();
    }
  });
});

test.describe("toasts: the stack holds still", TEST_DOOR, () => {
  /** This test's sessions, their prompts cleared once it ends, passed or not. */
  let sinks: ReturnType<typeof sink>[] = [];
  const ours = (request: APIRequestContext, bearer: string, title: string) => {
    const s = sink(request, bearer, `${title} ${tag()}`, CONTROL_EVENTS);
    sinks.push(s);
    return s;
  };
  test.beforeEach(async ({ context }) => {
    sinks = [];
    await seenSetupHere(context);
  });
  test.afterEach(async () => {
    for (const s of sinks) await s.done();
  });

  /** Where each card stands, read at once once nothing moves: its top and bottom, its
   *  place in the list and the cards before it (drawn above it). */
  const where = async (page: Page, keys: string[]) => {
    let at: Record<string, { top: number; bottom: number; index: number; above: string }> = {};
    await expect(async () => {
      await settled(page);
      const m = await page.evaluate((keys) => {
        const slots = Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast-slot"));
        if (slots.some((s) => s.hasAttribute("data-closing"))) return null;
        const out: Record<string, { top: number; bottom: number; index: number; above: string }> = {};
        for (const k of keys) {
          const index = slots.findIndex((s) => s.querySelector(`.toast[data-session="${k}"]`));
          if (index < 0) return null;
          const r = slots[index]!.querySelector(".toast")!.getBoundingClientRect();
          const above = slots
            .slice(0, index)
            .map((s) => s.dataset.toastId)
            .join();
          out[k] = { top: r.top, bottom: r.bottom, index, above };
        }
        return out;
      }, keys);
      expect(m).not.toBeNull();
      at = m!;
    }).toPass({ timeout: 10_000 });
    return at;
  };

  test("a passing card sits under the prompt, which keeps its place, and a short command is whole beside Allow", async ({
    page,
    request,
  }) => {
    const bearer = await sinkToken();
    const asks = ours(request, bearer, "Hold ask");
    const fails = ours(request, bearer, "Hold fail");
    await openOurs(page, `${CONTROL_BASE}/feed`, [asks.key, fails.key]);
    await asks.start();
    await fails.start();
    await asks.permission("Bash", "npm run deploy -- --target staging");
    const prompt = page.locator(`.toast[data-session="${asks.key}"]`);
    await expect(prompt).toBeVisible();
    // The command on its own line under "Bash wants to run:", whole, with Allow beside it.
    await expect(prompt.locator(".toast-verb")).toHaveText(" wants to run:");
    const msg = prompt.locator(".toast-msg.mono");
    await expect(msg).toHaveText("npm run deploy -- --target staging");
    expect(await msg.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    expect(await msg.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe("none");
    await expect(prompt.getByRole("button", { name: "Allow" })).toHaveCount(1);
    const before = (await where(page, [asks.key]))[asks.key]!;

    await fails.failed("api_overloaded");
    await expect(page.locator(`.toast[data-session="${fails.key}"]`)).toBeVisible();
    const after = await where(page, [asks.key, fails.key]);
    const p = after[asks.key]!;
    const e = after[fails.key]!;
    // The error is drawn under the prompt, and comes after it in the list (as it is drawn).
    expect(e.index).toBeGreaterThan(p.index);
    expect(e.top).toBeGreaterThanOrEqual(p.bottom - 1);
    // Only a newer prompt (another spec's, on its way out) may have moved it.
    if (p.above === before.above) expect(Math.abs(p.top - before.top)).toBeLessThanOrEqual(1);
  });

  test("a request shown whole beside Allow is never cut, whatever the tool", async ({ page, request }) => {
    const s = ours(request, await sinkToken(), "Hold write");
    await openOurs(page, `${CONTROL_BASE}/feed`, [s.key]);
    await s.start();
    const path = "/Users/e2e/code/sessionpipe-gui/web/src/components/settings/ReleaseChannelPicker.tsx";
    expect(path.length).toBeGreaterThanOrEqual(80);
    expect(path.length).toBeLessThanOrEqual(100);
    await s.permission("Write", path);
    const card = page.locator(`.toast[data-session="${s.key}"]`);
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/toast--whole/);
    await expect(card.getByRole("button", { name: "Allow" })).toHaveCount(1);
    await expect(card.locator(".toast-msg")).toHaveText(path);
    const body = card.locator(".toast-body");
    expect(await body.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  });

  test("a command too long to show whole offers Open, and no Allow, on the card or in its menu", async ({
    page,
    request,
  }) => {
    const s = ours(request, await sinkToken(), "Hold long");
    // Its Open opens the session the way Settings says: beside, where nothing is chosen.
    await openSessionsUnchosen(page);
    await openOurs(page, `${CONTROL_BASE}/feed`, [s.key]);
    await s.start();
    const command = `rsync -av --delete ./build/ deploy@staging.example.com:/srv/app/releases/2026-11-18/ --exclude node_modules ${"x".repeat(20)}`;
    expect(command.length).toBeGreaterThanOrEqual(120);
    await s.permission("Bash", command);
    const card = page.locator(`.toast[data-session="${s.key}"]`);
    await expect(card).toBeVisible();
    // Held under the pointer: no other spec's prompt pushes it out meanwhile.
    await card.locator(".toast-title").hover();
    await expect(card.getByRole("button", { name: "Open", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: /^(Allow|Deny)$/ })).toHaveCount(0);
    // Two lines and an ellipsis.
    const msg = card.locator(".toast-msg.mono");
    expect(await msg.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe("2");
    expect(await msg.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
    await card.locator(".toast-main").click({ button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Open beside" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^(Allow|Deny) Bash/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // Open opens the session beside the page.
    await card.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
  });

  test("a card that comes while the pointer is on the stack waits until it leaves", async ({ page, request }) => {
    const bearer = await sinkToken();
    const first = ours(request, bearer, "Hold first");
    const next = ours(request, bearer, "Hold next");
    await openOurs(page, `${CONTROL_BASE}/feed`, [first.key, next.key]);
    await first.start();
    await next.start();
    await first.permission("Bash", "git status");
    const card = page.locator(`.toast[data-session="${first.key}"]`);
    await expect(card).toBeVisible();
    await card.locator(".toast-title").hover();
    await next.permission("Bash", "git push");
    const late = page.locator(`.toast[data-session="${next.key}"]`);
    await page.waitForTimeout(1_500);
    await expect(late).toHaveCount(0);
    await away(page);
    await expect(late).toBeVisible({ timeout: 1_000 });
  });

  test("a card dismissed under the pointer keeps its room until the pointer leaves, so the one beside it holds still", async ({
    page,
    request,
  }) => {
    const bearer = await sinkToken();
    const asks = ours(request, bearer, "Hold room");
    const fails = ours(request, bearer, "Hold gone");
    const later = ours(request, bearer, "Hold later");
    await openOurs(page, `${CONTROL_BASE}/feed`, [asks.key, fails.key, later.key]);
    await asks.start();
    await fails.start();
    await later.start();
    await asks.permission("Bash", "git status");
    const prompt = page.locator(`.toast[data-session="${asks.key}"]`);
    await expect(prompt).toBeVisible();
    await fails.failed("api_overloaded");
    const error = page.locator(`.toast[data-session="${fails.key}"]`);
    await expect(error).toBeVisible();
    const slot = page.locator(".toast-slot", { has: error });
    // × with the pointer, which stays where the card was.
    await error.locator(".toast-title").hover();
    const top = (await where(page, [asks.key]))[asks.key]!.top;
    const tall = (await slot.boundingBox())!.height;
    await error.getByRole("button", { name: "Dismiss" }).click();
    await later.permission("Bash", "git push");
    await page.waitForTimeout(1_000);
    await expect(slot).toHaveAttribute("data-held", "");
    expect(Math.round((await slot.boundingBox())!.height)).toBe(Math.round(tall));
    await expect(page.locator(`.toast[data-session="${later.key}"]`)).toHaveCount(0);
    expect(Math.abs((await prompt.boundingBox())!.y - top)).toBeLessThanOrEqual(1);
    // Let go: the room closes and the card that waited comes in.
    await away(page);
    await expect(slot).toHaveCount(0);
    await expect(page.locator(`.toast[data-session="${later.key}"]`)).toBeVisible();
  });

  test("an error under the pointer stays past its time, and goes with the time it had left once the pointer leaves", async ({
    page,
    request,
  }) => {
    test.setTimeout(60_000);
    const s = ours(request, await sinkToken(), "Hold error");
    await openOurs(page, `${CONTROL_BASE}/feed`, [s.key]);
    await s.start();
    await s.failed("api_overloaded");
    const card = page.locator(`.toast[data-session="${s.key}"]`);
    await expect(card).toBeVisible();
    await card.locator(".toast-title").hover();
    await page.waitForTimeout(9_000);
    await expect(card).toBeVisible();
    await away(page);
    await expect(card).toHaveCount(0, { timeout: 10_000 });
  });

  test("⌘⇧T, then × with the keyboard: focus starts at the newest card and goes down to the next, and from the last back to the row", async ({
    page,
    request,
  }) => {
    const bearer = await sinkToken();
    const one = ours(request, bearer, "Hold keys one");
    const two = ours(request, bearer, "Hold keys two");
    await openOurs(page, `${CONTROL_BASE}/`, [one.key, two.key]);
    await one.start();
    await two.start();
    const link = page.locator(`article.card[data-flip="${one.key}"] a.card-link`);
    await expect(link).toBeVisible();
    await one.failed("api_overloaded");
    await expect(page.locator(`.toast[data-session="${one.key}"]`)).toBeVisible();
    await two.failed("rate_limit");
    await expect(page.locator(`.toast[data-session="${two.key}"]`)).toBeVisible();
    await link.focus();
    await page.keyboard.press("ControlOrMeta+Shift+t");
    const inStack = () =>
      page.evaluate(() => {
        const a = document.activeElement;
        return a?.closest(".toast-slot:not([data-closing])")?.getAttribute("data-toast-id") ?? null;
      });
    let at = await inStack();
    // The newest, nearest the corner.
    expect(at).toContain(two.key);
    for (let i = 0; i < 6 && at; i++) {
      await page.keyboard.press("Tab");
      await expect(page.locator(".toasts .toast-x:focus")).toHaveCount(1);
      await page.keyboard.press("Enter");
      const now = await inStack();
      // The next card, never the one that went.
      if (now) expect(now).not.toBe(at);
      // Both cards are this test's, so the first × always has a next card: the one under it.
      if (i === 0) expect(now).toContain(one.key);
      at = now;
    }
    await expect(link).toBeFocused();
  });

  test("⌘⇧T, then × with the mouse: once the pointer leaves, nothing stays held", async ({ page, request }) => {
    test.setTimeout(60_000);
    const bearer = await sinkToken();
    const one = ours(request, bearer, "Hold mouse one");
    const two = ours(request, bearer, "Hold mouse two");
    const three = ours(request, bearer, "Hold mouse three");
    await openOurs(page, `${CONTROL_BASE}/feed`, [one.key, two.key, three.key]);
    await one.start();
    await two.start();
    await three.start();
    await one.failed("api_overloaded");
    const first = page.locator(`.toast[data-session="${one.key}"]`);
    await expect(first).toBeVisible();
    await two.failed("rate_limit");
    const card = page.locator(`.toast[data-session="${two.key}"]`);
    await expect(card).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+t");
    await expect(page.locator(".toasts :focus")).toHaveCount(1);
    // A click moves focus onto the × (Chromium): the pointer's, not the keyboard's.
    const slot = page.locator(".toast-slot", { has: card });
    await card.getByRole("button", { name: "Dismiss" }).click();
    await away(page);
    // The kept room closes, the error left leaves by itself, and a new card comes in.
    await expect(slot).toHaveCount(0, { timeout: 3_000 });
    await expect(first).toHaveCount(0, { timeout: 12_000 });
    await three.failed("api_overloaded");
    await expect(page.locator(`.toast[data-session="${three.key}"]`)).toBeVisible({ timeout: 5_000 });
  });

  test("Esc in the notifications goes back to the page and leaves the panel open", async ({ page, request }) => {
    const bearer = await sinkToken();
    const side = ours(request, bearer, "Hold side");
    const fails = ours(request, bearer, "Hold esc");
    await side.start();
    await openOurs(page, `${CONTROL_BASE}/feed?s=${encodeURIComponent(side.key)}`, [side.key, fails.key]);
    await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
    await fails.start();
    await fails.failed("api_overloaded");
    const card = page.locator(`.toast[data-session="${fails.key}"]`);
    await expect(card).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+t");
    await expect(page.locator(".toasts :focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator(".toasts :focus")).toHaveCount(0);
    await expect(page.locator("aside.panel")).toHaveClass(/panel--open/);
    await expect(card).toBeVisible();
  });

  test("on a phone a banner held by a finger stays past its time", async ({ page, request }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const bearer = await sinkToken();
    await openOurs(page, `${CONTROL_BASE}/feed`, []);
    // A phone shows one banner: another spec's prompt on this instance replaces this one
    // (keepOurs then dismisses it). A try that saw one is not this test's; it tries again.
    for (let attempt = 0; ; attempt++) {
      const s = ours(request, bearer, "Hold finger");
      await keep(page, s.key);
      await page.evaluate(() => {
        window.__keep.swept = 0;
      });
      await s.start();
      await s.failed("api_overloaded");
      const banner = page.locator(`.toast[data-session="${s.key}"]`);
      await expect(banner).toHaveClass(/toast--banner/);
      await banner.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, button: 0, pointerId: 7 });
      await page.waitForTimeout(9_000);
      const replaced = await page.evaluate(() => window.__keep.swept > 0);
      if ((await banner.count()) === 0 && replaced && attempt < 2) {
        await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7 })));
        continue;
      }
      await expect(banner).toBeVisible();
      await banner.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, button: 0, pointerId: 7 });
      await expect(banner).toHaveCount(0, { timeout: 4_000 });
      break;
    }
  });
});
