// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The iPhone Duo for the end-to-end suite (duo.spec.ts and duo-continuity.spec.ts in the
// `duo` and `duo-webkit` projects, and account-screens.spec.ts when it is given insets):
// its shapes, what the system keeps on each side of them, a fold or a turn of a live page,
// a software keyboard, and three measures (which controls reach under a band, how long a
// line of prose is, how much of the page takes a finger for a control). The app's code
// names no Duo size: its layout follows the window. The shapes are written here, and in
// the render bed that draws the same ones.
//
// duoBed() is the app those are tried on: the iPhone app on a spacesheep account, on the
// stand-ins of test/account, as account-screens.spec.ts has it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { FakeSpacesheep } from "../account/fake-spacesheep.js";
import { HubStandIn } from "../account/hub.js";
import { type AccountServer, startAccountServer } from "../account/serve.js";
import { fakeShell } from "../account/shell-init.js";
import { Session } from "../events.js";

/** What the system keeps for itself on each side, in pt: top, right, bottom, left. */
export type Insets = [top: number, right: number, bottom: number, left: number];

export interface Shape {
  insets: Insets;
  /** Where the fold crosses the open display, flat and with no width: "h" from side to side
   *  at half the height, "v" from top to bottom at half the width. */
  fold?: "h" | "v";
  /** The software keyboard's height, in pt. */
  kb: number;
}

/** The Duo's windows, "WxH" in pt. The sizes are what the iOS 27.1 simulator gives a
 *  WKWebView. The insets and the keyboards are estimates until the iPhone Duo simulator
 *  probe (the iOS build's CI step) prints env(safe-area-inset-*) in each pose: one band of
 *  about 84 pt where the system keeps its bars beside the page (466 less the 382 Safari
 *  lays a page out in), 32 on top of the inner display upright, 20 for the home indicator. */
export const DUO: Record<string, Shape> = {
  // The outer display, upright; and on its side, which the app's portrait lock keeps it from.
  "466x678": { insets: [0, 84, 20, 0], kb: 300 },
  "678x466": { insets: [0, 84, 20, 0], kb: 219 },
  // The inner display, upright and turned (the portrait lock is not honoured there).
  "669x951": { insets: [32, 0, 20, 0], fold: "h", kb: 320 },
  "951x669": { insets: [0, 84, 20, 0], fold: "v", kb: 300 },
  // Half of the inner display turned: Split View.
  "470x669": { insets: [0, 84, 20, 0], kb: 300 },
  // An earlier estimate of the same three windows, kept so that nothing passes only at one size.
  "626x890": { insets: [32, 0, 20, 0], fold: "h", kb: 320 },
  "890x626": { insets: [0, 56, 20, 0], fold: "v", kb: 300 },
  "445x626": { insets: [0, 56, 20, 0], kb: 300 },
};

const NONE: Insets = [0, 0, 0, 0];

interface DuoWindow {
  __duoInsets?: { next(insets: number[]): void; apply(): void };
  __duoKeyboard?: (px: number) => void;
}

/** In the page, before any of its scripts: the --safe-* properties on <html>, which every
 *  stylesheet reads before env(safe-area-inset-*), as Android's shell sets them
 *  (native/shell.ts). An init script runs before the document has its <html>, so they are
 *  put on it the moment the parser makes it: the page's first script reads them and its
 *  first frame is laid out with them. They are set again as the window changes size,
 *  before the page hears of it: a fold changes both at once. */
