// SPDX-License-Identifier: Apache-2.0
// Lineage on the demo server (server/demo/sim.ts): a Claude Code session on lab-mac asks
// Codex from inside its turn (sessionpipe ask) and another gets a handoff's answer back.
// The asking session's page shows the row; the asked session's page says who asked, with
// a link back; the board nests it under its parent; Machines says lab-mac's agents can
// ask each other; the Feed words the two events. An asked session that needs you takes
// its working parent's row into Needs you, marked under it, and the count is the Inbox
// badge's (a subagent's own session too, its agent row marked even in a folded tree); a
// parent set to Never quiets the session it asked. A child's row on the board names the
// computer it runs on, and the Inbox row of its prompt names the session it works for.
// Desktop only (a finger's: mobile.spec).
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { askedPair, kidBoxes, openBoard, openPage } from "./helpers.js";

test.skip(({ isMobile }) => isMobile, "desktop project");

interface Snap {
  sessions: {
    key: string;
    harness: string;
    id: string;
    title?: string;
    delegatedBy?: string;
    machine?: string;
    delegations?: { via: string; harness: string; to?: string; endedAt?: string; relayed?: string }[];
  }[];
}
const snap = async (page: Page): Promise<Snap> => (await (await page.request.get("/api/ui/snapshot")).json()) as Snap;

/** The demo's asking session (its delegation has reached the receiver) and the asked one. */
async function lineage(page: Page) {
  await expect
    .poll(
      async () => (await snap(page)).sessions.some((s) => (s.delegations?.length ?? 0) > 0 && s.delegations![0]!.to),
      {
        timeout: 60_000,
      },
    )
    .toBe(true);
  const all = (await snap(page)).sessions;
  const asker = all.find((s) => (s.delegations?.length ?? 0) > 0 && s.delegations![0]!.to)!;
  const child = all.find((s) => s.key === asker.delegations![0]!.to);
  return { asker, child };
}

test("the asking session shows the row; the asked session says who asked", async ({ page }) => {
  await openPage(page, "/");
  const { asker, child } = await lineage(page);
  await openPage(page, `/s/${asker.harness}/${asker.id}`);
  const row = page.locator(".ask").first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(/asked Codex/i);
  // An asked session the store holds says its state in the board's word, as the list does.
  await expect(row.locator(".ask-state")).toHaveText(/running|working|needs you|answered|failed/);
  // The row links to the asked session, whose bar says whom it works for.
  if (child) {
    await expect(page.locator(`.ask a[href*="${child.id}"]`).first()).toBeVisible();
    await openPage(page, `/s/${child.harness}/${child.id}`);
    await expect(page.locator(".sess-for")).toContainText("for ");
    await expect(page.locator(`.sess-for a[href*="${asker.id}"]`)).toBeVisible();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Open the asking session" })).toBeVisible();
    await page.keyboard.press("Escape");
  }
});

