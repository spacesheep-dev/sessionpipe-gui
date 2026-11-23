// SPDX-License-Identifier: Apache-2.0
// Where an element is drawn against where it is laid out, for what moves rows (lib/motion.ts
// useFlip) and for what measures them while they move (lib/resizeAnchor.ts).

/** The vertical translate an element is drawn with right now (a running animation's). */
export function drawnY(el: HTMLElement): number {
  const t = getComputedStyle(el).transform;
  if (!t || t === "none") return 0;
  const m = t.match(/^matrix(3d)?\((.+)\)$/);
  if (!m) return 0;
  const v = m[2]!.split(",").map(Number);
  return (m[1] ? v[13] : v[5]) ?? 0;
}
