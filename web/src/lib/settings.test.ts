// SPDX-License-Identifier: Apache-2.0
// How sessions open by default, on a computer and on the phone, and the stored form: only
// what the device set, with the one-time drop of the "page" every save used to write.
import "../native/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PHONE_QUERY } from "./device";

const g = globalThis as Record<string, unknown>;
const KEY = "sessionpipe-gui.settings";

const layout = (phone: boolean) => {
  g.matchMedia = (q: string) => ({
    matches: phone && q === PHONE_QUERY,
    addEventListener() {},
    removeEventListener() {},
  });
};
/** The module as a fresh page load finds it, over what is stored now. */
async function load(stored?: object) {
  if (stored) localStorage.setItem(KEY, JSON.stringify(stored));
  vi.resetModules();
  return import("./settings");
}
const kept = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, unknown> | null;

afterEach(() => {
  delete g.matchMedia;
  localStorage.removeItem(KEY);
});

describe("Open sessions", () => {
  it("with nothing stored a computer opens beside and the phone as a page", async () => {
    layout(false);
    expect((await load()).getSettings().openSessions).toBe("beside");
    layout(true);
    expect((await load()).getSettings().openSessions).toBe("page");
  });

  it("follows the layout while the device has not chosen", async () => {
    layout(false);
    const s = await load();
    expect(s.getSettings().openSessions).toBe("beside");
    layout(true);
    expect(s.getSettings().openSessions).toBe("page");
  });

  it("drops the stored 'page' every save used to write, once, and keeps the rest", async () => {
    layout(false);
    const s = await load({ mode: "advanced", defaultPage: "/inbox", openSessions: "page", confirmForget: true });
    expect(s.getSettings().openSessions).toBe("beside");
    expect(s.getSettings().mode).toBe("advanced");
    expect(kept()).toEqual({ mode: "advanced", defaultPage: "/inbox", confirmForget: true, v: 2 });
    // A stored "beside" was chosen: it stays.
    expect((await load({ openSessions: "beside", mode: "simple" })).getSettings().openSessions).toBe("beside");
  });

  it("a 'page' chosen after that sticks, on later loads too", async () => {
    layout(false);
    const s = await load({ openSessions: "page" });
    s.setSettings({ openSessions: "page" });
    expect(s.getSettings().openSessions).toBe("page");
    expect(kept()).toEqual({ openSessions: "page", v: 2 });
    expect((await load()).getSettings().openSessions).toBe("page");
  });

  it("a save stores what the device set, never a default it did not choose", async () => {
    layout(false);
    const s = await load();
    s.setSettings({ mode: "advanced" });
    expect(kept()).toEqual({ mode: "advanced", v: 2 });
    expect(s.getSettings()).toMatchObject({ mode: "advanced", openSessions: "beside", defaultPage: "/" });
  });
});
