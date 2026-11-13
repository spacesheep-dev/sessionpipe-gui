// SPDX-License-Identifier: Apache-2.0
// The phone on a spacesheep account (docs/rfcs/08), in a browser, with no GUI server at
// all. The built page is served as the app serves its bundle (test/account/serve.ts); the
// native shell is an init script (test/account/shell-init.ts); behind it the hub's half of
// the contract is stood in (test/account/hub.ts: the commands, the documents, the event,
// the five doors with their refusals) over a spacesheep stood in (fake-spacesheep.ts) and a
// computer stood in below. The page's own code is what runs: its store, the relay's
// reader, the account's machines and sends, IndexedDB. One story, in order.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import type { ProtocolEvent } from "../../shared/api.js";
import { FakeSpacesheep } from "../account/fake-spacesheep.js";
import { HubStandIn } from "../account/hub.js";
import { type AccountServer, startAccountServer } from "../account/serve.js";
import { fakeShell } from "../account/shell-init.js";
import { Session } from "../events.js";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/web");
const MACHINE = "m_studio0123456789abcd";
const NAME = "studio-mac";

test.describe.configure({ mode: "serial" });

/** What the page's backend says of itself (account/backend.ts AccountView). */
interface View {
  state: string;
  relay: { state: string; cursor: number; events: number; lastError?: string };
  catching: boolean;
  cache: string;
  restored: { events: number; pages: number } | null;
  store: { events: number; sessions: number };
}

let ss: FakeSpacesheep;
let hub: HubStandIn;
let server: AccountServer;
let context: BrowserContext;
let page: Page;
let stopComputer: () => void;
const sessions = new Map<string, Session>();
/** What the computer was told to do, in order. */
const ran: Record<string, unknown>[] = [];

const on = { tier: 2 as const, session: { machine: NAME, cwd: "/Users/me/billing" } };
const session = (id: string): Session => {
  let s = sessions.get(id);
  if (!s) {
    s = new Session(id);
    sessions.set(id, s);
  }
  return s;
};
const started = (id: string, title: string, ask: string, answer: string): ProtocolEvent[] => {
  const s = session(id);
  const named = { ...on, session: { ...on.session, title } };
  return [
    s.ev("session.started", { source: "startup" }, named),
    s.ev("turn.started", { turn_id: "t1" }, named),
    s.ev("turn.transcript", { turn: 1, user: ask, assistant: answer }, named),
    s.ev("turn.ended", { turn_id: "t1" }, named),
  ];
};

/** The account's computer: it takes each job spacesheep holds for it, does what a daemon
 *  would (a prompt becomes a turn, an answer clears its prompt) and acks. */
function computer(): () => void {
  let turn = 10;
  const t = setInterval(() => {
    for (const job of ss.jobs) {
      if (job.status !== "queued") continue;
      const cmd = JSON.parse(String(job.sent.cmd)) as Record<string, string>;
      ran.push(cmd);
      ss.settle(job.id, "running");
      const s = session(String(cmd.session).split(":")[1]!);
      if (cmd.kind === "prompt") {
        const id = `t${turn++}`;
        ss.push([
          s.ev("turn.started", { turn_id: id }, on),
          s.ev("turn.transcript", { turn: turn, user: cmd.text, assistant: `Done: ${cmd.text}` }, on),
          s.ev("turn.ended", { turn_id: id }, on),
        ]);
      } else if (cmd.kind === "permission.answer") {
        ss.push([s.ev("attention.cleared", { attention_id: cmd.for, how: "answered" }, on)]);
      }
      ss.settle(job.id, "done");
    }
  }, 100);
  return () => clearInterval(t);
}

const view = (): Promise<View> =>
  page.evaluate(() =>
    (window as unknown as { __sessionpipeAccount: { view(): unknown } }).__sessionpipeAccount.view(),
  ) as Promise<View>;
const invoke = <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> =>
  page.evaluate(
    ([c, a]) =>
      (
        window as unknown as { __TAURI_INTERNALS__: { invoke(c: string, a: unknown): Promise<unknown> } }
      ).__TAURI_INTERNALS__.invoke(c as string, a),
    [cmd, args] as const,
  ) as Promise<T>;
const composer = () => page.getByLabel("Message for the next turn");

