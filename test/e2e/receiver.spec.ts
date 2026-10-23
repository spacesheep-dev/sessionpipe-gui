// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The receiver over HTTP, as a sink would use it (HTTP.md §1–2): a tier-1 batch is
// accepted and shows on the board, the same batch again is all duplicates, a wrong
// token is 401, a foreign protocol integer is 400, and the well-known file fits its schema.
import { expect, test } from "@playwright/test";
import { EVENTS, INFO, openBoard, sessionUrl, tier1Batch, WELL_KNOWN, wellKnownProblems } from "./helpers.js";

test.describe("receiver", () => {
  test("accepts a tier-1 batch, dedups a repeat, refuses a bad token or protocol", async ({ page, request }) => {
    const { sinkToken } = (await (await request.get(INFO)).json()) as { sinkToken: string };
    const batch = tier1Batch();
    const send = (token: string, headers: Record<string, string> = {}) =>
      request.post(EVENTS, {
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
        data: { events: batch.events },
      });

    const first = await send(sinkToken, { "sessionpipe-protocol": "1" });
    expect(first.status()).toBe(202);
    const body = (await first.json()) as {
      accepted: number;
      duplicates: number;
      rejected: unknown[];
      max_tier: number;
    };
    expect(body).toEqual({ accepted: batch.events.length, duplicates: 0, rejected: [], max_tier: 3 });

    // The board shows the new session, with the title from its session block (and, with
    // Advanced → Show counts, its turns and tools as columns).
    await page.addInitScript(() => localStorage.setItem("sessionpipe-gui.board.counts", "1"));
    await openBoard(page);
    const card = page.locator(`a.card-link[href="${sessionUrl(batch.harness, batch.sessionId)}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator(".card-title")).toHaveText(batch.title);
    await expect(card.locator(".card-foot")).toContainText("1 turn");
    await expect(card.locator(".card-foot")).toContainText("1 tool");
    await expect(card.locator(".card-meta")).toContainText("e2e-box");
    await expect(card.locator(".card-meta")).toContainText("e2e/fixture @ main");
    await expect(card.locator(".card-state")).toContainText("idle");
    await expect(page.locator("section.group--idle")).toContainText(batch.title);

    const again = await send(sinkToken, { "sessionpipe-protocol": "1" });
    expect(again.status()).toBe(202);
    expect(await again.json()).toEqual({ accepted: 0, duplicates: batch.events.length, rejected: [], max_tier: 3 });

    const wrong = await send("spg_not_the_token");
    expect(wrong.status()).toBe(401);
    expect(wrong.headers()["www-authenticate"]).toBe("Bearer");
    expect(await wrong.json()).toEqual({ reason: "unauthorized" });

    const proto = await send(sinkToken, { "sessionpipe-protocol": "99" });
    expect(proto.status()).toBe(400);
    expect(await proto.json()).toEqual({ reason: "unsupported_protocol", supported: [1] });

    // Reading the session back: full events, in seq order, at tier 1.
    const detail = await request.get(`/api/ui/sessions/${batch.harness}/${batch.sessionId}`);
    expect(detail.status()).toBe(200);
    const d = (await detail.json()) as {
      total: number;
      events: { type: string; tier: number; session: { seq: number } }[];
    };
    expect(d.total).toBe(batch.events.length);
    expect(d.events.map((e) => e.session.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(d.events.map((e) => e.type)).toEqual(batch.events.map((e) => e.type));
    expect(d.events.every((e) => e.tier === 1)).toBe(true);
  });

  test("the well-known file validates against schemas/v1/well-known.json", async ({ request }) => {
    const res = await request.get(WELL_KNOWN);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^application\/json/);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(wellKnownProblems(doc)).toEqual([]);
    expect(doc).toMatchObject({
      protocol: [1],
      max_tier: 3,
      auth: ["bearer"],
      endpoints: { events: EVENTS },
      batch: { max_events: 50, max_bytes: 262144 },
    });
    expect(doc.capabilities).toEqual(expect.arrayContaining(["events", "backfill", "forget", "control"]));
    expect((doc.endpoints as Record<string, string>).control).toMatch(/^\/api\/sessionpipe\/v1\/control$/);
    // The checker itself: a few known-bad documents must be caught.
    expect(wellKnownProblems({ ...doc, max_tier: 4 })).toContain("max_tier must be an integer 0..3");
    expect(wellKnownProblems({ ...doc, batch: { max_events: 51, max_bytes: 1024 } })).toHaveLength(1);
    expect(wellKnownProblems({ ...doc, capabilities: ["Events"] })).toHaveLength(1);
    expect(wellKnownProblems({ ...doc, control: undefined })).toContain(
      "control must be an object when capabilities lists control",
    );
  });
});
