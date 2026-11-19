// SPDX-License-Identifier: Apache-2.0
// The Board's one Filter menu: a section only where there is a choice (two machines, two
// agents, a label in use), none at all with one machine, one agent and no labels (then
// there is no button), "Clear filters" only while a filter is on, and a summary that names
// what the board narrows to in the order machine · agent · label.
import "../native/test-env";
import type { Labels } from "@shared/api";
import { describe, expect, it, vi } from "vitest";
import { tidy } from "./ContextMenu";
import { type BoardFilter, boardFilterItems, boardFilterSummary } from "./FilterMenu";

const noLabels: Labels = { rev: 1, names: {}, sessions: {} };
const someLabels: Labels = { rev: 1, names: { red: "Urgent" }, sessions: { "codex:a": "red" } };

const filter = (o: Partial<BoardFilter> = {}): BoardFilter => ({
  machines: ["lab-mac", "studio-mac"],
  machine: "",
  setMachine: vi.fn(),
  harnesses: ["claude-code", "codex"],
  harness: "",
  setHarness: vi.fn(),
  labels: noLabels,
  label: "",
  setLabel: vi.fn(),
  ...o,
});

/** What the menu shows, one line an item: headings as "# …", a separator as "-". */
const shown = (o: BoardFilter): string[] =>
  tidy(boardFilterItems(o)).map((i) => ("heading" in i ? `# ${i.heading}` : "sep" in i ? "-" : i.label));

describe("boardFilterItems", () => {
  it("is empty with one machine, one agent and no labels: there is nothing to narrow", () => {
    expect(shown(filter({ machines: ["lab-mac"], harnesses: ["codex"] }))).toEqual([]);
  });

  it("has Machine and Agent, each with its All, and Label only once a label is in use", () => {
    const at = shown(filter());
    expect(at).toContain("# Machine");
    expect(at).toContain("All machines");
    expect(at).toContain("# Agent");
    expect(at).toContain("All agents");
    expect(at).toContain("Codex");
    expect(at).not.toContain("Label");
    expect(at).not.toContain("Clear filters");
    expect(shown(filter({ labels: someLabels }))).toContain("Label");
  });

  it("leaves out a section with one choice, but keeps one that is set", () => {
    const one = shown(filter({ machines: ["lab-mac"] }));
    expect(one).not.toContain("# Machine");
    expect(one[0]).toBe("# Agent");
    expect(shown(filter({ machines: ["lab-mac"], machine: "lab-mac" }))).toContain("# Machine");
  });

  it("says the label set in its submenu's name, and offers Clear filters, which leaves the field alone", () => {
    const o = filter({ labels: someLabels, label: "red", machine: "lab-mac" });
    const at = shown(o);
    expect(at).toContain("Label: Urgent");
    expect(at.at(-1)).toBe("Clear filters");
    const clear = boardFilterItems(o).find((i) => !!i && "label" in i && i.label === "Clear filters");
    if (!clear || !("run" in clear)) throw new Error("no Clear filters");
    void clear.run();
    expect(o.setMachine).toHaveBeenCalledWith("");
    expect(o.setHarness).toHaveBeenCalledWith("");
    expect(o.setLabel).toHaveBeenCalledWith("");
  });
});

describe("boardFilterSummary", () => {
  it("names what the board narrows to: machine · agent · label", () => {
    expect(boardFilterSummary(filter({ labels: someLabels, label: "red", harness: "codex", machine: "lab-mac" }))).toBe(
      "lab-mac · Codex · Urgent",
    );
    expect(boardFilterSummary(filter({ label: "none" }))).toBe("No label");
    expect(boardFilterSummary(filter())).toBe("");
  });
});
