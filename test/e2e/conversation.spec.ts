// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// One conversation, drawn once, in order: a message sent from the session page and the
// turn it became are the same block, whichever of the two records says so first. The
// machine is a fake daemon (control-helpers.ts) that takes each signed message and is told
// here what to ack, and the session's hooks are posted as sessionpipe 0.13.4 to 0.13.6
// send them: a message handed to a terminal session at its Stop (an `injected` transcript
// and no `turn.started`), two messages queued, a refused message and then the same words
// typed at the terminal, a turn stopped mid-text and one stopped before its first word.
// Against the second e2e instance (test door on, rp id localhost).
import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { CONTROL_BASE, type FakeDaemon, fakeDaemon, type PageKey, passkeyPage, sinkToken } from "./control-helpers.js";
import { ulid } from "./helpers.js";

test.describe.configure({ mode: "serial" });
test.skip(({ isMobile }) => isMobile, "desktop project");

const tag = () => randomUUID().slice(0, 6);
const nums = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join("\n");
const count = (w: string) =>
  `Do not use any tools. Write the numbers 1 to 1500, one per line, and then on the last line just the word ${w} in capital letters`;
const word = (w: string) => `Reply with just the word ${w} in capital letters`;
const NOTE = "(The turn was cancelled.)";
const NONE = "No response requested.";
const CWD = "/Users/e2e/code";

/** A machine on sessionpipe 0.13: Claude Code, one folder. Its prompts are acked by the
 *  test; a Stop is acked as the daemon acks one for a turn it runs itself (CONTROL.md §6). */
const machine = (key: PageKey, name: string) =>
  fakeDaemon(
    key,
    { name, harnesses: ["claude-code"], folders: [CWD], mode: "auto", version: "0.13.6" },
    {
      script: (c) =>
        c.kind === "cancel"
          ? {
              pauseMs: 50,
              acks: [
                { outcome: "taken" },
                {
                  outcome: "delivered",
                  mode: "resume",
                  detail: "stopped the turn this computer was running for that session",
                },
              ],
            }
          : { acks: [] },
    },
  );

/** One session's hook events, as its machine's sink posts them, on the machine's own clock:
 *  it never runs backwards, and a prompt's hook runs a tenth of a second after the harness
 *  wrote the prompt down (so a turn's `turn.started` is dated that much after the `at` its
 *  transcript carries, as on a real machine). */
class Hooks {
  readonly id = randomUUID();
  /** The exchanges sent so far: the number the next `turn.transcript` carries. */
  turn = 0;
  private seq = 0;
  private clock = 0;
  constructor(
    private readonly sink: string,
    private readonly name: string,
    private readonly title: string,
  ) {}
  get key(): string {
    return `claude-code:${this.id}`;
  }
  /** The machine's time now, or at `at` when that is later than its last event. */
  now(at = Date.now()): number {
    this.clock = Math.max(at, this.clock + 1);
    return this.clock;
  }
  private ev(type: string, data: Record<string, unknown>, at: number) {
    return {
      protocol: 1,
      id: ulid(at),
      type,
      time: new Date(at).toISOString(),
      tier: 2,
      harness: { name: "claude-code", version: "2.1.322", event: "Hook" },
      session: {
        id: this.id,
        seq: this.seq++,
        machine: this.name,
        cwd: CWD,
        title: this.title,
        title_source: "custom",
      },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  }
  /** Posts events dated now (each a millisecond after the last), or at `at`. */
  async post(events: [type: string, data: Record<string, unknown>][], at?: number): Promise<void> {
    const res = await fetch(`${CONTROL_BASE}/api/sessionpipe/v1/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.sink}`,
        "sessionpipe-protocol": "1",
      },
      body: JSON.stringify({ events: events.map(([type, data]) => this.ev(type, data, this.now(at))) }),
    });
    expect([200, 202]).toContain(res.status);
  }
  /** A turn begins: the prompt is written down, then its hook sends the `turn.started` and
   *  the prompt's first reading. Returns the `at` the turn's transcript will carry. */
  async begin(turnId: string, user: string, at?: number): Promise<string> {
    const written = this.now(at);
    const iso = new Date(written).toISOString();
    await this.post(
      [
        ["turn.started", { turn_id: turnId, prompt_chars: user.length }],
        ["turn.progress", { turn: this.turn, user, assistant: "", at: iso }],
      ],
      written + 120,
    );
    return iso;
  }
  /** It ends at its Stop, and its exchange goes out. */
  async end(turnId: string, user: string, assistant: string, at: string): Promise<void> {
    await this.post([
      ["turn.ended", { turn_id: turnId, reason: "stop" }],
      ["turn.transcript", { turn: this.turn++, user, assistant, at }],
    ]);
  }
}

