// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. A session the receiver never saw, read from the search index
// (ux-search.md §7, SEARCH-SPEC.md D5): /s/<harness>/<id> in the same chat look as a live
// session (the person's prompts as bubbles, the agent's replies as prose, one quiet line
// per tool call; tool output was never indexed, so it never shows), read-only, with a find
// bar that steps hit to hit over the whole session ("2 of 7", ⏎ / ⇧⏎, ⌘G / ⇧⌘G) and,
// where the composer would be, the line that resumes it in a terminal. The same view
// serves the page, the side panel and the phone. A session the index does not know either
// gets the caller's own "No such session here".
import type { SearchMark, SearchTranscript, SearchTranscriptMessage } from "@shared/api";
import { freeText, parseSearch } from "@shared/searchQuery";
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CommandWell, HarnessGlyph } from "../components/bits";
import { type MenuList, MoreButton } from "../components/ContextMenu";
import { Markdown } from "../components/Markdown";
import { BackButton, PageBar } from "../components/PageBar";
import { useStore } from "../data/hooks";
import { toolLabel } from "../lib/format";
import { noteHistoryTitle } from "../lib/historyTitle";
import { back } from "../lib/router";
import { IS_MAC } from "../lib/shortcuts";
import { clock } from "../lib/time";
import { searchClient } from "./client";
import { Marked } from "./Marked";
import { copyAs, historyLink } from "./menu";
import type { SearchClient } from "./types";
import { footerWords, harnessName, idWord, metaFacts } from "./words";
import "../styles/search.css";

const WINDOW = 60;
const hashRef = (): string | null => {
  const m = /^#h-(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]!) : null;
};
const urlQuery = (): string => new URLSearchParams(location.search).get("q") ?? "";

