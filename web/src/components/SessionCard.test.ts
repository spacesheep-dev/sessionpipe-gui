// SPDX-License-Identifier: Apache-2.0
// The row menu's Allow and Deny name the tool as the strip and the Inbox do, and show the
// keys of the surface that has them; a working row's preview starts where the reply's
// newest thought does.
import { describe, expect, it, vi } from "vitest";

// The menus this file imports listen on the window when they load; node has none.
vi.hoisted(() => {
  Object.assign(globalThis, { window: new EventTarget() });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { answerItems, Inline, newest } from "./SessionCard";

describe("answerItems", () => {
  it("names the tool by its label", () => {
    const st = { off: false, reason: null };
    expect(answerItems("run_shell_command", st, () => {}).map((i) => "label" in i && i.label)).toEqual([
      "Allow Shell",
      "Deny Shell",
    ]);
    expect(answerItems("Bash", st, () => {}).map((i) => "label" in i && i.label)).toEqual(["Allow Bash", "Deny Bash"]);
    expect(answerItems(undefined, st, () => {}).map((i) => "label" in i && i.label)).toEqual(["Allow", "Deny"]);
  });
  it("asks a plan review's own question", () => {
    const st = { off: false, reason: null };
    for (const tool of ["ExitPlanMode", "exit_plan_mode"])
      expect(answerItems(tool, st, () => {}).map((i) => "label" in i && i.label)).toEqual([
        "Approve plan",
        "Keep planning",
      ]);
  });
  it("has none for a prompt whose hook stopped waiting", () => {
    const st = { off: true, reason: "too late to answer from here; answer it on studio-mac", tag: "late" };
    expect(answerItems("Bash", st, () => {})).toEqual([]);
    expect(answerItems("Bash", { ...st, tag: "blocked" }, () => {})).toHaveLength(2);
  });
  it("carries the keys of the surface that answers by key, and none where no key does", () => {
    const st = { off: false, reason: null };
    const board = { allow: "board.allow", deny: "board.deny" };
    expect(answerItems("Bash", st, () => {}, board).map((i) => [i.label, i.action])).toEqual([
      ["Allow Bash", "board.allow"],
      ["Deny Bash", "board.deny"],
    ]);
    // A plan review's pair is answered by the same two keys.
    expect(answerItems("ExitPlanMode", st, () => {}, board).map((i) => [i.label, i.action])).toEqual([
      ["Approve plan", "board.allow"],
      ["Keep planning", "board.deny"],
    ]);
    const inbox = { allow: "inbox.allow", deny: "inbox.deny" };
    expect(answerItems("Bash", st, () => {}, inbox).map((i) => i.action)).toEqual(["inbox.allow", "inbox.deny"]);
    // A toast: a and d do nothing on it, so its menu shows no key.
    expect(answerItems("Bash", st, () => {}).map((i) => i.action)).toEqual([undefined, undefined]);
    // Off, the items keep their keys and say why.
    const off = answerItems("Bash", { off: true, reason: "pair build-box to send messages" }, () => {}, board);
    expect(off.map((i) => [i.action, i.disabled])).toEqual([
      ["board.allow", "pair build-box to send messages"],
      ["board.deny", "pair build-box to send messages"],
    ]);
  });
});

describe("newest", () => {
  const REPLY =
    "I read the relay's reader and the store's seq tracking. The holes are not lost events: spacesheep asks " +
    "senders to thin subagent tools and takes tier 2 and below, so those seqs were never sent. I think I know " +
    "what's doubling the replies: the page store and the relay both ingest one page twice after a reconnect. " +
    "Next I'll make the page skip what it already filed.";

  it("leaves 140 characters or fewer whole", () => {
    expect(newest("Going screen by screen.")).toBe("Going screen by screen.");
    const full = "a b ".repeat(35);
    expect(full).toHaveLength(140);
    expect(newest(full)).toBe(full);
  });

  it("starts at the newest sentence that leaves 40 characters, with no ellipsis", () => {
    expect(newest(REPLY)).toBe("Next I'll make the page skip what it already filed.");
    // "Done." leaves too little after it: the sentence before it starts the line.
    expect(newest(`${REPLY} Done.`)).toBe("Next I'll make the page skip what it already filed. Done.");
    // A new line is a break too, and so are a colon and a space.
    expect(newest(`${REPLY.slice(0, 200)}\nThe one fix left: skip a page it already filed.`)).toBe(
      "The one fix left: skip a page it already filed.",
    );
    expect(newest(`${REPLY.slice(0, 200)} The fix: skip a page the store has already filed.`)).toBe(
      "skip a page the store has already filed.",
    );
  });

  it("cuts one long sentence at a word near 90 characters from its end, after an ellipsis", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const out = newest(long);
    expect(out).toMatch(/^…word\d+ /);
    expect(Math.abs(out.length - 91)).toBeLessThanOrEqual(4);
    expect(long.endsWith(out.slice(1))).toBe(true);
    // No space at all: the last 90 characters.
    expect(newest("x".repeat(400))).toBe(`…${"x".repeat(89)}`);
  });

  it("never starts mid-word, and is never more than 300 characters", () => {
    const text = `${REPLY} ${Array.from({ length: 50 }, (_, i) => `step${i}`).join(" ")}`;
    for (let n = 141; n <= text.length; n++) {
      const cut = text.slice(0, n).trim();
      const out = newest(cut);
      const rest = out.replace(/^…/, "");
      expect(out.length).toBeLessThanOrEqual(300);
      expect(cut.endsWith(rest)).toBe(true);
      const at = cut.length - rest.length;
      expect(at === 0 || /\s/.test(cut[at - 1]!), `${n}: ${out}`).toBe(true);
    }
  });
});

describe("Inline", () => {
  const html = (text: string) => renderToStaticMarkup(createElement(Inline, { text }));
  it("keeps the words between code spans, a dash after one too", () => {
    expect(html("Fix `a.ts` - then `b`")).toBe(
      'Fix <code class="inline-code">a.ts</code> - then <code class="inline-code">b</code>',
    );
  });
  it("drops a leading mark once and reads emphasis as words", () => {
    expect(html("- **Done**: `x` moved")).toBe('Done: <code class="inline-code">x</code> moved');
  });
});
