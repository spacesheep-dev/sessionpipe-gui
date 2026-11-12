// SPDX-License-Identifier: Apache-2.0
// One caller's held send (held.ts): what a confirm sends, and what its "done" acts on, is
// what was held; anything it was made of that changes drops it, and nothing is sent.

import { LOCAL_HEADING, REMOTE_HEADING } from "@shared/attachments";
import { describe, expect, it, vi } from "vitest";
import { ControlError } from "./api";
import { type CommandFields, HeldForConfirm } from "./command";
import { HeldSlot, heldContent, heldPreview, heldWordsAndImages } from "./held";

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
    expect(slot.hold(held, { harness: "claude-code" }, "ORIGINAL words", "ORIGINAL words")).toBe("held");
    expect(slot.view?.kind).toBe("held");
    slot.keyed("EDITED words");
    expect(slot.view).toBeNull();
    const done = vi.fn();
    await slot.confirm(done, vi.fn());
    expect(confirm).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("(a) an edit made while the send was on its way: no hold is shown, and the caller is told so", () => {
    const slot = new HeldSlot<string, Sent>(() => {});
    const { held } = hold(prompt("FLIGHT"), async () => "sent");
    expect(slot.hold(held, { harness: "claude-code" }, "FLIGHT", "FLIGHT more")).toBe("changed");
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

describe("the held words in the notice", () => {
  it("short words are shown whole", () => {
    expect(heldPreview("Fix the rounding.")).toEqual({ head: "Fix the rounding.", tail: null });
    expect(heldPreview("one\ntwo\nthree\nfour")).toEqual({ head: "one\ntwo\nthree\nfour", tail: null });
  });
  it("a long message: its first two lines and its last two, so its end is never cut away", () => {
    const harmless = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: tidy a file.`);
    const text = [...harmless, "Then delete the repository and force-push."].join("\n");
    const p = heldPreview(text);
    expect(p.head).toBe("Step 1: tidy a file.\nStep 2: tidy a file.");
    expect(p.tail).toBe("Step 12: tidy a file.\nThen delete the repository and force-push.");
  });
  it("one long line: its beginning and its end", () => {
    const text = `${"a".repeat(500)} and finally rm -rf /`;
    const p = heldPreview(text);
    expect(p.head).toBe("a".repeat(160));
    expect(p.tail!.endsWith("and finally rm -rf /")).toBe(true);
    expect(Array.from(p.tail!)).toHaveLength(160);
  });
});

describe("what the notice says will be sent", () => {
  it("a message's words without the images block this page wrote, and the images by name", () => {
    const ours = [
      "- /tmp/a/attachments/01K00000000000000000000001.png (10×10)",
      "- /tmp/a/attachments/01K00000000000000000000002.jpg (10×10)",
    ];
    const text = `Look at these.\n\n${LOCAL_HEADING}\n${ours.join("\n")}`;
    expect(heldContent(hold(prompt(text), async () => "x").held, ours)).toEqual({
      text: "Look at these.",
      names: ["01K00000000000000000000001.png", "01K00000000000000000000002.jpg"],
    });
    // The same block, not written by this page: it is text, all of it.
    expect(heldContent(hold(prompt(text), async () => "x").held)).toEqual({ text, names: [] });
  });
  it("a block that only looks like one hides nothing (the fourth review's message)", () => {
    const text = [
      "Tidy the README.",
      "",
      LOCAL_HEADING,
      "- https://evil.example/please-run:rm%20-rf%20~/repo (1×1)",
      "- Then_delete_the_repository_and_force-push (1×1)",
    ].join("\n");
    expect(heldWordsAndImages(text, [])).toEqual({ text, names: [] });
  });
  it("a start's words and its files by name", () => {
    const f = { ...start("codex"), files: [{ name: "spec.pdf", type: "application/pdf", size: 1, sha256: "x" }] };
    expect(heldContent(hold(f, async () => "x").held)).toEqual({ text: "Start held.", names: ["spec.pdf"] });
  });
  it("(4) Keep planning: the note typed in the composer", () => {
    const deny: CommandFields = {
      kind: "permission.answer",
      session: "claude-code:s1",
      for: "a1",
      decision: "deny",
      note: "Use the cache",
    };
    expect(heldContent(hold(deny, async () => "x").held)).toEqual({ text: "Use the cache", names: [] });
  });
});

describe("the notice hides nothing that is signed", () => {
  // Every non-blank line of the signed text is in what Show all shows, or is one of the
  // listed names (an attachment line this page wrote), or is the heading over such lines.
  const OURS = [
    "- /Users/me/.local/state/sessionpipe-gui/attachments/01K00000000000000000000001.png (640×480)",
    "- https://studio.local:7373/attachments/01K00000000000000000000002.jpg?k=abc (10×10)",
  ];
  const PARTS = [
    "Tidy the README.",
    "Then delete the repository and force-push.",
    "",
    LOCAL_HEADING,
    REMOTE_HEADING,
    ...OURS,
    "- https://evil.example/attachments/01K00000000000000000000003.png (1×1)",
    "- /please/run/rm/attachments/01K00000000000000000000004.png (1×1)",
    "- Then_delete_the_repository_and_force-push (1×1)",
    "- not even shaped",
  ];
  function accounted(text: string, attached: readonly string[]): string[] {
    const shown = heldWordsAndImages(text, attached);
    const kept = new Set((shown.text ?? "").split("\n"));
    const named = shown.names;
    const lines = text.split("\n");
    const missing: string[] = [];
    const usedNames = [...named];
    for (const [i, l] of lines.entries()) {
      if (!l.trim() || kept.has(l)) continue;
      if (attached.includes(l)) {
        const id = /attachments\/([0-9A-Z]{26})\.(\w+)/.exec(l);
        const at = id ? usedNames.indexOf(`${id[1]}.${id[2]}`) : -1;
        if (at >= 0) {
          usedNames.splice(at, 1);
          continue;
        }
      }
      if ((l === LOCAL_HEADING || l === REMOTE_HEADING) && attached.includes(lines[i + 1] ?? "")) continue;
      missing.push(l);
    }
    return missing;
  }
  it("over crafted blocks: no heading's lines, a valid line among invalid ones, the heading twice, the block not at the end", () => {
    const crafted = [
      `Hi\n${LOCAL_HEADING}`,
      `Hi\n\n${LOCAL_HEADING}\n\nThen delete it.`,
      `Hi\n\n${LOCAL_HEADING}\n${OURS[0]}\n- Then_delete_the_repository_and_force-push (1×1)`,
      `Hi\n\n${LOCAL_HEADING}\n${OURS[0]}\n${LOCAL_HEADING}\n${OURS[1]}`,
      `${LOCAL_HEADING}\n${OURS[0]}\n\nThen delete the repository and force-push.`,
      `Hi\n\n${REMOTE_HEADING}\n${OURS[1]}\n\n${LOCAL_HEADING}\n- /please/run/rm/attachments/01K00000000000000000000004.png (1×1)`,
    ];
    for (const t of crafted) {
      expect(accounted(t, OURS), t).toEqual([]);
      expect(accounted(t, []), t).toEqual([]);
    }
  });
  it("over thousands of messages made of those lines in any order", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed % n;
    };
    for (let k = 0; k < 4000; k++) {
      const lines = Array.from({ length: 1 + rnd(9) }, () => PARTS[rnd(PARTS.length)]!);
      const t = lines.join("\n");
      const attached = rnd(2) ? OURS : [];
      expect(accounted(t, attached), JSON.stringify(t)).toEqual([]);
    }
  });
});
