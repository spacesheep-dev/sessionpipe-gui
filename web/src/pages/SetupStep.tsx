// SPDX-License-Identifier: Apache-2.0
// One step of a checklist, shared by /setup and /phone: the status glyph in a 20 px lead,
// the title as the disclosure, one caption, the body under it while open. Its own module
// so each page's chunk carries only this, not the other page.
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import "./setup.css";

export type Mark = "done" | "needs" | "todo";

/** The status glyph in a step's 20 px lead: a check once done, a ring in the ink on the
 *  step to do now, a quiet hollow ring for the ones after it. No amber: amber means a
 *  prompt needs you, and a step to do is not that. One signal; no number beside it. A
 *  step that turns done in front of the person draws its check in (240 ms). */
export function StepMark({ mark, label }: { mark: Mark; label: string }) {
  const was = useRef(mark);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    if (was.current !== mark && mark === "done") setArrived(true);
    was.current = mark;
  }, [mark]);
  return (
    <span
      className={`step-mark step-mark--${mark}${arrived ? " step-mark--arrive" : ""}`}
      role="img"
      aria-label={label}
    >
      {mark === "done" ? (
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
          <path
            d="M5 10.5l3.2 3.2L15 6.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <span className="step-dot" aria-hidden="true" />
      )}
    </span>
  );
}

/** One step of a checklist (here and on /phone): the glyph, the title as the disclosure,
 *  one caption that says where it stands, and the body under it while open. */
export function Step({
  mark,
  title,
  caption,
  children,
  why,
  whyLabel,
  optional = false,
  open,
  onToggle,
  needsLabel = "needs you",
  attrs,
}: {
  mark: Mark;
  title: string;
  /** One line: the result once done, the gate while waiting, else what the step is for. */
  caption?: ReactNode;
  children?: ReactNode;
  why?: ReactNode;
  whyLabel?: string;
  /** Never "needs you": a quiet "optional" stands beside the title. */
  optional?: boolean;
  open: boolean;
  onToggle: () => void;
  needsLabel?: string;
  attrs: Record<string, string | number>;
}) {
  const body = useId();
  const label = mark === "done" ? "done" : mark === "needs" ? needsLabel : optional ? "optional" : "later";
  // A step with nothing under its caption is a plain row, not a disclosure.
  const folds = !!children || !!why;
  return (
    <li
      className={`step step--${mark}${folds ? "" : " step--flat"}`}
      data-mark={mark}
      data-open={(folds && open) || undefined}
      {...attrs}
    >
      <div className="step-head">
        <StepMark mark={mark} label={label} />
        <div className="step-head-text">
          <h2 className="step-title">
            {folds ? (
              <button
                type="button"
                className="step-toggle"
                aria-expanded={open}
                aria-controls={body}
                onClick={onToggle}
              >
                {title}
              </button>
            ) : (
              title
            )}
            {optional && <span className="step-optional">optional</span>}
          </h2>
          {caption && <p className="step-what">{caption}</p>}
        </div>
        {folds && <span className="step-chev" aria-hidden="true" />}
      </div>
      <div className="step-body" id={body} hidden={!folds || !open}>
        {children}
        {why && (
          <details className="step-why">
            <summary>{whyLabel ?? (mark === "done" || optional ? "Details" : "Why isn't this done?")}</summary>
            <div className="step-why-body">{why}</div>
          </details>
        )}
      </div>
    </li>
  );
}
