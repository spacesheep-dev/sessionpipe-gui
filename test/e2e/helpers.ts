// SPDX-License-Identifier: Apache-2.0
// Shared pieces for the end-to-end suite: page openers that wait for the live stream, a
// window resized, the session's message field, a check for a full stop that starts a line, a hand-rolled ULID
// (so the specs need nothing but @playwright/test), a tier-1 batch a sink would send, with
// a fresh session id per call, a session posted with a permission prompt open, and a
// working session with the one it asked (sessionpipe ask), whose prompt opens and clears.
import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, type Locator, type Page } from "@playwright/test";

export const INFO = "/api/ui/info";
export const EVENTS = "/api/sessionpipe/v1/events";
export const WELL_KNOWN = "/.well-known/sessionpipe";

/** A computer that has not chosen how sessions open (the suite chooses As a page,
 *  playwright.config.ts): from the page's first load, and not again, so a choice made in
 *  the test outlives a reload. */
export const openSessionsUnchosen = (page: Page) =>
  page.addInitScript(() => {
    if (sessionStorage.getItem("e2e-unchosen")) return;
    sessionStorage.setItem("e2e-unchosen", "1");
    localStorage.setItem("sessionpipe-gui.settings", JSON.stringify({ mode: "advanced" }));
  });

export const sessionUrl = (harness: string, id: string) =>
  `/s/${encodeURIComponent(harness)}/${encodeURIComponent(id)}`;

/** A session's message field, found by its place: its name is the words it shows, which
 *  change with the mode ("What should change?" in a plan review). */
export const composer = (page: Page) => page.locator(".ctl-ask textarea");

/** Opens a page and waits until the stream is live and the first snapshot rendered. */
export async function openPage(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator(".conn").first()).toHaveText("live", { timeout: 15_000 });
}

/** The board with at least one group rendered. */
export async function openBoard(page: Page): Promise<void> {
  await openPage(page, "/");
  await expect(page.locator("section.group").first()).toBeVisible();
}

/** The window resized, and the page given the frames in which it hears of it. */
export async function resizeWindow(page: Page, size: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(size);
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size.width);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** Rests the pointer on the board's list, so it holds still (Board.tsx `useListHold`): a row
 *  read is then the row clicked. The list itself never moves, so this waits on no card. The
 *  pointer goes 40 px into the part of the list on screen, not its top: a click far down a
 *  long board (the Done toggle) scrolls the page, which takes the list's top off screen and
 *  puts the sticky page bar over what is left of it. */
export async function holdBoard(page: Page): Promise<void> {
  const list = page.locator(".board-list");
  await expect(list).toBeVisible();
  const at = await list.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const bottom = Math.min(box.bottom, innerHeight);
    for (let top = Math.max(box.top, 0); top < bottom; top++) {
      if (!el.contains(document.elementFromPoint(x, top))) continue;
      const y = top + Math.min(40, (bottom - top) / 2);
      return { x, y: el.contains(document.elementFromPoint(x, y)) ? y : top };
    }
    return null;
  });
  expect(at, "some of the board's list is on screen").not.toBeNull();
  await page.mouse.move(at!.x, at!.y);
  await expect(page.locator(".page.board")).toHaveAttribute("data-held", "");
}

/** Puts the page's event streams under the test's hand; call it before the page loads.
 *  Chromium's offline mode leaves an open EventSource open and a route only meets the next
 *  request, so `dropStream` ends the open ones the way a dead socket does. */
export async function tapStream(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Real = window.EventSource;
    const open = new Set<EventSource>();
    window.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        open.add(this);
      }
      close() {
        open.delete(this);
        super.close();
      }
    };
    (window as unknown as { __dropStream: () => void }).__dropStream = () => {
      for (const es of [...open]) {
        es.close();
        es.onerror?.(new Event("error"));
      }
    };
  });
}

/** The receiver stops answering the stream and the open one dies (`tapStream` first): the
 *  page is reconnecting until the returned function lets the stream through again. */
export async function dropStream(page: Page): Promise<() => Promise<void>> {
  await page.route("**/api/ui/stream", (route) => route.abort("connectionrefused"));
  await page.evaluate(() => (window as unknown as { __dropStream: () => void }).__dropStream());
  return () => page.unroute("**/api/ui/stream");
}

/** The widths, 100 to 400 px, at which a line of `el` starts with a mark that belongs to
 *  the word before it (a full stop, a "·", a no-break space). `el` is set to each width in
 *  turn and given back as it was. */
