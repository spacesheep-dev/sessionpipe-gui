// SPDX-License-Identifier: Apache-2.0
// The sessionpipe mark, drawn live so it follows the scheme: three inlets merge into one
// stream, and the stream sends one event, the orange dot. The geometry is the brand's
// 64-unit construction (docs/brand.md, web/public/brand/mark.svg); the colours are the
// --brand-* tokens (tokens.css), which no skin sets: a skin never recolours the mark.
// The name beside it is the outlined wordmark (brand.css `.brand-name`), never live text.

/** The cut by the size the 64-unit box renders at: the strokes get heavier and the dot a
 *  little bigger as it shrinks, so the mark holds at 16 px (docs/brand.md, "The mark"). */
export function Mark({ size = 20 }: { size?: number }) {
  const small = size < 48;
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <g
        fill="none"
        stroke="var(--brand-inlet)"
        strokeLinecap="round"
        strokeWidth={size >= 128 ? 5.5 : small ? (size < 20 ? 7.5 : 7) : 6}
      >
        <path d="M9 47C20 47 19 32 29 32M9 32H29M9 17C20 17 19 32 29 32" />
        <path d={small ? "M29 32H36" : "M29 32H38"} stroke="var(--brand-stream)" />
      </g>
      <circle cx="51" cy="32" r={small ? 7.5 : 7} fill="var(--brand-dot)" />
    </svg>
  );
}
