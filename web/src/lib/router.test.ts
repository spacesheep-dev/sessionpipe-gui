// SPDX-License-Identifier: Apache-2.0
// The side panel across page changes. It goes along to every page; a session's own page
// takes its tab out of the strip, as one history entry that Back undoes; an address (a
// link's, a copied one) never carries the tabs onto a session; the phone layout carries
// none; and the mirror for the next launch follows the URL, from the boot on.
import "../native/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHONE_QUERY } from "./device";
import { landingFor } from "./landing";
import { absoluteUrl } from "./menus";
import { agentPath, hrefFor, navigate, panelOnto, sessionPath } from "./router";
import { restoreSplit } from "./split";

const g = globalThis as Record<string, unknown>;
const KEY_TABS = "sessionpipe-gui.splitTabs";
const ORIGIN = "http://127.0.0.1:7816";

/** The page's history as a browser keeps it: a stack. A push adds an entry after the one
 *  shown, a replace rewrites it, and back shows the one before and says so (popstate). */
let stack: string[] = [];
let shown = 0;
const show = () => {
  g.location = new URL(stack[shown]!, ORIGIN);
};
function at(path: string) {
  stack = [path];
  shown = 0;
  show();
  g.history = {
    get length() {
      return stack.length;
    },
    state: null,
    pushState: (_s: unknown, _t: string, url: string) => {
      stack = [...stack.slice(0, shown + 1), url];
      shown += 1;
      show();
    },
    replaceState: (_s: unknown, _t: string, url: string) => {
      stack[shown] = url;
      show();
    },
    back: () => {
      if (shown === 0) return;
      shown -= 1;
      show();
      window.dispatchEvent(new Event("popstate"));
    },
  };
}
const back = () => (g.history as { back: () => void }).back();
/** Where the page is, with the tabs readable (`:` and `,` as written, not as encoded). */
const where = () => decodeURIComponent(`${(g.location as URL).pathname}${(g.location as URL).search}`);
const mirror = () => JSON.parse(localStorage.getItem(KEY_TABS) ?? "null") as unknown;

/** The window's width as the browser reports it, asked afresh each time. */
let narrow = false;
g.matchMedia = (q: string) => ({
  get matches() {
    return narrow && q === PHONE_QUERY;
  },
  addEventListener() {},
  removeEventListener() {},
});

const A = "claude-code:a";
const B = "claude-code:b";
const C = "claude-code:c";
/** A's tab on its subagent g. */
const AG = `${A}#g`;

beforeEach(() => at("/inbox"));
afterEach(() => {
  narrow = false;
  localStorage.removeItem(KEY_TABS);
});

describe("panelOnto", () => {
  it("takes a session's own tab out for its page and moves the active index as a close does", () => {
    const page = sessionPath("claude-code", "b");
    // The active tab leaves: its right neighbour takes over, else the left one.
    expect(panelOnto(page, `${A},${B},${C}`, "1")).toEqual({ s: `${A},${C}`, t: "1" });
    expect(panelOnto(page, `${A},${B}`, "1")).toEqual({ s: A, t: null });
    // An earlier tab leaves: the same tab stays active.
    expect(panelOnto(sessionPath("claude-code", "a"), `${A},${B},${C}`, "2")).toEqual({ s: `${B},${C}`, t: "1" });
    // A later one: nothing moves.
    expect(panelOnto(sessionPath("claude-code", "c"), `${A},${B},${C}`, "0")).toEqual({ s: `${A},${B}`, t: "0" });
  });

  it("leaves nothing when the page's own tab was the only one", () => {
    expect(panelOnto(sessionPath("claude-code", "a"), A, null)).toBeNull();
  });

  it("carries the strip as it is to any other page, an unrelated session's included", () => {
    expect(panelOnto("/machines", `${A},${B}`, "1")).toEqual({ s: `${A},${B}`, t: "1" });
    expect(panelOnto(sessionPath("claude-code", "z"), `${A},${B}`, "1")).toEqual({ s: `${A},${B}`, t: "1" });
    expect(panelOnto(sessionPath("codex", "a"), A, null)).toEqual({ s: A, t: null });
  });

  it("tells a session's tab from its agents' tabs", () => {
    // The page on agent g takes only g's tab; the session's own tab stays.
    expect(panelOnto(agentPath("claude-code", "a", "g"), `${A},${AG},${B}`, "1")).toEqual({ s: `${A},${B}`, t: "1" });
    // The session's page takes the session's tab; its agent's stays.
    expect(panelOnto(sessionPath("claude-code", "a"), `${A},${AG},${B}`, "0")).toEqual({ s: `${AG},${B}`, t: "0" });
    // An agent with no tab of its own: nothing leaves.
    expect(panelOnto(agentPath("claude-code", "a", "h"), `${A},${AG}`, "0")).toEqual({ s: `${A},${AG}`, t: "0" });
  });

  it("reads the page from the path alone: an encoded id, a hash after it", () => {
    expect(panelOnto("/s/codex/x%2Fy#seq-3", `codex:x/y,${A}`, "0")).toEqual({ s: A, t: null });
    expect(panelOnto(`${sessionPath("claude-code", "a")}?file=src%2Fa.ts`, `${A},${B}`, "0")).toEqual({
      s: B,
      t: null,
    });
  });
});

