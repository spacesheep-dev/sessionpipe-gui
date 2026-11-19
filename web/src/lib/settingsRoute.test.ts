// SPDX-License-Identifier: Apache-2.0
// Settings over the page: `?settings=<section>` on the page you are on, one entry to open
// it, its old address read as the new one, and a close that goes back to exactly the entry
// it was opened over, however many sections the phone pushed meanwhile.
import "../native/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeSettings,
  navigate,
  openSettings,
  settingsAlias,
  settingsBackToList,
  settingsHref,
  showSettingsSection,
} from "./router";

const g = globalThis as Record<string, unknown>;
const ORIGIN = "http://127.0.0.1:7816";

/** The page's history as a browser keeps it: entries with their state; go(n) moves and
 *  says so (popstate), as the browser does a moment later. */
let stack: { url: string; state: unknown }[] = [];
let shown = 0;
const show = () => {
  g.location = new URL(stack[shown]!.url, ORIGIN);
};
function at(path: string) {
  stack = [{ url: path, state: null }];
  shown = 0;
  show();
  g.history = {
    get length() {
      return stack.length;
    },
    get state() {
      return stack[shown]!.state;
    },
    pushState: (state: unknown, _t: string, url: string) => {
      stack = [...stack.slice(0, shown + 1), { url, state }];
      shown += 1;
      show();
    },
    replaceState: (state: unknown, _t: string, url: string) => {
      stack[shown] = { url, state };
      show();
    },
    go: (n: number) => {
      shown = Math.max(0, Math.min(stack.length - 1, shown + n));
      show();
      window.dispatchEvent(new Event("popstate"));
    },
    back: () => (g.history as { go: (n: number) => void }).go(-1),
  };
}
const where = () => `${(g.location as URL).pathname}${(g.location as URL).search}`;
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(g.document as Record<string, unknown>).querySelector = () => null;

beforeEach(() => at("/machines"));

describe("settingsHref", () => {
  it("is the page you are on with Settings over it, its other parameters kept", () => {
    expect(settingsHref("general", "/machines")).toBe("/machines?settings=general");
    expect(settingsHref(null, "/machines")).toBe("/machines?settings");
    expect(settingsHref("data", "/s/claude-code/a?file=src%2Fa.ts&s=codex%3Ab")).toBe(
      "/s/claude-code/a?file=src%2Fa.ts&s=codex%3Ab&settings=data",
    );
    // Asked again, the section changes in place.
    expect(settingsHref("about", "/?settings=general&mock=1")).toBe("/?settings=about&mock=1");
  });
});

describe("settingsAlias", () => {
  it("reads the old address as Open on with Settings over it, the mock and the panel kept", () => {
    expect(settingsAlias("/settings", "/")).toBe("/?settings");
    expect(settingsAlias("/settings?section=data", "/machines")).toBe("/machines?settings=data");
    expect(settingsAlias("/settings#notifications", "/inbox")).toBe("/inbox?settings=notifications");
    expect(settingsAlias("/settings?section=app&s=codex%3Ab&t=0&mock=1&x=1", "/")).toBe(
      "/?mock=1&s=codex%3Ab&t=0&settings=app",
    );
  });

  it("is rewritten as the app loads, before anything reads the address", async () => {
    at("/settings?section=data&mock=1");
    localStorage.setItem("sessionpipe-gui.settings", JSON.stringify({ defaultPage: "/machines" }));
    vi.resetModules();
    await import("./router");
    expect(where()).toBe("/machines?mock=1&settings=data");
    expect(stack).toHaveLength(1);
    localStorage.removeItem("sessionpipe-gui.settings");
  });

  it("leaves every other address alone", () => {
    expect(settingsAlias("/", "/machines")).toBeNull();
    expect(settingsAlias("/machines?settings=data", "/")).toBeNull();
    expect(settingsAlias("/settings-x", "/")).toBeNull();
  });
});

describe("Settings over the page", () => {
  it("opens with one entry and closes back to the page as it was", () => {
    at("/s/claude-code/a?file=src%2Fa.ts");
    openSettings();
    expect(where()).toBe("/s/claude-code/a?file=src%2Fa.ts&settings");
    expect(stack).toHaveLength(2);
    // A section switched on a desktop is in place.
    showSettingsSection("data");
    expect(where()).toBe("/s/claude-code/a?file=src%2Fa.ts&settings=data");
    expect(stack).toHaveLength(2);
    closeSettings();
    expect(where()).toBe("/s/claude-code/a?file=src%2Fa.ts");
    expect(shown).toBe(0);
  });

  it("already open, goes to the section asked for without a second entry", () => {
    openSettings("general");
    openSettings("about");
    expect(where()).toBe("/machines?settings=about");
    expect(stack).toHaveLength(2);
    openSettings();
    expect(where()).toBe("/machines?settings=about");
  });

  it("the old address, navigated to, opens it over this page", () => {
    navigate("/settings?section=notifications");
    expect(where()).toBe("/machines?settings=notifications");
    navigate("/settings#data");
    expect(where()).toBe("/machines?settings=data");
    expect(stack).toHaveLength(2);
  });

  it("any other move closes it", () => {
    openSettings("keyboard");
    navigate("/shortcuts");
    expect(where()).toBe("/shortcuts");
  });

  it("on the phone, pops every section it pushed: list › section, Back to the list, Done to the page", () => {
    openSettings();
    showSettingsSection("data", { push: true });
    expect(where()).toBe("/machines?settings=data");
    expect(stack).toHaveLength(3);
    settingsBackToList();
    expect(where()).toBe("/machines?settings");
    showSettingsSection("about", { push: true });
    closeSettings();
    expect(where()).toBe("/machines");
    expect(shown).toBe(0);
  });

  it("opened by its address, closes to the same page without it", () => {
    at("/machines?settings=data");
    closeSettings();
    expect(where()).toBe("/machines");
    expect(stack).toHaveLength(1);
    // The phone's list opened by its address, a section pushed over it: Done goes back
    // past the section, and the list's entry drops the parameter.
    at("/machines?settings");
    showSettingsSection("app", { push: true });
    closeSettings();
    expect(where()).toBe("/machines");
    expect(shown).toBe(0);
    // A section opened by its address: Back shows the list in its place.
    at("/machines?settings=app");
    settingsBackToList();
    expect(where()).toBe("/machines?settings");
    expect(stack).toHaveLength(1);
  });
});
