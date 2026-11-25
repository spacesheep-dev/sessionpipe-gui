// SPDX-License-Identifier: Apache-2.0
// The sidebar's session tree (components/SessionTree.tsx) and the arrangement the person
// makes in it (lib/arrange.ts, server/ui/arrangement.ts), on the demo server with sessions
// of its own posted the way a sink sends them. A pointer drag attaches, moves, detaches,
// pins; a drop on its own child is refused; Esc puts it back; Undo undoes; the keys and
// the menu do the same. The arrangement is kept on the receiver: it is there after a
// reload and in a second window without one, and the Board nests the same way. It is
// display only: the session's page still says whom it really works for, and a parent's
// list says "placed by you". The phone has no list and still has the menu's items.
// One arrangement for the whole server: these tests run one after another, each from none.
// (That a change without the UI key is refused is server/ui/arrangement.test.ts's.)
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { EVENTS, INFO, openPage, sessionUrl, ulid } from "./helpers.js";

test.describe.configure({ mode: "serial" });

const ARRANGEMENT = "/api/ui/arrangement";

interface Arr {
  rev: number;
  placed: Record<string, string | null>;
  pinned: string[];
}
const arrangement = async (request: APIRequestContext): Promise<Arr> =>
  (await (await request.get(ARRANGEMENT)).json()) as Arr;

/** Back to no arrangement at all. */
async function reset(request: APIRequestContext): Promise<void> {
  const a = await arrangement(request);
  const res = await request.patch(ARRANGEMENT, { data: { follow: Object.keys(a.placed), pinned: [] } });
  expect(res.status()).toBe(200);
}

interface Made {
  key: string;
  id: string;
  harness: string;
  title: string;
}

/** Working sessions posted as a sink sends them: `asks` names the one that asked it (on
 *  the same computer, so it is its real child). */
