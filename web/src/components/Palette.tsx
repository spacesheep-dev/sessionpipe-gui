// SPDX-License-Identifier: Apache-2.0
// The command palette: ⌘K / ctrl+K on any page (a view plugin, the split panel) opens one
// input over the page. Sessions (fuzzy over title, repo, branch, machine, model; the ones
// that need you or work first), the open permissions ("Allow Read in …"), actions on the
// session in view (a message, open beside, open as page, forget) and the places to go.
// Enter runs the row under the cursor, shift+Enter opens a session beside, `>` keeps only
// actions, `#` only places. A row with › pushes a second list in place (the machines to
// start on, the appearance, the skin); Esc or Backspace on an empty field steps back.
// Typing a paired machine or a repo offers "New session on studio-mac in acme/billing"
// first. Messages and answers leave the way the control strip sends them
// (web/src/control/command.ts). Mounted once, from app.tsx.
import type { AgentRun, MachineSummary, SessionSummary } from "@shared/api";
import { LABEL_COLORS, sessionKey, splitKey } from "@shared/api";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { sendCommand } from "../control/command";
import { useRpId } from "../control/hooks";
import { type NewSessionTarget, openNewSession } from "../control/newSessionState";
import { insecureHint, passkeysAvailable } from "../control/webauthn";
import { sendErrorWords } from "../control/words";
import { byStateThenRecent, useAppState, useLabels, useStore } from "../data/hooks";
import { agentLabel, agentMatches, openAgent } from "../lib/agents";
import { modelShort, repoShort, sessionTitle } from "../lib/format";
import { type FieldsMatch, fuzzyFields } from "../lib/fuzzy";
import { labelName, labelQuery, setLabel } from "../lib/labels";
import { usePresence } from "../lib/motion";
import { navigate, parseRoute, sessionPath, useRoute } from "../lib/router";
import { useSimple } from "../lib/settings";
import { hintFor, matches, useShortcut, useShortcutMap } from "../lib/shortcuts";
import { openSplit, useSplitKey } from "../lib/split";
import { setSkin, setTextSize, setTheme, TEXT_SIZES, type Theme, useSettings } from "../lib/theme";
import { ago, useNow } from "../lib/time";
import { useThemes } from "../themes/host/registry";
import { AgentGlyph } from "./AgentRow";
import { Kbd, StateDot } from "./bits";
import { answerable } from "./ControlStrip";
import { LabelDot, LabelSwatch } from "./LabelDot";
import { APPEARANCE, noContextMenu, SIZE_NAME, SkinSwatch, useListedSkins } from "./QuickSettings";
import "../styles/palette.css";

/** The shortcut as this platform writes it, for hints. */
export const PALETTE_KEY = /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "") ? "⌘K" : "Ctrl K";

// ----- open state: a tiny external store, so a hint anywhere can open the palette -----

let isOpen = false;
/** Bumped on every open: a palette reopened during its exit starts fresh. */
let opens = 0;
/** Where focus was when the palette opened; it goes back there on close. */
let returnTo: HTMLElement | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function openPalette(): void {
  if (isOpen) return;
  returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  isOpen = true;
  opens++;
  emit();
}