function insetsScript(d: { insets: number[]; at: [number, number] | null }) {
  const KEPT = "duo.insets";
  let { insets, at } = d;
  try {
    // A pose this tab took before this document (a reload, another page of the app).
    const kept = sessionStorage.getItem(KEPT);
    if (kept) {
      insets = JSON.parse(kept) as number[];
      at = null;
    }
  } catch {
    // A document with no storage (about:blank) has no pose to remember.
  }
  // `at`: these are that size's insets, and another size has none. As its <html> is made a
  // window does not have its size yet (it is 980 wide until the page's viewport is read), so
  // the first answer is that it does; it is settled once the window has its size: at its
  // first resize, or once the document is read.
  let sized = false;
  const apply = () => {
    const root = document.documentElement;
    if (!root) return;
    const on = !at || !sized || matchMedia(`(width: ${at[0]}px) and (height: ${at[1]}px)`).matches;
    ["top", "right", "bottom", "left"].forEach((side, i) => {
      if (on) root.style.setProperty(`--safe-${side}`, `${insets[i]}px`);
      else root.style.removeProperty(`--safe-${side}`);
    });
  };
  (window as unknown as DuoWindow).__duoInsets = {
    next(v) {
      insets = v;
      at = null;
      sessionStorage.setItem(KEPT, JSON.stringify(v));
    },
    apply,
  };
  const settle = () => {
    sized = true;
    apply();
  };
  apply();
  // The <html> is not there yet: they are put on it as the parser makes it, which in a page
  // being loaded is before the script that follows it runs.
  new MutationObserver(apply).observe(document, { childList: true });
  document.addEventListener("DOMContentLoaded", settle);
  window.addEventListener("resize", settle, true);
}

/** Every page of `context` has these insets, from before its first script and its first
 *  frame. `at`: only while the window is that size, so a test that walks other widths
 *  leaves them behind and has them back when it returns. A page opened at another size
 *  still has them in its first frame, in both engines: they go at its first resize, or
 *  once the document is read. A document written into an open page (page.setContent) gets
 *  them as well, but in Chromium only after its first script: open pages by address.
 *  Once per context; pose() changes them from there. */
export async function insetsInit(
  context: BrowserContext,
  insets: Insets,
  at?: { width: number; height: number },
): Promise<void> {
  await context.addInitScript(insetsScript, { insets, at: at ? ([at.width, at.height] as [number, number]) : null });
}

/** Moves a live page to another window, as a fold, an unfold, a turn or Split View does:
 *  the size and that shape's insets together (`insets`: others, as with the band on the
 *  left), then waits until the page has the size and has drawn two frames at it, so what
 *  the resize set off is laid out (`settle` false: only for the size, as a hand that does
 *  not wait goes on). A page loaded afterwards keeps them. */
