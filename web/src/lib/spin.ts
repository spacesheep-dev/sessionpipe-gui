// SPDX-License-Identifier: Apache-2.0
// Owned by: web. One clock for every working ring: StateDot (components/bits.tsx) calls it
// when a ring starts, the stream mark (data/hooks.ts) when the stream comes back. It
// imports nothing, so the glyphs can use it anywhere.

/** Every turning ring in the window on one phase: each running `spin` animation (the
 *  working glyph, the spinner) starts at the document clock's origin, so a column of them
 *  turns as one instead of rippling. */
export function syncSpins(): void {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") return;
  for (const a of document.getAnimations())
    if ((a as CSSAnimation).animationName === "spin" && a.playState === "running") a.startTime = 0;
}
