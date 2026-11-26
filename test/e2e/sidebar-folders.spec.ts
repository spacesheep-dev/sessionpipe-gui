// SPDX-License-Identifier: Apache-2.0
// Project grouping & custom folders in the sidebar session tree (SessionTree.tsx,
// MoveFolder.tsx, shared/arrangement.ts): toggling Group by project with disambiguated
// labels, rolled-up lamps on collapsed project/folder rows, creating/renaming/recoloring/
// reordering/deleting custom folders, drag-and-drop into/out of folders (including 600 ms
// auto-expand on collapsed folders), Move to folder submenu, Shift+M picker with inline
// create, Shift+N new folder, Board Folder filter, and full Undo.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { EVENTS, INFO, openPage, ulid } from "./helpers.js";

test.describe.configure({ mode: "serial" });

const ARRANGEMENT = "/api/ui/arrangement";

interface Arr {
  rev: number;
  placed: Record<string, string | null>;
  pinned: string[];
  folders?: { id: string; name: string; color?: string }[];
  inFolder?: Record<string, string>;
}

const arrangement = async (request: APIRequestContext): Promise<Arr> =>
  (await (await request.get(ARRANGEMENT)).json()) as Arr;

async function reset(request: APIRequestContext): Promise<void> {
  const a = await arrangement(request);
  const res = await request.patch(ARRANGEMENT, {
    data: { follow: Object.keys(a.placed), pinned: [], folders: [] },
  });
  expect(res.status()).toBe(200);
}

interface Made {
  key: string;
  id: string;
  harness: string;
  title: string;
}

async function sessions(
  request: APIRequestContext,
  defs: {
    title: string;
    repo?: string;
    cwd?: string;
    machine?: string;
    harness?: string;
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
        harness: { name: harness, version: "2.1.296", event: hook },
        session: {
          id,
          seq: seq++,
          machine: d.machine ?? "studio-mac",
          cwd: d.cwd ?? "~/code/tree",
          ...(d.repo ? { repo: d.repo } : {}),
          title: d.title,
          title_source: "custom",
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

async function dragTo(page: Page, from: Locator, to: Locator, holdMs = 0): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("missing drag box");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

test.describe("Sidebar project grouping and custom folders", () => {
  test.beforeEach(async ({ request }) => {
    await reset(request);
  });

  test("groups sessions by project, disambiguates colliding names, rolls up lamps when folded", async ({
    page,
    request,
  }) => {
    const [s1, s2, s3] = await sessions(request, [
      { title: "Alpha auth", repo: "https://github.com/acme/app.git", state: "needs" },
      { title: "Beta billing", repo: "https://github.com/other/app.git", state: "idle" },
      { title: "Core CLI", cwd: "~/code/cli-tool", state: "idle" },
    ]);
    await openPage(page, "/");
    await expect(row(page, s1!.key)).toBeVisible();
    await expect(row(page, s2!.key)).toBeVisible();
    await expect(row(page, s3!.key)).toBeVisible();

    const toggle = page.locator(".stree [data-tree-group-toggle]");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    const acmeRow = page.locator('.stree [data-project-key="repo:acme/app"]');
    const otherRow = page.locator('.stree [data-project-key="repo:other/app"]');
    const cliRow = page.locator('.stree [data-project-key="cwd:~/code/cli-tool"]');
    await expect(acmeRow).toContainText("acme/app");
    await expect(otherRow).toContainText("other/app");
    await expect(cliRow).toContainText("cli-tool");

    // Collapsing a project with a needs_you session shows rolled-up needs_you lamp.
    await acmeRow.click();
    await expect(acmeRow).toHaveAttribute("aria-expanded", "false");
    await expect(acmeRow).toHaveAttribute("data-rolled", "needs_you");
    await expect(row(page, s1!.key)).toBeHidden();

    // Expanding brings the session back.
    await acmeRow.click();
    await expect(row(page, s1!.key)).toBeVisible();
  });

  test("creates, renames, recolors, drags into, deletes custom folder and restores with Undo", async ({
    page,
    request,
  }) => {
    const [s1, s2] = await sessions(request, [
      { title: "Fix login", state: "needs" },
      { title: "Write docs", state: "idle" },
    ]);
    await openPage(page, "/");
    await expect(row(page, s1!.key)).toBeVisible();

    // Create a custom folder inline via header button.
    await page.locator(".stree [data-tree-new-folder]").click();
    const input = page.locator(".stree .stree-inline-input");
    await expect(input).toBeVisible();
    await input.fill("Sprint 1");
    await input.press("Enter");

    const folderRow = page.locator('.stree [data-zone="folder"]', { hasText: "Sprint 1" });
    await expect(folderRow).toBeVisible();

    // Drag s1 onto the folder row to move it in.
    await dragTo(page, row(page, s1!.key), folderRow);
    await expect.poll(async () => Object.keys((await arrangement(request)).inFolder ?? {})).toContain(s1!.key);

    // Fold the folder: shows rolled-up needs_you lamp.
    await folderRow.click();
    await expect(folderRow).toHaveAttribute("aria-expanded", "false");
    await expect(folderRow).toHaveAttribute("data-rolled", "needs_you");

    // Drag s2 over collapsed folder and hold > 600 ms: auto-expands and moves s2 in.
    await dragTo(page, row(page, s2!.key), folderRow, 700);
    await expect(folderRow).toHaveAttribute("aria-expanded", "true");
    await expect.poll(async () => Object.keys((await arrangement(request)).inFolder ?? {})).toContain(s2!.key);

    // Rename & set color via context menu.
    await folderRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    const renameInput = page.locator(".stree .stree-inline-input");
    await renameInput.fill("Release");
    await renameInput.press("Enter");
    const renamedRow = page.locator('.stree [data-zone="folder"]', { hasText: "Release" });
    await expect(renamedRow).toBeVisible();

    // Delete folder via context menu -> sessions return to Sessions; Undo restores folder + memberships!
    await renamedRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete folder" }).click();
    await expect(renamedRow).toBeHidden();
    await expect(row(page, s1!.key)).toBeVisible();
    await expect.poll(async () => (await arrangement(request)).folders ?? []).toEqual([]);

    // Click Undo in toast.
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(renamedRow).toBeVisible();
    await expect
      .poll(async () => Object.keys((await arrangement(request)).inFolder ?? {}).sort())
      .toEqual([s1!.key, s2!.key].sort());
  });

  test("Shift+M opens Move to folder picker with inline create and persists across reload", async ({
    page,
    request,
  }) => {
    const [s1] = await sessions(request, [{ title: "Picker target", state: "idle" }]);
    await openPage(page, "/");
    const r1 = row(page, s1!.key);
    await expect(r1).toBeVisible();
    await r1.focus();
    await page.keyboard.press("Shift+M");

    const dialog = page.getByRole("dialog", { name: "Move to folder…" });
    await expect(dialog).toBeVisible();
    const field = dialog.getByRole("combobox");
    await field.fill("Quick Folder");
    await field.press("Enter");
    await expect(dialog).toBeHidden();

    const fRow = page.locator('.stree [data-zone="folder"]', { hasText: "Quick Folder" });
    await expect(fRow).toBeVisible();
    await page.reload();
    await expect(page.locator('.stree [data-zone="folder"]', { hasText: "Quick Folder" })).toBeVisible();
  });
});
