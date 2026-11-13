// SPDX-License-Identifier: Apache-2.0
// The parts a page on a spacesheep account is made of, each alone: what it reads of the
// shell's contract, how it tells the hub's own answers from spacesheep's at the doors, what
// its cache keeps and drops, and how its documents are kept behind the hub.
import type { ProtocolEvent, StoredEvent } from "@shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineRow, MessageRow } from "../../../server/control/rows";
import { HUB_HEADER } from "../../../server/sources/relay";
import { StoreCore } from "../../../server/store/core";
import { MemoryLog } from "../../../server/store/log";
import { Session } from "../../../test/events";
import type { AccountBackend, AccountNotice } from "./backend";
import { CACHE_EVENTS_MAX, compacted, memoryCache, openCache, pagesToDrop, pagesTooOld, sweepCaches } from "./cache";
import { DOC_READ_WAITS_MS, openDocs } from "./docs";
import { hubCode, openDoors, SEND_BUSY_TRIES, SEND_UNKNOWN, SEND_UNKNOWN_CODE, SEND_UNKNOWN_WAITS_MS } from "./doors";
import { PageLog } from "./log";
import { fitSends, readSends, SETTLED_TEXT_CHARS } from "./sends";
import { accountShell } from "./shell";
import { hookOf, noticeWords, startOnKept } from "./start";

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
        hubSays(502, "redirected", "spacesheep answered with a redirect, which the app does not follow."),
      ],
      { onUnauthorized: () => refused++ },
    );
    expect(await doors.send(m, {})).toEqual({
      status: 502,
      json: { code: hubCode("not_connected"), error: "This device holds no key for the account. Connect again." },
    });
    expect(await doors.send(m, {})).toMatchObject({ status: 502, json: { code: "hub_not_signed" } });
    expect(await doors.send(m, {})).toMatchObject({ status: 502, json: { code: "hub_redirected" } });
    expect(refused).toBe(0);
  });

  describe("a send nobody heard the answer to", () => {
    const body = { cmd: JSON.stringify({ kind: "prompt", session: "claude-code:s-1", nonce: "n1" }), csig: "s" };
    const timeout = () => hubSays(504, "timeout", "spacesheep did not answer in time.");
    const posts = (asked: { init?: RequestInit }[]) => asked.filter((a) => a.init?.method === "POST");

    it("is asked again with the same bytes, after a wait; taken then, it is sent", async () => {
      const waits: number[] = [];
      const { doors, asked } = open([timeout(), answer(202, { job: 9 })], {
        sleep: async (ms) => void waits.push(ms),
      });
      expect(await doors.send(m, body)).toEqual({ status: 202, json: { job: 9 } });
      expect(waits).toEqual([SEND_UNKNOWN_WAITS_MS[0]]);
      expect(posts(asked).map((a) => a.init!.body)).toEqual([JSON.stringify(body), JSON.stringify(body)]);
    });

    it("every way of not hearing counts: the hub's time, an answer that stopped or could not be passed on, a request that never came back", async () => {
      for (const code of [...SEND_UNKNOWN]) {
        const { doors } = open([hubSays(502, code, "x"), answer(202, { job: 1 })]);
        expect(await doors.send(m, body), code).toEqual({ status: 202, json: { job: 1 } });
      }
      // The app's own protocol failed the first: fetch threw.
      let n = 0;
      const doors = openDoors({
        rxBase: "rx://localhost/ACCT",
        sleep: async () => {},
        fetch: (async () => {
          if (n++ === 0) throw new TypeError("Load failed");
          return answer(202, { job: 2 });
        }) as typeof fetch,
      });
      expect(await doors.send(m, body)).toEqual({ status: 202, json: { job: 2 } });
    });

    it("spacesheep says it had it already: sent the first time, and its job is found in the jobs list", async () => {
      const replay = () => answer(409, { error: "That was already sent.", code: "replay" });
      const list = (jobs: unknown[]) => answer(200, { jobs });
      const mine = { id: 41, machine: m.id, action: "message", source: "claude-code", session: "s-1" };
      // One job after the last this page knew of fits the machine and the session.
      let t = open(
        [
          timeout(),
          replay(),
          list([
            { id: 40, machine: m.id, action: "message", session: "other" },
            { id: 42, machine: "m_someoneelse0123456", action: "message", session: "s-1" },
            mine,
          ]),
        ],
        { lastJob: () => 39 },
      );
      expect(await t.doors.send(m, body)).toEqual({ status: 202, json: { job: 41 } });
      expect(t.asked.at(-1)!.url).toBe("rx://localhost/ACCT/api/sessionpipe/v1/relay/jobs?since=39");
      // None fits, two fit, or the list cannot be read: sent, and no job is guessed.
      for (const jobs of [[], [mine, { ...mine, id: 43 }]]) {
        t = open([timeout(), replay(), list(jobs)]);
        expect(await t.doors.send(m, body)).toEqual({ status: 202, json: {} });
      }
      t = open([timeout(), replay(), hubSays(502, "unreachable", "x")]);
      expect(await t.doors.send(m, body)).toEqual({ status: 202, json: {} });
      // A list a hundred long is read on from its last id.
      const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, machine: m.id, session: "other" }));
      t = open([timeout(), replay(), list(full), list([{ ...mine, id: 101 }])]);
      expect(await t.doors.send(m, body)).toEqual({ status: 202, json: { job: 101 } });
      expect(t.asked.at(-1)!.url).toMatch(/jobs\?since=100$/);
    });

    it("still unheard after every try: one code that says nobody knows, with the hub's last words", async () => {
      const waits: number[] = [];
      const { doors, asked } = open([timeout(), timeout(), timeout()], { sleep: async (ms) => void waits.push(ms) });
      expect(await doors.send(m, body)).toEqual({
        status: 504,
        json: { code: SEND_UNKNOWN_CODE, error: "spacesheep did not answer in time." },
      });
      expect(waits).toEqual([...SEND_UNKNOWN_WAITS_MS]);
      expect(posts(asked)).toHaveLength(3);
      expect(SEND_UNKNOWN_CODE).toBe("hub_unknown");
    });

    it("a refusal on the second asking is the answer: the first never arrived", async () => {
      const held = answer(409, { error: "Confirm with your passkey.", code: "confirm", why: "it deletes a folder" });
      const { doors } = open([timeout(), held]);
      expect(await doors.send(m, body)).toEqual({
        status: 409,
        json: { error: "Confirm with your passkey.", code: "confirm", why: "it deletes a folder" },
      });
    });
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

  it("a request that never comes back from the app, however often it is asked: nobody knows, in plain words", async () => {
    const { doors, asked } = open([]);
    expect(await doors.send(m, {})).toEqual({
      status: 504,
      json: { code: "hub_unknown", error: "spacesheep could not be reached." },
    });
    expect(asked).toHaveLength(1 + SEND_UNKNOWN_WAITS_MS.length);
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
  it("drops the pages a read of the relay would no longer bring: taken more than its week ago, oldest first", () => {
    const now = Date.parse("2026-11-12T12:00:00.000Z");
    const day = 86_400_000;
    /** An event this phone took `days` ago; its own time is its machine's word. */
    const at = (days: number, time = now - days * day) => ({
      arrivedAt: new Date(now - days * day).toISOString(),
      time: new Date(time).toISOString(),
    });
    const pages = [
      { key: 10, events: [at(30), at(9)] },
      { key: 11, events: [] },
      { key: 20, events: [at(8), at(7.5)] },
      { key: 30, events: [at(9), at(6)] },
      { key: 40, events: [at(20)] },
    ];
    // The first three hold nothing taken within a week; the fourth does, and everything after it stays.
    expect(pagesTooOld(pages, now)).toEqual([10, 11, 20]);
    expect(pagesTooOld(pages, now, 40 * day)).toEqual([]);
    // All of it old: the last page stays, since it carries the cursor.
    expect(pagesTooOld(pages.slice(0, 3), now)).toEqual([10, 11]);
    // An arrival that cannot be read is never called old.
    expect(
      pagesTooOld(
        [
          { key: 1, events: [{ arrivedAt: "soon" }] },
          { key: 2, events: [at(0)] },
        ],
        now,
      ),
    ).toEqual([]);
    expect(pagesTooOld([], now)).toEqual([]);
  });

  it("goes by when the phone took an event, never by the date its machine gave it", () => {
    const now = Date.parse("2026-11-12T12:00:00.000Z");
    const day = 86_400_000;
    const ev = (arrivedDaysAgo: number, time: number) => ({
      arrivedAt: new Date(now - arrivedDaysAgo * day).toISOString(),
      time: new Date(time).toISOString(),
    });
    // One event dated next year in the first page: the trim goes on past it.
    expect(
      pagesTooOld(
        [
          { key: 1, events: [ev(9, now + 400 * day), ev(9, now - 9 * day)] },
          { key: 2, events: [ev(8, now - 8 * day)] },
          { key: 3, events: [ev(0, now)] },
        ],
        now,
      ),
    ).toEqual([1, 2]);
    // An outbox drained today: events dated ten days ago, taken now. The relay holds them
    // for a week yet, and so does the phone.
    expect(
      pagesTooOld(
        [
          { key: 1, events: [ev(0, now - 10 * day), ev(0, now - 8 * day)] },
          { key: 2, events: [ev(0, now)] },
        ],
        now,
      ),
    ).toEqual([]);
    // Only the phone's own clock can hold it off: a page it dated ahead stays until a week
    // past that date (the bound on the count holds meanwhile).
    const ahead = { key: 1, events: [ev(-30, now)] };
    const last = { key: 2, events: [ev(-40, now)] };
    expect(pagesTooOld([ahead, last], now)).toEqual([]);
    expect(pagesTooOld([ahead, last], now + 36 * day)).toEqual([]);
    expect(pagesTooOld([ahead, last], now + 38 * day)).toEqual([1]);
  });

  it("deletes the databases of accounts that are no longer on this phone, and no other", async () => {
    const deleted: string[] = [];
    const idb = {
      databases: async () => [
        { name: "sessionpipe.account.KEPT" },
        { name: "sessionpipe.account.GONE" },
        { name: "somebody-elses" },
        {},
      ],
      deleteDatabase: (name: string) => void deleted.push(name),
    } as unknown as IDBFactory;
    expect(await sweepCaches(["KEPT"], idb)).toEqual(["sessionpipe.account.GONE"]);
    expect(deleted).toEqual(["sessionpipe.account.GONE"]);
    // A browser that cannot list them, or has none: nothing happens.
    expect(await sweepCaches(["KEPT"], {} as IDBFactory)).toEqual([]);
    expect(await sweepCaches(["KEPT"], undefined)).toEqual([]);
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

  it("a save the hub cannot keep stays in memory, is named, and is tried again with the next", async () => {
    let refuse = true;
    const kept = new Map<string, unknown>();
    const docs = await openDocs(
      {
        docGet: async () => null,
        docSet: async (_id, name, value) => {
          if (refuse) throw { code: "too_large", message: "too large" };
          kept.set(name, value);
          return 1;
        },
      },
      "ACCT",
    );
    docs.keep("labels").save({ v: 1 });
    await docs.flushed();
    expect(docs.keep("labels").load()).toEqual({ v: 1 });
    expect(docs.failed()).toEqual(["labels"]);
    expect(docs.unread()).toEqual([]);
    refuse = false;
    docs.keep("labels").save({ v: 2 });
    await docs.flushed();
    expect(kept.get("labels")).toEqual({ v: 2 });
    expect(docs.failed()).toEqual([]);
  });

  it("a read that fails is tried again; one that comes back the second time is the document", async () => {
    const waits: number[] = [];
    let labelsReads = 0;
    const docs = await openDocs(
      {
        docGet: async (_id, name) => {
          if (name === "labels" && labelsReads++ === 0) throw { code: "io", message: "disk" };
          return name === "labels" ? { v: 1, names: { red: "Urgent" } } : null;
        },
        docSet: async () => 1,
      },
      "ACCT",
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([DOC_READ_WAITS_MS[0]]);
    expect(docs.unread()).toEqual([]);
    expect(docs.keep("labels").load()).toEqual({ v: 1, names: { red: "Urgent" } });
  });

  it("a document that could not be read is never written over: in memory for this launch, the hub's left as it is", async () => {
    const hub = new Map<string, unknown>([
      ["labels", { v: 1, names: { red: "Urgent" } }],
      ["marks", { v: 1, read: { a: "2026-11-01T00:00:00.000Z" } }],
    ]);
    const sets: string[] = [];
    const waits: number[] = [];
    const docs = await openDocs(
      {
        docGet: async (_id, name) => {
          if (name === "labels" || name === "sends") throw { code: "io", message: "disk" };
          return hub.get(name) ?? null;
        },
        docSet: async (_id, name, value) => {
          sets.push(name);
          hub.set(name, value);
          return 1;
        },
      },
      "ACCT",
      { sleep: async (ms) => void waits.push(ms) },
    );
    // Each was tried three times in all.
    expect(waits.sort()).toEqual([...DOC_READ_WAITS_MS, ...DOC_READ_WAITS_MS].sort());
    expect(docs.unread().sort()).toEqual(["labels", "sends"]);
    // Nothing was read, so the page starts that document from nothing...
    const labels = docs.keep("labels");
    expect(labels.load()).toBeUndefined();
    // ...and what it saves is its own for this launch: none of it reaches the hub.
    labels.save({ v: 1, names: {} });
    labels.save({ v: 1, names: { blue: "Later" } });
    docs.keep("sends").save({ v: 1, queues: {} });
    // A document that was read is kept as ever.
    docs.keep("marks").save({ v: 1, read: { a: "2026-11-02T00:00:00.000Z" } });
    await docs.flushed();
    expect(labels.load()).toEqual({ v: 1, names: { blue: "Later" } });
    expect(sets).toEqual(["marks"]);
    expect(hub.get("labels")).toEqual({ v: 1, names: { red: "Urgent" } });
    expect(hub.has("sends")).toBe(false);
    expect(docs.unread().sort()).toEqual(["labels", "sends"]);
    expect(docs.failed()).toEqual([]);
  });
});

describe("the sends a page keeps", () => {
  const row = (id: string, over: Partial<MessageRow> = {}): MessageRow =>
    ({
      id,
      machineId: "m_0123456789abcdefghij",
      cmd: "",
      at: "2026-11-12T10:00:00.000Z",
      expiresAt: "2026-11-13T10:00:00.000Z",
      kind: "prompt",
      session: "claude-code:s-1",
      via: "ui",
      remoteJob: Number(id.slice(1)),
      text: "x".repeat(2000),
      ...over,
    }) as MessageRow;
  const settled = (id: string) =>
    row(id, { outcome: "delivered", ackedAt: "2026-11-12T10:01:00.000Z", reply: "y".repeat(2000) });
  const bytes = (doc: unknown) => new TextEncoder().encode(JSON.stringify(doc)).length;

  it("under the ceiling, are kept as they are", () => {
    const queues = { m_0123456789abcdefghij: [settled("a1"), row("a2")] };
    expect(fitSends(queues)).toEqual({ v: 1, queues });
    expect(readSends(fitSends(queues))).toEqual(queues);
  });

  it("over it, lose the settled ones' long texts, then the oldest settled rows; never one that is still on its way", () => {
    const old = Array.from({ length: 60 }, (_, i) => settled(`a${100 + i}`));
    const waiting = [row("a900"), row("a901", { outcome: "taken" })];
    const queues = { m_0123456789abcdefghij: [...old, ...waiting] };
    const max = 40_000;
    expect(bytes({ v: 1, queues })).toBeGreaterThan(max);
    const kept = fitSends(queues, max).queues.m_0123456789abcdefghij!;
    expect(bytes({ v: 1, queues: { m_0123456789abcdefghij: kept } })).toBeLessThanOrEqual(max);
    // Both rows still on their way are there, whole: spacesheep's word can still settle them.
    expect(kept.filter((r) => r.id === "a900" || r.id === "a901")).toEqual(waiting);
    // Of the settled ones the newest stay, their texts cut.
    const left = kept.filter((r) => r.outcome === "delivered");
    expect(left.length).toBeGreaterThan(0);
    expect(left.length).toBeLessThan(old.length);
    expect(left.at(-1)!.id).toBe("a159");
    expect(
      left.every((r) => r.text!.length <= SETTLED_TEXT_CHARS + 1 && r.reply!.length <= SETTLED_TEXT_CHARS + 1),
    ).toBe(true);
  });

  it("with nothing settled left to drop, keep every waiting row and cut its text: the row still says what went where", () => {
    const waiting = Array.from({ length: 30 }, (_, i) => row(`a${i + 1}`));
    const queues = { m_0123456789abcdefghij: waiting };
    const kept = fitSends(queues, 20_000).queues.m_0123456789abcdefghij!;
    expect(kept.map((r) => r.id)).toEqual(waiting.map((r) => r.id));
    expect(kept.map((r) => r.remoteJob)).toEqual(waiting.map((r) => r.remoteJob));
    expect(kept.every((r) => r.text!.length === SETTLED_TEXT_CHARS + 1)).toBe(true);
  });

  it("what is not a sends document reads as none", () => {
    for (const raw of [null, undefined, "x", 7, [], { queues: [] }, { queues: null }])
      expect(readSends(raw)).toBeNull();
    expect(readSends({ v: 1, queues: { m_1: "not rows", m_2: [] } })).toEqual({ m_2: [] });
  });
});

describe("starting on what the phone kept", () => {
  const backend = (name: string) =>
    ({
      name,
      view: () => ({ id: name }),
      subscribe: () => () => {},
      asked: new Map([["GET /api/ui/info", 200]]),
      flushed: async () => {},
      transport: {},
      answer: async () => new Response("x"),
      disconnect: async () => ({}),
      deviceAsk: async () => ({}),
      device: async () => ({}),
      stop: () => {},
    }) as unknown as AccountBackend & { name: string };

  it("a kept board that reads is the backend, with what it had to say", async () => {
    const said: AccountNotice[] = [];
    const steps: string[] = [];
    const b = await startOnKept(
      async (o) => {
        steps.push(o.idb === null ? "start with nothing kept" : "start");
        o.notice({ kind: "cache_memory" });
        return backend("first");
      },
      { notice: (n) => said.push(n), forgetKept: () => steps.push("forget"), unsay: () => steps.push("unsay") },
    );
    expect((b as unknown as { name: string }).name).toBe("first");
    expect(steps).toEqual(["start"]);
    expect(said).toEqual([{ kind: "cache_memory" }]);
  });

  it("one that cannot be read is deleted and read again from the relay, without saying sessions are never kept here", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const said: AccountNotice[] = [];
      const steps: string[] = [];
      let n = 0;
      const b = await startOnKept(
        async (o) => {
          steps.push(o.idb === null ? "start with nothing kept" : "start");
          if (n++ === 0) {
            o.notice({ kind: "doc_unread", names: ["labels"] });
            throw new Error("a page that is not a page");
          }
          // Nowhere to keep the sessions this once, and the labels read fine this time.
          o.notice({ kind: "cache_memory" });
          o.notice({ kind: "doc_unread", names: ["marks"] });
          return backend("second");
        },
        {
          notice: (x) => said.push(x),
          forgetKept: () => steps.push("forget"),
          unsay: () => {
            steps.push("unsay");
            said.length = 0;
          },
        },
      );
      expect((b as unknown as { name: string }).name).toBe("second");
      expect(steps).toEqual(["start", "unsay", "forget", "start with nothing kept"]);
      // Next launch the storage is there again: "they load again each time" would be false.
      expect(said).toEqual([{ kind: "doc_unread", names: ["marks"] }]);
    } finally {
      errors.mockRestore();
    }
  });

  it("leaves in the page only what reads: nothing there sends, disconnects or holds a key", () => {
    const hook = hookOf(backend("b"));
    expect(Object.keys(hook).sort()).toEqual(["asked", "flushed", "subscribe", "view"]);
    expect(hook.view()).toEqual({ id: "b" });
    expect(hook.asked.get("GET /api/ui/info")).toBe(200);
  });
});

describe("what the page tells a person once", () => {
  it("says that sessions are not kept, and that labels and read marks could not be read; nothing for the rest", () => {
    expect(noticeWords({ kind: "cache_memory" })).toEqual({
      title: "Sessions are not kept on this phone",
      body: "Its storage could not be opened, so they load again each time the app opens.",
    });
    const unread = {
      title: "Labels and read marks are not being saved",
      body: "This phone could not read the ones it keeps, so changes made now are not kept.",
    };
    expect(noticeWords({ kind: "doc_unread", names: ["labels"] })).toEqual(unread);
    expect(noticeWords({ kind: "doc_unread", names: ["limits", "marks"] })).toEqual(unread);
    // The limits are read again from the events and the sends are spacesheep's to settle:
    // nothing of the person's own is at stake, so nothing is said.
    expect(noticeWords({ kind: "doc_unread", names: ["limits", "sends"] })).toBeNull();
    expect(noticeWords({ kind: "doc_unread" })).toBeNull();
  });
});

describe("the page's event log", () => {
  // One clock for both stores: an event's arrival is the store's own time.
  beforeEach(() => void vi.useFakeTimers({ now: Date.now() }));
  afterEach(() => void vi.useRealTimers());
  const session = new Session("s-log");
  const long = "x".repeat(6000);
  const events = (): ProtocolEvent[] => [
    session.ev("session.started", { source: "startup" }, { tier: 2 }),
    session.ev("turn.started", { turn_id: "t1" }, { tier: 2 }),
    session.ev("turn.transcript", { turn: 1, user: "short", assistant: long }, { tier: 2 }),
    session.ev("tool.started", { tool: "Read", call_id: "c1" }, { tier: 2 }),
    session.ev("turn.ended", { turn_id: "t1" }, { tier: 2 }),
  ];
  const readings = (store: StoreCore) => {
    const key = store.snapshot().sessions[0]!.key;
    const detail = store.sessionDetail(key, -1, 100)!;
    return {
      sessions: store.snapshot().sessions.map(({ lastAt: _l, stateSince: _s, ...rest }) => rest),
      events: detail.events.map(({ arrivedAt: _a, ...rest }) => rest),
      feed: store.feed({ limit: 50 }).events.map((e) => e.id),
      bytes: store.stats().storageBytes,
    };
  };

  it("gives the store the same board, session page and sizes as a log that keeps every event", async () => {
    const list = events();
    const mine = new StoreCore("page", { keepDays: 0, tickMs: 60_000, statsMs: 60_000 }, new PageLog());
    const whole = new StoreCore("page", { keepDays: 0, tickMs: 60_000, statsMs: 60_000 }, new MemoryLog());
    mine.ingest(list, "spacesheep");
    whole.ingest(list, "spacesheep");
    expect(readings(mine)).toEqual(readings(whole));
    // The one event the index cut reads back whole; the rest are the index's own copies.
    const detail = mine.sessionDetail(mine.snapshot().sessions[0]!.key, -1, 100)!;
    expect((detail.events[2]!.data as { assistant: string }).assistant).toBe(long);
    expect((detail.events[2] as { preview?: unknown }).preview).toBeUndefined();
    await mine.close();
    await whole.close();
  });

  it("boots from what was kept to the same readings, and lets the kept events go", async () => {
    const first = new StoreCore("page", { keepDays: 0, tickMs: 60_000, statsMs: 60_000 }, new MemoryLog());
    const stored = first.ingest(events(), "spacesheep").stored;
    const log = new PageLog(JSON.parse(JSON.stringify(stored)) as StoredEvent[]);
    const again = new StoreCore("page", { keepDays: 0, tickMs: 60_000, statsMs: 60_000 }, log);
    expect(readings(again)).toEqual(readings(first));
    // A second boot from the same log finds nothing: what was seeded is the store's now.
    expect(log.scanEach(() => {})).toEqual([]);
    // Forgetting a session forgets its kept lines.
    const key = again.snapshot().sessions[0]!.key;
    again.forget(key);
    expect(log.readAt("claude-code", "s-log", [{ offset: 2, bytes: 0 }])).toEqual([undefined]);
    await first.close();
    await again.close();
  });
});
