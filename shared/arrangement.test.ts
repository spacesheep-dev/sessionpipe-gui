// SPDX-License-Identifier: Apache-2.0
// The arrangement's rules: placing, following again, pinning; the refusals (an unknown
// field, a key out of the store's shape, a session under itself or its own descendant,
// sessions the store does not hold, the caps); forgetting; reading a kept file back.
import { describe, expect, it } from "vitest";
import {
  ARRANGEMENT_FOLDER_NAME_MAX,
  ARRANGEMENT_FOLDERS_MAX,
  ARRANGEMENT_PINNED_MAX,
  ARRANGEMENT_PLACED_MAX,
  type Arrangement,
  EMPTY_ARRANGEMENT,
} from "./api.js";
import {
  applyArrangement,
  cleanArrangement,
  forgetInArrangement,
  isSessionKey,
  placedLoop,
  sanitizeFolderName,
} from "./arrangement.js";

const A = "claude-code:a";
const B = "codex:b";
const C = "claude-code:c";
const all = () => true;
const reason = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    return `${(e as { status: number }).status} ${(e as Error).message}`;
  }
};

describe("applyArrangement", () => {
  it("places, brings to the top level, follows again and pins, bumping rev once a change", () => {
    let doc: Arrangement = EMPTY_ARRANGEMENT;
    doc = applyArrangement(doc, { placed: { [B]: A } }, all);
    expect(doc).toEqual({ rev: 1, placed: { [B]: A }, pinned: [] });
    doc = applyArrangement(doc, { placed: { [C]: null } }, all);
    expect(doc.placed).toEqual({ [B]: A, [C]: null });
    doc = applyArrangement(doc, { follow: [B], pinned: [C, A] }, all);
    expect(doc).toEqual({ rev: 3, placed: { [C]: null }, pinned: [C, A] });
    // Nothing changed: the same object, the same rev.
    expect(applyArrangement(doc, { placed: { [C]: null }, pinned: [C, A], follow: [B] }, all)).toBe(doc);
    // Following a session with no placement is fine.
    expect(applyArrangement(doc, { follow: ["codex:never"] }, all)).toBe(doc);
  });

  it("refuses an unknown field, the wrong kinds and keys out of the store's shape", () => {
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { placed: {}, extra: 1 }, all))).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, [], all))).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, null, all))).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { placed: [] }, all))).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { placed: { [B]: 3 } }, all))).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { placed: { nope: A } }, all))).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, JSON.parse(`{"placed":{"__proto__":"${A}"}}`), all))).toBe(
      "400 malformed",
    );
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { follow: "x" }, all))).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { pinned: [A, A] }, all))).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { pinned: ["Claude:a"] }, all))).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { placed: { [B]: A }, follow: [B] }, all))).toBe(
      "400 malformed",
    );
    expect(isSessionKey("claude-code:0a1b-2c.3:x")).toBe(true);
    expect(isSessionKey(`claude-code:${"x".repeat(129)}`)).toBe(false);
    expect(isSessionKey("claude code:a")).toBe(false);
  });

  it("refuses a session under itself or its own descendant, changing nothing", () => {
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { placed: { [A]: A } }, all))).toBe("400 bad_place");
    const chain = applyArrangement(EMPTY_ARRANGEMENT, { placed: { [B]: A, [C]: B } }, all);
    expect(reason(() => applyArrangement(chain, { placed: { [A]: C } }, all))).toBe("400 bad_place");
    expect(reason(() => applyArrangement(chain, { placed: { [A]: B } }, all))).toBe("400 bad_place");
    // Moving the chain's top under a session outside it is fine.
    expect(applyArrangement(chain, { placed: { [A]: "gemini-cli:d" } }, all).placed[A]).toBe("gemini-cli:d");
    expect(placedLoop({ [A]: B, [B]: A }, A)).toBe(true);
    expect(placedLoop({ [A]: B, [B]: null }, A)).toBe(false);
  });

  it("refuses sessions the store does not hold, but keeps a pin it has since forgotten", () => {
    const known = (k: string) => k !== "codex:gone";
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { placed: { "codex:gone": A } }, known))).toBe(
      "404 not_found",
    );
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { placed: { [A]: "codex:gone" } }, known))).toBe(
      "404 not_found",
    );
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { pinned: ["codex:gone"] }, known))).toBe("404 not_found");
    const had: Arrangement = { rev: 4, placed: {}, pinned: ["codex:gone"] };
    expect(applyArrangement(had, { pinned: [A, "codex:gone"] }, known).pinned).toEqual([A, "codex:gone"]);
  });

  it("holds to the caps: 500 placements, 100 pins", () => {
    const many = Object.fromEntries(
      Array.from({ length: ARRANGEMENT_PLACED_MAX }, (_, i) => [`codex:p${i}`, A] as const),
    );
    const full = applyArrangement(EMPTY_ARRANGEMENT, { placed: many }, all);
    expect(Object.keys(full.placed)).toHaveLength(ARRANGEMENT_PLACED_MAX);
    expect(reason(() => applyArrangement(full, { placed: { "codex:one-more": A } }, all))).toBe("413 too_many");
    // A change that keeps the count is fine.
    expect(reason(() => applyArrangement(full, { placed: { "codex:p0": null } }, all))).toBe("ok");
    const pins = Array.from({ length: ARRANGEMENT_PINNED_MAX + 1 }, (_, i) => `codex:pin${i}`);
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { pinned: pins.slice(0, -1) }, all))).toBe("ok");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { pinned: pins }, all))).toBe("413 too_many");
  });
});

