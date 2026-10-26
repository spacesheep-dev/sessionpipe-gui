// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. One session in the results (ux-search.md §2.2): its agent's glyph,
// its title with the marks the engine sent and its label dot, at most three facts (where ·
// what · how long), then 1–3 moments in transcript order, each a line with its field's
// glyph, and "N more matches". At the right: "Needs you" in the accent, "Working", or the
// last day it was active. Hairline rows, no box. Clicking the row opens it at its best hit;
// clicking a moment opens it at that moment. Memoised: a cursor move re-renders two rows.
import type { SessionMatch, SessionSearchHit } from "@shared/api";
import { type MouseEvent, memo, useCallback, useRef } from "react";
import { HarnessGlyph } from "../components/bits";
import { useContextMenu } from "../components/ContextMenu";
import { LabelDot } from "../components/LabelDot";
import { toolLabel } from "../lib/format";
import { Marked } from "./Marked";
import { menuSubtitle, menuTitle, type RowMenuContext, rowMenu, snippetMenu } from "./menu";
import { openResult, resultLink } from "./open";
import { metaFacts, shortDate, spanTip } from "./words";

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

/** A tool line's text without its leading tool name (the verb is drawn on its own), the
 *  marks moved with it. */
export function toolText(hit: Pick<SessionSearchHit, "text" | "marks" | "tool">): {
  text: string;
  marks: SessionSearchHit["marks"];
} {
  const name = hit.tool;
  let text = hit.text;
  let cut = 0;
  const lead = text.startsWith("…") ? 1 : 0;
  if (name && text.slice(lead).startsWith(`${name} `)) {
    cut = name.length + 1;
    text = text.slice(0, lead) + text.slice(lead + cut);
  }
  const marks = cut
    ? hit.marks
        .filter(([a]) => a >= lead + cut || a < lead)
        .map(([a, b]) => (a >= lead + cut ? ([a - cut, b - cut] as [number, number]) : ([a, b] as [number, number])))
    : hit.marks;
  return { text, marks };
}

export function HitLine({
  hit,
  onOpen,
  menu,
}: {
  hit: SessionSearchHit;
  onOpen?: (e: MouseEvent) => void;
  menu?: ReturnType<typeof useContextMenu>;
}) {
  const t = hit.field === "tool" ? toolText(hit) : hit;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the row is the keyboard's target; a moment is a pointer shortcut into it
    <span className="sx-hit" data-field={hit.field} onClick={onOpen} {...menu}>
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
  const open = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    openResult(m, hit, ctx().q, "page");
  };
  return <HitLine hit={hit} onOpen={open} menu={menu} />;
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
  now: number;
  /** The context read when a menu opens or a row is clicked (a ref's getter: stable). */
  ctx: () => RowMenuContext;
  onCursor: (i: number) => void;
}

export const Row = memo(function Row({ m, index, active, now, ctx, onCursor }: RowProps) {
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
  const href = resultLink(m, m.hits[0], ctx().q);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0) return;
    onCursor(index);
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      openResult(m, m.hits[0], ctx().q, "background", rect());
      return;
    }
    e.preventDefault();
    openResult(m, m.hits[0], ctx().q, e.shiftKey || e.altKey ? "beside" : "page", rect());
  };
  return (
    <a
      ref={ref}
      href={href}
      className="sx-row"
      data-nav-item=""
      data-key={m.key}
      aria-current={active ? "true" : undefined}
      tabIndex={-1}
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
      {m.hits.length > 0 && (
        <span className="sx-hits">
          {m.hits.map((h) => (
            <Moment key={h.ref} m={m} hit={h} ctx={ctx} />
          ))}
        </span>
      )}
      {m.moreHits > 0 && (
        // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a pointer shortcut; the row's menu has "Find in this session…"
        <span
          className="sx-more num"
          onClick={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            ctx().find(m);
          }}
        >
          {m.moreHits === 1 ? "1 more match" : `${m.moreHits.toLocaleString()} more matches`}
        </span>
      )}
    </a>
  );
});
