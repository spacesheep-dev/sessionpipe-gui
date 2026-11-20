// SPDX-License-Identifier: Apache-2.0
// After a new key, only the new key opens the board; no route answers anything that leads
// to it. Every route the receiver has is asked, as a visitor (through the proxy, so never
// this computer), with the old key, everything the old key could read, and the sink token.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Info, ROUTES, UI_KEY_COOKIE } from "../../shared/api.js";
import { Session, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";

const PUBLIC = "https://laptop.tail1234.ts.net";
const VISITOR = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };

let tmp: { dir: string; cleanup: () => void };
let app: App;
beforeEach(async () => {
  tmp = tempDir("spgui-cutoff-");
  const web = path.join(tmp.dir, "web");
  mkdirSync(web, { recursive: true });
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>board</title>");
  app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true, webDir: web, publicUrl: PUBLIC });
  await app.keyLooked;
  const s = new Session("cutoff");
  app.store.ingest([s.ev("session.started"), s.ev("turn.started", { turn_id: "t" })], "http");
}, 60_000);
afterEach(async () => {
  await app?.close();
  tmp.cleanup();
}, 60_000);

/** Every route, its parameters filled in. */
const routes = (a: App) =>
  a.router
    .list()
    .filter((r) => !r.pattern.includes("_test"))
    .map((r) => ({ method: r.method, path: r.pattern.replace(/:[^/]+/g, "x") }));

/** One request as a visitor; the whole answer (status, headers, body) as text, or "" when it
 *  did not answer in time (a long poll, a stream). */
async function ask(a: App, method: string, p: string, o: { cookie?: string; k?: string; bearer?: string }) {
  const headers: Record<string, string> = { ...VISITOR };
  if (o.cookie) headers.cookie = `${UI_KEY_COOKIE}=${o.cookie}`;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  if (method !== "GET") headers["content-type"] = "application/json";
  const url = `${a.url}${p}${o.k ? `${p.includes("?") ? "&" : "?"}k=${encodeURIComponent(o.k)}` : ""}`;
  const body =
    method === "GET"
      ? undefined
      : JSON.stringify({ name: "box", harnesses: ["claude-code"], modes: ["turn"], version: "0.13.6", events: [] });
  try {
    const r = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(1500) });
    const text = await Promise.race([r.text(), new Promise<string>((res) => setTimeout(() => res(""), 1500))]);
    const head: string[] = [];
    r.headers.forEach((v, k) => {
      head.push(`${k}: ${v}`);
    });
    return { status: r.status, all: `${r.status} ${head.join("; ")} ${text}` };
  } catch {
    return { status: 0, all: "" };
  }
}

/** Every way to present each secret, on every route: what came back, all of it. */
async function everything(a: App, secrets: string[]): Promise<string> {
  const out: string[] = [];
  for (const r of routes(a))
    for (const secret of secrets)
      for (const how of [{ cookie: secret }, { k: secret }, { bearer: secret }])
        out.push((await ask(a, r.method, r.path, how)).all);
  return out.join("\n");
}

describe("after a new key, only the new key opens the board", () => {
  it("the old key reads no sink token, and nothing it read leads to the new key on any route", async () => {
    const k1 = app.config().uiKey;
    const sink = app.config().sinkToken;
    // What it could read before: every GET route, with the key as its cookie.
    const before: string[] = [];
    for (const r of routes(app).filter((r) => r.method === "GET"))
      before.push((await ask(app, "GET", r.path, { cookie: k1 })).all);
    const read = before.join("\n");
    expect(read).toContain(k1);
    expect(read).not.toContain(sink);
    const info = (await (await fetch(`${app.url}${ROUTES.ui.info}?k=${k1}`, { headers: VISITOR })).json()) as Info;
    expect(info).toMatchObject({ sinkToken: "", sinkCommand: "", uiKey: k1 });
    expect(info.remote?.sinkCommand).toBe("");
    // Every secret-looking word it read, and the old key.
    const words = [...new Set([k1, ...(read.match(/\b(?:spg|mt)_[A-Za-z0-9_-]{8,}/g) ?? [])])];
    app.renewUiKey();
    const k2 = app.config().uiKey;
    expect(k2).not.toBe(k1);
    const after = await everything(app, words);
    expect(after).not.toContain(k2);
    expect(app.config().uiKey).toBe(k2);
  }, 120_000);

  it("step by step: read with the old key, a new key, the old key refused, a pairing with the sink token answers no key", async () => {
    const k1 = app.config().uiKey;
    const read = await fetch(`${app.url}${ROUTES.ui.info}?k=${k1}`, { headers: VISITOR });
    expect(read.status).toBe(200);
    expect(((await read.json()) as Info).sinkToken).toBe("");
    expect((await fetch(`${app.url}${ROUTES.ui.renewKey}?k=${k1}`, { method: "POST", headers: VISITOR })).status).toBe(
      403,
    );
    expect((await fetch(`${app.url}${ROUTES.ui.renewKey}`, { method: "POST" })).status).toBe(204);
    const k2 = app.config().uiKey;
    expect((await fetch(`${app.url}${ROUTES.ui.info}?k=${k1}`, { headers: VISITOR })).status).toBe(401);
    // A pairing with the sink token, as a sending machine starts one.
    const pair = await fetch(`${app.url}${ROUTES.control}/pair`, {
      method: "POST",
      headers: { ...VISITOR, authorization: `Bearer ${app.config().sinkToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "box", harnesses: ["claude-code"], modes: ["turn"], version: "0.13.6" }),
    });
    expect(pair.status).toBe(201);
    const answer = await pair.text();
    expect(answer).not.toContain(k2);
    expect(answer).not.toContain(k1);
    // The old key in an event it sends does nothing: it is not the key.
    const s = new Session("echo");
    const sent = await fetch(`${app.url}${ROUTES.events}`, {
      method: "POST",
      headers: { ...VISITOR, authorization: `Bearer ${app.config().sinkToken}`, "content-type": "application/json" },
      body: JSON.stringify({ events: [s.ev("prompt.submitted", { text: `?k=${k1}` })] }),
    });
    expect(sent.status).toBeLessThan(300);
    expect(app.config().uiKey).toBe(k2);
  });
});

describe("the sink token", () => {
  it("opens no route that answers the board's key", async () => {
    const key = app.config().uiKey;
    const all = await everything(app, [app.config().sinkToken]);
    expect(all).not.toContain(key);
    expect(app.config().uiKey).toBe(key);
  }, 120_000);
});
