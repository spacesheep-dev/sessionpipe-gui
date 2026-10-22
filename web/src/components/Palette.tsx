// SPDX-License-Identifier: Apache-2.0
// The command palette: ⌘K / ctrl+K on any page (a view plugin, the split panel) opens one
// input over the page. Sessions (fuzzy over title, repo, branch, machine, model; the ones
// that need you or work first), the open permissions ("Allow Read in …"), actions on the
// session in view (a message, open beside, open as page, forget) and the places to go.
// Enter runs the row under the cursor, shift+Enter opens a session beside, `>` keeps only
// actions, `#` only places. Messages and answers leave the way the control strip sends
// them (web/src/control/command.ts). Mounted once, from app.tsx.
import type { SessionSummary } from "@shared/api";
import { sessionKey, splitKey } from "@shared/api";
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
import { insecureHint, passkeysAvailable } from "../control/webauthn";
import { sendErrorWords } from "../control/words";
import { byStateThenRecent, useAppState, useStore } from "../data/hooks";
import { modelShort, repoShort, sessionTitle } from "../lib/format";
import { type FieldsMatch, fuzzyFields } from "../lib/fuzzy";
import { navigate, parseRoute, sessionPath, useRoute } from "../lib/router";
import { useSimple } from "../lib/settings";
import { matches, useShortcut } from "../lib/shortcuts";
import { openSplit, useSplitKey } from "../lib/split";
import { ago, useNow } from "../lib/time";
import { useThemes } from "../themes/host/registry";
import { StateDot } from "./bits";
import { answerable } from "./ControlStrip";
import { noContextMenu } from "./QuickSettings";
import "../styles/palette.css";

/** The shortcut as this platform writes it, for hints. */
export const PALETTE_KEY = /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "") ? "⌘K" : "Ctrl K";

// ----- open state: a tiny external store, so a hint anywhere can open the palette -----

let isOpen = false;
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
  emit();
}

export function closePalette(): void {
  if (!isOpen) return;
  isOpen = false;
  emit();
  const el = returnTo;
  returnTo = null;
  if (el?.isConnected) el.focus();
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
  return open ? <PaletteDialog /> : null;
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
  score: number;
  run: (mods: { beside: boolean }) => void | Promise<void>;
}

type Mode =
  | { kind: "search" }
  | { kind: "prompt"; session: SessionSummary }
  | { kind: "forget"; session: SessionSummary };

/** `>` keeps only actions, `#` only places; the rest is the text to match. */
function parseQuery(q: string): { only: Section | null; text: string } {
  const s = q.trimStart();
  if (s.startsWith(">")) return { only: "Actions", text: s.slice(1).trim() };
  if (s.startsWith("#")) return { only: "Go to", text: s.slice(1).trim() };
  return { only: null, text: s.trim() };
}

/** Text with the matched letters underlined (a hairline, never a block). */
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

/** One hint in the footer: the keys as a quiet string, then what they do. */
const FootKey = ({ keys, children }: { keys: string; children: string }) => (
  <span className="pal-foot-key">
    <span className="keys">
      <kbd>{keys}</kbd>
    </span>
    {children}
  </span>
);

const ACTIVE = new Set(["needs_you", "working"]);