export async function pose(
  page: Page,
  width: number,
  height: number,
  insets: Insets = DUO[`${width}x${height}`]?.insets ?? NONE,
  settle = true,
): Promise<void> {
  const armed = await page.evaluate((v) => {
    const duo = (window as unknown as DuoWindow).__duoInsets;
    duo?.next(v);
    return !!duo;
  }, insets);
  if (!armed) throw new Error("pose: this page's context was not made with insetsInit");
  await page.setViewportSize({ width, height });
  // The same size with other insets is no resize: they are put in place here.
  await page.evaluate(() => (window as unknown as DuoWindow).__duoInsets?.apply());
  // A state, not a time: the window is the size, then two frames have been drawn at it.
  await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height] as const);
  if (!settle) return;
  await page.evaluate(
    () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

/** The window a page is in ("WxH") and the insets it has, as the page itself has them. */
export function shapeOf(page: Page): Promise<{ size: string; insets: Insets }> {
  return page.evaluate(() => {
    const style = document.documentElement.style;
    const insets = ["top", "right", "bottom", "left"].map(
      (side) => Number.parseFloat(style.getPropertyValue(`--safe-${side}`)) || 0,
    );
    return { size: `${innerWidth}x${innerHeight}`, insets: insets as [number, number, number, number] };
  });
}

/** In the page, before any of its scripts: `window.visualViewport` gives the real one less
 *  a keyboard's height, and `__duoKeyboard(px)` raises or lowers it with the resize WebKit
 *  fires. The layout viewport keeps its size, as in WKWebView. */
function keyboardScript() {
  const real = window.visualViewport;
  if (!real) return;
  let kb = 0;
  const fake = new Proxy(real, {
    get(vv, key) {
      if (key === "height") return Math.max(0, vv.height - kb);
      const value = Reflect.get(vv, key, vv) as unknown;
      return typeof value === "function" ? value.bind(vv) : value;
    },
    set: (vv, key, value) => Reflect.set(vv, key, value, vv),
  });
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
  (window as unknown as DuoWindow).__duoKeyboard = (px) => {
    kb = px;
    // Where the keys would be, for a failed test's picture: outside <body>, and it takes no tap.
    let keys = document.getElementById("__duo-keyboard");
    if (!keys) {
      keys = document.createElement("div");
      keys.id = "__duo-keyboard";
      keys.setAttribute("aria-hidden", "true");
      keys.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;background:rgba(120,120,128,.6)";
      document.documentElement.appendChild(keys);
    }
    keys.style.height = `${px}px`;
    real.dispatchEvent(new Event("resize"));
  };
}

const keyboards = new WeakSet<Page>();

/** The software keyboard `kb` pt tall over the bottom of the page (0: put away), as the
 *  page learns of it in WKWebView: the visual viewport gets shorter and says so, and
 *  lib/keyboardInset.ts sets --kb from that. The page reads its viewport as it starts, so
 *  the first call comes before the page is opened, with 0 (duoBed makes it): there is no
 *  page yet to raise a keyboard over. */
export async function fakeKeyboard(page: Page, kb: number): Promise<void> {
  if (!keyboards.has(page)) {
    keyboards.add(page);
    await page.addInitScript(keyboardScript);
  }
  const set = await page.evaluate((px) => {
    const raise = (window as unknown as DuoWindow).__duoKeyboard;
    raise?.(px);
    return !!raise;
  }, kb);
  if (!set && (kb > 0 || page.url() !== "about:blank"))
    throw new Error(
      "fakeKeyboard: this page has no keyboard to move. The first call comes before the page is opened, with 0 (the page keeps the viewport it starts with); the keyboard is raised once the page is open",
    );
}

/** The controls a finger would land on inside an inset band: every button, link, field and
 *  [role=button|menuitem|switch|tab|option] (and <summary>, <select>) whose box reaches
 *  into a band of this page's --safe-* insets, is on top there, and cannot be scrolled out
 *  from under it (a row passing under the home indicator is not held there, nor a sticky
 *  head on its way up the page; a bar is, and a head once it is stuck). It goes by the box
 *  the eye aims at: a hit area that ::before or ::after widens past it is not counted.
 *  A scrim is not one of them (an empty button from one side of the window to the other):
 *  it is the dimmed ground round a sheet, a tap anywhere on it puts the sheet away, and
 *  nobody aims at the part of it a band covers.
 *  Their names as a screen reader would say them, as near as the page can tell.
 *  Once, in WebKit, a measure made straight after a scroll from the test missed a control
 *  (one trial in 13, not seen again): after such a scroll, ask through expect.poll. */
export function bandOffenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    const [top, right, bottom, left] = ["top", "right", "bottom", "left"].map(
      (side) => Number.parseFloat(style.getPropertyValue(`--safe-${side}`)) || 0,
    ) as [number, number, number, number];
    // With no band every page passes: that is a context made without insetsInit, not a pass.
    if (!(top || right || bottom || left)) throw new Error("bandOffenders: this page has no inset band");
    const W = innerWidth;
    const H = innerHeight;
    /** Each band: its box, the axis a control would leave it along, and which way: on
     *  (down, right) or back. */
    const bands: [x0: number, y0: number, x1: number, y1: number, across: boolean, on: boolean][] = [
      [0, 0, W, top, false, false],
      [W - right, 0, W, H, true, true],
      [0, H - bottom, W, H, false, true],
      [0, 0, left, H, true, false],
    ];
    /** Whether a sticky box is held along that axis now: off the place its flow gives it,
     *  which is where it stands for a moment with its position taken away. The attribute
     *  is written whole and put back whole: set through el.style and then removed, it came
     *  back empty (style="") in both engines on a box that had none. */
    const stuck = (el: HTMLElement, across: boolean): boolean => {
      const had = el.getAttribute("style");
      const now = el.getBoundingClientRect();
      el.setAttribute("style", `${had ?? ""};position:static!important`);
      const flow = el.getBoundingClientRect();
      if (had === null) el.removeAttribute("style");
      else el.setAttribute("style", had);
      return Math.abs(across ? flow.left - now.left : flow.top - now.top) > 0.5;
    };
    /** Whether something `el` scrolls with has `need` px left to scroll that way. What is
     *  fixed stays where it is, and so does what is sticky while it is stuck. */
    const scrollsClear = (el: HTMLElement, across: boolean, on: boolean, need: number): boolean => {
      for (let n = el; ; ) {
        const position = getComputedStyle(n).position;
        if (position === "fixed" || (position === "sticky" && stuck(n, across))) return false;
        const up = n.parentElement;
        if (!up) return false;
        // The page itself scrolls at the document, whatever <html> and <body> say of overflow.
        const box = up === root ? (document.scrollingElement ?? root) : up;
        const overflow = getComputedStyle(up)[across ? "overflowX" : "overflowY"];
        if (up === root || overflow === "auto" || overflow === "scroll") {
          const at = across ? box.scrollLeft : box.scrollTop;
          const end = across ? box.scrollWidth - box.clientWidth : box.scrollHeight - box.clientHeight;
          if ((on ? end - at : at) >= need - 0.5) return true;
        }
        if (up === root) return false;
        n = up;
      }
    };
    const name = (el: HTMLElement): string => {
      const by = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      const said =
        by.trim() ||
        el.getAttribute("aria-label") ||
        (el as HTMLInputElement).labels?.[0]?.textContent ||
        // biome-ignore lint/performance/useDomNodeTextContent: the words as drawn, without what is hidden
        el.innerText ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        `<${el.tagName.toLowerCase()}>`;
      return said.trim().replace(/\s+/g, " ");
    };
    const found: string[] = [];
    const controls =
      "button, a, input, textarea, select, summary, [role=button], [role=menuitem], [role=switch], [role=tab], [role=option]";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(controls))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      const button = el.tagName === "BUTTON" || el.getAttribute("role") === "button";
      const scrim = button && !el.childElementCount && !el.textContent?.trim() && r.left <= 0.5 && r.right >= W - 0.5;
      if (scrim) continue;
      const held = bands.some(([bx0, by0, bx1, by1, across, on]) => {
        // The part of the control inside the band.
        const x0 = Math.max(r.left, bx0);
        const y0 = Math.max(r.top, by0);
        const x1 = Math.min(r.right, bx1);
        const y1 = Math.min(r.bottom, by1);
        if (x1 - x0 <= 0.5 || y1 - y0 <= 0.5) return false;
        const onTop = [0.1, 0.5, 0.9].some((fx) =>
          [0.1, 0.5, 0.9].some((fy) => {
            const at = document.elementFromPoint(x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy);
            return !!at && el.contains(at);
          }),
        );
        const need = across ? (on ? r.right - bx0 : bx1 - r.left) : on ? r.bottom - by0 : by1 - r.top;
        return onTop && !scrollsClear(el, across, on, need);
      });
      if (held) found.push(name(el));
    }
    return found;
  });
}

