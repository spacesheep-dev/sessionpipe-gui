// SPDX-License-Identifier: Apache-2.0
// Searchable Move to folder… picker helper (components/MoveFolder.tsx): fuzzy filtering,
// current marker, Remove from folder, inline Create option, exact duplicate suppression,
// and folder cap enforcement.
import "../native/test-env";
import { ARRANGEMENT_FOLDERS_MAX, type ArrangementFolder } from "@shared/api";
import { describe, expect, it } from "vitest";
import { folderPickerChoices } from "./MoveFolder";

const folders: ArrangementFolder[] = [
  { id: "f_work", name: "Work", color: "blue" },
  { id: "f_ideas", name: "Ideas" },
];

describe("folderPickerChoices", () => {
  it("lists all folders with current flag and Remove from folder when in a folder", () => {
    const out = folderPickerChoices(folders, "f_work", "");
    expect(out).toEqual([
      { kind: "folder", folder: folders[0], current: true },
      { kind: "folder", folder: folders[1], current: false },
      { kind: "remove" },
    ]);
  });

  it("filters by query and offers inline Create when no exact match exists", () => {
    const out = folderPickerChoices(folders, undefined, "Sprint");
    expect(out).toEqual([{ kind: "create", name: "Sprint" }]);

    // Exact match (case-insensitive) suppresses Create.
    const exact = folderPickerChoices(folders, undefined, "work");
    expect(exact).toEqual([{ kind: "folder", folder: folders[0], current: false }]);
  });

  it("omits inline Create once at ARRANGEMENT_FOLDERS_MAX", () => {
    const full = Array.from({ length: ARRANGEMENT_FOLDERS_MAX }, (_, i) => ({ id: `f_${i}`, name: `F${i}` }));
    expect(folderPickerChoices(full, undefined, "Brand new")).toEqual([]);
  });
});
