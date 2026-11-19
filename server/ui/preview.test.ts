// SPDX-License-Identifier: Apache-2.0
// A list page's preview: tool input and output cut to what the page asked for, the turn's
// own words as the index holds them (whole up to 2 KB), and a running reply by its end.
import { describe, expect, it } from "vitest";
import { Session } from "../../test/events.js";
import { PREVIEW_CHARS, slimEvent, trimPreview } from "../store/slim.js";
import { cutPreview } from "./preview.js";

const s = new Session("preview");
/** An event as the index holds it. */
const slim = (type: string, data: Record<string, unknown>) => {
  const e = s.ev(type, data);
  return slimEvent({ ...e, arrivedAt: e.time, source: "http" });
};
/** A string of `n` characters whose start and end can be told apart. */
const text = (n: number, tag: string) => `${tag}-start ${"x".repeat(Math.max(0, n - 2 * tag.length - 12))} ${tag}-end`;

describe("cutPreview", () => {
  it("keeps a 1,500-character prompt and reply whole and still cuts tool output to the page's 400", () => {
    const turn = cutPreview(slim("turn.transcript", { user: text(1500, "u"), assistant: text(1500, "a") }), 400);
    expect(turn.data.user).toBe(text(1500, "u"));
    expect(turn.data.assistant).toBe(text(1500, "a"));
    expect(turn.preview).toBeUndefined();
    const input = { command: text(900, "i") };
    const tool = cutPreview(slim("tool.ended", { input, output: text(1500, "o") }), 400);
    expect(tool.data.output).toBe(text(1500, "o").slice(0, 400));
    expect((tool.data.input as string).length).toBe(400);
    expect(tool.preview).toEqual({ input: JSON.stringify(input).length, output: 1500 });
  });

  it("cuts a 3,000-character prompt at the index's 2,048 and says how long it was", () => {
    const e = cutPreview(slim("turn.transcript", { user: text(3000, "u"), assistant: "Done." }), 400);
    expect(e.data.user).toBe(text(3000, "u").slice(0, PREVIEW_CHARS));
    expect(e.data.assistant).toBe("Done.");
    expect(e.preview).toEqual({ user: 3000 });
  });

  it("keeps the end of a running reply, in the index and when cut shorter", () => {
    const long = text(5000, "p");
    const running = slim("turn.progress", { user: "Go.", assistant: long });
    expect(running.data.assistant).toBe(long.slice(-PREVIEW_CHARS));
    // An old event's shorter cut (store/core.ts) keeps the end too, and the first length.
    const old = trimPreview(running, 280);
    expect(old.data.assistant).toBe(long.slice(-280));
    expect(String(old.data.assistant).endsWith("p-end")).toBe(true);
    expect(old.preview).toEqual({ assistant: 5000 });
    // A finished turn's reply keeps its start.
    const done = trimPreview(slim("turn.transcript", { assistant: long }), 280);
    expect(String(done.data.assistant).startsWith("p-start")).toBe(true);
  });
});