/** How many characters the first rendered line of `el`'s text holds, read from where each
 *  character is drawn. */
export function firstLineChars(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let top: number | null = null;
    let n = 0;
    for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
      for (let i = 0; i < t.data.length; i++) {
        range.setStart(t, i);
        range.setEnd(t, i + 1);
        const box = range.getClientRects()[0];
        // White space a line break swallowed is not drawn.
        if (!box || box.width === 0) continue;
        if (top === null) top = box.top;
        else if (box.top - top > box.height / 2) return n;
        n++;
      }
    }
    return n;
  });
}

/** How much of the page takes a finger for `el`, in pt: from the middle of its box out, to
 *  the left, the right, up and down, for as long as what is on top there is `el`. So the
 *  room a ::before or ::after gives it counts, and what an ancestor cuts off or another
 *  control lies over does not. `el` is brought to the middle of the window first, clear of
 *  the bars. */
export function hitSize(el: Locator): Promise<{ width: number; height: number }> {
  return el.evaluate((node) => {
    node.scrollIntoView({ block: "center", behavior: "instant" });
    const r = node.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const reach = (dx: number, dy: number): number => {
      let n = 0;
      while (n < 200 && node.contains(document.elementFromPoint(x + dx * (n + 1), y + dy * (n + 1)))) n++;
      return n;
    };
    if (!node.contains(document.elementFromPoint(x, y))) return { width: 0, height: 0 };
    return { width: reach(-1, 0) + 1 + reach(1, 0), height: reach(0, -1) + 1 + reach(0, 1) };
  });
}

