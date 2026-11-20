// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The command palette: ⌘K opens it on any page, a title fragment puts that session first
// and Enter opens it, shift+Enter opens it beside, `>` keeps only actions, `#<view>` jumps
// to an installed view, Esc closes it and gives focus back. Allow, Deny and "Send a message…"
// are rows only where they would be sent, and the cursor stays with its row. A row's bold
// letters are in the text it draws, and the preview says what a session waits on.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
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
  HANDOFF,
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
import { EVENTS, INFO, openBoard, openPage, openPrompt, sessionUrl, tier1Batch } from "./helpers.js";

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
      HANDOFF,
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
    // The board's own field filters its rows; the palette is ⌘K (and in the rail's menu).
    await expect(page.locator("[data-search]")).toHaveAttribute("placeholder", "Filter");
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

  /** A settled session on e2e-box in e2e/fixture, or where `session` says. It stays on the
   *  board, so its title must be one `firstCard` never picks: its longest word is under 7
   *  letters, or other titles hold it too ("webhook"). */
  async function postSession(request: APIRequestContext, title: string, session: Record<string, string>) {
    const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
    const batch = tier1Batch({ title });
    for (const e of batch.events) Object.assign(e.session as object, session);
    const res = await request.post(EVENTS, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sinkToken}`,
        "sessionpipe-protocol": "1",
      },
      data: { events: batch.events },
    });
    expect(res.status()).toBe(202);
  }
  const row = (page: Page, title: string) => rows(page).filter({ hasText: title });

  test("the bold letters are in the title that holds the word; a word only the branch or the model holds brings that in, bold", async ({
    page,
    request,
  }) => {
    const t = randomUUID().slice(0, 6);
    // A branch that has "webhook" nearer its start than any title does.
    const inTitle = `Notes on the webhook retry ${t}`;
    const inBranch = `Tidy the retry queue ${t}`;
    await postSession(request, inTitle, { branch: "demo/webhook-backoff", model: "claude-fable-5-1" });
    await postSession(request, inBranch, { branch: "demo/webhook-backoff", model: "claude-opus-5-5" });
    await openBoard(page);
    await open(page);
    await page.keyboard.type(`webhook ${t}`);
    // The title holds the word: it is bold there, and the row stays "machine · repo".
    await expect(row(page, inTitle).locator(".pal-label u")).toHaveText(["webhook", t]);
    await expect(row(page, inTitle).locator(".pal-detail")).toHaveText("e2e-box · e2e/fixture");
    // Only the branch holds it: the branch follows the repo, the word bold in it.
    await expect(row(page, inBranch).locator(".pal-label u")).toHaveText([t]);
    await expect(row(page, inBranch).locator(".pal-detail")).toHaveText("e2e-box · e2e/fixture · demo/webhook-backoff");
    await expect(row(page, inBranch).locator(".pal-detail u")).toHaveText(["webhook"]);
    // A model, as the app writes it and as it is named.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(`fable ${t}`);
    await expect(row(page, inTitle).locator(".pal-detail")).toHaveText("e2e-box · e2e/fixture · fable 5.1");
    await expect(row(page, inTitle).locator(".pal-detail u")).toHaveText(["fable"]);
    await expect(row(page, inBranch)).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(`claude-opus ${t}`);
    await expect(row(page, inBranch).locator(".pal-detail")).toHaveText("e2e-box · e2e/fixture · claude-opus-5-5");
    await expect(row(page, inBranch).locator(".pal-detail u")).toHaveText(["claude-opus"]);
    await expect(row(page, inTitle)).toHaveCount(0);
    // Words on both forms of it: the model is there once, by its name, which holds both.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(`claude fable ${t}`);
    await expect(row(page, inTitle).locator(".pal-detail")).toHaveText("e2e-box · e2e/fixture · claude-fable-5-1");
    await expect(row(page, inTitle).locator(".pal-detail u")).toHaveText(["claude", "fable"]);
    // Any session listed with the word in its title shows it there.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("webhook");
    await expect(rows(page).first()).toHaveAttribute("data-section", "Sessions");
    await expect
      .poll(() =>
        dialog(page)
          .locator(".pal-row[data-section='Sessions']:not([data-kid]) .pal-label")
          .evaluateAll((labels) =>
            labels
              .filter((l) => /webhook/i.test(l.textContent ?? ""))
              .filter((l) => !Array.from(l.querySelectorAll("u")).some((u) => /^webhook$/i.test(u.textContent ?? "")))
              .map((l) => l.textContent),
          ),
      )
      .toEqual([]);
  });

  test("a row found by its branch keeps room for its title: the repo gives way first, whole, and nothing reaches the age", async ({
    page,
    request,
  }) => {
    const t = randomUUID().slice(0, 6);
    // Names as long as real ones: a machine, a repo and a branch that do not fit beside a title.
    const names = {
      machine: "e2e-box-with-a-long-name",
      repo: "github.com/e2e-corp/payments-service-fixture",
      branch: "feature/webhook-retry-backoff",
    };
    const long = `Tidy the retry queue ahead of the Friday demo ${t}`;
    const short = `Fix ${t}`;
    // Titles between the two, so that some row has only a little room left for its repo.
    const middle = [`Fix the queue ${t}`, `Fix the queues ${t}`, `Fix the old queue ${t}`, `Tidy the retry queue ${t}`];
    for (const title of [long, short, ...middle]) await postSession(request, title, names);
    /** A row's widths: its title, its row, each part of its detail (cut or whole), and how far
     *  the detail's ink stops short of the age. The repo is the width it is drawn at: 0 where
     *  it has wrapped out of its one line. */
    const measure = (title: string) =>
      row(page, title).evaluate((el) => {
        const box = (sel: string) => el.querySelector(sel)!.getBoundingClientRect();
        const cut = (sel: string) => {
          const e = el.querySelector(sel)!;
          return e.scrollWidth > e.clientWidth;
        };
        const tail = box(".pal-tail");
        const drawn = (e: Element) => e.getBoundingClientRect().top < tail.bottom - 0.5;
        const repo = el.querySelector(".pal-tail > .pal-repo")!;
        const parts = Array.from(el.querySelectorAll(".pal-machine, .pal-repo"))
          .filter(drawn)
          .map((e) => e.getBoundingClientRect());
        const why = box(".pal-why");
        const bold = box(".pal-why u");
        return {
          title: box(".pal-label").width,
          main: box(".pal-main").width,
          titleCut: cut(".pal-label"),
          machineCut: cut(".pal-machine"),
          repo: drawn(repo) ? repo.getBoundingClientRect().width : 0,
          // " · " and two letters and its "…".
          repoLeast: Number.parseFloat(getComputedStyle(repo).fontSize) * 3.5,
          // Each part starts where the one before it ends: no hole where a repo was.
          holes: parts.slice(1).some((r, i) => Math.abs(r.left - parts[i]!.right) > 0.5),
          whyCut: cut(".pal-why"),
          boldShown: bold.left >= why.left && bold.right <= why.right + 0.5,
          toAge: box(".pal-age").left - Math.max(...parts.map((r) => r.right)),
        };
      });
    await openBoard(page);
    await open(page);
    // The match is past the branch's first 20 letters: the branch starts later, at a word.
    await page.keyboard.type(`backoff ${t}`);
    await expect(row(page, long).locator(".pal-detail")).toHaveText(
      "e2e-box-with-a-long-name · e2e-corp/payments-service-fixture · …retry-backoff",
    );
    await expect(row(page, long).locator(".pal-why u")).toHaveText(["backoff"]);
    // A long title: it has 40% of the row or more, the machine and the branch are whole, and
    // the repo is the part that is gone.
    let m = await measure(long);
    expect(m.title).toBeGreaterThan(m.main * 0.38);
    expect(m).toMatchObject({
      titleCut: true,
      machineCut: false,
      repo: 0,
      whyCut: false,
      boldShown: true,
      holes: false,
    });
    expect(m.toAge).toBeGreaterThan(0);
    // A short title is whole, and the repo has the room it leaves.
    m = await measure(short);
    expect(m).toMatchObject({ titleCut: false, machineCut: false, whyCut: false, boldShown: true, holes: false });
    expect(m.repo).toBeGreaterThan(m.repoLeast);
    expect(m.toAge).toBeGreaterThan(0);
    // In a half-screen window, and in this one, every row's repo is gone whole or shows a few
    // of its letters: never a stray " · …".
    for (const size of [
      { width: 1100, height: 800 },
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(size);
      for (const title of [long, short, ...middle]) {
        m = await measure(title);
        expect(m.repo === 0 || m.repo >= m.repoLeast, `${title} at ${size.width}: repo ${m.repo}`).toBe(true);
        expect(m, `${title} at ${size.width}`).toMatchObject({ machineCut: false, boldShown: true, holes: false });
        expect(m.toAge).toBeGreaterThan(0);
      }
    }
    // A match in the branch's start: the branch is cut at its end, at 20ch, and the title
    // still has its room.
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(`feature ${t}`);
    await expect(row(page, long).locator(".pal-why")).toHaveText(" · feature/webhook-retry-backoff");
    m = await measure(long);
    expect(m.title).toBeGreaterThan(m.main * 0.38);
    expect(m).toMatchObject({ titleCut: true, machineCut: false, repo: 0, whyCut: true, boldShown: true });
    expect(m.toAge).toBeGreaterThan(0);
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

  test("the row the keys put the cursor on has the cursor edge; the pointer's has the fill alone", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openBoard(page);
    const meta = await page.evaluate(() => {
      const probe = document.body.appendChild(document.createElement("i"));
      probe.style.color = "var(--fg-3)";
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    const edge = `${meta} 0px 0px 0px 1px inset`;
    await open(page);
    // The actions: a list that holds still while the demo runs.
    await page.keyboard.type(">");
    const selected = dialog(page).locator(".pal-row[aria-selected='true']");
    await page.keyboard.press("ArrowDown");
    await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(selected).toHaveCSS("box-shadow", edge);
    // The mouse onto another row: it takes the cursor, as the fill alone.
    await rows(page).nth(3).hover();
    await expect(rows(page).nth(3)).toHaveAttribute("aria-selected", "true");
    await expect(selected).toHaveCSS("box-shadow", "none");
    // The keys again: the edge again.
    await page.keyboard.press("ArrowDown");
    await expect(rows(page).nth(4)).toHaveAttribute("aria-selected", "true");
    await expect(selected).toHaveCSS("box-shadow", edge);
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
  /** The keys take the cursor to `row`, from the row it is on. */
  async function cursorTo(page: Page, row: ReturnType<typeof allow>) {
    const from = Number(await selected(page).getAttribute("data-i"));
    const to = Number(await row.getAttribute("data-i"));
    for (let n = from; n < to; n++) await page.keyboard.press("ArrowDown");
    for (let n = from; n > to; n--) await page.keyboard.press("ArrowUp");
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

  test("an Allow row's bold letters are in its verb and its tool too, not only in the title", async ({ page }) => {
    const { d, bearer } = await paired(page);
    const t = tag();
    const p = await postPrompt(bearer, { machine: d.name, title: `Bold ask ${t}`, agoMs: 5_000 });
    try {
      await page.goto(`${CONTROL_BASE}/`);
      await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
      await open(page);
      await page.keyboard.type(`allow bash ${t}`);
      await expect(allow(page, `Bold ask ${t}`).locator(".pal-label u")).toHaveText(["Allow", "Bash", t]);
    } finally {
      await p.clear();
      await d.stop();
    }
  });

  test("the preview says what a session waits on, as its board row does, not what was asked; an Allow row previews its own prompt", async ({
    page,
  }) => {
    const { d, bearer } = await paired(page);
    const t = tag();
    const peek = dialog(page).locator(".pal-peek");
    const labels = peek.locator(".pal-peek-label");
    const wait = peek.locator(".pal-peek-text--wait");
    const posted: { clear: () => Promise<void> }[] = [];
    try {
      // The newest comes last, so its session leads the list: the row the cursor starts on.
      posted.push(
        await postPrompt(bearer, {
          machine: d.name,
          title: `Older wait ${t}`,
          agoMs: 20_000,
          message: "rm -rf node_modules && npm ci",
        }),
        await postPrompt(bearer, {
          machine: d.name,
          title: `Plan wait ${t}`,
          agoMs: 15_000,
          tool: "ExitPlanMode",
          message: "ExitPlanMode",
        }),
        await postPrompt(bearer, {
          machine: d.name,
          title: `Question wait ${t}`,
          agoMs: 10_000,
          tool: "AskUserQuestion",
          message: "AskUserQuestion",
          input: { questions: [{ question: "Which queue should the retries use?", options: ["Main", "A new one"] }] },
        }),
      );
      const newest = await postPrompt(bearer, {
        machine: d.name,
        title: `Newest wait ${t}`,
        agoMs: 3_000,
        message: "npm run deploy -- --target staging",
        ask: "Ship the cache to staging.",
      });
      posted.push(newest);
      await page.goto(`${CONTROL_BASE}/`);
      await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
      await expect(page.locator(`article.card[data-flip="${newest.key}"]`)).toBeVisible();
      // No query. The session's own row: the command, in mono under its tool, and no "Asked".
      await open(page);
      await cursorTo(page, session(page, `Newest wait ${t}`));
      await expect(peek.locator(".pal-peek-title")).toHaveText(`Newest wait ${t}`);
      await expect(labels).toHaveText(["Bash", "Replying"]);
      await expect(wait).toHaveText("npm run deploy -- --target staging");
      await expect(wait).toHaveClass(/(^| )mono( |$)/);
      await expect(peek).not.toContainText("Ship the cache to staging.");
      // A question is what its session waits on, in the words it was asked in.
      await cursorTo(page, session(page, `Question wait ${t}`));
      await expect(labels).toHaveText(["Question"]);
      await expect(wait).toHaveText("Which queue should the retries use?");
      await expect(wait).not.toHaveClass(/(^| )mono( |$)/);
      // A plan review is its chip alone, as on the board.
      await cursorTo(page, session(page, `Plan wait ${t}`));
      await expect(labels).toHaveText(["Plan"]);
      await expect(wait).toHaveCount(0);
      // Another prompt's Allow row: that prompt, not the first one listed.
      await cursorTo(page, allow(page, `Older wait ${t}`));
      await expect(peek.locator(".pal-peek-title")).toHaveText(`Older wait ${t}`);
      await expect(labels).toHaveText(["Bash"]);
      await expect(wait).toHaveText("rm -rf node_modules && npm ci");
      await expect(wait).toHaveClass(/(^| )mono( |$)/);
      // Answered on its computer, the newest works again: its preview is back on the ask.
      await newest.clear();
      await expect(answers(page, `Newest wait ${t}`)).toHaveCount(0);
      await cursorTo(page, session(page, `Newest wait ${t}`));
      await expect(labels).toHaveText(["Asked", "Replying"]);
      await expect(peek).toContainText("Ship the cache to staging.");
      await expect(wait).toHaveCount(0);
    } finally {
      for (const p of posted) await p.clear();
      await d.stop();
    }
  });
});
