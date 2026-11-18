// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The command palette: ⌘K opens it on any page, a title fragment puts that session first
// and Enter opens it, shift+Enter opens it beside, `>` keeps only actions, `#<view>` jumps
// to an installed view, Esc closes it and gives focus back. Allow, Deny and "Send a message…"
// are rows only where they would be sent, and the cursor stays with its row.
import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { E2E_PORT } from "../../playwright.config.js";
import {
  ANTIGRAVITY_TURNS,
  ASK_TURN,
  BACKFILL_TITLES,
  BACKGROUND_TURNS,
  CLAUDE_TURNS,
  CODEX_ASKED_TURN,
  CODEX_TURNS,
  CURSOR_TURNS,
  GEMINI_TURNS,
  HANDOFF_PARENT_TURN,
  PARALLEL_TURN,
  RESUME_TURN,
  SCHEDULED_TURNS,
  SILENT_TURN,
  UNATTENDED_TURN,
} from "../../server/demo/content.js";
import {
  CONTROL_BASE,
  type FakeDaemon,
  fakeDaemon,
  passkeyPage,
  postPrompt,
  seenSetupHere,
  sinkToken,
} from "./control-helpers.js";
import { openBoard, openPage, openPrompt, sessionUrl } from "./helpers.js";

/** Every title a demo session can learn mid-run (the scripts', nested ones included) and
 *  the backfilled ones: a session not on the board yet may still be in the palette, so the
 *  word typed must pick out one title among all of them, not only the board's. */
const DEMO_TITLES: string[] = [
  ...BACKFILL_TITLES.map((t) => t.text),
  ...[
    ...JSON.stringify([
      CLAUDE_TURNS,
      CODEX_TURNS,
      GEMINI_TURNS,
      ANTIGRAVITY_TURNS,
      CURSOR_TURNS,
      BACKGROUND_TURNS,
      SCHEDULED_TURNS,
      RESUME_TURN,
      SILENT_TURN,
      PARALLEL_TURN,
      UNATTENDED_TURN,
      CODEX_ASKED_TURN,
      ASK_TURN,
      HANDOFF_PARENT_TURN,
    ]).matchAll(/"title":\{"text":"((?:[^"\\]|\\.)*)"/g),
  ].map((m) => JSON.parse(`"${m[1]}"`) as string),
];

/** The card shows a long title up to its first sentence or an ellipsis; the palette and the
 *  session page may show more, so a title is matched as the start. */
const startsWith = (t: string) => new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
const dialog = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const rows = (page: Page) => dialog(page).locator(".pal-row");

async function open(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("combobox")).toBeFocused();
}

/** A settled board card (idle or stale: past its first turn, so its title won't be replaced
 *  by a better one mid-test) whose title is a phrase with a word worth typing (3+ words, one of
 *  7+ letters, found in no other card's title: one session, not a repo, a machine or a near
 *  namesake), else the first card; its title, and that word. */
/** The palette's own entries (pages, views, actions): a session's word must not read as one. */
const PAGE_WORDS = [
  "board",
  "inbox",
  "search",
  "feed",
  "review",
  "machines",
  "connect",
  "setup",
  "workflow",
  "usage",
  "settings",
  "shortcut",
  "views",
  "display",
  "session",
  "canvas",
  "office",
];

