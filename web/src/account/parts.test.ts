// SPDX-License-Identifier: Apache-2.0
// The parts a page on a spacesheep account is made of, each alone: what it reads of the
// shell's contract, how it tells the hub's own answers from spacesheep's at the doors, what
// its cache keeps and drops, and how its documents are kept behind the hub.
import type { StoredEvent } from "@shared/api";
import { describe, expect, it } from "vitest";
import type { MachineRow } from "../../../server/control/rows";
import { HUB_HEADER } from "../../../server/sources/relay";
import { CACHE_EVENTS_MAX, compacted, memoryCache, openCache, pagesToDrop } from "./cache";
import { openDocs } from "./docs";
import { hubCode, openDoors, SEND_BUSY_TRIES } from "./doors";
import { accountShell } from "./shell";

describe("the shell's contract, read for an account", () => {
  const contract = (receiver: unknown, over: Record<string, unknown> = {}) => ({
    v: 1,
    platform: "ios",
    appVersion: "0.9.0",
    features: ["notifications", "signer", "account", 7],
    receiver,
    rxBase: "rx://localhost/ACCT",
    ...over,
  });
  it("is the account when the receiver's kind says so, and nothing else is one", () => {
    const acct = { id: "ACCT", name: "me@example.com", origin: "https://spacesheep.dev", local: false };
    expect(
      accountShell(contract({ ...acct, kind: "spacesheep", email: "me@example.com", state: "unauthorized" })),
    ).toEqual({
      id: "ACCT",
      origin: "https://spacesheep.dev",
      email: "me@example.com",
      state: "unauthorized",
      rxBase: "rx://localhost/ACCT",
      appVersion: "0.9.0",
      platform: "ios",
      features: ["notifications", "signer", "account"],
    });
    // A receiver (no kind), no receiver, another contract version, no rx base: not an account.
    expect(accountShell(contract(acct))).toBeNull();
    expect(accountShell(contract(null))).toBeNull();
    expect(accountShell(contract({ ...acct, kind: "spacesheep" }, { v: 2 }))).toBeNull();
    expect(accountShell(contract({ ...acct, kind: "spacesheep" }, { rxBase: null }))).toBeNull();
    expect(accountShell(undefined)).toBeNull();
    // A state this page does not know reads as ok: the doors say how it really is.
    expect(accountShell(contract({ ...acct, kind: "spacesheep", state: "new" }))?.state).toBe("ok");
  });
});