async function sessions(
  request: APIRequestContext,
  defs: {
    title: string;
    machine?: string;
    harness?: string;
    asks?: string;
    /** Working unless said: idle (its turn ended), needs (a prompt open), done (ended). */
    state?: "idle" | "needs" | "done";
  }[],
): Promise<Made[]> {
  const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
  const out: Made[] = [];
  for (const d of defs) {
    const harness = d.harness ?? "claude-code";
    const id = randomUUID();
    let seq = 0;
    let clock = Date.now() - 5_000;
    const ev = (type: string, data: Record<string, unknown>, hook: string) => {
      clock += 200;
      return {
        protocol: 1,
        id: ulid(clock),
        type,
        time: new Date(clock).toISOString(),
        tier: 1,
        harness: { name: harness, version: harness === "codex" ? "0.98.0" : "2.1.296", event: hook },
        session: {
          id,
          seq: seq++,
          machine: d.machine ?? "studio-mac",
          cwd: "~/code/tree",
          title: d.title,
          title_source: "custom",
          ...(d.asks ? { delegated_by: d.asks } : {}),
        },
        privacy: { rulesets: ["secrets@1"], pii: false },
        data,
      };
    };
    const res = await request.post(EVENTS, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sinkToken}`,
        "sessionpipe-protocol": "1",
      },
      data: {
        events: [
          ev("session.started", { source: "startup" }, "SessionStart"),
          ev("turn.started", { turn_id: "t1", prompt_chars: 30 }, "UserPromptSubmit"),
          ...(d.state === "needs"
            ? [
                ev(
                  "attention.needed",
                  { attention_id: `a-${id}`, kind: "permission", tool: "Bash", message: "npm test" },
                  "PermissionRequest",
                ),
              ]
            : []),
          ...(d.state === "idle" || d.state === "done"
            ? [ev("turn.ended", { turn_id: "t1", reason: "stop", ms: 2000 }, "Stop")]
            : []),
          ...(d.state === "done" ? [ev("session.ended", { reason: "exit" }, "SessionEnd")] : []),
        ],
      },
    });
    expect(res.status()).toBe(202);
    out.push({ key: `${harness}:${id}`, id, harness, title: d.title });
  }
  return out;
}

const row = (page: Page, key: string): Locator => page.locator(`.stree [data-tree-row="${key}"]`);
/** The row a row is drawn under, read off the tree as a screen reader reads it. */
const drawnUnder = (page: Page, key: string) =>
  row(page, key).evaluate((el) => {
    const group = el.closest('[role="group"]');
    return group ? (document.querySelector(`[aria-owns="${group.id}"]`)?.getAttribute("data-tree-row") ?? "?") : null;
  });

/** A pointer drag of `from`'s row onto a place of `to`: its middle (`on`), just inside its
 *  top edge (`above`) or its bottom edge (`below`). Released unless `hold`. */
async function drag(
  page: Page,
  from: Locator,
  to: Locator,
  where: "on" | "above" | "below" = "on",
  o: { hold?: boolean } = {},
): Promise<void> {
  // The pointer on the list first, so it holds still (no row moves under a hand), then the row.
  // Rows that are still sliding (a move just made) are not where they will be.
  const settled = () =>
    page.waitForFunction(() =>
      document
        .getAnimations()
        .every(
          (x) =>
            x instanceof CSSAnimation ||
            x.playState !== "running" ||
            !(x.effect as KeyframeEffect)?.target?.closest?.(".stree"),
        ),
    );
  await settled();
  await from.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await from.hover({ position: { x: 40, y: 10 } });
  await expect(page.locator(".stree")).toHaveAttribute("data-held", "");
  // The list may have taken a new order just before it held: let that slide finish.
  await settled();
  await from.hover({ position: { x: 40, y: 10 } });
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  // Past the 4 px that make it a drag.
  await page.mouse.move(a.x + 44, a.y + a.height / 2 + 6, { steps: 3 });
  await expect(page.locator(".stree-chip")).toBeVisible();
  // The place well inside the list's scroll, away from the edges that scroll it.
  await to.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await settled();
  const b = (await to.boundingBox())!;
  const y = where === "on" ? b.y + b.height / 2 : where === "above" ? b.y + 2 : b.y + b.height - 2;
  await page.mouse.move(b.x + 60, y, { steps: 8 });
  if (!o.hold) await page.mouse.up();
}

/** The undo toast says what happened. */
const toast = (page: Page) => page.locator('.toast[data-toast="undo"]');

test.use({ viewport: { width: 1440, height: 1400 } });

test.beforeEach(async ({ request }) => {
  await reset(request);
});
test.afterAll(async ({ request }) => {
  await reset(request);
});

test("the tree is a tree: role, levels, the Board's order, New session at its top", async ({ page, request }) => {
  const tag = randomUUID().slice(0, 6);
  const [parent] = await sessions(request, [{ title: `Tree ${tag} parent` }]);
  const [kid] = await sessions(request, [{ title: `Tree ${tag} asked`, harness: "codex", asks: parent!.key }]);
  await openPage(page, "/");
  const tree = page.locator('.stree [role="tree"]').last();
  await expect(tree).toHaveAttribute("aria-labelledby", /.+/);
  await expect(row(page, parent!.key)).toHaveAttribute("aria-level", "1");
  await expect(row(page, parent!.key)).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, kid!.key)).toHaveAttribute("aria-level", "2");
  expect(await drawnUnder(page, kid!.key)).toBe(parent!.key);
  // A working session's lamp is the board's turning ring, never a new colour.
  await expect(row(page, parent!.key).locator(".stree-lamp .dot--working")).toHaveCount(1);
  // The Board's order: the sidebar's top level is the Board's rows, done ones at the end.
  // Read at one moment: the live demo moves rows between two reads.
  const [sidebar, board] = await page.evaluate(() => [
    Array.from(document.querySelectorAll('.stree [role="tree"] > .stree-item > [data-tree-row]')).map((e) =>
      e.getAttribute("data-tree-row"),
    ),
    Array.from(document.querySelectorAll(".board-list .group:not(.group--done):not(.group--hidden) article.card")).map(
      (e) => e.getAttribute("data-flip"),
    ),
  ]);
  expect(sidebar.slice(0, board.length)).toEqual(board);
  await expect(page.locator(".stree-new")).toHaveText("New session");
  await page.locator(".stree-new").click();
  await expect(page.getByRole("dialog", { name: /new session/i })).toBeVisible();
});

test("a pointer drag attaches, moves, detaches and pins; the Board agrees; Undo puts it back", async ({
  page,
  request,
}) => {
  const tag = randomUUID().slice(0, 6);
  const [a, b, c] = await sessions(request, [
    { title: `Tree ${tag} A` },
    { title: `Tree ${tag} B`, machine: "build-box" },
    { title: `Tree ${tag} C` },
  ]);
  await openPage(page, "/");
  await expect(row(page, a!.key)).toBeVisible();

  // Attach: B on A.
  await drag(page, row(page, b!.key), row(page, a!.key), "on");
  await expect(toast(page)).toContainText(`Moved under Tree ${tag} A`);
  await expect.poll(async () => (await arrangement(request)).placed[b!.key]).toBe(a!.key);
  expect(await drawnUnder(page, b!.key)).toBe(a!.key);
  // Placed, and on another computer than its parent: its tooltip says both.
  await expect(row(page, b!.key)).toHaveAttribute("title", /Placed here by you/);
  await expect(row(page, b!.key).locator(".stree-away")).toHaveCount(1);
  // A top-level row has no mark, whatever computer it runs on: its tooltip says where.
  await expect(row(page, a!.key).locator(".stree-away")).toHaveCount(0);
  await expect(row(page, a!.key)).toHaveAttribute("title", /Runs on studio-mac/);
  await expect(page.locator("[data-tree-said]")).toHaveText(`Tree ${tag} B moved under Tree ${tag} A.`);
  // The Board nests by the same tree.
  await expect(page.locator(`article.card[data-flip="${a!.key}"] .card-kids`)).toContainText(`Tree ${tag} B`);

  // Move: B from A onto C.
  await page.mouse.move(700, 600);
  await drag(page, row(page, b!.key), row(page, c!.key), "on");
  await expect.poll(async () => (await arrangement(request)).placed[b!.key]).toBe(c!.key);
  expect(await drawnUnder(page, b!.key)).toBe(c!.key);

  // Detach: B onto the line above a top-level row.
  await drag(page, row(page, b!.key), row(page, a!.key), "above");
  await expect(toast(page)).toContainText("Moved to the top level");
  // B's events name no parent: it follows them again.
  await expect.poll(async () => b!.key in (await arrangement(request)).placed).toBe(false);
  expect(await drawnUnder(page, b!.key)).toBeNull();

  // Pin: A onto the place to pin (New session's, while nothing is pinned).
  await page.mouse.move(700, 600);
  await drag(page, row(page, a!.key), page.locator(".stree-new"), "on", { hold: true });
  await expect(page.locator(".stree-pin-zone")).toHaveAttribute("data-target", "");
  await page.mouse.up();
  await expect(toast(page)).toContainText("Pinned");
  await expect.poll(async () => (await arrangement(request)).pinned).toEqual([a!.key]);
  await expect(page.locator(".stree-section").first().locator(".stree-label")).toHaveText("Pinned");
  await expect(page.locator(".stree-section").first().locator(`[data-tree-row="${a!.key}"]`)).toBeVisible();

  // Undo: the pin goes.
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await arrangement(request)).pinned).toEqual([]);
  await expect(page.locator(".stree-label", { hasText: "Pinned" })).toHaveCount(0);
});

test("a drop on a row's own child is refused, a drop elsewhere and Esc put it back", async ({ page, request }) => {
  const tag = randomUUID().slice(0, 6);
  const [p] = await sessions(request, [{ title: `Tree ${tag} parent` }]);
  const [k] = await sessions(request, [{ title: `Tree ${tag} kid`, asks: p!.key }]);
  await openPage(page, "/");
  await expect(row(page, k!.key)).toBeVisible();
  const before = (await arrangement(request)).rev;

  // On its own child: no place shows, and the drop changes nothing.
  await drag(page, row(page, p!.key), row(page, k!.key), "on", { hold: true });
  await expect(row(page, k!.key)).not.toHaveAttribute("data-target", "");
  await expect(page.locator(".stree [data-target]")).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator(".stree-chip")).toHaveCount(0);
  expect((await arrangement(request)).rev).toBe(before);

  // Esc mid-drag: everything goes back.
  await drag(page, row(page, k!.key), page.locator(".stree [data-tree-row]").first(), "on", { hold: true });
  await page.keyboard.press("Escape");
  await expect(page.locator(".stree-chip")).toHaveCount(0);
  await expect(page.locator(".stree-item[data-lifted]")).toHaveCount(0);
  await page.mouse.up();
  expect((await arrangement(request)).rev).toBe(before);
  expect(await drawnUnder(page, k!.key)).toBe(p!.key);

  // Dropped outside the sidebar: the same.
  await drag(page, row(page, k!.key), page.locator(".board-list"), "on");
  await expect(page.locator(".stree-chip")).toHaveCount(0);
  expect((await arrangement(request)).rev).toBe(before);
  // A click still opens it: a drag never started.
  await row(page, k!.key).click();
  await expect(page).toHaveURL(new RegExp(`/s/claude-code/${k!.id}`));
});

test("the keys and the menu do what a drag does; the arrows walk the tree", async ({ page, request }) => {
  const tag = randomUUID().slice(0, 6);
  const [a, b] = await sessions(request, [{ title: `Tree ${tag} alpha` }, { title: `Tree ${tag} beta` }]);
  await openPage(page, "/");
  await expect(row(page, b!.key)).toBeVisible();
  // Pin from the menu, by the keyboard.
  await row(page, b!.key).focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect.poll(async () => (await arrangement(request)).pinned).toEqual([b!.key]);
  await expect(page.locator("[data-tree-said]")).toHaveText(`Tree ${tag} beta pinned.`);
  // Move under…: the picker, filtered as typed, Enter takes it.
  await row(page, a!.key).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move under…" }).click();
  const picker = page.getByRole("dialog", { name: "Move under…" });
  await expect(picker).toBeVisible();
  await picker.getByRole("combobox", { name: "Find a session" }).fill(`${tag} beta`);
  await expect(picker.getByRole("option").first()).toContainText(`Tree ${tag} beta`);
  // It never offers the session itself.
  await expect(picker.getByRole("option", { name: new RegExp(`${tag} alpha`) })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect.poll(async () => (await arrangement(request)).placed[a!.key]).toBe(b!.key);
  expect(await drawnUnder(page, a!.key)).toBe(b!.key);
  // The arrows: ← from the child goes to its parent, ← there folds it, → opens it again.
  await row(page, a!.key).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, b!.key)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, b!.key)).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, a!.key)).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(row(page, b!.key)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowDown");
  await expect(row(page, a!.key)).toBeFocused();
  // Move to top level, from the menu, only where it applies.
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Move to top level" }).click();
  await expect.poll(async () => a!.key in (await arrangement(request)).placed).toBe(false);
  await row(page, a!.key).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Move to top level" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  // Enter opens.
  await row(page, a!.key).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/s/claude-code/${a!.id}`));
});