test.beforeAll(async ({ browser }) => {
  ss = new FakeSpacesheep();
  ss.machines = [
    {
      id: MACHINE,
      name: NAME,
      online: true,
      last_seen: Date.now(),
      folders: ["/Users/me"],
      mode: "safe",
      agents: ["claude-code"],
      cli_version: "sessionpipe 0.14.2",
      modes: ["waiter"],
      passkey_ids: ["a-passkey-made-on-spacesheep"],
      key_types: ["passkey", "device"],
    },
  ];
  hub = new HubStandIn({ upstream: { origin: "https://spacesheep.test", ask: (req) => ss.handle(req) } });
  server = await startAccountServer({ web: WEB, hub });
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: { cookies: [], origins: [] },
  });
  await context.addInitScript(fakeShell, {});
  page = await context.newPage();
  stopComputer = computer();
});

test.afterAll(async () => {
  stopComputer?.();
  await context?.close();
  await server?.close();
});

test("connects: the digits, the approval on spacesheep, the account as this window's receiver", async () => {
  ss.push(
    started(
      "s-invoice",
      "Fix the invoice webhook",
      "The invoice webhook retries forever on a 409.",
      "Found it: the retry loop never checks for a conflict.",
    ),
  );
  await page.goto(server.url);
  // No receiver yet: the page is the app's welcome, and it knows the account mode is there.
  expect(
    await page.evaluate(
      () => (window as unknown as { sessionpipeShell: { receiver: unknown } }).sessionpipeShell.receiver,
    ),
  ).toBeNull();
  const start = await invoke<{ digits: string; state: string; url?: string }>("acct_connect_start");
  expect(start).toMatchObject({ state: "pending", origin: "https://spacesheep.test" });
  expect(start.digits).toMatch(/^\d{4}$/);
  // The link never reaches the page: the hub opens it.
  expect(start.url).toBeUndefined();
  await invoke("acct_connect_open");
  expect(hub.opened).toHaveLength(1);
  ss.approve(start.digits);
  await hub.pollConnect();
  const status = await invoke<{
    accounts: { id: string; email: string; state: string }[];
    connect: { state: string; receiver: string };
  }>("acct_status");
  expect(status.connect).toMatchObject({ state: "approved", email: "me@example.com" });
  expect(status.accounts).toMatchObject([{ email: "me@example.com", state: "ok" }]);
  expect(status.accounts[0]!.id).toMatch(/^[a-z2-7]{52}$/);
  // The key is nowhere a page can read.
  expect(JSON.stringify(status)).not.toContain(ss.key);
  await invoke("rx_select", { id: status.connect.receiver });
  await page.reload();
  expect(
    await page.evaluate(
      () => (window as unknown as { sessionpipeShell: { receiver: { kind: string } } }).sessionpipeShell.receiver.kind,
    ),
  ).toBe("spacesheep");
});

test("shows the board and a session from the relay, and what happens next as it happens", async () => {
  await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
  await expect.poll(async () => (await view()).relay.state).toBe("ok");
  expect(await view()).toMatchObject({ state: "ok", cache: "indexeddb", catching: false, store: { sessions: 1 } });
  // A second session starts while the board is on screen.
  ss.push(
    started(
      "s-login",
      "Add a login test",
      "Add a login test for the refund page.",
      "Added it; the refund page logs in first.",
    ),
  );
  await expect(page.getByText("Add a login test").first()).toBeVisible();
  await page.goto(`${server.url}/s/claude-code/s-invoice`);
  await expect(page.getByText("The invoice webhook retries forever on a 409.").first()).toBeVisible();
  await expect(page.getByText("Found it: the retry loop never checks for a conflict.").first()).toBeVisible();
  // Live, on the session's own page.
  const s = session("s-invoice");
  ss.push([
    s.ev("turn.started", { turn_id: "t2" }, on),
    s.ev("turn.transcript", { turn: 2, user: "And the refund webhook?", assistant: "Same loop, same fix." }, on),
    s.ev("turn.ended", { turn_id: "t2" }, on),
  ]);
  await expect(page.getByText("Same loop, same fix.").first()).toBeVisible();
});