export function strandedMarks(el: Locator): Promise<number[]> {
  return el.evaluate((node: HTMLElement) => {
    const was = node.getAttribute("style");
    if (getComputedStyle(node).display === "inline") node.style.display = "block";
    node.style.maxWidth = "none";
    const chars: Range[] = [];
    const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
      for (let i = 0; i < t.data.length; i++) {
        const r = document.createRange();
        r.setStart(t, i);
        r.setEnd(t, i + 1);
        chars.push(r);
      }
    }
    const found: number[] = [];
    for (let w = 100; w <= 400; w++) {
      node.style.width = `${w}px`;
      // Every line starts where the first does: a mark there begins a line.
      let start: number | null = null;
      for (const r of chars) {
        const box = r.getClientRects()[0];
        if (!box || box.width === 0) continue;
        if (start === null) start = box.left;
        else if (Math.abs(box.left - start) < 0.5 && /^[.,;:!?·\u00a0]$/.test(r.toString())) {
          found.push(w);
          break;
        }
      }
    }
    if (was === null) node.removeAttribute("style");
    else node.setAttribute("style", was);
    return found;
  });
}

type Box = { x: number; y: number; width: number; height: number };

/** Whether a one-line row of facts holds all its parts whole: its width with every part at
 *  its whole width (each part's own box, as the layout sizes it from the whole text) is no
 *  more than the width the layout gave it. Read in one frame, set back as it was. */
export function fits(line: Locator): Promise<boolean> {
  return line.evaluate((el: HTMLElement) => {
    const given = el.getBoundingClientRect().width;
    const was = el.getAttribute("style");
    const gone = Array.from(el.querySelectorAll<HTMLElement>("[data-gone]"));
    for (const g of gone) g.removeAttribute("data-gone");
    el.style.setProperty("width", "max-content", "important");
    el.style.setProperty("max-width", "none", "important");
    el.style.setProperty("flex", "none", "important");
    const whole = el.getBoundingClientRect().width;
    for (const g of gone) g.setAttribute("data-gone", "");
    if (was === null) el.removeAttribute("style");
    else el.setAttribute("style", was);
    return whole <= given + 0.5;
  });
}

/** What a row of facts with a rule's mark draws of each part: the text each would show
 *  whole and what it shows (a chip's without the dot it draws before its words), and
 *  whether a part left (`data-gone`). Read in one frame. */
export function metaParts(line: Locator): Promise<
  {
    cls: string;
    whole: string;
    shown: string;
    cut: boolean;
    gone: boolean;
    right: number;
    textRight: number;
  }[]
