// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SWEEP_AGAIN_MS, sweepGone } from "./gone";
import {
  ACCOUNT_KEYED,
  accountsKept,
  CONVENIENCES,
  forgetLocal,
  readsKey,
  SESSION_KEYED,
  SESSION_LISTS,
  wipeAccount,
} from "./local";

/** A Storage, as much of one as the page uses. */
function storage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

/** One phone, three windows over one storage: two accounts connected, and a GUI server. */
const ONE = ["claude-code:one-1", "codex:one-2"];
const TWO = ["claude-code:two-1"];
const RECEIVER = ["claude-code:home-1", "claude-code:home-2"];
const used = () =>
  storage({
    "sessionpipe-gui.settings": '{"mode":"advanced"}',
    "sessionpipe-gui.theme": "dark",
    "sessionpipe-gui.draft:claude-code:one-1": "half a message about the staging password",
    "sessionpipe-gui.draft:claude-code:two-1": "the other account's draft",
    "sessionpipe-gui.draft:claude-code:home-1": "the receiver's draft",
    "sessionpipe-gui.hidden": JSON.stringify({
      "codex:one-2": "2026-01-01T00:00:00Z",
      "claude-code:two-1": { since: "2026-01-01T00:00:00Z", until: "needs" },
      "claude-code:home-2": "2026-01-01T00:00:00Z",
    }),
    "sessionpipe-gui.agentsOpen": JSON.stringify([
      ["claude-code:one-1", true],
      ["claude-code:home-1", false],
    ]),
    [readsKey("acct-one")]: '{"reads":[1]}',
    [readsKey("acct-two")]: '{"reads":[2]}',
    "sessionpipe-gui.account.device.acct-one": '{"code":"71"}',
    "sp.search.recent": '["staging password"]',
    "sp.newSession.last": '{"machine":"studio-mac","cwd":"/Users/me/billing"}',
    "sp.handoff.draft": "ask codex",
    "sessionpipe-gui.splitTabs": '{"tabs":["claude-code:home-1"]}',
    "sessionpipe.workflows.mine": '["run-1"]',
    "sessionpipe-gui.theme.e2e-counter.count": "3",
    "a-key-added-tomorrow": "anything",
  });
const parsed = (s: ReturnType<typeof storage>, k: string) => JSON.parse(s.m.get(k) ?? "null") as unknown;