/** Whether a finger is this project's main pointer: what makes a screen the touch app's,
 *  whatever its width. A duo spec's beforeAll holds its project to it. */
export async function coarsePointer(browser: Browser): Promise<boolean> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    return await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  } finally {
    await context.close();
  }
}

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/web");
/** The account's origin as a person reads it. Nothing is asked of it: spacesheep is stood in. */
const ORIGIN = "https://spacesheep.dev";
const MACHINE = { id: "m_studio0123456789abcd", name: "studio-mac" };
/** The newest reply of the session a prompt waits in (DUO_SESSIONS.prompt). */
export const DUO_REPLY =
  "Found it: a duplicate event id threw before the idempotency check, so every retry failed the same way. I moved the check first and added a test for it. 23 of 23 pass. Deploying to staging next.";
/** The sample's sessions, by what a test wants of them: one with a permission prompt
 *  waiting under DUO_REPLY, one that is done and takes a message. */
export const DUO_SESSIONS = { prompt: "/s/claude-code/s-webhook", done: "/s/claude-code/s-notes" };

function sample(): unknown[] {
  // The prompt is five seconds old, so it can still be answered from here.
  const asked = Date.now() - 5_000;
  const webhook = new Session("s-webhook", "claude-code", asked - 6 * 60_000);
  const notes = new Session("s-notes", "claude-code", asked - 70 * 60_000);
  const on = (cwd: string, title: string, at?: number) => ({
    session: { machine: MACHINE.name, cwd, title, title_source: "custom" as const },
    ...(at ? { time: new Date(at).toISOString() } : {}),
  });
  const w = ["/Users/me/code/billing", "Fix the invoice webhook retries"] as const;
  const n = on("/Users/me/code/app", "Release notes for 0.8.3");
  const command = "npm run deploy -- --target staging";
  return [
    webhook.ev("session.started", { source: "startup" }, on(...w)),
    webhook.ev("turn.started", { turn_id: "t1" }, on(...w)),
    webhook.ev(
      "turn.progress",
      {
        turn_id: "t1",
        user: "The invoice webhook retries forever when a duplicate event arrives. Fix it and deploy to staging.",
        assistant: DUO_REPLY,
      },
      on(...w),
    ),
    webhook.ev(
      "tool.started",
      { tool: "Bash", call_id: "c1", turn_id: "t1", input: { command } },
      on(...w, asked - 1_000),
    ),
    webhook.ev(
      "attention.needed",
      { attention_id: "att_deploy", kind: "permission", tool: "Bash", message: command },
      on(...w, asked),
    ),
    notes.ev("session.started", { source: "startup" }, n),
    notes.ev("turn.started", { turn_id: "t1" }, n),
    notes.ev(
      "turn.transcript",
      {
        turn: 1,
        user: "Draft the release notes for 0.8.3 from the merged PRs.",
        assistant: "Drafted CHANGELOG.md: three fixes to connecting, grouped by what a person notices.",
      },
      n,
    ),
    notes.ev("turn.ended", { turn_id: "t1" }, n),
  ];
}

/** One more finished session on the sample's computer, for a test that wants words of its
 *  own: what was asked and the reply (Markdown). Before the page is opened. Its address. */
export function duoSession(b: DuoBed, id: string, turn: { title: string; user: string; assistant: string }): string {
  const s = new Session(id, "claude-code", Date.now() - 20 * 60_000);
  const on = {
    session: {
      machine: MACHINE.name,
      cwd: "/Users/me/code/billing",
      title: turn.title,
      title_source: "custom" as const,
    },
  };
  b.ss.push([
    s.ev("session.started", { source: "startup" }, on),
    s.ev("turn.started", { turn_id: "t1" }, on),
    s.ev("turn.transcript", { turn: 1, user: turn.user, assistant: turn.assistant }, on),
    s.ev("turn.ended", { turn_id: "t1" }, on),
  ]);
  return `/s/claude-code/${id}`;
}

/** One more session on the sample's computer, waiting for its plan (Markdown) to be
 *  approved: the plan in the call's input, as Claude Code's plan mode sends it. Before the
 *  page is opened. Its address. */
