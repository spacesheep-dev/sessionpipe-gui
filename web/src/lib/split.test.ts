// SPDX-License-Identifier: Apache-2.0
// The side panel's state as the URL and its mirror carry it, the one preview tab a plain
// open replaces, and the phone's exception: there a session opens as its page, nothing is
// mirrored and nothing is restored.
import "../native/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHONE_QUERY } from "./device";
import { setSettings } from "./settings";
import {
  agentTabKey,
  closeTab,
  howOf,
  keepTab,
  moveTab,
  type OpenHow,
  openAsked,
  openSession,
  openSplit,
  openWay,
  parseSplit,
  previewTab,
  restoreSplit,
  tabPath,
  takeJump,
} from "./split";

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
    matches: on && q === PHONE_QUERY,
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
  beforeEach(() => {
    phone(false);
    // The shell's boot: from here on the mirror follows the URL.
    restoreSplit();
  });

  it("openSplit puts the tab in the URL and the mirror; restoreSplit brings it back", () => {
    openSplit("claude-code:abc");
    expect(where()).toBe("/inbox?s=claude-code%3Aabc");
    expect(JSON.parse(localStorage.getItem(KEY_TABS) ?? "null")).toEqual({ tabs: ["claude-code:abc"], active: 0 });
    at("/machines");
    restoreSplit();
    expect(where()).toBe("/machines?s=claude-code%3Aabc");
  });
});

