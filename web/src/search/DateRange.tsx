// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. "Custom range…" under the Date chip (ux-search.md §4): two native
// date fields, From and To, and Apply, which writes `since:` and `until:` into the query.
// A popover on a desktop, a sheet at the bottom on a phone.
import { useEffect, useRef, useState } from "react";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "Oct 1 – Oct 20" for the chip, when both ends are days. */
export function rangeLabel(since: string | undefined, until: string | undefined): string | null {
  const f = (v: string) => new Date(`${v}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (since && DAY.test(since) && until && DAY.test(until)) return `${f(since)} – ${f(until)}`;
  if (since && DAY.test(since)) return `Since ${f(since)}`;
  if (until && DAY.test(until)) return `Until ${f(until)}`;
  return null;
}

export function DateRange({
  since,
  until,
  onApply,
  onClose,
}: {
  since?: string;
  until?: string;
  onApply: (since: string | null, until: string | null) => void;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(since && DAY.test(since) ? since : "");
  const [to, setTo] = useState(until && DAY.test(until) ? until : "");
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.querySelector("input")?.focus();
    const onClose = () => close.current();
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, []);
  const bad = !!from && !!to && from > to;
  return (
    <div className="sx-range" role="dialog" aria-label="Custom range" ref={ref}>
      <label className="sx-range-field">
        <span>From</span>
        <input
          type="date"
          className="field"
          value={from}
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
        />
      </label>
      <label className="sx-range-field">
        <span>To</span>
        <input
          type="date"
          className="field"
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
        />
      </label>
      <div className="sx-range-actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={bad || (!from && !to)}
          onClick={() => {
            onApply(from || null, to || null);
            onClose();
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
