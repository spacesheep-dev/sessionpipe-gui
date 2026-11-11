// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The GUI never shows state from before. An open session page across a dropped stream:
// what it draws before, while it is down (its rings and clocks stopped, nothing to send
// or stop), and after (the turn that ended, the reply, the message's last word), read
// once, with the composer's draft and the place it was scrolled to kept. The drop is made
// three ways: the device offline, the receiver gone while the browser is online, and a
// stream that is open in name only (a page out of the back/forward cache, a laptop awake
// again, a tab shown after a long time), which nothing but the page coming back reveals.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { E2E_PORT } from "../../playwright.config.js";
import { CONTROL_BASE, fakeDaemon, passkeyPage, seenSetupHere, sinkToken } from "./control-helpers.js";
import { EVENTS, INFO, sessionUrl, ulid } from "./helpers.js";

/** localhost, where the composer is live (the page's origin is one sending works from). */
const BASE = `http://localhost:${E2E_PORT}`;
/** STALE_SHOTS=<dir> also writes what the page looks like down and back, at three sizes. */
const SHOTS = process.env.STALE_SHOTS;
const SIZES = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  phone: { width: 390, height: 844 },
};

declare global {
  interface Window {
    __streams: { cut(): void; mute(): void; say(frame: unknown): void };
    __firstPage?: (detail: { session: unknown; events: Record<string, unknown>[] }) => void;
  }
}

/** The page's live streams under the test's hand. Chromium's offline mode refuses new
 *  connections and leaves an open EventSource open, so a dropped one is said the way a
 *  dead socket says it (`cut`: closed, its error handler called), and one that is open in
 *  name only by its frames no longer arriving (`mute`: the streams open now, for good; one
 *  opened afterwards hears everything). `say` is a frame arriving. A page that sets
 *  `__firstPage` is called with a session's first page in the task after it was read. */
async function tapStreams(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    type Stream = EventTarget & { close(): void; onerror: ((e: Event) => void) | null };
    const Real = window.EventSource as unknown as new (url: string | URL, init?: EventSourceInit) => Stream;
    const live = new Set<Stream>();
    const deaf = new WeakSet<Stream>();
    const heard = new Map<string, (e: Event) => void>();
    class Tapped extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        live.add(this);
      }
      addEventListener(
        kind: string,
        fn: EventListenerOrEventListenerObject | null,
        o?: boolean | AddEventListenerOptions,
      ) {
        if (typeof fn === "function") heard.set(kind, fn);
        super.addEventListener(kind, (e) => (deaf.has(this) || typeof fn !== "function" ? undefined : fn(e)), o);
      }
      close() {
        live.delete(this);
        super.close();
      }
    }
    window.EventSource = Tapped as unknown as typeof EventSource;
    window.__streams = {
      cut() {
        for (const es of [...live]) {
          es.close();
          es.onerror?.(new Event("error"));
        }
      },
      mute() {
        for (const es of live) deaf.add(es);
      },
      say(frame: unknown) {
        const { kind } = frame as { kind: string };
        heard.get(kind)?.(new MessageEvent(kind, { data: JSON.stringify(frame) }));
      },
    };
    const fetched = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await fetched(...args);
      if (!window.__firstPage || !/\/api\/ui\/sessions\/[^/]+\/[^/?]+\?tail=1/.test(res.url)) return res;
      const json = res.json.bind(res);
      res.json = async () => {
        const detail = await json();
        setTimeout(() => window.__firstPage?.(detail), 0);
        return detail;
      };
      return res;
    };
  });
}

/** One Claude Code session's events as a sessionpipe sender stamps them, posted to a
 *  receiver the way a sink posts them. */