> {
  return line.evaluate((el: HTMLElement) =>
    Array.from(el.children)
      .filter((c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains("glyph-wrap"))
      .filter((c) => !c.matches(".card-sep, [aria-hidden='true'], .sr-only"))
      .map((c) => {
        const chip = c.matches(".chip") ? c : c.querySelector<HTMLElement>(".chip");
        const text = chip?.querySelector<HTMLElement>(".midcut-text");
        const range = document.createRange();
        if (text) range.selectNodeContents(text);
        const sep = chip?.dataset.sep?.length ?? 0;
        const whole = chip ? (chip.dataset.text ?? "").slice(sep) : (c.textContent ?? "");
        const shown = text ? (text.textContent ?? "").slice(sep) : (c.textContent ?? "");
        return {
          cls: c.className,
          whole,
          shown,
          // A chip is cut when it draws less than its text; an ellipsis span, when its text
          // runs past its box.
          cut: text ? shown !== whole : c.scrollWidth > c.clientWidth + 0.5,
          gone: c.hasAttribute("data-gone"),
          right: (chip ?? c).getBoundingClientRect().right,
          textRight: text ? range.getBoundingClientRect().right : c.getBoundingClientRect().right,
        };
      }),
  );
}

/** Where a cut chip's words end in its box, whatever the cut left over: a short word is
 *  put in place of them for one read, and how far its end is from the box's right edge is
 *  given (0 when the words are set flush right). Set back as it was in the same frame. */
export function wordsEnd(chip: Locator): Promise<number> {
  return chip.evaluate((el: HTMLElement) => {
    const line = el.querySelector<HTMLElement>(".midcut-text")!;
    const node = line.firstChild as Text;
    const was = node.nodeValue;
    node.nodeValue = "x";
    const range = document.createRange();
    range.selectNodeContents(node);
    const gap = line.getBoundingClientRect().right - range.getBoundingClientRect().right;
    node.nodeValue = was;
    return gap;
  });
}

/** The room a part of a row of facts gives its own words, in ems of its font: from where
 *  they start (after the "· " or the dot drawn before them) to where the part is cut off. */
export function wordsRoom(part: Locator): Promise<number> {
  return part.evaluate((el: HTMLElement) => {
    let text: Text | null = null;
    for (let n = el.lastChild; n && !text; n = n.previousSibling)
      if (n.nodeType === Node.TEXT_NODE && n.nodeValue?.trim()) text = n as Text;
    const right = el.getBoundingClientRect().right;
    const range = document.createRange();
    if (text) range.selectNodeContents(text);
    const start = text ? range.getBoundingClientRect().left : right;
    return (right - start) / Number.parseFloat(getComputedStyle(el).fontSize);
  });
}

/** The room between each "·" of a row of facts and the word after it, in order: the dots
 *  the line draws as text, a separator element's, and a chip's own. Read in one frame. */
export function dotGaps(line: Locator): Promise<number[]> {
  return line.evaluate((el: HTMLElement) => {
    const out: number[] = [];
    const nodes: Text[] = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const p = n.parentElement!;
      if (p.closest(".sr-only, [data-gone]") || getComputedStyle(p).display === "none") continue;
      if (n.nodeValue?.trim()) nodes.push(n as Text);
    }
    const box = (n: Text, i: number) => {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 1);
      return r.getBoundingClientRect();
    };
    nodes.forEach((n, k) => {
      const v = n.nodeValue!;
      for (let i = 0; i < v.length; i++) {
        if (v[i] !== "·") continue;
        // The next letter: in this text, or the first of the next one.
        let j = i + 1;
        while (j < v.length && v[j] === " ") j++;
        const next =
          j < v.length ? box(n, j) : nodes[k + 1] ? box(nodes[k + 1]!, nodes[k + 1]!.nodeValue!.search(/\S/)) : null;
        if (next) out.push(next.left - box(n, i).right);
      }
    });
    return out;
  });
}

/** How far a focus ring drawn round `el` (its outline, off its edge by its offset) is cut
 *  off by the boxes it sits in that clip what overflows them: one line per side cut. */
export function ringCut(el: Locator): Promise<string[]> {
  return el.evaluate((node: HTMLElement) => {
    const cs = getComputedStyle(node);
    const out = Number.parseFloat(cs.outlineWidth) + Number.parseFloat(cs.outlineOffset);
    const r = node.getBoundingClientRect();
    const ring = { left: r.left - out, right: r.right + out, top: r.top - out, bottom: r.bottom + out };
    const cut: string[] = [];
    for (let a = node.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      const b = a.getBoundingClientRect();
      const left = b.left + a.clientLeft;
      const top = b.top + a.clientTop;
      const box = { left, top, right: left + a.clientWidth, bottom: top + a.clientHeight };
      const by = (side: keyof typeof box, d: number) =>
        d > 0.5 && cut.push(`${a.className} ${side} by ${d.toFixed(1)}`);
      if (s.overflowX !== "visible") {
        by("left", box.left - ring.left);
        by("right", ring.right - box.right);
      }
      if (s.overflowY !== "visible") {
        by("top", box.top - ring.top);
        by("bottom", ring.bottom - box.bottom);
      }
    }
    return cut;
  });
}

/** A Board kid row's box, its title's and its computer's, read in one frame: a card that
 *  slides to a new place (useFlip's translate) moves all three together, so two reads
 *  apart could see it half way. */
export function kidBoxes(kid: Locator): Promise<{ row: Box; title: Box; chip: Box }> {
  return kid.evaluate((el: HTMLElement) => {
    const box = (n: Element) => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return { row: box(el), title: box(el.querySelector(".kid-title")!), chip: box(el.querySelector(".kid-where")!) };
  });
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID (26 Crockford base32 chars: 48-bit ms time + 80 random bits). */
export function ulid(time = Date.now()): string {
  let t = time;
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = CROCKFORD[t % 32] + head;
    t = Math.floor(t / 32);
  }
  let tail = "";
  for (let i = 0; i < 16; i++) tail += CROCKFORD[Math.floor(Math.random() * 32)];
  return head + tail;
}

export interface Batch {
  harness: string;
  sessionId: string;
  title: string;
  events: Record<string, unknown>[];
}

