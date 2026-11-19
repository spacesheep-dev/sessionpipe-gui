// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The board as a person sees it: groups by state, a working card's current tool, its
// reply's newest words ahead of a flag on a phone, an attention banner when the demo
// asks for a permission, the collapsed done group,
// live counts without a reload (with Advanced → Show counts), a list that holds still
// under the pointer, the search that finds nothing, the keyboard (e with Hidden open
// too), the Hidden header's own menu, and a row's menu that the click which opened it
// chooses nothing from.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { EVENTS, holdBoard, INFO, openBoard, sessionUrl, tier1Batch, ulid } from "./helpers.js";

test.describe("board", () => {
  test("groups demo sessions by state and collapses done with a count", async ({ page }) => {
    await openBoard(page);
    // The demo's backfill makes a done group at once; its cards stay hidden until asked for.
    const done = page.locator("section.group--done");
    await expect(done).toBeVisible();
    const toggle = done.locator("button.group-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle.locator(".group-count")).toHaveText(/^[1-9]\d*$/);
    await expect(done.locator(".grid--done")).toHaveCount(0);
    await expect(done.locator("article.card")).toHaveCount(0);
    await expect(toggle).toContainText("Done");
    // Live groups: at least one of working/idle is there and each heading carries a count.
    await expect(page.locator("section.group--working, section.group--idle").first()).toBeVisible();
    for (const group of await page.locator("section.group:not(.group--done)").all()) {
      await expect(group.locator("h2.group-head")).toHaveText(/^(Needs? you|Working|Stale|Idle)\s*[1-9]\d*$/);
      expect(await group.locator("article.card").count()).toBeGreaterThan(0);
    }
    // Every card in a state group wears that state's dot and label.
    const working = page.locator("section.group--working article.card").first();
    if (await working.isVisible()) {
      await expect(working.locator(".card-state .dot--working")).toBeVisible();
      await expect(working.locator(".card-state")).toContainText("working");
    }
    // Expanding done shows the cards and the count still matches.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const n = Number(await toggle.locator(".group-count").innerText());
    await expect(done.locator("article.card--done")).toHaveCount(n);
  });

  test("Done's head says how many are unread only while it is folded", async ({ page }) => {
    await openBoard(page);
    const done = page.locator("section.group--done");
    const toggle = done.locator("button.group-toggle");
    await toggle.click();
    // A session that just finished lands in Done unread already, and its menu offers
    // "Mark as read"; so take a row that is read (another worker on the same server may
    // mark it first, so each try takes one afresh), and keep to it by its link as rows
    // re-sort. A scroll closes a menu, as a native one does, so one that closed is opened
    // again.
    let href: string | null = null;
    const link = () => done.locator(`a.card-link[href="${href}"]`);
    await expect(async () => {
      await page.keyboard.press("Escape");
      href = await done
        .locator("article.card--done:not(:has(.dot--unread)) a.card-link")
        .first()
        .getAttribute("href", { timeout: 2000 });
      await link().click({ button: "right" });
      await page.getByRole("menuitem", { name: "Mark as unread" }).click({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    // Open, the row's filled dot says it; the head does not say it again.
    await expect(link().locator(".dot--unread")).toBeVisible();
    await expect(toggle.locator(".group-note")).toHaveCount(0);
    await toggle.click();
    await expect(toggle.locator(".group-note")).toHaveText(/^[1-9]\d* unread$/);
  });

  test("a working card shows the tool it is running", async ({ page }) => {
    await openBoard(page);
    // The status of a working row: the glyph (its state word for assistive tech), the
    // tool, and its time. The element lays its parts out across the row (display:
    // contents), so the tool is what is visible.
    const status = page.locator("article.card--working .card-status:has(code)");
    await expect(status.first().locator("code")).toBeVisible({ timeout: 30_000 });
    await expect(status.first().locator("code")).toHaveText(/^\S+$/);
    await expect(status.first().locator(".card-state")).toContainText("working");
    await expect(status.first().locator(".num").last()).toHaveText(/\d/);
  });

  test("on a phone a working row's words keep the line: a flag gives way, a gap is not said", async ({ page }) => {
    test.setTimeout(90_000);
    const { sinkToken } = (await (await page.request.get(INFO)).json()) as { sinkToken: string };
    const id = randomUUID();
    let seq = 0;
    let clock = Date.now() - 60_000;
    const ev = (type: string, data: Record<string, unknown>) => {
      clock += 1000;
      return {
        protocol: 1,
        id: ulid(clock),
        type,
        time: new Date(clock).toISOString(),
        tier: 3,
        harness: { name: "claude-code", version: "2.1.296", event: "Hook" },
        session: {
          id,
          seq: seq++,
          machine: "e2e-box",
          cwd: "~/code/e2e",
          title: "E2E long reply",
          title_source: "custom",
        },
        privacy: { rulesets: ["secrets@1"], pii: false },
        data: { turn_id: "t1", ...data },
      };
    };
    const input = { file_path: "src/relay/reader.ts" };
    const events = [ev("session.started", { source: "startup" }), ev("turn.started", {})];
    // The same Read three times is a loop; two compactions within half an hour are compacting.
    for (const n of [1, 2, 3])
      events.push(
        ev("tool.started", { tool: "Read", call_id: `r${n}`, input }),
        ev("tool.ended", { tool: "Read", call_id: `r${n}`, input, ok: true, ms: 20 }),
      );
    events.push(ev("context.compacted", { trigger: "auto" }), ev("context.compacted", { trigger: "auto" }));
    events.push(
      ev("turn.progress", {
        turn: 1,
        assistant:
          "I traced the doubling through the relay's reader and the page's store, from the first page to the " +
          "last. Each reply arrives twice when the page reconnects, because the cursor is written after the " +
          "page it names. Next I'll write the cursor in the same write as the page, and add a test for it.",
      }),
    );
    // A hole a sink left: the two seqs before the last event never come.
    seq += 2;
    events.push(ev("tool.started", { tool: "Bash", call_id: "b1", input: { command: "npm test" } }));
    const res = await page.request.post(EVENTS, {
      headers: { authorization: `Bearer ${sinkToken}` },
      data: { events },
    });
    expect(res.status()).toBe(202);
    try {
      const card = page.locator(`article.card:has(a.card-link[href^="${sessionUrl("claude-code", id)}"])`);
      for (const [width, height] of [
        [320, 568],
        [393, 852],
      ] as const) {
        await page.setViewportSize({ width, height });
        await openBoard(page);
        // Only what says a session is stuck: the loop, not the compactions.
        await expect(card.locator(".card-flags")).toHaveText("Read ×3 on the same input");
        await expect(card.locator(".card-text")).toHaveText(/^Next I'll write the cursor/);
        const [text, flag, line] = await Promise.all(
          [".card-text", ".card-flags", ".card-line"].map((c) => card.locator(c).evaluate((e) => e.clientWidth)),
        );
        expect(text, `${width}: the words take at least 40% of the line`).toBeGreaterThanOrEqual(0.4 * line!);
        // Cut, not crushed: the flag keeps enough of its words to be read.
        expect(flag, `${width}: the flag keeps 30% of the line`).toBeGreaterThanOrEqual(0.3 * line!);
      }
      // Past GAP_AFTER_MS the store reads the sink's hole as a gap; the row does not say it.
      await expect
        .poll(
          async () => {
            const d = await (await page.request.get(`/api/ui/sessions/claude-code/${id}?limit=1`)).json();
            return (d as { session: { flags: { kind: string }[] } }).session.flags.map((f) => f.kind);
          },
          { timeout: 60_000, intervals: [2_000] },
        )
        .toContain("gap");
      await expect(card.locator(".card-flags")).toHaveText("Read ×3 on the same input");
      expect(await page.locator(".board-list").innerText()).not.toMatch(/waiting for \d+ events?/);
    } finally {
      await page.request.post(`/api/ui/sessions/claude-code/${id}/forget`);
    }
  });

  test("a needs-you card appears with its attention banner", async ({ page }) => {
    test.setTimeout(90_000);
    await openBoard(page);
    // The demo's permission windows last ~2 s of wall time at speed 20 and recur every
    // 6–20 s; read the banner in one go so a vanished card just makes the poll retry.
    await expect
      .poll(
        async () => {
          const card = page.locator("section.group--needs_you article.card--needs_you").first();
          if ((await card.count()) === 0) return null;
          try {
            // textContent, not innerText: labels may be transformed by CSS.
            return {
              status: await card.locator(".card-status").textContent({ timeout: 500 }),
              tool: await card.locator(".card-status code").textContent({ timeout: 500 }),
              msg: await card.locator(".card-attn").textContent({ timeout: 500 }),
              dot: await card.locator(".card-state .dot--needs_you").count(),
            };
          } catch {
            return null;
          }
        },
        { timeout: 60_000, message: "a needs_you card with its attention banner" },
      )
      .toMatchObject({
        status: expect.stringMatching(/needs you\s*·?\s*permission/),
        tool: expect.stringMatching(/^\S+$/),
        msg: expect.stringMatching(/\S/),
        dot: 1,
      });
  });

  test("counts on a working card change live, without a reload", async ({ page }) => {
    // Turns and tools are the row's tooltip by default; "Show counts" prints them.
    await page.addInitScript(() => localStorage.setItem("sessionpipe-gui.board.counts", "1"));
    await openBoard(page);
    await expect(page.locator(".conn").first()).toHaveText("live");
    const foot = async () => {
      const out = new Map<string, string>();
      for (const card of await page.locator("article.card--working").all()) {
        const href = await card.locator("a.card-link").getAttribute("href");
        const text = await card
          .locator(".card-foot")
          .innerText()
          .catch(() => "");
        if (href && text) out.set(href, text);
      }
      return out;
    };
    await expect.poll(async () => (await foot()).size, { timeout: 30_000 }).toBeGreaterThan(0);
    const before = await foot();
    const navigations: string[] = [];
    page.on("framenavigated", (f) => f === page.mainFrame() && navigations.push(f.url()));
    await expect
      .poll(
        async () => {
          const now = await foot();
          for (const [href, text] of before) {
            const cur = now.get(href);
            if (cur && cur !== text) return `${text} -> ${cur}`;
          }
          return null;
        },
        { timeout: 30_000, message: "a working card's footer counts to change" },
      )
      .toMatch(/\d+ (turn|tool|file|subagent)/);
    expect(navigations, "no reload or navigation happened").toEqual([]);
  });

  test("by default a row says two facts; Show counts in the view menu adds the columns", async ({ page }) => {
    await openBoard(page);
    await expect(page.locator("article.card .card-foot")).toHaveCount(0);
    // The counts are the row's tooltip instead.
    await expect(page.locator("article.card a.card-link").first()).toHaveAttribute("title", /\d+ (turn|tool)/);
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Show counts" }).click();
    await expect(page.locator("article.card .card-foot").first()).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("sessionpipe-gui.board.counts"))).toBe("1");
  });

  test("a row's one time is how long it has been in its group, with one tooltip, and the ✕ beside it", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const { sinkToken } = (await (await page.request.get(INFO)).json()) as { sinkToken: string };
    const now = Date.now();
    const ago = (m: number) => now - m * 60_000;
    const ids: string[] = [];
    /** A session of its own, its events dated as given. */
    const session = (title: string, cwd = "~/code/e2e") => {
      const id = randomUUID();
      ids.push(id);
      let seq = 0;
      const ev = (type: string, at: number, data: Record<string, unknown> = {}) => ({
        protocol: 1,
        id: ulid(at),
        type,
        time: new Date(at).toISOString(),
        tier: 3,
        harness: { name: "claude-code", version: "2.1.296", event: "Hook" },
        session: { id, seq: seq++, machine: "e2e-box", cwd, title, title_source: "custom" },
        privacy: { rulesets: ["secrets@1"], pii: false },
        data: { turn_id: "t1", ...data },
      });
      const card = page.locator(`article.card:has(a.card-link[href^="${sessionUrl("claude-code", id)}"])`);
      return { ev, card };
    };
    const post = async (events: unknown[]) => {
      const res = await page.request.post(EVENTS, {
        headers: { authorization: `Bearer ${sinkToken}` },
        data: { events },
      });
      expect(res.status()).toBe(202);
    };
    const bash = (call: string) => ({ tool: "Bash", call_id: call, input: { command: "npm ci" } });
    // A turn 30 m old, its tool fresh; one 5 m tool, slow; a Bash 49 m quiet, stale; a Bash that failed.
    const old = session("E2E row time: old turn, fresh tool");
    const slow = session("E2E row time: slow tool");
    const stale = session("E2E row time: quiet Bash");
    const failed = session("E2E row time: failed Bash", "~/code/a-rather-long-repository-name-for-the-where-line");
    await post([
      old.ev("session.started", ago(31), { source: "startup" }),
      old.ev("turn.started", ago(30)),
      old.ev("tool.started", now, { tool: "Read", call_id: "r1", input: { file_path: "a.ts" } }),
      slow.ev("session.started", ago(7), { source: "startup" }),
      slow.ev("turn.started", ago(6)),
      slow.ev("tool.started", ago(5), bash("b1")),
      stale.ev("session.started", ago(51), { source: "startup" }),
      stale.ev("turn.started", ago(50)),
      stale.ev("tool.started", ago(49), bash("b1")),
      failed.ev("session.started", ago(2), { source: "startup" }),
      failed.ev("turn.started", ago(1.5)),
      failed.ev("tool.started", ago(1), bash("b1")),
      failed.ev("tool.ended", ago(0.9), { ...bash("b1"), ok: false, ms: 900 }),
    ]);
    try {
      await openBoard(page);
      // Working: the turn's 30 m, not the fresh tool's seconds, and still after a second tool.
      await expect(old.card.locator(".card-tool")).toHaveText("Read");
      await expect(old.card.locator(".card-time")).toHaveText("30 m");
      await post([
        old.ev("tool.ended", Date.now(), { tool: "Read", call_id: "r1", ok: true, ms: 40 }),
        old.ev("tool.started", Date.now(), bash("b2")),
      ]);
      await expect(old.card.locator(".card-tool")).toHaveText("Bash");
      await expect(old.card.locator(".card-time")).toHaveText("30 m");
      // One tooltip, on the cell: what the number measures.
      await expect(old.card.locator(".card-time")).toHaveAttribute("title", /^Working since \S/);
      await expect(old.card.locator(".card-time time")).not.toHaveAttribute("title");
      // A slow tool says its own age once, after its name.
      await expect(slow.card.locator(".card-tool")).toHaveText("Bash · 5 m");
      await expect(slow.card.locator(".card-flags")).toHaveCount(0);
      // Stale: since the last word, the tool named without a second clock.
      await expect(stale.card.locator(".card-time")).toHaveText("49 m");
      await expect(stale.card.locator(".card-time")).toHaveAttribute("title", /^No word since \S/);
      await expect(stale.card.locator(".card-tool")).toHaveText("Bash");
      await expect(stale.card.locator(".card-flags")).toHaveCount(0);
      // The last tool failed: the ✕ just before the time, at every width, and no foot.
      for (const [width, height] of [
        [1440, 900],
        [393, 852],
      ] as const) {
        await page.setViewportSize({ width, height });
        const mark = failed.card.locator(".card-time .card-err");
        await expect(mark).toBeVisible();
        await expect(failed.card.locator(".card-foot")).toHaveCount(0);
        const [x, t] = await Promise.all([mark.boundingBox(), failed.card.locator(".card-time time").boundingBox()]);
        const gap = t!.x - (x!.x + x!.width);
        expect(gap, `${width}: the ✕ sits just before the time`).toBeGreaterThanOrEqual(0);
        expect(gap, `${width}: the ✕ sits just before the time`).toBeLessThanOrEqual(8);
      }
      // With Show counts on, the ✕ is in the errors column, and only there.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem("sessionpipe-gui.board.counts", "1"));
      await openBoard(page);
      await expect(failed.card.locator(".card-foot .card-err")).toBeVisible();
      await expect(failed.card.locator(".card-err")).toHaveCount(1);
    } finally {
      for (const id of ids) await page.request.post(`/api/ui/sessions/claude-code/${id}/forget`);
    }
  });

  test("the list holds still under the pointer: no row moves while it rests on one", async ({ page }) => {
    test.setTimeout(60_000);
    await openBoard(page);
    // The first row: nothing above it is the pointer's to hold but the section header.
    const row = page.locator("section.group:not(.group--done) article.card").first();
    await expect(row).toBeVisible();
    const box = await row.boundingBox();
    if (!box) throw new Error("no row");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".page.board")).toHaveAttribute("data-held", "");
    const key = await row.getAttribute("data-flip");
    const card = page.locator(`article.card[data-flip="${key}"]`);
    // A move that was already playing when the pointer arrived finishes first.
    await page.waitForTimeout(600);
    const at = Math.round((await card.boundingBox())?.y ?? -1);
    const tops: number[] = [];
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      tops.push(Math.round((await card.boundingBox())?.y ?? -1));
    }
    // The demo changes states every few seconds; the row under the pointer stays put.
    expect(new Set(tops)).toEqual(new Set([at]));
    // Leaving lets the list take its real order again.
    await page.mouse.move(5, 5);
    await expect(page.locator(".page.board")).not.toHaveAttribute("data-held", "", { timeout: 5_000 });
  });

  test("a filter applies at once while the pointer rests on the list", async ({ page }) => {
    // A row of the test's own, so the filter has one row to keep.
    const { sinkToken } = (await (await page.request.get(INFO)).json()) as { sinkToken: string };
    const b = tier1Batch({ title: "E2E held filter" });
    const res = await page.request.post(EVENTS, {
      headers: { authorization: `Bearer ${sinkToken}` },
      data: { events: b.events },
    });
    expect(res.status()).toBe(202);
    try {
      await openBoard(page);
      const card = page.locator(`article.card:has(a.card-link[href^="${sessionUrl(b.harness, b.sessionId)}"])`);
      await expect(card).toBeVisible();
      expect(await page.locator("article.card").count()).toBeGreaterThan(1);
      // The pointer rests on the row: the list holds.
      await card.hover();
      await expect(page.locator(".page.board")).toHaveAttribute("data-held", "");
      // fill() types without moving the pointer, so the list is still held when the filter
      // changes: the rows it took away leave now, not when the pointer does. The session's
      // id is the one thing no other row has.
      await page.getByRole("searchbox", { name: "Search sessions" }).fill(b.sessionId);
      await expect(page.locator("article.card")).toHaveCount(1);
      await expect(card).toBeVisible();
    } finally {
      // The specs share one receiver: the row goes, so the board other specs read is no longer.
      await page.request.post(`/api/ui/sessions/${b.harness}/${b.sessionId}/forget`);
    }
  });

  test("a search that finds nothing says so, with Clear search", async ({ page }) => {
    await openBoard(page);
    await page.getByRole("searchbox", { name: "Search sessions" }).fill("zzzz-nothing");
    await expect(page.locator(".board-nomatch .state-title")).toHaveText("No sessions match “zzzz-nothing”");
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.locator("section.group").first()).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search sessions" })).toHaveValue("");
  });

  test("a filter that finds nothing hands the words to Search, which reads every session", async ({ page }) => {
    await openBoard(page);
    await page.getByRole("searchbox", { name: "Search sessions" }).fill("zzzz nothing");
    await page.getByRole("button", { name: "Search every session for “zzzz nothing”" }).click();
    await expect(page).toHaveURL((u) => u.pathname === "/search" && u.searchParams.get("q") === "zzzz nothing");
  });

  test("keyboard: / focuses search, j/k move the cursor, Enter opens the session", async ({ page }) => {
    await openBoard(page);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("/");
    await expect(page.locator("input[data-search]")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("input[data-search]")).not.toBeFocused();
    await expect(page.locator("article.card[aria-current='true']")).toHaveCount(0);
    await page.keyboard.press("j");
    await expect(page.locator("article.card[aria-current='true']")).toHaveAttribute("data-cursor", "0");
    await page.keyboard.press("j");
    await expect(page.locator("article.card[aria-current='true']")).toHaveAttribute("data-cursor", "1");
    await page.keyboard.press("k");
    await expect(page.locator("article.card[aria-current='true']")).toHaveAttribute("data-cursor", "0");
    // `.` opens the row's own menu at the row; Esc closes it.
    await page.keyboard.press(".");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    const opened = await page.locator("article.card[aria-current='true'] a.card-link").getAttribute("href");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/s\/[^/]+\/.+/);
    await expect(page.locator("h1.sess-title")).toBeVisible();
    // Back puts the cursor on the row it was on (wherever the live list has put it since).
    await page.goBack();
    await expect(page.locator("article.card[aria-current='true'] a.card-link")).toHaveAttribute("href", opened!);
  });

  test("with Hidden open, e leaves the cursor in its place, so e again hides the next row", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("sessionpipe-gui.board.hiddenOpen", "1"));
    await openBoard(page);
    await page.locator("section.group--working article.card a.card-link").first().focus();
    // The cursor stays on the row that took the hidden one's place, not on the row in Hidden
    // (the live demo may still bring a row back above it, so this reads rows, not indexes).
    const cursor = page.locator("article.card[aria-current='true']");
    const link = cursor.locator("a.card-link");
    const section = cursor.locator("xpath=ancestor::section");
    const first = await link.getAttribute("href");
    await page.keyboard.press("e");
    await expect(link).not.toHaveAttribute("href", first!);
    await expect(section).not.toHaveClass(/group--hidden/);
    const second = await link.getAttribute("href");
    await page.keyboard.press("e");
    await expect(link).not.toHaveAttribute("href", second!);
    await expect(link).not.toHaveAttribute("href", first!);
    await expect(section).not.toHaveClass(/group--hidden/);
  });

  test("e and ⇧E leave the board alone while you work in the panel beside it", async ({ page }) => {
    await openBoard(page);
    await holdBoard(page);
    const card = page.locator("section.group--working article.card").first();
    const href = (await card.locator("a.card-link").getAttribute("href"))!;
    await page.locator(`article.card a.card-link[href="${href}"]`).click({ modifiers: ["Shift"] });
    const panel = page.locator("aside.panel");
    await expect(panel).toHaveClass(/panel--open/);
    // Working in the panel: focus on one of its controls, with the board's cursor still set.
    await panel.getByRole("button", { name: "Close panel" }).focus();
    expect(await page.evaluate(() => !!document.activeElement?.closest("aside.panel"))).toBe(true);
    await expect(page.locator("article.card[aria-current='true']")).toHaveCount(1);
    const hiddenStore = () => page.evaluate(() => JSON.parse(localStorage.getItem("sessionpipe-gui.hidden") ?? "{}"));
    await page.keyboard.press("e");
    await page.keyboard.press("Shift+E");
    expect(await hiddenStore()).toEqual({});
    await expect(page.locator('.toast[data-toast="undo"]')).toHaveCount(0);
    await expect(page.locator("section.group--hidden")).toHaveCount(0);
    // Back on the board (focus off the panel), the same key hides the row under the cursor.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    expect(await page.evaluate(() => !!document.activeElement?.closest("aside.panel"))).toBe(false);
    await page.keyboard.press("e");
    await expect.poll(async () => Object.keys(await hiddenStore()).length).toBe(1);
    await expect(page.locator('.toast[data-toast="undo"]')).toContainText("Hidden");
  });

  test("Esc clears the search first, then the cursor", async ({ page }) => {
    await openBoard(page);
    const search = page.getByRole("searchbox", { name: "Search sessions" });
    await search.fill("a");
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("j");
    await expect(page.locator("article.card[aria-current='true']")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(search).toHaveValue("");
    await expect(page.locator("article.card[aria-current='true']")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("article.card[aria-current='true']")).toHaveCount(0);
    // A third goes nowhere: the board is a place, not a step.
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("section.group").first()).toBeVisible();
  });

  test("the Hidden header has its own menu, as Done's does, not the board's", async ({ page }) => {
    await openBoard(page);
    await page.locator("section.group--working article.card a.card-link").first().focus();
    await page.keyboard.press("Shift+E");
    const toggle = page.locator("section.group--hidden button.group-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click({ button: "right" });
    const item = page.getByRole("menuitemcheckbox", { name: "Show hidden sessions" });
    await expect(item).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("menuitemcheckbox", { name: "Show done sessions" })).toHaveCount(0);
    await item.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  test("the right-click that opens a row's menu chooses nothing from it; a press held and dragged onto an item does", async ({
    page,
  }) => {
    await openBoard(page);
    await holdBoard(page);
    const title = page.locator("section.group--working article.card .card-title").first();
    const box = (await title.boundingBox())!;
    const at = { x: Math.round(box.x + 40), y: Math.round(box.y + 6) };
    // The page's clock in the test's hands: how long the button was held is what is tested.
    await page.evaluate(() => {
      const w = window as unknown as { heldAt: number };
      w.heldAt = Date.now();
      Date.now = () => w.heldAt;
    });
    // The press opens the menu under the pointer (as a Mac's right button does, before it
    // is let go).
    await title.evaluate((el, { x, y }) => {
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, at);
    const first = page.getByRole("menu").getByRole("menuitem").first();
    await expect(first).toHaveText(/^Open as page/);
    /** The right button let go over the menu's first item, the pointer at `x`, `y`. */
    const release = (x: number, y: number) =>
      first.dispatchEvent("mouseup", { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y });
    // Let go at once, the hand having drifted onto the item: a click, and the menu stays.
    await release(at.x + 9, at.y + 9);
    await expect(first).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    // Held, and let go where it was pressed: nothing either.
    await page.evaluate(() => {
      (window as unknown as { heldAt: number }).heldAt += 300;
    });
    await release(at.x + 1, at.y + 1);
    await expect(first).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    // Held and dragged onto the item: that is choosing it.
    await release(at.x + 9, at.y + 9);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page).toHaveURL(/\/s\//);
  });
});