test("this phone's key is asked to be trusted through the hub; once the computer trusts it a message goes, and its answer comes back", async () => {
  // The page supplies nothing: the hub reads the key from the signer and asks spacesheep.
  const asked = await page.evaluate(() =>
    (
      window as unknown as { __sessionpipeAccount: { deviceAsk(): Promise<{ code: string; keyId: string }> } }
    ).__sessionpipeAccount.deviceAsk(),
  );
  expect(asked.code).toBe("71");
  expect([...ss.deviceRequests.keys()]).toEqual([asked.keyId]);
  // Approved on spacesheep's Devices page: the computer trusts the key from now on.
  (ss.machines[0]!.passkey_ids as string[]).push(asked.keyId);
  ss.trusting.set(asked.keyId, [MACHINE]);
  await page.reload();
  const box = composer();
  await expect(box).toBeEnabled();
  await box.fill("Check the refund webhook too.");
  await box.press("Enter");
  await expect(page.getByText("Done: Check the refund webhook too.").first()).toBeVisible();
  // What reached spacesheep: the signed bytes and the four names the door takes.
  const job = ss.jobs[ss.jobs.length - 1]!;
  expect(Object.keys(job.sent).sort()).toEqual(["cmd", "confirm", "csig", "grant"]);
  expect(job.sent.confirm).toBeNull();
  expect(ran[ran.length - 1]).toMatchObject({
    kind: "prompt",
    session: "claude-code:s-invoice",
    text: "Check the refund webhook too.",
  });
  await expect(box).toHaveValue("");
});

test("a message spacesheep holds is shown held with its reason, and goes when confirmed", async () => {
  ss.sendAnswers.push(() => ({
    status: 409,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "confirm",
      error: "Confirm with your passkey to send this: it deletes a whole folder.",
      why: "it deletes a whole folder",
    }),
  }));
  const box = composer();
  await box.fill("Delete the old billing folder.");
  await box.press("Enter");
  const notice = page.locator("[data-held]");
  await expect(notice).toBeVisible();
  // The notice says who held it and why, in the receiver's own words.
  await expect(notice.locator("[data-held-why]")).toContainText("spacesheep.test says");
  await expect(notice.locator("[data-held-why]")).toContainText("deletes a whole folder");
  await expect(notice.locator("[data-held-what]")).toHaveText("Delete the old billing folder.");
  const before = ss.jobs.length;
  await notice.locator("[data-held-confirm]").click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByText("Done: Delete the old billing folder.").first()).toBeVisible();
  expect(ss.jobs).toHaveLength(before + 1);
  // The confirmed send is the confirm alone.
  expect(ss.jobs[ss.jobs.length - 1]!.sent).toMatchObject({
    csig: null,
    grant: null,
    confirm: { cred: expect.any(String) },
  });
});

test("a permission question is answered from the inbox, and the computer gets the answer", async () => {
  const s = session("s-login");
  ss.push([
    s.ev("turn.started", { turn_id: "t5" }, on),
    s.ev(
      "attention.needed",
      { attention_id: "perm-1", kind: "permission", tool: "Bash", message: "Bash rm -rf node_modules && npm ci" },
      on,
    ),
  ]);
  await page.goto(`${server.url}/inbox`);
  const row = page.locator(".inbox-row--answerable").first();
  await expect(row).toBeVisible();
  await expect(row).toContainText("Add a login test");
  await row.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => ran.some((c) => c.kind === "permission.answer")).toBe(true);
  expect(ran.find((c) => c.kind === "permission.answer")).toMatchObject({
    session: "claude-code:s-login",
    for: "perm-1",
    decision: "allow",
  });
  await expect(page.locator(".inbox-row--answerable")).toHaveCount(0);
});

