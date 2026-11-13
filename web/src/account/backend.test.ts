// SPDX-License-Identifier: Apache-2.0
// The page's own backend on a spacesheep account, whole, with no receiver anywhere: the
// hub stood in (test/account/hub.ts: the contract's commands, documents, event and five
// doors with their refusals) over a spacesheep stood in (test/account/fake-spacesheep.ts).
// What a page asks goes in as the page asks it (the Transport, apiFetch's paths), and what
// reaches spacesheep is read at the far end.
import type { ControlActivity, Snapshot, StreamMessage } from "@shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeAnswer, FakeSpacesheep } from "../../../test/account/fake-spacesheep";
import { HubStandIn } from "../../../test/account/hub";
import { Session } from "../../../test/events";
import { type AccountBackend, type AccountNotice, startAccountBackend } from "./backend";
import { NOT_HERE } from "./routes";
import { type AccountShell, accountShell, type ShellCalls } from "./shell";
import { type KeptCache, keptCache } from "./testCache";

const M1 = "m_0123456789abcdefghij";
const machine = (over: Record<string, unknown> = {}) => ({
  id: M1,
  name: "lab-mac",
  online: true,
  last_seen: Date.now(),
  folders: ["/home/me"],
  mode: "safe",
  agents: ["claude-code"],
  cli_version: "sessionpipe 0.14.2",
  modes: ["waiter"],
  passkey_ids: ["k1"],
  key_types: ["passkey", "device"],
  ...over,
});

/** A hub over a spacesheep, an account connected on it, and a page's backend on that. */
function rig(o: { features?: string[]; cache?: KeptCache; noStorage?: boolean } = {}) {
  const ss = new FakeSpacesheep();
  ss.machines = [machine()];
  const hub = new HubStandIn({
    upstream: { origin: "https://spacesheep.test", ask: (req) => ss.handle(req) },
    ...(o.features ? { features: o.features } : {}),
  });
  hub.rxBase = (id) => `https://rx.test/${id}`;
  hub.add("me@example.com", ss.key);
  const asked: string[] = [];
  const fetchDoors = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const id = u.pathname.split("/")[1]!;
    const path = u.pathname.slice(id.length + 1) + u.search;
    asked.push(`${init?.method ?? "GET"} ${path.split("?")[0]}`);
    const a: FakeAnswer = await hub.door(id, {
      method: init?.method ?? "GET",
      path,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    return new Response(a.status === 204 ? null : a.body, { status: a.status, headers: a.headers });
  }) as typeof fetch;
  /** Documents the hub cannot read: each name fails this many times more (an `io` error). */
  const failGet = new Map<string, number>();
  /** Every document write asked of the hub, by name. */
  const sets: string[] = [];
  const calls: ShellCalls = {
    status: () => hub.invoke("acct_status") as never,
    disconnect: (id) => hub.invoke("acct_disconnect", { id }).catch((e) => Promise.reject(e.toJSON())) as never,
    deviceAsk: (id) => hub.invoke("acct_device_ask", { id }).catch((e) => Promise.reject(e.toJSON())) as never,
    docGet: (id, name) => {
      const left = failGet.get(name) ?? 0;
      if (left > 0) {
        failGet.set(name, left - 1);
        return Promise.reject({ code: "io", message: "The document could not be read." });
      }
      return hub.invoke("acct_doc_get", { id, name });
    },
    docSet: (id, name, value) => {
      sets.push(name);
      return hub.invoke("acct_doc_set", { id, name, value }) as never;
    },
    docDelete: (id, name) => hub.invoke("acct_doc_delete", { id, name }) as never,
    onAccount: async (fn) => hub.on((event, payload) => event === "account" && fn(payload as never)),
    needs: (id, sessions) => hub.invoke("acct_needs", { id, sessions }),
  };
  const notices: AccountNotice[] = [];
  /** The page's own storage, as the backend used it: "claim <id>", "wipe". */
  const local: string[] = [];
  /** What it holds, across launches (a wipe empties it). */
  const stored = new Map<string, string>();
  /** Each time the backend said the account is gone: the hub's answer, or null. */
  const gone: unknown[] = [];
  let backend: AccountBackend | null = null;
  const start = async (): Promise<AccountBackend> => {
    const shell = accountShell(hub.contract()) as AccountShell;
    backend = await startAccountBackend({
      shell,
      calls,
      fetch: fetchDoors,
      idb: null,
      ...(o.cache ? { cache: o.cache } : {}),
      local: {
        claim: (id) => void local.push(`claim ${id}`),
        wipe: () => {
          local.push("wipe");
          stored.clear();
        },
        read: (key) => stored.get(key) ?? null,
        write: (key, value) => {
          if (o.noStorage) return false;
          stored.set(key, value);
          return true;
        },
      },
      onGone: (d) => void gone.push(d),
      notice: (n) => notices.push(n),
    });
    return backend;
  };
  return { ss, hub, asked, notices, calls, failGet, sets, local, stored, gone, start, stop: () => backend?.stop() };
}

/** The frames a page gets from a stream it opened. */
function listen(b: AccountBackend) {
  const frames: StreamMessage[] = [];
  const off = b.transport.openStream({ onMessage: (m) => frames.push(m), onOpen: () => {}, onError: () => {} });
  const last = <K extends StreamMessage["kind"]>(kind: K) =>
    [...frames].reverse().find((m): m is Extract<StreamMessage, { kind: K }> => m.kind === kind);
  return { frames, off, last };
}