describe("what the page keeps outside an account's cache", () => {
  it("an account that goes takes what is kept of its sessions and under its id, and nothing of anybody else's", () => {
    const local = used();
    const before = new Map(local.m);
    const gone = wipeAccount("acct-one", ONE, {}, local);
    expect(gone.sort()).toEqual([
      "sessionpipe-gui.account.device.acct-one",
      "sessionpipe-gui.account.reads.acct-one",
      "sessionpipe-gui.agentsOpen",
      "sessionpipe-gui.draft:claude-code:one-1",
      "sessionpipe-gui.hidden",
    ]);
    // The other account's and the receiver's: their drafts, their entries, as they were.
    for (const key of [TWO[0]!, RECEIVER[0]!])
      expect(local.m.get(`sessionpipe-gui.draft:${key}`), key).toBe(before.get(`sessionpipe-gui.draft:${key}`));
    expect(Object.keys(parsed(local, "sessionpipe-gui.hidden") as object)).toEqual([TWO[0]!, RECEIVER[1]!]);
    expect(parsed(local, "sessionpipe-gui.agentsOpen")).toEqual([["claude-code:home-1", false]]);
    expect(local.m.has(readsKey("acct-two"))).toBe(true);
    // And everything that is nobody's session: untouched, the conveniences too.
    for (const k of [
      "sessionpipe-gui.settings",
      "sessionpipe-gui.theme",
      "sp.search.recent",
      "sp.newSession.last",
      "sp.handoff.draft",
      "sessionpipe-gui.splitTabs",
      "sessionpipe.workflows.mine",
      "sessionpipe-gui.theme.e2e-counter.count",
      "a-key-added-tomorrow",
    ])
      expect(local.m.get(k), k).toBe(before.get(k));
  });

  it("disconnected by the person in its own window, what belongs to no session goes too; a receiver's own stays", () => {
    const local = used();
    const gone = wipeAccount("acct-one", ONE, { conveniences: true }, local);
    for (const k of ["sp.search.recent", "sp.newSession.last", "sp.handoff.draft", "sessionpipe-gui.splitTabs"]) {
      expect(gone, k).toContain(k);
      expect(local.m.has(k), k).toBe(false);
    }
    // The receiver's drafts and hidden list, its signing marks, a view's own state, the settings.
    expect(local.m.get("sessionpipe-gui.draft:claude-code:home-1")).toBe("the receiver's draft");
    expect(Object.keys(parsed(local, "sessionpipe-gui.hidden") as object)).toContain("claude-code:home-2");
    expect(local.m.get("sessionpipe.workflows.mine")).toBe('["run-1"]');
    expect(local.m.get("sessionpipe-gui.theme.e2e-counter.count")).toBe("3");
    expect(local.m.get("sessionpipe-gui.settings")).toBe('{"mode":"advanced"}');
    expect(local.m.get("a-key-added-tomorrow")).toBe("anything");
  });

  it("two accounts and a receiver over one storage: a session one account forgets takes its own, and nothing of the others", () => {
    // Opening a window removes nothing (backend.test.ts): only a session forgotten, or an account gone, does.
    const local = used();
    const before = new Map(local.m);
    expect(forgetLocal([], local)).toEqual([]);
    expect(local.m).toEqual(before);
    // One session forgotten by its account: its draft and its entries, and no other's.
    expect(forgetLocal(["codex:one-2"], local)).toEqual(["sessionpipe-gui.hidden"]);
    expect(forgetLocal(["claude-code:one-1"], local).sort()).toEqual([
      "sessionpipe-gui.agentsOpen",
      "sessionpipe-gui.draft:claude-code:one-1",
    ]);
    expect(local.m.has("sessionpipe-gui.draft:claude-code:two-1")).toBe(true);
    // A list left empty is removed; one that is no list is left alone.
    const lone = storage({ "sessionpipe-gui.agentsOpen": '[["a:1",true]]', "sessionpipe-gui.hidden": "not json" });
    forgetLocal(["a:1"], lone);
    expect([...lone.m.keys()]).toEqual(["sessionpipe-gui.hidden"]);
  });

  it("nothing to remove, nothing thrown: no storage at all, or one that refuses", () => {
    expect(wipeAccount("acct-one", ONE, { conveniences: true }, null)).toEqual([]);
    const refusing = {
      get length(): number {
        throw new Error("denied");
      },
      key: () => null,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    expect(wipeAccount("acct-one", ONE, { conveniences: true }, refusing)).toEqual([]);
    expect(accountsKept(refusing)).toEqual([]);
    expect(accountsKept(used()).sort()).toEqual(["acct-one", "acct-two"]);
  });

  it("every key named here is one the app writes (none is a leftover name)", () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    let text = "";
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const full = path.join(dir, f);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && full !== path.join(src, "account", "local.ts"))
          text += readFileSync(full, "utf8");
      }
    };
    walk(src);
    for (const k of [...SESSION_KEYED, ...SESSION_LISTS, ...CONVENIENCES])
      expect(text.includes(`"${k}`) || text.includes(`\`${k}`), k).toBe(true);
    expect(readsKey("x").startsWith(ACCOUNT_KEYED)).toBe(true);
  });
});