test("after a reload the board is there from what was kept, before the relay answers at all", async () => {
  // spacesheep cannot be reached: nothing the page shows now can have come from it.
  hub.down = true;
  await page.goto(server.url);
  await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
  await expect(page.getByText("Add a login test").first()).toBeVisible();
  const v = await view();
  expect(v.cache).toBe("indexeddb");
  expect(v.restored?.events).toBeGreaterThan(8);
  expect(v.relay.cursor).toBeGreaterThan(8);
  expect(v.relay.events).toBe(0);
  await expect
    .poll(async () => (await view()).relay)
    .toMatchObject({ state: "offline", lastError: "hub: unreachable" });
  // The rows are from before and spacesheep cannot be reached: the page says so, not "live".
  const reconnecting = page.locator("text=/^Reconnecting/ >> visible=true");
  await expect(reconnecting.first()).toBeVisible();
  // The labels the person set are the hub's to keep, and the sends are still listed.
  hub.down = false;
  await expect.poll(async () => (await view()).relay.state, { timeout: 20_000 }).toBe("ok");
  await expect(reconnecting).toHaveCount(0);
});

/** Everything the page's cache holds for the account, as text (the relay's pages in IndexedDB). */
const keptText = (): Promise<string> =>
  page.evaluate(async () => {
    const all = await indexedDB.databases();
    let out = "";
    for (const d of all) {
      if (!d.name?.startsWith("sessionpipe.account.")) continue;
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const o = indexedDB.open(d.name!);
        o.onsuccess = () => res(o.result);
        o.onerror = () => rej(o.error);
      });
      const pages = await new Promise<unknown[]>((res, rej) => {
        const r = db.transaction("pages", "readonly").objectStore("pages").getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      db.close();
      out += JSON.stringify(pages);
    }
    return out;
  });

test("a session the account forgets leaves the board and the phone, and a reload does not bring it back", async () => {
  ss.push(
    started(
      "s-secret",
      "Rotate the staging password",
      "The staging password is in the old wiki, rotate it.",
      "Rotated; the wiki page is gone.",
    ),
  );
  await expect(page.getByText("Rotate the staging password").first()).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __sessionpipeAccount: { flushed(): Promise<void> } }).__sessionpipeAccount.flushed(),
  );
  expect(await keptText()).toContain("The staging password is in the old wiki");
  // Forgotten on the account: spacesheep relays it as an event of that session.
  ss.push([session("s-secret").ev("session.forgotten", {}, on)]);
  await expect(page.getByText("Rotate the staging password")).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { __sessionpipeAccount: { flushed(): Promise<void> } }).__sessionpipeAccount.flushed(),
  );
  const kept = await keptText();
  expect(kept).not.toContain("s-secret");
  expect(kept).not.toContain("The staging password is in the old wiki");
  expect(kept).toContain("s-invoice");
  // From what was kept alone (spacesheep cannot be reached): it is not back.
  hub.down = true;
  await page.goto(server.url);
  await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
  await expect(page.getByText("Rotate the staging password")).toHaveCount(0);
  hub.down = false;
  await expect.poll(async () => (await view()).relay.state, { timeout: 20_000 }).toBe("ok");
  await expect(page.getByText("Rotate the staging password")).toHaveCount(0);
  expect((await view()).store.sessions).toBe(2);
});

test("a 429 from spacesheep is waited out and read on from; a full room at the hub and an answer too large are not errors", async () => {
  ss.limitedUntil = Date.now() + 9000;
  // Something happens on the account: the next read of the relay meets spacesheep's limit
  // and is told how long to wait.
  ss.push(started("s-limit", "While the relay was limited", "Is anyone there?", "Yes."));
  await expect.poll(async () => (await view()).relay.state, { timeout: 15_000 }).toBe("limited");
  // The board is as usable as it was: what was read is shown.
  await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
  ss.push(started("s-after", "After the limit", "Still there?", "Still here."));
  // When the wait is over both are read, with nothing lost.
  await expect(page.getByText("After the limit").first()).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("While the relay was limited").first()).toBeVisible();
  expect((await view()).relay.state).toBe("ok");

  // The hub's room is full three times: asked again, never said to be limited.
  hub.busy = 3;
  ss.push(started("s-busy", "Through a busy hub", "Hello?", "Hello."));
  await expect(page.getByText("Through a busy hub").first()).toBeVisible({ timeout: 15_000 });
  expect((await view()).relay.state).toBe("ok");
  expect(hub.log.filter((l) => l.endsWith(" busy")).length).toBeGreaterThanOrEqual(3);

  // Forty events that do not fit one answer: asked for in smaller pages, all of them read.
  const events = (await view()).store.events;
  hub.relayMax = 6000;
  const s = session("s-busy");
  ss.push(Array.from({ length: 40 }, (_, i) => s.ev("tool.started", { tool: "Read", call_id: `big-${i}` }, on)));
  await expect.poll(async () => (await view()).store.events, { timeout: 20_000 }).toBe(events + 40);
  expect(hub.log.some((l) => l.endsWith(" answer_too_large"))).toBe(true);
  hub.relayMax = 8 * 1024 * 1024;
  expect((await view()).relay.state).toBe("ok");
});

