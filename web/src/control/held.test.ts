// SPDX-License-Identifier: Apache-2.0
// One caller's held send (held.ts): what a confirm sends, and what its "done" acts on, is
// what was held; anything it was made of that changes drops it, and nothing is sent.
import { describe, expect, it, vi } from "vitest";
import { ControlError } from "./api";
import { type CommandFields, HeldForConfirm } from "./command";
import { HeldSlot } from "./held";

interface Sent {
  where?: string;
  harness: string;
}

/** A hold as signAndDeliver throws one; `confirm` answers as `answer` says. */
function hold(fields: CommandFields, answer: () => Promise<string>, from: string | null = "spacesheep.dev") {
  const e = new ControlError(422, "Confirm with your passkey to send this: x.", "confirm_required", "x");
  const confirm = vi.fn(answer);
  return { held: new HeldForConfirm<string>(e, "x", fields, "m_1", from, confirm), confirm };
}
const prompt = (text: string): CommandFields => ({ kind: "prompt", session: "claude-code:s1", text });
const start = (harness: string): CommandFields => ({
  kind: "start",
  session: `${harness}:9d1c0b54-3f7a-4d2b-8a51-0c6e2f4b7a19`,
  text: "Start held.",
  cwd: "/Users/e2e/code",
});

describe("a held send", () => {
  it("(a) the composer edited after the hold: the hold goes, nothing is confirmed, nothing sent", async () => {
    const changed = vi.fn();
    const slot = new HeldSlot<string, Sent>(changed);
    const { held, confirm } = hold(prompt("ORIGINAL words"), async () => "sent");
    expect(slot.hold(held, { harness: "claude-code" }, "ORIGINAL words", "ORIGINAL words")).toBe(true);
    expect(slot.view?.kind).toBe("held");
    slot.keyed("EDITED words");
    expect(slot.view).toBeNull();
    const done = vi.fn();
    await slot.confirm(done, vi.fn());
    expect(confirm).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("(a) an edit made while the send was on its way drops the hold the moment it lands", () => {
    const slot = new HeldSlot<string, Sent>(() => {});
    const { held } = hold(prompt("ORIGINAL words"), async () => "sent");
    expect(slot.hold(held, { harness: "claude-code" }, "ORIGINAL words", "ORIGINAL wor")).toBe(true);
    expect(slot.view).toBeNull();
  });

  it("(b, c, d) a sheet's row changed after the hold: gone; the same key again keeps it", () => {
    const slot = new HeldSlot<string, Sent>(() => {});
    const { held } = hold(start("claude-code"), async () => "sent");
    const key = JSON.stringify(["studio", "claude-code", "/Users/e2e/code"]);
    slot.hold(held, { harness: "claude-code" }, key, key);
    slot.keyed(key);
    expect(slot.view?.kind).toBe("held");
    slot.keyed(JSON.stringify(["studio", "codex", "/Users/e2e/code"]));
    expect(slot.view).toBeNull();
  });

  it("(b) done gets the held fields and what was kept at the press, never the form as it is now", async () => {
    const slot = new HeldSlot<string, Sent>(() => {});
    const { held, confirm } = hold(start("claude-code"), async () => "sent");
    slot.hold(held, { harness: "claude-code", where: "studio · ~/code" }, "k", "k");
    const done = vi.fn();
    await slot.confirm(done, vi.fn());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith("sent", held, { harness: "claude-code", where: "studio · ~/code" });
    expect(done.mock.calls[0]![1].fields).toEqual(start("claude-code"));
    expect(slot.view).toBeNull();
  });

  it("an edit during the confirm does not drop it: that send is the held one", async () => {
    let finish: (v: string) => void = () => {};
    const slot = new HeldSlot<string, Sent>(() => {});
    const { held } = hold(prompt("words"), () => new Promise((r) => (finish = r)));
    slot.hold(held, { harness: "claude-code" }, "k", "k");
    const done = vi.fn();
    const going = slot.confirm(done, vi.fn());
    expect(slot.view).toMatchObject({ kind: "held", busy: true });
    slot.keyed("other");
    slot.drop();
    expect(slot.view).toMatchObject({ kind: "held", busy: true });
    finish("sent");
    await going;
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a hold that depends on nothing that can change (an answer, a Stop) stays", () => {
    const slot = new HeldSlot<string, Sent>(() => {});
    const { held } = hold({ kind: "cancel", session: "claude-code:s1" }, async () => "sent");
    slot.hold(held, { harness: "claude-code" }, undefined, "anything");
    slot.keyed("something else");
    expect(slot.view?.kind).toBe("held");
  });

  it("a confirm held again is still held, with the receiver's reason cleaned; another refusal is the caller's", async () => {
    const slot = new HeldSlot<string, Sent>(() => {});
    const again = new ControlError(422, "held", "confirm_required", "still   unsure\nabout it");
    const { held } = hold(prompt("words"), () => Promise.reject(again));
    slot.hold(held, { harness: "claude-code" }, "k", "k");
    const failed = vi.fn();
    await slot.confirm(vi.fn(), failed);
    expect(failed).not.toHaveBeenCalled();
    expect(slot.view).toMatchObject({ kind: "still", why: "still unsure about it" });
    // Still held goes with an edit too, and with its one button.
    slot.keyed("edited");
    expect(slot.view).toBeNull();

    const refused = new ControlError(422, "the signature did not verify", "bad_assertion");
    const other = hold(prompt("words"), () => Promise.reject(refused));
    slot.hold(other.held, { harness: "claude-code" }, "k", "k");
    await slot.confirm(vi.fn(), failed);
    expect(failed).toHaveBeenCalledWith(refused, { harness: "claude-code" });
    expect(slot.view).toBeNull();
  });

  it("anything that is not a hold is not caught", () => {
    const slot = new HeldSlot<string, Sent>(() => {});
    expect(slot.hold(new ControlError(422, "no", "untrusted_key"), { harness: "x" }, "k", "k")).toBe(false);
    expect(slot.view).toBeNull();
  });
});