describe("preview tabs: a plain open replaces the one preview tab instead of adding one", () => {
  const tabs = () => parseSplit(new URL(where(), "http://x/").searchParams.get("s"), null).tabs;
  const active = () => {
    const q = new URL(where(), "http://x/").searchParams;
    return parseSplit(q.get("s"), q.get("t")).tabs[Number(q.get("t") ?? 0)];
  };
  beforeEach(() => {
    phone(false);
    restoreSplit();
  });
  it("a plain open replaces the preview, in place, and switches to a session already open", () => {
    openSplit("claude-code:a", { preview: true });
    expect(previewTab()).toBe("claude-code:a");
    openSplit("claude-code:b", { preview: true });
    openSplit("claude-code:c", { preview: true });
    expect(tabs()).toEqual(["claude-code:c"]);
    expect(previewTab()).toBe("claude-code:c");
    // Beside a kept tab the preview is swapped where it stands, and becomes the active one.
    openSplit("claude-code:k");
    openSplit("claude-code:d", { preview: true });
    expect(tabs()).toEqual(["claude-code:d", "claude-code:k"]);
    expect(active()).toBe("claude-code:d");
    openSplit("claude-code:k", { preview: true });
    expect(active()).toBe("claude-code:k");
    expect(tabs()).toEqual(["claude-code:d", "claude-code:k"]);
    expect(previewTab()).toBe("claude-code:d");
  });

  it("a kept tab is never replaced: an explicit open, a drag, or a closed preview leave none", () => {
    openSplit("claude-code:a");
    expect(previewTab()).toBeNull();
    openSplit("claude-code:b", { preview: true });
    // Opened explicitly while it is the preview: kept.
    openSplit("claude-code:b");
    expect(previewTab()).toBeNull();
    openSplit("claude-code:c", { preview: true });
    expect(tabs()).toEqual(["claude-code:a", "claude-code:b", "claude-code:c"]);
    moveTab(2, 0);
    expect(previewTab()).toBeNull();
    openSplit("claude-code:d", { preview: true });
    expect(tabs()).toEqual(["claude-code:c", "claude-code:a", "claude-code:b", "claude-code:d"]);
    closeTab(3);
    expect(previewTab()).toBeNull();
    // The same session opened again explicitly is not taken for a preview.
    openSplit("claude-code:d");
    expect(previewTab()).toBeNull();
    openSplit("claude-code:e", { preview: true });
    expect(tabs()).toHaveLength(5);
    // An agent's tab opened beside the preview session keeps the session's, so the pair holds.
    openSplit(agentTabKey("claude-code:e", "ag1"));
    expect(previewTab()).toBeNull();
    openSplit("claude-code:f", { preview: true });
    expect(tabs()).toEqual([
      "claude-code:c",
      "claude-code:a",
      "claude-code:b",
      "claude-code:d",
      "claude-code:e",
      agentTabKey("claude-code:e", "ag1"),
      "claude-code:f",
    ]);
  });

  it("⌘-open adds a kept background tab, and leaves the preview where it is", () => {
    openSplit("claude-code:a", { preview: true });
    openSplit("claude-code:b", { background: true, preview: true });
    expect(tabs()).toEqual(["claude-code:a", "claude-code:b"]);
    expect(active()).toBe("claude-code:a");
    expect(previewTab()).toBe("claude-code:a");
    openSplit("claude-code:c", { preview: true });
    expect(tabs()).toEqual(["claude-code:c", "claude-code:b"]);
  });

  it("typing keeps the tab, an agent's too, and no other", () => {
    openSplit("claude-code:a", { preview: true });
    keepTab("claude-code:other");
    expect(previewTab()).toBe("claude-code:a");
    keepTab("claude-code:a");
    expect(previewTab()).toBeNull();
    openSplit(agentTabKey("claude-code:b", "ag1"), { preview: true });
    keepTab("claude-code:b");
    expect(previewTab()).toBeNull();
    // Answering keeps nothing: test/e2e/inbox.spec.ts answers in the preview and opens the next.
  });

  it("a reload restores every tab and drops the preview mark", async () => {
    openSplit("claude-code:a");
    openSplit("claude-code:b", { preview: true });
    vi.resetModules();
    const fresh = await import("./split");
    at("/inbox");
    fresh.restoreSplit();
    expect(tabs()).toEqual(["claude-code:a", "claude-code:b"]);
    expect(fresh.previewTab()).toBeNull();
    fresh.openSplit("claude-code:c", { preview: true });
    expect(tabs()).toEqual(["claude-code:a", "claude-code:b", "claude-code:c"]);
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

describe("openWay: ↵ (primary), ⇧↵ (other) and ⌘↵ (background) through one rule", () => {
  const HOWS: OpenHow[] = ["primary", "other", "background"];
  const ways = () => HOWS.map(openWay);
  afterEach(() => setSettings({ openSessions: "page" }));

  it("on the phone every way is the page, under either setting", () => {
    phone(true);
    for (const openSessions of ["page", "beside"] as const) {
      setSettings({ openSessions });
      at("/");
      expect(ways()).toEqual(["page", "page", "page"]);
    }
  });

  it("where the panel does not show (Usage, Workflows) every way is the page: no tab out of sight", () => {
    phone(false);
    setSettings({ openSessions: "beside" });
    for (const path of ["/usage", "/workflows"]) {
      at(path);
      expect(ways()).toEqual(["page", "page", "page"]);
    }
  });

  it("with Beside set ↵ opens beside, ⇧↵ as a page, ⌘↵ in the background", () => {
    phone(false);
    setSettings({ openSessions: "beside" });
    for (const path of ["/", "/inbox", "/feed"]) {
      at(path);
      expect(ways()).toEqual(["beside", "page", "background"]);
    }
  });

  it("with As a page set ↵ opens the page, ⇧↵ beside, ⌘↵ in the background", () => {
    phone(false);
    setSettings({ openSessions: "page" });
    at("/");
    expect(ways()).toEqual(["page", "beside", "background"]);
  });
});

describe("openSession: every opener asks the one rule", () => {
  const q = () => new URL(where(), "http://x/").searchParams;
  const tabs = () => parseSplit(q().get("s"), null).tabs;
  beforeEach(() => {
    phone(false);
    g.HashChangeEvent ??= class extends Event {};
    restoreSplit();
  });
  afterEach(() => setSettings({ openSessions: "page" }));

  it("with Beside set a plain open is the preview tab, ⇧ goes to the page, ⌘ a kept tab behind", () => {
    setSettings({ openSessions: "beside" });
    at("/");
    openSession("claude-code:a", "primary");
    openSession("claude-code:b", "primary");
    expect(where()).toBe("/?s=claude-code%3Ab");
    expect(previewTab()).toBe("claude-code:b");
    openSession("claude-code:c", "background");
    expect(tabs()).toEqual(["claude-code:b", "claude-code:c"]);
    expect(previewTab()).toBe("claude-code:b");
    openSession("claude-code:d", "other");
    expect((g.location as URL).pathname).toBe("/s/claude-code/d");
  });

  it("with As a page set a plain open is the page, with its hash; ⇧ a kept tab beside", () => {
    setSettings({ openSessions: "page" });
    at("/review");
    openSession("claude-code:a", "primary", { hash: "#seq-4" });
    expect((g.location as URL).pathname).toBe("/s/claude-code/a");
    expect((g.location as URL).hash).toBe("#seq-4");
    at("/review");
    openSession("claude-code:b", "other", { hash: "#seq-9" });
    expect(tabs()).toEqual(["claude-code:b"]);
    expect(previewTab()).toBeNull();
    // The tab beside is handed its row; the address's hash stays the page's.
    expect((g.location as URL).hash).toBe("");
    expect(takeJump("claude-code:a")).toBeNull();
    expect(takeJump("claude-code:b")).toBe(9);
    expect(takeJump("claude-code:b")).toBeNull();
  });

  it("a menu's plain open keeps its tab", () => {
    setSettings({ openSessions: "beside" });
    at("/review");
    openSession("claude-code:a", "primary", { keep: true });
    expect(tabs()).toEqual(["claude-code:a"]);
    expect(previewTab()).toBeNull();
  });

  it("the session whose page is open stays its page: no copy opens beside it, a hash lands on it", () => {
    setSettings({ openSessions: "beside" });
    at("/s/claude-code/a?s=claude-code%3Ax");
    for (const how of ["primary", "other", "background"] as const) openSession("claude-code:a", how);
    expect(where()).toBe("/s/claude-code/a?s=claude-code%3Ax");
    expect(previewTab()).toBeNull();
    const seen = vi.fn();
    window.addEventListener("hashchange", seen);
    openSession("claude-code:a", "primary", { hash: "#seq-3" });
    window.removeEventListener("hashchange", seen);
    expect(where()).toBe("/s/claude-code/a?s=claude-code%3Ax");
    expect((g.location as URL).hash).toBe("#seq-3");
    expect(seen).toHaveBeenCalledOnce();
    // A subagent's page is not its session's: the session opens beside it.
    at("/s/claude-code/a?agent=r1");
    openSession("claude-code:a", "primary");
    expect(tabs()).toEqual(["claude-code:a"]);
  });

  it("a click's keys say how: ⌘ or Ctrl the background, ⇧ or ⌥ the other way", () => {
    const e = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(howOf(e)).toBe("primary");
    expect(howOf({ ...e, shiftKey: true })).toBe("other");
    expect(howOf({ ...e, altKey: true })).toBe("other");
    expect(howOf({ ...e, ctrlKey: true, shiftKey: true })).toBe("background");
    expect(howOf({ ...e, metaKey: true })).toBe("background");
  });
});

describe("openAsked: a page the app asks for while its window is up (a notification, the menu bar)", () => {
  const q = () => new URL(where(), "http://x/").searchParams;
  beforeEach(() => {
    phone(false);
    restoreSplit();
    setSettings({ openSessions: "beside" });
  });
  afterEach(() => setSettings({ openSessions: "page" }));

  it("a session opens as the preview tab beside the page, the page and its other tabs staying", () => {
    at("/inbox?s=claude-code%3Ax%2Cclaude-code%3Ay&t=1");
    openAsked("/s/claude-code/z");
    expect((g.location as URL).pathname).toBe("/inbox");
    expect(parseSplit(q().get("s"), null).tabs).toEqual(["claude-code:x", "claude-code:y", "claude-code:z"]);
    expect(previewTab()).toBe("claude-code:z");
  });

  it("where the panel cannot show, and any other address, it is navigated to", () => {
    at("/usage");
    openAsked("/s/claude-code/z");
    expect(where()).toBe("/s/claude-code/z");
    at("/");
    openAsked("/feed");
    expect(where()).toBe("/feed");
    // A session's page asked with more than its address (an agent, a file) is that page.
    at("/");
    openAsked("/s/claude-code/z?agent=a1");
    expect(where()).toBe("/s/claude-code/z?agent=a1");
  });

  it("the session already on screen stays as it is", () => {
    at("/s/claude-code/z?s=claude-code%3Ax");
    openAsked("/s/claude-code/z");
    expect(where()).toBe("/s/claude-code/z?s=claude-code%3Ax");
    expect(previewTab()).toBeNull();
  });

  it("over Settings the session's page opens and Settings goes, so the click shows it", () => {
    at("/inbox?settings=general&s=claude-code%3Ax");
    openAsked("/s/claude-code/z");
    expect(where()).toBe("/s/claude-code/z?s=claude-code%3Ax");
  });

  it("on the phone it is the page", () => {
    phone(true);
    at("/inbox");
    openAsked("/s/claude-code/z");
    expect(where()).toBe("/s/claude-code/z");
  });
});