async function firstCard(page: Page): Promise<{ title: string; href: string; fragment: string }> {
  const longest = (t: string) =>
    t
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
      .sort((a, b) => b.length - a.length)[0] ?? "";
  const settled = page.locator("section.group--idle, section.group--stale").locator("article.card a.card-link");
  // Every title on the board and every title the demo can give a session (DEMO_TITLES), so
  // the word typed picks out one session, not two.
  const all = [...(await page.locator("article.card .card-title").allTextContents()), ...DEMO_TITLES].map((t) =>
    t.toLowerCase(),
  );
  // A word that names a page or an action ("workflow" → Workflows) ranks that entry above
  // every session, so such a word never picks the card either.
  const unique = (t: string) => {
    const w = longest(t).toLowerCase();
    if (PAGE_WORDS.some((pw) => pw.includes(w) || w.includes(pw))) return false;
    return all.filter((x) => x.includes(w)).length === 1;
  };
  let link = page.locator("article.card a.card-link").first();
  for (let i = 0, n = await settled.count(); i < n; i++) {
    const t = ((await settled.nth(i).locator(".card-title").textContent()) ?? "").trim();
    if (t.split(/\s+/).length >= 3 && longest(t).length >= 7 && unique(t)) {
      link = settled.nth(i);
      break;
    }
  }
  const title = (await link.locator(".card-title").textContent())!.trim().replace(/…$/, "");
  const href = (await link.getAttribute("href"))!;
  return { title, href, fragment: longest(title) };
}