function PaletteDialog() {
  const store = useStore();
  const { sessions, machines } = useAppState();
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

  const items = useMemo((): Item[] => {
    const { only, text } = parseQuery(q);
    const want = (s: Section) => only === null || only === s;
    const sorted = [...sessions.values()].sort(byStateThenRecent);
    const out: Item[] = [];
    const sessionRow = (s: SessionSummary, m: FieldsMatch | null): Item => ({
      id: `s:${s.key}`,
      section: "Sessions",
      mark: <StateDot state={s.state} decorative />,
      label: <Hit text={sessionTitle(s)} at={m?.positions[0]} />,
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

    if (want("Sessions")) {
      if (!text) out.push(...sorted.slice(0, 8).map((s) => sessionRow(s, null)));
      else {
        const rows: Item[] = [];
        for (const s of sorted) {
          const m = fuzzyFields(text, [
            sessionTitle(s),
            s.machine ?? "",
            repoShort(s.repo),
            s.branch ?? "",
            `${modelShort(s.model)} ${s.model ?? ""}`,
          ]);
          if (m) rows.push(sessionRow(s, m));
        }
        rows.sort((a, b) => b.score - a.score);
        out.push(...rows.slice(0, 12));
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
        const add = (verb: string, run: Item["run"], glyph = "›") => {
          const m = text ? fuzzyFields(text, [verb, title]) : null;
          if (text && !m) return;
          rows.push({
            id: `x:${verb}:${s.key}`,
            section: "Actions",
            mark: <Glyph>{glyph}</Glyph>,
            label: <Hit text={verb} at={m?.positions[0]} />,
            detail: <Hit text={title} at={m?.positions[1]} />,
            score: (m?.score ?? 0) + (isCtx ? 1 : 0),
            run,
          });
        };
        add("Send a message…", () => {
          setMode({ kind: "prompt", session: s });
          setQ("");
          setNote(null);
          const can = sendable(s);
          if (!can.ok) setNote({ text: can.why, err: true });
        });
        if (!simple && !(isCtx && splitActive === s.key && !onItsPage(s)))
          add("Open beside", () => {
            closePalette();
            openSplit(s.key);
          });
        if (!onItsPage(s))
          add("Open as page", () => {
            closePalette();
            navigate(sessionPath(s.harness, s.id));
          });
        if (!simple) add("Forget…", () => setMode({ kind: "forget", session: s }));
      }
      if (text) rows.sort((a, b) => b.score - a.score);
      out.push(...rows.slice(0, only === "Actions" ? 40 : 8));
    }

    if (want("Go to")) {
      const places: { label: string; detail?: string; run: () => void }[] = [
        { label: "Board", run: () => navigate("/") },
        { label: "Feed", run: () => navigate("/feed") },
        { label: "Machines", run: () => navigate("/machines") },
        { label: "Connect", run: () => navigate("/connect") },
      ];
      for (const p of ["Inbox", "Review", "Setup"]) {
        const path = `/${p.toLowerCase()}`;
        if (parseRoute(path).name !== "missing") places.push({ label: p, run: () => navigate(path) });
      }
      for (const t of themes) {
        if (t.error) continue;
        places.push({
          label: t.name || t.id,
          detail: "view",
          run: () => navigate(`/t/${encodeURIComponent(t.id)}`),
        });
      }
      places.push({ label: "Views", detail: "install, link, remove", run: () => navigate("/themes") });
      places.push({
        label: "Shortcuts",
        detail: "every key, and change any",
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
    return out;
  }, [q, sessions, now, ctx, ctxKey, splitActive, themes, answered, rp, sendable, act, onItsPage, simple]);

  // A new query starts at the top; a shorter list pulls the cursor in.
  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    if (cursor >= items.length) setCursor(Math.max(0, items.length - 1));
  }, [items.length, cursor]);
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

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
    if (e.key === "Escape" || is("palette.close")) {
      e.preventDefault();
      if (mode.kind !== "search") {
        setMode({ kind: "search" });
        setQ("");
        setNote(null);
      } else closePalette();
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
      : only === "Actions"
        ? "An action…"
        : only === "Go to"
          ? "A page or a view…"
          : "Sessions, actions, pages…";
  const activeId = items[cursor] ? `pal-opt-${cursor}` : undefined;

  return (
    <>
      <button type="button" className="pal-scrim" aria-label="Close" onClick={closePalette} data-dismiss />
      <div
        className="pal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={dialogRef}
        onKeyDown={onKey}
        onContextMenu={noContextMenu}
        data-mode={mode.kind}
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
              <span className="pal-busy">Sending…</span>
            ) : (
              <button type="button" className="pal-cancel" onClick={closePalette}>
                Cancel
              </button>
            )}
          </div>
        )}

        {mode.kind === "search" && (
          <div className="pal-list" role="listbox" id="pal-list" ref={listRef} aria-label="Results">
            {items.length === 0 && <p className="pal-empty">Nothing matches{text ? ` “${text}”` : ""}.</p>}
            {SECTIONS.map((sec) => {
              const first = items.findIndex((it) => it.section === sec);
              if (first < 0) return null;
              return [
                <div className="pal-section" role="presentation" key={`h:${sec}`}>
                  {sec}
                </div>,
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
                      data-i={i}
                      data-section={sec}
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
                      {it.age ? <span className="pal-age num">{it.age}</span> : null}
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
              <FootKey keys="↵">Open</FootKey>
              <FootKey keys="⇧↵">Beside</FootKey>
              <span className="pal-foot-spring" />
              <FootKey keys=">">Actions</FootKey>
              <FootKey keys="#">Go to</FootKey>
            </>
          ) : (
            <FootKey keys="esc">Back</FootKey>
          )}
        </div>
      </div>
    </>
  );
}
