// SPDX-License-Identifier: Apache-2.0
// Labels in the page: the `label:` search token (a colour or a name, `none`, `-label:`)
// and the toolbar chip's filter.
import type { Labels } from "@shared/api";
import { describe, expect, it } from "vitest";
import { anyLabel, labelFromQuery, labelPasses, labelQuery } from "./labels";

const labels: Labels = {
  rev: 3,
  names: { red: "Urgent", blue: "Needs review" },
  sessions: { "claude-code:a": "red", "codex:b": "blue", "claude-code:c": "grey" },
};
const keys = ["claude-code:a", "codex:b", "claude-code:c", "claude-code:d"];
const kept = (q: string) => keys.filter(labelQuery(labels, q).test);

describe("labelQuery", () => {
  it("keeps a label by its colour or its name, case-insensitive", () => {
    expect(kept("label:red")).toEqual(["claude-code:a"]);
    expect(kept("label:URGENT")).toEqual(["claude-code:a"]);
    expect(kept("label:needs_review")).toEqual(["codex:b"]);
  });

  it("reads none and the exclusion", () => {
    expect(kept("label:none")).toEqual(["claude-code:d"]);
    expect(kept("-label:grey")).toEqual(["claude-code:a", "codex:b", "claude-code:d"]);
    expect(kept("-label:none")).toEqual(["claude-code:a", "codex:b", "claude-code:c"]);
  });

  it("leaves the free text for the page and ignores a token still being typed", () => {
    const q = labelQuery(labels, "billing label:red retry");
    expect(q.rest).toBe("billing retry");
    expect(labelQuery(labels, "billing label:").test("claude-code:d")).toBe(true);
    expect(labelQuery(labels, "billing label:").rest).toBe("billing");
  });

  it("keeps nothing for a label that does not exist", () => {
    expect(kept("label:mauve")).toEqual([]);
  });
});

describe("the chip", () => {
  it("passes everything, one colour, or the unlabelled", () => {
    expect(keys.filter((k) => labelPasses(labels, k, ""))).toEqual(keys);
    expect(keys.filter((k) => labelPasses(labels, k, "blue"))).toEqual(["codex:b"]);
    expect(keys.filter((k) => labelPasses(labels, k, "none"))).toEqual(["claude-code:d"]);
  });

  it("shows once any session has a label", () => {
    expect(anyLabel(labels)).toBe(true);
    expect(anyLabel({ rev: 0, names: {}, sessions: {} })).toBe(false);
  });

  it("finds a colour from its own name or the person's", () => {
    expect(labelFromQuery(labels, "Red")).toBe("red");
    expect(labelFromQuery(labels, "urgent")).toBe("red");
    expect(labelFromQuery(labels, "")).toBeUndefined();
  });
});
