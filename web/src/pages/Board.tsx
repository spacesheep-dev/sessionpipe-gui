// SPDX-License-Identifier: Apache-2.0
// The board: every session in one grouped list, needs_you first, under sticky section
// headers. Filters by machine, harness and text in the page bar; done sessions folded
// behind a disclosure with a count. Empty, waiting and no-match states sit where the
// first row would be. A right-click on the page's empty space has the view options.
import type { SessionState, SessionSummary } from "@shared/api";
import { SESSION_STATES } from "@shared/api";
import { useCallback, useMemo, useRef, useState } from "react";
import { ChipSelect, HarnessGlyph, SearchInput } from "../components/bits";
import { type MenuList, MoreButton, useContextMenu } from "../components/ContextMenu";
import { LabelChip, useLabelKeys } from "../components/LabelDot";
import { LensChip, LensNote } from "../components/LensChip";
import { PageBar } from "../components/PageBar";
import { cardHides, lensMenu, SessionCard, useBackgroundMenu, useStickyTop } from "../components/SessionCard";
import { useAppState, useLabels, useSessionTree } from "../data/hooks";
import { agentMatches } from "../lib/agents";
import { harnessMark, repoBranch, STATE_HEADING, STATE_HINT, sessionTitle } from "../lib/format";
import { focusSearch, useListNav } from "../lib/keys";
import { type LabelFilter, labelPasses, labelQuery, requestLabelRename } from "../lib/labels";
import { Link, sessionPath } from "../lib/router";
import { type Lens, setMode, setSettings, useAppSettings, useLens } from "../lib/settings";
import { useSplitKey } from "../lib/split";

/** Whether a search finds one of a session's agents (their type or what they were asked). */
const agentsMatch = (s: SessionSummary, q: string): boolean => {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && (s.agents ?? []).some((a) => words.every((w) => agentMatches(a, w)));
};