test.describe("command palette", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop project only");

  test("⌘K opens it; a title fragment puts the session first; Enter opens it", async ({ page }) => {
    await openBoard(page);
    const { title, href, fragment } = await firstCard(page);
    await open(page);
    // The board's own search is a plain toolbar field; the palette is ⌘K (and in the rail's menu).
    await expect(page.locator("[data-search]")).toHaveAttribute("placeholder", "Search");
    await expect(dialog(page).locator(".pal-section").first()).toHaveText("Sessions");
    await page.keyboard.type(fragment);
    const first = rows(page).first();
    await expect(first).toHaveAttribute("data-section", "Sessions");
    await expect(first.locator(".pal-label")).toHaveText(startsWith(title));
    // The matched letters are marked (in the ink at 600), not blocked.
    await expect(first.locator("u").first()).toBeVisible();
    await expect(first).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeHidden();
    await expect(page).toHaveURL((u) => u.pathname === href.split("?")[0]);
    await expect(page.locator("h1.sess-title")).toHaveText(startsWith(title));
  });

  test("shift+Enter opens the session beside the page", async ({ page }) => {
    await openBoard(page);
    const { title, href, fragment } = await firstCard(page);
    await open(page);
    await page.keyboard.type(fragment);
    await expect(rows(page).first().locator(".pal-label")).toHaveText(startsWith(title));
    await page.keyboard.press("Shift+Enter");
    await expect(dialog(page)).toBeHidden();
    const panel = page.locator("aside.panel");
    await expect(panel).toHaveClass(/panel--open/);
    // By its key, not its words: a demo session may learn a better title mid-turn.
    const key = href
      .split("?")[0]!
      .replace(/^\/s\//, "")
      .split("/")
      .slice(0, 2)
      .map(decodeURIComponent)
      .join(":");
    await expect.poll(() => decodeURIComponent(new URL(page.url()).searchParams.get("s") ?? "")).toBe(key);
    await expect(panel.locator(".panel-title")).not.toHaveText("");
    // Inside the split, ⌘K still works.
    await open(page);
    await expect(dialog(page).locator(".pal-section", { hasText: "Actions" })).toBeVisible();
  });

  test("`>` lists only actions; arrows move the cursor", async ({ page }) => {
    await openBoard(page);
    await open(page);
    await page.keyboard.type(">");
    const sections = dialog(page).locator(".pal-section");
    await expect(sections).toHaveText(["Actions"]);
    await expect(rows(page).first()).toHaveAttribute("data-section", "Actions");
    // This page cannot sign (it is at 127.0.0.1, the rp id is localhost): no message would
    // go, so none is offered.
    await expect(rows(page).filter({ hasText: "Send a message…" })).toHaveCount(0);
    await expect(rows(page).filter({ hasText: "Open beside" }).first()).toBeVisible();
    await expect(rows(page).filter({ hasText: "Open as page" }).first()).toBeVisible();
    await expect(rows(page).filter({ hasText: "Forget…" }).first()).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowUp");
    await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true");
    // `#` keeps only the places.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("#");
    await expect(sections).toHaveText(["Go to"]);
    await expect(rows(page).filter({ hasText: "Board" })).toBeVisible();
    await expect(rows(page).filter({ hasText: "Display settings" })).toBeVisible();
  });

  test("`#<view>` jumps to an installed view", async ({ page, request }) => {
    const { themes } = (await (await request.get("/api/ui/themes")).json()) as {
      themes: { id: string; name: string; error?: string }[];
    };
    const view = themes.find((t) => t.id === "canvas" && !t.error) ?? themes.find((t) => !t.error);
    test.skip(!view, "no view installed");
    await openPage(page, "/feed");
    await open(page);
    await page.keyboard.type(`#${view!.name}`);
    await expect(rows(page).first().locator(".pal-label")).toHaveText(view!.name);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/t/${view!.id}$`));
    // And from inside the view, ⌘K opens it again.
    await open(page);
    await page.keyboard.type("#feed");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/feed$/);
  });

  test("Esc closes it and focus goes back where it was", async ({ page }) => {
    await openBoard(page);
    const search = page.locator("[data-search]");
    await search.focus();
    await expect(search).toBeFocused();
    await open(page);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toBeHidden();
    await expect(search).toBeFocused();
    // Reopened and dismissed through the scrim, the same.
    await open(page);
    await page.locator(".pal-scrim").click({ position: { x: 10, y: 10 } });
    await expect(dialog(page)).toBeHidden();
  });
});

// Allow, Deny and "Send a message…" are rows only where they would be sent: the palette reads
// the gate the Inbox, the toasts and a row's menu read (control/useSend.ts answerState). The
// paired machine is on the test-door instance (control-helpers.ts), where a virtual
// authenticator signs and a fake daemon takes the answer.
test.describe("command palette: an answer only where it would be sent", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop project only");
  // These raise prompts on the one test-door instance, where every page gets a toast for
  // each, three at most: they take turns, so none pushes another's toast out.
  test.describe.configure({ mode: "default" });

  const tag = () => randomUUID().slice(0, 6);
  /** "Allow Bash in <title>" and "Deny Bash in <title>". */
  const answers = (page: Page, title: string) =>
    dialog(page).getByRole("option", { name: new RegExp(`^(Allow|Deny) .* in ${title}`) });
  const allow = (page: Page, title: string) =>
    dialog(page).getByRole("option", { name: new RegExp(`^Allow .* in ${title}`) });
  const session = (page: Page, title: string) =>
    dialog(page).locator(".pal-row[data-section='Sessions']").filter({ hasText: title });
  const selected = (page: Page) => dialog(page).locator(".pal-row[aria-selected='true']");
  /** The keys take the cursor down to `row`. */
  async function cursorTo(page: Page, row: ReturnType<typeof allow>) {
    const i = Number(await row.getAttribute("data-i"));
    for (let n = 0; n < i; n++) await page.keyboard.press("ArrowDown");
    await expect(row).toHaveAttribute("aria-selected", "true");
  }
  /** A page with a passkey a fresh machine trusts, and that machine's daemon. */
  async function paired(page: Page): Promise<{ d: FakeDaemon; bearer: string }> {
    await seenSetupHere(page.context());
    const key = await passkeyPage(page.context(), page);
    const d = await fakeDaemon(key, { name: `gate-${tag()}`, harnesses: ["claude-code"] });
    return { d, bearer: await sinkToken() };
  }
  const sent = (d: FakeDaemon) => d.seen.filter((c) => c.kind === "permission.answer").map((c) => c.for);

  test("a prompt on a machine that is not paired has no Allow, Deny or message row; its session opens on why", async ({
    page,
    request,
  }) => {
    const title = `Gate unpaired ${tag()}`;
    const s = await openPrompt(request, { machine: "e2e-box", title });
    try {
      // Under the rp id (localhost), where this page can sign: all that is missing is the pairing.
      await page.goto(`http://localhost:${E2E_PORT}/`);
      await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
      // The page has the prompt: its session is in Needs you.
      await expect(page.locator(`section.group--needs_you article.card[data-flip="${s.key}"]`)).toBeVisible();
      await open(page);
      await expect(dialog(page).locator(".pal-section").first()).toHaveText("Sessions");
      await expect(answers(page, title)).toHaveCount(0);
      // Typed, the session is found under Sessions, and still nothing answers for it.
      await page.keyboard.type(title);
      await expect(rows(page).first()).toHaveAttribute("data-section", "Sessions");
      await expect(session(page, title)).toHaveAttribute("aria-selected", "true");
      await expect(answers(page, title)).toHaveCount(0);
      // Its actions: no message that would only be refused.
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type(`>${title}`);
      const actions = rows(page).filter({ hasText: title });
      await expect(actions.filter({ hasText: "Open as page" })).toBeVisible();
      await expect(actions.filter({ hasText: "Send a message…" })).toHaveCount(0);
      // Enter on the session opens its page, whose composer says the one reason.
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type(title);
      await expect(session(page, title)).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL((u) => u.pathname === sessionUrl(s.harness, s.sessionId));
      await expect(page.locator('[data-reason="unpaired"]')).toContainText(
        "Pair e2e-box to message this session from here.",
      );
    } finally {
      await s.clear();
    }
  });

  test("a paired machine's prompt lists Allow and Deny, and Enter sends the answer; one past its two minutes lists neither", async ({
    page,
  }) => {
    const { d, bearer } = await paired(page);
    const t = tag();
    const fresh = await postPrompt(bearer, { machine: d.name, title: `Fresh ask ${t}`, agoMs: 5_000 });
    const late = await postPrompt(bearer, { machine: d.name, title: `Late ask ${t}`, agoMs: 130_000 });
    try {
      await page.goto(`${CONTROL_BASE}/`);
      await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
      await expect(page.locator(`article.card[data-flip="${late.key}"]`)).toBeVisible();
      await open(page);
      await expect(answers(page, `Fresh ask ${t}`)).toHaveText([/^Allow Bash in Fresh ask/, /^Deny Bash in Fresh ask/]);
      await expect(answers(page, `Late ask ${t}`)).toHaveCount(0);
      await page.keyboard.type(`ask ${t}`);
      await expect(answers(page, `Fresh ask ${t}`)).toHaveCount(2);
      await expect(answers(page, `Late ask ${t}`)).toHaveCount(0);
      // The late one keeps its row under Sessions.
      await expect(session(page, `Late ask ${t}`)).toBeVisible();
      // A message can go to this machine, so the row is there.
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type(`>Fresh ask ${t}`);
      await expect(
        rows(page)
          .filter({ hasText: `Fresh ask ${t}` })
          .filter({ hasText: "Send a message…" }),
      ).toBeVisible();
      // Enter on Allow signs and sends it, for this prompt.
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type(`Fresh ask ${t}`);
      await cursorTo(page, allow(page, `Fresh ask ${t}`));
      await page.keyboard.press("Enter");
      await expect(dialog(page)).toBeHidden();
      await expect.poll(() => sent(d)).toEqual([fresh.attention]);
      // With its answer out, the prompt has no row any more.
      await open(page);
      await page.keyboard.type(`ask ${t}`);
      await expect(session(page, `Fresh ask ${t}`)).toBeVisible();
      await expect(answers(page, `Fresh ask ${t}`)).toHaveCount(0);
    } finally {
      await fresh.clear();
      await late.clear();
      await d.stop();
    }
  });

  test("with the cursor on an Allow row, answering that prompt from a toast moves the cursor to its session's row", async ({
    page,
  }) => {
    const { d, bearer } = await paired(page);
    const t = tag();
    const both = dialog(page).getByRole("option", { name: new RegExp(`^(Allow|Deny) .* in \\w+ toast ${t}`) });
    const posted: { clear: () => Promise<void> }[] = [];
    try {
      // The toasts are for prompts that come while the page is open.
      await page.goto(`${CONTROL_BASE}/feed`);
      await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
      posted.push(await postPrompt(bearer, { machine: d.name, title: `Two toast ${t}`, agoMs: 30_000 }));
      await open(page);
      // One comes last: its toast is the newest of the stack (which keeps three), and its
      // session the newest, so its pair leads the list.
      const one = await postPrompt(bearer, { machine: d.name, title: `One toast ${t}`, agoMs: 5_000 });
      posted.push(one);
      const card = page.locator(`.toast[data-attention="${one.attention}"]`);
      await expect(card.getByRole("button", { name: "Allow" })).toBeEnabled();
      await page.keyboard.type(`toast ${t}`);
      await expect(both).toHaveText([
        /^Allow Bash in One/,
        /^Deny Bash in One/,
        /^Allow Bash in Two/,
        /^Deny Bash in Two/,
      ]);
      await expect(allow(page, `One toast ${t}`)).toHaveAttribute("aria-selected", "true");
      // Answered from its toast: its pair leaves the list. The cursor does not slide onto
      // the row that takes its place, the other prompt's Allow: it is on One's session.
      await card.getByRole("button", { name: "Allow" }).click();
      await expect(both).toHaveText([/^Allow Bash in Two/, /^Deny Bash in Two/]);
      await expect(selected(page)).toHaveCount(1);
      await expect(selected(page)).toHaveAttribute("data-section", "Sessions");
      await expect(selected(page)).toContainText(`One toast ${t}`);
      // An Enter that was on its way opens the session. Nothing was answered for Two.
      await dialog(page).getByRole("combobox").focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL((u) => u.pathname === sessionUrl("claude-code", one.id));
      await expect.poll(() => sent(d)).toEqual([one.attention]);
    } finally {
      for (const p of posted) await p.clear();
      await d.stop();
    }
  });

  test("a prompt that runs out of its two minutes under the cursor leaves, and the cursor goes to its session", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const { d, bearer } = await paired(page);
    const t = tag();
    const both = dialog(page).getByRole("option", { name: new RegExp(`^(Allow|Deny) .* in \\w+ ask ${t}`) });
    // Eight seconds of its window are left when it is posted. The other is Codex's, which
    // waits as long as it takes, in an older session: its pair comes second.
    const aging = await postPrompt(bearer, { machine: d.name, title: `Aging ask ${t}`, agoMs: 112_000 });
    const other = await postPrompt(bearer, {
      machine: d.name,
      title: `Other ask ${t}`,
      agoMs: 300_000,
      harness: "codex",
    });
    try {
      await page.goto(`${CONTROL_BASE}/`);
      await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
      await open(page);
      await page.keyboard.type(`ask ${t}`);
      await expect(both).toHaveText([
        /^Allow Bash in Aging/,
        /^Deny Bash in Aging/,
        /^Allow Bash in Other/,
        /^Deny Bash in Other/,
      ]);
      // The keys put the cursor on Deny; the row that would take its place is the other Deny.
      await page.keyboard.press("ArrowDown");
      await expect(both.nth(1)).toHaveAttribute("aria-selected", "true");
      await expect(both).toHaveText([/^Allow Bash in Other/, /^Deny Bash in Other/], { timeout: 20_000 });
      await expect(selected(page)).toHaveCount(1);
      await expect(selected(page)).toHaveAttribute("data-section", "Sessions");
      await expect(selected(page)).toContainText(`Aging ask ${t}`);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL((u) => u.pathname === sessionUrl("claude-code", aging.id));
      expect(sent(d)).toEqual([]);
    } finally {
      await aging.clear();
      await other.clear();
      await d.stop();
    }
  });
});
