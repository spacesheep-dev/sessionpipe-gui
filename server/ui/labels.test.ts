// SPDX-License-Identifier: Apache-2.0
// Colour labels: the store's merge rules and file, and the routes and stream frames.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Labels, ROUTES, type Snapshot, type StreamMessage, sessionKey } from "../../shared/api.js";
import { Session, SID, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { LabelStore } from "./labels.js";

const KEY = sessionKey("claude-code", SID);

describe("LabelStore", () => {
  it("merges, clears with null, bumps rev, and writes the file atomically and private", () => {
    const tmp = tempDir();
    try {
      const store = new LabelStore(tmp.dir, () => true);
      const frames: StreamMessage[] = [];
      store.subscribe((m) => frames.push(m));
      expect(store.get()).toEqual({ rev: 0, names: {}, sessions: {} });
      store.patch({ sessions: { a: "red", b: "blue" }, names: { red: "  Urgent " } });
      expect(store.get()).toEqual({ rev: 1, names: { red: "Urgent" }, sessions: { a: "red", b: "blue" } });
      store.patch({ sessions: { a: null }, names: { red: null } });
      expect(store.get()).toEqual({ rev: 2, names: {}, sessions: { b: "blue" } });
      // Nothing changed: no new rev and no frame.
      store.patch({ sessions: { b: "blue" } });
      expect(store.get().rev).toBe(2);
      expect(frames.map((f) => (f as { labels: Labels }).labels.rev)).toEqual([1, 2]);
      const file = path.join(tmp.dir, "labels.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readdirSync(tmp.dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, rev: 2, names: {}, sessions: { b: "blue" } });
      // A restart reads the same document.
      expect(new LabelStore(tmp.dir, () => true).get()).toEqual(store.get());
    } finally {
      tmp.cleanup();
    }
  });

  it("refuses bad colours, bad names and unknown sessions, changing nothing", () => {
    const tmp = tempDir();
    try {
      const store = new LabelStore(tmp.dir, (k) => k === "known");
      const reason = (f: () => void) => {
        try {
          f();
          return "ok";
        } catch (e) {
          return `${(e as { status: number }).status} ${(e as Error).message}`;
        }
      };
      expect(reason(() => store.patch({ sessions: { known: "pink" as never } }))).toBe("400 bad_label");
      expect(reason(() => store.patch({ names: { pink: "x" } as never }))).toBe("400 bad_label");
      expect(reason(() => store.patch({ names: { red: "x".repeat(33) } }))).toBe("400 bad_name");
      expect(reason(() => store.patch({ names: { red: "a\nb" } }))).toBe("400 bad_name");
      expect(reason(() => store.patch({ sessions: { nope: "red" } }))).toBe("404 not_found");
      expect(reason(() => store.patch([] as never))).toBe("400 malformed");
      // Clearing an unknown key is fine (the session may be gone already).
      expect(reason(() => store.patch({ sessions: { nope: null } }))).toBe("ok");
      expect(store.get().rev).toBe(0);
    } finally {
      tmp.cleanup();
    }
  });

  it("sets a broken file aside and starts empty", () => {
    const tmp = tempDir();
    try {
      writeFileSync(path.join(tmp.dir, "labels.json"), "{nope");
      const store = new LabelStore(tmp.dir, () => true);
      expect(store.get()).toEqual({ rev: 0, names: {}, sessions: {} });
      expect(readdirSync(tmp.dir).some((f) => f.startsWith("labels.json.bad-"))).toBe(true);
      expect(existsSync(path.join(tmp.dir, "labels.json"))).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("labels routes", () => {
  let app: App;
  let tmp: { dir: string; cleanup: () => void };
  const url = (p: string) => `${app.url}${p}`;
  const patch = (body: unknown, type = "application/json") =>
    fetch(url(ROUTES.ui.labels), { method: "PATCH", headers: { "content-type": type }, body: JSON.stringify(body) });

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
    expect(await (await fetch(url(ROUTES.ui.labels))).json()).toEqual({ rev: 0, names: {}, sessions: {} });
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
    expect(first.snapshot.labels).toEqual({ rev: 0, names: {}, sessions: {} });

    const ok = await patch({ sessions: { [KEY]: "green" }, names: { green: "Shipped" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ rev: 1, names: { green: "Shipped" }, sessions: { [KEY]: "green" } });
    expect(((await next("labels")) as { labels: Labels }).labels.rev).toBe(1);
    expect(((await (await fetch(url(ROUTES.ui.snapshot))).json()) as Snapshot).labels?.sessions[KEY]).toBe("green");

    expect((await patch({ sessions: { [KEY]: "pink" } })).status).toBe(400);
    expect((await patch({ sessions: { "claude-code:nope": "red" } })).status).toBe(404);
    expect((await patch({ sessions: { [KEY]: "red" } }, "text/plain")).status).toBe(415);
    const bad = await fetch(url(ROUTES.ui.labels), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(bad.status).toBe(400);

    expect((await fetch(url(`${ROUTES.ui.forget}/claude-code/${SID}/forget`), { method: "POST" })).status).toBe(204);
    expect(((await next("labels")) as { labels: Labels }).labels.sessions).toEqual({});
    await reader.cancel();
  });
});
