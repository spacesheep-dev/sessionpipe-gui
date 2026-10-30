// SPDX-License-Identifier: Apache-2.0
// The side panel's state as the URL and its mirror carry it, and the phone's exception:
// there a session opens as its page, nothing is mirrored and nothing is restored.
import "../native/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentTabKey, openSplit, parseSplit, restoreSplit, tabPath } from "./split";

const g = globalThis as Record<string, unknown>;
const KEY_TABS = "sessionpipe-gui.splitTabs";

/** The page's history, enough for the router: the URL moves, nothing is kept. */
function at(path: string) {
  g.location = new URL(path, "http://127.0.0.1:7816/");
  g.history = {
    length: 1,
    pushState: (_s: unknown, _t: string, url: string) => {
      g.location = new URL(url, "http://127.0.0.1:7816/");
    },
    replaceState: (_s: unknown, _t: string, url: string) => {
      g.location = new URL(url, "http://127.0.0.1:7816/");
    },
  };
}
const where = () => `${(g.location as URL).pathname}${(g.location as URL).search}`;
const phone = (on: boolean) => {
  g.matchMedia = (q: string) => ({
    matches: on && q === "(max-width: 839px)",
    addEventListener() {},
    removeEventListener() {},
  });
};

beforeEach(() => at("/inbox"));
afterEach(() => {
  delete g.matchMedia;
  localStorage.removeItem(KEY_TABS);
});

describe("parseSplit", () => {
  it("reads the tabs and the active index, dropping what is not a key", () => {
    expect(parseSplit("claude-code:a,codex:b, x ,claude-code:a", "1")).toEqual({
      tabs: ["claude-code:a", "codex:b"],
      active: 1,
    });
    expect(parseSplit(null, null)).toEqual({ tabs: [], active: 0 });
    expect(parseSplit("claude-code:a", "9")).toEqual({ tabs: ["claude-code:a"], active: 0 });
  });
});

describe("on a desktop", () => {
  beforeEach(() => phone(false));

  it("openSplit puts the tab in the URL and the mirror; restoreSplit brings it back", () => {
    openSplit("claude-code:abc");
    expect(where()).toBe("/inbox?s=claude-code%3Aabc");
    expect(JSON.parse(localStorage.getItem(KEY_TABS) ?? "null")).toEqual({ tabs: ["claude-code:abc"], active: 0 });
    at("/machines");
    restoreSplit();
    expect(where()).toBe("/machines?s=claude-code%3Aabc");
  });
});

describe("on the phone", () => {
  beforeEach(() => phone(true));

  it("openSplit opens the session's page instead, and mirrors nothing", () => {
    openSplit("claude-code:abc", { background: true });
    expect(where()).toBe("/s/claude-code/abc");
    expect(localStorage.getItem(KEY_TABS)).toBeNull();
    // An agent's tab: the session's page on that agent.
    at("/");
    openSplit(agentTabKey("claude-code:abc", "ag1"));
    expect(where()).toBe("/s/claude-code/abc?agent=ag1");
    expect(tabPath("codex:x/y")).toBe("/s/codex/x%2Fy");
  });

  it("restoreSplit leaves a desktop's mirror alone: no sheet over the page it opens on", () => {
    localStorage.setItem(KEY_TABS, JSON.stringify({ tabs: ["claude-code:abc"], active: 0 }));
    at("/machines");
    restoreSplit();
    expect(where()).toBe("/machines");
    // The mirror is still there for the desktop that made it.
    expect(localStorage.getItem(KEY_TABS)).not.toBeNull();
  });
});