export function HistorySession({
  harness,
  id,
  mode,
  rootRef,
  fallback,
}: {
  harness: string;
  id: string;
  mode: "page" | "panel";
  rootRef?: RefObject<HTMLDivElement>;
  /** What shows when the index does not know the session either. */
  fallback: ReactNode;
}) {
  const store = useStore();
  const [client, setClient] = useState<SearchClient | null>(null);
  const [data, setData] = useState<SearchTranscript | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  const [q, setQ] = useState(() => freeText(parseSearch(urlQuery())));
  const [findOpen, setFindOpen] = useState(() => !!q || !!hashRef());
  const [at, setAt] = useState<string | null>(hashRef);
  const [current, setCurrent] = useState(-1);
  const listRef = useRef<HTMLOListElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const scrollTo = useRef<string | null>(at);

  useEffect(() => {
    let live = true;
    searchClient(store).then(
      (c) => live && setClient(c),
      () => live && setState("missing"),
    );
    return () => {
      live = false;
    };
  }, [store]);

  // The window around the hit (or the start), and every hit of the query in the session.
  const load = useCallback(
    async (around: string | null, query: string, signal?: AbortSignal) => {
      if (!client) return;
      try {
        const t = await client.transcript(
          harness,
          id,
          { q: query || undefined, around: around ?? undefined, limit: WINDOW },
          signal,
        );
        noteHistoryTitle(t.session.key, t.session.title);
        setData(t);
        setState("ready");
        return t;
      } catch (e) {
        if ((e as { name?: string })?.name === "AbortError") return;
        setState((s) => (s === "ready" ? s : "missing"));
      }
    },
    [client, harness, id],
  );
  useEffect(() => {
    if (!client) return;
    const ac = new AbortController();
    void load(at, q, ac.signal);
    return () => ac.abort();
    // The window moves by `at`; a new query refetches the hits around where the view is.
  }, [client, load, at, q]);

  // A hit the URL names, or the first hit, is the current one.
  const hits = data?.hits ?? [];
  useEffect(() => {
    if (!data) return;
    if (!hits.length) {
      setCurrent(-1);
      return;
    }
    const want = scrollTo.current ?? at;
    const i = want ? hits.findIndex((h) => h.ref === want) : -1;
    setCurrent((c) => (i >= 0 ? i : c >= 0 && c < hits.length ? c : 0));
  }, [data]);

  // The current hit sits 40 % down the view (scroll-margin), never animated longer than
  // the platform's own.
  const curRef = current >= 0 ? hits[current]?.ref : undefined;
  useLayoutEffect(() => {
    const ref = scrollTo.current ?? curRef;
    if (!ref || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-ref="${CSS.escape(ref)}"]`);
    if (!el) return;
    scrollTo.current = null;
    el.scrollIntoView({ block: "start" });
  }, [curRef, data]);

  const step = useCallback(
    (d: 1 | -1) => {
      if (!hits.length) return;
      const next = ((current < 0 ? (d === 1 ? -1 : 0) : current) + d + hits.length) % hits.length;
      setCurrent(next);
      const ref = hits[next]!.ref;
      scrollTo.current = ref;
      // Past the loaded window: load the window around the next hit.
      if (!data?.messages.some((m) => m.ref === ref)) setAt(ref);
      else {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-ref="${CSS.escape(ref)}"]`);
        el?.scrollIntoView({ block: "start" });
        scrollTo.current = null;
      }
    },
    [hits, current, data],
  );

  // ⌘G / ⇧⌘G anywhere on the page, while the find bar is up.
  useEffect(() => {
    if (!findOpen) return;
    const on = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [findOpen, step]);

  useEffect(() => {
    const on = () => {
      const r = hashRef();
      if (r) {
        scrollTo.current = r;
        setAt(r);
        setFindOpen(true);
      }
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  if (state === "missing") return <>{fallback}</>;
  const m = data?.session;
  const marksFor = new Map<string, SearchMark[]>();
  if (findOpen) for (const h of hits) marksFor.set(h.ref, h.marks);
  const menu = (): MenuList =>
    m
      ? [
          { label: "Find in this session…", run: () => openFind() },
          { sep: true },
          m.resume
            ? { label: "Copy resume command", run: () => void copyAs("resume command", m.resume!) }
            : { label: `Copy ${idWord(m.harness)}`, run: () => void copyAs(idWord(m.harness), m.id) },
          m.resume ? { label: `Copy ${idWord(m.harness)}`, run: () => void copyAs(idWord(m.harness), m.id) } : null,
          { label: "Copy link", run: () => void copyAs("link", historyLink(m)) },
          m.transcriptPath
            ? { label: "Copy transcript path", run: () => void copyAs("transcript path", m.transcriptPath!) }
            : null,
        ]
      : [];
  function openFind() {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  }
  const turns = groupTurns(data?.messages ?? []);
  return (
    <div
      className={`page session session--chat hx ${mode === "panel" ? "session--panel" : ""}`}
      ref={rootRef}
      data-history=""
      aria-busy={state === "loading"}
    >
      {mode === "page" && (
        <PageBar
          back={<BackButton onClick={() => back("/search")} label="Search" />}
          title={
            <>
              <HarnessGlyph name={harness} size="sm" />
              <span className="sess-title-text">{m?.title ?? ""}</span>
            </>
          }
          titleClassName="sess-title"
          large={false}
          className="sess-bar"
          meta={m ? metaFacts(m).slice(0, 2).join(" · ") : undefined}
          actions={m ? <MoreButton build={menu} title={() => m.title} /> : undefined}
        />
      )}
      {findOpen && (
        <FindBar
          inputRef={findRef}
          value={q}
          onChange={(v) => {
            setQ(v);
            setCurrent(-1);
          }}
          current={current}
          total={hits.length}
          step={step}
          close={() => {
            setFindOpen(false);
            setQ("");
          }}
        />
      )}
      {data?.before && (
        <div className="hx-edge">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAt(data.before!)}>
            Earlier turns
          </button>
        </div>
      )}
      <ol className="timeline timeline--chat hx-msgs" ref={listRef}>
        {turns.map((t) => (
          <Turn
            key={t[0]!.ref}
            msgs={t}
            harness={harness}
            marks={marksFor}
            current={findOpen && current >= 0 ? hits[current]?.ref : undefined}
          />
        ))}
      </ol>
      {data?.after && (
        <div className="hx-edge">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAt(data.after!)}>
            Later turns
          </button>
        </div>
      )}
      {m && (
        <footer className="hx-foot">
          <p className="hx-foot-text">{footerWords(m)}</p>
          {m.resume ? (
            <CommandWell command={m.resume} prompt={false} label="Copy resume command" />
          ) : (
            <div>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void copyAs(idWord(m.harness), m.id)}
              >
                Copy {idWord(m.harness)}
              </button>
            </div>
          )}
        </footer>
      )}
    </div>
  );
}

/** Prompts open turns; what follows belongs to the turn until the next prompt. */
function groupTurns(msgs: SearchTranscriptMessage[]): SearchTranscriptMessage[][] {
  const out: SearchTranscriptMessage[][] = [];
  for (const m of msgs) {
    // A subagent's prompt is its orchestrator's, inside the turn, never the person's bubble.
    if ((m.field === "prompt" && !m.agent) || !out.length) out.push([m]);
    else out[out.length - 1]!.push(m);
  }
  return out;
}