/** One short Claude Code session at tier 1: start, a turn with one tool, the turn's end.
 *  Times sit a minute in the past so they never run ahead of arrival. */
export function tier1Batch(opts: { title?: string; machine?: string } = {}): Batch {
  const harness = "claude-code";
  const sessionId = randomUUID();
  const title = opts.title ?? `E2E receiver ${sessionId.slice(0, 8)}`;
  const machine = opts.machine ?? "e2e-box";
  const turnId = randomUUID();
  const callId = `toolu_${ulid().slice(0, 20)}`;
  let seq = 0;
  let clock = Date.now() - 60_000;
  const ev = (type: string, data: Record<string, unknown>, hook: string) => {
    clock += 1000;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 1,
      harness: { name: harness, version: "2.1.296", event: hook },
      session: {
        id: sessionId,
        seq: seq++,
        machine,
        cwd: "~/code/e2e",
        repo: "github.com/e2e/fixture",
        branch: "main",
        title,
        title_source: "custom",
      },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const events = [
    ev("session.started", { source: "startup" }, "SessionStart"),
    ev("turn.started", { turn_id: turnId, prompt_chars: 42 }, "UserPromptSubmit"),
    ev("tool.started", { tool: "Read", call_id: callId, turn_id: turnId }, "PreToolUse"),
    ev("tool.ended", { tool: "Read", call_id: callId, turn_id: turnId, ms: 12, ok: true }, "PostToolUse"),
    ev("turn.ended", { turn_id: turnId, reason: "stop", ms: 3000 }, "Stop"),
  ];
  return { harness, sessionId, title, events };
}

/** A Claude Code session on `machine` that asks to run `npm run deploy`, posted the way its
 *  hooks send it (tier 1), a few seconds old; `clear()` closes the prompt again, so no other
 *  spec finds it open. */
export async function openPrompt(
  request: APIRequestContext,
  o: { machine: string; title: string },
): Promise<{ harness: string; sessionId: string; key: string; attention: string; clear: () => Promise<void> }> {
  const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
  const harness = "claude-code";
  const sessionId = randomUUID();
  const attention = `perm-${sessionId.slice(0, 8)}`;
  let seq = 0;
  let clock = Date.now() - 5_000;
  const ev = (type: string, data: Record<string, unknown>, hook: string) => {
    clock = type === "attention.cleared" ? Date.now() : clock + 500;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 1,
      harness: { name: harness, version: "2.1.296", event: hook },
      session: {
        id: sessionId,
        seq: seq++,
        machine: o.machine,
        cwd: "~/code/e2e",
        title: o.title,
        title_source: "custom",
      },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const post = async (events: unknown[]) => {
    const res = await request.post(EVENTS, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sinkToken}`,
        "sessionpipe-protocol": "1",
      },
      data: { events },
    });
    expect(res.status()).toBe(202);
  };
  await post([
    ev("session.started", { source: "startup" }, "SessionStart"),
    ev("turn.started", { turn_id: "t1", prompt_chars: 20 }, "UserPromptSubmit"),
    ev(
      "attention.needed",
      { attention_id: attention, kind: "permission", tool: "Bash", message: "npm run deploy" },
      "PermissionRequest",
    ),
  ]);
  return {
    harness,
    sessionId,
    key: `${harness}:${sessionId}`,
    attention,
    clear: () => post([ev("attention.cleared", { attention_id: attention, how: "answered" }, "PreToolUse")]),
  };
}

/** A Claude Code session working on `machine` and the Codex session it asked (`delegated_by`,
 *  as the daemon starts it: same machine, same folder), both mid-turn, posted the way
 *  their hooks send them. `raise()` opens a permission prompt in the asked one and
 *  `clear()` closes it; `end()` ends both, so no other spec finds them. With `subagent`
 *  the child is the parent's own subagent session instead (`parent_id`, Claude Code, so
 *  also one of its agents). */
export async function askedPair(
  request: APIRequestContext,
  o: { machine: string; title: string; subagent?: boolean },
): Promise<{
  parent: { key: string; id: string; title: string };
  child: { key: string; id: string; title: string };
  /** A prompt on the child (or, `"parent"`, on the parent: a session of its own). */
  raise: (on?: "child" | "parent") => Promise<string>;
  clear: () => Promise<void>;
  end: () => Promise<void>;
}> {
  const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
  const post = async (events: unknown[]) => {
    const res = await request.post(EVENTS, {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sinkToken}`,
        "sessionpipe-protocol": "1",
      },
      data: { events },
    });
    expect(res.status()).toBe(202);
  };
  let clock = Date.now() - 10_000;
  const sess = (harness: string, title: string, extra: Record<string, unknown> = {}) => {
    const id = randomUUID();
    let seq = 0;
    const ev = (type: string, data: Record<string, unknown>, hook: string) => {
      clock = Math.max(clock + 200, type === "attention.needed" || type === "attention.cleared" ? Date.now() : 0);
      return {
        protocol: 1,
        id: ulid(clock),
        type,
        time: new Date(clock).toISOString(),
        tier: 1,
        harness: { name: harness, version: harness === "codex" ? "0.98.0" : "2.1.296", event: hook },
        session: { id, seq: seq++, machine: o.machine, cwd: "~/code/tree", title, title_source: "custom", ...extra },
        privacy: { rulesets: ["secrets@1"], pii: false },
        data,
      };
    };
    return { id, key: `${harness}:${id}`, title, ev };
  };
  const parent = sess("claude-code", o.title);
  const child = o.subagent
    ? sess("claude-code", `${o.title}: the subagent`, { parent_id: parent.id })
    : sess("codex", `${o.title}: the asked one`, { delegated_by: parent.key });
  await post([
    parent.ev("session.started", { source: "startup" }, "SessionStart"),
    parent.ev("turn.started", { turn_id: "t1", prompt_chars: 30 }, "UserPromptSubmit"),
  ]);
  await post([
    child.ev("session.started", { source: o.subagent ? "fork" : "startup" }, "SessionStart"),
    child.ev("turn.started", { turn_id: "t1", prompt_chars: 60 }, "UserPromptSubmit"),
  ]);
  const open: { id: string; by: typeof child }[] = [];
  const clear = async () => {
    for (const { id, by } of open.splice(0))
      await post([by.ev("attention.cleared", { attention_id: id, how: "answered" }, "PreToolUse")]);
  };
  return {
    parent: { key: parent.key, id: parent.id, title: parent.title },
    child: { key: child.key, id: child.id, title: child.title },
    raise: async (on = "child") => {
      const id = `exec-${randomUUID()}`;
      const by = on === "parent" ? parent : child;
      open.push({ id, by });
      await post([
        by.ev(
          "attention.needed",
          { attention_id: id, kind: "permission", tool: "Bash", message: "npm run migrate" },
          "PermissionRequest",
        ),
      ]);
      return id;
    },
    clear,
    end: async () => {
      await clear();
      await post([
        child.ev("turn.ended", { turn_id: "t1", reason: "stop", ms: 2000 }, "Stop"),
        child.ev("session.ended", { reason: "exit" }, "SessionEnd"),
      ]);
      await post([
        parent.ev("turn.ended", { turn_id: "t1", reason: "stop", ms: 9000 }, "Stop"),
        parent.ev("session.ended", { reason: "exit" }, "SessionEnd"),
      ]);
    },
  };
}

