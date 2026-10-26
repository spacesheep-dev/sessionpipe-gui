// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. Text with the server's marks (never re-matched here): each mark is
// the text's own ink at 600, no fill. Inline Markdown is read as text the way the Review
// snippets read it: a code span is mono without its ticks, even one a mark splits; a
// `[redacted]` placeholder keeps its quiet highlight.
import type { SearchMark } from "@shared/api";
import type { ReactNode } from "react";

export interface Piece {
  text: string;
  mark: boolean;
  code: boolean;
  redacted: boolean;
}

const REDACTED = /\[redacted\]/gi;

/** Splits `text` at its marks, its code spans and its `[redacted]` placeholders. The
 *  backticks of a closed code span are dropped; an unpaired one stays as it is. Pure. */
export function pieces(text: string, marks: readonly SearchMark[] = []): Piece[] {
  const n = text.length;
  const cuts = new Set<number>([0, n]);
  const markAt = new Uint8Array(n + 1);
  for (const [a, b] of marks) {
    const s = Math.max(0, Math.min(n, a));
    const e = Math.max(s, Math.min(n, b));
    if (e <= s) continue;
    cuts.add(s);
    cuts.add(e);
    for (let i = s; i < e; i++) markAt[i] = 1;
  }
  const codeAt = new Uint8Array(n + 1);
  const tick = new Uint8Array(n + 1);
  for (let i = 0; i < n; i++) {
    if (text[i] !== "`") continue;
    const j = text.indexOf("`", i + 1);
    if (j < 0) break;
    if (j === i + 1 || text.slice(i + 1, j).includes("\n")) {
      i = j - 1;
      continue;
    }
    tick[i] = 1;
    tick[j] = 1;
    cuts.add(i);
    cuts.add(i + 1);
    cuts.add(j);
    cuts.add(j + 1);
    for (let k = i + 1; k < j; k++) codeAt[k] = 1;
    i = j;
  }
  // Emphasis reads as its words: the `**` / `*` of a closed pair go (snake_case and a
  // lone `*` stay); a backtick a cut window left unpaired goes too.
  for (const re of [/\*\*(?=\S)[^*\n]*?\S\*\*/g, /(?<![\w*])\*(?=[^\s*])[^*\n]*?[^\s*]\*(?![\w*])/g]) {
    for (const m of text.matchAll(re)) {
      const d = m[0].startsWith("**") ? 2 : 1;
      const s0 = m.index;
      const e0 = m.index + m[0].length;
      if (codeAt[s0] || tick[s0]) continue;
      for (let k = 0; k < d; k++) {
        tick[s0 + k] = 1;
        tick[e0 - d + k] = 1;
        cuts.add(s0 + k);
        cuts.add(s0 + k + 1);
        cuts.add(e0 - d + k);
        cuts.add(e0 - d + k + 1);
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (text[i] === "`" && !tick[i] && !codeAt[i]) {
      tick[i] = 1;
      cuts.add(i);
      cuts.add(i + 1);
    }
  }
  const redAt = new Uint8Array(n + 1);
  for (const m of text.matchAll(REDACTED)) {
    cuts.add(m.index);
    cuts.add(m.index + m[0].length);
    for (let k = m.index; k < m.index + m[0].length; k++) redAt[k] = 1;
  }
  const at = [...cuts].sort((a, b) => a - b);
  const out: Piece[] = [];
  for (let i = 0; i < at.length - 1; i++) {
    const s = at[i]!;
    const e = at[i + 1]!;
    if (e <= s || tick[s]) continue;
    const p: Piece = { text: text.slice(s, e), mark: !!markAt[s], code: !!codeAt[s], redacted: !!redAt[s] };
    const last = out[out.length - 1];
    if (last && last.mark === p.mark && last.code === p.code && last.redacted === p.redacted) last.text += p.text;
    else out.push(p);
  }
  return out;
}

export function Marked({
  text,
  marks,
  className,
}: {
  text: string;
  marks?: readonly SearchMark[];
  className?: string;
}) {
  const ps = pieces(text, marks);
  const nodes: ReactNode[] = ps.map((p, i) => {
    let node: ReactNode = p.text;
    if (p.redacted)
      node = (
        <mark className="sx-redacted" title="Removed before it was indexed: it looked like a secret">
          {node}
        </mark>
      );
    if (p.code) node = <code className="inline-code">{node}</code>;
    if (p.mark) node = <mark className="sx-mark">{node}</mark>;
    return <span key={i}>{node}</span>;
  });
  return <span className={className}>{nodes}</span>;
}