test("it is kept on the receiver: after a reload, and in a second window at once", async ({
  page,
  browser,
  request,
}) => {
  const tag = randomUUID().slice(0, 6);
  const [a, b] = await sessions(request, [{ title: `Tree ${tag} one` }, { title: `Tree ${tag} two` }]);
  await openPage(page, "/");
  const other = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
  await openPage(other, "/");
  await expect(row(other, b!.key)).toBeVisible();
  await drag(page, row(page, b!.key), row(page, a!.key), "on");
  await expect.poll(async () => (await arrangement(request)).placed[b!.key]).toBe(a!.key);
  // The other window, never reloaded.
  await expect.poll(() => drawnUnder(other, b!.key)).toBe(a!.key);
  await other.close();
  await page.reload();
  await expect(row(page, b!.key)).toBeVisible();
  expect(await drawnUnder(page, b!.key)).toBe(a!.key);
});

test("display only: the page still says whom it works for, and the parent's list says placed by you", async ({
  page,
  request,
}) => {
  const tag = randomUUID().slice(0, 6);
  const [p, q] = await sessions(request, [{ title: `Tree ${tag} asker` }, { title: `Tree ${tag} other` }]);
  const [k] = await sessions(request, [{ title: `Tree ${tag} asked`, harness: "codex", asks: p!.key }]);
  // The asked one, put under another session by hand.
  expect((await request.patch(ARRANGEMENT, { data: { placed: { [k!.key]: q!.key } } })).status()).toBe(200);
  await openPage(page, sessionUrl("codex", k!.id));
  // Its page says whom it really works for.
  await expect(page.locator(".sess-for")).toContainText(`Tree ${tag} asker`);
  // The session it was placed under lists it, saying how it got there.
  await openPage(page, sessionUrl("claude-code", q!.id));
  const placedRow = page.locator(`section.kids li.kids-row[data-kid="${k!.key}"]`);
  await expect(placedRow.locator(".kids-how")).toHaveText("placed by you");
  // The real parent's list still has it as asked, with no such words.
  await openPage(page, sessionUrl("claude-code", p!.id));
  const realRow = page.locator(`section.kids li.kids-row[data-kid="${k!.key}"]`);
  await expect(realRow).toBeVisible();
  await expect(realRow.locator(".kids-how")).toHaveCount(0);
});

