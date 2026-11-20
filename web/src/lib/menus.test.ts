// SPDX-License-Identifier: Apache-2.0
// A session's menu says only what is so: what the surface can answer leads it, an item
// that would only be refused is not in it, and a key shows beside an item only where
// pressing it there does that to this session.
import "../native/test-env";
import type { MachineControl, SessionSummary } from "@shared/api";
import { beforeAll, describe, expect, it } from "vitest";
import type { MenuItem } from "../components/ContextMenu";
import type { Store } from "../data/store";
import { PHONE_QUERY } from "./device";
import { askItem, type SessionMenuContext, sessionItems } from "./menus";
import { setSettings } from "./settings";

// A wide window with a mouse, as every part of the page asks for it.
beforeAll(() => {
  (globalThis as Record<string, unknown>).matchMedia = (query: string) => ({
    matches: /min-width/.test(query),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});

const AT = "2026-11-18T10:00:00Z";
const session = (o: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    key: "claude-code:s-1",
    harness: "claude-code",
    id: "s-1",
    machine: "studio-mac",
    cwd: "/Users/dev/code/billing",
    state: "needs_you",
    stateSince: AT,
    startedAt: AT,
    lastAt: AT,
    openAttentions: [],
    counts: { turns: 1, tools: 0, toolErrors: 0 },
    ...o,
  }) as unknown as SessionSummary;

const control = (extra: Partial<MachineControl> = {}): MachineControl => ({
  machineId: "m_studio",
  online: true,
  keys: [],
  queued: 0,
  ...extra,
});
/** A daemon whose agents ask each other, with someone there to ask. */
const asking = control({ ask: true, handoff: true, harnesses: ["claude-code", "codex"] });
/** One from before asking: a hello with neither `ask` nor `handoff`. */
const older = control({ harnesses: ["claude-code", "codex"] });

const storeOf = (c: MachineControl | undefined, sessions: SessionSummary[] = [session()]): Store =>
  ({
    get: () => ({
      machines: new Map([["studio-mac", { name: "studio-mac", control: c }]]),
      sessions: new Map(sessions.map((s) => [s.key, s])),
      labels: { names: {}, sessions: {} },
      marks: { since: null, read: {}, unread: {}, notify: {} },
    }),
  }) as unknown as Store;

const labels = (items: MenuItem[]) => items.map((i) => ("sep" in i ? "─" : "label" in i ? i.label : ""));
const named = (items: MenuItem[], label: string) => items.find((i) => "label" in i && i.label === label);
const actions = (items: MenuItem[]) => items.map((i) => ("action" in i ? i.action : undefined)).filter(Boolean);
const menu = (c: MachineControl | undefined, ctx: Partial<SessionMenuContext> = {}) =>
  sessionItems(session(), { store: storeOf(c), surface: "list", ...ctx });

describe("askItem", () => {
  it("is not in a menu where asking would only be refused, as the strip has no button there", () => {
    const s = session();
    // Not paired here.
    expect(askItem(s, storeOf(undefined))).toBeNull();
    // A daemon that predates asking.
    expect(askItem(s, storeOf(older))).toBeNull();
    // One that asks, with no agent in its hello and no other session there: nobody to ask.
    expect(askItem(s, storeOf(control({ ask: true })))).toBeNull();
    // The other session on its machine is someone to ask.
    const other = session({ key: "codex:s-2", harness: "codex", id: "s-2" });
    expect(askItem(s, storeOf(control({ ask: true }), [s, other]))).not.toBeNull();
  });

  it("shows ⇧A only where the menu says to, and is never disabled", () => {
    const store = storeOf(asking);
    const plain = askItem(session(), store)!;
    expect(plain).toMatchObject({ label: "Ask another agent…" });
    expect("action" in plain ? plain.action : "none").toBeUndefined();
    expect("disabled" in plain).toBe(false);
    expect(askItem(session(), store, { hint: true })).toMatchObject({ action: "session.ask" });
    // A reply's own menu: its own words, and no key (⇧A asks about the last reply).
    const reply = askItem(session(), store, { label: "Ask another agent about this…", reply: "Done." })!;
    expect(reply).toMatchObject({ label: "Ask another agent about this…" });
    expect("action" in reply ? reply.action : "none").toBeUndefined();
  });
});

describe("sessionItems", () => {
  const answer: MenuItem[] = [
    { label: "Allow Bash", action: "board.allow", run: () => {} },
    { label: "Deny Bash", action: "board.deny", run: () => {} },
  ];

  it("leads with what the surface can answer, then a rule, then Open", () => {
    // A computer that has not chosen opens beside: that comes first.
    expect(labels(menu(asking, { answer })).slice(0, 9)).toEqual([
      "Allow Bash",
      "Deny Bash",
      "─",
      "Open beside",
      "Open as page",
      "Open in background tab",
      "Open in new window",
      "─",
      "New session here",
    ]);
    // Nothing to answer: the menu starts as it always did, with no rule at its head.
    expect(labels(menu(asking))[0]).toBe("Open beside");
    expect(labels(menu(asking, { answer: [] }))[0]).toBe("Open beside");
    // A panel's tab and its head lead with the answer too.
    for (const surface of ["tab", "panel", "page"] as const)
      expect(labels(menu(asking, { surface, answer })).slice(0, 3)).toEqual(["Allow Bash", "Deny Bash", "─"]);
  });

  it("on the phone the sheet keeps the answer where it was, after Ask, between rules", () => {
    const g = globalThis as Record<string, unknown>;
    const wide = g.matchMedia;
    g.matchMedia = (query: string) => ({
      matches: query === PHONE_QUERY,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    try {
      const items = labels(menu(asking, { answer }));
      expect(items[0]).not.toBe("Allow Bash");
      const at = items.indexOf("Allow Bash");
      expect(items.slice(at - 2, at + 3)).toEqual(["Ask another agent…", "─", "Allow Bash", "Deny Bash", "─"]);
    } finally {
      g.matchMedia = wide;
    }
  });

  it("on a row puts ↵'s way first with ↵, and the other way with ⇧↵, under either setting", () => {
    const opens = (items: MenuItem[]) =>
      items
        .filter((i) => "label" in i && i.label.startsWith("Open"))
        .map((i) => ("label" in i ? [i.label, "action" in i ? i.action : undefined] : []));
    try {
      setSettings({ openSessions: "beside" });
      expect(opens(menu(asking))).toEqual([
        ["Open beside", "list.open"],
        ["Open as page", "list.beside"],
        ["Open in background tab", "list.background"],
        ["Open in new window", undefined],
      ]);
      setSettings({ openSessions: "page" });
      expect(opens(menu(asking))).toEqual([
        ["Open as page", "list.open"],
        ["Open beside", "list.beside"],
        ["Open in background tab", "list.background"],
        ["Open in new window", undefined],
      ]);
    } finally {
      setSettings({ openSessions: "page" });
    }
  });

  it("on a row shows no key beside New session here or Ask another agent…", () => {
    const items = menu(asking, { answer });
    expect(actions(items)).not.toContain("newSession.open");
    expect(actions(items)).not.toContain("session.ask");
    expect(named(items, "New session here")).toBeDefined();
    expect(named(items, "Ask another agent…")).toBeDefined();
    // The row's own keys stay.
    expect(actions(items)).toEqual(expect.arrayContaining(["board.allow", "board.deny", "list.open", "list.beside"]));
  });

  it("shows ⇧A on the session's page and the panel's head, where the key asks about this session", () => {
    for (const surface of ["page", "panel"] as const) {
      const items = menu(asking, { surface });
      expect(named(items, "Ask another agent…"), surface).toMatchObject({ action: "session.ask" });
      // C opens New session for the board's machine, never for this session's folder.
      expect(actions(items), surface).not.toContain("newSession.open");
    }
    expect(actions(menu(asking, { surface: "tab" }))).not.toContain("session.ask");
  });

  it("has no Ask another agent… on a machine that cannot ask, on any surface", () => {
    for (const surface of ["list", "tab", "panel", "page"] as const) {
      const items = menu(older, { surface });
      expect(named(items, "Ask another agent…"), surface).toBeUndefined();
      // Paired, so a session can still be started there.
      expect(named(items, "New session here"), surface).toBeDefined();
    }
  });

  it("has neither on a machine that is not paired: the group is gone, with its rule", () => {
    const items = menu(undefined);
    expect(named(items, "New session here")).toBeUndefined();
    expect(named(items, "Ask another agent…")).toBeUndefined();
    expect(labels(items).slice(0, 6)).toEqual([
      "Open as page",
      "Open beside",
      "Open in background tab",
      "Open in new window",
      "─",
      "Label",
    ]);
  });
});