describe("navigate, where there is a beside", () => {
  it("opens a session as a page with the other tabs beside it; Back puts the strip back", () => {
    at(`/inbox?s=${A},${B},${C}&t=1`);
    navigate(sessionPath("claude-code", "b"));
    expect(where()).toBe(`/s/claude-code/b?s=${A},${C}&t=1`);
    // One history entry moved the tab out, so one Back undoes it.
    expect(stack).toHaveLength(2);
    back();
    expect(where()).toBe(`/inbox?s=${A},${B},${C}&t=1`);
  });

  it("carries no s onto the page of the only tab", () => {
    at(`/inbox?s=${A}`);
    navigate(sessionPath("claude-code", "a"));
    expect(where()).toBe("/s/claude-code/a");
  });

  it("keeps every tab beside a session that has none", () => {
    at(`/?s=${A},${B}&t=0`);
    navigate(sessionPath("claude-code", "z"));
    expect(where()).toBe(`/s/claude-code/z?s=${A},${B}&t=0`);
    // And from that page on: the Board still has them.
    navigate("/");
    expect(where()).toBe(`/?s=${A},${B}&t=0`);
  });

  it("takes only an agent's tab out for the page on that agent", () => {
    at(`/?s=${encodeURIComponent(`${A},${AG},${B}`)}&t=1`);
    navigate(agentPath("claude-code", "a", "g"));
    expect(where()).toBe(`/s/claude-code/a?agent=g&s=${A},${B}&t=1`);
  });

  it("keeps the mock flag with the panel", () => {
    at(`/?mock=1&s=${A},${B}&t=1`);
    navigate(sessionPath("claude-code", "b"));
    expect(where()).toBe(`/s/claude-code/b?mock=1&s=${A}`);
  });
});

describe("an address", () => {
  it("never carries the tabs onto a session: a link's href, a copied link", () => {
    at(`/inbox?s=${A},${B},${C}&t=1`);
    expect(hrefFor(sessionPath("claude-code", "b"))).toBe("/s/claude-code/b");
    expect(hrefFor(sessionPath("claude-code", "z"))).toBe("/s/claude-code/z");
    expect(absoluteUrl(sessionPath("claude-code", "b"))).toBe(`${ORIGIN}/s/claude-code/b`);
    expect(absoluteUrl(agentPath("claude-code", "a", "g"))).toBe(`${ORIGIN}/s/claude-code/a?agent=g`);
  });

  it("carries them to the other pages, as it did", () => {
    at(`/inbox?s=${A},${B},${C}&t=1`);
    expect(decodeURIComponent(hrefFor("/machines"))).toBe(`/machines?s=${A},${B},${C}&t=1`);
  });
});

describe("navigate, on the phone layout", () => {
  it("carries nothing onto a session's page: it is the whole screen", () => {
    narrow = true;
    at(`/inbox?s=${A},${B},${C}&t=1`);
    navigate(sessionPath("claude-code", "z"));
    expect(where()).toBe("/s/claude-code/z");
    at(`/inbox?s=${A},${B},${C}&t=1`);
    navigate(sessionPath("claude-code", "b"));
    expect(where()).toBe("/s/claude-code/b");
  });
});

describe("the mirror", () => {
  it("follows the URL: a tab that left for its page, the strip Back put back, the last tab gone", () => {
    at(`/inbox?s=${A},${B},${C}&t=1`);
    restoreSplit();
    navigate(sessionPath("claude-code", "b"));
    expect(mirror()).toEqual({ tabs: [A, C], active: 1 });
    back();
    expect(mirror()).toEqual({ tabs: [A, B, C], active: 1 });
    // A page change that keeps the strip keeps the mirror.
    navigate("/machines");
    expect(mirror()).toEqual({ tabs: [A, B, C], active: 1 });
    at(`/inbox?s=${A}`);
    navigate(sessionPath("claude-code", "a"));
    expect(mirror()).toBeNull();
  });

  it("keeps nothing on the phone layout", () => {
    at(`/inbox?s=${A},${B}&t=0`);
    restoreSplit();
    localStorage.setItem(KEY_TABS, JSON.stringify({ tabs: [C], active: 0 }));
    narrow = true;
    navigate("/machines");
    expect(mirror()).toEqual({ tabs: [C], active: 0 });
  });

  it("is not emptied by an address that moves before the boot has read it", async () => {
    // A page load of its own: the modules as they are before the shell's boot.
    vi.resetModules();
    const fresh = { router: await import("./router"), split: await import("./split") };
    localStorage.setItem(KEY_TABS, JSON.stringify({ tabs: [A, B], active: 1 }));
    at("/");
    fresh.router.navigate("/machines");
    expect(mirror()).toEqual({ tabs: [A, B], active: 1 });
    fresh.split.restoreSplit();
    expect(where()).toBe(`/machines?s=${A},${B}&t=1`);
  });
});

describe("the landing (Open on)", () => {
  it("lands on the chosen page with the tabs the boot put back", () => {
    localStorage.setItem(KEY_TABS, JSON.stringify({ tabs: [A], active: 0 }));
    at("/");
    const opened = { at: where(), asked: false };
    restoreSplit();
    expect(where()).toBe(`/?s=${A}`);
    const page = landingFor(opened, "/inbox");
    expect(page).toBe("/inbox");
    navigate(page!, { replace: true });
    expect(where()).toBe(`/inbox?s=${A}`);
    expect(stack).toHaveLength(1);
    expect(mirror()).toEqual({ tabs: [A], active: 0 });
  });
});
