// SPDX-License-Identifier: Apache-2.0
// The palette's dialog (Palette.tsx holds its open state and its key, and loads this module
// once the page is idle, so the first ⌘K is instant and the first load is lighter).
// Sessions (fuzzy over title, repo, branch, machine, model; the ones that need you or work
// first), the open permissions ("Allow Read in …"), actions on the session in view (a
// message, open beside, open as page, forget) and the places to go. Enter runs the row
// under the cursor, shift+Enter opens a session beside, `>` keeps only actions, `#` only
// places. A row with › pushes a second list in place (the machines to start on, the
// appearance, the skin); Esc or Backspace on an empty field steps back. Typing a paired
// machine or a repo offers "New session on studio-mac in acme/billing" first. On a wide
// window the session under the cursor is previewed beside the list. Messages and answers
// leave the way the control strip sends them (web/src/control/command.ts).
import type { AgentRun, MachineSummary, SessionMatch, SessionSummary } from "@shared/api";
import { LABEL_COLORS, SNIPPET_CHARS, sessionKey, splitKey } from "@shared/api";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { sendCommand } from "../control/command";
import { useRpId } from "../control/hooks";
import { type NewSessionTarget, openNewSession } from "../control/newSessionState";
import { canSign, signHint } from "../control/signer";
import { sendErrorWords } from "../control/words";
import { byStateThenRecent, useAppState, useLabels, useStore } from "../data/hooks";
import { openDrawer, toggleDrawer } from "../files/state";
import { agentLabel, agentMatches, openAgent } from "../lib/agents";
import {
  attentionMessage,
  isPlanReview,
  modelShort,
  repoShort,
  STATE_LABEL,
  sessionTitle,
  toolLabel,
} from "../lib/format";
import { type FieldsMatch, fuzzyFields } from "../lib/fuzzy";
import { labelName, labelQuery, setLabel } from "../lib/labels";
import { navigate, parseRoute, sessionPath, useRoute } from "../lib/router";
import { useSimple } from "../lib/settings";
import { hintFor, IS_MAC, matches, useShortcutMap } from "../lib/shortcuts";
import { openSplit, useSplitKey } from "../lib/split";
import { setSkin, setTextSize, setTheme, TEXT_SIZES, type Theme, useSettings } from "../lib/theme";
import { askOff } from "../orchestrate/handoff/handoff";
import { openHandoffFor } from "../orchestrate/handoff/handoffState";
import {
  openTranscriptRow,
  PALETTE_MIN,
  searchAll,
  TxDetail,
  TxMark,
  TxPeek,
  TxSearchMark,
  TxTitle,
  usePaletteTranscripts,
} from "../search/palette";
import { FileMark, type FileRow, looksLikePath, matchFiles, usePaletteFiles } from "../search/paletteFiles";
import { useThemes } from "../themes/host/registry";
import { AgentGlyph } from "./AgentRow";
import { Ago, Kbd, Since, StateDot } from "./bits";
import { answerable } from "./ControlStrip";
import { LabelDot, LabelSwatch } from "./LabelDot";
import { closePalette, takeEarlyQuery } from "./Palette";
import { APPEARANCE, noContextMenu, SIZE_NAME, SkinSwatch, useListedSkins } from "./QuickSettings";
import { Inline } from "./SessionCard";
import "../styles/palette.css";

/** The quick settings: on the rail its own button, on a phone the row in the More sheet. */
function openDisplaySettings(): void {
  const rail = document.querySelector<HTMLElement>("nav.rail .qs-trigger");
  if (rail && rail.offsetParent !== null) {
    rail.click();
    return;
  }
  document.querySelector<HTMLElement>("[data-nav='more']")?.click();
  requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-nav='display']")?.click());
}

// ----- the rows -----

type Section = "Sessions" | "In transcripts" | "Files" | "Needs you" | "Actions" | "Go to";
const SECTIONS: Section[] = ["Sessions", "In transcripts", "Files", "Needs you", "Actions", "Go to"];

interface Item {
  id: string;
  section: Section;
  label: ReactNode;
  detail?: ReactNode;
  /** The row's mark: a session's state dot, or a small glyph. */
  mark: ReactNode;
  /** The instant its age counts from, drawn at the row's right ("7 s ago"), ticking on
   *  its own so the list never re-renders for a clock. */
  at?: string;
  /** The session the row is about, for the preview beside the list. */
  session?: SessionSummary;
  /** A subagent row's agent, for the preview. */
  agent?: AgentRun;
  /** The action's own key, as caps at the row's right ("C", "G B"). */
  keys?: string;
  /** It pushes a second list (a › at the right). */
  sub?: boolean;
  /** A subagent under the session row before it: the board's tree guide. */
  kid?: "mid" | "last";
  /** A session row with subagents listed under it: the guide starts at its glyph. */
  parent?: boolean;
  /** The current choice in a pushed list (appearance, skin): a ✓ for its mark. */
  on?: boolean;
  /** A subagent row matched the query itself (not only through its session). */
  hit?: boolean;
  /** A session found by what was said in it (the In transcripts section), for the preview. */
  match?: SessionMatch;
  score: number;
  run: (mods: { beside: boolean }) => void | Promise<void>;
}

type Mode =
  | { kind: "search" }
  | { kind: "prompt"; session: SessionSummary }
  | { kind: "forget"; session: SessionSummary };

/** A list pushed in place by a › row; Esc steps back one. Built from live data each
 *  render, so a machine going offline shows while the list is up. */
type Sub =
  | { id: "new" }
  | { id: "new-on"; machine: string }
  | { id: "appearance" }
  | { id: "skin" }
  | { id: "text" }
  | { id: "label"; session: string }
  /** The sessions that touched one file (the Files section's ›). */
  | { id: "file"; repo: string; path: string };

const SUB_TITLE = (s: Sub): string =>
  s.id === "new"
    ? "New session on"
    : s.id === "new-on"
      ? s.machine
      : s.id === "appearance"
        ? "Appearance"
        : s.id === "skin"
          ? "Skin"
          : s.id === "text"
            ? "Text size"
            : s.id === "file"
              ? (s.path.split("/").pop() ?? s.path)
              : "Label";

/** What a paired machine can do, in the picker's words: "safe mode", "offline",
 *  "sessionpipe 0.9" (no start options). */