class Feed {
  readonly id = randomUUID();
  private seq = 0;
  private clock = Date.now() - 600_000;
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly machine: string,
    readonly title: string,
  ) {}
  get url(): string {
    return sessionUrl("claude-code", this.id);
  }
  /** The next event the sender records. Its `time` is when its hook fired: half a second
   *  after the one before, or `ago` ms before now, never before the one before; `early`
   *  is the late-recorded hook, fired this many ms before the last one and recorded after. */
  ev(type: string, data: Record<string, unknown>, hook: string, o: { ago?: number; early?: number } = {}) {
    // What a turn said is dated by the turn (the hook before it), as the sender reads it.
    const said = type === "turn.transcript" || type === "turn.progress";
    if (said) data = { ...data, at: new Date(this.clock).toISOString() };
    if (o.early === undefined)
      this.clock = Math.max(this.clock + 1, o.ago === undefined ? this.clock + 500 : Date.now() - o.ago);
    const time = this.clock - (o.early ?? 0);
    return {
      protocol: 1,
      id: ulid(time),
      type,
      time: new Date(time).toISOString(),
      tier: 3,
      harness: { name: "claude-code", version: "2.1.296", event: hook },
      session: {
        id: this.id,
        seq: this.seq++,
        machine: this.machine,
        cwd: "~/code/billing",
        repo: "github.com/acme/billing",
        branch: "main",
        title: this.title,
        title_source: "custom",
      },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  }
  async post(...events: Record<string, unknown>[]): Promise<void> {
    // A batch is at most 50 events (the receiver's well-known says so).
    for (let i = 0; i < events.length; i += 50) {
      const res = await fetch(`${this.base}${EVENTS}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
          "sessionpipe-protocol": "1",
        },
        body: JSON.stringify({ events: events.slice(i, i + 50) }),
      });
      expect(res.status, await res.text()).toBe(202);
    }
  }
  /** A finished exchange: the prompt, one tool, the Stop and the transcript. */
  turn(n: number, user: string, assistant: string) {
    const turn_id = `p${n}`;
    const call_id = `toolu_${n}`;
    return [
      this.ev("turn.started", { turn_id, prompt_chars: user.length, submitted_by: "user" }, "UserPromptSubmit"),
      this.ev(
        "tool.started",
        { tool: "Read", call_id, turn_id, input: { file_path: `src/part${n}.ts` } },
        "PreToolUse",
      ),
      this.ev("tool.ended", { tool: "Read", call_id, turn_id, ok: true, ms: 12 }, "PostToolUse"),
      this.ev("turn.ended", { turn_id, reason: "stop", background: 0 }, "Stop"),
      this.ev("turn.transcript", { turn: n, user, assistant }, "Stop"),
    ];
  }
}

const demoToken = async (): Promise<string> =>
  ((await (await fetch(`${BASE}${INFO}`)).json()) as { sinkToken: string }).sinkToken;

const live = async (page: Page) => expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
const down = (page: Page) => expect(page.locator("html")).toHaveAttribute("data-stream", "down");
const up = (page: Page) => expect(page.locator("html")).not.toHaveAttribute("data-stream", "down");
const ring = (page: Page) => page.locator(".page.session h1.sess-title .dot");
const box = (page: Page) => page.getByLabel("Message for the next turn");
const stop = (page: Page) => page.getByRole("button", { name: "Stop the turn" });
const send = (page: Page) => page.locator(".ctl-send");
const reply = (page: Page) => page.locator(".page.session li.reply").last();
/** The device goes offline, and the stream with it. */
async function offline(context: BrowserContext, page: Page): Promise<void> {
  await context.setOffline(true);
  await page.evaluate(() => window.__streams.cut());
  await down(page);
}
/** How many times the page asked for this session's events. */
function reads(page: Page, id: string): { n: number } {
  const count = { n: 0 };
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.endsWith(`/sessions/claude-code/${id}`)) count.n++;
  });
  return count;
}
async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS!, { recursive: true });
  const { width } = page.viewportSize()!;
  const size = Object.entries(SIZES).find(([, v]) => v.width === width)![0];
  // What just landed has been laid out and the view has followed it: two frames on.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: path.join(SHOTS!, `${name}-${size}.png`) });
}

const ASK = "The date picker starts weeks on Sunday; make it Monday.";
const DRAFT = "and add a test for the first week of the year";
/** A session twelve exchanges long with a thirteenth running: its prompt, and a Bash call still going. */
async function runningSession(): Promise<Feed> {
  const s = new Feed(BASE, await demoToken(), "lab-mac", "Fix the date picker's week start");
  await s.post(
    s.ev("session.started", { source: "startup" }, "SessionStart"),
    ...Array.from({ length: 12 }, (_, n) => s.turn(n, `Earlier ask ${n}`, `Earlier answer ${n}.`)).flat(),
    s.ev("turn.started", { turn_id: "p12", prompt_chars: ASK.length, submitted_by: "user" }, "UserPromptSubmit", {
      ago: 9000,
    }),
    s.ev("turn.progress", { turn: 12, user: ASK, assistant: "" }, "UserPromptSubmit", { ago: 9000 }),
    s.ev(
      "tool.started",
      { tool: "Bash", call_id: "toolu_run", turn_id: "p12", input: { command: "npm test" } },
      "PreToolUse",
      { ago: 4000 },
    ),
  );
  return s;
}
/** The running turn ends. Its tool's own end, fired before the Stop, is recorded after it. */
const endTurn = (s: Feed) =>
  s.post(
    s.ev("turn.ended", { turn_id: "p12", reason: "stop", background: 0 }, "Stop", { ago: 1000 }),
    s.ev(
      "turn.transcript",
      { turn: 12, user: ASK, assistant: "Done: weeks start on Monday now. 212 tests pass." },
      "Stop",
      { ago: 1000 },
    ),
    s.ev("tool.ended", { tool: "Bash", call_id: "toolu_run", turn_id: "p12", ok: true, ms: 2900 }, "PostToolUse", {
      early: 100,
    }),
  );

/** A paired, trusted machine with the test as its daemon, a session on it, and a message
 *  sent from the page that the machine has taken. `finish` is its reply and final ack. */
async function takenMessage(context: BrowserContext, page: Page) {
  await seenSetupHere(context);
  await tapStreams(context);
  const key = await passkeyPage(context, page);
  const d = await fakeDaemon(
    key,
    { name: `stale-${randomUUID().slice(0, 6)}`, harnesses: ["claude-code"] },
    { offline: true },
  );
  const control = `${CONTROL_BASE}/api/sessionpipe/v1/control`;
  const auth = { authorization: `Bearer ${d.token}`, "content-type": "application/json" };
  const poll = async () => {
    const r = await fetch(`${control}?machine=${d.id}&wait=5`, { headers: auth });
    return r.status === 200 ? ((await r.json()) as { messages: { id: string }[] }).messages : [];
  };
  const ack = (id: string, outcome: string, more: Record<string, unknown> = {}) =>
    fetch(`${control}/ack`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ acks: [{ id, outcome, at: new Date().toISOString(), ...more }] }),
    });
  expect(await poll()).toEqual([]);
  const s = new Feed(CONTROL_BASE, await sinkToken(), d.name, "Run the suite");
  await s.post(
    s.ev("session.started", { source: "startup" }, "SessionStart"),
    ...s.turn(0, "Set up the repo", "Ready."),
  );
  await page.goto(`${CONTROL_BASE}${s.url}`);
  await live(page);
  await expect(box(page)).toBeEnabled();
  await box(page).fill("Run the whole suite");
  await box(page).press("Enter");
  const status = page.locator(".page.session .status-row[data-sent-state]").last();
  await expect(status).toHaveAttribute("data-sent-state", "queued", { timeout: 20_000 });
  const [msg] = await poll();
  await ack(msg!.id, "taken", { mode: "sdk" });
  await expect(status).toHaveAttribute("data-sent-state", "taken");
  await expect(box(page)).toHaveValue("");
  return {
    status,
    async finish() {
      await ack(msg!.id, "progress", { reply: "Running the suite", seq: 1 });
      await ack(msg!.id, "delivered", { mode: "sdk", reply: "All 212 tests pass." });
    },
    stop: () => d.stop(),
  };
}

test.describe("a session page across a dropped stream", () => {
  test.use({ baseURL: BASE });

  test("mid-turn, the device offline: stopped and said while down; back, the turn that ended, read once, the draft and the scroll kept", async ({
    context,
    page,
  }) => {
    await tapStreams(context);
    await page.clock.install();
    const s = await runningSession();
    const asked = reads(page, s.id);
    await page.goto(s.url);
    await live(page);

    // Before: a turn is running, and the page says so; its clock runs.
    await expect(ring(page)).toHaveClass(/dot--working/);
    const turn = page.locator(".page.session .turn--live");
    await expect(turn).toHaveCount(1);
    await expect(turn.locator(".tool-status.is-run")).toHaveCount(1);
    await expect(stop(page)).toBeEnabled();
    await expect(box(page)).toBeEnabled();
    expect(asked.n, "the open reads the session once").toBe(1);
    const clock = turn.locator(".turn-dur");
    const ran = await clock.textContent();
    await page.clock.fastForward(3000);
    await expect(clock).not.toHaveText(ran!);
    // A draft in the composer, and the view scrolled up to an earlier turn.
    await box(page).fill(DRAFT);
    const row = page.locator('.page.session .turn-head[data-seq="31"]');
    await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const at = async () => ({ y: await page.evaluate(() => window.scrollY), top: (await row.boundingBox())!.y });
    const before = await at();
    await page.evaluate(() => {
      (document.querySelector(".page.session .timeline") as HTMLElement & { kept?: boolean }).kept = true;
    });

    await offline(context, page);
    await expect(page.locator(".conn").first()).toContainText("Offline");
    await expect(page.locator(".conn").getByRole("button", { name: "Retry now" })).toBeVisible();
    // Nothing is offered as if connected, and the draft is still there.
    await expect(box(page)).toBeDisabled();
    await expect(box(page)).toHaveValue(DRAFT);
    await expect(send(page)).toBeDisabled();
    await expect(stop(page)).toBeDisabled();
    // Nothing claims the turn is running now: its rings stand still, and so do its clocks.
    await expect(ring(page)).toHaveCSS("animation-play-state", "paused");
    await expect(turn.locator(".spinner").first()).toHaveCSS("animation-play-state", "paused");
    const stood = await clock.textContent();
    await page.clock.fastForward(3000);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await expect(clock).toHaveText(stood!);

    // Meanwhile the turn ends, and the receiver reads the session idle, late tool and all.
    await endTurn(s);
    const res = await fetch(`${BASE}/api/ui/sessions/claude-code/${s.id}?tail=1&limit=1&slim=1`);
    expect(((await res.json()) as { session: { state: string } }).session.state).toBe("idle");
    // The page has heard none of it, and says only what it knew, stopped.
    await expect(ring(page)).toHaveClass(/dot--working/);
    expect(asked.n).toBe(1);

    // Back online: what is true now, read once, with nothing drawn again from scratch.
    await context.setOffline(false);
    await up(page);
    await live(page);
    await expect(ring(page)).toHaveClass(/dot--idle/);
    await expect(page.locator(".page.session .turn--live")).toHaveCount(0);
    await expect(page.locator(".page.session .tool-status.is-run")).toHaveCount(0);
    await expect(reply(page)).toContainText("212 tests pass");
    await expect(stop(page)).toHaveCount(0);
    await expect(box(page)).toBeEnabled();
    await expect(box(page)).toHaveValue(DRAFT);
    expect(
      await page.evaluate(
        () => (document.querySelector(".page.session .timeline") as HTMLElement & { kept?: boolean }).kept,
      ),
      "the timeline is the one that was there",
    ).toBe(true);
    const after = await at();
    expect(after.y, "scroll position").toBe(before.y);
    expect(Math.abs(after.top - before.top), "the row on screen stayed where it was").toBeLessThanOrEqual(1);
    expect(asked.n, "one read after the drop").toBe(2);
  });

  test("an event that arrives the instant the first page lands is in the timeline", async ({ context, page }) => {
    await tapStreams(context);
    const s = new Feed(BASE, await demoToken(), "lab-mac", "Between the page and the stream");
    await s.post(s.ev("session.started", { source: "startup" }, "SessionStart"), ...s.turn(0, "First", "Done."));
    // The page's own read has landed and nothing has been drawn yet: the stream speaks.
    await page.addInitScript(() => {
      window.__firstPage = (d) => {
        const last = d.events[d.events.length - 1]!;
        const session = last.session as { seq: number };
        const event = {
          ...last,
          id: "01JSTALE0000000000000000GAP",
          type: "tool.started",
          time: new Date().toISOString(),
          session: { ...session, seq: session.seq + 1 },
          data: { tool: "Arrived", call_id: "toolu_gap" },
        };
        window.__streams.say({ kind: "event", event, session: d.session });
      };
    });
    await page.goto(s.url);
    await live(page);
    await expect(reply(page)).toContainText("Done.");
    await expect(page.locator(".page.session .tool-name", { hasText: "Arrived" })).toHaveCount(1);
  });

  test("at rest, the receiver gone while the browser is online: Reconnecting, then the turn it missed; a late-recorded event leaves it idle", async ({
    context,
    page,
  }) => {
    await tapStreams(context);
    const s = new Feed(BASE, await demoToken(), "lab-mac", "Tidy the changelog");
    await s.post(
      s.ev("session.started", { source: "startup" }, "SessionStart"),
      ...s.turn(0, "Tidy the changelog", "Tidied."),
    );
    const asked = reads(page, s.id);
    await page.goto(s.url);
    await live(page);
    await expect(ring(page)).toHaveClass(/dot--idle/);
    await expect(page.locator(".page.session .turn")).toHaveCount(1);
    await expect(reply(page)).toContainText("Tidied.");
    await box(page).fill("next: the release notes");

    // The receiver stops answering; the browser itself is online.
    await page.route("**/api/ui/stream", (route) => route.abort("connectionrefused"));
    await page.evaluate(() => window.__streams.cut());
    await down(page);
    await expect(page.locator(".conn").first()).toContainText("Reconnecting");
    await expect(box(page)).toBeDisabled();
    await expect(send(page)).toBeDisabled();
    await expect(ring(page)).toHaveClass(/dot--idle/);

    // A whole turn happens meanwhile; one of its tools is recorded after its Stop.
    const ask = "Write the release notes for 0.7.6";
    await s.post(
      s.ev("turn.started", { turn_id: "p1", prompt_chars: ask.length, submitted_by: "user" }, "UserPromptSubmit", {
        ago: 8000,
      }),
      s.ev(
        "tool.started",
        { tool: "Read", call_id: "toolu_a", turn_id: "p1", input: { file_path: "CHANGELOG.md" } },
        "PreToolUse",
        { ago: 7000 },
      ),
      s.ev("turn.ended", { turn_id: "p1", reason: "stop", background: 0 }, "Stop", { ago: 3000 }),
      s.ev("turn.transcript", { turn: 1, user: ask, assistant: "The notes are in docs/release-0.7.6.md." }, "Stop", {
        ago: 3000,
      }),
      s.ev("tool.ended", { tool: "Read", call_id: "toolu_a", turn_id: "p1", ok: true, ms: 9 }, "PostToolUse", {
        early: 100,
      }),
    );
    await expect(page.locator(".page.session .turn")).toHaveCount(1);
    expect(asked.n).toBe(1);

    // The receiver is back. Retry now asks at once; the transport's own backoff may get
    // there first, and then there is no button left to press.
    await page.unroute("**/api/ui/stream");
    await page.evaluate(() => document.querySelector<HTMLButtonElement>(".conn .conn-retry")?.click());
    await up(page);
    await live(page);
    await expect(reply(page)).toContainText("docs/release-0.7.6.md");
    await expect(page.locator(".page.session .turn")).toHaveCount(2);
    await expect(ring(page)).toHaveClass(/dot--idle/);
    await expect(page.locator(".page.session .turn--live")).toHaveCount(0);
    await expect(page.locator(".page.session .tool-status.is-run")).toHaveCount(0);
    await expect(stop(page)).toHaveCount(0);
    await expect(box(page)).toHaveValue("next: the release notes");
    expect(asked.n).toBe(2);
  });

  test("a stream open in name only: out of the back/forward cache, awake again, shown after a long time, the page asks", async ({
    context,
    page,
  }) => {
    await tapStreams(context);
    await page.clock.install();
    const s = new Feed(BASE, await demoToken(), "lab-mac", "Three long builds");
    await s.post(s.ev("session.started", { source: "startup" }, "SessionStart"));
    const asked = reads(page, s.id);
    await page.goto(s.url);
    await live(page);
    const turns = page.locator(".page.session .turn");
    /** Frames stop arriving with nobody told, and a turn starts that the page never hears of. */
    const missed = async (n: number) => {
      await page.evaluate(() => window.__streams.mute());
      await s.post(
        s.ev("turn.started", { turn_id: `p${n}`, prompt_chars: 7, submitted_by: "user" }, "UserPromptSubmit", {
          ago: 300,
        }),
        s.ev("turn.progress", { turn: n, user: `Build ${n}`, assistant: "" }, "UserPromptSubmit", { ago: 300 }),
        s.ev("tool.started", { tool: "Bash", call_id: `toolu_${n}`, turn_id: `p${n}` }, "PreToolUse", { ago: 100 }),
      );
      // The page reads idle still, and still calls itself live.
      await expect(ring(page)).toHaveClass(/dot--idle/);
      await expect(turns).toHaveCount(n);
      await expect(page.locator(".conn").first()).toHaveText("live");
    };
    const caughtUp = async (n: number) => {
      await expect(ring(page)).toHaveClass(/dot--working/);
      await expect(turns).toHaveCount(n + 1);
      await expect(page.locator(".page.session .turn--live")).toContainText(`Build ${n}`);
      expect(asked.n, "one read each time the page comes back").toBe(n + 2);
      await s.post(
        s.ev("turn.ended", { turn_id: `p${n}`, reason: "stop", background: 0 }, "Stop", { ago: 0 }),
        s.ev("turn.transcript", { turn: n, user: `Build ${n}`, assistant: `Build ${n} passed.` }, "Stop", { ago: 0 }),
      );
      await expect(ring(page)).toHaveClass(/dot--idle/);
      await expect(reply(page)).toContainText(`Build ${n} passed.`);
    };

    // Restored from the back/forward cache.
    await missed(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await caughtUp(0);

    // The laptop slept for an hour with the tab in front.
    await missed(1);
    await page.clock.fastForward("01:00:00");
    await caughtUp(1);

    // The tab was hidden for five minutes, then shown.
    await missed(2);
    const visible = (state: "hidden" | "visible") =>
      page.evaluate((v) => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => v });
        document.dispatchEvent(new Event("visibilitychange"));
      }, state);
    await visible("hidden");
    await page.clock.fastForward("05:00");
    await expect(turns).toHaveCount(2);
    await visible("visible");
    await caughtUp(2);
  });
});

test.describe("a message across a dropped stream", () => {
  test.use({ baseURL: CONTROL_BASE });

  test("taken before the drop, delivered during it: back, it reads delivered with its reply, and the composer waited", async ({
    context,
    page,
  }) => {
    const m = await takenMessage(context, page);
    await box(page).fill("then tag the release");

    await offline(context, page);
    const foot = page.locator(".ctl-foot[data-reason=stream]");
    await expect(foot.locator(".ctl-hint")).toHaveText("Offline. Sending waits for the connection.");
    await expect(box(page)).toBeDisabled();
    await expect(box(page)).toHaveValue("then tag the release");
    await expect(send(page)).toBeDisabled();
    await expect(m.status.locator(".spinner")).toHaveCSS("animation-play-state", "paused");

    // The machine answers and finishes while the page hears nothing.
    await m.finish();
    await expect(m.status).toHaveAttribute("data-sent-state", "taken");

    await context.setOffline(false);
    await up(page);
    await live(page);
    await expect(m.status).toHaveAttribute("data-sent-state", "delivered");
    await expect(reply(page)).toContainText("All 212 tests pass.");
    await expect(page.locator(".ctl-foot[data-reason=stream]")).toHaveCount(0);
    await expect(box(page)).toBeEnabled();
    await expect(box(page)).toHaveValue("then tag the release");
    await m.stop();
  });
});

// The same two drops as pictures (STALE_SHOTS=<dir>): the page down, and back, at each size.
for (const [size, viewport] of Object.entries(SIZES)) {
  test.describe(`pictures, ${size}`, () => {
    test.skip(!SHOTS, "STALE_SHOTS=<dir> writes them");
    test.use({ viewport });

    test("a turn running: offline, then back", async ({ context, page }) => {
      await tapStreams(context);
      const s = await runningSession();
      await page.goto(`${BASE}${s.url}`);
      await live(page);
      await expect(page.locator(".page.session .turn--live .tool-status.is-run")).toHaveCount(1);
      await box(page).fill(DRAFT);
      await offline(context, page);
      await shot(page, "offline-mid-turn");
      await endTurn(s);
      await context.setOffline(false);
      await up(page);
      await expect(reply(page)).toContainText("212 tests pass");
      await expect(ring(page)).toHaveClass(/dot--idle/);
      await shot(page, "recovered-mid-turn");
    });

    test("a message taken: offline, then back, delivered", async ({ context, page }) => {
      const m = await takenMessage(context, page);
      await box(page).fill("then tag the release");
      await offline(context, page);
      await shot(page, "offline-message");
      await m.finish();
      await context.setOffline(false);
      await up(page);
      await expect(m.status).toHaveAttribute("data-sent-state", "delivered");
      await expect(reply(page)).toContainText("All 212 tests pass.");
      await shot(page, "recovered-message");
      await m.stop();
    });
  });
}