/** Structural checks of a well-known document against schemas/v1/well-known.json:
 *  required fields, types, ranges and the enum/pattern constraints, by hand. */
export function wellKnownProblems(doc: unknown): string[] {
  const out: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const isInt = (v: unknown): v is number => Number.isInteger(v);
  if (!isObj(doc)) return ["document is not an object"];
  for (const k of ["protocol", "max_tier", "capabilities", "endpoints", "batch"])
    if (!(k in doc)) out.push(`missing ${k}`);
  const { protocol, max_tier, capabilities, auth, endpoints, batch, control } = doc;
  if (!Array.isArray(protocol) || protocol.length < 1 || !protocol.every((p) => isInt(p) && p >= 1))
    out.push("protocol must be a non-empty array of integers >= 1");
  if (!isInt(max_tier) || max_tier < 0 || max_tier > 3) out.push("max_tier must be an integer 0..3");
  if (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === "string" && /^[a-z][a-z0-9-]*$/.test(c)))
    out.push("capabilities must be an array of ^[a-z][a-z0-9-]*$ strings");
  if (auth !== undefined && (!Array.isArray(auth) || !auth.every((a) => a === "bearer")))
    out.push('auth must be an array of "bearer"');
  if (!isObj(endpoints)) out.push("endpoints must be an object");
  else {
    if (typeof endpoints.events !== "string") out.push("endpoints.events must be a string");
    for (const k of ["control", "native"])
      if (endpoints[k] !== undefined && typeof endpoints[k] !== "string") out.push(`endpoints.${k} must be a string`);
  }
  if (!isObj(batch)) out.push("batch must be an object");
  else {
    if (!isInt(batch.max_events) || batch.max_events < 1 || batch.max_events > 50)
      out.push("batch.max_events must be an integer 1..50");
    if (!isInt(batch.max_bytes) || batch.max_bytes < 1024 || batch.max_bytes > 262144)
      out.push("batch.max_bytes must be an integer 1024..262144");
  }
  const lists = Array.isArray(capabilities) && capabilities.includes("control");
  if (control !== undefined || lists) {
    if (!isObj(control)) out.push("control must be an object when capabilities lists control");
    else {
      if (!isInt(control.wait_max_s) || control.wait_max_s < 1 || control.wait_max_s > 60)
        out.push("control.wait_max_s must be an integer 1..60");
      if (control.open_pairing !== undefined && typeof control.open_pairing !== "boolean")
        out.push("control.open_pairing must be a boolean");
      if (
        control.session_tools !== undefined &&
        (!Array.isArray(control.session_tools) ||
          control.session_tools.length > 8 ||
          !control.session_tools.every((t) => typeof t === "string" && /^mcp__[A-Za-z0-9_-]{1,64}$/.test(t)))
      )
        out.push("control.session_tools must be at most 8 ^mcp__[A-Za-z0-9_-]{1,64}$ strings");
      const s = control.signing;
      if (!isObj(s)) out.push("control.signing must be an object");
      else {
        if (typeof s.rp_id !== "string" || s.rp_id.length < 1 || s.rp_id.length > 253)
          out.push("control.signing.rp_id must be a string of 1..253 chars");
        if (!Array.isArray(s.algs) || s.algs.length < 1 || !s.algs.every((a) => a === -7 || a === -257))
          out.push("control.signing.algs must be a non-empty array of -7 / -257");
      }
    }
  }
  return out;
}

