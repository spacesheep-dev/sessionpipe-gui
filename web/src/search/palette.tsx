// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. ⌘K's "In transcripts" section (ux-search.md §6, SEARCH-SPEC.md D16):
// from the second character, up to five sessions whose words match, one marked moment
// each, from GET /api/ui/search/sessions?live=1&limit=5&hits=1; the last answer stays while
// the next is asked, so the rows under the section never jump per keystroke. And the
// preview of such a row: its moments as labelled blocks.
import type { SessionMatch, SessionSearchPage } from "@shared/api";
import { isEmptySearch, parseSearch } from "@shared/searchQuery";
import { useEffect, useRef, useState } from "react";
import { HarnessGlyph } from "../components/bits";
import type { Store } from "../data/store";
import { navigate } from "../lib/router";
import { searchClient } from "./client";
import { Marked } from "./Marked";
import { openResult } from "./open";
import { toolText } from "./Row";
import { metaFacts } from "./words";
import "../styles/search.css";

export const PALETTE_MIN = 2;

/** Sessions with the words of `q` in what was said, for the palette; null below 2 chars. */
export function usePaletteTranscripts(store: Store, q: string, on: boolean): SessionSearchPage | null {
  const text = q.trim();
  const want = on && text.length >= PALETTE_MIN && !isEmptySearch(parseSearch(text, { live: true }));
  const [page, setPage] = useState<SessionSearchPage | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!want) {
      setPage(null);
      return;
    }
    const ac = new AbortController();
    const mine = ++seq.current;
    searchClient(store)
      .then((c) =>
        c.sessions(
          { q: text, live: true, limit: 5, hits: 1, tz: new Date().getTimezoneOffset(), sort: "best" },
          ac.signal,
        ),
      )
      .then(
        (p) => {
          if (mine === seq.current) setPage(p);
        },
        () => {},
      );
    return () => ac.abort();
  }, [store, text, want]);
  return want ? page : null;
}

export const TxMark = ({ m }: { m: SessionMatch }) => (
  <span className="pal-glyph">
    <HarnessGlyph name={m.harness} size="sm" />
  </span>
);
export const TxSearchMark = () => (
  <span className="pal-glyph" aria-hidden="true">
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  </span>
);
export const TxTitle = ({ m }: { m: SessionMatch }) => <Marked text={m.title} marks={m.titleMarks} />;
export function TxDetail({ m }: { m: SessionMatch }) {
  const h = m.hits[0];
  if (!h) return null;
  const t = h.field === "tool" ? toolText(h) : h;
  return <Marked className="pal-tx-snip" text={t.text} marks={t.marks} />;
}

export function openTranscriptRow(m: SessionMatch, q: string, beside: boolean): void {
  openResult(m, m.hits[0], q, beside ? "beside" : "page");
}
export function searchAll(q: string): void {
  navigate(`/search?q=${encodeURIComponent(q.trim())}`);
}

const LABEL = { prompt: "Prompt", reply: "Reply", tool: "Tool call" } as const;

/** The preview of a transcript row: where it ran, then each moment under its field. */
export function TxPeek({ m }: { m: SessionMatch }) {
  return (
    <aside className="pal-peek" aria-hidden="true">
      <p className="pal-peek-state">
        <HarnessGlyph name={m.harness} size="sm" withLabel />
      </p>
      <p className="pal-peek-title">
        <Marked text={m.title} marks={m.titleMarks} />
      </p>
      <p className="pal-peek-where">{metaFacts(m).join(" · ")}</p>
      {m.hits.slice(0, 3).map((h) => {
        const t = h.field === "tool" ? toolText(h) : h;
        return (
          <div key={h.ref} className="pal-peek-block">
            <p className="pal-peek-label">{LABEL[h.field]}</p>
            <p className="pal-peek-text">
              <Marked text={t.text} marks={t.marks} />
            </p>
          </div>
        );
      })}
    </aside>
  );
}