const timeline = (page: Page) => page.locator(".page.session ol.timeline");
/** The timeline's blocks that hold a prompt, in the order drawn: turns and messages on their way. */
const blocks = (page: Page) =>
  timeline(page)
    .locator("> li.turn")
    .filter({ has: page.locator("blockquote") });
const block = (page: Page, prompt: string) =>
  timeline(page)
    .locator("> li.turn")
    .filter({ has: page.locator("blockquote", { hasText: prompt }) });
const REPLY = "li.reply, .chat-card";
const stoppedRow = (turn: Locator) => turn.locator('.status-row[data-sent-state="stopped"]');
/** How many times `words` is drawn in the timeline. */
const drawn = async (page: Page, words: string) =>
  ((await timeline(page).innerText()).match(new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? [])
    .length;

/** The session's page, open and live, with a finished turn typed at the terminal. What a
 *  test needs there before the page opens (`before`) is posted first, so the page reads it
 *  with its first load; everything after follows a signed send, long after that load. */
async function openSession(
  page: Page,
  sink: string,
  name: string,
  title: string,
  before?: (s: Hooks) => Promise<void>,
): Promise<Hooks> {
  const s = new Hooks(sink, name, title);
  const t0 = Date.now() - 600_000;
  await s.post([["session.started", { source: "startup" }]], t0);
  const at = await s.begin("t-first", "start", t0 + 1000);
  await s.post(
    [
      ["turn.ended", { turn_id: "t-first", reason: "stop" }],
      ["turn.transcript", { turn: s.turn++, user: "start", assistant: "Started.", at }],
    ],
    t0 + 9000,
  );
  await before?.(s);
  await page.goto(`${CONTROL_BASE}/s/claude-code/${s.id}`);
  await expect(page.locator(".conn").first()).toHaveText("live");
  await expect(page.getByLabel("Message for the next turn")).toBeEnabled();
  await expect(block(page, "start").locator(REPLY)).toHaveText("Started.");
  return s;
}

/** Sends `text` from the composer; resolves to the message's id once the receiver holds it. */
async function send(page: Page, s: Hooks, text: string): Promise<string> {
  const box = page.getByLabel("Message for the next turn");
  await box.fill(text);
  await box.press("Enter");
  await expect(box).toHaveValue("");
  let id = "";
  await expect
    .poll(
      async () => {
        const r = (await (await fetch(`${CONTROL_BASE}/api/ui/control/activity?limit=50`)).json()) as {
          activity: { id: string; kind: string; session?: string; text?: string }[];
        };
        id = r.activity.find((a) => a.kind === "prompt" && a.session === s.key && a.text === text)?.id ?? "";
        return id;
      },
      { timeout: 20_000 },
    )
    .not.toBe("");
  return id;
}

/** The machine's ack for one message, as its daemon posts it. */
async function ack(m: FakeDaemon, id: string, a: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${CONTROL_BASE}/api/sessionpipe/v1/control/ack`, {
    method: "POST",
    headers: { authorization: `Bearer ${m.token}`, "content-type": "application/json" },
    body: JSON.stringify({ acks: [{ id, at: new Date().toISOString(), ...a }] }),
  });
  expect(res.status).toBe(202);
}

async function device(context: BrowserContext, mode: "advanced" | "simple"): Promise<void> {
  await context.addInitScript((m) => {
    localStorage.setItem("sessionpipe-gui.setup.seen", "1");
    localStorage.setItem("sessionpipe-gui.settings", JSON.stringify({ mode: m }));
  }, mode);
}

let sink: string;
const daemons: FakeDaemon[] = [];
test.afterAll(async () => {
  await Promise.all(daemons.map((d) => d.stop()));
});
async function setup(context: BrowserContext, page: Page, o: { mode?: "advanced" | "simple"; name: string }) {
  await device(context, o.mode ?? "advanced");
  const key = await passkeyPage(context, page);
  sink ??= await sinkToken();
  const m = await machine(key, o.name);
  daemons.push(m);
  return m;
}

test("a message into a running terminal turn is handed over at its Stop: both exchanges, once, in order", async ({
  context,
  page,
}) => {
  const SLEEP =
    "Run `sleep 25` in bash, then read docs/api.md and say one sentence about it, then end with the word LONGDONE.";
  const WAITING = "sleep 25 is running in the background. I'll read docs/api.md once it finishes.";
  const ASK = "Reply with only the word INTERRUPT1.";
  const name = `cv-stop-${tag()}`;
  const m = await setup(context, page, { name });
  // The person typed a prompt at the terminal a minute and a half ago; it is still running.
  let typedAt = "";
  const s = await openSession(page, sink, name, `Handed over ${name}`, async (h) => {
    typedAt = await h.begin("t-typed", SLEEP, Date.now() - 90_000);
  });
  const typed = block(page, "sleep 25");
  await expect(typed.locator(".turn-n")).toHaveText("Turn 2");

  // The message waits for that turn's Stop: under the running turn, on its way.
  const id = await send(page, s, ASK);
  await expect(blocks(page)).toHaveCount(3);
  await expect(blocks(page).nth(1).locator("blockquote")).toContainText("sleep 25");
  await expect(blocks(page).nth(2).locator("blockquote")).toHaveText(ASK);
  await expect(blocks(page).nth(2).locator(".status-row")).toHaveAttribute("data-sent-state", "queued");

  // The Stop hook hands it over: the typed turn's exchange goes out, the session answers
  // the message, and stops again. No `turn.started` for it; its transcript says `injected`.
  await ack(m, id, { outcome: "taken", mode: "turn" });
  await expect(blocks(page).nth(2).locator(".status-row")).toHaveAttribute("data-sent-state", "taken");
  await s.end("t-typed", SLEEP, WAITING, typedAt);
  const handedAt = new Date(s.now()).toISOString();
  await s.post([
    ["turn.ended", { turn_id: "t-typed", reason: "stop" }],
    ["turn.transcript", { turn: s.turn++, user: ASK, assistant: "INTERRUPT1", at: handedAt, injected: true }],
  ]);
  await ack(m, id, { outcome: "delivered", mode: "turn", reply: "INTERRUPT1" });

  // The typed turn keeps its prompt and its reply; the message is the exchange after it,
  // which the harness counts as the same turn; nothing is drawn twice, nothing is on its way.
  const handed = block(page, ASK);
  await expect(handed.locator(".turn-n")).toHaveText("Turn 2, continued");
  await expect(handed.locator(REPLY)).toHaveText("INTERRUPT1");
  await expect(typed.locator(".turn-n")).toHaveText("Turn 2");
  await expect(typed.locator(REPLY)).toHaveText(WAITING);
  await expect(blocks(page)).toHaveCount(3);
  await expect(blocks(page).nth(1).locator("blockquote")).toContainText("sleep 25");
  await expect(blocks(page).nth(2).locator("blockquote")).toContainText(ASK);
  await expect(timeline(page).locator(".status-row")).toHaveCount(0);
  for (const words of ["sleep 25 is running", "INTERRUPT1.", "Reply with only the word"])
    expect(await drawn(page, words), words).toBe(1);
  expect(await drawn(page, "INTERRUPT1")).toBe(2);

  // Under a lens that leaves transcripts out, the message sent from here keeps its row.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await expect(page.locator(".sess-lens")).toBeVisible();
  await expect(blocks(page).filter({ hasText: ASK })).toHaveCount(1);
  await expect(block(page, ASK).locator(".turn-n")).toHaveText("Turn 2, continued");
});

test("two messages queued: the running turn sits under the message it answers, the waiting one below", async ({
  context,
  page,
}) => {
  const ONE =
    "Write the numbers 1 to 20, one per line, and then on the last line just the word golf1 in capital letters";
  const TWO = word("golf2");
  const name = `cv-queue-${tag()}`;
  const m = await setup(context, page, { name });
  const s = await openSession(page, sink, name, `Queued ${name}`);
  const first = await send(page, s, ONE);
  const second = await send(page, s, TWO);
  // Both on their way, in the order sent.
  await expect(blocks(page)).toHaveCount(3);
  await expect(blocks(page).nth(1).locator("blockquote")).toHaveText(ONE);
  await expect(blocks(page).nth(2).locator("blockquote")).toHaveText(TWO);

  // The machine runs the first; the second waits behind it.
  await ack(m, first, { outcome: "taken", mode: "resume" });
  await ack(m, second, { outcome: "taken", mode: "resume" });
  const at1 = await s.begin("t-one", ONE);
  const one = block(page, "golf1");
  const two = block(page, "golf2");
  await expect(one.locator(".turn-n")).toHaveText("Turn 2");
  await expect(one.locator(".status-row")).toHaveAttribute("data-sent-state", "running");
  await expect(two.locator(".status-row")).toHaveAttribute("data-sent-state", "taken");
  await expect(blocks(page)).toHaveCount(3);
  await expect(blocks(page).nth(1).locator("blockquote")).toHaveText(ONE);
  await expect(blocks(page).nth(2).locator("blockquote")).toHaveText(TWO);
  // What it streams is drawn in the running turn, once.
  await ack(m, first, { outcome: "progress", mode: "resume", reply: nums(7), seq: 1 });
  await expect(one.locator(REPLY)).toHaveCount(1);
  await expect(one.locator(REPLY)).toContainText("7");
  await expect(two.locator(REPLY)).toHaveCount(0);

  // The first ends (the ack's reply is the turn's last piece of text; the transcript has
  // every piece), and the second runs: under its own message.
  await ack(m, first, { outcome: "delivered", mode: "resume", reply: `${nums(20)}\nGOLF1` });
  await s.end("t-one", ONE, `Here they are.\n\n${nums(20)}\nGOLF1`, at1);
  const at2 = await s.begin("t-two", TWO);
  await expect(two.locator(".turn-n")).toHaveText("Turn 3");
  await expect(two.locator(".status-row")).toHaveAttribute("data-sent-state", "running");
  await expect(one.locator(".status-row")).toHaveCount(0);
  await ack(m, second, { outcome: "delivered", mode: "resume", reply: "GOLF2" });
  await s.end("t-two", TWO, "GOLF2", at2);

  await expect(two.locator(REPLY)).toHaveText("GOLF2");
  await expect(one.locator(REPLY)).toHaveCount(1);
  await expect(one.locator(REPLY)).toContainText("Here they are.");
  await expect(blocks(page)).toHaveCount(3);
  await expect(timeline(page).locator(".status-row")).toHaveCount(0);
  for (const words of ["GOLF1", "GOLF2", "Here they are.", "golf1 in capital letters", "golf2 in capital letters"])
    expect(await drawn(page, words), words).toBe(1);
});

test("a refused message, then the same words typed at the terminal: the refusal is not drawn on the turn that ran", async ({
  context,
  page,
}) => {
  const name = `cv-refused-${tag()}`;
  const m = await setup(context, page, { name });
  const s = await openSession(page, sink, name, `Refused ${name}`);
  const id = await send(page, s, "continue");
  await ack(m, id, { outcome: "refused", code: "folder", detail: "not on the allowlist" });
  const refusal = timeline(page).locator(".starting-failed");
  await expect(refusal).toContainText(`${name} refused it`);
  await expect(blocks(page)).toHaveCount(2);

  // The same word, typed at the terminal: a turn of its own, that ran.
  const at = await s.begin("t-typed", "continue");
  const typed = block(page, "continue");
  await expect(typed.locator(".turn-n")).toHaveText("Turn 2");
  await s.end("t-typed", "continue", "Going on.", at);
  await expect(typed.locator(REPLY)).toHaveText("Going on.");
  // The refusal is the message's, not this turn's: the turn has none, and the message that
  // never reached the session is not drawn as its prompt a second time.
  await expect(typed.locator(".turn-failed, .starting-failed")).toHaveCount(0);
  await expect(refusal).toHaveCount(0);
  await expect(blocks(page)).toHaveCount(2);
  expect(await drawn(page, "Going on.")).toBe(1);
});

test("Stop mid-text, then a new message: the stopped turn once, in its place, with what it had written", async ({
  context,
  page,
}) => {
  const name = `cv-stopped-${tag()}`;
  const m = await setup(context, page, { name });
  const s = await openSession(page, sink, name, `Stopped ${name}`);
  const first = await send(page, s, count("indiaa"));
  await ack(m, first, { outcome: "taken", mode: "resume" });
  const at1 = await s.begin("t-count", count("indiaa"));
  await ack(m, first, { outcome: "progress", mode: "resume", reply: nums(96), seq: 1 });
  const stopped = block(page, "indiaa");
  await expect(stopped.locator(REPLY)).toContainText("96");
  await expect(stopped.locator(".turn-head .spinner")).toHaveCount(1);

  // Stop: the daemon ends the turn's process (no hook says so) and acks the message with
  // what the turn had written, then its own note.
  await page.getByRole("button", { name: "Stop the turn", exact: true }).click();
  await expect.poll(() => m.seen.some((c) => c.kind === "cancel")).toBe(true);
  await ack(m, first, { outcome: "delivered", reply: `${nums(144)}\n\n${NOTE}` });
  await expect(stoppedRow(stopped)).toHaveText("Stopped");
  await expect(stopped.locator(REPLY)).toHaveCount(1);
  await expect(stopped.locator(REPLY)).toContainText("144");
  await expect(stopped.locator(".turn-head .spinner")).toHaveCount(0);
  await expect(stopped.locator('.status-row[data-sent-state="running"]')).toHaveCount(0);
  expect(await drawn(page, NOTE)).toBe(0);

  // A new message resumes the session. Its prompt's hook first sends what the transcript
  // holds of the stopped turn: an end that says `interrupt`, and nothing said (0.13.5).
  const second = await send(page, s, word("indiab"));
  await ack(m, second, { outcome: "taken", mode: "resume" });
  await s.post([
    ["turn.ended", { turn_id: "t-count", reason: "interrupt" }],
    ["turn.transcript", { turn: s.turn++, user: count("indiaa"), assistant: "", at: at1 }],
  ]);
  const at2 = await s.begin("t-word", word("indiab"));
  await ack(m, second, { outcome: "delivered", mode: "resume", reply: "INDIAB" });
  await s.end("t-word", word("indiab"), "INDIAB", at2);

  const next = block(page, "indiab");
  await expect(next.locator(".turn-n")).toHaveText("Turn 3");
  await expect(next.locator(REPLY)).toHaveText("INDIAB");
  await expect(stoppedRow(next)).toHaveCount(0);
  // The stopped turn is where it was, with what it had written, once; its head does not
  // say the raw reason, and neither of the two strings is anyone's words.
  await expect(stopped.locator(".turn-n")).toHaveText("Turn 2");
  await expect(stoppedRow(stopped)).toHaveText("Stopped");
  await expect(stopped.locator(REPLY)).toHaveCount(1);
  await expect(stopped.locator(REPLY)).toContainText("144");
  // Its end was stamped by the hook that began the next turn: no duration is made of that.
  await expect(stopped.locator(".turn-head")).not.toContainText("interrupt");
  await expect(stopped.locator(".turn-dur")).toHaveCount(0);
  await expect(blocks(page)).toHaveCount(3);
  await expect(blocks(page).nth(1).locator("blockquote")).toContainText("indiaa");
  await expect(blocks(page).nth(2).locator("blockquote")).toContainText("indiab");
  await expect(timeline(page).locator('.status-row[data-sent-state="stopped"]')).toHaveCount(1);
  for (const words of [NOTE, NONE, "interrupt"]) expect(await drawn(page, words), words).toBe(0);
  for (const words of ["INDIAB", "144"]) expect(await drawn(page, words), words).toBe(1);
});

test("Stop before the first word says so, in the chat too; a message stopped before it started is not 'delivered'", async ({
  context,
  page,
}) => {
  const name = `cv-early-${tag()}`;
  const m = await setup(context, page, { mode: "simple", name });
  const s = await openSession(page, sink, name, `Stopped early ${name}`);
  const first = await send(page, s, count("kiloa"));
  await ack(m, first, { outcome: "taken", mode: "resume" });
  const at1 = await s.begin("t-count", count("kiloa"));
  const stopped = block(page, "kiloa");
  await expect(stopped.locator('.status-row[data-sent-state="running"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Stop the turn", exact: true }).click();
  await expect.poll(() => m.seen.some((c) => c.kind === "cancel")).toBe(true);
  // Nothing written yet: the daemon's reply is its note alone.
  await ack(m, first, { outcome: "delivered", reply: NOTE });
  await expect(stoppedRow(stopped)).toHaveText("Stopped before the first word.");
  await expect(stopped.locator(REPLY)).toHaveCount(0);
  await expect(stopped.locator('.status-row[data-sent-state="running"]')).toHaveCount(0);
  expect(await drawn(page, NOTE)).toBe(0);

  // The session is resumed by the next message. An older sender passes on what Claude Code
  // then writes as the stopped turn's reply: its stand-in, which nobody said.
  const second = await send(page, s, word("kilob"));
  await ack(m, second, { outcome: "taken", mode: "resume" });
  await s.post([["turn.transcript", { turn: s.turn++, user: count("kiloa"), assistant: NONE, at: at1 }]]);
  const at2 = await s.begin("t-word", word("kilob"));
  await ack(m, second, { outcome: "delivered", mode: "resume", reply: "KILOB" });
  await s.end("t-word", word("kilob"), "KILOB", at2);
  const next = block(page, "kilob");
  await expect(next.locator(REPLY)).toHaveText("KILOB");
  await expect(stoppedRow(stopped)).toHaveText("Stopped before the first word.");
  await expect(stopped.locator(REPLY)).toHaveCount(0);
  await expect(blocks(page)).toHaveCount(3);
  await expect(blocks(page).nth(1).locator("blockquote")).toContainText("kiloa");
  await expect(blocks(page).nth(2).locator("blockquote")).toContainText("kilob");

  // A third message is stopped before its turn began: no turn, no hook event, and the
  // machine's one final ack is `delivered` with the note as its whole reply.
  const third = await send(page, s, word("kiloc"));
  await ack(m, third, { outcome: "delivered", reply: NOTE });
  const never = block(page, "kiloc");
  await expect(stoppedRow(never)).toHaveText("Stopped before the first word.");
  await expect(never.locator(REPLY)).toHaveCount(0);
  await expect(never.locator(".status-row")).toHaveCount(1);
  await expect(blocks(page)).toHaveCount(4);
  await expect(timeline(page).locator('.status-row[data-sent-state="stopped"]')).toHaveCount(2);
  for (const words of [NOTE, NONE, "Its turn shows here when it begins"])
    expect(await drawn(page, words), words).toBe(0);
  expect(await drawn(page, "KILOB")).toBe(1);
});
