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
import { composer as composerOf } from "./helpers.js";

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
const composer = () => composerOf(page);

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
  // The shell reopens the window on the account it was told to show.
  await Promise.all([page.waitForEvent("load"), invoke("rx_select", { id: status.connect.receiver })]);
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
  // The reads spent of spacesheep's limit are written down as they are spent, in the page's
  // own storage: a reload or a kill loses none of them.
  const spent = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith("sessionpipe-gui.account.reads."));
    return key ? (JSON.parse(localStorage.getItem(key)!) as { reads: number[] }).reads.length : 0;
  });
  expect(spent).toBeGreaterThan(0);
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
  expect(
    await page.evaluate(() =>
      Object.keys((window as unknown as { __sessionpipeAccount: object }).__sessionpipeAccount).sort(),
    ),
    "what the page leaves for a test to read: nothing in it acts on the account",
  ).toEqual(["asked", "flushed", "subscribe", "view"]);
  const asked = await invoke<{ code: string; keyId: string }>("acct_device_ask", { id: [...hub.accounts.keys()][0]! });
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

test("a picture can't go to a computer reached through spacesheep yet: no paperclip, and a pasted one is answered under the field", async () => {
  const box = composer();
  await expect(box).toBeEnabled();
  await expect(page.locator("input[data-attach-input]")).toHaveCount(0);
  const line = page.locator(".ctl-foot[data-reason=pictures-off] .ctl-hint");
  await expect(line).toHaveCount(0);
  const prevented = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".ctl-ask textarea")!.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  // Nothing is taken, so nothing is prevented, and the line says why the picture did not go.
  expect(prevented).toBe(false);
  await expect(line).toHaveText(`Pictures can't be sent to ${NAME} through spacesheep from here yet.`);
  await expect(page.locator(".att-item")).toHaveCount(0);
  // It answers the paste; once the person writes on, it goes. (Nothing was asked of the hub
  // for it: the last test of this story reads every door that was.)
  await box.fill("In words, then");
  await expect(line).toHaveCount(0);
  await box.fill("");
});

test("a message whose answer never comes back is not said to be not sent: it went once, and its reply arrives", async () => {
  // spacesheep takes the message and its answer is lost on the way back to the phone.
  hub.unheard = 1;
  const before = ran.length;
  const box = composer();
  await box.fill("And the payout webhook?");
  await box.press("Enter");
  // The page asks again with the same signed bytes; spacesheep says it has it; the computer runs it once.
  await expect(page.getByText("Done: And the payout webhook?").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/not sent/i)).toHaveCount(0);
  expect(ran.slice(before).filter((c) => c.text === "And the payout webhook?")).toHaveLength(1);
  expect(hub.log.filter((l) => l.endsWith("/jobs timeout"))).toHaveLength(1);
  expect(ss.log.filter((l) => l.startsWith("POST /api/machines/")).length).toBeGreaterThanOrEqual(2);
  await expect(box).toHaveValue("");
});

