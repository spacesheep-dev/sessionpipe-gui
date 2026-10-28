// SPDX-License-Identifier: Apache-2.0
// Read marks: the document's merge rules, caps and file, and the routes and stream frames.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKS_MAX, type Marks, ROUTES, type Snapshot, type StreamMessage, sessionKey } from "../../shared/api.js";
import { Session, SID, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { MarkStore } from "./marks.js";

const KEY = sessionKey("claude-code", SID);
const T0 = Date.parse("2026-10-28T10:00:00.000Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

describe("MarkStore", () => {
  it("is made on the first run with since, which a restart never moves", () => {
    const tmp = tempDir();
    try {
      const file = path.join(tmp.dir, "marks.json");
      const first = new MarkStore(
        tmp.dir,
        () => true,
        () => T0,
      );
      expect(first.get()).toEqual({ rev: 0, since: iso(0), read: {}, unread: {} });
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      first.patch({ read: { a: iso(5) } });
      const again = new MarkStore(
        tmp.dir,
        () => true,
        () => T0 + 3_600_000,
      );
      expect(again.get()).toEqual({ rev: 1, since: iso(0), read: { a: iso(5) }, unread: {} });
    } finally {
      tmp.cleanup();
    }
  });

  it("merges, clears with null, bumps rev with one frame a change, and writes atomically", () => {
    const tmp = tempDir();
    try {
      const store = new MarkStore(
        tmp.dir,
        () => true,
        () => T0,
      );
      const frames: StreamMessage[] = [];
      store.subscribe((m) => frames.push(m));
      store.patch({ read: { a: iso(1), b: iso(2) }, unread: { c: true } });
      expect(store.get()).toMatchObject({ rev: 1, read: { a: iso(1), b: iso(2) }, unread: { c: true } });
      store.patch({ read: { a: null, b: iso(3) }, unread: { c: null } });
      expect(store.get()).toMatchObject({ rev: 2, read: { b: iso(3) }, unread: {} });
      // Nothing changed: no new rev and no frame.
      store.patch({ read: { b: iso(3) }, unread: { c: null } });
      expect(store.get().rev).toBe(2);
      expect(frames.map((f) => (f as { kind: string; marks: Marks }).marks.rev)).toEqual([1, 2]);
      expect(frames.every((f) => f.kind === "marks")).toBe(true);
      expect(readdirSync(tmp.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect(JSON.parse(readFileSync(path.join(tmp.dir, "marks.json"), "utf8"))).toEqual({
        v: 1,
        rev: 2,
        since: iso(0),
        read: { b: iso(3) },
        unread: {},
      });
    } finally {
      tmp.cleanup();
    }
  });

  it("never moves a read mark back: a late device's older newsAt changes nothing", () => {
    const tmp = tempDir();
    try {
      const store = new MarkStore(
        tmp.dir,
        () => true,
        () => T0,
      );
      const frames: StreamMessage[] = [];
      store.subscribe((m) => frames.push(m));
      store.patch({ read: { a: iso(9) } });
      store.patch({ read: { a: iso(4) } });
      expect(store.get()).toMatchObject({ rev: 1, read: { a: iso(9) } });
      expect(frames).toHaveLength(1);
      // Cleared, it starts again from anything.
      store.patch({ read: { a: null } });
      store.patch({ read: { a: iso(4) } });
      expect(store.get()).toMatchObject({ rev: 3, read: { a: iso(4) } });
    } finally {
      tmp.cleanup();
    }
  });

  it("refuses unknown fields, a read that is not an ISO time and an unread that is not true, changing nothing", () => {
    const tmp = tempDir();
    try {
      const store = new MarkStore(
        tmp.dir,
        () => true,
        () => T0,
      );
      const reason = (f: () => void) => {
        try {
          f();
          return "ok";
        } catch (e) {
          return `${(e as { status: number }).status} ${(e as Error).message}`;
        }
      };
      expect(reason(() => store.patch({ read: { a: iso(1) }, names: {} } as never))).toBe("400 malformed");
      expect(reason(() => store.patch([] as never))).toBe("400 malformed");
      expect(reason(() => store.patch({ read: [] } as never))).toBe("400 malformed");
      expect(reason(() => store.patch({ read: { a: "yesterday" } }))).toBe("400 bad_read");
      expect(reason(() => store.patch({ read: { a: 1 as never } }))).toBe("400 bad_read");
      expect(reason(() => store.patch({ read: { a: iso(1) }, unread: { b: false as never } }))).toBe("400 bad_unread");
      expect(reason(() => store.patch({ unread: { b: "yes" as never } }))).toBe("400 bad_unread");
      expect(store.get()).toMatchObject({ rev: 0, read: {}, unread: {} });
    } finally {
      tmp.cleanup();
    }
  });

  it("skips sessions the store does not know, and a forgotten session drops its keys", () => {
    const tmp = tempDir();
    try {
      const store = new MarkStore(
        tmp.dir,
        (k) => k !== "gone",
        () => T0,
      );
      store.patch({ read: { a: iso(1), gone: iso(1) }, unread: { a: true, gone: true } });
      expect(store.get()).toMatchObject({ rev: 1, read: { a: iso(1) }, unread: { a: true } });
      store.forget("a");
      expect(store.get()).toMatchObject({ rev: 2, read: {}, unread: {} });
      store.forget("a");
      expect(store.get().rev).toBe(2);
    } finally {
      tmp.cleanup();
    }
  });

  it(`keeps at most ${MARKS_MAX} keys a map, the oldest read values going first`, () => {
    const tmp = tempDir();
    try {
      const store = new MarkStore(
        tmp.dir,
        () => true,
        () => T0,
      );
      // Newest first in the patch, so the order kept is the times', not the keys'.
      const read = Object.fromEntries(Array.from({ length: MARKS_MAX + 3 }, (_, i) => [`k${i}`, iso(MARKS_MAX - i)]));
      store.patch({ read });
      const kept = store.get().read;
      expect(Object.keys(kept)).toHaveLength(MARKS_MAX);
      for (const k of ["k5002", "k5001", "k5000"]) expect(kept[k]).toBeUndefined();
      expect(kept.k0).toBe(iso(MARKS_MAX));
      const unread = Object.fromEntries(Array.from({ length: MARKS_MAX + 1 }, (_, i) => [`u${i}`, true as const]));
      store.patch({ unread });
      expect(Object.keys(store.get().unread)).toHaveLength(MARKS_MAX);
      expect(store.get().unread.u0).toBeUndefined();
      expect(statSync(path.join(tmp.dir, "marks.json")).size).toBeLessThanOrEqual(256 * 1024);
    } finally {
      tmp.cleanup();
    }
  });

  it("sets a broken file aside and starts again from now", () => {
    const tmp = tempDir();
    try {
      writeFileSync(path.join(tmp.dir, "marks.json"), "{nope");
      const store = new MarkStore(
        tmp.dir,
        () => true,
        () => T0,
      );
      expect(store.get()).toEqual({ rev: 0, since: iso(0), read: {}, unread: {} });
      expect(readdirSync(tmp.dir).some((f) => f.startsWith("marks.json.bad-"))).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("marks routes", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  const url = (p: string) => `${app.url}${p}`;
  const patch = (body: unknown, type = "application/json") =>
    fetch(url(ROUTES.ui.marks), { method: "PATCH", headers: { "content-type": type }, body: JSON.stringify(body) });

  beforeAll(async () => {
    tmp = tempDir();
    app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true });
    const s = new Session();
    app.store.ingest([s.ev("session.started", { source: "startup" })], "http");
  });
  afterAll(async () => {
    await app.close();
    tmp.cleanup();
  });

  it("GET reads, PATCH merges, the snapshot and the stream carry them, forget drops them", async () => {
    const empty = (await (await fetch(url(ROUTES.ui.marks))).json()) as Marks;
    expect(empty).toMatchObject({ rev: 0, read: {}, unread: {} });
    expect(empty.since).toMatch(/^\d{4}-\d\d-\d\dT/);
    const res = await fetch(url(ROUTES.ui.stream));
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const next = async (kind: string): Promise<StreamMessage> => {
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split("\n").find((l) => l.startsWith("data: "));
          const m = data ? (JSON.parse(data.slice(6)) as StreamMessage) : null;
          if (m?.kind === kind) return m;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += dec.decode(value, { stream: true });
      }
    };
    const first = (await next("snapshot")) as { snapshot: Snapshot };
    expect(first.snapshot.marks).toEqual(empty);

    const at = new Date().toISOString();
    const ok = await patch({ read: { [KEY]: at }, unread: { [KEY]: true } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ rev: 1, read: { [KEY]: at }, unread: { [KEY]: true } });
    expect(((await next("marks")) as { marks: Marks }).marks.rev).toBe(1);
    expect(((await (await fetch(url(ROUTES.ui.snapshot))).json()) as Snapshot).marks?.unread[KEY]).toBe(true);

    expect((await patch({ unread: { [KEY]: false } })).status).toBe(400);
    expect((await patch({ read: { [KEY]: "now" } })).status).toBe(400);
    expect((await patch({ read: {} }, "text/plain")).status).toBe(415);

    expect((await fetch(url(`${ROUTES.ui.forget}/claude-code/${SID}/forget`), { method: "POST" })).status).toBe(204);
    expect(((await next("marks")) as { marks: Marks }).marks).toMatchObject({ rev: 2, read: {}, unread: {} });
    await reader.cancel();
  });
});