test("a gap in the relay is said, and the board shows what the relay still holds", async () => {
  hub.down = true;
  await expect.poll(async () => (await view()).relay.state, { timeout: 30_000 }).toBe("offline");
  // While the phone was away the relay moved on past what it had read.
  const s = session("s-gap");
  ss.push(
    Array.from({ length: 30 }, (_, i) =>
      s.ev(
        i ? "tool.started" : "session.started",
        { call_id: `g-${i}` },
        { ...on, session: { ...on.session, title: "After the gap" } },
      ),
    ),
  );
  ss.drop(ss.newest - 5);
  hub.down = false;
  await expect.poll(async () => (await view()).relay.state, { timeout: 30_000 }).toBe("gap");
  expect((await view()).relay.lastError).toContain("no longer holds events before");
  await expect(page.getByText("After the gap").first()).toBeVisible();
  await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
});

test("what only a receiver has is not offered, and no page asks for it", async () => {
  // Every page a person can reach: what it asks of its backend is answered, never refused.
  for (const route of [
    "/",
    "/inbox",
    "/search",
    "/feed",
    "/review",
    "/machines",
    "/usage",
    "/settings",
    "/s/claude-code/s-invoice",
  ]) {
    await page.goto(server.url + route);
    await page.waitForTimeout(400);
    const asked = await page.evaluate(() => [
      ...(window as unknown as { __sessionpipeAccount: { asked: Map<string, number> } }).__sessionpipeAccount.asked,
    ]);
    expect(
      asked.filter(([, status]) => status >= 400),
      route,
    ).toEqual([]);
  }
  // The pages that are a receiver's own doing are not in the app's menu…
  await page.goto(server.url);
  await page.locator("[data-nav=more]").first().click();
  const sheet = page.locator(".more-sheet, [role=dialog]").last();
  await expect(sheet.locator("[data-nav=machines]")).toBeVisible();
  await expect(sheet.locator("[data-nav=usage]")).toBeVisible();
  for (const key of ["workflows", "connect", "setup"]) await expect(page.locator(`[data-nav=${key}]`)).toHaveCount(0);
  // …and are no pages when an address names them.
  for (const route of ["/workflows", "/connect", "/setup", "/themes", "/phone", "/pair?code=abcdefgh"]) {
    await page.goto(server.url + route);
    await expect(page.locator("[data-no-receiver]"), route).toContainText("This needs a sessionpipe-gui server");
  }
  // No session offers to be forgotten: the account holds it.
  await page.goto(`${server.url}/s/claude-code/s-invoice`);
  await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Forget…" })).toHaveCount(0);
});

test("a revoked key is spacesheep's own word: reading stops, and a send says why it did not go", async () => {
  await page.goto(`${server.url}/s/claude-code/s-invoice`);
  await expect(composer()).toBeEnabled();
  ss.revoked = true;
  const box = composer();
  await box.fill("Anyone?");
  await box.press("Enter");
  await expect(page.getByText("spacesheep no longer takes this app's key").first()).toBeVisible();
  await expect.poll(async () => (await view()).relay.state).toBe("unauthorized");
  expect((await view()).state).toBe("unauthorized");
  // The hub said so too, in its event.
  expect([...hub.accounts.values()][0]!.state).toBe("unauthorized");
});

/** The names of this origin's IndexedDB databases, and what its localStorage holds. */
const databases = (): Promise<(string | undefined)[]> =>
  page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
const stored = (): Promise<Record<string, string>> =>
  page.evaluate(() => Object.fromEntries(Object.entries(localStorage)) as Record<string, string>);
