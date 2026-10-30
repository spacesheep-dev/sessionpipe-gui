// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LimitsEntry, ROUTES, type SessionDetail } from "../../shared/api.js";
import { Session, SID, tempDir } from "../../test/events.js";
import { type App, createApp } from "../app.js";
import { MAX_BYTES, MAX_EVENTS } from "./index.js";

let app: App;
let tmp: { dir: string; cleanup: () => void };
let token: string;

beforeAll(async () => {
  tmp = tempDir();
  app = await createApp({ port: 0, stateDir: tmp.dir, outbox: false, quiet: true });
  token = app.config().sinkToken;
});
afterAll(async () => {
  await app.close();
  tmp.cleanup();
});

const post = (body: unknown, headers: Record<string, string> = {}, auth: string | null = token) =>
  fetch(`${app.url}${ROUTES.events}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("well-known", () => {
  it("describes the receiver per HTTP.md §1", async () => {
    const res = await fetch(`${app.url}${ROUTES.wellKnown}`);
    expect(res.status).toBe(200);
    const wk = await res.json();
    expect(wk).toMatchObject({
      protocol: [1],
      max_tier: 3,
      capabilities: ["events", "backfill", "forget", "control"],
      auth: ["bearer"],
      endpoints: { events: ROUTES.events, control: ROUTES.control },
      batch: { max_events: 50, max_bytes: 262144 },
      control: { wait_max_s: 25, signing: { rp_id: "localhost", algs: [-7, -257] } },
    });
  });
});

describe("POST events", () => {
  it("401 on a missing or wrong bearer", async () => {
    const s = new Session();
    expect((await post({ events: [s.ev("session.started")] }, {}, null)).status).toBe(401);
    const res = await post({ events: [s.ev("session.started")] }, {}, "wrong");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("400 unsupported_protocol on a foreign protocol header", async () => {
    const res = await post({ events: [new Session().ev("session.started")] }, { "sessionpipe-protocol": "99" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ reason: "unsupported_protocol", supported: [1] });
    expect(
      (await post({ events: [new Session("p1").ev("session.started")] }, { "sessionpipe-protocol": "1" })).status,
    ).toBe(202);
  });

  it("400 malformed on bad JSON, a non-batch and an empty batch", async () => {
    for (const body of [
      "{not json",
      "[]",
      JSON.stringify({}),
      JSON.stringify({ events: [] }),
      JSON.stringify({ events: "x" }),
    ]) {
      const res = await post(body);
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ reason: "malformed" });
    }
  });

  it("413 over max_events or max_bytes", async () => {
    const s = new Session("many");
    const events = Array.from({ length: MAX_EVENTS + 1 }, () => s.ev("tool.ended", { tool: "Bash", ok: true }));
    const r1 = await post({ events });
    expect(r1.status).toBe(413);
    expect(await r1.json()).toMatchObject({ reason: "too_many_events", max_events: MAX_EVENTS });
    const fat = new Session("fat").ev("tool.ended", { tool: "Bash", ok: true, output: "z".repeat(MAX_BYTES) });
    const r2 = await post({ events: [fat] });
    expect(r2.status).toBe(413);
    expect(await r2.json()).toMatchObject({ reason: "batch_too_large", max_bytes: MAX_BYTES });
  });

  it("403 tier_above_max when any event's tier is above 3", async () => {
    const s = new Session("tier");
    const high = { ...s.ev("session.started"), tier: 4 };
    const res = await post({ events: [s.ev("session.started"), high] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ reason: "tier_above_max", max_tier: 3 });
    expect(app.store.session("claude-code:tier")).toBeUndefined();
  });

  it("validates per event: rejected with a reason, counts add up, the rest is stored", async () => {
    const s = new Session("valid");
    const ok = s.ev("session.started", { source: "startup" });
    const badId = { ...s.ev("turn.started"), id: "not-a-ulid" };
    const badType = { ...s.ev("turn.started"), type: "Turn.Started" };
    const badTime = { ...s.ev("turn.started"), time: "yesterday" };
    const badProto = { ...s.ev("turn.started"), protocol: 2 };
    const badSession = { ...s.ev("turn.started"), session: { id: "bad id!", seq: 9 } };
    const badSeq = { ...s.ev("turn.started"), session: { id: "valid", seq: -1 } };
    const badPrivacy = { ...s.ev("turn.started"), privacy: { pii: false } };
    const badData = { ...s.ev("turn.started"), data: "x" };
    const tierType = s.ev("tool.ended", { tool: "Bash", ok: true }, { tier: 0 });
    const progressTier = s.ev("turn.progress", { turn: 1, user: "u", assistant: "a", at: "x" }, { tier: 1 });
    const native = s.ev("native", { raw: true }, { tier: 3 });
    const events = [
      ok,
      badId,
      badType,
      badTime,
      badProto,
      badSession,
      badSeq,
      badPrivacy,
      badData,
      tierType,
      progressTier,
      native,
      42,
      null,
      ok,
    ];
    const res = await post({ events });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: number;
      duplicates: number;
      rejected: { id: string; reason: string }[];
      max_tier: number;
    };
    expect(body.max_tier).toBe(3);
    expect(body.accepted + body.duplicates + body.rejected.length).toBe(events.length);
    expect(body.accepted).toBe(2);
    expect(body.duplicates).toBe(1);
    const reasons = Object.fromEntries(body.rejected.map((r) => [r.id, r.reason]));
    expect(reasons[badId.id]).toBe("bad_id");
    expect(reasons[badType.id]).toBe("bad_type");
    expect(reasons[badTime.id]).toBe("bad_time");
    expect(reasons[badProto.id]).toBe("unsupported_protocol");
    expect(reasons[badSession.id]).toBe("bad_session");
    expect(reasons[badSeq.id]).toBe("bad_seq");
    expect(reasons[badPrivacy.id]).toBe("bad_privacy");
    expect(reasons[badData.id]).toBe("bad_data");
    expect(reasons[tierType.id]).toBe("tier_type");
    expect(reasons[progressTier.id]).toBe("tier_type");
    expect(body.rejected.filter((r) => r.id === "" && r.reason === "malformed")).toHaveLength(2);
    expect(app.store.session("claude-code:valid")!.counts.events).toBe(2);
  });

  it("stores an unknown type and makes it retrievable; dedups a repeat", async () => {
    const s = new Session("unknown");
    const batch = { events: [s.ev("session.started"), s.ev("x.y", { anything: [1, 2] })] };
    const r1 = await post(batch);
    expect(r1.status).toBe(202);
    expect(await r1.json()).toMatchObject({ accepted: 2, duplicates: 0, rejected: [] });
    const r2 = await post(batch);
    expect(await r2.json()).toMatchObject({ accepted: 0, duplicates: 2 });
    const detail = (await (await fetch(`${app.url}${ROUTES.ui.session}/claude-code/unknown`)).json()) as SessionDetail;
    expect(detail.events[1]!).toMatchObject({ type: "x.y", data: { anything: [1, 2] }, source: "http" });
    expect(Date.parse(detail.events[1]!.arrivedAt)).toBeGreaterThan(0);
    expect(detail.events[1]!.arrivedAt >= detail.events[1]!.time).toBe(true);
  });

  it("takes limits.observed at tier 1 and keeps its numbers; at tier 0 it is tier_type", async () => {
    const s = new Session("limits", "codex");
    const windows = [{ id: "primary", used_percent: 12, window_minutes: 300, resets_at: "2026-10-28T19:43:49.000Z" }];
    const low = s.ev("limits.observed", { windows }, { tier: 0 });
    const ok = s.ev("limits.observed", { windows, plan: "pro" }, { tier: 1 });
    const res = await post({ events: [s.ev("session.started"), low, ok] });
    expect(await res.json()).toMatchObject({ accepted: 2, rejected: [{ id: low.id, reason: "tier_type" }] });
    const { limits } = (await (await fetch(`${app.url}${ROUTES.ui.limits}`)).json()) as { limits: LimitsEntry[] };
    expect(limits).toMatchObject([
      { key: "codex m:misha-air", plan: "pro", windows: [{ id: "primary", usedPercent: 12, windowMinutes: 300 }] },
    ]);
  });

  it("honours session.forgotten before answering", async () => {
    const s = new Session(SID);
    expect((await post({ events: [s.ev("session.started"), s.ev("turn.started")] })).status).toBe(202);
    expect((await fetch(`${app.url}${ROUTES.ui.session}/claude-code/${SID}`)).status).toBe(200);
    const res = await post({ events: [s.ev("session.forgotten")] });
    expect(await res.json()).toMatchObject({ accepted: 1, duplicates: 0, rejected: [] });
    expect((await fetch(`${app.url}${ROUTES.ui.session}/claude-code/${SID}`)).status).toBe(404);
  });
});
