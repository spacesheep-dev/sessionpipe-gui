// SPDX-License-Identifier: Apache-2.0
// Shared pieces for the end-to-end suite: page openers that wait for the live stream,
// a hand-rolled ULID (so the specs need nothing but @playwright/test), and a tier-1
// batch a sink would send, with a fresh session id per call.
import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";

export const INFO = "/api/ui/info";
export const EVENTS = "/api/sessionpipe/v1/events";
export const WELL_KNOWN = "/.well-known/sessionpipe";

export const sessionUrl = (harness: string, id: string) =>
  `/s/${encodeURIComponent(harness)}/${encodeURIComponent(id)}`;

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

/** Rests the pointer on the board's list, so it holds still (Board.tsx `useListHold`): a row
 *  read is then the row clicked. The list itself never moves, so this waits on no card. */
export async function holdBoard(page: Page): Promise<void> {
  const list = page.locator(".board-list");
  await expect(list).toBeVisible();
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(40, box.height / 2));
  await expect(page.locator(".page.board")).toHaveAttribute("data-held", "");
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