/** A Claude Code session on build-box (or `machine`; "" for none) that a rule named `rule`
 *  started, mid-turn, posted the way its hooks send it (tier 1); `end()` ends it, so no
 *  other spec finds it. No `repo`, none. */
export async function postRuled(
  request: APIRequestContext,
  o: { rule: string; repo?: string; machine?: string; branch?: string },
): Promise<{ id: string; rule: string; title: string; more: (n: number) => Promise<void>; end: () => Promise<void> }> {
  const { sinkToken: token } = (await (await request.get(INFO)).json()) as { sinkToken: string };
  const id = randomUUID();
  const title = "Rotate the staging certificates";
  let seq = 0;
  let clock = Date.now() - 20_000;
  const ev = (type: string, data: Record<string, unknown>, hook: string) => {
    clock += 1000;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 1,
      harness: { name: "claude-code", version: "2.1.296", event: hook },
      session: {
        id,
        seq: seq++,
        ...(o.machine === "" ? {} : { machine: o.machine ?? "build-box" }),
        cwd: "~/work/infra",
        ...(o.repo ? { repo: o.repo } : {}),
        ...(o.branch ? { branch: o.branch } : {}),
        title,
        title_source: "custom",
        triggered_by: o.rule,
      },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const post = async (events: unknown[]) => {
    const res = await request.post(EVENTS, {
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "sessionpipe-protocol": "1" },
      data: { events },
    });
    expect(res.status()).toBe(202);
  };
  await post([
    ev("session.started", { source: "startup" }, "SessionStart"),
    ev("turn.started", { turn_id: "t1", prompt_chars: 60 }, "UserPromptSubmit"),
    ev("tool.started", { tool: "Bash", call_id: `toolu_${id.slice(0, 8)}`, turn_id: "t1" }, "PreToolUse"),
  ]);
  /** `n` more of the run's tools, each started and ended. */
  const more = (n: number) =>
    post(
      Array.from({ length: n }, (_, i) => [
        ev(
          "tool.ended",
          { tool: "Bash", call_id: `toolu_${id.slice(0, 8)}${i || ""}`, turn_id: "t1", ok: true },
          "PostToolUse",
        ),
        ev("tool.started", { tool: "Bash", call_id: `toolu_${id.slice(0, 8)}${i + 1}`, turn_id: "t1" }, "PreToolUse"),
      ]).flat(),
    );
  return { id, rule: o.rule, title, more, end: () => post([ev("session.ended", { reason: "exit" }, "SessionEnd")]) };
}
