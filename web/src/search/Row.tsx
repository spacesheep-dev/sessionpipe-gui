// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. One session in the results (ux-search.md §2.2): its agent's glyph,
// its title with the marks the engine sent and its label dot, at most three facts (where ·
// what · how long), then its best moment, a line with its field's glyph, and at its right
// "N more matches". At the right of the title: "Needs you" in the accent, "Working", or the
// last day it was active. Hairline rows, no box. Clicking the row opens it at that moment.
// Memoised: a cursor move re-renders two rows.
import type { SessionMatch, SessionSearchHit } from "@shared/api";
import { type MouseEvent, memo, useCallback, useRef } from "react";
import { HarnessGlyph } from "../components/bits";
import { useContextMenu } from "../components/ContextMenu";
import { LabelDot } from "../components/LabelDot";
import { toolLabel } from "../lib/format";
import { howOf } from "../lib/split";
import { Marked } from "./Marked";
import { menuSubtitle, menuTitle, type RowMenuContext, rowMenu, snippetMenu } from "./menu";
import { openResultAs, resultLink } from "./open";
import { metaFacts, shortDate, spanTip, toolText } from "./words";

const FIELD_WORD = { prompt: "Prompt", reply: "Reply", tool: "Tool call" } as const;

/** Where a moment matched, as a 12 px line glyph: a speech bubble (prompt), two text
 *  lines (reply), a wrench (tool call). */
export function FieldGlyph({ field }: { field: SessionSearchHit["field"] }) {
  const p = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <span className="sx-field" title={FIELD_WORD[field]}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        {field === "prompt" ? (
          <path {...p} d="M2.5 3.5h11v7H7.5L4.5 13v-2.5h-2z" />
        ) : field === "reply" ? (
          <path {...p} d="M3 5.5h10M3 10.5h7" />
        ) : (
          <path
            {...p}
            d="M10.5 2.8a3 3 0 0 0-3.4 3.9L3 10.8 5.2 13l4.1-4.1a3 3 0 0 0 3.9-3.4l-1.8 1.8-1.7-.4-.4-1.7z"
          />
        )}
      </svg>
      <span className="sr-only">{FIELD_WORD[field]}</span>
    </span>
  );
}

export function HitLine({ hit, menu }: { hit: SessionSearchHit; menu?: ReturnType<typeof useContextMenu> }) {
  const t = hit.field === "tool" ? toolText(hit) : hit;
  return (
    <span className="sx-hit" data-field={hit.field} {...menu}>
      <FieldGlyph field={hit.field} />
      {hit.agent ? <span className="sx-agent">{hit.agent.type || "Subagent"}</span> : null}
      {hit.field === "tool" && hit.tool ? <span className="sx-verb">{toolLabel(hit.tool)}</span> : null}
      <Marked className="sx-snip" text={t.text} marks={t.marks} />
    </span>
  );
}

function Moment({ m, hit, ctx }: { m: SessionMatch; hit: SessionSearchHit; ctx: () => RowMenuContext }) {
  const menu = useContextMenu(() => snippetMenu(m, hit, ctx(), () => wholeText(ctx(), m, hit)), {
    title: () => menuTitle(m),
    subtitle: () => FIELD_WORD[hit.field],
  });
  return <HitLine hit={hit} menu={menu} />;
}

/** The whole message a moment is cut from (the transcript holds it). */
async function wholeText(ctx: RowMenuContext, m: SessionMatch, hit: SessionSearchHit): Promise<string> {
  if (!ctx.client) return hit.text;
  try {
    const t = await ctx.client.transcript(m.harness, m.id, { around: hit.ref, limit: 1 });
    return t.messages.find((x) => x.ref === hit.ref)?.text ?? hit.text;
  } catch {
    return hit.text;
  }
}

export interface RowProps {
  m: SessionMatch;
  index: number;
  active: boolean;
  /** The list's one tab stop: the cursor's row, or the first. Not `active`, which the phone layout never sets. */
  stop: boolean;
  now: number;
  /** The context read when a menu opens or a row is clicked (a ref's getter: stable). */
  ctx: () => RowMenuContext;
  onCursor: (i: number) => void;
}

export const Row = memo(function Row({ m, index, active, stop, now, ctx, onCursor }: RowProps) {
  const ref = useRef<HTMLAnchorElement>(null);
  const rect = useCallback(() => ref.current?.getBoundingClientRect(), []);
  const menu = useContextMenu(() => rowMenu(m, { ...ctx(), from: rect }), {
    title: () => menuTitle(m),
    subtitle: () => menuSubtitle(m),
  });
  const s = m.summary;
  const right =
    s?.state === "needs_you" ? (
      <span className="sx-when sx-when--needs">Needs you</span>
    ) : s?.state === "working" ? (
      <span className="sx-when">Working</span>
    ) : (
      <span className="sx-when num" title={spanTip(m.firstAt, m.lastAt)}>
        {shortDate(m.lastAt, now)}
      </span>
    );
  const facts = metaFacts(m);
  // Search asks for one hit, the best (or, under Newest, the newest): the row is its moment.
  const hit = m.hits[0];
  const href = resultLink(m, hit, ctx().q);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0) return;
    onCursor(index);
    e.preventDefault();
    openResultAs(m, hit, ctx().q, howOf(e), rect());
  };
  return (
    <a
      ref={ref}
      href={href}
      className="sx-row"
      data-nav-item=""
      data-key={m.key}
      aria-current={active ? "true" : undefined}
      tabIndex={stop ? 0 : -1}
      onClick={onClick}
      onFocus={() => onCursor(index)}
      {...menu}
    >
      <span className="sx-glyph">
        <HarnessGlyph name={m.harness} size="md" />
      </span>
      <span className="sx-head">
        <Marked className="sx-title" text={m.title} marks={m.titleMarks} />
        {s ? <LabelDot session={m.key} /> : null}
      </span>
      {right}
      <span className="sx-meta">{facts.join(" · ")}</span>
      {hit && (
        <span className="sx-hits">
          <Moment m={m} hit={hit} ctx={ctx} />
        </span>
      )}
      {m.moreHits > 0 && (
        <span className="sx-more num">
          {m.moreHits === 1 ? "1 more match" : `${m.moreHits.toLocaleString()} more matches`}
        </span>
      )}
    </a>
  );
});
