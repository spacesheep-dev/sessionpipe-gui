// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sweepGone } from "./gone";
import { claimLocal, KEPT_LOCAL, OWNER_KEY, ownerOf, wipeLocal } from "./local";

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

/** What a page that showed an account's sessions has written, and the app's own settings. */
const used = () =>
  storage({
    "sessionpipe-gui.settings": '{"mode":"advanced"}',
    "sessionpipe-gui.theme": "dark",
    "sessionpipe-gui.textSize": "large",
    "sessionpipe-gui.native.firstRun": "1",
    "sessionpipe-gui.draft:claude-code:s-1": "half a message about the staging password",
    "sp.search.recent": '["staging password"]',
    "sp.newSession.last": '{"machine":"studio-mac","cwd":"/Users/me/billing"}',
    "sp.newSession.byMachine": "{}",
    "sp.handoff.draft": "ask codex",
    "sessionpipe-gui.hidden": '["claude-code:s-2"]',
    "sessionpipe-gui.splitTabs": '["claude-code:s-1"]',
    "sessionpipe-gui.theme.e2e-counter.count": "3",
    "sessionpipe-gui.account.device.abc": '{"code":"71"}',
    "a-key-added-tomorrow": "anything",
    [OWNER_KEY]: "acct-one",
  });

describe("what the page keeps outside an account's cache", () => {
  it("a wipe leaves the app's settings and removes everything else, and all of sessionStorage", () => {
    const local = used();
    const session = storage({ "sessionpipe.device-request": "x", other: "y" });
    const gone = wipeLocal(local, session);
    expect([...local.m.keys()].sort()).toEqual([
      "sessionpipe-gui.native.firstRun",
      "sessionpipe-gui.settings",
      "sessionpipe-gui.textSize",
      "sessionpipe-gui.theme",
    ]);
    expect(session.m.size).toBe(0);
    expect(gone).toContain("sessionpipe-gui.draft:claude-code:s-1");
    expect(gone).toContain("a-key-added-tomorrow");
    expect(gone).toContain(OWNER_KEY);
    expect(gone).toHaveLength(13);
    // Nothing to remove, nothing thrown: no storage at all, or one that refuses.
    expect(wipeLocal(null, null)).toEqual([]);
    const refusing = {
      get length(): number {
        throw new Error("denied");
      },
      key: () => null,
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    };
    expect(wipeLocal(refusing, null)).toEqual([]);
  });

  it("nothing that says something of a session is on the list of what stays", () => {
    for (const k of [
      "sessionpipe-gui.draft:claude-code:s-1",
      "sp.search.recent",
      "sp.newSession.last",
      "sp.newSession.draft",
      "sp.newSession.byMachine",
      "sp.handoff.draft",
      "sp.handoff.byMachine",
      "sessionpipe-gui.hidden",
      "sessionpipe-gui.splitTabs",
      "sessionpipe.workflows.mine",
      "sessionpipe.device-request",
      OWNER_KEY,
    ])
      expect(KEPT_LOCAL.has(k), k).toBe(false);
  });

  it("every key on the list of what stays is one the app writes (none is a leftover name)", () => {
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
    for (const k of KEPT_LOCAL) expect(text.includes(`"${k}"`) || text.includes(`\`${k}\``), k).toBe(true);
  });

  it("a window that opens on another account removes what the last one left; on the same one, nothing", () => {
    const local = used();
    expect(claimLocal("acct-one", local)).toEqual([]);
    expect(local.m.has("sp.search.recent")).toBe(true);
    const gone = claimLocal("acct-two", local);
    expect(gone).toContain("sp.search.recent");
    expect(local.m.has("sessionpipe-gui.draft:claude-code:s-1")).toBe(false);
    expect(local.m.get("sessionpipe-gui.settings")).toBe('{"mode":"advanced"}');
    expect(ownerOf(local)).toBe("acct-two");
    // The first account ever shown here: nothing to remove, and it is marked.
    const fresh = storage({ "sp.search.recent": "[]" });
    expect(claimLocal("acct-one", fresh)).toEqual([]);
    expect(fresh.m.get(OWNER_KEY)).toBe("acct-one");
    expect(fresh.m.has("sp.search.recent")).toBe(true);
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
  const status = (ids: string[]) => async () => ({
    enabled: true,
    accounts: ids.map((id) => ({
      id,
      origin: "https://spacesheep.dev",
      email: "me@example.com",
      state: "ok" as const,
    })),
  });

  it("goes as any window opens: its cached sessions, and the page's storage when it was written beside it", async () => {
    const db = idb(["sessionpipe.account.acct-one", "sessionpipe.account.acct-two", "somebody-else"]);
    let wiped = 0;
    const swept = await sweepGone(status(["acct-two"]), {
      idb: db.factory,
      owner: () => "acct-one",
      wipe: () => {
        wiped++;
        return ["sp.search.recent"];
      },
    });
    expect(db.deleted).toEqual(["sessionpipe.account.acct-one"]);
    expect(wiped).toBe(1);
    expect(swept).toEqual({ caches: ["sessionpipe.account.acct-one"], local: ["sp.search.recent"] });
  });

  it("an account that is still here keeps everything; a storage no account wrote beside is left alone", async () => {
    const db = idb(["sessionpipe.account.acct-one"]);
    let wiped = 0;
    const wipe = () => {
      wiped++;
      return [];
    };
    await sweepGone(status(["acct-one"]), { idb: db.factory, owner: () => "acct-one", wipe });
    await sweepGone(status([]), { idb: idb([]).factory, owner: () => null, wipe });
    expect(db.deleted).toEqual([]);
    expect(wiped).toBe(0);
  });

  it("with no account left at all, everything of the last one goes", async () => {
    const db = idb(["sessionpipe.account.acct-one"]);
    const local = used();
    const swept = await sweepGone(status([]), {
      idb: db.factory,
      owner: () => ownerOf(local),
      wipe: () => wipeLocal(local, null),
    });
    expect(db.deleted).toEqual(["sessionpipe.account.acct-one"]);
    expect(swept.local).toContain("sessionpipe-gui.draft:claude-code:s-1");
    expect(local.m.has(OWNER_KEY)).toBe(false);
  });

  it("a hub that does not answer is not an empty list: nothing is removed", async () => {
    const db = idb(["sessionpipe.account.acct-one"]);
    let wiped = 0;
    const swept = await sweepGone(
      async () => {
        throw { code: "failed", message: "The app is not ready yet." };
      },
      {
        idb: db.factory,
        owner: () => "acct-one",
        wipe: () => {
          wiped++;
          return [];
        },
      },
    );
    expect(swept).toEqual({ caches: [], local: [] });
    expect(db.deleted).toEqual([]);
    expect(wiped).toBe(0);
  });
});
