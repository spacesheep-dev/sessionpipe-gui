// SPDX-License-Identifier: Apache-2.0
import { chmodSync, existsSync, mkdirSync, readFileSync, rmdirSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { Outbox } from "sessionpipe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Session, tempDir } from "../../test/events.js";
import { Store } from "../store/store.js";
import { resolveOutboxRoot, startOutboxSource } from "./outbox.js";

let tmp: { dir: string; cleanup: () => void };
let store: Store;
let spState: string;

beforeEach(() => {
  tmp = tempDir();
  spState = path.join(tmp.dir, "sessionpipe");
  store = new Store(path.join(tmp.dir, "gui"));
});
afterEach(async () => {
  await store.close();
  tmp.cleanup();
});

/** Write events the way the client does: Outbox.append into <state>/outbox/<harness>/<id>.jsonl. */
const write = (s: Session, events: ReturnType<Session["ev"]>[]) =>
  new Outbox(spState).append({ harness: s.harness, session: s.id }, events as never);

const size = (id: string) => statSync(path.join(spState, "outbox", "claude-code", `${id}.jsonl`)).size;

describe("outbox source", () => {
  it("reads every file from the start on first run, then only what is new", () => {
    const a = new Session("aaa");
    const b = new Session("bbb", "codex");
    write(a, [a.ev("session.started"), a.ev("turn.started")]);
    write(b, [b.ev("session.started")]);
    const src = startOutboxSource(store, { path: spState, intervalMs: 50 });
    try {
      expect(src.status()).toMatchObject({ path: path.join(spState, "outbox"), sessions: 2, enabled: true, events: 3 });
      expect(store.stats()).toMatchObject({ events: 3, sessions: 2 });
      expect(store.session("codex:bbb")!.source).toBe("outbox");
      write(a, [a.ev("tool.started", { tool: "Bash" })]);
      src.tick();
      expect(store.session("claude-code:aaa")!.counts.events).toBe(3);
      expect(src.status().events).toBe(4);
      const offsets = JSON.parse(readFileSync(path.join(store.dir, "outbox-offsets.json"), "utf8"));
      expect(Object.keys(offsets).sort()).toEqual(["claude-code/aaa", "codex/bbb"]);
    } finally {
      src.stop();
    }
  });

  it("drains a long file in one tick and skips lines that are not events", () => {
    const a = new Session("long");
    const events = [a.ev("session.started")];
    for (let i = 0; i < 450; i++) events.push(a.ev("tool.ended", { tool: "Bash", ok: true }));
    write(a, events);
    write(a, [{ ...a.ev("turn.started"), id: "bad" } as never]);
    const src = startOutboxSource(store, { path: path.join(spState, "outbox") });
    src.stop();
    expect(store.session("claude-code:long")!.counts.events).toBe(451);
  });

  it("resumes from the persisted offsets after a restart without duplicates", () => {
    const a = new Session("resume");
    write(a, [a.ev("session.started"), a.ev("turn.started")]);
    const first = startOutboxSource(store, { path: spState });
    first.stop();
    expect(existsSync(path.join(store.dir, "outbox-offsets.json"))).toBe(true);
    write(a, [a.ev("turn.ended", { reason: "stop" })]);
    const second = startOutboxSource(store, { path: spState });
    second.stop();
    expect(second.status().events).toBe(1);
    expect(store.session("claude-code:resume")!.counts.events).toBe(3);
    expect(store.stats().events).toBe(3);
  });

  it("reads a batch again on the next tick when the store can't write it", () => {
    const a = new Session("full");
    const b = new Session("long");
    const src = startOutboxSource(store, { path: spState });
    try {
      write(a, [a.ev("session.started"), a.ev("turn.started"), a.ev("turn.ended", { reason: "stop" })]);
      // The second batch of a 250-line file fails too: the first batch's offset may move, not the second's.
      const long = [b.ev("session.started")];
      for (let i = 0; i < 249; i++) long.push(b.ev("tool.ended", { tool: "Bash", ok: true }));
      write(b, long);
      const enospc = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      const real = store.ingest.bind(store);
      // Fail once on session "full", and once on the second batch of "long" (seq 200 on).
      const failed = new Set<string>();
      const ingest = vi.spyOn(store, "ingest").mockImplementation((evs, source) => {
        const which = evs[0]!.session.id === "full" ? "full" : evs[0]!.session.seq >= 200 ? "long#2" : "";
        if (which && !failed.has(which)) {
          failed.add(which);
          throw enospc;
        }
        return real(evs, source);
      });
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      src.tick();
      src.tick();
      err.mockRestore();
      expect([...failed].sort()).toEqual(["full", "long#2"]);
      ingest.mockRestore();
      expect(store.session("claude-code:full")!.counts.events).toBe(3);
      expect(store.session("claude-code:long")!.counts.events).toBe(250);
      expect(store.stats().events).toBe(253);
      const offsets = JSON.parse(readFileSync(path.join(store.dir, "outbox-offsets.json"), "utf8"));
      expect(offsets["claude-code/full"]).toBe(size("full"));
      expect(offsets["claude-code/long"]).toBe(size("long"));
    } finally {
      src.stop();
    }
  });

  it("keeps the other sessions flowing while one can't be stored, and logs that once", () => {
    const a = new Session("stuck");
    const b = new Session("fine");
    const src = startOutboxSource(store, { path: spState });
    try {
      write(a, [a.ev("session.started")]);
      write(b, [b.ev("session.started")]);
      const eacces = Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
      const real = store.ingest.bind(store);
      const ingest = vi.spyOn(store, "ingest").mockImplementation((evs, source) => {
        if (evs[0]!.session.id === "stuck") throw eacces;
        return real(evs, source);
      });
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      src.tick();
      src.tick();
      write(b, [b.ev("turn.started")]);
      src.tick();
      expect(err.mock.calls.filter(([m]) => String(m).includes("can't store claude-code/stuck"))).toHaveLength(1);
      err.mockRestore();
      expect(store.session("claude-code:fine")!.counts.events).toBe(2);
      expect(store.session("claude-code:stuck")?.counts.events ?? 0).toBe(0);
      const offsets = JSON.parse(readFileSync(path.join(store.dir, "outbox-offsets.json"), "utf8"));
      expect(offsets["claude-code/fine"]).toBe(size("fine"));
      expect(offsets["claude-code/stuck"]).toBeUndefined();
      ingest.mockRestore();
      src.tick();
      expect(store.session("claude-code:stuck")!.counts.events).toBe(1);
    } finally {
      src.stop();
    }
  });

  it("moves past a batch with no valid events without asking the store", () => {
    const a = new Session("junk");
    write(a, [{ ...a.ev("turn.started"), id: "bad" } as never]);
    const ingest = vi.spyOn(store, "ingest");
    const src = startOutboxSource(store, { path: spState });
    src.stop();
    expect(ingest).not.toHaveBeenCalled();
    const offsets = JSON.parse(readFileSync(path.join(store.dir, "outbox-offsets.json"), "utf8"));
    expect(offsets["claude-code/junk"]).toBe(size("junk"));
  });

  it("copes with no outbox at all", () => {
    const src = startOutboxSource(store, { path: path.join(tmp.dir, "nowhere") });
    src.stop();
    expect(src.status().sessions).toBe(0);
  });

  it("skips a session file it can't read and carries on with the others", () => {
    const a = new Session("aaa");
    const c = new Session("ccc");
    write(a, [a.ev("session.started")]);
    write(c, [c.ev("session.started")]);
    // A folder named like a session file, between the two in mtime order (newest first).
    const bad = path.join(spState, "outbox", "claude-code", "bbb.jsonl");
    mkdirSync(bad);
    const now = Date.now() / 1000;
    utimesSync(path.join(spState, "outbox", "claude-code", "aaa.jsonl"), now, now);
    utimesSync(bad, now - 10, now - 10);
    utimesSync(path.join(spState, "outbox", "claude-code", "ccc.jsonl"), now - 20, now - 20);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const src = startOutboxSource(store, { path: spState });
    try {
      expect(src.status()).toMatchObject({ sessions: 3, enabled: true, events: 2 });
      expect(store.session("claude-code:aaa")!.counts.events).toBe(1);
      expect(store.session("claude-code:ccc")!.counts.events).toBe(1);
      write(a, [a.ev("turn.started")]);
      write(c, [c.ev("turn.started")]);
      src.tick();
      src.tick();
      expect(src.status().events).toBe(4);
      expect(store.session("claude-code:ccc")!.counts.events).toBe(2);
      const offsets = JSON.parse(readFileSync(path.join(store.dir, "outbox-offsets.json"), "utf8"));
      expect(Object.keys(offsets).sort()).toEqual(["claude-code/aaa", "claude-code/ccc"]);
      // Said once for that file, not on every tick. (Where a folder's size is 0, as on
      // NTFS, Outbox.read finds nothing to read in it and never throws.)
      const said = err.mock.calls.map((x) => String(x[0])).filter((x) => x.includes("claude-code/bbb"));
      expect(said).toHaveLength(statSync(bad).size > 0 ? 1 : 0);
      if (said.length)
        expect(said[0]).toMatch(/^\[outbox\] can't read claude-code\/bbb: .*; skipped, its offset stays\n$/);
      // Gone and back, it is said again.
      rmdirSync(bad);
      src.tick();
      mkdirSync(bad);
      src.tick();
      const again = err.mock.calls.filter((x) => String(x[0]).includes("claude-code/bbb"));
      expect(again).toHaveLength(statSync(bad).size > 0 ? 2 : 0);
    } finally {
      src.stop();
      err.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "resumes a file that turned unreadable from its kept offset once it can be read again",
    () => {
      const a = new Session("aaa");
      const b = new Session("bbb");
      write(a, [a.ev("session.started")]);
      write(b, [b.ev("session.started")]);
      const fileB = path.join(spState, "outbox", "claude-code", "bbb.jsonl");
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const src = startOutboxSource(store, { path: spState });
      try {
        expect(src.status().events).toBe(2);
        const kept = JSON.parse(readFileSync(path.join(store.dir, "outbox-offsets.json"), "utf8"))["claude-code/bbb"];
        expect(kept).toBeGreaterThan(0);
        write(b, [b.ev("turn.started")]);
        chmodSync(fileB, 0o000);
        write(a, [a.ev("turn.started")]);
        src.tick();
        src.tick();
        expect(store.session("claude-code:aaa")!.counts.events).toBe(2);
        expect(store.session("claude-code:bbb")!.counts.events).toBe(1);
        const offsets = JSON.parse(readFileSync(path.join(store.dir, "outbox-offsets.json"), "utf8"));
        expect(offsets["claude-code/bbb"]).toBe(kept);
        expect(err.mock.calls.filter((x) => String(x[0]).includes("claude-code/bbb"))).toHaveLength(1);
        chmodSync(fileB, 0o600);
        src.tick();
        expect(store.session("claude-code:bbb")!.counts.events).toBe(2);
        expect(store.stats().events).toBe(4);
        expect(src.status()).toMatchObject({ enabled: true, events: 4 });
      } finally {
        chmodSync(fileB, 0o600);
        src.stop();
        err.mockRestore();
      }
    },
  );

  it("resolves the state dir from either spelling", () => {
    write(new Session("x"), [new Session("x").ev("session.started")]);
    expect(resolveOutboxRoot(spState)).toBe(spState);
    expect(resolveOutboxRoot(path.join(spState, "outbox"))).toBe(spState);
    expect(resolveOutboxRoot()).toMatch(/sessionpipe$/);
  });
});