test("a message nobody could hear the answer to: it may have been sent, its words and its send are held, and the app settles it", async () => {
  // spacesheep takes the message; that answer and the answers to both askings after it are lost.
  hub.unheard = 3;
  const before = ran.length;
  const jobs = ss.jobs.length;
  const box = composer();
  await box.fill("And the chargeback webhook?");
  await box.press("Enter");
  const line = page.getByText(
    "It may have been sent: spacesheep did not answer in time. Look at the session before you send it again.",
  );
  await expect(line).toBeVisible({ timeout: 15_000 });
  await expect(box).toHaveValue("And the chargeback webhook?");
  await expect(page.getByText(/not sent/i)).toHaveCount(0);
  // One more tap makes no second job: the send is held, with the same line.
  await box.press("Enter");
  await expect(line).toBeVisible();
  expect(ss.jobs.length - jobs).toBe(1);
  // The app asks again by itself and hears that spacesheep had it: the words leave the box and the line goes.
  await expect(box).toHaveValue("", { timeout: 20_000 });
  await expect(line).toHaveCount(0);
  await expect(page.getByText(/not sent/i)).toHaveCount(0);
  await expect(page.getByText("Done: And the chargeback webhook?").first()).toBeVisible();
  expect(ran.slice(before).filter((c) => c.text === "And the chargeback webhook?")).toHaveLength(1);
  expect(ss.jobs.length - jobs).toBe(1);
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

test("a message spacesheep held, with that answer lost: the held notice comes by itself, and one Confirm sends it once", async () => {
  test.setTimeout(150_000);
  const hold = () => ({
    status: 409,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "confirm",
      error: "Confirm with your passkey to send this: it deletes a whole folder.",
      why: "it deletes a whole folder",
    }),
  });
  // spacesheep holds the message; its answer is lost on the way back, and every asking again is held too.
  hub.unheard = 1;
  ss.sendAnswers.push(hold, hold, hold, hold, hold, hold);
  const before = ss.jobs.length;
  const box = composer();
  await box.fill("Delete the old exports folder.");
  await box.press("Enter");
  // While the first asking may still be running, nobody knows: the line says so, in the
  // words of the lost answer, and offers nothing to confirm.
  await expect(
    page.getByText(
      "It may have been sent: spacesheep did not answer in time. Look at the session before you send it again.",
    ),
  ).toBeVisible({ timeout: 15_000 });
  const notice = page.locator("[data-held]");
  await expect(notice).toHaveCount(0);
  expect(ss.jobs).toHaveLength(before);
  // Half a minute after the send began it is known: held, no job made. The notice comes by
  // itself, with the reason and the words, and the line is gone.
  await expect(notice).toBeVisible({ timeout: 80_000 });
  await expect(notice.locator("[data-held-why]")).toContainText("deletes a whole folder");
  await expect(notice.locator("[data-held-what]")).toHaveText("Delete the old exports folder.");
  await expect(page.getByText(/It may have been sent/)).toHaveCount(0);
  await expect(page.getByText(/not sent/i)).toHaveCount(0);
  expect(ss.jobs).toHaveLength(before);
  // One press: sent, once.
  await notice.locator("[data-held-confirm]").click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByText("Done: Delete the old exports folder.").first()).toBeVisible();
  expect(ss.jobs).toHaveLength(before + 1);
  await expect(box).toHaveValue("");
});