/** What a person leaves behind while sessions are on screen: a draft, a search, a hidden session. */
const leaveTraces = (): Promise<void> =>
  page.evaluate(() => {
    localStorage.setItem("sessionpipe-gui.draft:claude-code:s-invoice", "half a message about the webhook");
    localStorage.setItem("sp.search.recent", JSON.stringify(["invoice webhook"]));
    localStorage.setItem("sessionpipe-gui.hidden", JSON.stringify(["claude-code:s-login"]));
    localStorage.setItem("sessionpipe-gui.textSize", "large");
  });
const TRACES = ["sessionpipe-gui.draft:claude-code:s-invoice", "sp.search.recent", "sessionpipe-gui.hidden"];
const welcome = () => page.locator(".onb[data-step='welcome']");

test("Disconnect in Settings, once confirmed, leaves nothing of the account on screen or on the phone", async () => {
  const id = [...hub.accounts.keys()][0]!;
  const name = `sessionpipe.account.${id}`;
  expect(await databases()).toContain(name);
  await leaveTraces();
  await page.goto(`${server.url}/settings?section=data`);
  await expect(page.getByText(/Connected as me@example\.com/).first()).toBeVisible();
  // What Disconnect removes, and what it does not, said before it is pressed.
  await expect(
    page.getByText(
      "Disconnect removes the account from this iPhone: its key, its sessions, labels and read marks, drafts and recent searches. The key keeps working until you revoke it on spacesheep: Settings → API keys.",
      { exact: false },
    ),
  ).toBeVisible();
  // The key was revoked in the test before: said as it is, with nothing to do here that is not here.
  await expect(page.getByText(/the key was revoked on spacesheep ·|the key was revoked on spacesheep\./)).toBeVisible();
  await expect(page.getByText(/disconnect and connect again/)).toHaveCount(0);
  const button = page.getByRole("button", { name: "Disconnect" });
  // The person says no in the app's own alert: nothing changes.
  hub.alert = () => false;
  await button.click();
  await expect(button).toBeEnabled();
  await expect(page.getByText(/Connected as me@example\.com/).first()).toBeVisible();
  expect(hub.accounts.size).toBe(1);
  expect(await databases()).toContain(name);
  expect(Object.keys(await stored())).toEqual(expect.arrayContaining(TRACES));
  // Yes: the window leaves the account for what the app shows with none, the welcome.
  hub.alert = () => true;
  await button.click();
  await expect(welcome()).toBeVisible();
  expect(hub.accounts.size).toBe(0);
  await expect(page.getByText("Fix the invoice webhook")).toHaveCount(0);
  await expect(page.getByText(/Connected as/)).toHaveCount(0);
  // Nothing of it is kept: not the sessions, not what was written beside them.
  await expect.poll(databases).not.toContain(name);
  const left = await stored();
  for (const key of TRACES) expect(left[key], key).toBeUndefined();
  expect(Object.keys(left).filter((k) => /draft|recent|hidden|account/.test(k))).toEqual([]);
  // The app's own settings are the person's, not the account's: they stay.
  expect(left["sessionpipe-gui.textSize"]).toBe("large");
  expect(left["sessionpipe-gui.settings"]).toBeTruthy();
});

test("an account that goes while no window shows it is cleaned up after by the next window that opens", async () => {
  // Connected again (as a connect leaves it), and shown.
  ss.revoked = false;
  const a = hub.add("me@example.com", ss.key);
  const name = `sessionpipe.account.${a.id}`;
  ss.push(started("s-notes", "Check the release notes", "Are the release notes up to date?", "They are."));
  await page.goto(server.url);
  await expect(page.getByText("Check the release notes").first()).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __sessionpipeAccount: { flushed(): Promise<void> } }).__sessionpipeAccount.flushed(),
  );
  expect(await databases()).toContain(name);
  await leaveTraces();
  // The window is elsewhere when the account leaves the phone (replaced by another
  // connect, removed by the hub): no page of the account runs to clean up.
  await page.goto("about:blank");
  hub.accounts.clear();
  hub.active = null;
  await page.goto(server.url);
  await expect(welcome()).toBeVisible();
  await expect.poll(databases).not.toContain(name);
  await expect.poll(async () => Object.keys(await stored()).filter((k) => TRACES.includes(k))).toEqual([]);
  expect((await stored())["sessionpipe-gui.textSize"]).toBe("large");
});