test("the sessions column: beside the rail where it fits, hidden and shown again, over the page where it does not", async ({
  page,
}) => {
  await openPage(page, "/");
  const col = page.locator(".tree-col");
  const toggle = page.locator("[data-tree-toggle]");
  await expect(col).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-label", "Hide sessions");
  await expect(toggle).toHaveAttribute("data-tip-keys", /.+/);
  // Hidden by its button, kept on this device, shown again by its key.
  await toggle.click();
  await expect(col).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
  await expect(col).toHaveCount(0);
  await page.keyboard.press(process.platform === "darwin" ? "Control+Meta+s" : "Control+b");
  await expect(col).toBeVisible();
  // 1024: the column at 288 beside a 664 px page.
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect.poll(async () => Math.round((await col.boundingBox())!.width)).toBe(288);
  // 860: no room; the rail's button shows it over the page, and Esc, a click outside and
  // opening a session close it.
  await page.setViewportSize({ width: 860, height: 800 });
  await expect(col).toHaveCount(0);
  await toggle.click();
  await expect(page.locator(".rail[data-tree-overlay] .tree-col")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(col).toHaveCount(0);
  await toggle.click();
  await page.mouse.click(700, 500);
  await expect(col).toHaveCount(0);
  await toggle.click();
  await page.locator(".tree-col [data-tree-row]").first().click();
  await expect(page).toHaveURL(/\/s\//);
  await expect(col).toHaveCount(0);
  await page.setViewportSize({ width: 1400, height: 1400 });
});

test("the sidebar's edge: dragged, by the keys, a double-click back to its width, kept", async ({ page }) => {
  await openPage(page, "/");
  const rail = page.locator(".tree-col");
  const edge = page.getByRole("separator", { name: "Sidebar width" });
  await expect(edge).toHaveAttribute("aria-orientation", "vertical");
  const width = async () => Math.round((await rail.boundingBox())!.width);
  // Back to where a device starts, whatever an earlier run left.
  await edge.dblclick();
  await expect(edge).toHaveAttribute("aria-valuenow", "288");
  expect(await width()).toBe(288);
  // The keys: 16 px a press, held to 220 to 400.
  await edge.focus();
  await page.keyboard.press("ArrowRight");
  await expect(edge).toHaveAttribute("aria-valuenow", "304");
  expect(await width()).toBe(304);
  await page.keyboard.press("End");
  await expect(edge).toHaveAttribute("aria-valuenow", "400");
  await page.keyboard.press("ArrowRight");
  await expect(edge).toHaveAttribute("aria-valuenow", "400");
  await page.keyboard.press("Home");
  await expect(edge).toHaveAttribute("aria-valuenow", "220");
  // A drag, and the page takes the rest.
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + 300, { steps: 6 });
  await page.mouse.up();
  await expect(edge).toHaveAttribute("aria-valuenow", "320");
  const main = (await page.locator("main#main").boundingBox())!;
  // The page starts after the icon rail (72) and the column.
  expect(Math.round(main.x)).toBe(72 + 320);
  // Kept on this device, before the first paint of the next load.
  await page.reload();
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--tree-w").trim()),
  ).toBe("320px");
  await expect(edge).toHaveAttribute("aria-valuenow", "320");
  await edge.dblclick();
  await expect(edge).toHaveAttribute("aria-valuenow", "288");
});