describe("the account's doors", () => {
  const m = { id: "m_0123456789abcdefghij", name: "lab-mac" } as MachineRow;
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const hubSays = (status: number, code: string, error: string, headers: Record<string, string> = {}) =>
    answer(status, { hub: true, reason: code, error }, { [HUB_HEADER]: code, ...headers });
  const open = (answers: Response[], more: Partial<Parameters<typeof openDoors>[0]> = {}) => {
    const asked: { url: string; init?: RequestInit }[] = [];
    const doors = openDoors({
      rxBase: "rx://localhost/ACCT",
      fetch: (async (url: string, init?: RequestInit) => {
        asked.push({ url, init });
        const next = answers.shift();
        if (!next) throw new TypeError("Load failed");
        return next;
      }) as typeof fetch,
      sleep: async () => {},
      ...more,
    });
    return { doors, asked };
  };

  it("asks rxBase for the door, and sends a signed body as it is", async () => {
    const { doors, asked } = open([answer(200, { events: [], next: 0, oldest: null }), answer(202, { job: 4 })]);
    await doors.read("/api/sessionpipe/v1/relay?since=0&limit=500&wait=0");
    const body = { cmd: "{}", csig: "s", grant: { str: "g" }, confirm: null };
    expect(await doors.send(m, body)).toEqual({ status: 202, json: { job: 4 } });
    expect(asked.map((a) => a.url)).toEqual([
      "rx://localhost/ACCT/api/sessionpipe/v1/relay?since=0&limit=500&wait=0",
      "rx://localhost/ACCT/api/machines/m_0123456789abcdefghij/jobs",
    ]);
    expect(asked[1]!.init).toMatchObject({ method: "POST", body: JSON.stringify(body) });
    // No header of the page's names a key: the hub adds it.
    expect(JSON.stringify(asked.map((a) => a.init?.headers))).not.toMatch(/authorization/i);
  });

  it("spacesheep's own refusals pass as they are; only its own 401 says the key is refused", async () => {
    let refused = 0;
    const { doors } = open(
      [
        answer(409, { code: "confirm", error: "Confirm to send this.", why: "unusual" }),
        answer(401, { code: "unlock", error: "Unlock again." }),
        answer(401, { code: "unauthorized", error: "Unknown or revoked API key." }),
      ],
      { onUnauthorized: () => refused++ },
    );
    expect(await doors.send(m, {})).toMatchObject({ status: 409, json: { code: "confirm", why: "unusual" } });
    expect(await doors.send(m, {})).toMatchObject({ status: 401, json: { code: "unlock" } });
    expect(refused).toBe(0);
    expect(await doors.send(m, {})).toMatchObject({ status: 401, json: { code: "unauthorized" } });
    expect(refused).toBe(1);
  });

  it("the hub's own answers are never read as spacesheep's: its 401 is not a refused key, its words pass on", async () => {
    let refused = 0;
    const { doors } = open(
      [
        hubSays(401, "not_connected", "This device holds no key for the account. Connect again."),
        hubSays(400, "not_signed", "The app forwards only a signed command to a machine."),
        hubSays(504, "timeout", "spacesheep did not answer in time."),
        hubSays(502, "unreachable", "spacesheep could not be reached."),
      ],
      { onUnauthorized: () => refused++ },
    );
    expect(await doors.send(m, {})).toEqual({
      status: 502,
      json: { code: hubCode("not_connected"), error: "This device holds no key for the account. Connect again." },
    });
    expect(await doors.send(m, {})).toMatchObject({ status: 502, json: { code: "hub_not_signed" } });
    expect(await doors.send(m, {})).toMatchObject({ status: 504, json: { code: "hub_timeout" } });
    expect(await doors.send(m, {})).toMatchObject({ status: 502, json: { code: "hub_unreachable" } });
    expect(refused).toBe(0);
  });

  it("a hub `busy` is asked again, a few times, and is never spacesheep's limit", async () => {
    const busy = () => hubSays(429, "busy", "Too many requests at once.", { "retry-after": "1" });
    const waits: number[] = [];
    const once = open([busy(), answer(202, { job: 9 })], { sleep: async (ms) => void waits.push(ms) });
    expect(await once.doors.send(m, {})).toEqual({ status: 202, json: { job: 9 } });
    expect(waits).toEqual([1000]);
    const always = open(Array.from({ length: SEND_BUSY_TRIES }, busy));
    expect(await always.doors.send(m, {})).toEqual({
      status: 502,
      json: { code: "hub_busy", error: "Too many requests at once." },
    });
    expect(always.asked).toHaveLength(SEND_BUSY_TRIES);
  });

  it("a request that never left the app is unreachable, in the hub's words for it", async () => {
    const { doors } = open([]);
    expect(await doors.send(m, {})).toEqual({
      status: 502,
      json: { code: "hub_unreachable", error: "spacesheep could not be reached." },
    });
  });

  it("the device door says whose answer it is", async () => {
    const { doors } = open([
      hubSays(409, "no_device_key", "This device has not asked to be trusted yet."),
      answer(200, { trusted_on: ["m_1"], machines: [], pending: false }),
    ]);
    expect(await doors.device()).toMatchObject({ status: 409, hub: "no_device_key" });
    expect(await doors.device()).toMatchObject({ status: 200, hub: null, json: { trusted_on: ["m_1"] } });
  });
});