const signed = (session: string, text = "hello") => ({
  machineId: M1,
  cmd: JSON.stringify({
    v: 1,
    t: "sessionpipe.control",
    machine: M1,
    kind: "prompt",
    session,
    text,
    nonce: "n",
    iat: Date.now(),
  }),
  csig: "sig",
  grant: { str: "g", cred: "k1", sig: "s" },
  from: session,
});
const post = (b: AccountBackend, path: string, body: unknown) =>
  b.answer(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("a page's own backend on a spacesheep account", () => {
  let r: ReturnType<typeof rig>;
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    r = rig();
  });
  afterEach(() => {
    r.stop();
    vi.useRealTimers();
  });

  it("shows the board from the relay, a session's page, the feed and the machines, and then what happens live", async () => {
    const s = new Session("s-1");
    // The session ran on the paired computer: its events name it.
    const on = { tier: 2 as const, session: { machine: "lab-mac" } };
    r.ss.push([
      s.ev("session.started", { source: "startup" }, on),
      s.ev("turn.started", { turn_id: "t1" }, on),
      s.ev("turn.transcript", { turn: 1, user: "fix the flaky login test", assistant: "done" }, on),
    ]);
    const b = await r.start();
    const page = listen(b);
    await tick(400);
    const snap = page.last("snapshot")!.snapshot;
    expect(snap.sessions.map((x) => x.id)).toEqual(["s-1"]);
    expect(snap.sessions[0]!.source).toBe("spacesheep");
    expect(
      snap.machines.map((m) => [m.name, m.control?.machineId, m.control?.online, m.control?.remote?.rpId]),
    ).toEqual([["lab-mac", M1, true, "spacesheep.test"]]);
    expect(snap.labels).toMatchObject({ rev: 0 });
    expect(snap.marks?.since).toBeTruthy();
    expect(snap.limits).toEqual([]);
    const detail = await b.transport.session("claude-code", "s-1", { tail: true, limit: 50 });
    expect(detail.events.map((e) => e.type)).toEqual(["session.started", "turn.started", "turn.transcript"]);
    expect((await b.transport.feed({ limit: 10 })).events).toHaveLength(3);
    await expect(b.transport.session("claude-code", "nope", {})).rejects.toMatchObject({ status: 404 });
    const info = await b.transport.info();
    expect(info.sources.spacesheep).toMatchObject({
      origin: "https://spacesheep.test",
      email: "me@example.com",
      state: "ok",
      cursor: 3,
    });
    expect(info.control).toMatchObject({ rpId: "spacesheep.test", machines: 1, keyTypes: ["passkey", "device"] });

    // Live: one event, one frame; no board is sent again for it.
    const boards = page.frames.filter((m) => m.kind === "snapshot").length;
    r.ss.push([s.ev("tool.started", { tool: "Bash", call_id: "c1" }, on)]);
    await tick(6000);
    expect(page.last("event")?.event.type).toBe("tool.started");
    expect(page.frames.filter((m) => m.kind === "snapshot")).toHaveLength(boards);
    expect(b.view()).toMatchObject({
      state: "ok",
      catching: false,
      cache: "memory",
      relay: { state: "ok", cursor: 4 },
    });
    // Only the doors were asked of the hub, and only the three that read.
    expect([...new Set(r.asked)].sort()).toEqual([
      "GET /api/sessionpipe/v1/relay",
      "GET /api/sessionpipe/v1/relay/machines",
    ]);
    page.off();
  });

  it("reads a long history as one board that fills in, not a frame an event", async () => {
    const all = Array.from({ length: 5 }, (_, i) => new Session(`s-${i}`)).flatMap((s) =>
      Array.from({ length: 260 }, (_, n) =>
        s.ev(n ? "tool.started" : "session.started", { call_id: `c${n}` }, { tier: 2 }),
      ),
    );
    r.ss.push(all);
    const b = await r.start();
    const page = listen(b);
    await tick(300);
    expect(b.view()).toMatchObject({ catching: false, store: { events: 1300, sessions: 5 } });
    expect(page.frames.filter((m) => m.kind === "event")).toEqual([]);
    expect(page.frames.filter((m) => m.kind === "snapshot").length).toBeGreaterThanOrEqual(1);
    expect(page.last("snapshot")!.snapshot.sessions).toHaveLength(5);
    expect(b.view().firstBoardMs).not.toBeNull();
    page.off();
  });

  it("sends a signed message through the jobs door with only what the door takes, and follows its job", async () => {
    const s = new Session("s-1");
    r.ss.push([s.ev("session.started", {}, { tier: 2 })]);
    const b = await r.start();
    const page = listen(b);
    await tick(400);
    const res = await post(b, "/api/ui/control/send", signed("claude-code:s-1"));
    expect(res.status).toBe(201);
    const row = (await res.json()) as ControlActivity;
    expect(row).toMatchObject({
      kind: "prompt",
      machineId: M1,
      session: "claude-code:s-1",
      text: "hello",
      from: "claude-code:s-1",
    });
    // What spacesheep got: the signed bytes and the four names, nothing of the page's own.
    expect(Object.keys(r.ss.jobs[0]!.sent).sort()).toEqual(["cmd", "confirm", "csig", "grant"]);
    expect(r.hub.log.filter((l) => l.startsWith("POST"))).toEqual([`POST /api/machines/${M1}/jobs 202`]);
    r.ss.settle(1, "running");
    await tick(3100);
    expect(page.last("control")?.message).toMatchObject({ id: row.id, outcome: "taken" });
    r.ss.settle(1, "refused", { code: "folder", note: "That folder isn't allowed." });
    await tick(3100);
    expect(page.last("control")?.message).toMatchObject({
      outcome: "refused",
      code: "folder",
      detail: "That folder isn't allowed.",
    });
    const activity = (await (await b.answer("/api/ui/control/activity?limit=5")).json()) as {
      activity: ControlActivity[];
    };
    expect(activity.activity.map((a) => a.id)).toEqual([row.id]);
    page.off();
  });

  it("gives a refusal the shape the page reads: spacesheep's hold, the hub's own word, a machine that is not there", async () => {
    const b = await r.start();
    await tick(400);
    r.ss.sendAnswers.push(() => ({
      status: 409,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "confirm",
        error: "Confirm with your passkey to send this: it is unusual.",
        why: "it is unusual",
      }),
    }));
    let res = await post(b, "/api/ui/control/send", signed("claude-code:s-1"));
    expect([res.status, await res.json()]).toEqual([
      422,
      {
        reason: "Confirm with your passkey to send this: it is unusual.",
        code: "confirm_required",
        detail: "it is unusual",
      },
    ]);
    // The confirm alone, with the number a person matched beside it, is what the door takes.
    const confirmed = {
      machineId: M1,
      cmd: signed("claude-code:s-1").cmd,
      confirm: { cred: "k1", sig: "s" },
      match: "0417",
    };
    res = await post(b, "/api/ui/control/send", confirmed);
    expect(res.status).toBe(201);
    expect(r.ss.jobs[0]!.sent).toMatchObject({ confirm: { cred: "k1" }, match: "0417", csig: null, grant: null });

    // The hub cannot reach spacesheep: its words, its code, never a 401 or a hold.
    r.hub.down = true;
    res = await post(b, "/api/ui/control/send", signed("claude-code:s-1"));
    expect([res.status, await res.json()]).toEqual([
      502,
      { reason: "spacesheep could not be reached.", code: "hub_unreachable" },
    ]);
    r.hub.down = false;
    // The hub's room is full twice, then it goes.
    r.hub.busy = 2;
    const sent = post(b, "/api/ui/control/send", signed("claude-code:s-1"));
    await tick(2500);
    expect((await sent).status).toBe(201);
    res = await post(b, "/api/ui/control/send", { ...signed("claude-code:s-1"), machineId: "m_nobodynobodynobody" });
    expect(res.status).toBe(404);
  });

  it("a revoked key is spacesheep's own 401 and nothing else: said at once, the waiting send marked, nothing read after", async () => {
    const b = await r.start();
    await tick(400);
    expect((await post(b, "/api/ui/control/send", signed("claude-code:s-1"))).status).toBe(201);
    r.ss.revoked = true;
    const res = await post(b, "/api/ui/control/send", signed("claude-code:s-1"));
    expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([502, "spacesheep_unauthorized"]);
    expect(b.view()).toMatchObject({ state: "unauthorized", relay: { state: "unauthorized" } });
    expect(b.transport.controlActivity && (await b.transport.controlActivity(5))[0]).toMatchObject({
      unfollowed: "revoked",
    });
    const before = r.asked.length;
    await tick(120_000);
    expect(r.asked.length).toBe(before);
  });

  it("keeps the person's labels and marks and the sends still on their way in the hub's documents, and reads them back", async () => {
    const s = new Session("s-1");
    r.ss.push([s.ev("session.started", {}, { tier: 2 })]);
    let b = await r.start();
    const page = listen(b);
    await tick(400);
    expect(
      await b.transport.patchLabels({ sessions: { "claude-code:s-1": "red" }, names: { red: "Urgent" } }),
    ).toMatchObject({ rev: 1 });
    expect(page.last("labels")?.labels.sessions).toEqual({ "claude-code:s-1": "red" });
    await expect(b.transport.patchLabels({ sessions: { "claude-code:unknown": "red" } })).rejects.toMatchObject({
      status: 404,
      message: "not_found",
    });
    const at = new Date(Date.now() + 1000).toISOString();
    expect((await b.transport.patchMarks({ read: { "claude-code:s-1": at } })).read).toEqual({ "claude-code:s-1": at });
    expect((await post(b, "/api/ui/control/send", signed("claude-code:s-1"))).status).toBe(201);
    await b.flushed();
    const account = [...r.hub.accounts.values()][0]!;
    expect([...account.docs.keys()].sort()).toEqual(["labels", "marks", "sends"]);
    // Nothing that signed the send is in what was kept.
    expect(account.docs.get("sends")).not.toMatch(/"csig"|"grant"|nonce/);
    page.off();
    b.stop();

    // The app is opened again: the same documents, and the send is followed to its end.
    b = await r.start();
    const again = listen(b);
    await tick(400);
    expect(again.last("snapshot")!.snapshot.labels?.sessions).toEqual({ "claude-code:s-1": "red" });
    expect(again.last("snapshot")!.snapshot.marks?.read).toEqual({ "claude-code:s-1": at });
    expect(again.frames.filter((m) => m.kind === "control")).toHaveLength(1);
    r.ss.settle(1, "done");
    await tick(3200);
    expect(again.last("control")?.message).toMatchObject({ outcome: "delivered" });
    again.off();
  });

  it("a session the account forgot is gone from what the phone keeps, and does not come back at the next start", async () => {
    const cache = keptCache();
    r = rig({ cache });
    const kept = new Session("s-kept");
    const gone = new Session("s-gone");
    r.ss.push([
      kept.ev("session.started", {}, { tier: 2 }),
      gone.ev("session.started", {}, { tier: 2 }),
      gone.ev("turn.transcript", { turn: 1, user: "the prompt nobody should keep", assistant: "ok" }, { tier: 2 }),
    ]);
    let b = await r.start();
    await tick(400);
    expect(b.view().store.sessions).toBe(2);
    expect(JSON.stringify(cache.events())).toContain("the prompt nobody should keep");
    // More of it arrives, and in the same page the account forgets the session.
    r.ss.push([
      gone.ev("turn.transcript", { turn: 2, user: "one more line of it", assistant: "ok" }, { tier: 2 }),
      gone.ev("session.forgotten", {}, { tier: 2 }),
      kept.ev("turn.started", { turn_id: "t1" }, { tier: 2 }),
    ]);
    await tick(30_000);
    expect(b.view().store.sessions).toBe(1);
    // Nothing of it is kept: not the page it came in on, not the one it left in.
    expect(cache.forgotten).toEqual([["claude-code:s-gone"]]);
    const text = JSON.stringify(cache.pages());
    expect(text).not.toContain("s-gone");
    expect(text).not.toContain("the prompt nobody should keep");
    expect(text).not.toContain("one more line of it");
    expect(cache.events().map((e) => e.session.id)).toEqual(["s-kept", "s-kept"]);
    // The next start reads what was kept: the session is not back, and stays away once the
    // relay (read on from the kept cursor, past the forget) has answered.
    b.stop();
    b = await r.start();
    const page = listen(b);
    await tick(400);
    expect(b.view()).toMatchObject({ restored: { events: 2 }, store: { sessions: 1 } });
    await tick(30_000);
    expect(b.view().store.sessions).toBe(1);
    expect(page.last("snapshot")!.snapshot.sessions.map((x) => x.id)).toEqual(["s-kept"]);
    page.off();
  });

  describe("a document the hub could not read at the start", () => {
    const account = () => [...r.hub.accounts.values()][0]!;
    /** A launch that needs the documents' reads tried again: time is moved while it starts. */
    const startSlowly = async (): Promise<AccountBackend> => {
      const starting = r.start();
      await tick(1000);
      return starting;
    };
    const seed = async (): Promise<void> => {
      const one = new Session("s-1");
      const two = new Session("s-2");
      r.ss.push([one.ev("session.started", {}, { tier: 2 }), two.ev("session.started", {}, { tier: 2 })]);
      const b = await r.start();
      await tick(400);
      await b.transport.patchLabels({ sessions: { "claude-code:s-1": "red" }, names: { red: "Urgent" } });
      await b.transport.patchMarks({ read: { "claude-code:s-1": "2026-11-01T00:00:00.000Z" } });
      await b.flushed();
      b.stop();
    };

    it("once: the read is tried again and the document is there, kept on as ever", async () => {
      await seed();
      r.failGet.set("labels", 1);
      r.failGet.set("marks", 1);
      const b = await startSlowly();
      await tick(400);
      expect(r.notices.filter((n) => n.kind === "doc_unread")).toEqual([]);
      expect((await b.transport.labels()).names).toEqual({ red: "Urgent" });
      await b.transport.patchLabels({ sessions: { "claude-code:s-2": "blue" } });
      await b.flushed();
      const kept = account().docs.get("labels")!;
      expect(kept).toContain("claude-code:s-1");
      expect(kept).toContain("claude-code:s-2");
      expect(kept).toContain("Urgent");
    });

    it("every time: nothing is written over what the hub keeps, the person is told, and the next launch has it all", async () => {
      await seed();
      const before = { labels: account().docs.get("labels"), marks: account().docs.get("marks") };
      expect(before.labels).toContain("Urgent");
      r.failGet.set("labels", 9);
      r.failGet.set("marks", 9);
      r.sets.length = 0;
      let b = await startSlowly();
      await tick(400);
      expect(r.notices).toContainEqual({ kind: "doc_unread", names: ["labels", "marks"] });
      // The page works: a label set now shows now.
      await b.transport.patchLabels({ sessions: { "claude-code:s-2": "blue" }, names: { blue: "Later" } });
      await b.transport.patchMarks({ read: { "claude-code:s-2": "2026-11-02T00:00:00.000Z" } });
      expect((await b.transport.labels()).sessions).toEqual({ "claude-code:s-2": "blue" });
      await b.flushed();
      await tick(5000);
      // Not one write of either reached the hub: what it keeps is what it kept.
      expect(r.sets.filter((n) => n === "labels" || n === "marks")).toEqual([]);
      expect(account().docs.get("labels")).toBe(before.labels);
      expect(account().docs.get("marks")).toBe(before.marks);
      b.stop();
      // The next launch reads them: the label set before is there, with its name.
      r.failGet.clear();
      r.notices.length = 0;
      b = await r.start();
      await tick(400);
      expect(r.notices.filter((n) => n.kind === "doc_unread")).toEqual([]);
      expect(await b.transport.labels()).toMatchObject({
        sessions: { "claude-code:s-1": "red" },
        names: { red: "Urgent" },
      });
    });

    it("the sends too: the rows kept of earlier sends are not replaced by this launch's", async () => {
      const s = new Session("s-1");
      r.ss.push([s.ev("session.started", {}, { tier: 2, session: { machine: "lab-mac" } })]);
      let b = await r.start();
      await tick(400);
      expect((await post(b, "/api/ui/control/send", signed("claude-code:s-1", "the first"))).status).toBe(201);
      await b.flushed();
      const before = account().docs.get("sends")!;
      expect(before).toContain("the first");
      b.stop();
      r.failGet.set("sends", 9);
      b = await startSlowly();
      await tick(400);
      expect((await post(b, "/api/ui/control/send", signed("claude-code:s-1", "the second"))).status).toBe(201);
      await b.flushed();
      expect(account().docs.get("sends")).toBe(before);
      // Nothing a person keeps was unread: no notice for it.
      expect(r.notices.filter((n) => n.kind === "doc_unread")).toEqual([{ kind: "doc_unread", names: ["sends"] }]);
    });
  });

  it("says so while spacesheep cannot be reached, reads at once when asked again, and is live when it answers", async () => {
    const s = new Session("s-1");
    r.ss.push([s.ev("session.started", {}, { tier: 2 })]);
    const b = await r.start();
    /** What a page's stream is told, in order: "open", "snapshot", "down". */
    const told: string[] = [];
    const watch = () =>
      b.transport.openStream({
        onOpen: () => told.push("open"),
        onMessage: (m) => m.kind === "snapshot" && told.push("snapshot"),
        onError: () => told.push("down"),
      });
    let off = watch();
    await tick(400);
    expect(told).toEqual(["open", "snapshot"]);
    // spacesheep goes away: the open stream is told, once it shows.
    r.hub.down = true;
    r.ss.push([s.ev("turn.started", { turn_id: "t1" }, { tier: 2 })]);
    await tick(30_000);
    expect(b.view().relay.state).toBe("offline");
    expect(told.at(-1)).toBe("down");
    // "Retry now" closes the stream and opens it again: the rows as they were, still down,
    // and the relay asked at once rather than at the end of the reader's pause.
    off();
    told.length = 0;
    const reads = () => r.asked.filter((a) => a === "GET /api/sessionpipe/v1/relay").length;
    const before = reads();
    off = watch();
    await tick(50);
    expect(told.slice(0, 3)).toEqual(["open", "snapshot", "down"]);
    expect(told.at(-1)).toBe("down");
    expect(told.filter((t) => t === "snapshot")).toHaveLength(1);
    // (A reader started anew reads, and on a failure once more before its pause begins.)
    const after = reads();
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(before + 2);
    // Asked again and again, it does not hammer: it starts anew every few seconds at most.
    for (let i = 0; i < 5; i++) {
      off();
      off = watch();
      await tick(50);
    }
    expect(reads()).toBe(after);
    // It answers: the stream that is open is handed a board, and that is live.
    r.hub.down = false;
    told.length = 0;
    await tick(60_000);
    expect(b.view().relay.state).toBe("ok");
    expect(told).toEqual(["snapshot"]);
    // A stream opened now is told nothing of a drop.
    off();
    told.length = 0;
    off = watch();
    await tick(50);
    expect(told).toEqual(["open", "snapshot"]);
    off();
  });

  describe("the reads spent of spacesheep's limit", () => {
    /** A relay as full as it gets: 50 000 events, a hundred reads to take it all. */
    const fill = (): void => {
      const all: ReturnType<Session["ev"]>[] = [];
      for (let i = 0; i < 100; i++) {
        const s = new Session(`s-${i}`);
        for (let n = 0; n < 500; n++)
          all.push(s.ev(n ? "tool.started" : "session.started", { call_id: `c${n}` }, { tier: 2 }));
      }
      r.ss.push(all);
    };
    const keptReads = (): number[] => {
      const text = [...r.stored.entries()].find(([k]) => k.startsWith("sessionpipe-gui.account.reads."))?.[1];
      return text ? (JSON.parse(text) as { reads: number[] }).reads : [];
    };

    it("are written down with every page, so a page killed in the middle of a backlog has lost none", async () => {
      fill();
      await r.start();
      // A moment in: no timer of the reader's has run, nothing was stopped or hidden.
      await tick(300);
      const spent = r.ss.relayReads;
      expect(spent).toBeGreaterThan(10);
      expect(keptReads().length).toBeGreaterThanOrEqual(spent - 1);
      // Killed here (never stopped): the next page starts from what was written.
    });

    it("are kept with nowhere to keep the sessions: opened four times in ten minutes, spacesheep's limit is never met", async () => {
      fill();
      const seen: string[] = [];
      for (let launch = 1; launch <= 4; launch++) {
        const b = await r.start();
        for (let i = 0; i < 12; i++) {
          await tick(5000);
          seen.push(b.view().relay.state);
        }
        b.stop();
        await tick(30_000);
      }
      // Six minutes in all, inside one of spacesheep's windows: it counted every read, and
      // never had to refuse one.
      expect(seen).not.toContain("limited");
      expect(r.ss.relayReads).toBeLessThanOrEqual(240);
      expect(r.ss.log.filter((l) => l.includes("/relay?")).length).toBe(r.ss.relayReads);
      expect(keptReads().length).toBeGreaterThan(150);
      expect(keptReads().length).toBe(r.ss.relayReads);
    }, 120_000);

    it("where the page's own storage will not take them, they are kept beside the sessions as before", async () => {
      const cache = keptCache();
      r = rig({ cache, noStorage: true });
      const s = new Session("s-1");
      r.ss.push([s.ev("session.started", {}, { tier: 2 })]);
      const b = await r.start();
      await tick(400);
      b.stop();
      expect(r.stored.size).toBe(0);
      expect((JSON.parse(cache.meta.get("reads")!) as { reads: number[] }).reads.length).toBeGreaterThan(0);
    });

    it("go with a disconnect: a new connect is a new key", async () => {
      const s = new Session("s-1");
      r.ss.push([s.ev("session.started", {}, { tier: 2 })]);
      const b = await r.start();
      await tick(400);
      expect(keptReads().length).toBeGreaterThan(0);
      await b.disconnect();
      expect(keptReads()).toEqual([]);
    });
  });

  describe("a cold start whose first read fails", () => {
    type Snap = { sessions: { key: string; newsAt?: string }[]; marks: { since: string } };
    const unread = async (b: AccountBackend): Promise<string[]> => {
      const snap = (await (await b.answer("/api/ui/snapshot")).json()) as Snap;
      return snap.sessions.filter((x) => x.newsAt && x.newsAt > snap.marks.since).map((x) => x.key);
    };
    const history = (n: number) =>
      Array.from({ length: n }, (_, i) => new Session(`s-${i}`)).flatMap((s) => [
        s.ev("session.started", {}, { tier: 2 }),
        s.ev("turn.transcript", { turn: 1, user: "hello", assistant: "hi" }, { tier: 2 }),
      ]);

    it("spacesheep unreachable, then a short history: one board, no live frames, none of it unread", async () => {
      r.ss.push(history(2));
      r.hub.down = true;
      const b = await r.start();
      const page = listen(b);
      await tick(400);
      expect(b.view()).toMatchObject({ relay: { state: "offline" }, catching: true });
      // What is here is shown as it is (an empty board), not a page that waits for ever.
      expect(page.last("snapshot")!.snapshot.sessions).toEqual([]);
      r.hub.down = false;
      await tick(120_000);
      expect(b.view()).toMatchObject({ relay: { state: "ok" }, catching: false, store: { sessions: 2 } });
      expect(page.frames.filter((m) => m.kind === "event")).toEqual([]);
      expect(page.last("snapshot")!.snapshot.sessions).toHaveLength(2);
      expect(await unread(b)).toEqual([]);
      // What arrives from here on is news, and live.
      await tick(5);
      const again = new Session("s-0");
      r.ss.push([
        again.ev("turn.started", { turn_id: "t9" }, { tier: 2, seq: 7 }),
        again.ev("turn.transcript", { turn: 2, user: "again", assistant: "yes" }, { tier: 2, seq: 8 }),
        again.ev("turn.ended", { turn_id: "t9" }, { tier: 2, seq: 9 }),
      ]);
      await tick(30_000);
      expect(page.frames.some((m) => m.kind === "event")).toBe(true);
      expect(await unread(b)).toEqual(["claude-code:s-0"]);
      page.off();
    });

    it("spacesheep's limit first, then the history: none of it unread", async () => {
      r.ss.push(history(3));
      r.ss.limitedUntil = Date.now() + 30_000;
      const b = await r.start();
      const page = listen(b);
      await tick(400);
      expect(b.view()).toMatchObject({ relay: { state: "limited" }, catching: true });
      await tick(180_000);
      expect(b.view()).toMatchObject({ relay: { state: "ok" }, catching: false, store: { sessions: 3 } });
      expect(page.frames.filter((m) => m.kind === "event")).toEqual([]);
      expect(await unread(b)).toEqual([]);
      page.off();
    });

    it("a key refused before anything was read shows what is here and waits for nothing", async () => {
      r.ss.push(history(1));
      r.ss.revoked = true;
      const b = await r.start();
      const page = listen(b);
      await tick(400);
      expect(b.view()).toMatchObject({ state: "unauthorized", catching: false, store: { sessions: 0 } });
      expect(page.last("snapshot")!.snapshot.sessions).toEqual([]);
      page.off();
    });
  });

  it("a relay read from its start is history, none of it unread; what arrives after is news", async () => {
    const s = new Session("s-1");
    r.ss.push([
      s.ev("session.started", {}, { tier: 2 }),
      s.ev("turn.started", { turn_id: "t1" }, { tier: 2 }),
      s.ev("turn.transcript", { turn: 1, user: "hello", assistant: "hi" }, { tier: 2 }),
      s.ev("turn.ended", { turn_id: "t1" }, { tier: 2 }),
    ]);
    let b = await r.start();
    let page = listen(b);
    await tick(400);
    let snap = page.last("snapshot")!.snapshot;
    const news = snap.sessions[0]!.newsAt!;
    expect(news).toBeTruthy();
    // The session's news is not after what the marks say is read.
    expect(snap.marks!.since! >= news).toBe(true);
    // A new turn ends while the page is open: that is news.
    await tick(5);
    r.ss.push([
      s.ev("turn.started", { turn_id: "t2" }, { tier: 2 }),
      s.ev("turn.transcript", { turn: 2, user: "again", assistant: "yes" }, { tier: 2 }),
      s.ev("turn.ended", { turn_id: "t2" }, { tier: 2 }),
    ]);
    await tick(6000);
    const later = page.last("event")!.session.newsAt!;
    expect(later > snap.marks!.since!).toBe(true);
    // The person reads it; then the phone loses what it kept (here: nowhere to keep it) and
    // reads the relay from its start again. The read mark is the hub's, and nothing is unread.
    await b.transport.patchMarks({ read: { "claude-code:s-1": later } });
    await b.flushed();
    page.off();
    b.stop();
    await tick(5);
    b = await r.start();
    page = listen(b);
    await tick(400);
    snap = page.last("snapshot")!.snapshot;
    const marks = snap.marks!;
    const again = snap.sessions[0]!.newsAt!;
    expect(again > (marks.read["claude-code:s-1"] ?? marks.since!)).toBe(false);
    page.off();
  });

  it("answers in the page what has no route on an account, and asks the network nothing for it", async () => {
    const b = await r.start();
    await tick(400);
    const before = r.asked.length;
    for (const path of [
      "/api/ui/setup/status",
      "/api/ui/themes",
      "/api/ui/workflows",
      "/api/ui/attachments",
      "/themes/x/main.js",
    ]) {
      const res = await b.answer(path);
      expect([path, res.status, await res.json()]).toEqual([path, 404, { reason: NOT_HERE }]);
    }
    expect((await (await b.answer("/api/ui/control/pairings")).json()) as unknown).toEqual({ pairings: [] });
    expect((await (await b.answer("/api/ui/control/devices")).json()) as unknown).toEqual({ devices: [] });
    const machines = (await (await b.answer("/api/ui/control/machines")).json()) as { machines: { name: string }[] };
    expect(machines.machines.map((m) => m.name)).toEqual(["lab-mac"]);
    expect(((await (await b.answer("/api/ui/snapshot")).json()) as Snapshot).machines).toHaveLength(1);
    expect(r.asked.length).toBe(before);
    expect(b.asked.get("GET /api/ui/setup/status")).toBe(404);
    await expect(b.transport.forget("claude-code", "s-1")).rejects.toMatchObject({ status: 405 });
    await expect(b.transport.rotateToken()).rejects.toMatchObject({ status: 405 });
    expect(b.transport.qrUrl()).toBeNull();
  });

  it("asks spacesheep to trust this phone's own key through the hub, and reads where it stands", async () => {
    const b = await r.start();
    await tick(400);
    // Before the key was ever asked for, the device door is the hub's refusal, not spacesheep's.
    let res = await b.answer("/api/ui/spacesheep/device");
    expect([res.status, ((await res.json()) as { reason: string }).reason]).toEqual([409, "no_device_key"]);
    // No signer (Android): the hub says so.
    res = await post(b, "/api/ui/spacesheep/device", { key: { id: "page-made" }, name: "x" });
    expect([res.status, ((await res.json()) as { reason: string }).reason]).toEqual([502, "unsupported"]);
    r.hub.deviceKey = {
      id: "A".repeat(43),
      alg: -7,
      spki: "B".repeat(120),
      type: "device",
      store: "hardware",
      uv: "each-use",
    };
    res = await post(b, "/api/ui/spacesheep/device", { key: { id: "page-made" }, name: "x" });
    expect([res.status, await res.json()]).toEqual([
      200,
      { code: "71", keyId: "A".repeat(43), trustedOn: [], devicesUrl: "https://spacesheep.test/devices" },
    ]);
    // The key that was enrolled is the hub's, whatever the page sent.
    expect([...r.ss.deviceRequests.keys()]).toEqual(["A".repeat(43)]);
    r.ss.trusting.set("A".repeat(43), [M1]);
    res = await b.answer("/api/ui/spacesheep/device");
    expect(await res.json()).toMatchObject({ trustedOn: [M1], pending: false });
  });

  it("disconnects only on the person's yes, and then holds nothing of the account: not on screen, not on the phone", async () => {
    const cache = keptCache();
    r = rig({ cache });
    const s = new Session("s-1");
    r.ss.push([s.ev("session.started", {}, { tier: 2, session: { machine: "lab-mac" } })]);
    const b = await r.start();
    const page = listen(b);
    await tick(400);
    const id = b.view().id;
    // The window opened on this account: the page's own storage is its from now.
    expect(r.local).toEqual([`claim ${id}`]);
    expect(cache.events()).toHaveLength(1);
    const settings = async () => (await (await b.answer("/api/ui/spacesheep")).json()) as { link: unknown };
    expect((await settings()).link).toMatchObject({ email: "me@example.com" });

    // No in the app's alert: nothing changes, anywhere.
    r.hub.alert = () => false;
    await expect(b.disconnect()).rejects.toMatchObject({ code: "cancelled" });
    const refused = await b.answer("/api/ui/spacesheep", { method: "DELETE" });
    expect([refused.status, ((await refused.json()) as { reason: string }).reason]).toEqual([409, "cancelled"]);
    expect(b.view().state).toBe("ok");
    expect(r.local).toEqual([`claim ${id}`]);
    expect(cache.destroyed).toBe(false);
    expect(r.gone).toEqual([]);

    // Yes: through the route Settings uses, which hands back what the hub says of the key.
    r.hub.alert = () => true;
    const res = await b.answer("/api/ui/spacesheep", { method: "DELETE" });
    const said = (await res.json()) as { ok: boolean; revoked: boolean; revokeUrl: string; note: string };
    expect(res.status).toBe(200);
    expect(said).toMatchObject({ ok: true, revoked: false });
    expect(said.revokeUrl).toMatch(/^https:\/\/spacesheep\.test\/settings/);
    expect(said.note).toMatch(/revoke it on spacesheep: Settings → API keys\.$/);
    expect(r.hub.accounts.size).toBe(0);
    // Not on the phone: the cached sessions and the page's own storage are gone...
    expect(cache.destroyed).toBe(true);
    expect(cache.events()).toEqual([]);
    expect(r.local).toEqual([`claim ${id}`, "wipe"]);
    // ...and not on screen: the board is empty, no machine is listed, Settings has no account.
    expect(b.view()).toMatchObject({ state: "gone", store: { sessions: 0 } });
    const last = page.last("snapshot")!.snapshot;
    expect(last.sessions).toEqual([]);
    expect(last.machines.filter((m) => m.control)).toEqual([]);
    expect((await settings()).link).toBeNull();
    expect((await b.transport.info()).sources.spacesheep).toBeNull();
    // Whoever draws the window was told, once, with the hub's answer.
    expect(r.gone).toHaveLength(1);
    expect(r.gone[0]).toMatchObject({ forgotten: true, revoked: false, email: "me@example.com" });
    // And nothing is asked of spacesheep after.
    const before = r.asked.length;
    await tick(120_000);
    expect(r.asked.length).toBe(before);
    page.off();
  });

  it("an account the hub no longer lists is left the same way, with no answer to pass on", async () => {
    const cache = keptCache();
    r = rig({ cache });
    const s = new Session("s-1");
    r.ss.push([s.ev("session.started", {}, { tier: 2 })]);
    const b = await r.start();
    const page = listen(b);
    await tick(400);
    expect(b.view().store.sessions).toBe(1);
    // Gone on the hub's side (replaced by another connect, disconnected from another window).
    r.hub.accounts.clear();
    r.hub.active = null;
    r.hub.on(() => {})();
    await r.hub.invoke("acct_connect_cancel");
    await tick(50);
    expect(b.view()).toMatchObject({ state: "gone", store: { sessions: 0 } });
    expect(cache.destroyed).toBe(true);
    expect(r.local).toContain("wipe");
    expect(r.gone).toEqual([null]);
    expect(page.last("snapshot")!.snapshot.sessions).toEqual([]);
    page.off();
  });

  it("starts reading again when the same account is connected again after its key was refused", async () => {
    const b = await r.start();
    await tick(400);
    r.ss.revoked = true;
    await tick(30_000);
    expect(b.view()).toMatchObject({ state: "unauthorized", relay: { state: "unauthorized" } });
    // A new connect under the same id: a new key, and the hub says the account is ok.
    r.ss.revoked = false;
    r.hub.add("me@example.com", r.ss.key);
    r.ss.push([new Session("s-9").ev("session.started", {}, { tier: 2 })]);
    await tick(30_000);
    expect(b.view()).toMatchObject({ state: "ok", relay: { state: "ok" }, store: { sessions: 1 } });
  });

  it("says once that nothing is kept between launches where there is nowhere to keep it", async () => {
    await r.start();
    expect(r.notices).toEqual([{ kind: "cache_memory" }]);
  });

  describe("needs-you", () => {
    const needing = (s: Session) => [
      s.ev("session.started", {}, { tier: 2 }),
      s.ev("turn.started", { turn_id: "t1" }, { tier: 2 }),
      s.ev(
        "attention.needed",
        { attention_id: "a1", kind: "permission", tool: "Bash", message: "Bash rm -rf build" },
        { tier: 2 },
      ),
    ];
    it("is handed to the shell where the shell says it takes it, once a change", async () => {
      r = rig({ features: ["notifications", "signer", "account", "account-needs"] });
      const s = new Session("s-1");
      r.ss.push(needing(s));
      const b = await r.start();
      const page = listen(b);
      await tick(1000);
      expect(r.hub.needs).toHaveLength(1);
      expect(r.hub.needs[0]!.sessions).toMatchObject([
        {
          key: "claude-code:s-1",
          harness: "claude-code",
          id: "s-1",
          state: "needs_you",
          openAttentions: [{ attentionId: "a1", kind: "permission", tool: "Bash", message: "Bash rm -rf build" }],
        },
      ]);
      // Nothing changed: nothing is said again.
      r.ss.push([new Session("s-2").ev("session.started", {}, { tier: 2 })]);
      await tick(6000);
      expect(r.hub.needs).toHaveLength(1);
      r.ss.push([s.ev("attention.cleared", { attention_id: "a1" }, { tier: 2 })]);
      await tick(6000);
      expect(r.hub.needs).toHaveLength(2);
      expect(r.hub.needs[1]!.sessions).toEqual([]);
      page.off();
    });
    it("is not called at all on a shell that does not list it", async () => {
      r.ss.push(needing(new Session("s-1")));
      await r.start();
      await tick(2000);
      expect(r.hub.needs).toEqual([]);
    });
  });
});