export function machineHint(m: MachineSummary): string {
  const c = m.control;
  if (!c) return "";
  return [
    c.online ? "" : "offline",
    c.mode === "safe" ? "safe mode" : c.mode === "auto" ? "auto" : c.mode === "inherit" ? "inherit mode" : "",
    c.start ? "" : c.version ? `sessionpipe ${c.version}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `>` keeps only actions, `#` only places, `/` only files; the rest is the text to match.
 *  `is:subagent` keeps only subagents (it is taken off the text). */
function parseQuery(q: string): { only: Section | null; text: string; agentsOnly: boolean } {
  const s = q.trimStart();
  if (s.startsWith(">")) return { only: "Actions", text: s.slice(1).trim(), agentsOnly: false };
  if (s.startsWith("#")) return { only: "Go to", text: s.slice(1).trim(), agentsOnly: false };
  if (s.startsWith("/")) return { only: "Files", text: s.slice(1).trim(), agentsOnly: false };
  const words = s.trim().split(/\s+/);
  const agentsOnly = words.some((w) => /^is:subagents?$/i.test(w));
  return {
    only: agentsOnly ? "Sessions" : null,
    text: words.filter((w) => !/^is:subagents?$/i.test(w)).join(" "),
    agentsOnly,
  };
}

/** The word being typed when it is a `label:` token (the palette offers the labels). */
const labelWord = (q: string): { prefix: string; partial: string } | null => {
  const m = /(?:^|\s)(-?label:)(\S*)$/i.exec(q);
  return m ? { prefix: m[1]!.toLowerCase(), partial: m[2]!.toLowerCase() } : null;
};

/** Text with the matched letters marked: in the ink while the rest of the row stays a
 *  tier down (palette.css), never a block. */
function Hit({ text, at }: { text: string; at: number[] | undefined }) {
  if (!at || at.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    if (k < at.length && at[k] === i) {
      let j = i;
      while (k < at.length && at[k] === j) {
        j++;
        k++;
      }
      out.push(<u key={i}>{text.slice(i, j)}</u>);
      i = j;
    } else {
      const next = k < at.length ? (at[k] as number) : text.length;
      out.push(text.slice(i, next));
      i = next;
    }
  }
  return <>{out}</>;
}

const Glyph = ({ children }: { children: string }) => (
  <span className="pal-glyph" aria-hidden="true">
    {children}
  </span>
);

/** One hint in the footer: the key as a cap, then what it does. */
const FootKey = ({ keys, children }: { keys: string; children: string }) => (
  <span className="pal-foot-key">
    <Kbd>{keys}</Kbd>
    {children}
  </span>
);

/** An action's key at the row's right, one cap per chord ("G" "B", "⌘K"). */
const RowKeys = ({ keys }: { keys: string }) => (
  <span className="pal-keys" aria-hidden="true">
    {keys.split(" ").map((k, i) => (
      <Kbd key={i}>{k}</Kbd>
    ))}
  </span>
);

const Check = () => (
  <svg className="pal-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path
      d="M3.5 8.5 6.5 11.5 12.5 4.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ACTIVE = new Set(["needs_you", "working"]);

/** "New session on studio-mac in acme/billing": a word that starts a paired machine's
 *  name picks it; a word that starts a repo's owner or name picks a folder a session
 *  there already used (on the picked machine, or the repo's own machine). `named` when a
 *  machine was typed: then this start is the palette's first row. */
function startSuggestion(
  text: string,
  paired: readonly MachineSummary[],
  sessions: readonly SessionSummary[],
): { machine: MachineSummary; repo?: string; s?: SessionSummary; named: boolean } | null {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (!words.length) return null;
  const mw = words.find((w) => paired.some((m) => m.name.toLowerCase().startsWith(w)));
  const machine = mw ? paired.find((m) => m.name.toLowerCase().startsWith(mw)) : undefined;
  const rest = words.filter((w) => w !== mw);
  let hit: SessionSummary | undefined;
  if (rest.length)
    hit = sessions.find(
      (s) =>
        s.repo &&
        s.machine &&
        (machine ? s.machine === machine.name : paired.some((m) => m.name === s.machine)) &&
        rest.every((w) =>
          repoShort(s.repo)
            .toLowerCase()
            .split(/[/\-_.]/)
            .some((seg) => seg.startsWith(w)),
        ),
    );
  if (machine) return { machine, repo: hit ? repoShort(hit.repo) : undefined, s: hit, named: true };
  if (!hit) return null;
  const on = paired.find((m) => m.name === hit.machine);
  return on ? { machine: on, repo: repoShort(hit.repo), s: hit, named: false } : null;
}

/** The fixed rows a list ends on, so a long list shows whole rows at its fold. */
function snapToRows(list: HTMLElement): void {
  list.style.maxHeight = "";
  if (matchMedia("(max-width: 839px)").matches) return;
  const cap = list.clientHeight;
  if (list.scrollHeight <= cap + 1) return;
  let bottom = 0;
  for (const el of list.querySelectorAll<HTMLElement>(".pal-row")) {
    const b = el.offsetTop + el.offsetHeight;
    if (b > cap) break;
    bottom = b;
  }
  if (bottom > 0) list.style.maxHeight = `${bottom + 4}px`;
}

/** A "Needs you" command's words: a plan review's own pair (Approve plan, Keep planning),
 *  as the strip says it; else the verb and the tool, which the row shows as code. */
export function answerWords(a: { kind?: string; tool?: string }, allow: boolean): { verb: string; tool?: string } {
  if (isPlanReview(a)) return { verb: allow ? "Approve plan" : "Keep planning" };
  return { verb: allow ? "Allow" : "Deny", tool: a.tool ? toolLabel(a.tool) : "this" };
}

export function PaletteDialog({ closing = false }: { closing?: boolean }) {
  const store = useStore();
  const { sessions, machines } = useAppState();
  const labels = useLabels();
  const route = useRoute();
  const splitActive = useSplitKey();
  const { themes } = useThemes();
  const rp = useRpId();
  // Simple mode: fewer action rows (a message, open as page); the rest stay in Advanced.
  const simple = useSimple();
  // Keys typed while this module was still loading are the query's start.
  const [q, setQ] = useState(takeEarlyQuery);
  const [cursor, setCursorRaw] = useState(0);
  /** Who moved the cursor last: the keys scroll the list to it, the pointer never does. */
  const by = useRef<"key" | "pointer">("key");
  const setCursor = useCallback((next: number | ((c: number) => number), source: "key" | "pointer" = "key") => {
    by.current = source;
    setCursorRaw(next);
  }, []);
  /** Where the pointer last was: a row only takes the cursor when the pointer really
   *  moves, not when the list scrolls or reorders under a resting one. */
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "search" });
  const [stack, setStack] = useState<Sub[]>([]);
  const sub = stack[stack.length - 1];
  const display = useSettings();
  const { builtins: skinList, installed: skinsInstalled } = useListedSkins();
  // The keys at the row's right follow the person's own bindings.
  useShortcutMap();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; err: boolean } | null>(null);
  /** Attention ids answered from here this time; no second answer goes. */
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  const peek = useWide();
  // What was said, across every session and this machine's history (search/palette.tsx).
  const txOn = mode.kind === "search" && !stack.length && !/^\s*[>#/]/.test(q) && !/\bis:subagent\b/i.test(q);
  const tx = usePaletteTranscripts(store, q, txOn);
  // Files: asked for with `/`, or brought in when the words read as a path; the file
  // sub-list needs them too.
  const filesOn =
    mode.kind === "search" &&
    (/^\s*\//.test(q) || (!stack.length && !/^\s*[>#]/.test(q) && looksLikePath(q.trim())) || sub?.id === "file");
  const fileList = usePaletteFiles(store, filesOn);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const ctxKey = route.name === "session" ? sessionKey(route.harness, route.id) : splitActive;
  const ctx = ctxKey ? sessions.get(ctxKey) : undefined;
  const onItsPage = useCallback(
    (s: SessionSummary) => route.name === "session" && sessionKey(route.harness, route.id) === s.key,
    [route],
  );

  /** Whether a command can leave for this session's machine from this page. */
  const sendable = useCallback(
    (s: SessionSummary): { ok: true; machineId: string } | { ok: false; why: string } => {
      const control = s.machine ? machines.get(s.machine)?.control : undefined;
      if (!control) return { ok: false, why: `pair ${s.machine ?? "this machine"} to send from here` };
      if (!rp || !canSign(rp)) return { ok: false, why: signHint(rp) };
      return { ok: true, machineId: control.machineId };
    },
    [machines, rp],
  );

  const act = useCallback(async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote({ text: sendErrorWords(e), err: true });
    } finally {
      setBusy(null);
    }
  }, []);

  const push = useCallback((next: Sub) => {
    setStack((st) => [...st, next]);
    setQ("");
    setNote(null);
  }, []);
  const pop = useCallback(() => {
    setStack((st) => st.slice(0, -1));
    setQ("");
    setNote(null);
  }, []);

  /** The order the rows had when this query was first drawn: live updates change what a
   *  row says, never where it is, while the palette is up (a new session joins the end). */
  const held = useRef<{
    q: string;
    sessions: Map<string, number>;
    rows: Map<string, number>;
    order: Section[];
  } | null>(null);
  const { items, order } = useMemo((): { items: Item[]; order: Section[] } => {
    if (sub) return { items: subItems(sub), order: SECTIONS };
    let promote = false;
    const parsed = parseQuery(q);
    const { only, agentsOnly } = parsed;
    // `label:` tokens narrow the sessions; the rest of the words are matched.
    const lq = labelQuery(labels, parsed.text);
    const text = lq.rest;
    const want = (s: Section) => only === null || only === s;
    let sorted = [...sessions.values()].filter((s) => lq.test(s.key)).sort(byStateThenRecent);
    const hold = held.current?.q === q ? held.current : null;
    if (hold) {
      const rank = (k: string) => hold.sessions.get(k) ?? Number.POSITIVE_INFINITY;
      sorted = sorted
        .map((s, i) => ({ s, i }))
        .sort((a, b) => rank(a.s.key) - rank(b.s.key) || a.i - b.i)
        .map((x) => x.s);
    }
    const out: Item[] = [];
    // Typing `label:`: the labels, to finish the token with.
    const typing = labelWord(q);
    if (typing && want("Sessions")) {
      for (const c of LABEL_COLORS) {
        const name = labelName(labels, c);
        if (typing.partial && !name.toLowerCase().startsWith(typing.partial) && !c.startsWith(typing.partial)) continue;
        out.push({
          id: `l:${c}`,
          section: "Sessions",
          mark: <LabelSwatch color={c} />,
          label: `Label: ${name}`,
          detail: typing.prefix.startsWith("-") ? "leave out" : undefined,
          score: 10,
          run: () => {
            setQ((cur) => cur.replace(/(-?label:)\S*$/i, `$1${name.toLowerCase().replace(/\s+/g, "_")} `));
            inputRef.current?.focus();
          },
        });
      }
    }
    /** "Explore · Find ad-hoc money formatting", on the tree guide under its session (or,
     *  for `is:subagent`, on its own with the session named after it). */
    const agentRow = (s: SessionSummary, a: AgentRun, m: FieldsMatch | null, tree = true): Item => ({
      id: `g:${s.key}:${a.id}`,
      section: "Sessions",
      mark: tree ? <span className="pal-guide" aria-hidden="true" /> : <AgentGlyph a={a} />,
      kid: tree ? "mid" : undefined,
      label: (
        <>
          {tree && <AgentGlyph a={a} />}
          <Hit text={agentLabel(a)} at={m?.positions[0]} />
        </>
      ),
      // Under its session's row the guide says whose it is; alone, the title does.
      detail: !tree && (agentsOnly || m) ? sessionTitle(s) : undefined,
      hit: !!m,
      at: a.endedAt ?? a.lastAt,
      session: s,
      agent: a,
      score: (m?.score ?? 0) + (a.state !== "done" ? 1 : 0),
      // An agent opens beside, as its tab (a phone opens the page on it).
      run: () => {
        closePalette();
        openAgent(s, a, "beside");
      },
    });
    const agentsOf = (s: SessionSummary, m: FieldsMatch | null, all: boolean): Item[] =>
      (s.agents ?? [])
        .filter((a) => all || a.state !== "done")
        .map((a) => {
          const am = text ? fuzzyFields(text, [agentLabel(a)]) : null;
          return text && !am && !m ? null : agentRow(s, a, am);
        })
        .filter((x): x is Item => !!x);
    const sessionRow = (s: SessionSummary, m: FieldsMatch | null): Item => ({
      id: `s:${s.key}`,
      section: "Sessions",
      mark: <StateDot state={s.state} decorative />,
      label: (
        <>
          <LabelDot session={s.key} />
          <Hit text={sessionTitle(s)} at={m?.positions[0]} />
        </>
      ),
      // The machine never truncates (the repo, then the title, give way first).
      detail:
        s.machine || repoShort(s.repo) ? (
          <>
            {s.machine ? (
              <span className="pal-machine">
                <Hit text={s.machine} at={m?.positions[1]} />
              </span>
            ) : null}
            {repoShort(s.repo) ? (
              <span className="pal-repo">
                {s.machine ? " · " : ""}
                <Hit text={repoShort(s.repo)} at={m?.positions[2]} />
              </span>
            ) : null}
          </>
        ) : undefined,
      at: s.lastAt,
      session: s,
      score: (m?.score ?? 0) + (ACTIVE.has(s.state) ? 1.5 : 0),
      run: ({ beside }) => {
        closePalette();
        if (beside) openSplit(s.key);
        else navigate(sessionPath(s.harness, s.id));
      },
    });

    if (want("Sessions") && agentsOnly) {
      // `is:subagent`: every subagent, open ones first, each naming its session.
      const rows: Item[] = [];
      for (const s of sorted)
        for (const a of s.agents ?? []) {
          const m = text ? fuzzyFields(text, [agentLabel(a), sessionTitle(s)]) : null;
          if (text && !m && !text.split(/\s+/).every((w) => agentMatches(a, w.toLowerCase()))) continue;
          rows.push(agentRow(s, a, m, false));
        }
      rows.sort((a, b) => b.score - a.score);
      out.push(...rows.slice(0, 20));
    } else if (want("Sessions")) {
      // A session's open subagents (any that match, with a query) follow it.
      // The tree guide: the parent's row starts it, the last kid ends it.
      const tree = (group: Item[]): Item[] => {
        if (group.length > 1) {
          group[0] = { ...group[0]!, parent: true };
          group[group.length - 1] = { ...group[group.length - 1]!, kid: "last" };
        }
        return group;
      };
      if (!text)
        out.push(...sorted.slice(0, 8).flatMap((s) => tree([sessionRow(s, null), ...agentsOf(s, null, false)])));
      else {
        const rows: Item[][] = [];
        for (const s of sorted) {
          const m = fuzzyFields(text, [
            sessionTitle(s),
            s.machine ?? "",
            repoShort(s.repo),
            s.branch ?? "",
            `${modelShort(s.model)} ${s.model ?? ""}`,
          ]);
          const kids = agentsOf(s, m, true).filter((r) => !m || r.score > 1 || r.hit);
          if (m || kids.length) rows.push(tree([sessionRow(s, m ?? { score: 0, positions: [] }), ...kids]));
        }
        rows.sort((a, b) => Math.max(...b.map((r) => r.score)) - Math.max(...a.map((r) => r.score)));
        out.push(...rows.slice(0, 12).flat());
      }
    }

    // In transcripts: sessions whose words match (not those already listed), then the way
    // out to the Search page with the same query, always last once 2 characters are typed.
    if (txOn && only === null && q.trim().length >= PALETTE_MIN) {
      const listed = new Set(out.map((it) => it.id));
      for (const m of tx?.sessions ?? []) {
        if (listed.has(`s:${m.key}`)) continue;
        out.push({
          id: `t:${m.key}`,
          section: "In transcripts",
          mark: <TxMark m={m} />,
          label: <TxTitle m={m} />,
          detail: <TxDetail m={m} />,
          at: m.lastAt,
          match: m,
          score: -1,
          run: ({ beside }) => {
            closePalette();
            openTranscriptRow(m, q, beside);
          },
        });
      }
      out.push({
        id: "t:all",
        section: "In transcripts",
        mark: <TxSearchMark />,
        label: `Search all sessions for “${q.trim()}”`,
        keys: IS_MAC ? "⌘↵" : "Ctrl ↵",
        score: -2,
        run: () => {
          closePalette();
          searchAll(q);
        },
      });
    }

    // Files: with `/`, the files changed lately; without it, only when the words read as a
    // path. A row opens the newest session that touched the file, on that file; › lists
    // the other sessions.
    if (want("Files") && filesOn && fileList && (only === "Files" || text)) {
      for (const hit of matchFiles(fileList, text)) out.push(fileRow(hit.row, hit.at, hit.score));
    }

    if (want("Needs you")) {
      for (const s of sorted) {
        for (const a of s.openAttentions) {
          if (a.kind !== "permission" || !answerable(a) || answered.has(a.attentionId)) continue;
          const title = sessionTitle(s);
          for (const allow of [true, false]) {
            const verb = allow ? "Allow" : "Deny";
            const words = answerWords(a, allow);
            const label = words.tool ? `${words.verb} ${words.tool}` : words.verb;
            const m = text ? fuzzyFields(text, [label, title, s.machine ?? ""]) : null;
            if (text && !m) continue;
            out.push({
              id: `a:${a.attentionId}:${verb}`,
              section: "Needs you",
              mark: <StateDot state="needs_you" decorative />,
              label: (
                <>
                  {words.verb}{" "}
                  {words.tool && (
                    <>
                      <code>{words.tool}</code>{" "}
                    </>
                  )}
                  in <Hit text={title} at={m?.positions[1]} />
                </>
              ),
              detail: attentionMessage(a),
              at: a.at,
              session: s,
              score: (m?.score ?? 0) + 2,
              run: () => {
                const can = sendable(s);
                if (!can.ok) {
                  setNote({ text: can.why, err: true });
                  return;
                }
                return act(`a:${a.attentionId}`, async () => {
                  await sendCommand(
                    rp as string,
                    can.machineId,
                    {
                      kind: "permission.answer",
                      session: s.key,
                      for: a.attentionId,
                      decision: allow ? "allow" : "deny",
                    },
                    { onTap: () => setNote({ text: "Confirm with your passkey…", err: false }) },
                  );
                  setAnswered((prev) => new Set(prev).add(a.attentionId));
                  closePalette();
                });
              },
            });
          }
        }
      }
    }

    if (want("Actions")) {
      const targets =
        only === "Actions" ? [...(ctx ? [ctx] : []), ...sorted.filter((s) => s.key !== ctxKey)] : ctx ? [ctx] : [];
      const rows: Item[] = [];
      for (const s of targets) {
        const title = sessionTitle(s);
        const isCtx = s.key === ctxKey;
        const add = (verb: string, run: Item["run"], keys?: string, more: Partial<Item> = {}) => {
          const m = text ? fuzzyFields(text, [verb, title]) : null;
          if (text && !m) return;
          rows.push({
            id: `x:${verb}:${s.key}`,
            section: "Actions",
            mark: <Glyph>→</Glyph>,
            label: <Hit text={verb} at={m?.positions[0]} />,
            detail: <Hit text={title} at={m?.positions[1]} />,
            keys: isCtx ? keys : undefined,
            session: s,
            score: (m?.score ?? 0) + (isCtx ? 1 : 0),
            run,
            ...more,
          });
        };
        add(
          "Send a message…",
          () => {
            setMode({ kind: "prompt", session: s });
            setQ("");
            setNote(null);
            const can = sendable(s);
            if (!can.ok) setNote({ text: can.why, err: true });
          },
          onItsPage(s) ? hintFor("session.prompt") : undefined,
        );
        // The Handoff sheet (orchestrate/handoff): the row runs when its machine can take
        // an ask; else it says why, the way a message that cannot be sent does.
        add(
          "Ask another agent…",
          () => {
            const off = askOff(s, s.machine ? machines.get(s.machine)?.control : undefined);
            if (off) {
              setNote({ text: off, err: true });
              return;
            }
            closePalette();
            openHandoffFor(s);
          },
          hintFor("session.ask") || undefined,
        );
        if (!simple && !(isCtx && splitActive === s.key && !onItsPage(s)))
          add(
            "Open beside",
            () => {
              closePalette();
              openSplit(s.key);
            },
            hintFor("palette.beside"),
          );
        if (!onItsPage(s))
          add(
            "Open as page",
            () => {
              closePalette();
              navigate(sessionPath(s.harness, s.id));
            },
            splitActive === s.key ? hintFor("session.openPage") : undefined,
          );
        if (isCtx) add("Label…", () => push({ id: "label", session: s.key }), undefined, { sub: true });
        if (isCtx && !simple)
          add(
            "Files of this session",
            () => {
              closePalette();
              toggleDrawer(s.key);
            },
            hintFor("session.files") || undefined,
          );
        if (!simple) add("Forget…", () => setMode({ kind: "forget", session: s }));
      }
      // New session: the sheet as it is (c), the machines to start on (›), and when the
      // words name a paired machine or a repo on one, that start first, prefilled.
      const paired = [...machines.values()].filter((m) => m.control).sort((a, b) => a.name.localeCompare(b.name));
      if (paired.length) {
        const compose = (
          id: string,
          verb: string,
          detail: string | undefined,
          target: NewSessionTarget,
          extra: Partial<Item> = {},
        ) => {
          const m = text ? fuzzyFields(text, [verb]) : null;
          if (text && !m) return;
          rows.push({
            id: `n:${id}`,
            section: "Actions",
            mark: <Glyph>+</Glyph>,
            label: <Hit text={verb} at={m?.positions[0]} />,
            detail,
            score: (m?.score ?? 0) + (id === "new" ? 0.5 : 0),
            run: () => {
              closePalette();
              openNewSession(target);
            },
            ...extra,
          });
        };
        compose("new", "New session…", undefined, {}, { keys: hintFor("newSession.open") });
        if (text || only === "Actions") {
          const m = text ? fuzzyFields(text, ["New session on…", ...paired.map((p) => p.name)]) : null;
          if (!text || m)
            rows.push({
              id: "n:on",
              section: "Actions",
              mark: <Glyph>+</Glyph>,
              label: <Hit text="New session on…" at={m?.positions[0]} />,
              detail: paired.map((p) => p.name).join(", "),
              sub: true,
              score: m?.score ?? 0,
              run: () => push({ id: "new" }),
            });
        }
        const pick = startSuggestion(text, paired, sorted);
        if (pick) {
          const { machine, repo, s } = pick;
          promote = pick.named;
          rows.push({
            id: "n:here",
            section: "Actions",
            mark: <Glyph>+</Glyph>,
            label: (
              <>
                New session on <b className="pal-em">{machine.name}</b>
                {repo ? (
                  <>
                    {" "}
                    in <b className="pal-em">{repo}</b>
                  </>
                ) : null}
              </>
            ),
            detail: machineHint(machine) || undefined,
            score: 1000,
            run: () => {
              closePalette();
              openNewSession({
                machine: machine.name,
                ...(s ? { harness: s.harness, ...(s.cwd ? { cwd: s.cwd } : {}) } : {}),
              });
            },
          });
        }
      }
      // The display, as verbs: a typed "dark", "skin" or "text" finds them.
      if (text || only === "Actions") {
        const disp: { id: Sub["id"]; verb: string; now: string; words: string }[] = [
          {
            id: "appearance",
            verb: "Appearance…",
            now: APPEARANCE.find((a) => a.value === display.appearance)?.label ?? "",
            words: "theme dark light system mode",
          },
          {
            id: "skin",
            verb: "Skin…",
            now: display.skin.name,
            words: "theme colours colors paper sessionpipe spacesheep",
          },
          { id: "text", verb: "Text size…", now: SIZE_NAME[display.textSize], words: "font zoom bigger smaller" },
        ];
        for (const d of disp) {
          const m = text ? fuzzyFields(text, [d.verb, d.words]) : null;
          if (text && !m) continue;
          rows.push({
            id: `d:${d.id}`,
            section: "Actions",
            mark: <Glyph>→</Glyph>,
            label: <Hit text={d.verb} at={m?.positions[0]} />,
            detail: d.now,
            sub: true,
            score: (m?.score ?? 0) - 0.5,
            run: () => push({ id: d.id } as Sub),
          });
        }
      }
      if (text) rows.sort((a, b) => b.score - a.score);
      out.push(...rows.slice(0, only === "Actions" ? 40 : 8));
    }

    if (want("Go to")) {
      // `words`: what else finds a place ("limits" finds Usage), matched like its name.
      const places: { label: string; detail?: string; words?: string; key?: string; run: () => void }[] = [
        { label: "Board", key: "nav.board", run: () => navigate("/") },
        { label: "Feed", key: "nav.feed", run: () => navigate("/feed") },
        { label: "Machines", key: "nav.machines", run: () => navigate("/machines") },
        {
          label: "Usage",
          detail: "what each account has left",
          words: "limits quota left",
          key: "nav.usage",
          run: () => navigate("/usage"),
        },
        { label: "Workflows", key: "nav.workflows", run: () => navigate("/workflows") },
        { label: "Connect", key: "nav.connect", run: () => navigate("/connect") },
      ];
      for (const p of ["Inbox", "Review", "Setup"]) {
        const path = `/${p.toLowerCase()}`;
        if (parseRoute(path).name !== "missing")
          places.push({ label: p, key: `nav.${p.toLowerCase()}`, run: () => navigate(path) });
      }
      let nth = 0;
      for (const t of themes) {
        if (t.error) continue;
        nth++;
        places.push({
          label: t.name || t.id,
          detail: "view",
          key: nth <= 9 ? `nav.view${nth}` : undefined,
          run: () => navigate(`/t/${encodeURIComponent(t.id)}`),
        });
      }
      places.push({
        label: "Views",
        detail: "install, link, remove",
        key: "nav.views",
        run: () => navigate("/themes"),
      });
      places.push({
        label: "Shortcuts",
        detail: "every key, and change any",
        key: "nav.shortcuts",
        run: () => navigate("/shortcuts"),
      });
      places.push({ label: "Display settings", detail: "appearance, skin, text size", run: openDisplaySettings });
      places.push({ label: "Settings", detail: "mode · tier lens · data", run: () => navigate("/settings") });
      const rows: Item[] = [];
      for (const p of places) {
        const m = text ? fuzzyFields(text, [p.label, p.words ?? ""]) : null;
        if (text && !m) continue;
        rows.push({
          id: `g:${p.label}`,
          section: "Go to",
          mark: <Glyph>#</Glyph>,
          label: <Hit text={p.label} at={m?.positions[0]} />,
          detail: p.detail,
          keys: p.key ? hintFor(p.key) || undefined : undefined,
          score: m?.score ?? 0,
          run: () => {
            closePalette();
            p.run();
          },
        });
      }
      if (text) rows.sort((a, b) => b.score - a.score);
      out.push(...rows);
    }
    if (hold) {
      // A row known at the hold keeps its rank; a new one follows the row before it (a
      // subagent stays under its session), and a new session goes to its section's end.
      const ranked: { it: Item; r: number; i: number }[] = [];
      let last = -1;
      for (const [i, it] of out.entries()) {
        const r = hold.rows.get(it.id) ?? (it.id.startsWith("s:") ? Number.POSITIVE_INFINITY : last + 0.001);
        last = r;
        ranked.push({ it, r, i });
      }
      const sec = (it: Item) => hold.order.indexOf(it.section);
      ranked.sort((a, b) => sec(a.it) - sec(b.it) || a.r - b.r || a.i - b.i);
      out.splice(0, out.length, ...ranked.map((x) => x.it));
      return { items: out, order: hold.order };
    }
    // The sections in the order of their best match: "new session on" puts the action
    // first, a title fragment the sessions. A typed machine puts its start first; with
    // nothing typed, sessions lead.
    let order = SECTIONS;
    if (promote) order = ["Actions", "Sessions", "In transcripts", "Files", "Needs you", "Go to"];
    else if (text && !only) {
      const best = (sec: Section) =>
        out.reduce((m, it) => (it.section === sec ? Math.max(m, it.score) : m), Number.NEGATIVE_INFINITY);
      order = SECTIONS.map((sec, i) => ({ sec, i, b: best(sec) }))
        .sort((a, b) => b.b - a.b || a.i - b.i)
        .map((x) => x.sec);
    }
    // In transcripts stays under Sessions, whatever leads.
    order = [...order.filter((x) => x !== "In transcripts")];
    order.splice(Math.max(0, order.indexOf("Sessions")) + 1, 0, "In transcripts");
    // The cursor walks the rows in the order they are drawn.
    out.sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
    held.current = {
      q,
      sessions: new Map(sorted.map((s, i) => [s.key, i])),
      rows: new Map(out.map((it, i) => [it.id, i])),
      order,
    };
    return { items: out, order };

    /** A pushed list's rows, matched by the field's text. */
    function subItems(sub: Sub): Item[] {
      const text = q.trim();
      const rows: Item[] = [];
      const row = (it: Omit<Item, "section" | "score" | "label"> & { label: string; words?: string }) => {
        const m = text ? fuzzyFields(text, [it.label, it.words ?? ""]) : null;
        if (text && !m) return;
        const { words: _w, ...rest } = it;
        rows.push({
          ...rest,
          section: "Actions",
          label: <Hit text={it.label} at={m?.positions[0]} />,
          score: m?.score ?? 0,
        });
      };
      const paired = [...machines.values()].filter((m) => m.control).sort((a, b) => a.name.localeCompare(b.name));
      if (sub.id === "new") {
        for (const m of paired)
          row({
            id: `sub:m:${m.name}`,
            // Only an offline machine carries a mark (as on Machines).
            mark: m.control?.online ? <Glyph> </Glyph> : <StateDot state="stale" decorative />,
            label: m.name,
            detail: machineHint(m) || undefined,
            sub: true,
            run: () => push({ id: "new-on", machine: m.name }),
          });
      } else if (sub.id === "new-on") {
        const m = machines.get(sub.machine);
        row({
          id: "sub:any",
          mark: <Glyph>+</Glyph>,
          label: "Choose a folder…",
          detail: machineHint(m ?? ({ name: sub.machine } as MachineSummary)) || undefined,
          run: () => {
            closePalette();
            openNewSession({ machine: sub.machine });
          },
        });
        const seen = new Set<string>();
        for (const s of [...sessions.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))) {
          if (s.machine !== sub.machine || !s.cwd || seen.has(s.cwd)) continue;
          seen.add(s.cwd);
          if (seen.size > 8) break;
          row({
            id: `sub:cwd:${s.cwd}`,
            mark: <Glyph>+</Glyph>,
            label: repoShort(s.repo) || s.cwd,
            words: s.cwd,
            detail: repoShort(s.repo) ? s.cwd : undefined,
            run: () => {
              closePalette();
              openNewSession({ machine: sub.machine, harness: s.harness, cwd: s.cwd });
            },
          });
        }
        for (const f of m?.control?.folders ?? []) {
          if (seen.has(f)) continue;
          row({
            id: `sub:folder:${f}`,
            mark: <Glyph>+</Glyph>,
            label: f,
            detail: "allowed folder",
            run: () => {
              closePalette();
              openNewSession({ machine: sub.machine, cwd: f });
            },
          });
        }
      } else if (sub.id === "appearance") {
        const forced = display.skin.scheme !== "both";
        for (const a of APPEARANCE)
          row({
            id: `sub:t:${a.value}`,
            mark: (forced ? display.skin.scheme === a.value : display.appearance === a.value) ? (
              <Check />
            ) : (
              <Glyph> </Glyph>
            ),
            label: a.label,
            detail: forced && a.value !== display.skin.scheme ? `${display.skin.name} is light only` : undefined,
            on: display.appearance === a.value,
            run: () => {
              if (!forced) setTheme(a.value as Theme);
              pop();
            },
          });
      } else if (sub.id === "skin") {
        const scheme = document.documentElement.dataset.scheme === "dark" ? "dark" : "light";
        for (const k of [...skinList, ...skinsInstalled])
          row({
            id: `sub:k:${k.id}`,
            mark: display.skin.id === k.id ? <Check /> : <SkinSwatch skin={k} scheme={scheme} />,
            label: k.name,
            detail: k.scheme === "both" ? undefined : `${k.scheme} only`,
            run: () => {
              setSkin(k);
              pop();
            },
          });
      } else if (sub.id === "text") {
        for (const t of TEXT_SIZES)
          row({
            id: `sub:x:${t}`,
            mark: display.textSize === t ? <Check /> : <Glyph> </Glyph>,
            label: SIZE_NAME[t],
            detail: `${Math.round(t * 100)} %`,
            run: () => {
              setTextSize(t);
              pop();
            },
          });
      } else if (sub.id === "label") {
        const current = labels.sessions[sub.session];
        for (const c of LABEL_COLORS)
          row({
            id: `sub:l:${c}`,
            mark: <LabelSwatch color={c} />,
            label: labelName(labels, c),
            words: c,
            detail: current === c ? "current" : undefined,
            run: async () => {
              closePalette();
              await setLabel(store, sub.session, c);
            },
          });
        if (current)
          row({
            id: "sub:l:none",
            mark: <Glyph> </Glyph>,
            label: "No label",
            run: async () => {
              closePalette();
              await setLabel(store, sub.session, null);
            },
          });
      } else if (sub.id === "file") {
        // Every session that touched the file, newest first; each opens on it.
        const file = fileList?.find((f) => f.repo === sub.repo && f.path === sub.path);
        for (const fs of file?.sessions ?? []) {
          const live = sessions.get(fs.key);
          row({
            id: `sub:f:${fs.key}`,
            mark: live ? <StateDot state={live.state} decorative /> : <Glyph> </Glyph>,
            label: live ? sessionTitle(live) : fs.title,
            detail:
              [live?.machine, fs.count > 1 ? `${fs.count} changes` : undefined].filter(Boolean).join(" · ") ||
              undefined,
            at: fs.lastAt,
            session: live,
            run: ({ beside }) => openFileIn(fs.key, sub.path, beside),
          });
        }
      }
      if (text) rows.sort((a, b) => b.score - a.score);
      return rows;
    }

    /** The newest session that touched the file, opened on it: as the page (`?file=`), or
     *  beside, where the panel's drawer takes the file. */
    function openFileIn(key: string, path: string, beside: boolean): void {
      closePalette();
      const { harness, id } = splitKey(key);
      if (beside) {
        openSplit(key);
        openDrawer(key, path, "panel");
      } else navigate(`${sessionPath(harness, id)}?file=${encodeURIComponent(path)}`);
    }
    function fileRow(f: FileRow, at: number[], score: number): Item {
      const latest = f.sessions[0];
      const live = latest ? sessions.get(latest.key) : undefined;
      const where = [repoShort(f.repo), live ? sessionTitle(live) : latest?.title].filter(Boolean).join(" · ");
      return {
        id: `f:${f.repo}:${f.path}`,
        section: "Files",
        mark: <FileMark />,
        label: <Hit text={f.path} at={at} />,
        detail: where || undefined,
        at: f.lastAt,
        session: live,
        // Touched by several sessions: Enter asks which (›), as every pushed list does.
        sub: f.sessions.length > 1,
        score,
        run: ({ beside }) => {
          if (!latest) return;
          if (f.sessions.length > 1) push({ id: "file", repo: f.repo, path: f.path });
          else openFileIn(latest.key, f.path, beside);
        },
      };
    }
  }, [
    sub,
    push,
    pop,
    display,
    skinList,
    skinsInstalled,
    store,
    q,
    sessions,
    machines,
    labels,
    ctx,
    ctxKey,
    splitActive,
    themes,
    answered,
    rp,
    sendable,
    act,
    onItsPage,
    simple,
    tx,
    txOn,
    filesOn,
    fileList,
  ]);

  // A new query (or a pushed list) starts at the top, in this same render; a shorter list
  // pulls the cursor in.
  const listId = `${stack.length}:${q}`;
  const [seenList, setSeenList] = useState(listId);
  if (seenList !== listId) {
    setSeenList(listId);
    by.current = "key";
    setCursorRaw(0);
  }
  const at = Math.min(cursor, Math.max(0, items.length - 1));
  // The list scrolls only when the keys take the cursor past its edge: one row's worth,
  // and to the very top (its section's label too) for the first row. The pointer never
  // scrolls it.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || by.current !== "key") return;
    if (at === 0) {
      list.scrollTop = 0;
      return;
    }
    const row = list.querySelector<HTMLElement>(`[data-i="${at}"]`);
    if (!row) return;
    const head = row.previousElementSibling?.classList.contains("pal-section")
      ? (row.previousElementSibling as HTMLElement)
      : row;
    const top = head.offsetTop;
    const bottom = row.offsetTop + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      // Down: just enough to show the row, then on to the next whole row's top, so the
      // list never rests on half a row at its top either.
      const need = bottom - list.clientHeight + 4;
      let to = need;
      for (const el of list.children as HTMLCollectionOf<HTMLElement>) {
        if (el.offsetTop >= need - 0.5) {
          to = el.offsetTop;
          break;
        }
      }
      list.scrollTop = to;
    }
  }, [at]);
  // The list ends on a whole row at its fold, never half a row: measured when its rows
  // change (not on every live update) and on a resize.
  const shape = items.map((it) => it.id).join("|");
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    snapToRows(list);
  }, [shape, mode.kind]);
  useEffect(() => {
    const on = () => listRef.current && snapToRows(listRef.current);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  // Focus: the input on open and when the mode comes back to search; the Forget button
  // in the confirm.
  useEffect(() => {
    if (mode.kind === "forget") dialogRef.current?.querySelector<HTMLElement>(".btn--danger")?.focus();
    else inputRef.current?.focus();
  }, [mode]);

  const sendPrompt = () => {
    if (mode.kind !== "prompt") return;
    const text = q.trim();
    if (!text || busy) return;
    const s = mode.session;
    const can = sendable(s);
    if (!can.ok) {
      setNote({ text: can.why, err: true });
      return;
    }
    void act("prompt", async () => {
      await sendCommand(
        rp as string,
        can.machineId,
        { kind: "prompt", session: s.key, text },
        { onTap: () => setNote({ text: "Confirm with your passkey…", err: false }) },
      );
      closePalette();
    });
  };

  const forget = () => {
    if (mode.kind !== "forget" || busy) return;
    const s = mode.session;
    void act("forget", async () => {
      const { harness, id } = splitKey(s.key);
      await store.transport.forget(harness, id);
      store.apply({ kind: "forgotten", key: s.key });
      closePalette();
      if (onItsPage(s)) navigate("/", { replace: true });
    });
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Nothing here reaches the page's own keys (`/`, j/k, Esc on the panel).
    e.stopPropagation();
    // The palette's own keys come from the keymap too (scope "palette", rebindable).
    const is = (id: string) => matches(e.nativeEvent, id);
    if (closing) return;
    if (e.key === "Escape" || is("palette.close")) {
      e.preventDefault();
      if (mode.kind !== "search") {
        setMode({ kind: "search" });
        setQ("");
        setNote(null);
      } else if (stack.length) pop();
      else closePalette();
      return;
    }
    // Backspace in an empty field steps out of a pushed list, as Raycast's does.
    if (e.key === "Backspace" && !q && stack.length && mode.kind === "search") {
      e.preventDefault();
      pop();
      return;
    }
    if (e.key === "Tab") {
      // The trap: focus cycles inside the dialog.
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? [])];
      if (focusable.length === 0) return;
      e.preventDefault();
      const i = focusable.indexOf(document.activeElement as HTMLElement);
      const next = focusable[(i + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length];
      next?.focus();
      return;
    }
    if (mode.kind === "forget") {
      if (e.key === "Enter" && !(document.activeElement instanceof HTMLButtonElement)) {
        e.preventDefault();
        forget();
      }
      return;
    }
    if (mode.kind === "prompt") {
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        sendPrompt();
      }
      return;
    }
    if (is("palette.down")) {
      e.preventDefault();
      setCursor(Math.min(items.length - 1, at + 1));
    } else if (is("palette.up")) {
      e.preventDefault();
      setCursor(Math.max(0, at - 1));
    } else if (e.key === "Home" && !q) {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === "End" && !q) {
      e.preventDefault();
      setCursor(Math.max(0, items.length - 1));
    } else if (
      e.key === "Enter" &&
      (IS_MAC ? e.metaKey : e.ctrlKey) &&
      txOn &&
      q.trim().length >= PALETTE_MIN &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      closePalette();
      searchAll(q);
    } else if ((is("palette.beside") || is("palette.run")) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const it = items[at];
      if (it && !busy) void it.run({ beside: is("palette.beside") });
    }
  };

  const { only, text } = parseQuery(q);
  const placeholder =
    mode.kind === "prompt"
      ? `Message for ${sessionTitle(mode.session)} · Enter sends`
      : sub
        ? sub.id === "new"
          ? "A machine…"
          : sub.id === "new-on"
            ? "A folder or a repo…"
            : `${SUB_TITLE(sub)}…`
        : only === "Actions"
          ? "An action…"
          : only === "Go to"
            ? "A page or a view…"
            : only === "Files"
              ? "A file path…"
              : "Sessions, actions, pages…";
  const activeId = items[at] ? `pal-opt-${at}` : undefined;
  const paired = [...machines.values()].some((m) => m.control);
  const noResults = items.every((it) => it.id === "t:all") && mode.kind === "search";

  return (
    <>
      <button
        type="button"
        className="pal-scrim"
        aria-label="Close"
        onClick={closePalette}
        data-dismiss
        data-closing={closing ? "" : undefined}
        tabIndex={closing ? -1 : undefined}
      />
      <div
        className="pal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        aria-hidden={closing || undefined}
        ref={dialogRef}
        onKeyDown={onKey}
        onContextMenu={noContextMenu}
        data-mode={mode.kind}
        data-peek={peek && mode.kind === "search" ? "" : undefined}
        data-q={text ? "" : undefined}
        data-closing={closing ? "" : undefined}
      >
        {mode.kind === "forget" ? (
          <div className="pal-confirm" role="alertdialog" aria-label="Forget this session?">
            <span>Delete everything held for “{sessionTitle(mode.session)}” here?</span>
            <button type="button" className="btn btn--sm btn--danger" onClick={forget} disabled={!!busy}>
              {busy === "forget" ? "Forgetting…" : "Forget"}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => {
                setMode({ kind: "search" });
                setNote(null);
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="pal-head">
            {mode.kind === "prompt" ? (
              <span className="pal-to" title={sessionTitle(mode.session)}>
                To {sessionTitle(mode.session)}
              </span>
            ) : stack.length ? (
              <button type="button" className="pal-crumb" onClick={pop} aria-label={`Back from ${SUB_TITLE(sub!)}`}>
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path
                    d="M10 3.5 5.5 8l4.5 4.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>{SUB_TITLE(sub!)}</span>
              </button>
            ) : (
              <svg className="pal-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            )}
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={placeholder}
              aria-label={mode.kind === "prompt" ? "Message for the next turn" : "Search sessions, actions and pages"}
              role="combobox"
              aria-expanded={mode.kind !== "prompt"}
              aria-controls={mode.kind === "prompt" ? undefined : "pal-list"}
              aria-activedescendant={mode.kind === "prompt" ? undefined : activeId}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
              enterKeyHint={mode.kind === "prompt" ? "send" : "go"}
              disabled={busy === "prompt"}
            />
            {busy === "prompt" ? (
              <span className="pal-busy">
                <span className="spinner spinner--sm" aria-hidden="true" /> Sending…
              </span>
            ) : (
              <button type="button" className="pal-cancel" onClick={closePalette}>
                Cancel
              </button>
            )}
          </div>
        )}

        {mode.kind === "search" && (
          <div className="pal-body">
            <div
              className="pal-list"
              role="listbox"
              id="pal-list"
              ref={listRef}
              aria-label={sub ? SUB_TITLE(sub) : "Results"}
              key={stack.length}
              data-pushed={stack.length ? "" : undefined}
            >
              {noResults && (
                <div className="pal-empty" role="status">
                  <p className="pal-empty-title">
                    {text || q.trim() ? `No results for “${text || q.trim()}”` : "Nothing here yet"}
                  </p>
                  <p className="pal-empty-text">
                    {sub
                      ? "Esc goes back."
                      : `Try a title, a machine or a repo${paired ? ", or “new” to start a session" : ""}. Type > for actions, # for pages.`}
                  </p>
                </div>
              )}
              {order.map((sec) => {
                const first = items.findIndex((it) => it.section === sec);
                if (first < 0) return null;
                return [
                  sub ? null : (
                    <div className="pal-section" role="presentation" key={`h:${sec}`}>
                      {sec}
                    </div>
                  ),
                  ...items.map((it, i) =>
                    it.section !== sec ? null : (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled on the dialog (combobox pattern)
                      <div
                        key={it.id}
                        id={`pal-opt-${i}`}
                        className={`pal-row ${busy === it.id ? "pal-row--busy" : ""}`}
                        role="option"
                        tabIndex={-1}
                        aria-selected={i === at}
                        aria-haspopup={it.sub ? "listbox" : undefined}
                        data-i={i}
                        data-section={sec}
                        data-kid={it.kid}
                        data-parent={it.parent ? "" : undefined}
                        onMouseMove={(e) => {
                          const p = lastPointer.current;
                          lastPointer.current = { x: e.clientX, y: e.clientY };
                          if (p && p.x === e.clientX && p.y === e.clientY) return;
                          if (i !== at) setCursor(i, "pointer");
                        }}
                        onClick={(e) => {
                          if (!busy) void it.run({ beside: e.shiftKey || e.altKey });
                        }}
                      >
                        {it.mark}
                        <span className="pal-main">
                          <span className="pal-label">{it.label}</span>
                          {it.detail ? <span className="pal-detail">{it.detail}</span> : null}
                        </span>
                        {it.sub ? (
                          <span className="pal-chev" aria-hidden="true">
                            ›
                          </span>
                        ) : it.keys ? (
                          <RowKeys keys={it.keys} />
                        ) : it.at ? (
                          <span className="pal-age">
                            <Ago iso={it.at} />
                          </span>
                        ) : null}
                      </div>
                    ),
                  ),
                ];
              })}
            </div>
            {peek && (items[at]?.match ? <TxPeek m={items[at]!.match!} /> : <Peek item={items[at]} />)}
          </div>
        )}

        {note && <p className={`pal-note ${note.err ? "pal-note--err" : ""}`}>{note.text}</p>}

        <div className="pal-foot" aria-hidden="true">
          {mode.kind === "search" ? (
            <>
              <FootKey keys="↑↓">Move</FootKey>
              <FootKey keys="↵">{items[at]?.sub ? "Choose" : "Open"}</FootKey>
              {!sub && <FootKey keys="⇧↵">Beside</FootKey>}
              {txOn && q.trim().length >= PALETTE_MIN && <FootKey keys={IS_MAC ? "⌘↵" : "Ctrl ↵"}>Search all</FootKey>}
              <span className="pal-foot-spring" />
              {sub ? (
                <FootKey keys="esc">Back</FootKey>
              ) : (
                <>
                  <FootKey keys=">">Actions</FootKey>
                  <FootKey keys="#">Go to</FootKey>
                  <FootKey keys="/">Files</FootKey>
                </>
              )}
            </>
          ) : (
            <FootKey keys="esc">Back</FootKey>
          )}
        </div>
      </div>
    </>
  );
}

/** A window wide enough for the preview beside the list, with a pointer (a desktop). */
const WIDE = "(min-width: 1180px) and (hover: hover)";
function useWide(): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = matchMedia(WIDE);
    const up = () => setOn(mq.matches);
    mq.addEventListener("change", up);
    return () => mq.removeEventListener("change", up);
  }, []);
  return on;
}