describe("the cache of relay pages", () => {
  const ev = (n: number) => ({ id: `e${n}` }) as unknown as StoredEvent;
  it("drops the oldest whole pages past the bound, and nothing under it", () => {
    const pages = [
      { key: 500, n: 500 },
      { key: 1000, n: 500 },
      { key: 1001, n: 1 },
    ];
    expect(pagesToDrop(pages, 2000)).toEqual([]);
    expect(pagesToDrop(pages, 1000)).toEqual([500]);
    expect(pagesToDrop(pages, 1)).toEqual([500, 1000]);
    expect(pagesToDrop([], CACHE_EVENTS_MAX)).toEqual([]);
  });
  it("rewrites many small pages as full ones, each under the cursor of its last event's page", () => {
    const small = Array.from({ length: 7 }, (_, i) => ({ key: 10 + i, events: [ev(i)] }));
    const out = compacted(small, 3);
    expect(out.map((p) => [p.key, p.events.length])).toEqual([
      [12, 3],
      [15, 3],
      [16, 1],
    ]);
    expect(out.flatMap((p) => p.events)).toEqual(small.flatMap((p) => p.events));
    // A page with no event (the cursor moved over what was already here) keeps the cursor.
    expect(
      compacted(
        [
          { key: 3, events: [ev(1), ev(2), ev(3)] },
          { key: 9, events: [] },
        ],
        3,
      ).map((p) => p.key),
    ).toEqual([9]);
    expect(compacted([{ key: 4, events: [] }], 3)).toEqual([{ key: 4, events: [] }]);
    expect(compacted([], 3)).toEqual([]);
  });
  it("with no IndexedDB, or one that will not open, is memory: nothing kept, nothing thrown", async () => {
    expect((await openCache("ACCT", undefined)).kind).toBe("memory");
    const refusing = {
      open: () => {
        const r: { onerror?: () => void; error: Error } = { error: new Error("SecurityError") };
        queueMicrotask(() => r.onerror?.());
        return r;
      },
    } as unknown as IDBFactory;
    const c = await openCache("ACCT", refusing);
    expect(c.kind).toBe("memory");
    c.page(5, [ev(1)], { cursor: 5 });
    c.put("reads", { reads: [] });
    expect(await c.load()).toEqual({ events: [], kept: {}, pages: 0, ms: 0 });
    await c.flushed();
    await c.destroy();
    expect(memoryCache().kind).toBe("memory");
  });
});

describe("the account's documents", () => {
  it("are all read before one is opened, and a save reaches the hub with the last value winning", async () => {
    const store = new Map<string, unknown>([["labels", { v: 1, rev: 3, names: {}, sessions: {} }]]);
    const sets: [string, unknown][] = [];
    let release: (() => void) | null = null;
    const docs = await openDocs(
      {
        docGet: async (_id, name) => store.get(name) ?? null,
        docSet: async (_id, name, value) => {
          sets.push([name, value]);
          // The first write is slow: two more saves arrive while it is out.
          if (sets.length === 1) await new Promise<void>((r) => (release = r));
          store.set(name, value);
          return 1;
        },
      },
      "ACCT",
    );
    expect(docs.keep("labels").load()).toEqual({ v: 1, rev: 3, names: {}, sessions: {} });
    expect(docs.keep("marks").load()).toBeUndefined();
    const marks = docs.keep("marks");
    const doc = { v: 1, rev: 1, read: {} as Record<string, string> };
    marks.save(doc);
    // What was saved is a copy: a later change to the object is not what was kept.
    doc.read.x = "later";
    expect(marks.load()).toEqual({ v: 1, rev: 1, read: {} });
    marks.save({ v: 1, rev: 2 });
    marks.save({ v: 1, rev: 3 });
    release!();
    await docs.flushed();
    expect(sets.map(([n, v]) => [n, (v as { rev: number }).rev])).toEqual([
      ["marks", 1],
      ["marks", 3],
    ]);
    expect(store.get("marks")).toEqual({ v: 1, rev: 3 });
    expect(docs.failed()).toEqual([]);
  });

  it("a document the hub cannot read or keep stays in memory, and is named", async () => {
    const docs = await openDocs(
      {
        docGet: async (_id, name) => {
          if (name === "sends") throw { code: "io", message: "disk" };
          return null;
        },
        docSet: async () => {
          throw { code: "too_large", message: "too large" };
        },
      },
      "ACCT",
    );
    expect(docs.failed()).toEqual(["sends"]);
    docs.keep("labels").save({ v: 1 });
    await docs.flushed();
    expect(docs.keep("labels").load()).toEqual({ v: 1 });
    expect(docs.failed().sort()).toEqual(["labels", "sends"]);
  });
});