describe("forgetInArrangement", () => {
  it("drops the session's own placement and pin; a placement under it stays, inert", () => {
    const doc: Arrangement = { rev: 2, placed: { [B]: A, [A]: null }, pinned: [A, C] };
    expect(forgetInArrangement(doc, A)).toEqual({ rev: 3, placed: { [B]: A }, pinned: [C] });
    expect(forgetInArrangement(doc, "codex:other")).toBe(doc);
  });
});

describe("cleanArrangement", () => {
  it("keeps what holds to the rules and drops the rest, entry by entry", () => {
    expect(cleanArrangement(undefined)).toEqual({ rev: 0, placed: {}, pinned: [] });
    expect(
      cleanArrangement({
        rev: 7,
        placed: { [B]: A, [A]: A, bad: A, [C]: 4, "gemini-cli:x": "gemini-cli:y", "gemini-cli:y": "gemini-cli:x" },
        pinned: [A, A, "bad", B],
      }),
    ).toEqual({ rev: 7, placed: { [B]: A, "gemini-cli:x": "gemini-cli:y" }, pinned: [A, B] });
  });

  it("sanitizes custom folders and prunes orphan or corrupt inFolder entries", () => {
    const cleaned = cleanArrangement({
      rev: 3,
      placed: {},
      pinned: [],
      folders: [
        { id: "work", name: "  Work\u202e\u0007  ", color: "blue" },
        { id: "work", name: "Duplicate" },
        { id: "BAD ID", name: "Nope" },
        { id: "empty_name", name: "\u0000\u202a   " },
        { id: "bad_color", name: "Ok", color: "neon" },
        "not-an-object",
      ],
      inFolder: {
        [A]: "work",
        [B]: "orphan",
        [C]: "bad_color",
        "bad key": "work",
      },
    });
    expect(cleaned).toEqual({
      rev: 3,
      placed: {},
      pinned: [],
      folders: [
        { id: "work", name: "Work", color: "blue" },
        { id: "bad_color", name: "Ok" },
      ],
      inFolder: {
        [A]: "work",
        [C]: "bad_color",
      },
    });
  });
});

