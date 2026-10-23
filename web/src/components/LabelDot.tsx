// SPDX-License-Identifier: Apache-2.0
// A session's colour label as the one small dot every surface draws beside the status
// glyph (ORGANIZE-SPEC.md §3), the toolbar chip that filters by it, and the ⌥⌘1 … ⌥⌘7 /
// ⌥⌘0 keys that set it on whatever a list's cursor (or a page) is on. The dot reads the
// label itself, so a row re-renders only when its own label changes. Nothing renders for
// a session with no label.
import { LABEL_COLORS, type LabelColor, type SessionKey } from "@shared/api";
import type { RefObject } from "react";
import { useLabel, useLabels, useStore } from "../data/hooks";
import { anyLabel, type LabelFilter, labelName, removeLabel, setLabel } from "../lib/labels";
import { useShortcut } from "../lib/shortcuts";
import { Select } from "./Select";

/** The dot for a known colour; `name` is its accessible name ("Label: Urgent"). */
export function LabelSwatch({ color, name }: { color: LabelColor; name?: string }) {
  const className = `label-dot label-dot--${color}`;
  if (!name) return <span className={className} aria-hidden="true" />;
  return <span className={className} role="img" aria-label={`Label: ${name}`} title={name} />;
}

/** The dot of a session's label, or nothing. */
export function LabelDot({ session }: { session: SessionKey }) {
  const label = useLabel(session);
  return label ? <LabelSwatch color={label.color} name={label.name} /> : null;
}

/** "All labels", the seven (each its dot and name), "No label": a toolbar pop-up that
 *  stays away until some session has a label (or while it filters). Set, it shows the dot
 *  and the name on the selected fill, as the other chips do. */
export function LabelChip({ value, onChange }: { value: LabelFilter; onChange: (v: LabelFilter) => void }) {
  const labels = useLabels();
  if (!value && !anyLabel(labels)) return null;
  return (
    <Select<LabelFilter>
      value={value}
      onChange={onChange}
      aria-label="Label"
      className={`chipsel ${value ? "chipsel-on" : ""}`}
      options={[
        { value: "", label: "All labels" },
        ...LABEL_COLORS.map((c) => ({
          value: c as LabelFilter,
          label: labelName(labels, c),
          icon: <LabelSwatch color={c} />,
        })),
        { value: "none", label: "No label" },
      ]}
    />
  );
}

/** ⌥⌘1 … ⌥⌘7 set a label on the sessions `keys()` names (the row under a list's cursor,
 *  the selection, the page's own session), ⌥⌘0 clears it; a key with nothing to label
 *  passes. */
export function useLabelKeys(
  keys: () => readonly SessionKey[],
  opts: { enabled?: boolean; priority?: number; within?: RefObject<HTMLElement | null> } = {},
): void {
  const store = useStore();
  const run = (color: LabelColor | null) => {
    const list = keys();
    if (!list.length) return false;
    void (color ? setLabel(store, list, color) : removeLabel(store, list));
  };
  useShortcut("label.red", () => run("red"), opts);
  useShortcut("label.orange", () => run("orange"), opts);
  useShortcut("label.yellow", () => run("yellow"), opts);
  useShortcut("label.green", () => run("green"), opts);
  useShortcut("label.blue", () => run("blue"), opts);
  useShortcut("label.purple", () => run("purple"), opts);
  useShortcut("label.grey", () => run("grey"), opts);
  useShortcut("label.none", () => run(null), opts);
}