test("the asking session lists the sessions it asked under its bar; one that asked none has no list", async ({
  page,
}) => {
  await openPage(page, "/");
  const { asker, child } = await lineage(page);
  test.skip(!child, "the asked session is not in the snapshot yet");
  await openPage(page, `/s/${asker.harness}/${asker.id}`);
  const row = page.locator(`section.kids li.kids-row[data-kid="${child!.key}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator(".kids-word")).toHaveText(/needs you|working|stale|idle|done/);
  await expect(row.locator(".kids-agent")).toHaveText("Codex");
  // The computer is named, though it is the asking session's own.
  await expect(row.locator(".kids-where")).toHaveText(child!.machine!);
  // Open: the row goes to the asked session, which asked nobody itself.
  await row.locator("a.kids-link").click();
  await expect(page).toHaveURL(new RegExp(`/s/codex/${child!.id}`));
  await expect(page.locator(".sess-for")).toBeVisible();
  await expect(page.locator("section.kids")).toHaveCount(0);
});

test("the board nests the asked session under its parent", async ({ page }) => {
  await openPage(page, "/");
  const { asker, child } = await lineage(page);
  test.skip(!child, "the asked session is not on the board yet");
  await openBoard(page);
  const card = page.locator(`article.card[data-flip="${asker.key}"]`);
  if ((await card.count()) === 0) test.skip(true, "the asking session is folded away on the board");
  await expect(card.locator("ul.card-kids li", { hasText: child!.title ?? "" }).first()).toBeVisible();
});

test("Machines: lab-mac's agents can ask each other; the Feed words the events", async ({ page }) => {
  await openPage(page, "/machines");
  const lab = page.locator("section.machine[aria-label='lab-mac']");
  await expect(lab.locator(".machine-caution", { hasText: "Agents here can ask each other" })).toBeVisible();
  await openPage(page, "/feed");
  const ev = page.locator('li.ev[data-type="delegation.started"]').first();
  await expect(ev).toBeVisible({ timeout: 30_000 });
  // The kind column says who was asked; the detail column says how the ask is going.
  await expect(ev).toContainText(/asked Codex/i);
  await expect(ev).toContainText(/running/);
});

test.describe("an asked session that needs you", () => {
  test("lifts its working parent into Needs you, marked under it, counted as the Inbox badge counts, until its prompt clears", async ({
    page,
    request,
  }) => {
    const pair = await askedPair(request, { machine: `tree-${randomUUID().slice(0, 6)}`, title: "Plan the migration" });
    const needsYou = page.locator("section.group--needs_you");
    const working = page.locator("section.group--working");
    const parent = (in_: typeof needsYou) => in_.locator(`article.card[data-flip="${pair.parent.key}"]`);
    try {
      await openBoard(page);
      await page.addStyleTag({ content: ".toasts { display: none !important; }" });
      await page.mouse.move(0, 0);
      await expect(parent(working)).toBeVisible({ timeout: 15_000 });
      await expect(parent(working).locator(".kid", { hasText: pair.child.title })).toBeVisible();
      await expect(parent(working).locator(".kid[data-needs]")).toHaveCount(0);

      await pair.raise();
      await expect(parent(needsYou)).toBeVisible({ timeout: 15_000 });
      // The row keeps its own state; the child under it is the one marked.
      await expect(parent(needsYou)).toHaveClass(/card--working/);
      const kid = parent(needsYou).locator(".kid[data-needs]");
      await expect(kid).toHaveCount(1);
      await expect(kid).toContainText(pair.child.title);
      await expect(kid.locator(".kid-state")).toHaveText("needs you");
      // Nothing new to press on it: no Allow or Deny on the row.
      await expect(parent(needsYou).getByRole("button", { name: /^(Allow|Deny)$/ })).toHaveCount(0);
      // Needs you's count is the badge's (other specs raise prompts meanwhile: read at once).
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const num = (sel: string) => Number(document.querySelector(sel)?.textContent ?? 0);
              const badge = num("nav.rail a[data-nav='inbox'] .nav-badge");
              const heading = num("section.group--needs_you .group-count");
              return badge > 0 && badge === heading ? "agree" : JSON.stringify({ badge, heading });
            }),
          { timeout: 15_000 },
        )
        .toBe("agree");

      // The prompt clears: the parent goes back to Working once the pointer is off the list.
      await pair.clear();
      await page.mouse.move(0, 0);
      await expect(parent(working)).toBeVisible({ timeout: 15_000 });
      await expect(parent(needsYou)).toHaveCount(0);
      await expect(parent(working).locator(".kid[data-needs]")).toHaveCount(0);
    } finally {
      await pair.end();
    }
  });

  test("a subagent's own session does the same: its agent row is marked, shown though the person folded the tree", async ({
    page,
    request,
  }) => {
    const pair = await askedPair(request, {
      machine: `tree-${randomUUID().slice(0, 6)}`,
      title: "Tidy the docs",
      subagent: true,
    });
    const row = page.locator(`article.card[data-flip="${pair.parent.key}"]`);
    const inNeeds = page.locator(`section.group--needs_you article.card[data-flip="${pair.parent.key}"]`);
    // The person folded its agents on this device (lib/agents.ts).
    await page.addInitScript(
      (key) => localStorage.setItem("sessionpipe-gui.agentsOpen", JSON.stringify([[key, false]])),
      pair.parent.key,
    );
    try {
      await openBoard(page);
      await page.addStyleTag({ content: ".toasts { display: none !important; }" });
      await page.mouse.move(0, 0);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row.locator(".card-disclose")).toHaveAttribute("aria-expanded", "false");
      await expect(row.locator(".agent-row")).toHaveCount(0);

      await pair.raise();
      await expect(inNeeds).toBeVisible({ timeout: 15_000 });
      await expect(row).not.toHaveClass(/card--needs_you/);
      // The reason shows, folded or not: that one agent, saying "needs you", not its time.
      await expect(row.locator(".card-disclose")).toHaveAttribute("aria-expanded", "false");
      const agent = row.locator(".agent-row");
      await expect(agent).toHaveCount(1);
      await expect(agent).toHaveAttribute("data-needs", "");
      await expect(agent.locator(".kid-state")).toHaveText("needs you");
      await expect(agent.locator(".agent-now")).toHaveCount(0);

      await pair.clear();
      await page.mouse.move(0, 0);
      await expect(inNeeds).toHaveCount(0, { timeout: 15_000 });
      await expect(row.locator(".agent-row")).toHaveCount(0);
    } finally {
      await pair.end();
    }
  });

  test("raises no banner when its parent is set to Never; the same ask under a parent left alone does", async ({
    page,
    request,
  }) => {
    const quiet = await askedPair(request, { machine: `tree-${randomUUID().slice(0, 6)}`, title: "Quiet parent" });
    const loud = await askedPair(request, { machine: `tree-${randomUUID().slice(0, 6)}`, title: "Loud parent" });
    const marks = (level: "never" | null) =>
      request.patch("/api/ui/marks", { data: { notify: { [quiet.parent.key]: level } } });
    // Every banner that ever shows, by its session: the demo's own prompts share the three
    // slots and may push one out before it is looked at.
    await page.addInitScript(() => {
      const seen = new Set<string>();
      (window as unknown as { __banners: Set<string> }).__banners = seen;
      new MutationObserver(() => {
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(".toast[data-session]")))
          seen.add(el.dataset.session!);
      }).observe(document, { childList: true, subtree: true });
    });
    const banners = () => page.evaluate(() => [...(window as unknown as { __banners: Set<string> }).__banners]);
    try {
      expect((await marks("never")).ok()).toBeTruthy();
      await openPage(page, "/feed");
      await page.mouse.move(0, 0);
      await quiet.raise();
      await loud.raise();
      // The loud one's banner comes, after the quiet one's prompt was raised: by then the
      // quiet one's would have come too.
      await expect.poll(banners, { timeout: 15_000 }).toContain(loud.child.key);
      await page.waitForTimeout(1_000);
      expect(await banners()).not.toContain(quiet.child.key);
    } finally {
      await marks(null);
      await quiet.end();
      await loud.end();
    }
  });
});

test("a nested child's row names its computer at the row's end; its prompt's Inbox row says whom it works for, a session of its own's says nothing", async ({
  page,
  request,
}) => {
  const machine = `tree-${randomUUID().slice(0, 6)}`;
  const pair = await askedPair(request, { machine, title: "Plan the migration" });
  try {
    await openBoard(page);
    await page.addStyleTag({ content: ".toasts { display: none !important; }" });
    await page.mouse.move(0, 0);
    const kid = page.locator(`article.card[data-flip="${pair.parent.key}"] .kid`, { hasText: pair.child.title });
    await expect(kid).toBeVisible({ timeout: 15_000 });
    // Named, though it is its parent's own computer; the whole name is its tooltip.
    const where = kid.locator(".kid-where");
    await expect(where).toHaveText(machine);
    await expect(where).toHaveAttribute("title", machine);
    // With a mouse at 1440 the row stays one line: the computer after the title, level with it.
    // Read in one frame: other sessions moving between sections slide this card.
    const { row, title, chip } = await kidBoxes(kid);
    expect(Math.abs(title.y + title.height / 2 - (chip.y + chip.height / 2))).toBeLessThan(3);
    expect(chip.x).toBeGreaterThan(title.x);
    expect(row.height).toBeLessThan(40);

    await pair.raise();
    await pair.raise("parent");
    await openPage(page, "/inbox");
    const child = page.locator(`li.inbox-row[data-session="${pair.child.key}"]`);
    await expect(child.locator(".inbox-for")).toHaveText(`for ${pair.parent.title}`, { timeout: 15_000 });
    await expect(child.locator(".inbox-machine")).toHaveText(machine);
    const own = page.locator(`li.inbox-row[data-session="${pair.parent.key}"]`);
    await expect(own).toBeVisible();
    await expect(own.locator(".inbox-for")).toHaveCount(0);
    // Its box ends inside the row, at or left of the time's end.
    const ends = () =>
      child.evaluate((li) => {
        const end = (sel: string) => li.querySelector(sel)!.getBoundingClientRect().right;
        return { for: end(".inbox-for"), main: end(".inbox-main"), age: end(".inbox-age") };
      });
    let e = await ends();
    expect(e.for).toBeLessThanOrEqual(Math.min(e.main, e.age) + 0.5);
    // On a narrow window too it is whole where it fits, and nothing drawn runs past its box.
    await page.setViewportSize({ width: 760, height: 800 });
    const forLine = child.locator(".inbox-for .midcut-text");
    await expect(forLine).toHaveText(`for ${pair.parent.title}`);
    expect(await forLine.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    e = await ends();
    expect(e.for).toBeLessThanOrEqual(Math.min(e.main, e.age) + 0.5);
    // A long parent's, cut at its end after a whole word, keeps the time's 12px gap before
    // the time's box.
    const long = await askedPair(request, {
      machine: "lab-mac",
      title: "Find every page the move to the new docs site broke and fix the links that point to them again",
    });
    try {
      await long.raise();
      const row = page.locator(`li.inbox-row[data-session="${long.child.key}"]`);
      await expect(row.locator(".inbox-for .midcut-text")).toContainText("…", { timeout: 15_000 });
      const gap = await row.evaluate(
        (li) =>
          li.querySelector(".inbox-age")!.getBoundingClientRect().left -
          li.querySelector(".inbox-for")!.getBoundingClientRect().right,
      );
      expect(gap).toBeGreaterThanOrEqual(11.5);
    } finally {
      await long.end();
    }
  } finally {
    await pair.end();
  }
});
