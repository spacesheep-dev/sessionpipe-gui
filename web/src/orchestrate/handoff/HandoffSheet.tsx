// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The Handoff sheet (DESIGN §3.2, UX-SPEC §2): the New session
// sheet with the rows an ask needs and nothing more. From a session, fixed (a handoff is
// same-machine by protocol); to an agent, one picker: the other sessions on that machine,
// newest first, then a new session of each harness its hello lists; the folder only for a
// new session; the text prefilled once with one line of ours over the session's last
// reply; "Bring the answer back into this session" only when the hello says `handoff`;
// permission and model only as advertised. It signs one `prompt` or `start` with
// `reply_to` when the switch is on and `from` always, through the one send path
// (control/command.ts), and closes without navigating: the asking session's page shows
// the ask as a row at once. Whether it can ask is New session's gate (startGate.ts): not
// approved, the sheet is the way to approve this phone; inside its hour, Ask waits. Loaded
// once the page is idle (HandoffHost.tsx mounts it).
import type { RunLevel } from "@shared/api";
import { validModel } from "@shared/api";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSendStates } from "../../account/sendable";
import { ActionButton, EmptyState, HarnessGlyph, Toggle, withFormScrim } from "../../components/bits";
import { MoreButton } from "../../components/ContextMenu";
import { Select, type SelectOption } from "../../components/Select";
import { wrongOriginHere } from "../../control/api";
import { uuid } from "../../control/bytes";
import { sendCommand } from "../../control/command";
import { folderChoices, machineHome, tildify, typedFolder, unnamedHere } from "../../control/folders";
import { HeldNotice, useHeld } from "../../control/HeldNotice";
import type { HeldMeta } from "../../control/held";
import { HELD_WORDS } from "../../control/heldWords";
import { useGrant, useRpId } from "../../control/hooks";
import { fixedLine, fixedPermission, permissionChoices, permissionToSend } from "../../control/newSessionState";
import { canSign, isCancel, setupLabel, signerKind, signHint, tapWords } from "../../control/signer";
import { startGate } from "../../control/startGate";
import { notSentWords, PERMISSION_LABEL } from "../../control/words";
import { useListedSessions, useMachinesMap, useSession, useStore, useStreamDown } from "../../data/hooks";
import { usePhoneLayout } from "../../lib/device";
import { useFocusTrap } from "../../lib/focus";
import { harnessMark, STATE_LABEL, sessionTitle } from "../../lib/format";
import { useSheetDrag } from "../../lib/motion";
import { navigate } from "../../lib/router";
import { hintFor, matches, useShortcut } from "../../lib/shortcuts";
import { ago, useNow } from "../../lib/time";
import { NEW_WORDS, START, ThisPhone } from "../../native/accountWords";
import {
  askableSessions,
  defaultTarget,
  handoffFields,
  handoffRefusalWords,
  lastReplyOf,
  parseTarget,
  prefillText,
  type Target,
  targetValue,
} from "./handoff";
import {
  closeHandoff,
  type HandoffTarget,
  readHandoffAgent,
  readHandoffDraft,
  rememberHandoffAgent,
  saveHandoffDraft,
} from "./handoffState";
import "../../control/newSessionSheet.css";
import "./handoff.css";

const TEXT_MAX = 20_000;
const COUNTER_AT = 18_000;
/** The default on an `inherit` machine, as New session's Permission pop-up names it. */
const INHERIT_DEFAULT = "As your own sessions on this machine";

/** What an ask was when it was pressed: all its "asked" needs after a confirm. */
interface AskSent extends HeldMeta {
  target: Target;
  machineId: string;
}

