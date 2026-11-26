// SPDX-License-Identifier: Apache-2.0
// How sessions open by default, on a computer and on the phone, and the stored form: only
// what the device set, with the one-time drop of the "page" every save used to write.
import "../native/test-env";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

describe("the sidebar's width", () => {
  it("starts at 288, keeps what was dragged, and holds to 220 to 400 in whole pixels", async () => {
    layout(false);
    const m = await load();
    expect(m.getSettings().sidebarWidth).toBe(288);
    m.setSettings({ sidebarWidth: 330 });
    expect(kept()?.sidebarWidth).toBe(330);
    expect((await load()).getSettings().sidebarWidth).toBe(330);
    expect((await load({ sidebarWidth: 1000 })).getSettings().sidebarWidth).toBe(400);
    expect((await load({ sidebarWidth: 12.6 })).getSettings().sidebarWidth).toBe(220);
    expect((await load({ sidebarWidth: "wide" })).getSettings().sidebarWidth).toBe(288);
    expect(m.sidebarClamp(301.4)).toBe(301);
  });
});

describe("the sessions column beside the rail", () => {
  let treeColumn: Awaited<ReturnType<typeof load>>["treeColumn"];
  beforeAll(async () => {
    layout(false);
    ({ treeColumn } = await load());
  });
  const at = (window: number, chosen = 288, panel = 0) => treeColumn({ window, rail: 72, chosen, panel });
  it("keeps the chosen width while the page keeps 600", () => {
    expect(at(1440)).toEqual({ fits: true, width: 288, cap: 400, panel: 0, covers: false });
    expect(at(1280).width).toBe(288);
    expect(at(1200).width).toBe(288);
    expect(at(1024).width).toBe(288);
  });
  it("narrows for the page, down to 220, then leaves the page to the rail's button", () => {
    expect(at(1024, 400).width).toBe(352);
    expect(at(900).width).toBe(228);
    expect(at(892)).toMatchObject({ fits: true, width: 220 });
    expect(at(891).fits).toBe(false);
  });
  it("with a session open beside the page, the column never gives way: the panel narrows, else covers the page", () => {
    expect(at(1440, 288, 610)).toEqual({ fits: true, width: 288, cap: 400, panel: 538, covers: false });
    expect(at(1440, 400, 610)).toEqual({ fits: true, width: 400, cap: 400, panel: 426, covers: false });
    expect(at(1360, 288, 598)).toEqual({ fits: true, width: 288, cap: 400, panel: 458, covers: false });
    expect(at(1280, 288, 563)).toMatchObject({ fits: true, width: 288, covers: true });
    expect(at(1200, 288, 528)).toMatchObject({ fits: true, width: 288, covers: true });
  });
});