describe("custom folders and inFolder", () => {
  it("creates, renames, recolors, reorders, assigns, removes, and deletes folders atomically", () => {
    let doc: Arrangement = EMPTY_ARRANGEMENT;
    doc = applyArrangement(
      doc,
      { folders: [{ id: "f_work", name: "  Work  ", color: "blue" }], inFolder: { [A]: "f_work" } },
      all,
    );
    expect(doc).toEqual({
      rev: 1,
      placed: {},
      pinned: [],
      folders: [{ id: "f_work", name: "Work", color: "blue" }],
      inFolder: { [A]: "f_work" },
    });
    // No-op patch returns exact same object.
    expect(
      applyArrangement(
        doc,
        { folders: [{ id: "f_work", name: "Work", color: "blue" }], inFolder: { [A]: "f_work" } },
        all,
      ),
    ).toBe(doc);
    // Remove from folder via null.
    doc = applyArrangement(doc, { inFolder: { [A]: null } }, all);
    expect(doc.inFolder).toBeUndefined();
    // Re-assign and delete folder: prunes inFolder automatically with zero orphans.
    doc = applyArrangement(doc, { inFolder: { [A]: "f_work", [B]: "f_work" } }, all);
    doc = applyArrangement(doc, { folders: [] }, all);
    expect(doc).toEqual({ rev: 4, placed: {}, pinned: [] });
  });

  it("refuses malformed folders, control/bidi-only names, bad colors, unknown fields, duplicates, and bad_folder", () => {
    expect(sanitizeFolderName("  hi\u0000\u001f\u007f\u202a\u202e\u2066\u2069  ")).toBe("hi");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { folders: "nope" }, all))).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { folders: [null] }, all))).toBe("400 malformed");
    expect(
      reason(() => applyArrangement(EMPTY_ARRANGEMENT, { folders: [{ id: "f1", name: "Ok", extra: 1 }] }, all)),
    ).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { folders: [{ id: "BadId", name: "Ok" }] }, all))).toBe(
      "400 malformed",
    );
    expect(
      reason(() =>
        applyArrangement(
          EMPTY_ARRANGEMENT,
          {
            folders: [
              { id: "dup", name: "One" },
              { id: "dup", name: "Two" },
            ],
          },
          all,
        ),
      ),
    ).toBe("400 malformed");
    expect(
      reason(() => applyArrangement(EMPTY_ARRANGEMENT, { folders: [{ id: "f1", name: "   \u202e\u0007  " }] }, all)),
    ).toBe("400 malformed");
    expect(
      reason(() =>
        applyArrangement(
          EMPTY_ARRANGEMENT,
          { folders: [{ id: "f1", name: "a".repeat(ARRANGEMENT_FOLDER_NAME_MAX + 1) }] },
          all,
        ),
      ),
    ).toBe("400 malformed");
    expect(
      reason(() =>
        applyArrangement(EMPTY_ARRANGEMENT, { folders: [{ id: "f1", name: "Ok", color: "magenta" as never }] }, all),
      ),
    ).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { inFolder: [] }, all))).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { inFolder: { bad: "f1" } }, all))).toBe("400 malformed");
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { inFolder: { [A]: 123 as never } }, all))).toBe(
      "400 malformed",
    );
    expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { inFolder: { [A]: "missing" } }, all))).toBe(
      "400 bad_folder",
    );
    const withFolder = applyArrangement(EMPTY_ARRANGEMENT, { folders: [{ id: "f1", name: "Work" }] }, all);
    expect(
      reason(() => applyArrangement(withFolder, { inFolder: { "codex:gone": "f1" } }, (k) => k !== "codex:gone")),
    ).toBe("404 not_found");
  });

  it("enforces caps on folders (50) and inFolder entries (500)", () => {
    const fifty = Array.from({ length: ARRANGEMENT_FOLDERS_MAX }, (_, i) => ({ id: `f_${i}`, name: `Folder ${i}` }));
    const doc = applyArrangement(EMPTY_ARRANGEMENT, { folders: fifty }, all);
    expect(doc.folders).toHaveLength(ARRANGEMENT_FOLDERS_MAX);
    expect(
      reason(() =>
        applyArrangement(EMPTY_ARRANGEMENT, { folders: [...fifty, { id: "f_over", name: "Too many" }] }, all),
      ),
    ).toBe("413 too_many");
    const manyIn = Object.fromEntries(Array.from({ length: ARRANGEMENT_PLACED_MAX }, (_, i) => [`codex:s${i}`, "f_0"]));
    const full = applyArrangement(doc, { inFolder: manyIn }, all);
    expect(Object.keys(full.inFolder ?? {})).toHaveLength(ARRANGEMENT_PLACED_MAX);
    expect(reason(() => applyArrangement(full, { inFolder: { "codex:one-more": "f_0" } }, all))).toBe("413 too_many");
  });

  it("rejects invisible/zero-width-only folder names while preserving ZWJ emoji", () => {
    for (const invisible of [
      "\u200b",
      "\u200d",
      "\u200e",
      "\u200f",
      "\u00ad",
      "\ufeff",
      "\u0085",
      "\u2028",
      "\u061c",
    ]) {
      expect(sanitizeFolderName(invisible)).toBe("");
      expect(reason(() => applyArrangement(EMPTY_ARRANGEMENT, { folders: [{ id: "f1", name: invisible }] }, all))).toBe(
        "400 malformed",
      );
    }
    expect(sanitizeFolderName("  🧑‍💻 Dev\u200b\u00ad  ")).toBe("🧑‍💻 Dev");
    const ok = applyArrangement(EMPTY_ARRANGEMENT, { folders: [{ id: "f1", name: "🧑‍💻 Dev" }] }, all);
    expect(ok.folders).toEqual([{ id: "f1", name: "🧑‍💻 Dev" }]);
  });

  it("prunes conflicting inFolder when a session is pinned or nested in both cleanArrangement and applyArrangement", () => {
    const cleaned = cleanArrangement({
      rev: 4,
      placed: { [B]: A, [C]: null },
      pinned: [A],
      folders: [{ id: "f1", name: "Work" }],
      inFolder: { [A]: "f1", [B]: "f1", [C]: "f1" },
    });
    // A is pinned, B is nested under A -> both pruned; C is explicitly root (placed[C] = null) -> kept.
    expect(cleaned.inFolder).toEqual({ [C]: "f1" });

    // Direct PATCH: pinning or nesting a foldered session drops its inFolder membership.
    let doc = applyArrangement(
      EMPTY_ARRANGEMENT,
      { folders: [{ id: "f1", name: "Work" }], inFolder: { [A]: "f1", [B]: "f1" } },
      all,
    );
    doc = applyArrangement(doc, { pinned: [A] }, all);
    expect(doc.inFolder).toEqual({ [B]: "f1" });
    doc = applyArrangement(doc, { placed: { [B]: C } }, all);
    expect(doc.inFolder).toBeUndefined();

    // Direct PATCH trying to set inFolder on an already-pinned session produces no conflict and no rev bump.
    const same = applyArrangement(doc, { inFolder: { [A]: "f1" } }, all);
    expect(same).toBe(doc);
    expect(same.inFolder).toBeUndefined();
  });

  it("forgetInArrangement drops inFolder membership too while keeping folders", () => {
    const doc: Arrangement = {
      rev: 5,
      placed: {},
      pinned: [],
      folders: [{ id: "f1", name: "Work" }],
      inFolder: { [A]: "f1", [B]: "f1" },
    };
    const next = forgetInArrangement(doc, A);
    expect(next).toEqual({
      rev: 6,
      placed: {},
      pinned: [],
      folders: [{ id: "f1", name: "Work" }],
      inFolder: { [B]: "f1" },
    });
  });
});
