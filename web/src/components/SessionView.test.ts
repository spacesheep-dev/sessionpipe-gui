// SPDX-License-Identifier: Apache-2.0
import "../native/test-env";
import type { SessionSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import { answerItems } from "./SessionView";

type Side = { disabled: boolean; description?: string };

/** The strip's bar as answerItems reads it: one answer row, its card line (`note`) and its
 *  two buttons, each described by the line where there is one and by its own reason. */
function bar(allow: Side, deny: Side, note?: string, attention = "perm-1") {
  const texts: Record<string, string> = {};
  if (note) texts.note = note;
  const doc = { getElementById: (id: string) => (id in texts ? { textContent: texts[id] } : null) };
  const button = (b: Side, side: string) => {
    if (b.description) texts[side] = b.description;
    const ids = [note ? "note" : null, b.description ? side : null].filter(Boolean).join(" ");
    return {
      disabled: b.disabled,
      ownerDocument: doc,
      getAttribute: (n: string) => (n === "aria-describedby" ? ids || null : null),
    };
  };
  const buttons = { allow: button(allow, "allow"), deny: button(deny, "deny") };
  const row = {
    dataset: { attention },
    querySelector: (sel: string) =>
      sel === ".btn--allow"
        ? buttons.allow
        : sel === ".btn--deny"
          ? buttons.deny
          : sel === ".ctl-answer-note" && note
            ? { id: "note", textContent: note }
            : null,
  };
  return { querySelectorAll: () => [row] } as unknown as HTMLElement;
}

const s = { openAttentions: [{ attentionId: "perm-1", kind: "permission", tool: "ExitPlanMode" }] } as SessionSummary;

describe("answerItems", () => {
  it("says why Keep planning is off when the strip's own button is", () => {
    const root = bar({ disabled: false }, { disabled: true, description: "Keep it under 2,000 characters" });
    const [approve, keep] = answerItems(root, s) as unknown as { label: string; disabled?: string | boolean }[];
    expect(approve).toMatchObject({ label: "Approve plan", disabled: undefined });
    expect(keep).toMatchObject({ label: "Keep planning", disabled: "Keep it under 2,000 characters" });
  });
  it("says why Approve plan is off while the composer holds a note, and leaves Keep planning on", () => {
    const why = "Send the note with Keep planning, or clear it";
    const root = bar({ disabled: true, description: why }, { disabled: false });
    const [approve, keep] = answerItems(root, s) as unknown as { label: string; disabled?: string | boolean }[];
    expect(approve).toMatchObject({ label: "Approve plan", disabled: why });
    expect(keep).toMatchObject({ label: "Keep planning", disabled: undefined });
  });
  it("says the card's line for both when only that describes them", () => {
    const line = "This iPhone can send from 5:30 PM";
    const root = bar({ disabled: true }, { disabled: true }, line);
    const items = answerItems(root, s) as unknown as { disabled?: unknown }[];
    expect(items.map((i) => i.disabled)).toEqual([line, line]);
  });
  it("offers the first prompt that still has its pair: one with its answer out has none", () => {
    const out = { dataset: { attention: "perm-1" }, querySelector: () => null };
    const [open] = bar({ disabled: false }, { disabled: false }, undefined, "perm-2").querySelectorAll("*");
    const root = { querySelectorAll: () => [out, open] } as unknown as HTMLElement;
    const two = {
      openAttentions: [
        { attentionId: "perm-1", kind: "permission", tool: "Bash" },
        { attentionId: "perm-2", kind: "permission", tool: "Edit" },
      ],
    } as SessionSummary;
    const items = answerItems(root, two) as unknown as { label: string; disabled?: unknown }[];
    expect(items.map((i) => [i.label, i.disabled])).toEqual([
      ["Allow Edit", undefined],
      ["Deny Edit", undefined],
    ]);
  });
  it("leaves both on when both buttons are", () => {
    const items = answerItems(bar({ disabled: false }, { disabled: false }), s) as unknown as { disabled?: unknown }[];
    expect(items.map((i) => i.disabled)).toEqual([undefined, undefined]);
  });
});