test("in all of it, nothing was asked of a GUI server, and the hub was asked for its doors only", async () => {
  expect(server.strays).toEqual([]);
  const doors = new Set(hub.log.map((l) => l.split(" ").slice(0, 2).join(" ")));
  expect([...doors].sort()).toEqual(
    [
      "GET /api/gui/device",
      "GET /api/sessionpipe/v1/relay",
      "GET /api/sessionpipe/v1/relay/jobs",
      "GET /api/sessionpipe/v1/relay/machines",
      `POST /api/machines/${MACHINE}/jobs`,
    ].filter((d) => doors.has(d)),
  );
  expect(hub.log.filter((l) => /not_a_door|bad_query|bad_body|not_signed|forbidden/.test(l))).toEqual([]);
  // Every request the server saw is the bundle, the hub's own, or a door.
  expect(server.seen.filter((r) => /^\w+ \/(api|themes|skins|attachments)\//.test(r))).toEqual([]);
});

test.describe("a phone that cannot sign, with no storage to keep the board in", () => {
  let ss2: FakeSpacesheep;
  let hub2: HubStandIn;
  let server2: AccountServer;
  let context2: BrowserContext;
  let page2: Page;

  test.beforeAll(async ({ browser }) => {
    ss2 = new FakeSpacesheep();
    ss2.machines = [
      {
        id: MACHINE,
        name: NAME,
        online: true,
        last_seen: Date.now(),
        agents: ["claude-code"],
        modes: ["waiter"],
        passkey_ids: ["a-passkey-made-on-spacesheep"],
        key_types: ["passkey", "device"],
      },
    ];
    const s = new Session("s-android");
    const named = { ...on, session: { ...on.session, title: "Read on an Android phone" } };
    ss2.push([
      s.ev("session.started", { source: "startup" }, named),
      s.ev("turn.started", { turn_id: "t1" }, named),
      s.ev("turn.transcript", { turn: 1, user: "Is the build green?", assistant: "It is." }, named),
      s.ev("turn.ended", { turn_id: "t1" }, named),
    ]);
    // Android as the contract will say it once the mode is on there: the signer answers
    // `status` and never signs.
    hub2 = new HubStandIn({
      upstream: { origin: "https://spacesheep.test", ask: (req) => ss2.handle(req) },
      platform: "android",
    });
    hub2.add("me@example.com", ss2.key);
    server2 = await startAccountServer({ web: WEB, hub: hub2 });
    context2 = await browser.newContext({
      viewport: { width: 390, height: 844 },
      storageState: { cookies: [], origins: [] },
    });
    await context2.addInitScript(fakeShell, { signer: "Sending from this phone comes in a later version" });
    // Storage that will not open, as in a private window.
    await context2.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", {
        value: {
          open() {
            throw new DOMException("The operation is insecure.", "SecurityError");
          },
        },
      });
    });
    page2 = await context2.newPage();
  });
  test.afterAll(async () => {
    await context2?.close();
    await server2?.close();
  });

  test("the board is there all the same, from memory, and the phone says once that it is not kept", async () => {
    await page2.goto(server2.url);
    await expect(page2.getByText("Read on an Android phone").first()).toBeVisible();
    await expect(page2.getByText("Sessions are not kept on this phone").first()).toBeVisible();
    const kept = await page2.evaluate(
      () =>
        (window as unknown as { __sessionpipeAccount: { view(): { cache: string } } }).__sessionpipeAccount.view()
          .cache,
    );
    expect(kept).toBe("memory");
  });

  test("it reads; where it would send, one line says why not and leads to the session on spacesheep", async () => {
    await page2.goto(`${server2.url}/s/claude-code/s-android`);
    await expect(page2.getByText("It is.").first()).toBeVisible();
    await expect(page2.getByLabel("Message for the next turn")).toBeDisabled();
    await expect(page2.getByText("Sending from this phone comes in a later version").first()).toBeVisible();
    const link = page2.locator("[data-elsewhere]");
    await expect(link).toHaveText("Open on spacesheep.test");
    await expect(link).toHaveAttribute("href", "https://spacesheep.test/sessions?s=s-android");
    expect(server2.strays).toEqual([]);
    expect(ss2.jobs).toEqual([]);
  });
});
