// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The marks of the Workflows page, drawn once: the workflow
// glyph (three stacked short rules with a chevron, the rail's icon at row size), the
// small red ✕ an error carries, the chevron a fold turns, and the one glyph a run's or a
// step's row shows for its state (UX-SPEC §4: a spinner, the tick, the ✕, a dash for
// cancelled, the orange dot only for "waiting for a signer", a hollow ring otherwise).
import { StateDot } from "../../components/bits";
import type { RunGlyph, StepGlyph } from "./words";

/** The nav icon's paths on the 20 px grid; Shell.tsx draws the same for the rail. */
export const WORKFLOWS_ICON_PATHS = ["M3 5h8", "M3 10h8", "M3 15h8", "M14 7l3 3-3 3"];

export function WorkflowGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      className="wf-glyph"
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {WORKFLOWS_ICON_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The small ✕ that is an error's one signal in a row: red, 10 px, in the glyph column. */
export function ErrGlyph() {
  return (
    <svg className="err-glyph" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Chevron({ className }: { className?: string }) {
  return (
    <svg
      className={className ? `chev ${className}` : "chev"}
      viewBox="0 0 12 12"
      width="10"
      height="10"
      aria-hidden="true"
    >
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A row's one state mark. `label` is what assistive tech reads for it. */
export function StatusGlyph({ glyph, label }: { glyph: RunGlyph | StepGlyph; label: string }) {
  switch (glyph) {
    case "spinner":
      return <span className="spinner spinner--sm" role="img" aria-label={label} />;
    case "done":
      return <StateDot state="done" decorative />;
    case "failed":
      return (
        <span className="wf-err" role="img" aria-label={label}>
          <ErrGlyph />
        </span>
      );
    case "needs":
      return <StateDot state="needs_you" decorative />;
    case "cancelled":
    case "skipped":
      return (
        <span className="wf-dash" role="img" aria-label={label}>
          —
        </span>
      );
    default:
      return <StateDot state="idle" decorative />;
  }
}