test("a permission question is answered from the inbox, and the computer gets the answer", async () => {
  const s = session("s-login");
  // Asked now, as a hook asks: an answer reaches it only while the hook waits (lib/answerWindow.ts).
  s.clock = Date.now() - 2_000;
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
  // The app's half is handed the session with its question (it took the list: the stand-in
  // refuses one over the hub's bounds), so a notification can be posted as for a receiver's.
  type Handed = { key: string; state: string; openAttentions: { attentionId: string; answerable: boolean }[] };
  await expect
    .poll(() => (hub.needs.at(-1)?.sessions as Handed[] | undefined)?.find((x) => x.key === "claude-code:s-login"))
    .toMatchObject({ state: "needs_you", openAttentions: [{ attentionId: "perm-1", kind: "permission" }] });
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

test("long turns read whole from what the phone holds: the newest reply at once, an older one on Show more", async () => {
  const s = session("s-long");
  const named = { ...on, session: { ...on.session, title: "Long turns" } };
  const reply = (last: string) => `${"The export now takes a fresh connection for each batch. ".repeat(88)}${last}`;
  ss.push([
    s.ev("session.started", { source: "startup" }, named),
    s.ev("turn.started", { turn_id: "t1" }, named),
    s.ev("turn.transcript", { turn: 1, user: "Read the export code.", assistant: reply("OLDEND") }, named),
    s.ev("turn.ended", { turn_id: "t1" }, named),
    s.ev("turn.started", { turn_id: "t2" }, named),
    s.ev(
      "turn.transcript",
      { turn: 2, user: `${"Batch 7 failed: connection reset by peer. ".repeat(35)}LOGEND`, assistant: reply("NEWEND") },
      named,
    ),
    s.ev("turn.ended", { turn_id: "t2" }, named),
  ]);
  await expect(page.getByText("Long turns").first()).toBeVisible();
  await page.goto(`${server.url}/s/claude-code/s-long`);
  const cards = page.locator(".timeline li.reply, .timeline .chat-card");
  // The newest reply whole as it opens, and a message of 1,500 characters whole (folded).
  await expect(cards.nth(1)).toContainText("NEWEND");
  await expect(cards.nth(1).locator(".reply-more")).toHaveCount(0);
  await expect(page.locator(".timeline blockquote").nth(1)).toContainText("LOGEND");
  // The older reply ends in "…"; "Show more" brings the rest from what the phone holds.
  await expect(cards.nth(0)).not.toContainText("OLDEND");
  await cards.nth(0).getByRole("button", { name: "Show more" }).click();
  await expect(cards.nth(0)).toContainText("OLDEND");
  await expect(cards.nth(0).locator(".reply-more")).toHaveCount(0);
  await expect(page.getByText(/A preview of/)).toHaveCount(0);
  await page.goto(server.url);
  await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
});

test("New session offers only the folders spacesheep takes: a session's `~/…` folder is not among them, and Start sends a full path; so do New session here and Ask another agent from that session", async () => {
  // The computer takes starts of two agents, and its agents can ask each other. spacesheep
  // checks a start's folder against the computer's folders, which are full paths, and
  // refuses a `~/…` one.
  const start = { permissions: ["read", "safe"], permission: "safe" };
  Object.assign(ss.machines[0]!, {
    agents: ["claude-code", "codex"],
    ask: true,
    handoff: true,
    start: { "claude-code": start, codex: start },
  });
  // The account's newest session, in `~/notes`.
  const s = new Session("s-notes", "claude-code", Date.now() - 5000);
  const notes = { ...on, session: { machine: NAME, cwd: "~/notes", title: "Sort the notes" } };
  ss.push([
    s.ev("session.started", { source: "startup" }, notes),
    s.ev("turn.started", { turn_id: "t1" }, notes),
    s.ev("turn.transcript", { turn: 1, user: "Sort the notes by date.", assistant: "Sorted." }, notes),
    s.ev("turn.ended", { turn_id: "t1" }, notes),
  ]);
  try {
    await page.goto(server.url);
    await expect(page.getByText("Sort the notes").first()).toBeVisible();
    await page.locator(".page.board .compose-btn--phone").click();
    const sheet = page.locator("[data-new-session]");
    await expect(sheet.locator("[data-ns-row=permission]")).toBeVisible();
    // The newest session's folder is `~/notes`: the sheet picks the newest full path instead,
    // and offers only full paths.
    const folder = sheet.locator("[data-ns-row=folder] button.sel");
    await expect(folder).toHaveAttribute("data-value", "/Users/me/billing");
    await folder.click();
    const opts = page.locator(".sel-sheet .sel-opt");
    await expect(opts.first()).toBeVisible();
    expect(await opts.allTextContents()).toEqual([
      expect.stringContaining("/Users/me/billing"),
      expect.stringContaining("/Users/me"),
    ]);
    await expect(page.locator(".sel-sheet").getByText("~/notes")).toHaveCount(0);
    await opts.first().click();
    await expect(page.locator(".sel-sheet")).toHaveCount(0);
    let before = ran.length;
    await sheet.locator("[data-ns-text]").fill("Add a test for the rounding.");
    await sheet.locator(".ns-bar [data-ns-start]").click();
    await expect(page).toHaveURL(/\/s\/claude-code\//);
    await expect
      .poll(() => ran.slice(before).find((c) => c.kind === "start"))
      .toMatchObject({
        kind: "start",
        cwd: "/Users/me/billing",
        text: "Add a test for the rounding.",
      });
    expect(ss.jobs.filter((j) => j.action === "start" && j.status === "done")).toHaveLength(1);

    // Ask another agent from the session in `~/notes`, which is inside `/Users/me` though this
    // page can't tell: the folder is one of the computer's own, and nothing says the
    // session's is not allowed.
    await page.goto(`${server.url}/s/claude-code/s-notes`);
    await expect(page.getByText("Sorted.").first()).toBeVisible();
    await page.locator("[data-ctl-ask]").click();
    const ask = page.locator("[data-handoff]");
    await expect(ask.locator("[data-hs-row=agent] button.sel")).toContainText("Codex · new session");
    await expect(ask.locator("[data-hs-row=folder] button.sel")).toHaveAttribute("data-value", "/Users/me");
    await expect(ask.getByText(/isn't allowed|needs the full path/)).toHaveCount(0);
    before = ran.length;
    await ask.locator("[data-hs-text]").fill("Check the notes for dates.");
    await ask.locator("[data-hs-ask]").click();
    await expect(ask).toHaveCount(0);
    await expect
      .poll(() => ran.slice(before).find((c) => c.kind === "start"))
      .toMatchObject({ kind: "start", cwd: "/Users/me", text: "Check the notes for dates." });
    expect(String(ran.slice(before).find((c) => c.kind === "start")!.session)).toMatch(/^codex:/);

    // New session here: the session's agent, and a folder that can start, not `~/notes`.
    await page.getByRole("button", { name: "More actions" }).first().click();
    await page.getByRole("menuitem", { name: "New session here" }).click();
    await expect(sheet.locator("[data-ns-row=permission]")).toBeVisible();
    await expect(folder).toHaveAttribute("data-value", "/Users/me/billing");
    await expect(sheet.getByText(/needs the full path/)).toHaveCount(0);
    await sheet.locator("[data-ns-text]").fill("Date the notes.");
    await expect(sheet.locator(".ns-bar [data-ns-start]")).toBeEnabled();
    await sheet.locator("[data-ns-cancel]").click();
    await expect(sheet).toHaveCount(0);
  } finally {
    for (const k of ["ask", "handoff", "start"]) delete ss.machines[0]![k];
    ss.machines[0]!.agents = ["claude-code"];
  }
  await page.goto(server.url);
  await expect(page.getByText("Fix the invoice webhook").first()).toBeVisible();
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
  // (The read that was out when the room filled may bring the session before any is refused.)
  await expect.poll(() => hub.log.filter((l) => l.endsWith(" busy")).length).toBeGreaterThanOrEqual(3);
  expect((await view()).relay.state).toBe("ok");

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
    // The backend is up (it leaves its hook), then what the page asks as it loads has landed.
    await page.waitForFunction(() => "__sessionpipeAccount" in window);
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
/** What a person leaves behind while the account's sessions are on screen (a draft, a hidden
 *  session, an opened agent, a search), and what the same phone keeps of a GUI server's
 *  sessions, shown in another window of the app over the same storage. */
const leaveTraces = (): Promise<void> =>
  page.evaluate(() => {
    localStorage.setItem("sessionpipe-gui.draft:claude-code:s-invoice", "half a message about the webhook");
    localStorage.setItem("sessionpipe-gui.draft:claude-code:home-1", "a draft on the receiver at home");
    localStorage.setItem(
      "sessionpipe-gui.hidden",
      JSON.stringify({ "claude-code:s-invoice": "2026-01-01T00:00:00Z", "claude-code:home-2": "2026-01-01T00:00:00Z" }),
    );
    localStorage.setItem(
      "sessionpipe-gui.agentsOpen",
      JSON.stringify([
        ["claude-code:s-invoice", true],
        ["claude-code:home-1", true],
      ]),
    );
    localStorage.setItem("sp.search.recent", JSON.stringify(["invoice webhook"]));
    localStorage.setItem("sessionpipe.workflows.mine", JSON.stringify(["run-at-home"]));
    localStorage.setItem("sessionpipe-gui.textSize", "large");
  });
const TRACES = ["sessionpipe-gui.draft:claude-code:s-invoice", "sp.search.recent"];
const welcome = () => page.locator(".onb[data-step='welcome']");

test("Disconnect in Settings, once confirmed, leaves nothing of the account on screen or on the phone", async () => {
  const id = [...hub.accounts.keys()][0]!;
  const name = `sessionpipe.account.${id}`;
  expect(await databases()).toContain(name);
  await leaveTraces();
  // On the phone the account is Settings › App's own group (account/AccountSettings.tsx).
  await page.goto(`${server.url}/settings?section=app`);
  const group = page.locator("[data-account-settings]");
  await expect(group.getByText("me@example.com")).toBeVisible();
  // What Disconnect removes, and what it does not, said before it is pressed.
  await expect(
    group.getByText(
      "Disconnect removes the account from this iPhone: its key, its sessions, labels and read marks, drafts and recent searches. The key keeps working until you revoke it on spacesheep: Settings → API keys.",
    ),
  ).toBeVisible();
  // The key was revoked in the test before: said as it is, with the way to mend it beside it.
  await expect(group.locator(".acct-state--warn").first()).toHaveText("The key was revoked on spacesheep");
  await expect(page.getByText(/disconnect and connect again/)).toHaveCount(0);
  const button = group.locator("[data-disconnect]");
  // The person says no in the app's own alert: nothing changes.
  hub.alert = () => false;
  await button.click();
  await expect(button).toBeEnabled();
  await expect(group.getByText("me@example.com")).toBeVisible();
  expect(hub.accounts.size).toBe(1);
  expect(await databases()).toContain(name);
  expect(Object.keys(await stored())).toEqual(expect.arrayContaining(TRACES));
  // Yes: the window leaves the account, says what became of the key, then is the welcome.
  hub.alert = () => true;
  await button.click();
  await expect(page.locator(".onb[data-step='account-disconnected']")).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(welcome()).toBeVisible();
  expect(hub.accounts.size).toBe(0);
  await expect(page.getByText("Fix the invoice webhook")).toHaveCount(0);
  await expect(page.getByText("me@example.com")).toHaveCount(0);
  // Nothing of it is kept: not the sessions, not what was written beside them.
  await expect.poll(databases).not.toContain(name);
  const left = await stored();
  for (const key of TRACES) expect(left[key], key).toBeUndefined();
  expect(Object.keys(left).filter((k) => k.startsWith("sessionpipe-gui.account."))).toEqual([]);
  expect(JSON.stringify(left)).not.toContain("s-invoice");
  // What the phone keeps of a GUI server's sessions is not the account's: it is all still there.
  expect(left["sessionpipe-gui.draft:claude-code:home-1"]).toBe("a draft on the receiver at home");
  expect(JSON.parse(left["sessionpipe-gui.hidden"]!)).toEqual({ "claude-code:home-2": "2026-01-01T00:00:00Z" });
  expect(JSON.parse(left["sessionpipe-gui.agentsOpen"]!)).toEqual([["claude-code:home-1", true]]);
  expect(left["sessionpipe.workflows.mine"]).toBe('["run-at-home"]');
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
  await page.evaluate(() => localStorage.setItem("sessionpipe-gui.draft:claude-code:s-notes", "a note to self"));
  // The window is elsewhere when the account leaves the phone (replaced by another
  // connect, removed by the hub): no page of the account runs to clean up.
  await page.goto("about:blank");
  hub.accounts.clear();
  hub.active = null;
  await page.goto(server.url);
  await expect(welcome()).toBeVisible();
  // The hub is asked twice, a few seconds apart, before anything is removed on its word.
  expect(await databases()).toContain(name);
  await expect.poll(databases, { timeout: 15_000 }).not.toContain(name);
  // What the storage keeps of its sessions goes with it: they are read from what was kept of them.
  await expect
    .poll(async () => (await stored())["sessionpipe-gui.draft:claude-code:s-notes"], { timeout: 15_000 })
    .toBeUndefined();
  const left = await stored();
  // What is no session's was nobody's to remove from here (nobody disconnected it in its window),
  // and what the phone keeps of a GUI server's sessions is that server's.
  expect(left["sp.search.recent"]).toBe('["invoice webhook"]');
  expect(left["sessionpipe-gui.draft:claude-code:home-1"]).toBe("a draft on the receiver at home");
  expect(JSON.parse(left["sessionpipe-gui.hidden"]!)).toMatchObject({ "claude-code:home-2": "2026-01-01T00:00:00Z" });
  expect(left["sessionpipe-gui.textSize"]).toBe("large");
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

test.describe("an account with nothing on it yet, then a session from a computer that is not paired", () => {
  let ss3: FakeSpacesheep;
  let hub3: HubStandIn;
  let server3: AccountServer;
  let context3: BrowserContext;
  let page3: Page;

  test.beforeAll(async ({ browser }) => {
    ss3 = new FakeSpacesheep();
    ss3.machines = [
      {
        id: MACHINE,
        name: NAME,
        online: true,
        last_seen: Date.now(),
        folders: ["/Users/me"],
        agents: ["claude-code"],
        modes: ["waiter"],
        passkey_ids: ["a-passkey-made-on-spacesheep"],
        key_types: ["passkey", "device"],
        start: { "claude-code": { permissions: ["default"] } },
      },
    ];
    hub3 = new HubStandIn({ upstream: { origin: "https://spacesheep.test", ask: (req) => ss3.handle(req) } });
    hub3.add("me@example.com", ss3.key);
    server3 = await startAccountServer({ web: WEB, hub: hub3 });
    context3 = await browser.newContext({
      viewport: { width: 390, height: 844 },
      storageState: { cookies: [], origins: [] },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await context3.addInitScript(fakeShell, {});
    page3 = await context3.newPage();
  });
  test.afterAll(async () => {
    await context3?.close();
    await server3?.close();
  });

  test("a first launch that meets spacesheep's limit says so, and says nothing of there being no sessions", async () => {
    // spacesheep asks this key to wait before the account was read once.
    ss3.limit = 0;
    await page3.goto(server3.url);
    await expect(page3.getByText("This app is reading too often for spacesheep")).toBeVisible();
    await expect(page3.getByText("It catches up by itself.")).toBeVisible();
    await expect(page3.getByText("Waiting for your first session")).toHaveCount(0);
    await expect(page3.getByText(/Start an agent on a computer paired/)).toHaveCount(0);
    // Nothing is arriving, and nothing is to be retried: the limit's line stands alone, with
    // neither "live" nor "Reconnecting…" and its Retry beside it.
    await expect(page3.locator(".conn--live")).toHaveCount(0);
    await expect(page3.locator("text=Reconnecting… >> visible=true")).toHaveCount(0);
    await expect(page3.locator("text=/^Retry/ >> visible=true")).toHaveCount(0);
    // The wait is over by the next launch: the account is read, and it is empty.
    ss3.limit = 240;
  });

  test("the empty board says nothing of a terminal on this machine, a command to type, or sample sessions", async () => {
    await page3.goto(server3.url);
    await expect(page3.getByText("Waiting for your first session")).toBeVisible();
    await expect(
      page3.getByText("Start an agent on a computer paired with this account and it appears here."),
    ).toBeVisible();
    // A session can be started on the paired computer: the one way on.
    await expect(page3.getByRole("button", { name: `Start a session on ${NAME}` })).toBeVisible();
    for (const false_ of [/in any terminal/, /on this machine/, /^claude$/, /Listening/, /sample sessions/, /npx /])
      await expect(page3.getByText(false_)).toHaveCount(0);
    await expect(page3.getByRole("link", { name: /Pair another machine/ })).toHaveCount(0);
    expect(server3.strays).toEqual([]);
  });

  test("where a computer is not paired, the way on is the session on spacesheep, not a page this app does not have", async () => {
    const s = new Session("s-unpaired");
    const from = {
      tier: 2 as const,
      session: { machine: "attic-linux", cwd: "/home/me/notes", title: "Tidy the notes" },
    };
    ss3.push([
      s.ev("session.started", { source: "startup" }, from),
      s.ev("turn.started", { turn_id: "t1" }, from),
      s.ev(
        "turn.transcript",
        {
          turn: 1,
          // An image a receiver was holding when this was sent from its own page.
          user: "Tidy the notes folder. /attachments/01HZX5M3K9Q2W8RTY4N6P7VBCD.png",
          assistant: "Tidied.",
        },
        from,
      ),
      s.ev("turn.ended", { turn_id: "t1" }, from),
    ]);
    await expect(page3.getByText("Tidy the notes").first()).toBeVisible();
    await page3.goto(`${server3.url}/s/claude-code/s-unpaired`);
    await expect(page3.getByText("Tidied.").first()).toBeVisible();
    await expect(page3.getByText(/How to pair/)).toHaveCount(0);
    // The image is the receiver's, not the relay's: no thumbnail, and nothing asked for.
    await expect(page3.locator("[data-attachment-thumbs]")).toHaveCount(0);
    await expect(page3.locator("img[src*='/attachments/']")).toHaveCount(0);
    expect(hub3.log.filter((l) => l.includes("/attachments/"))).toEqual([]);
    expect(server3.seen.filter((r) => r.includes("/attachments/"))).toEqual([]);
    const link = page3.locator("[data-elsewhere]").first();
    await expect(link).toHaveText("Open on spacesheep.test");
    await expect(link).toHaveAttribute("href", "https://spacesheep.test/sessions?s=s-unpaired");
    // The link a person copies is the session's page on spacesheep, the one address it has.
    await page3.getByRole("button", { name: "More actions" }).first().click();
    await page3.getByRole("menuitem", { name: "Copy" }).click();
    await page3.getByRole("menuitem", { name: "Link" }).click();
    await expect
      .poll(() => page3.evaluate(() => navigator.clipboard.readText()))
      .toBe("https://spacesheep.test/sessions?s=s-unpaired");
    // Machines: no command to pair it with a receiver that is not there.
    await page3.goto(`${server3.url}/machines`);
    await expect(page3.getByText("attic-linux").first()).toBeVisible();
    await expect(page3.getByText(/sessionpipe control pair/)).toHaveCount(0);
    await expect(page3.getByText("Pair it")).toHaveCount(0);
    expect(server3.strays).toEqual([]);
  });

  test("at the next launch what the phone took more than a week ago is gone, and an old date on today's arrival is not", async () => {
    // An outbox drained late: a session whose events are dated ten days ago, arriving now.
    const late = new Session("s-late", "claude-code", Date.now() - 10 * 86_400_000);
    const from = { tier: 2 as const, session: { machine: NAME, cwd: "/Users/me/old", title: "Drained late" } };
    ss3.push([
      late.ev("session.started", { source: "startup" }, from),
      late.ev("turn.transcript", { turn: 1, user: "From last week.", assistant: "Arrived today." }, from),
    ]);
    const kept = () =>
      page3.evaluate(
        () =>
          (
            window as unknown as { __sessionpipeAccount: { view(): { store: { sessions: number } } } }
          ).__sessionpipeAccount.view().store.sessions,
      );
    await page3.goto(server3.url);
    await expect(page3.getByText("Tidy the notes").first()).toBeVisible();
    // (A session whose last event is ten days old is done: it is under the folded Done group.)
    await expect.poll(kept).toBe(2);
    await page3.evaluate(() =>
      (window as unknown as { __sessionpipeAccount: { flushed(): Promise<void> } }).__sessionpipeAccount.flushed(),
    );
    // The page that brought "Tidy the notes" was taken eight days ago (its events' own dates are today's).
    const pages = await page3.evaluate(async () => {
      const name = (await indexedDB.databases()).find((d) => d.name?.startsWith("sessionpipe.account."))!.name!;
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const o = indexedDB.open(name);
        o.onsuccess = () => res(o.result);
        o.onerror = () => rej(o.error);
      });
      const tx = db.transaction("pages", "readwrite");
      const store = tx.objectStore("pages");
      const [keys, values] = await Promise.all([
        new Promise<IDBValidKey[]>((res) => {
          const r = store.getAllKeys();
          r.onsuccess = () => res(r.result);
        }),
        new Promise<{ session: { id: string }; arrivedAt: string }[][]>((res) => {
          const r = store.getAll();
          r.onsuccess = () => res(r.result);
        }),
      ]);
      const then = new Date(Date.now() - 8 * 86_400_000).toISOString();
      let aged = 0;
      keys.forEach((key, i) => {
        if (!values[i]!.some((e) => e.session.id === "s-unpaired")) return;
        store.put(
          values[i]!.map((e) => ({ ...e, arrivedAt: then })),
          key,
        );
        aged++;
      });
      await new Promise<void>((res) => {
        tx.oncomplete = () => res();
      });
      db.close();
      return { all: keys.length, aged };
    });
    expect(pages.all).toBeGreaterThan(1);
    expect(pages.aged).toBe(1);
    // From what is kept alone: spacesheep cannot be reached.
    hub3.down = true;
    await page3.goto(`${server3.url}/s/claude-code/s-late`);
    await expect(page3.getByText("Arrived today.").first()).toBeVisible();
    expect(await kept()).toBe(1);
    await page3.goto(server3.url);
    await expect(page3.getByText("Done").first()).toBeVisible();
    await expect(page3.getByText("Tidy the notes")).toHaveCount(0);
    hub3.down = false;
  });
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
    await expect(composerOf(page2)).toBeDisabled();
    await expect(page2.getByText("Sending from this phone comes in a later version").first()).toBeVisible();
    const link = page2.locator("[data-elsewhere]");
    await expect(link).toHaveText("Open on spacesheep.test");
    await expect(link).toHaveAttribute("href", "https://spacesheep.test/sessions?s=s-android");
    expect(server2.strays).toEqual([]);
    expect(ss2.jobs).toEqual([]);
  });
});