export function closePalette(): void {
  if (!isOpen) return;
  isOpen = false;
  emit();
  const el = returnTo;
  returnTo = null;
  if (el?.isConnected) el.focus();
  // Focus leaves the palette the moment it closes, not when its exit ends: the next key
  // ("g f" straight after Esc) is the page's, never swallowed by the fading field.
  const left = document.activeElement;
  if (left instanceof HTMLElement && left.closest(".pal")) left.blur();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const usePaletteOpen = () =>
  useSyncExternalStore(
    subscribe,
    () => isOpen,
    () => isOpen,
  );

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

/** ⌘K / ctrl+K (the `palette.toggle` action, rebindable on /shortcuts); the dialog while open. */
export function Palette() {
  const open = usePaletteOpen();
  useShortcut("palette.toggle", () => (isOpen ? closePalette() : openPalette()));
  // It stays mounted for its exit (zoom-out, --dur-exit), inert, then goes.
  const { mounted, closing } = usePresence(open);
  return mounted ? <PaletteDialog key={opens} closing={closing} /> : null;
}

// ----- the rows -----

type Section = "Sessions" | "Needs you" | "Actions" | "Go to";
const SECTIONS: Section[] = ["Sessions", "Needs you", "Actions", "Go to"];

interface Item {
  id: string;
  section: Section;
  label: ReactNode;
  detail?: ReactNode;
  /** The row's mark: a session's state dot, or a small glyph. */
  mark: ReactNode;
  age?: string;
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
  | { id: "label"; session: string };

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
            : "Label";

/** What a paired machine can do, in the picker's words: "safe mode", "offline",
 *  "sessionpipe 0.9" (no start options). */
export function machineHint(m: MachineSummary): string {
  const c = m.control;
  if (!c) return "";
  return [
    c.online ? "" : "offline",
    c.mode === "safe" ? "safe mode" : c.mode === "auto" ? "auto" : "",
    c.start ? "" : c.version ? `sessionpipe ${c.version}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** `>` keeps only actions, `#` only places; the rest is the text to match. `is:subagent`
 *  keeps only subagents (it is taken off the text). */
function parseQuery(q: string): { only: Section | null; text: string; agentsOnly: boolean } {
  const s = q.trimStart();
  if (s.startsWith(">")) return { only: "Actions", text: s.slice(1).trim(), agentsOnly: false };
  if (s.startsWith("#")) return { only: "Go to", text: s.slice(1).trim(), agentsOnly: false };
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

function PaletteDialog({ closing = false }: { closing?: boolean }) {
  const store = useStore();
  const { sessions, machines } = useAppState();
  const labels = useLabels();
  const route = useRoute();
  const splitActive = useSplitKey();
  const { themes } = useThemes();
  const rp = useRpId();
  const now = useNow();
  // Simple mode: fewer action rows (a message, open as page); the rest stay in Advanced.
  const simple = useSimple();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
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
      if (!rp || !passkeysAvailable(rp)) return { ok: false, why: insecureHint() };
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

  const { items, promote } = useMemo((): { items: Item[]; promote: boolean } => {
    if (sub) return { items: subItems(sub), promote: false };
    let promote = false;
    const parsed = parseQuery(q);
    const { only, agentsOnly } = parsed;
    // `label:` tokens narrow the sessions; the rest of the words are matched.
    const lq = labelQuery(labels, parsed.text);
    const text = lq.rest;
    const want = (s: Section) => only === null || only === s;
    const sorted = [...sessions.values()].filter((s) => lq.test(s.key)).sort(byStateThenRecent);
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
      age: ago(a.endedAt ?? a.lastAt, now),
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
      detail: [
        s.machine ? <Hit key="m" text={s.machine} at={m?.positions[1]} /> : null,
        repoShort(s.repo) ? <Hit key="r" text={repoShort(s.repo)} at={m?.positions[2]} /> : null,
      ]
        .filter(Boolean)
        .flatMap((n, i) => (i ? [" · ", n] : [n])),
      age: ago(s.lastAt, now),
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

    if (want("Needs you")) {
      for (const s of sorted) {
        for (const a of s.openAttentions) {
          if (a.kind !== "permission" || !answerable(a) || answered.has(a.attentionId)) continue;
          const title = sessionTitle(s);
          for (const allow of [true, false]) {
            const verb = allow ? "Allow" : "Deny";
            const label = `${verb} ${a.tool ?? "this"}`;
            const m = text ? fuzzyFields(text, [label, title, s.machine ?? ""]) : null;
            if (text && !m) continue;
            out.push({
              id: `a:${a.attentionId}:${verb}`,
              section: "Needs you",
              mark: <StateDot state="needs_you" decorative />,
              label: (
                <>
                  {verb} <code>{a.tool ?? "this"}</code> in <Hit text={title} at={m?.positions[1]} />
                </>
              ),
              detail: a.message ? a.message : undefined,
              age: ago(a.at, now),
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
          { id: "skin", verb: "Skin…", now: display.skin.name, words: "theme colours colors paper spacesheep" },
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
      const places: { label: string; detail?: string; key?: string; run: () => void }[] = [
        { label: "Board", key: "nav.board", run: () => navigate("/") },
        { label: "Feed", key: "nav.feed", run: () => navigate("/feed") },
        { label: "Machines", key: "nav.machines", run: () => navigate("/machines") },
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
        const m = text ? fuzzyFields(text, [p.label]) : null;
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
    // The cursor walks the rows in the order they are drawn.
    if (promote) out.sort((a, b) => Number(b.section === "Actions") - Number(a.section === "Actions"));
    return { items: out, promote };

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
      }
      if (text) rows.sort((a, b) => b.score - a.score);
      return rows;
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
    now,
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
  ]);

  // A new query starts at the top; a shorter list pulls the cursor in.
  useEffect(() => setCursor(0), [q, stack.length]);
  useEffect(() => {
    if (cursor >= items.length) setCursor(Math.max(0, items.length - 1));
  }, [items.length, cursor]);
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  // The list ends on a whole row at its fold, never half a row (and again on a resize).
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    snapToRows(list);
    const on = () => snapToRows(list);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  });

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
      setCursor((c) => Math.min(items.length - 1, c + 1));
    } else if (is("palette.up")) {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === "Home" && !q) {
      e.preventDefault();
      setCursor(0);
    } else if (e.key === "End" && !q) {
      e.preventDefault();
      setCursor(Math.max(0, items.length - 1));
    } else if ((is("palette.beside") || is("palette.run")) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const it = items[cursor];
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
            : "Sessions, actions, pages…";
  const activeId = items[cursor] ? `pal-opt-${cursor}` : undefined;
  // A typed machine puts its start first; otherwise sessions lead.
  const order: Section[] = promote ? ["Actions", "Sessions", "Needs you", "Go to"] : SECTIONS;
  const paired = [...machines.values()].some((m) => m.control);
  const noResults = items.length === 0 && mode.kind === "search";

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
                      aria-selected={i === cursor}
                      aria-haspopup={it.sub ? "listbox" : undefined}
                      data-i={i}
                      data-section={sec}
                      data-kid={it.kid}
                      data-parent={it.parent ? "" : undefined}
                      onMouseMove={() => i !== cursor && setCursor(i)}
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
                      ) : it.age ? (
                        <span className="pal-age num">{it.age}</span>
                      ) : null}
                    </div>
                  ),
                ),
              ];
            })}
          </div>
        )}

        {note && <p className={`pal-note ${note.err ? "pal-note--err" : ""}`}>{note.text}</p>}

        <div className="pal-foot" aria-hidden="true">
          {mode.kind === "search" ? (
            <>
              <FootKey keys="↑↓">Move</FootKey>
              <FootKey keys="↵">{items[cursor]?.sub ? "Choose" : "Open"}</FootKey>
              {!sub && <FootKey keys="⇧↵">Beside</FootKey>}
              <span className="pal-foot-spring" />
              {sub ? (
                <FootKey keys="esc">Back</FootKey>
              ) : (
                <>
                  <FootKey keys=">">Actions</FootKey>
                  <FootKey keys="#">Go to</FootKey>
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
