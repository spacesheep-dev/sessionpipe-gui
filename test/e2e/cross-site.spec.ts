// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// The router's guard (server/http/guard.ts) met by a real browser. The test server answers
// on http://127.0.0.1:<port> and on http://localhost:<port>: to a browser those are two
// sites, so a page on the one is a page of another origin to the other, and what it sends
// is what any page on the web would send. What the board's own page sends goes through.
import { expect, test } from "@playwright/test";
import { E2E_PORT } from "../../playwright.config.js";

const BOARD = `http://127.0.0.1:${E2E_PORT}`;
const ELSEWHERE = `http://localhost:${E2E_PORT}`;
const PROBE = `${BOARD}/api/ui/phone/trust-check`;
const ATTACHMENTS = `${BOARD}/api/ui/attachments`;
const FILES = `${BOARD}/api/ui/control/files?name=notes.txt`;
/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";

test.describe("a page of another origin", () => {
  test("its requests are refused: a no-cors fetch, a form, a read; the board's own go through", async ({ page }) => {
    await page.goto(`${ELSEWHERE}/`);
    // fetch in no-cors mode with a text/plain body: no preflight, and the page never sees the answer.
    const [fetched] = await Promise.all([
      page.waitForResponse(PROBE),
      page.evaluate((u) => fetch(u, { method: "POST", mode: "no-cors", body: "{}" }).then((r) => r.type), PROBE),
    ]);
    expect(fetched.status()).toBe(403);
    // A read is refused at the server too; in the page it was already unreadable, since no
    // route sends a CORS header.
    const info = `${BOARD}/api/ui/info`;
    const [read] = await Promise.all([
      page.waitForResponse(info),
      page.evaluate((u) => fetch(u, { mode: "no-cors" }).then((r) => r.type), info),
    ]);
    expect(read.status()).toBe(403);
    expect(await read.headerValue("access-control-allow-origin")).toBeNull();
    const readable = await page.evaluate(
      (u) =>
        fetch(u).then(
          () => "read",
          () => "blocked",
        ),
      info,
    );
    expect(readable).toBe("blocked");
    // A form, which is a navigation: the answer is the refusal.
    await page.setContent(
      `<form id="f" method="post" enctype="text/plain" action="${PROBE}"><input name="a" value="b"></form>`,
    );
    const [posted] = await Promise.all([
      page.waitForResponse(PROBE),
      page.evaluate(() => (document.getElementById("f") as HTMLFormElement).submit()),
    ]);
    expect(posted.status()).toBe(403);
    expect(await posted.json()).toMatchObject({ reason: "cross_site" });
    // The board's own page asks the same route and is answered.
    await page.goto(`${BOARD}/`);
    const own = await page.evaluate(
      (u) => fetch(u, { method: "POST" }).then(async (r) => ({ status: r.status, body: await r.json() })),
      PROBE,
    );
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ https: false });
  });

  test("it uploads nothing and deletes nothing; the board's own page does both", async ({ page }) => {
    // The board's own page keeps an image.
    await page.goto(`${BOARD}/`);
    const kept = await page.evaluate(
      async ([u, b64]) => {
        const bytes = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0));
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: "image/png" }), "a.png");
        const r = await fetch(u as string, { method: "POST", body: form });
        return { status: r.status, body: (await r.json()) as { id: string } };
      },
      [ATTACHMENTS, PNG],
    );
    expect(kept.status).toBe(201);
    const image = `${BOARD}/attachments/${kept.body.id}.png`;

    await page.goto(`${ELSEWHERE}/`);
    // A file for a start, as text/plain: a request a browser sends with no preflight.
    const [file] = await Promise.all([
      page.waitForResponse(FILES),
      page.evaluate(
        (u) =>
          fetch(u, { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: "notes" }).then(
            (r) => r.type,
          ),
        FILES,
      ),
    ]);
    expect(file.status()).toBe(403);
    // An image as a form's one part: again no preflight.
    const [upload] = await Promise.all([
      page.waitForResponse(ATTACHMENTS),
      page.evaluate(
        async ([u, b64]) => {
          const bytes = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0));
          const form = new FormData();
          form.append("file", new Blob([bytes], { type: "image/png" }), "a.png");
          return fetch(u as string, { method: "POST", mode: "no-cors", body: form }).then((r) => r.type);
        },
        [ATTACHMENTS, PNG],
      ),
    ]);
    expect(upload.status()).toBe(403);
    // A delete asks first (a preflight), which is refused, so the delete is never sent.
    const deleted = await page.evaluate(
      (u) =>
        fetch(u, { method: "DELETE" }).then(
          (r) => `answered ${r.status}`,
          () => "blocked",
        ),
      image,
    );
    expect(deleted).toBe("blocked");
    // Nor is the image shown there.
    const shown = await page.evaluate(
      (u) =>
        new Promise<string>((done) => {
          const img = new Image();
          img.onload = () => done("shown");
          img.onerror = () => done("not shown");
          img.src = u;
        }),
      image,
    );
    expect(shown).toBe("not shown");

    // Back on the board: the image is still there, and the board's own page removes it.
    await page.goto(`${BOARD}/`);
    const own = await page.evaluate(async (u) => {
      const got = await fetch(u);
      const gone = await fetch(u, { method: "DELETE" });
      return { got: got.status, type: got.headers.get("content-type"), gone: gone.status };
    }, image);
    expect(own).toEqual({ got: 200, type: "image/png", gone: 204 });
  });

  test("it may link to the board, and may not frame it", async ({ page }) => {
    await page.goto(`${ELSEWHERE}/`);
    // The frame's load is part of setContent, so the answer is waited for from before it.
    const [framed] = await Promise.all([
      page.waitForResponse((r) => r.url() === `${BOARD}/` && r.frame() !== page.mainFrame()),
      page.setContent(`<a id="go" href="${BOARD}/sessions">the board</a><iframe id="fr" src="${BOARD}/"></iframe>`),
    ]);
    expect(framed.status()).toBe(403);
    const [linked] = await Promise.all([
      page.waitForResponse((r) => r.url() === `${BOARD}/sessions` && r.frame() === page.mainFrame()),
      page.click("#go"),
    ]);
    expect(linked.status()).toBe(200);
    expect(await linked.headerValue("content-security-policy")).toBe("frame-ancestors 'self'");
  });
});
