// SPDX-License-Identifier: Apache-2.0
import "../native/test-env";
import type { SessionSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import { answerItems } from "./SessionView";

/** The strip's bar as answerItems reads it: one answer row and its two buttons. */
function bar(allow: { disabled: boolean; description?: string }, deny: { disabled: boolean; description?: string }) {
  const button = (b: { disabled: boolean; description?: string }) => ({
    disabled: b.disabled,
    getAttribute: (n: string) => (n === "aria-description" ? (b.description ?? null) : null),
  });
  const row = {
    dataset: { attention: "perm-1" },
    querySelector: (sel: string) =>
      sel === ".btn--allow" ? button(allow) : sel === ".btn--deny" ? button(deny) : null,
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
  it("leaves both on when both buttons are", () => {
    const items = answerItems(bar({ disabled: false }, { disabled: false }), s) as unknown as { disabled?: unknown }[];
    expect(items.map((i) => i.disabled)).toEqual([undefined, undefined]);
  });
});
