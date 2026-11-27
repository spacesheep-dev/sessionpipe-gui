// SPDX-License-Identifier: Apache-2.0
// One Filter pop-up in a page bar in place of a row of "All …" chips: a menu with a
// section per filter (Machine, Agent, then Label › as a submenu), and "Clear filters"
// while any is set. At rest it reads "Filter"; while it narrows the page it reads what it
// narrows to ("lab-mac · Codex") on the selection fill, as a chip does. The Board, the
// Feed and the Inbox use it on a computer; `boardFilterItems` is the Board's menu, for
// any other place that offers the Board's filters.
import { LABEL_COLORS, type Labels } from "@shared/api";
import { useEffect, useRef, useState } from "react";
import { harnessMark } from "../lib/format";
import { anyLabel, type LabelFilter, labelName } from "../lib/labels";
import { type MenuItem, type MenuList, openMenu, useMenuOpen } from "./ContextMenu";
import { FilterIcon } from "./Icons";

/** Radio items for one filter: "All …", then each option, the current one checked. */
export function pick(
  all: string,
  value: string,
  options: string[],
  set: (v: string) => void,
  name: (o: string) => string = (o) => o,
): MenuItem[] {
  return [
    { label: all, radio: true, checked: !value, run: () => set("") },
    ...options.map((o) => ({ label: name(o), radio: true, checked: value === o, run: () => set(o) })),
  ];
}

/** What a label filter is called in a summary: the label's name, or "No label". */
export const labelFilterName = (labels: Labels, f: LabelFilter): string =>
  !f ? "" : f === "none" ? "No label" : labelName(labels, f);

/** "All labels", the seven (each its dot and name), "No label", as radio items. */
export function labelFilterItems(labels: Labels, value: LabelFilter, set: (v: LabelFilter) => void): MenuItem[] {
  return [
    { label: "All labels", radio: true, checked: !value, run: () => set("") },
    ...LABEL_COLORS.map(
      (c): MenuItem => ({
        label: labelName(labels, c),
        swatch: c,
        radio: true,
        checked: value === c,
        run: () => set(c),
      }),
    ),
    { label: "No label", radio: true, checked: value === "none", run: () => set("none") },
  ];
}

/** The Label submenu ("Label ›", "Label: Urgent" while set), or nothing while no session
 *  has a label and none is set: a filter that could only empty the page. */
export function labelFilterSub(labels: Labels, value: LabelFilter, set: (v: LabelFilter) => void): MenuItem | null {
  if (!value && !anyLabel(labels)) return null;
  return {
    label: value ? `Label: ${labelFilterName(labels, value)}` : "Label",
    items: labelFilterItems(labels, value, set),
  };
}

/** A menu with the label filter alone (the Inbox's): its section, and no Clear, as its
 *  "All labels" already is the way out. */
export const labelFilterMenu = (labels: Labels, value: LabelFilter, set: (v: LabelFilter) => void): MenuList => [
  { heading: "Label" },
  ...labelFilterItems(labels, value, set),
];

export interface BoardFilter {
  machines: string[];
  machine: string;
  setMachine: (v: string) => void;
  harnesses: string[];
  harness: string;
  setHarness: (v: string) => void;
  labels: Labels;
  label: LabelFilter;
  setLabel: (v: LabelFilter) => void;
}

/** What the Board's filter narrows to, in the order machine · agent · label. */
export const boardFilterSummary = (o: BoardFilter): string =>
  [o.machine, o.harness && harnessMark(o.harness).label, labelFilterName(o.labels, o.label)]
    .filter(Boolean)
    .join(" · ");

/** The Board's filter menu: Machine (with two machines or more), Agent (with two agents or
 *  more), Label ›, and "Clear filters" while any of the three is set (not the text in the
 *  field, which has its own way out). Empty when there is nothing to narrow. */
export function boardFilterItems(o: BoardFilter): MenuList {
  const on = !!(o.machine || o.harness || o.label);
  const machines = o.machines.length > 1 || !!o.machine;
  const agents = o.harnesses.length > 1 || !!o.harness;
  const label = labelFilterSub(o.labels, o.label, o.setLabel);
  if (!machines && !agents && !label) return [];
  return [
    machines && { heading: "Machine" },
    ...(machines ? pick("All machines", o.machine, o.machines, o.setMachine) : []),
    { sep: true },
    agents && { heading: "Agent" },
    ...(agents ? pick("All agents", o.harness, o.harnesses, o.setHarness, (h) => harnessMark(h).label) : []),
    { sep: true },
    label,
    on && { sep: true },
    on && {
      label: "Clear filters",
      run: () => {
        o.setMachine("");
        o.setHarness("");
        o.setLabel("");
      },
    },
  ];
}

/** The Filter button. `summary` is what a set filter narrows to; `hint` its tooltip at rest. */
export function FilterMenu({
  on,
  summary,
  build,
  hint,
}: {
  on: boolean;
  summary: string;
  build: () => MenuList;
  hint: string;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const up = useMenuOpen();
  useEffect(() => {
    if (!up) setOpen(false);
  }, [up]);
  const show = (keyboard: boolean) => {
    if (!btn.current) return;
    openMenu(build(), btn.current, { source: keyboard ? "keyboard" : "mouse", invoker: btn.current, title: "Filter" });
    setOpen(true);
  };
  return (
    <button
      ref={btn}
      type="button"
      className={`filter-btn ${on ? "filter-btn--on" : ""}`}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={on ? `Filter: ${summary}` : "Filter"}
      title={on ? summary : hint}
      onClick={(e) => show(e.detail === 0)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown") return;
        e.preventDefault();
        show(true);
      }}
    >
      <FilterIcon size={14} />
      <span className="filter-btn-text">{on ? summary : "Filter"}</span>
    </button>
  );
}