/** A prompt the harness wrote, not the person: it opens with its own tag. */
const HARNESS_TURN = /^<[a-z][\w-]*>/i;

/** Whitespace folded, for a clamped block of an agent's words; a snippet the receiver cut
 *  at SNIPPET_CHARS ends on its last whole word and a "…", never mid-word. */
function flat(t: string | undefined): string {
  const f = (t ?? "").replace(/\s+/g, " ").trim();
  if ((t ?? "").length < SNIPPET_CHARS - 1) return f;
  return `${f.replace(/\s+\S*$/, "").replace(/[\s,;:–—-]+$/, "")}…`;
}

/** The row under the cursor, previewed beside the list: for a session (or its subagent,
 *  or a permission it waits on) its state and timer, its title, where it runs, the last
 *  ask and the latest reply; for anything else what the row does. Read only, so a screen
 *  reader keeps to the list; the row itself says the same in short. */
function Peek({ item }: { item: Item | undefined }) {
  if (!item) return <aside className="pal-peek" aria-hidden="true" />;
  const s = item.session;
  if (!s)
    return (
      <aside className="pal-peek pal-peek--plain" aria-hidden="true">
        <p className="pal-peek-title">{item.label}</p>
        {item.detail ? <p className="pal-peek-text">{item.detail}</p> : null}
        {item.keys ? (
          <p className="pal-peek-keys">
            <RowKeys keys={item.keys} />
          </p>
        ) : null}
      </aside>
    );
  const a = item.agent;
  const where = [s.machine, repoShort(s.repo) || undefined, s.branch].filter(Boolean).join(" · ");
  // A turn the harness opened itself (a `<task-notification>`, a `<command-name>`) is not
  // what the person asked: its markup is never shown as the ask.
  const asked = item.section === "Needs you" ? undefined : flat(s.progress?.user ?? s.lastUser);
  const ask = asked && !HARNESS_TURN.test(asked) ? asked : undefined;
  const reply = flat(s.progress?.assistant ?? s.lastAssistant);
  const waiting = item.section === "Needs you" ? s.openAttentions[0] : undefined;
  return (
    <aside className="pal-peek" aria-hidden="true">
      <p className="pal-peek-state">
        {a ? (
          <>
            <AgentGlyph a={a} />
            <span>{a.state === "done" ? "Done" : a.state === "stale" ? "Stale" : "Running"}</span>
            {a.state !== "done" ? (
              <>
                <span aria-hidden="true">·</span>
                <Since iso={a.startedAt} />
              </>
            ) : null}
          </>
        ) : (
          <>
            <StateDot state={s.state} decorative />
            <span className="pal-peek-word">{STATE_LABEL[s.state]}</span>
            <span aria-hidden="true">·</span>
            <Since iso={s.stateSince} />
          </>
        )}
      </p>
      <p className="pal-peek-title">{a ? agentLabel(a) : sessionTitle(s)}</p>
      <p className="pal-peek-where">{a ? sessionTitle(s) : where}</p>
      {!a && s.model ? <p className="pal-peek-where">{modelShort(s.model)}</p> : null}
      {waiting ? (
        <p className="pal-peek-text">{attentionMessage(waiting) ?? (waiting.tool ? toolLabel(waiting.tool) : null)}</p>
      ) : a?.currentTool ? (
        <p className="pal-peek-text">{toolLabel(a.currentTool.tool)}</p>
      ) : null}
      {!a && ask ? (
        <div className="pal-peek-block">
          <p className="pal-peek-label">Asked</p>
          <p className="pal-peek-text pal-peek-text--ask">
            <Inline text={ask} />
          </p>
        </div>
      ) : null}
      {!a && reply ? (
        <div className="pal-peek-block">
          <p className="pal-peek-label">{s.progress ? "Replying" : "Replied"}</p>
          <p className="pal-peek-text pal-peek-text--reply">
            <Inline text={reply} />
          </p>
        </div>
      ) : null}
    </aside>
  );
}