test.describe("the keys stay with the tree's row", () => {
  test("Tab leaves the tree, and a click in the Filter field types there", async ({ page, request }) => {
    const tag = randomUUID().slice(0, 6);
    const [a] = await sessions(request, [{ title: `Keys ${tag} one` }, { title: `Keys ${tag} two` }]);
    await openPage(page, "/");
    await row(page, a!.key).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("[role=tree]"))).toBe(false);
    await row(page, a!.key).focus();
    await page.locator("[data-search]").click();
    await page.keyboard.type("abc");
    await expect(page.locator("[data-search]")).toHaveValue("abc");
  });

  test("every Lists key on a tree row acts on that row, never on the Board's cursor row", async ({ page, request }) => {
    const tag = randomUUID().slice(0, 6);
    const [n] = await sessions(request, [{ title: `Keys ${tag} target`, state: "idle" }]);
    await openPage(page, "/");
    await expect(row(page, n!.key)).toBeVisible();
    // The Board's cursor on its first row.
    await page.locator("main#main").focus();
    await page.keyboard.press("j");
    const cursor = page.locator("article.card[aria-current='true']");
    await expect(cursor).toHaveCount(1);
    const boardKey = await cursor.getAttribute("data-flip");
    expect(boardKey).not.toBe(n!.key);
    const t = row(page, n!.key);
    // `.`: the tree row's own menu.
    await t.focus();
    await page.keyboard.press(".");
    await expect(page.getByRole("menu")).toContainText("Pin");
    await expect(page.locator("[role=menu]").first()).toBeVisible();
    await page.keyboard.press("Escape");
    // u: this row's read mark (an idle row with news is unread: u marks it read).
    type M = { read: Record<string, string>; unread: Record<string, true> };
    const marks = async () => (await (await request.get("/api/ui/marks")).json()) as M;
    const boardMarks = JSON.stringify([(await marks()).read[boardKey ?? ""], (await marks()).unread[boardKey ?? ""]]);
    await t.focus();
    await page.keyboard.press("u");
    await expect.poll(async () => n!.key in (await marks()).read || n!.key in (await marks()).unread).toBe(true);
    expect(JSON.stringify([(await marks()).read[boardKey ?? ""], (await marks()).unread[boardKey ?? ""]])).toBe(
      boardMarks,
    );
    // ⌥⌘1: this row's label.
    await t.focus();
    await page.keyboard.press("ControlOrMeta+Alt+1");
    await expect
      .poll(
        async () =>
          ((await (await request.get("/api/ui/labels")).json()) as { sessions: Record<string, string> }).sessions[
            n!.key
          ],
      )
      .toBe("red");
    await request.patch("/api/ui/labels", { data: { sessions: { [n!.key]: null } } });
    // Space: beside the page, the focus staying on the row and the list not scrolled.
    await t.focus();
    const before = await page.locator(".stree-scroll").evaluate((el) => el.scrollTop);
    await page.keyboard.press("Space");
    await expect(page).toHaveURL(new RegExp(encodeURIComponent(n!.key).replace(/%3A/g, "(:|%3A)")));
    await expect(t).toBeFocused();
    expect(await page.locator(".stree-scroll").evaluate((el) => el.scrollTop)).toBe(before);
    // e: hides this row, not the Board's cursor row.
    await t.focus();
    await page.keyboard.press("e");
    await expect(row(page, n!.key)).toHaveCount(0);
    expect(
      await page.evaluate((k) => JSON.parse(localStorage.getItem("sessionpipe-gui.hidden") ?? "{}")[k], boardKey ?? ""),
    ).toBeUndefined();
    // Enter: opens this row's session.
    // (While the keyboard is in the tree it holds still: a new row waits until it leaves.)
    await page.locator("main#main").focus();
    const [m] = await sessions(request, [{ title: `Keys ${tag} open` }]);
    await row(page, m!.key).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/s/claude-code/${m!.id}`));
  });
});

test("unread: the same sessions as the Board, with the Board's own mark", async ({ page, request }) => {
  const tag = randomUUID().slice(0, 6);
  const [idle] = await sessions(request, [{ title: `Unread ${tag} news`, state: "idle" }]);
  await openPage(page, "/");
  await expect(row(page, idle!.key)).toHaveAttribute("data-unread", "");
  await expect(row(page, idle!.key).locator(".stree-lamp .dot--unread")).toHaveCount(1);
  await expect(row(page, idle!.key)).toHaveAccessibleName(/unread/);
  // Every session in both lists: unread in one exactly when unread in the other.
  const both = await page.evaluate(() => {
    const out: [string, boolean, boolean][] = [];
    for (const r of Array.from(document.querySelectorAll<HTMLElement>(".stree [data-tree-row]"))) {
      const k = r.dataset.treeRow!;
      const card = document.querySelector(`article.card[data-flip="${CSS.escape(k)}"] .card-state`);
      if (card) out.push([k, r.hasAttribute("data-unread"), !!card.querySelector(".dot--unread")]);
    }
    return out;
  });
  expect(both.length).toBeGreaterThan(0);
  for (const [k, side, board] of both) expect(side, k).toBe(board);
  // Read, it goes, by the Board's own rule (here: u on the row).
  await row(page, idle!.key).focus();
  await page.keyboard.press("u");
  await expect(row(page, idle!.key)).not.toHaveAttribute("data-unread", "");
  // No orange but for what needs you.
  const orange = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>(".stree *")).filter((el) => {
        const c = getComputedStyle(el);
        return (
          [c.color, c.backgroundColor, c.borderTopColor].some((v) => /rgb\(255, 90, 31\)/.test(v)) &&
          !el.closest(".dot--needs_you, .dot.dot--needs_you")
        );
      }).length,
  );
  expect(orange).toBe(0);
});

test("one filled row, the list's own cursor, and a drop ring told apart by shape", async ({ page, request }) => {
  const tag = randomUUID().slice(0, 6);
  const [a, b] = await sessions(request, [{ title: `States ${tag} open` }, { title: `States ${tag} other` }]);
  await openPage(page, "/");
  // Open beside the Board: the tree's row is the one filled row in the sidebar.
  await row(page, a!.key).click({ modifiers: ["Shift"] });
  await expect(row(page, a!.key)).toHaveAttribute("data-open", "");
  await page.mouse.move(900, 600);
  const filled = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("nav.rail .nav-link, nav.rail .stree-row"))
        .filter((el) => getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)")
        .map((el) => el.getAttribute("data-tree-row") ?? el.getAttribute("data-nav")),
    );
  // (Past the fills' own 80 ms release.)
  await expect.poll(filled).toEqual([a!.key]);
  // The keyboard's cursor: a fill and a hairline edge, no 2 px ring.
  await row(page, b!.key).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  const cursor = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const c = getComputedStyle(el);
    return { outline: c.outlineStyle, shadow: c.boxShadow, fill: c.backgroundColor };
  });
  expect(cursor.outline).toBe("none");
  expect(cursor.shadow).toContain("inset");
  expect(cursor.fill).not.toBe("rgba(0, 0, 0, 0)");
});

test.describe("a row is never lost", () => {
  /** Folds a parent row by its disclosure. */
  const fold = async (page: Page, key: string) => {
    await row(page, key).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(row(page, key)).toHaveAttribute("aria-expanded", "false");
  };

  test("a folded parent carries what needs you under it, in its glyph and its name", async ({ page, request }) => {
    const tag = randomUUID().slice(0, 6);
    const [p] = await sessions(request, [{ title: `Lost ${tag} parent` }]);
    await sessions(request, [{ title: `Lost ${tag} child`, asks: p!.key, state: "needs" }]);
    await openPage(page, "/");
    await fold(page, p!.key);
    await expect(row(page, p!.key)).toHaveAttribute("data-rolled", "needs_you");
    await expect(row(page, p!.key).locator(".stree-lamp .dot--needs_you")).toHaveCount(1);
    await expect(row(page, p!.key)).toHaveAccessibleName(/1 needs you/);
  });

  test("u on a folded parent showing a child's news reads the child", async ({ page, request }) => {
    const tag = randomUUID().slice(0, 6);
    const [p] = await sessions(request, [{ title: `Lost ${tag} quiet parent`, state: "done" }]);
    const [c] = await sessions(request, [{ title: `Lost ${tag} news`, asks: p!.key, state: "idle" }]);
    await openPage(page, "/");
    await expect(row(page, c!.key)).toHaveAttribute("data-unread", "");
    // Read the parent itself first: the glyph is then the child's.
    await row(page, p!.key).focus();
    if ((await row(page, p!.key).getAttribute("data-unread")) !== null) await page.keyboard.press("u");
    await expect(row(page, p!.key)).not.toHaveAttribute("data-unread", "");
    await fold(page, p!.key);
    await expect(row(page, p!.key)).toHaveAttribute("data-rolled", "unread");
    await page.keyboard.press("u");
    await expect(row(page, p!.key)).not.toHaveAttribute("data-rolled", "unread");
    await row(page, p!.key).focus();
    await page.keyboard.press("ArrowRight");
    await expect(row(page, c!.key)).not.toHaveAttribute("data-unread", "");
  });

  test("opening a child from the Board unfolds its parent and shows its row filled", async ({ page, request }) => {
    const tag = randomUUID().slice(0, 6);
    const [p] = await sessions(request, [{ title: `Lost ${tag} board parent` }]);
    const [c] = await sessions(request, [{ title: `Lost ${tag} board child`, asks: p!.key }]);
    await openPage(page, "/");
    await fold(page, p!.key);
    await page.locator(`article.card[data-flip="${p!.key}"] .kid`, { hasText: `Lost ${tag} board child` }).click();
    await expect(page).toHaveURL(new RegExp(c!.id));
    await expect(row(page, p!.key)).toHaveAttribute("aria-expanded", "true");
    await expect(row(page, c!.key)).toHaveAttribute("data-open", "");
    await expect(row(page, c!.key)).toBeInViewport();
  });

  test("a move under a folded parent opens it, focused; Hide hands the focus on", async ({ page, request }) => {
    const tag = randomUUID().slice(0, 6);
    const [p, x, y] = await sessions(request, [
      { title: `Lost ${tag} home` },
      { title: `Lost ${tag} mover` },
      { title: `Lost ${tag} hider` },
    ]);
    await sessions(request, [{ title: `Lost ${tag} home child`, asks: p!.key }]);
    await openPage(page, "/");
    await fold(page, p!.key);
    await row(page, x!.key).focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Move under…" }).click();
    await page.getByRole("combobox", { name: "Find a session" }).fill(`${tag} home`);
    await page.keyboard.press("Enter");
    await expect(row(page, p!.key)).toHaveAttribute("aria-expanded", "true");
    await expect(row(page, x!.key)).toBeFocused();
    // Hide from the row's menu: the focus goes to the row that took its place.
    await row(page, y!.key).focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Hide", exact: true }).click();
    await expect(row(page, y!.key)).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest(".stree [data-tree-row]")))
      .toBe(true);
  });
});

test.describe("the phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("has no list, and its menu still pins and moves", async ({ page, request }) => {
    const tag = randomUUID().slice(0, 6);
    const [a] = await sessions(request, [{ title: `Tree ${tag} phone` }]);
    await openPage(page, "/");
    await expect(page.locator(".stree")).toHaveCount(0);
    await expect(page.getByRole("separator", { name: "Sidebar width" })).toHaveCount(0);
    const card = page.locator(`article.card[data-flip="${a!.key}"]`);
    await expect(card).toBeVisible();
    // A finger held on the row: its menu, as a sheet.
    const sheet = page.locator(".menu-sheet");
    await expect(async () => {
      await card.locator(".card-title").evaluate((el) => {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            pointerType: "touch",
            clientX: r.left + 4,
            clientY: r.top + 4,
          }),
        );
      });
      await expect(sheet.getByRole("menuitem", { name: "Pin", exact: true })).toBeVisible({ timeout: 2_000 });
    }).toPass();
    // The finger lifts: its click is the hold's, not a tap on the menu (ContextMenu.tsx).
    await page.evaluate(() => {
      document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await sheet.evaluate((el) => Promise.all(el.getAnimations().map((x) => x.finished)));
    await expect(sheet.getByRole("menuitem", { name: "Move under…" })).toBeVisible();
    await sheet.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect.poll(async () => (await arrangement(request)).pinned).toEqual([a!.key]);
  });
});