export function duoPlanSession(b: DuoBed, id: string, plan: string): string {
  const asked = Date.now() - 5_000;
  const s = new Session(id, "claude-code", asked - 2 * 60_000);
  const on = (at?: number) => ({
    session: {
      machine: MACHINE.name,
      cwd: "/Users/me/code/billing",
      title: "Plan the export's resume",
      title_source: "custom" as const,
    },
    ...(at ? { time: new Date(at).toISOString() } : {}),
  });
  b.ss.push([
    s.ev("session.started", { source: "startup" }, on()),
    s.ev("turn.started", { turn_id: "t1" }, on()),
    s.ev("tool.started", { tool: "ExitPlanMode", call_id: "p1", turn_id: "t1", input: { plan } }, on(asked - 1_000)),
    s.ev(
      "attention.needed",
      { attention_id: `att_${id}`, kind: "permission", tool: "ExitPlanMode", message: "ExitPlanMode" },
      on(asked),
    ),
  ]);
  return `/s/claude-code/${id}`;
}

export interface DuoBed {
  ss: FakeSpacesheep;
  hub: HubStandIn;
  server: AccountServer;
  context: BrowserContext;
  page: Page;
  /** The phone was approved on spacesheep long ago: it can send. Asked of the page, so it
   *  wants one open; a page opened afterwards knows. */
  approve(): Promise<void>;
  close(): Promise<void>;
}

/** The iPhone app at one of the Duo's shapes (`size`, "WxH"), with that shape's insets
 *  (`insets`: others) and the keyboard down: on a spacesheep account with two sessions on
 *  one computer, in Simple mode as a new phone is; or `fresh`, a new install at its first
 *  run. The touch screen is the project's (playwright.config.ts `duo`). */
export async function duoBed(
  browser: Browser,
  size: string,
  o: { fresh?: boolean; insets?: Insets } = {},
): Promise<DuoBed> {
  const [width, height] = size.split("x").map(Number) as [number, number];
  const ss = new FakeSpacesheep();
  ss.rpId = new URL(ORIGIN).host;
  ss.machines = [
    {
      ...MACHINE,
      online: true,
      last_seen: Date.now(),
      folders: ["/Users/me/code"],
      mode: "safe",
      agents: ["claude-code"],
      cli_version: "sessionpipe 0.15.0",
      modes: ["waiter"],
      passkey_ids: ["a-passkey-made-on-spacesheep"],
      key_types: ["passkey", "device"],
    },
  ];
  ss.push(sample());
  const hub = new HubStandIn({ upstream: { origin: ORIGIN, ask: (req) => ss.handle(req) } });
  const server = await startAccountServer({ web: WEB, hub });
  const settings = { name: "sessionpipe-gui.settings", value: JSON.stringify({ mode: "simple" }) };
  const context = await browser.newContext({
    viewport: { width, height },
    storageState: { cookies: [], origins: o.fresh ? [] : [{ origin: server.url, localStorage: [settings] }] },
  });
  // Nothing leaves this machine: a link to the account's origin is never followed.
  await context.route(
    (url) => url.hostname !== "127.0.0.1",
    (r) => r.abort(),
  );
  await context.addInitScript(fakeShell, o.fresh ? { settled: false } : {});
  await insetsInit(context, o.insets ?? DUO[size]?.insets ?? NONE);
  const page = await context.newPage();
  await fakeKeyboard(page, 0);
  if (!o.fresh) hub.add("me@example.com", ss.key, Date.parse("2026-11-03T09:00:00Z"));
  return {
    ss,
    hub,
    server,
    context,
    page,
    approve: async () => {
      const id = [...hub.accounts.keys()][0]!;
      const asked = await page.evaluate(
        (account) =>
          (
            window as unknown as { __TAURI_INTERNALS__: { invoke(c: string, a: unknown): Promise<unknown> } }
          ).__TAURI_INTERNALS__.invoke("acct_device_ask", { id: account }) as Promise<{ keyId: string }>,
        id,
      );
      (ss.machines[0]!.passkey_ids as string[]).push(asked.keyId);
      ss.trusting.set(asked.keyId, [MACHINE.id]);
    },
    close: async () => {
      await context.close();
      await server.close();
    },
  };
}