function Turn({
  msgs,
  harness,
  marks,
  current,
}: {
  msgs: SearchTranscriptMessage[];
  harness: string;
  marks: Map<string, SearchMark[]>;
  current: string | undefined;
}) {
  const prompt = msgs[0]!.field === "prompt" && !msgs[0]!.agent ? msgs[0]! : null;
  const rest = prompt ? msgs.slice(1) : msgs;
  return (
    <li className="turn turn--chat">
      {prompt && (
        <div className="chat-you hx-msg" data-ref={prompt.ref} data-current={current === prompt.ref ? "" : undefined}>
          <time className="chat-time num" dateTime={prompt.at} title={new Date(prompt.at).toLocaleString()}>
            {clock(prompt.at).slice(0, 5)}
          </time>
          <p className="chat-bubble">
            <Text m={prompt} marks={marks.get(prompt.ref)} current={current === prompt.ref} />
          </p>
        </div>
      )}
      {rest.length > 0 && (
        <div className="chat-ai">
          <span className="chat-meta">
            <HarnessGlyph name={harness} size="sm" />
            {harnessName(harness)}
          </span>
          {rest.map((m) =>
            m.field === "tool" ? (
              <p
                key={m.ref}
                className="hx-msg hx-tool"
                data-ref={m.ref}
                data-field="tool"
                data-current={current === m.ref ? "" : undefined}
              >
                <span className="hx-verb">{m.tool ? toolLabel(m.tool) : "Tool"}</span>
                <span className="hx-tool-text">
                  <Text m={stripTool(m)} marks={shift(m, marks.get(m.ref))} current={current === m.ref} />
                </span>
              </p>
            ) : (
              <div
                key={m.ref}
                className={`hx-msg hx-reply chat-card ${m.agent ? "hx-sub" : ""}`}
                data-ref={m.ref}
                data-current={current === m.ref ? "" : undefined}
              >
                {m.agent ? (
                  <span className="hx-who">
                    {m.agent.type || "Subagent"}
                    {m.field === "prompt" ? " · asked" : ""}
                  </span>
                ) : null}
                {marks.get(m.ref)?.length ? (
                  <p className="hx-prose">
                    <Text m={m} marks={marks.get(m.ref)} current={current === m.ref} />
                  </p>
                ) : (
                  <Markdown text={m.text} />
                )}
              </div>
            ),
          )}
        </div>
      )}
    </li>
  );
}

const stripTool = (m: SearchTranscriptMessage): SearchTranscriptMessage =>
  m.tool && m.text.startsWith(`${m.tool} `) ? { ...m, text: m.text.slice(m.tool.length + 1) } : m;
const shift = (m: SearchTranscriptMessage, marks: SearchMark[] | undefined): SearchMark[] | undefined => {
  if (!marks || !m.tool || !m.text.startsWith(`${m.tool} `)) return marks;
  const n = m.tool.length + 1;
  return marks.filter(([a]) => a >= n).map(([a, b]) => [a - n, b - n] as SearchMark);
};

function Text({ m, marks, current }: { m: SearchTranscriptMessage; marks?: SearchMark[]; current: boolean }) {
  return <Marked text={m.text} marks={marks} className={current ? "hx-current" : undefined} />;
}

function FindBar({
  inputRef,
  value,
  onChange,
  current,
  total,
  step,
  close,
}: {
  inputRef: RefObject<HTMLInputElement>;
  value: string;
  onChange: (v: string) => void;
  current: number;
  total: number;
  step: (d: 1 | -1) => void;
  close: () => void;
}) {
  const [text, setText] = useState(value);
  // The query follows the field a beat behind the keys (each answer is a whole-session scan).
  useEffect(() => {
    if (text === value) return;
    const t = window.setTimeout(() => onChange(text), 120);
    return () => window.clearTimeout(t);
  }, [text, value, onChange]);
  return (
    <search className="hx-find" aria-label="Find in this session">
      <label className="search">
        <svg className="search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          value={text}
          placeholder="Find in this session"
          aria-label="Find in this session"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (text !== value) onChange(text);
              else step(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        />
      </label>
      <span className="hx-count num" aria-live="polite">
        {value.trim() ? (total ? `${current + 1} of ${total.toLocaleString()}` : "No matches") : ""}
      </span>
      <button
        type="button"
        className="icon-btn hx-step"
        aria-label="Previous match"
        title="Previous match (⇧⌘G)"
        disabled={!total}
        onClick={() => step(-1)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className="icon-btn hx-step"
        aria-label="Next match"
        title="Next match (⌘G)"
        disabled={!total}
        onClick={() => step(1)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <button type="button" className="btn btn--ghost btn--sm hx-done" onClick={close}>
        Done
      </button>
    </search>
  );
}