export function Sheet({ open, closing }: { open: HandoffTarget; closing: boolean }) {
  const phone = usePhoneLayout();
  const session = useSession(open.session);
  const machines = useMachinesMap();
  // The agents to ask and the recent folders: the sessions the board lists.
  const sessions = useListedSessions();
  const store = useStore();
  const rp = useRpId();
  const grant = useGrant(rp);
  const secure = canSign(rp);
  const wrong = wrongOriginHere();
  const sendTo = useSendStates(rp);
  const now = useNow("coarse");
  // The app's stream is down (as the page bar says it): an ask waits for it, as a message does.
  const down = useStreamDown() !== null;
  const ref = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const name = session?.machine ?? "this machine";
  const c = session?.machine ? machines.get(session.machine)?.control : undefined;
  const harnesses = c?.harnesses ?? [];
  const others = useMemo(
    () => (session ? askableSessions(sessions.values(), session, now) : []),
    [sessions, session, now],
  );

  // ----- the first values: the draft the sheet was closed on, else the defaults -----
  const initial = useMemo(() => {
    const draft = open.reply === undefined ? readHandoffDraft(open.session) : null;
    const fromDraft = draft ? parseTarget(draft.target) : null;
    const valid =
      fromDraft &&
      (fromDraft.kind === "new" ? harnesses.includes(fromDraft.harness) : others.some((s) => s.key === fromDraft.key));
    const target =
      (valid ? fromDraft : null) ??
      (session
        ? defaultTarget({
            harnesses,
            selfHarness: session.harness,
            sessions: others,
            remembered: c ? readHandoffAgent(c.machineId) : null,
          })
        : null);
    return { draft, target };
    // Once, at open: later stream frames must not move what was picked.
  }, []);
  const [target, setTarget] = useState<Target | null>(initial.target);
  const [bringBack, setBringBack] = useState(initial.draft?.bringBack ?? true);
  const [text, setText] = useState(initial.draft?.text ?? (open.reply !== undefined ? prefillText(open.reply) : ""));
  const [busy, setBusy] = useState(false);
  const [tap, setTap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Something was edited: the draft is kept on Esc; an untouched prefill is not.
  const touched = useRef(!!initial.draft);
  const edit = <T,>(set: (v: T) => void) => {
    return (v: T) => {
      touched.current = true;
      set(v);
    };
  };

  // ----- the folder, the permission and the model of a new session -----
  const home = machineHome(c);
  const choices = useMemo(
    () =>
      session?.machine && c
        ? folderChoices({ sessions: [...sessions.values()], machine: session.machine, folders: c.folders, home })
        : { recent: [], allowed: [] },
    [session?.machine, c, sessions, home],
  );
  const ownFolder = session?.cwd ? typedFolder(session.cwd, { folders: c?.folders, home, machine: name }) : null;
  // Said only of a folder outside the machine's: a `~/…` one this page can't name is not.
  const ownOutside = !!session?.cwd && !!ownFolder && !ownFolder.ok && !unnamedHere(session.cwd, home);
  const [folder, setFolder] = useState(
    () =>
      initial.draft?.folder ??
      (ownFolder?.ok ? ownFolder.path : (choices.allowed[0]?.path ?? choices.recent[0]?.path ?? "")),
  );
  const harness = target?.kind === "new" ? target.harness : undefined;
  const opts = harness ? c?.start?.[harness] : undefined;
  const levels = permissionChoices(opts);
  const showPermission = !!harness && levels.length >= 2;
  const showModel = !!harness && !!opts && (!!opts.anyModel || !!opts.models?.length);
  const [permission, setPermission] = useState<RunLevel | undefined>(() => {
    const d = initial.draft?.permission as RunLevel | undefined;
    return d && permissionChoices(opts).includes(d) ? d : opts?.permission;
  });
  const [model, setModel] = useState(initial.draft?.model ?? "");
  const pickTarget = (v: string) => {
    const t = parseTarget(v);
    if (!t) return;
    touched.current = true;
    setTarget(t);
    setError(null);
    if (t.kind === "new") {
      const o = c?.start?.[t.harness];
      setPermission(o?.permission);
      setModel("");
    }
  };
  const listsFolders = !!c?.folders?.length;
  const folderCheck = target?.kind === "new" ? typedFolder(folder, { folders: c?.folders, home, machine: name }) : null;
  const modelOk = !model || (showModel && validModel(model) && (opts!.anyModel || !!opts!.models?.includes(model)));

  // ----- the prefill: once, from the session's last reply, unless it came with the open -----
  const lastReply = useRef<string | null>(open.reply ?? null);
  const [replyKnown, setReplyKnown] = useState(open.reply !== undefined);
  useEffect(() => {
    if (!session || open.reply !== undefined) return;
    let on = true;
    const apply = (reply: string) => {
      if (!on) return;
      lastReply.current = reply;
      setReplyKnown(true);
      if (!touched.current && !initial.draft) setText(prefillText(reply));
    };
    store.transport
      .session(session.harness, session.id, { tail: true, limit: 40 })
      .then((d) => apply(lastReplyOf(session, d.events)))
      .catch(() => apply(lastReplyOf(session)));
    return () => {
      on = false;
    };
    // Once, at open.
  }, []);

  // ----- the draft, kept while something was edited -----
  useEffect(() => {
    if (!touched.current) return;
    saveHandoffDraft(open.session, {
      text,
      ...(target ? { target: targetValue(target) } : {}),
      ...(folder ? { folder } : {}),
      bringBack,
      ...(permission ? { permission } : {}),
      ...(model ? { model } : {}),
    });
  }, [open.session, text, target, folder, bringBack, permission, model]);

  const close = () => closeHandoff();
  useFocusTrap(ref, !closing, { onClose: close, initial: "textarea, [data-ns-approve]" });
  useSheetDrag(ref, close, { handle: ".ns-grab, .ns-bar-title", enabled: phone && !closing });
  // Opened from a menu or the palette, whose own focus goes back where it was as they
  // close: take it once they have, and let Esc close the sheet from wherever it is.
  useEffect(() => {
    const t = setTimeout(() => {
      const root = ref.current;
      if (root && !root.contains(document.activeElement))
        root.querySelector<HTMLElement>("textarea, [data-ns-approve]")?.focus({ preventScroll: true });
    }, 120);
    return () => clearTimeout(t);
  }, []);
  useShortcut("back", () => close(), { priority: 10, enabled: !closing });
  // The session was forgotten under the sheet: nothing to ask from.
  useEffect(() => {
    if (!session) closeHandoff();
  }, [session]);

  // The text grows with what is in it (no grip).
  useEffect(() => {
    const ta = textRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, phone ? 10_000 : Math.round(window.innerHeight * 0.45))}px`;
  }, [text, phone]);

  // ----- what the machine advertises, and whether an ask can go there -----
  const gate = c ? startGate(name, c, { wrong, secure, hint: signHint(), send: sendTo(c) }) : null;
  // The hour's line stands in for an error while it lasts (the status line below); what was
  // refused in it is old news once it is over.
  const cooling = gate?.kind === "cooling";
  useEffect(() => {
    if (!cooling) setError(null);
  }, [cooling]);

  if (!session) return null;

  const offersBack = c?.handoff === true;
  const oldDaemon = !!c && c.ask === undefined && c.handoff === undefined;
  const nobody = !others.length && !harnesses.length;
  const fixed = harness && c ? fixedPermission(c, harness, PERMISSION_LABEL) : null;
  // A phone has its note under the row; a desktop's options line has it in one run.
  const fixedValue = fixed && (
    <span className="ns-fixed" title={START.setOn(name)}>
      {phone ? fixed.value : fixedLine(fixed)}
    </span>
  );
  const fixedNote = fixed?.note ? <span className="ns-aside">{fixed.note}</span> : null;

  const canAsk =
    !!c &&
    !gate &&
    !!rp &&
    !!target &&
    (target.kind === "session" ? others.some((s) => s.key === target.key) : harnesses.includes(target.harness)) &&
    (!folderCheck || folderCheck.ok) &&
    !!text.trim() &&
    text.length <= TEXT_MAX &&
    modelOk &&
    !down &&
    !busy;

  // Sent: the sheet closes and the asking session's page says the rest (its row). What it
  // remembers is what was asked when it was pressed, never the sheet as it is now.
  const asked = (s: AskSent) => {
    if (s.target.kind === "new") rememberHandoffAgent(s.machineId, s.target.harness);
    saveHandoffDraft(session.key, null);
    closeHandoff();
  };
  // Everything an ask is made of, as one string: a held ask goes the moment any of it
  // changes (who is asked, the switch, folder, permission, model, text).
  const sheetKey = JSON.stringify([target, bringBack, folder, permission, model, text]);
  // An ask the receiver held for a confirm: the notice above the foot, and its button.
  const held = useHeld<unknown, AskSent>(
    (_r, _h, s) => {
      asked(s);
      grant.refresh();
    },
    (e) => setError(handoffRefusalWords(e, name) ?? notSentWords(e)),
    sheetKey,
  );
  const askButton = useCallback(() => ref.current?.querySelector<HTMLElement>(".ns-start") ?? null, []);

  const ask = async () => {
    if (!canAsk || !c || !rp || !target) return;
    // A held ask's confirm is on its way: a second press would ask twice.
    if (held.confirming()) return;
    setBusy(true);
    setError(null);
    held.drop();
    const back = offersBack && bringBack;
    const fields = handoffFields({
      target,
      text: text.trim(),
      from: session.key,
      bringBack: back,
      newId: uuid(),
      ...(folderCheck?.ok ? { cwd: folderCheck.path } : {}),
      // Only what this machine's hello advertised (CONTROL.md §2), as New session does.
      ...(showPermission && permissionToSend(opts, permission)
        ? { permission: permissionToSend(opts, permission) }
        : {}),
      ...(showModel && model ? { model } : {}),
    });
    const sent: AskSent = { target, machineId: c.machineId };
    const keyAtSend = sheetKey;
    try {
      await sendCommand(rp, c.machineId, fields, { onTap: () => setTap(true), from: session.key });
      asked(sent);
    } catch (e) {
      const caught = held.catchHeld(e, sent, keyAtSend);
      if (caught === "changed") setError(HELD_WORDS.changed);
      // A prompt the person closed is no refusal: the sheet stays as it was.
      else if (!caught) setError(isCancel(e) ? null : (handoffRefusalWords(e, name) ?? notSentWords(e)));
      setBusy(false);
    } finally {
      setTap(false);
      grant.refresh();
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // The New session sheet's keys (⌘↩, ⌘⇧F): one chord for one kind of sheet.
    if (matches(e.nativeEvent, "newSession.start")) {
      e.preventDefault();
      void ask();
    } else if (matches(e.nativeEvent, "newSession.folder")) {
      e.preventDefault();
      ref.current?.querySelector<HTMLElement>("[data-hs-row=folder] button, [data-hs-row=folder] input")?.focus();
    }
    // The page's own keys stay out while the sheet has focus (Esc and Tab are the trap's).
    if (e.key !== "Tab" && e.key !== "Escape") e.stopPropagation();
  };

  const discard = () => {
    saveHandoffDraft(session.key, null);
    touched.current = true;
    setText("");
    setError(null);
  };
  const useLastReply = () => {
    touched.current = true;
    setText(prefillText(lastReply.current));
  };

  // ----- the one-fact status line (UX-SPEC §2.4) -----
  // `ready`: nothing is wrong and nothing under way; a phone's foot then says nothing.
  const status = ((): { text: string; tone?: "err"; approve?: boolean; ready?: boolean } | null => {
    // Inside the hour, one sentence says from when: also in place of a refusal for it.
    if (gate?.kind === "cooling") return { text: gate.long };
    if (error) return { text: error, tone: "err" };
    if (tap) return { text: tapWords() };
    if (busy) return { text: `Sending to ${name}…` };
    if (!c) return { text: `Pair ${name} to ask from here.` };
    if (gate?.kind === "machine") return { text: gate.long, approve: gate.approve };
    if (down) return { text: NEW_WORDS.streamAsk };
    if (nobody) return { text: `${name} hasn't said which agents it runs.` };
    if (target?.kind === "new" && folderCheck && !folderCheck.ok)
      return {
        text:
          !folder && listsFolders && !choices.allowed.length && !choices.recent.length
            ? `${name} allows no folder for a new session. Add one on the machine.`
            : folderCheck.reason,
      };
    if (model && !modelOk) return { text: `${model} isn't a model ${name} offers for ${harnessMark(harness!).label}.` };
    if (oldDaemon)
      return {
        text: `${name} needs a newer sessionpipe to bring answers back. The answer stays in the asked session.`,
      };
    if (!c.online)
      return {
        text: `${name} is offline. It asks when the machine is back, within ${c.remote ? "a day" : "an hour"}.`,
      };
    return { text: `${name} is listening.`, ready: true };
  })();
  // A browser's only, as New session's: the app's Ask brings up its own prompt.
  const passkeyNote =
    signerKind() === "passkey" && grant.exp === null && !gate ? "Ask asks for your passkey, once today." : null;

  // ----- the rows -----
  const agentOptions: SelectOption<string>[] = [
    ...others.map((s) => ({
      value: targetValue({ kind: "session", key: s.key }),
      label: sessionTitle(s),
      icon: <HarnessGlyph name={s.harness} size="sm" />,
      hint: `${STATE_LABEL[s.state]} · ${ago(s.lastAt, now).replace(/ ago$/, "")}`,
    })),
    ...harnesses.map((h, i) => ({
      value: targetValue({ kind: "new", harness: h }),
      label: `${harnessMark(h).label} · new session`,
      icon: <HarnessGlyph name={h} size="sm" />,
      divider: i === 0 && others.length > 0,
    })),
  ];
  const folderOptions: SelectOption<string>[] = [
    ...choices.recent.map((f) => ({ value: f.path, label: f.display, hint: f.repo })),
    ...choices.allowed.map((f, i) => ({
      value: f.path,
      label: f.display,
      divider: i === 0 && choices.recent.length > 0,
    })),
  ];
  const typed = (t: string): SelectOption<string> | null => {
    const r = typedFolder(t, { folders: c?.folders, home, machine: name });
    return r.ok ? { value: r.path, label: tildify(r.path, home) } : { value: t, label: t, hint: r.reason };
  };
  const permissionOptions: SelectOption<RunLevel>[] = levels.map((p) => ({
    value: p,
    label: p === "inherit" ? INHERIT_DEFAULT : PERMISSION_LABEL[p],
  }));
  const modelOptions: SelectOption<string>[] = [
    { value: "", label: "Default", hint: "the agent's own" },
    ...(opts?.models ?? []).map((x) => ({ value: x, label: x })),
  ];
  const typedModel = opts?.anyModel
    ? (t: string): SelectOption<string> =>
        validModel(t) ? { value: t, label: t } : { value: t, label: t, hint: "not a model id", disabled: true }
    : undefined;
  const capped =
    c?.mode === "safe"
      ? `${name} is in safe mode. Wider levels are set at the machine.`
      : c?.mode === "inherit"
        ? `${name} runs agents as your own sessions there. A level named here is at most Safe.`
        : undefined;

  const row = (key: string, label: string, control: ReactNode, extra?: ReactNode) => (
    <div className="ns-row" data-hs-row={key}>
      <span className="ns-label" id={`hs-${key}`}>
        {label}
      </span>
      <span className="ns-value">{control}</span>
      {extra}
    </div>
  );
  const fromText = `${sessionTitle(session)} · ${name}`;
  const rows = (
    <div className="ns-rows">
      {row(
        "from",
        "From",
        <span className="ns-fixed hs-from ellipsis" title={fromText}>
          {fromText}
        </span>,
      )}
      {row(
        "agent",
        "Agent",
        <Select<string>
          labelledBy="hs-agent"
          value={target ? targetValue(target) : null}
          onChange={pickTarget}
          options={agentOptions}
          placeholder={agentOptions.length ? "Choose…" : "None reported"}
          disabled={!agentOptions.length}
          searchable={agentOptions.length > 8}
          filterPlaceholder="Search sessions or agents"
          className="ns-sel"
        />,
      )}
      {target?.kind === "new" &&
        row(
          "folder",
          "Folder",
          listsFolders || folderOptions.length ? (
            <Select<string>
              labelledBy="hs-folder"
              value={folder || null}
              onChange={edit(setFolder)}
              options={folderOptions}
              placeholder="Choose…"
              custom={typed}
              filterPlaceholder="Search, or type a path"
              className="ns-sel mono"
            />
          ) : (
            <input
              className="ns-path mono"
              aria-labelledby="hs-folder"
              value={folder}
              onChange={(e) => edit(setFolder)(e.target.value)}
              placeholder={c?.tilde ? "~/path/on/the/machine" : "/absolute/path/on/the/machine"}
              spellCheck={false}
              autoComplete="off"
            />
          ),
          ownOutside ? <span className="ns-aside">This session's folder isn't allowed on {name}</span> : null,
        )}
    </div>
  );

  const message = (
    <div className="ns-text-wrap">
      <textarea
        ref={textRef}
        className="ns-text"
        aria-label="What should it do?"
        placeholder={replyKnown || initial.draft ? "What should it do?" : ""}
        value={text}
        maxLength={TEXT_MAX}
        onChange={(e) => edit(setText)(e.target.value)}
        rows={phone ? 6 : 5}
        data-hs-text
      />
      {text.length >= COUNTER_AT && (
        <span className="ns-count num" aria-live="polite">
          {text.length.toLocaleString()} / {TEXT_MAX.toLocaleString()}
        </span>
      )}
    </div>
  );

  const backSwitch = offersBack && (
    <Toggle on={bringBack} onChange={edit(setBringBack)} label="Bring the answer back into this session" />
  );
  const permissionSelect = showPermission && (
    <Select<RunLevel>
      labelledBy="hs-permission"
      value={permission}
      onChange={edit(setPermission)}
      options={permissionOptions}
      footer={capped}
      size={phone ? "md" : "sm"}
      align={phone ? "end" : "start"}
      className="ns-sel ns-opt-sel"
    />
  );
  const modelSelect = showModel && (
    <Select<string>
      labelledBy="hs-model"
      value={model}
      onChange={edit(setModel)}
      options={modelOptions}
      custom={typedModel}
      searchable={!!typedModel || modelOptions.length > 8}
      filterPlaceholder={typedModel ? "Search, or type a model id" : "Filter"}
      size={phone ? "md" : "sm"}
      align={phone ? "end" : "start"}
      className="ns-sel ns-opt-sel"
    />
  );

  const askKeys = hintFor("newSession.start");
  const more = () => [
    { label: "Discard draft", disabled: !text, run: discard },
    {
      label: "Use the last reply",
      disabled: !lastReply.current || text === prefillText(lastReply.current),
      run: useLastReply,
    },
  ];
  // Not approved yet: the way on is Approve this iPhone; the draft stays for when it can.
  const approveHere = () => {
    close();
    navigate("/add-device");
  };
  // On a phone the foot says one thing, and nothing when all is well, as New session's.
  const line: typeof status = !phone
    ? status
    : status && !status.ready
      ? status
      : passkeyNote
        ? { text: passkeyNote, ready: true }
        : null;
  // An Ask that is off is described by the line that says why, and by the passkey note.
  const askWhy =
    [line && (!canAsk || (phone && line.ready)) ? "hs-status" : null, passkeyNote && !phone ? "hs-passkey" : null]
      .filter(Boolean)
      .join(" ") || undefined;
  // Kept in place while empty, so what it says later is read out where it was.
  const statusLine = (line || phone) && (
    <p
      id="hs-status"
      className={`ns-status ${line?.tone === "err" ? "ns-status--err" : ""}`}
      role="status"
      aria-live="polite"
    >
      {line?.text}
      {line?.approve && (
        <>
          {" "}
          <button type="button" className="ns-status-link" onClick={approveHere} data-ns-approve>
            {setupLabel()}
          </button>
        </>
      )}
    </p>
  );
  // Not approved: nothing here could ask, so the sheet is the way to approve this device.
  const unapproved = gate?.kind === "approve";
  const empty = unapproved && (
    <EmptyState
      className="ns-empty"
      title={START.notApproved(ThisPhone())}
      actions={
        <>
          <button type="button" className="btn btn--primary" onClick={approveHere} data-ns-approve>
            {setupLabel()}
          </button>
          {!phone && (
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
          )}
        </>
      }
    />
  );

  if (phone)
    return withFormScrim(
      close,
      closing,
      <div
        className="ns-sheet ns-sheet--phone hs-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hs-title"
        ref={ref}
        data-closing={closing ? "" : undefined}
        onKeyDown={onKeyDown}
        data-handoff
      >
        <header className="ns-bar">
          <button type="button" className="ns-bar-btn" onClick={close} data-hs-cancel>
            Cancel
          </button>
          <h2 className="ns-bar-title" id="hs-title">
            Ask another agent
          </h2>
          {unapproved ? (
            <span />
          ) : (
            <button
              type="button"
              className="ns-bar-btn ns-bar-btn--start"
              onClick={() => void ask()}
              disabled={!canAsk}
              aria-busy={busy || undefined}
              aria-describedby={askWhy}
              data-hs-ask
            >
              {busy ? "Asking…" : "Ask"}
            </button>
          )}
          <span className="ns-grab" aria-hidden="true" />
        </header>
        {unapproved ? (
          <div className="ns-scroll">{empty}</div>
        ) : (
          <div className="ns-scroll">
            <div className="ns-group">{rows}</div>
            <div className="ns-group ns-group--text">{message}</div>
            {(offersBack || showPermission || fixed || showModel) && (
              <div className="ns-group">
                {offersBack && (
                  <div className="ns-row hs-switch" data-hs-row="back">
                    <span className="ns-label hs-switch-label" id="hs-back">
                      Bring the answer back
                    </span>
                    <span className="ns-value">{backSwitch}</span>
                  </div>
                )}
                {showPermission && row("permission", "Permission", permissionSelect)}
                {fixed && row("options", "Permission", fixedValue, fixedNote)}
                {showModel && row("model", "Model", modelSelect)}
              </div>
            )}
            <div className="ns-group-foot">
              <HeldNotice h={held} focusBack={askButton} />
              {statusLine}
              {text && (
                <button type="button" className="ns-discard" onClick={discard}>
                  Discard draft
                </button>
              )}
            </div>
          </div>
        )}
      </div>,
    );

  return (
    <>
      <button
        type="button"
        className="menu-scrim menu-scrim--dialog ns-scrim"
        aria-label="Close"
        onClick={close}
        data-closing={closing ? "" : undefined}
        data-dismiss
      />
      <div
        className="ns-sheet hs-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hs-title"
        ref={ref}
        data-closing={closing ? "" : undefined}
        onKeyDown={onKeyDown}
        data-handoff
      >
        <h2 className="ns-title" id="hs-title">
          Ask another agent
        </h2>
        {unapproved ? (
          empty
        ) : (
          <>
            {rows}
            {message}
            {(offersBack || showPermission || fixed || showModel) && (
              <div className="ns-opts hs-opts">
                {offersBack && (
                  <span className="ns-opt hs-switch" data-hs-row="back">
                    {backSwitch}
                    <span className="ns-opt-label hs-switch-label">Bring the answer back into this session</span>
                  </span>
                )}
                {showPermission && (
                  <span className="ns-opt" data-hs-row="permission">
                    <span className="ns-opt-label" id="hs-permission">
                      Permission
                    </span>
                    {permissionSelect}
                  </span>
                )}
                {fixed && (
                  <span className="ns-opt" data-hs-row="options">
                    <span className="ns-opt-label">Permission</span>
                    {fixedValue}
                  </span>
                )}
                {showModel && (
                  <span className="ns-opt" data-hs-row="model">
                    <span className="ns-opt-label" id="hs-model">
                      Model
                    </span>
                    {modelSelect}
                  </span>
                )}
              </div>
            )}
            <HeldNotice h={held} focusBack={askButton} />
            <footer className="ns-foot">
              {statusLine}
              <span className="ns-actions">
                <MoreButton build={more} label="Draft" title={() => "Ask another agent"} className="ns-more" />
                <button type="button" className="btn" onClick={close} data-hs-cancel>
                  Cancel
                </button>
                <ActionButton
                  className="btn btn--primary ns-start"
                  onClick={ask}
                  disabled={!canAsk && !busy}
                  pending={busy}
                  pendingLabel="Asking…"
                  aria-describedby={askWhy}
                  data-tip={passkeyNote ?? undefined}
                  data-tip-side="top"
                  data-hs-ask
                >
                  Ask {askKeys && <kbd className="ns-kbd">{askKeys}</kbd>}
                </ActionButton>
              </span>
              {passkeyNote && (
                <span className="sr-only" id="hs-passkey">
                  {passkeyNote}
                </span>
              )}
            </footer>
          </>
        )}
      </div>
    </>
  );
}