describe("what an account that is no longer on this phone left behind", () => {
  const idb = (names: string[]) => {
    const deleted: string[] = [];
    return {
      deleted,
      factory: {
        databases: async () => names.map((name) => ({ name, version: 1 })),
        deleteDatabase: (name: string) => {
          deleted.push(name);
          return {} as IDBOpenDBRequest;
        },
      } as unknown as IDBFactory,
    };
  };
  const answer = (ids: string[]) => ({
    enabled: true,
    accounts: ids.map((id) => ({
      id,
      origin: "https://spacesheep.dev",
      email: "me@example.com",
      state: "ok" as const,
    })),
  });
  /** A hub that answers these in turn (the last one for ever). */
  const hub = (...answers: unknown[]) => {
    let n = 0;
    const waits: number[] = [];
    return {
      waits,
      asked: () => n,
      status: (async () => {
        const a = answers[Math.min(n++, answers.length - 1)];
        if (a instanceof Error) throw a;
        return a;
      }) as never,
      sleep: async (ms: number) => void waits.push(ms),
    };
  };

  it("goes as any window opens, once two answers a few seconds apart both leave it out: its cached sessions, and what the storage keeps of them", async () => {
    const db = idb(["sessionpipe.account.acct-one", "sessionpipe.account.acct-two", "somebody-else"]);
    const local = used();
    const h = hub(answer(["acct-two"]));
    const swept = await sweepGone(h.status, {
      idb: db.factory,
      sleep: h.sleep,
      // One of its sessions is still in its cache; the other aged out, and is remembered by key.
      sessions: async (name) => (name === "sessionpipe.account.acct-one" ? [ONE[0]!] : []),
      seen: (id) => (id === "acct-one" ? [ONE[1]!] : []),
      kept: () => accountsKept(local),
      wipe: (id, sessions) => wipeAccount(id, sessions, {}, local),
    });
    expect(h.asked()).toBe(2);
    expect(h.waits).toEqual([SWEEP_AGAIN_MS]);
    expect(db.deleted).toEqual(["sessionpipe.account.acct-one"]);
    expect(swept.caches).toEqual(["sessionpipe.account.acct-one"]);
    expect(swept.local).toContain("sessionpipe-gui.draft:claude-code:one-1");
    expect(Object.keys(JSON.parse(local.m.get("sessionpipe-gui.hidden")!) as object)).not.toContain(ONE[1]);
    // The account that is here, and the receiver, keep everything; so do the conveniences.
    expect(local.m.has("sessionpipe-gui.draft:claude-code:two-1")).toBe(true);
    expect(local.m.has("sessionpipe-gui.draft:claude-code:home-1")).toBe(true);
    expect(local.m.has(readsKey("acct-two"))).toBe(true);
    expect(local.m.has("sp.search.recent")).toBe(true);
  });

  it("one answer that lists no accounts removes nothing: the second lists them, or does not come, or is no list", async () => {
    for (const second of [answer(["acct-one"]), new Error("not ready"), { enabled: true }, null, { accounts: [{}] }]) {
      const db = idb(["sessionpipe.account.acct-one"]);
      let wiped = 0;
      const h = hub(answer([]), second);
      const swept = await sweepGone(h.status, {
        idb: db.factory,
        sleep: h.sleep,
        kept: () => ["acct-one"],
        sessions: async () => ONE,
        wipe: () => {
          wiped++;
          return [];
        },
      });
      expect(swept, JSON.stringify(second)).toEqual({ caches: [], local: [] });
      expect(db.deleted).toEqual([]);
      expect(wiped).toBe(0);
    }
    // Nor does a first answer that is none; and with nothing kept of anybody, the hub is asked once.
    const db = idb(["sessionpipe.account.acct-one"]);
    expect(await sweepGone(hub(new Error("not ready")).status, { idb: db.factory, kept: () => [] })).toEqual({
      caches: [],
      local: [],
    });
    const quiet = hub(answer(["acct-one"]));
    await sweepGone(quiet.status, { idb: db.factory, kept: () => ["acct-one"], sleep: quiet.sleep });
    expect(quiet.asked()).toBe(1);
    expect(db.deleted).toEqual([]);
  });

  it("the account this window shows is never swept from it, whatever the hub lists", async () => {
    const db = idb(["sessionpipe.account.acct-one", "sessionpipe.account.acct-gone"]);
    const wiped: string[] = [];
    const h = hub(answer([]));
    await sweepGone(h.status, {
      idb: db.factory,
      showing: "acct-one",
      sleep: h.sleep,
      kept: () => ["acct-one", "acct-gone"],
      sessions: async () => [],
      wipe: (id) => {
        wiped.push(id);
        return [];
      },
    });
    expect(wiped).toEqual(["acct-gone"]);
    expect(db.deleted).toEqual(["sessionpipe.account.acct-gone"]);
  });
});