const matches = (s: SessionSummary, q: string) => {
  if (!q) return true;
  const hay = [
    sessionTitle(s),
    s.cwd,
    repoBranch(s),
    s.machine,
    s.model,
    s.harness,
    s.id,
    s.lastAssistant,
    s.progress?.assistant,
    s.openAttentions.map((a) => a.message).join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
};

/** The board's view options: the page's right-click menu, its "⋯" and (Show done) the
 *  Done header's. Built when a menu opens, from the state of the last render. */
function viewItems(o: {
  filtered: boolean;
  clear: () => void;
  showDone: boolean;
  setShowDone: (v: boolean) => void;
  beside: boolean;
  lens: Lens;
  simple: boolean;
}): MenuList {
  return [
    { label: "Find…", action: "search.focus", run: () => void focusSearch() },
    o.filtered && { label: "Clear filters", run: o.clear },
    { label: "Show done sessions", checked: o.showDone, run: () => o.setShowDone(!o.showDone) },
    { label: "Edit labels…", run: () => requestLabelRename() },
    { sep: true },
    {
      label: "Open sessions",
      items: [
        { label: "As a page", radio: true, checked: !o.beside, run: () => setSettings({ openSessions: "page" }) },
        {
          label: "Beside the page",
          radio: true,
          checked: o.beside,
          run: () => setSettings({ openSessions: "beside" }),
        },
      ],
    },
    ...lensMenu(o.lens, o.simple),
    { sep: true },
    {
      label: "Mode",
      items: [
        { label: "Simple", radio: true, checked: o.simple, run: () => setMode("simple") },
        { label: "Advanced", radio: true, checked: !o.simple, run: () => setMode("advanced") },
      ],
    },
  ];
}

export function Board() {
  const { roots, childrenOf, all } = useSessionTree();
  const { snapshotAt, connection } = useAppState();
  const [q, setQ] = useState("");
  const [machine, setMachine] = useState("");
  const [harness, setHarness] = useState("");
  const [label, setLabelFilter] = useState<LabelFilter>("");
  const labels = useLabels();
  const lq = useMemo(() => labelQuery(labels, q), [labels, q]);
  const [showDone, setShowDone] = useState(false);
  const lens = useLens();
  const { mode, openSessions } = useAppSettings();
  const simple = mode === "simple";
  const beside = openSessions === "beside";
  const openKey = useSplitKey();
  const page = useRef<HTMLDivElement>(null);
  useStickyTop(page);

  const machines = useMemo(() => [...new Set(all.map((s) => s.machine).filter((m): m is string => !!m))].sort(), [all]);
  const harnesses = useMemo(() => [...new Set(all.map((s) => s.harness))].sort(), [all]);

  const visible = useMemo(
    () =>
      roots.filter(
        (s) =>
          (!machine || s.machine === machine) &&
          (!harness || s.harness === harness) &&
          labelPasses(labels, s.key, label) &&
          lq.test(s.key) &&
          (matches(s, lq.rest) ||
            agentsMatch(s, lq.rest) ||
            (childrenOf.get(s.key) ?? []).some((c) => matches(c, lq.rest))),
      ),
    [roots, machine, harness, label, labels, lq, childrenOf],
  );
  const groups = useMemo(() => {
    const g = new Map<SessionState, SessionSummary[]>();
    for (const st of SESSION_STATES) g.set(st, []);
    for (const s of visible) g.get(s.state)!.push(s);
    return g;
  }, [visible]);

  const ordered = useMemo(() => {
    const list: SessionSummary[] = [];
    for (const st of SESSION_STATES) if (st !== "done" || showDone) list.push(...groups.get(st)!);
    return list;
  }, [groups, showDone]);
  const hrefs = useMemo(() => ordered.map((s) => sessionPath(s.harness, s.id)), [ordered]);
  const keys = useMemo(() => ordered.map((s) => s.key), [ordered]);
  const { cursor } = useListNav(hrefs, true, keys);
  const cursorKey = ordered[cursor]?.key;
  // ⌥⌘1 … ⌥⌘7 label the row under the cursor, ⌥⌘0 clears it.
  useLabelKeys(() => (cursorKey ? [cursorKey] : []));
  const hiddenByLens = useMemo(() => ordered.reduce((n, s) => n + cardHides(s, lens), 0), [ordered, lens]);

  const filtered = !!(q || machine || harness || label);
  const clear = useCallback(() => {
    setQ("");
    setMachine("");
    setHarness("");
    setLabelFilter("");
  }, []);
  const view = () => viewItems({ filtered, clear, showDone, setShowDone, beside, lens, simple });
  const pageMenu = useBackgroundMenu(view, { title: () => "Board" });
  const doneMenu = useContextMenu(() => [
    { label: "Show done sessions", checked: showDone, run: () => setShowDone((v) => !v) },
  ]);

  const doneCount = groups.get("done")!.length;
  const loaded = !!snapshotAt;
  const empty = loaded && all.length === 0;

  const row = (s: SessionSummary) => (
    <SessionCard
      key={s.key}
      s={s}
      children={childrenOf.get(s.key)}
      cursor={s.key === cursorKey ? cursor : undefined}
      lens={lens}
      simple={simple}
      openBeside={beside}
      open={s.key === openKey}
      openTab={s.agents?.length ? openKey : null}
      agentsMatch={!!lq.rest && agentsMatch(s, lq.rest)}
      onlyMachine={setMachine}
      onlyHarness={setHarness}
    />
  );

  return (
    <div className="page board" ref={page} {...pageMenu}>
      <PageBar
        title="Board"
        tools={
          empty ? null : (
            <>
              <SearchInput value={q} onChange={setQ} placeholder="Search" label="Search sessions" />
              <LensChip />
              {machines.length > 1 && (
                <ChipSelect
                  value={machine}
                  options={machines}
                  onChange={setMachine}
                  all="All machines"
                  label="Machine"
                />
              )}
              {harnesses.length > 1 && (
                <ChipSelect
                  value={harness}
                  options={harnesses}
                  onChange={setHarness}
                  all="All harnesses"
                  label="Harness"
                  optionLabel={(h) => harnessMark(h).label}
                  icon={(h) => <HarnessGlyph name={h} size="sm" />}
                />
              )}
              <LabelChip value={label} onChange={setLabelFilter} />
              {filtered && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={clear}>
                  Clear
                </button>
              )}
            </>
          )
        }
        actions={<MoreButton build={view} label="View options" title={() => "Board"} />}
      />

      <LensNote lens={lens} hidden={hiddenByLens} />

      {!loaded ? (
        connection === "live" || connection === "connecting" ? (
          <div className="skeleton" role="status" aria-label="Loading sessions">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton-row" />
            ))}
          </div>
        ) : (
          <div className="state">
            <p className="state-title">No connection to the receiver</p>
            <p className="state-text">The board fills in as soon as the stream is back.</p>
          </div>
        )
      ) : empty ? (
        <div className="state board-empty">
          <p className="state-title">No sessions yet</p>
          <p className="state-text">
            A session shows up the moment an agent fires a hook: run <code>npx sessionpipe install</code> here, or point
            another machine at this one.
          </p>
          <Link to="/connect" className="btn btn--primary">
            Open Connect
          </Link>
        </div>
      ) : visible.length === 0 ? (
        <div className="state">
          <p className="state-title">
            Nothing matches{q ? ` “${q}”` : ""}
            {harness ? ` in ${harnessMark(harness).label}` : ""}
            {machine ? ` on ${machine}` : ""}
          </p>
          <p className="state-text">Try fewer words, or another machine or harness.</p>
          <button type="button" className="btn" onClick={clear}>
            Clear filters
          </button>
        </div>
      ) : (
        <div className="board-list">
          {SESSION_STATES.filter((st) => st !== "done").map((st) => {
            const list = groups.get(st)!;
            if (list.length === 0) return null;
            return (
              <section
                key={st}
                className={`group group--${st}`}
                aria-label={`${list.length} ${STATE_HEADING[st](list.length)}`}
              >
                <h2 className="group-head" title={STATE_HINT[st]}>
                  {STATE_HEADING[st](list.length)}
                  <span className="group-count num">{list.length}</span>
                </h2>
                <div className="grid">{list.map(row)}</div>
              </section>
            );
          })}

          {doneCount > 0 && (
            <section className="group group--done" aria-label={`${doneCount} done`}>
              <h2 className="group-head" {...doneMenu}>
                <button
                  type="button"
                  className="group-toggle"
                  onClick={() => setShowDone((v) => !v)}
                  aria-expanded={showDone}
                  title={STATE_HINT.done}
                >
                  Done
                  <span className="group-count num">{doneCount}</span>
                  <svg className="group-caret" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path
                      d="M6 4l4 4-4 4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </h2>
              {showDone && <div className="grid grid--done">{groups.get("done")!.map(row)}</div>}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
