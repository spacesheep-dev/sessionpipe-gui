// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. New session's sheet: one sheet, Mail's compose (STEER-SPEC B.3).
// Where it runs (machine, agent, folder), what it should do (the message and its files),
// then the options the machine's hello advertises (permission, model) and nothing it does
// not. Each agent says how much its account has left on the chosen machine (lib/limits.ts
// accountFor; the pool's current account and count where the machine pools them), and
// nothing for a harness with no numbers; it orders, disables or picks none. It signs one CONTROL.md §6 `start` with the day grant and hands it to the machine's
// daemon through POST /api/ui/control/send, then opens the new session's page, which fills
// in as the agent starts (Starting.tsx). The GUI runs nothing itself: the machine is the
// gate, and a choice it did not advertise is never sent (a daemon that predates a field
// ignores it). A desktop sheet drops from under the title bar, 640 px wide, and lifts back
// into it as it closes; a phone's is full height with Cancel and Start in its top bar, and
// can be pulled down by its top to dismiss. With no machine paired it is an empty state
// with the one way on, not a disabled form. Loaded once the page is idle (NewSession.tsx
// mounts it).
import type { MachineSummary, RunLevel, StartFile } from "@shared/api";
import { START_FILE_MAX_BYTES, START_FILES_MAX, START_FILES_TOTAL_BYTES, sessionKey, validModel } from "@shared/api";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActionButton, EmptyState, HarnessGlyph } from "../components/bits";
import { MoreButton } from "../components/ContextMenu";
import { Select, type SelectOption } from "../components/Select";
import { useAppState, useLimits, useMachines } from "../data/hooks";
import { useFocusTrap } from "../lib/focus";
import "../lib/acp";
import { bytes, harnessMark } from "../lib/format";
import { reducedMotion, tokenMs, useSheetDrag } from "../lib/motion";
import { navigate, sessionPath } from "../lib/router";
import { hintFor, matches, useShortcut } from "../lib/shortcuts";
import { useNow } from "../lib/time";
import { controlApi, wrongOriginHere } from "./api";
import { uuid } from "./bytes";
import { sendCommand } from "./command";
import { folderChoices, machineHome, tildify, typedFolder } from "./folders";
import { useGrant, useRpId } from "./hooks";
import {
  agentLeft,
  closeNewSession,
  type Draft,
  fixedPermission,
  getBoardFilter,
  machineFacts,
  type NewSessionTarget,
  permissionChoices,
  permissionToSend,
  pickContext,
  pruneRemembered,
  readDraft,
  readLast,
  readRemembered,
  rememberStart,
  saveDraft,
} from "./newSessionState";
import { sentence } from "./PendingDevices";
import { canSign, machineTakes, setupWords, signerKind, signHint, updateWords, useOwnKeys } from "./signer";
import { PERMISSION_LABEL, sendErrorWords, WRONG_ORIGIN } from "./words";
import "./newSessionSheet.css";

/** A level's one line in the Permission pop-up (only the sheet shows them, so they live here). */
const PERMISSION_HINT: Record<RunLevel, string> = {
  read: "Reads and plans; changes nothing",
  safe: "Only what the folder already allows; the rest is denied and listed",
  edits: "Also edits files in the folder",
  auto: "The agent's own automatic approval",
  inherit: "No permission flag: the agent's own settings there decide, which can mean no checks",
};
/** The default on an `inherit` machine, as the Permission pop-up names it. */
const INHERIT_DEFAULT = "As your own sessions on this machine";

const PHONE = "(max-width: 839px)";
const TEXT_MAX = 20_000;
const COUNTER_AT = 18_000;

function usePhone(): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = matchMedia(PHONE);
    const up = () => setOn(mq.matches);
    mq.addEventListener("change", up);
    return () => mq.removeEventListener("change", up);
  }, []);
  return on;
}

/** A file on its way into the start: uploading, held (its entry), or refused in place. */
interface FileItem {
  key: string;
  name: string;
  size: number;
  entry?: StartFile;
  error?: string;
}

/** Why a machine cannot take a start from this page, short (the list's secondary text). */
function blocker(
  m: MachineSummary,
  o: { wrong: string | null; secure: boolean; mine: ReadonlySet<string> },
): { short: string; long: string } | null {
  const c = m.control;
  if (!c) return { short: "not paired", long: `Pair ${m.name} from its terminal to start sessions there.` };
  if (o.wrong) return { short: "can't sign from this address", long: WRONG_ORIGIN(o.wrong) };
  const device = signerKind() === "device";
  if (!o.secure)
    return { short: device ? "can't sign here" : "can't sign from this address", long: `${sentence(signHint())}.` };
  if (!machineTakes(c)) return { short: "needs a newer sessionpipe", long: updateWords(m.name) };
  if (!c.keys.some((k) => o.mine.has(k.id)))
    return device
      ? { short: `${m.name} doesn't trust this Mac`, long: setupWords(m.name) }
      : {
          short: `no passkey here that ${m.name} trusts`,
          long: `${m.name} trusts no passkey from this browser. Add this device from one it trusts.`,
        };
  return null;
}

export function Sheet({ target, closing }: { target: NewSessionTarget; closing: boolean }) {
  const phone = usePhone();
  const machines = useMachines();
  const { sessions, snapshotAt } = useAppState();
  const rp = useRpId();
  const grant = useGrant(rp);
  const secure = canSign(rp);
  const wrong = wrongOriginHere();
  const own = useOwnKeys(rp);
  const mine = useMemo(() => new Set(own.map((k) => k.id)), [own]);
  const ref = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Paired machines first (each list in name order), then the ones a start cannot reach.
  const listed = useMemo(
    () => [...machines.filter((m) => m.control), ...machines.filter((m) => !m.control)],
    [machines],
  );
  const why = useCallback((m: MachineSummary) => blocker(m, { wrong, secure, mine }), [wrong, secure, mine]);

  // ----- the first values: an explicit target, the draft, the board's context -----
  const initial = useMemo(() => {
    const draft = target.text !== undefined ? null : readDraft();
    const explicit = target.machine ?? (target.text === undefined ? draft?.machine : undefined);
    const ctx = pickContext({
      target: { ...target, machine: explicit, harness: target.harness ?? draft?.harness },
      filter: getBoardFilter(),
      last: readLast(),
      sessions: [...sessions.values()],
      machines: listed.filter((m) => m.control).map((m) => m.name),
    });
    return { draft, ctx };
    // Read once, when the sheet opens: later stream frames must not move what was picked.
  }, []);

  const [machine, setMachineRaw] = useState<string | undefined>(initial.ctx.machine);
  const m = listed.find((x) => x.name === machine);
  const c = m?.control;
  const valuesFor = useCallback(
    (name: string | undefined, prefer: NewSessionTarget = {}) => {
      const mm = listed.find((x) => x.name === name);
      const cc = mm?.control;
      if (!mm || !cc) return { harness: prefer.harness, folder: prefer.cwd ?? "" };
      const r = pruneRemembered(readRemembered(cc.machineId), cc, mm.name);
      const harnesses = cc.harnesses ?? [];
      const harness =
        prefer.harness && harnesses.includes(prefer.harness)
          ? prefer.harness
          : (r.harness ?? (harnesses.includes("claude-code") ? "claude-code" : harnesses[0]));
      const choices = folderChoices({
        sessions: [...sessions.values()],
        machine: mm.name,
        folders: cc.folders,
        home: machineHome(cc),
      });
      let folder = "";
      if (prefer.cwd) {
        const t = typedFolder(prefer.cwd, { folders: cc.folders, home: machineHome(cc), machine: mm.name });
        folder = t.ok ? t.path : prefer.cwd;
      } else folder = r.cwd ?? choices.recent[0]?.path ?? choices.allowed[0]?.path ?? "";
      const opts = harness ? cc.start?.[harness] : undefined;
      const permission: RunLevel | undefined =
        prefer.permission && permissionChoices(opts).includes(prefer.permission)
          ? prefer.permission
          : r.harness === harness && r.permission
            ? r.permission
            : opts?.permission;
      const modelOk = (x: string | undefined) => !!x && !!opts && (opts.anyModel || !!opts.models?.includes(x));
      const model = modelOk(prefer.model) ? prefer.model! : r.harness === harness && modelOk(r.model) ? r.model! : "";
      return { harness, folder, permission, model };
    },
    [listed, sessions],
  );

  const first = useMemo(() => {
    const d = initial.draft;
    const fromDraft = d && !target.machine && d.machine === initial.ctx.machine;
    const prefer: NewSessionTarget = {
      ...(fromDraft ? { harness: d.harness, cwd: d.folder, permission: d.permission, model: d.model } : {}),
      ...Object.fromEntries(Object.entries(target).filter(([, v]) => v !== undefined)),
      ...(initial.ctx.harness && !target.harness && !fromDraft ? { harness: initial.ctx.harness } : {}),
    };
    return valuesFor(initial.ctx.machine, prefer);
    // Once, at open.
  }, []);
  const [harness, setHarness] = useState<string | undefined>(first.harness);
  const [folder, setFolder] = useState(first.folder);
  const [permission, setPermission] = useState<RunLevel | undefined>(first.permission);
  const [model, setModel] = useState(first.model ?? "");
  const [text, setText] = useState(target.text ?? initial.draft?.text ?? "");
  const [files, setFiles] = useState<FileItem[]>(() =>
    (target.files ?? initial.draft?.files ?? []).map((f) => ({ key: f.sha256, name: f.name, size: f.size, entry: f })),
  );
  const [busy, setBusy] = useState(false);
  const [tap, setTap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Opened before the stream's first snapshot (`?new=1` on a fresh load): the machines
  // arrive a moment later, and the context is worked out then, once.
  const settled = useRef(!!initial.ctx.machine);
  useEffect(() => {
    if (settled.current) return;
    const names = listed.filter((x) => x.control).map((x) => x.name);
    if (!names.length) return;
    settled.current = true;
    const ctx = pickContext({
      target,
      filter: getBoardFilter(),
      last: readLast(),
      sessions: [...sessions.values()],
      machines: names,
    });
    if (!ctx.machine) return;
    const prefer: NewSessionTarget = {
      ...Object.fromEntries(Object.entries(target).filter(([, v]) => v !== undefined)),
      ...(ctx.harness && !target.harness ? { harness: ctx.harness } : {}),
    };
    const v = valuesFor(ctx.machine, prefer);
    setMachineRaw(ctx.machine);
    setHarness(v.harness);
    setFolder(v.folder);
    setPermission(v.permission);
    setModel(v.model ?? "");
  }, [listed, sessions, target, valuesFor]);

  const setMachine = (name: string) => {
    if (name === machine) return;
    setMachineRaw(name);
    const v = valuesFor(name);
    setHarness(v.harness);
    setFolder(v.folder);
    setPermission(v.permission);
    setModel(v.model ?? "");
    setError(null);
  };
  const pickHarness = (h: string) => {
    setHarness(h);
    const opts = c?.start?.[h];
    const r = c ? readRemembered(c.machineId) : {};
    setPermission(
      r.harness === h && r.permission && permissionChoices(opts).includes(r.permission)
        ? r.permission
        : opts?.permission,
    );
    setModel(r.harness === h && r.model && opts && (opts.anyModel || opts.models?.includes(r.model)) ? r.model : "");
  };

  // ----- what the machine advertises -----
  const blocked = m ? why(m) : null;
  const harnesses = c?.harnesses ?? [];
  const opts = harness ? c?.start?.[harness] : undefined;
  // On an inherit machine the default ("As your own sessions") is one of the choices.
  const levels = permissionChoices(opts);
  const showPermission = levels.length >= 2;
  const showModel = !!opts && (!!opts.anyModel || !!opts.models?.length);
  const takesFiles = c?.files === true;
  const listsFolders = !!c?.folders?.length;
  const folderCheck = machine
    ? typedFolder(folder, { folders: c?.folders, home: machineHome(c), machine })
    : ({ ok: false, reason: "Choose a machine" } as const);
  const uploading = files.some((f) => !f.entry && !f.error);
  const fileErrors = files.some((f) => f.error);
  const modelOk = !model || (showModel && validModel(model) && (opts!.anyModel || !!opts!.models?.includes(model)));

  // ----- the draft, kept per device until it is sent or discarded -----
  useEffect(() => {
    const d: Draft = {
      ...(machine ? { machine } : {}),
      ...(harness ? { harness } : {}),
      ...(folder ? { folder } : {}),
      text,
      ...(permission ? { permission } : {}),
      ...(model ? { model } : {}),
      ...(files.some((f) => f.entry) ? { files: files.flatMap((f) => (f.entry ? [f.entry] : [])) } : {}),
    };
    saveDraft(d);
  }, [machine, harness, folder, text, permission, model, files]);

  const close = useCallback(() => closeNewSession(), []);
  const initialFocus = !machine
    ? "[data-ns-row=machine] button"
    : !harness
      ? "[data-ns-row=agent] button"
      : !folderCheck.ok
        ? "[data-ns-row=folder] button, [data-ns-row=folder] input"
        : "textarea";
  useFocusTrap(ref, !closing, { onClose: close, initial: initialFocus });
  // A phone's sheet follows the finger down from its top, and goes past 40 % or a flick.
  useSheetDrag(ref, close, { handle: ".ns-grab, .ns-bar-title", enabled: phone && !closing });
  // Opened from the palette or a menu, whose own focus goes back where it was as they
  // close: take it once they have, and let Esc close the sheet from wherever it is.
  useEffect(() => {
    const t = setTimeout(() => {
      const root = ref.current;
      if (root && !root.contains(document.activeElement))
        root.querySelector<HTMLElement>(initialFocus)?.focus({ preventScroll: true });
    }, 120);
    return () => clearTimeout(t);
    // Once, at open.
  }, []);
  useShortcut("back", () => close(), { priority: 10, enabled: !closing });

  // The message grows with what is in it (no grip).
  useEffect(() => {
    const ta = textRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, phone ? 10_000 : Math.round(window.innerHeight * 0.45))}px`;
  }, [text, phone]);

  // ----- files: 📎, paste, drop; uploaded here, named by hash in the signed command -----
  const addFiles = (list: File[]) => {
    if (!list.length) return;
    if (!takesFiles) {
      setNote(`${machine ?? "This machine"} can't take files on a new session. Update sessionpipe there.`);
      return;
    }
    setNote(null);
    let count = files.length;
    let total = files.reduce((n, f) => n + (f.error ? 0 : f.size), 0);
    const add: FileItem[] = [];
    for (const f of list) {
      const key = `${f.name}:${f.size}:${Math.random().toString(36).slice(2)}`;
      if (count >= START_FILES_MAX) {
        setNote(`Up to ${START_FILES_MAX} files on a new session.`);
        break;
      }
      if (f.size > START_FILE_MAX_BYTES) {
        add.push({ key, name: f.name, size: f.size, error: "over 25 MB" });
        continue;
      }
      if (f.size === 0) {
        add.push({ key, name: f.name, size: f.size, error: "empty" });
        continue;
      }
      if (total + f.size > START_FILES_TOTAL_BYTES) {
        add.push({ key, name: f.name, size: f.size, error: "over 50 MB in all" });
        continue;
      }
      count++;
      total += f.size;
      add.push({ key, name: f.name, size: f.size });
      controlApi.uploadFile(f).then(
        (entry) => setFiles((prev) => prev.map((x) => (x.key === key ? { ...x, entry } : x))),
        (e) => setFiles((prev) => prev.map((x) => (x.key === key ? { ...x, error: uploadWords(e) } : x))),
      );
    }
    setFiles((prev) => [...prev, ...add]);
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
  };
  const onPaste = (e: ClipboardEvent) => {
    const list = Array.from(e.clipboardData?.files ?? []);
    if (!list.length) return;
    e.preventDefault();
    addFiles(list);
  };

  // ----- start -----
  const canStart =
    !!m &&
    !!c &&
    !blocked &&
    !!rp &&
    !!harness &&
    harnesses.includes(harness) &&
    folderCheck.ok &&
    !!text.trim() &&
    text.length <= TEXT_MAX &&
    !uploading &&
    !fileErrors &&
    (takesFiles || files.length === 0) &&
    modelOk &&
    !busy;

  const start = async () => {
    if (!canStart || !m || !c || !rp || !harness || !folderCheck.ok) return;
    setBusy(true);
    setError(null);
    const sid = uuid();
    const held = files.flatMap((f) => (f.entry ? [f.entry] : []));
    try {
      await sendCommand(
        rp,
        c.machineId,
        {
          kind: "start",
          session: sessionKey(harness, sid),
          text: text.trim(),
          cwd: folderCheck.path,
          // Only what this machine's hello advertised (CONTROL.md §2): an older daemon
          // ignores a field it does not know and would run at its own mode.
          ...(takesFiles && held.length ? { files: held } : {}),
          // On an inherit machine its default is chosen by naming no level at all.
          ...(showPermission && permissionToSend(opts, permission)
            ? { permission: permissionToSend(opts, permission) }
            : {}),
          ...(showModel && model ? { model } : {}),
        },
        { onTap: () => setTap(true) },
      );
      rememberStart(m.name, c.machineId, {
        harness,
        cwd: folderCheck.path,
        ...(showPermission && permission ? { permission } : {}),
        ...(showModel && model ? { model } : {}),
      });
      saveDraft(null);
      // The started moment: the sheet dissolves where it is (no lift) and the message
      // carries on from where it was typed into the new session's first turn.
      const typed = ref.current?.querySelector<HTMLElement>("[data-ns-text]");
      const from = typed ? textOrigin(typed) : null;
      ref.current?.setAttribute("data-started", "");
      closeNewSession();
      navigate(sessionPath(harness, sid));
      if (from) landStart(from);
    } catch (e) {
      setError(sendErrorWords(e).replace(/^not sent · /, "Not sent: "));
      setBusy(false);
    } finally {
      // Started, Start keeps saying "Starting…" while the sheet dissolves: it never flips
      // back for its last frames.
      setTap(false);
      grant.refresh();
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (matches(e.nativeEvent, "newSession.start")) {
      e.preventDefault();
      void start();
    } else if (matches(e.nativeEvent, "newSession.folder")) {
      e.preventDefault();
      ref.current?.querySelector<HTMLElement>("[data-ns-row=folder] button, [data-ns-row=folder] input")?.focus();
    }
    // The page's own keys stay out while the sheet has focus (Esc and Tab are the trap's).
    if (e.key !== "Tab" && e.key !== "Escape") e.stopPropagation();
  };

  const discard = () => {
    saveDraft(null);
    setText("");
    setFiles([]);
    setNote(null);
    setError(null);
  };

  // ----- the one-fact status line -----
  const status = ((): { text: string; tone?: "err" } | null => {
    if (error) return { text: error, tone: "err" };
    if (tap) return { text: signerKind() === "device" ? "Confirm with Touch ID…" : "Confirm with your passkey…" };
    if (busy) return { text: `Sending to ${machine}…` };
    if (!m) return { text: listed.length ? "Choose a machine" : "Pair a machine to start sessions on it." };
    if (blocked) return { text: blocked.long };
    if (!harness) return { text: harnesses.length ? "Choose an agent" : `${m.name} hasn't said which agents it runs.` };
    if (!folderCheck.ok) return { text: folderCheck.reason };
    if (note) return { text: note };
    if (files.length && !takesFiles)
      return { text: `${m.name} can't take files on a new session. Update sessionpipe there.` };
    if (model && !modelOk)
      return { text: `${model} isn't a model ${m.name} offers for ${harnessMark(harness).label}.` };
    if (c && !c.online) return { text: `${m.name} is offline. It starts when the machine is back, within an hour.` };
    return { text: `${m.name} is listening.` };
  })();
  // The passkey is a note on Start (its tooltip, and what a screen reader hears with it),
  // not the status line: that line is for what is happening.
  const passkeyNote =
    grant.exp === null && !blocked
      ? signerKind() === "device"
        ? "Start asks for Touch ID, once today."
        : "Start asks for your passkey, once today."
      : null;

  // ----- the rows -----
  const agentLabel = (h: string) => harnessMark(h).label;
  const machineOptions: SelectOption<string>[] = listed.map((x) => {
    const b = why(x);
    const f = machineFacts(x.control, agentLabel);
    return {
      value: x.name,
      label: x.name,
      ...(b ? { hint: b.short } : f),
      disabled: !!b,
    };
  });
  // What each agent's account has left here: its tightest window, or each account's by
  // name; on a machine that pools the agent's accounts, the pool's current one and the count.
  const limits = useLimits();
  const now = useNow("coarse");
  const left = (h: string) => (machine ? agentLeft(h, machine, c, limits, now) : {});
  const agentOptions: SelectOption<string>[] = harnesses.map((h) => {
    const w = left(h);
    return {
      value: h,
      label: harnessMark(h).label,
      icon: <HarnessGlyph name={h} size="sm" />,
      ...(w.hint ? { hint: w.hint } : {}),
      ...(w.out ? { hintTone: "attention" as const } : {}),
      ...(w.detail ? { detail: w.detail } : {}),
    };
  });
  const chosen = harness ? left(harness) : {};
  const choices = useMemo(
    () =>
      machine && c
        ? folderChoices({ sessions: [...sessions.values()], machine, folders: c.folders, home: machineHome(c) })
        : { recent: [], allowed: [] },
    [machine, c, sessions],
  );
  const folderOptions: SelectOption<string>[] = [
    ...choices.recent.map((f) => ({ value: f.path, label: f.display, hint: f.repo })),
    ...choices.allowed.map((f, i) => ({
      value: f.path,
      label: f.display,
      divider: i === 0 && choices.recent.length > 0,
    })),
  ];
  const typed = (t: string): SelectOption<string> | null => {
    if (!machine) return null;
    const r = typedFolder(t, { folders: c?.folders, home: machineHome(c), machine });
    return r.ok ? { value: r.path, label: tildify(r.path, machineHome(c)) } : { value: t, label: t, hint: r.reason };
  };
  const permissionOptions: SelectOption<RunLevel>[] = levels.map((p) => ({
    value: p,
    label: p === "inherit" ? INHERIT_DEFAULT : PERMISSION_LABEL[p],
    detail: PERMISSION_HINT[p],
  }));
  const seenModels = useMemo(() => {
    if (!machine || !harness) return [];
    const out = new Set<string>();
    for (const s of sessions.values()) if (s.machine === machine && s.harness === harness && s.model) out.add(s.model);
    return [...out].filter((x) => validModel(x) && !opts?.models?.includes(x)).slice(0, 8);
  }, [sessions, machine, harness, opts]);
  const modelOptions: SelectOption<string>[] = [
    { value: "", label: "Default", hint: "the agent's own" },
    ...(opts?.models ?? []).map((x) => ({ value: x, label: x })),
    ...(opts?.anyModel ? seenModels.map((x, i) => ({ value: x, label: x, hint: "seen here", divider: i === 0 })) : []),
  ];
  const typedModel = opts?.anyModel
    ? (t: string): SelectOption<string> =>
        validModel(t) ? { value: t, label: t } : { value: t, label: t, hint: "not a model id", disabled: true }
    : undefined;

  const row = (key: string, label: string, control: ReactNode, extra?: ReactNode) => (
    <div className="ns-row" data-ns-row={key}>
      <span className="ns-label" id={`ns-${key}`}>
        {label}
      </span>
      <span className="ns-value">{control}</span>
      {extra}
    </div>
  );

  const rows = (
    <div className="ns-rows">
      {row(
        "machine",
        "Machine",
        <Select<string>
          labelledBy="ns-machine"
          value={machine}
          onChange={setMachine}
          options={machineOptions}
          placeholder="Choose…"
          searchable={machineOptions.length > 8}
          className="ns-sel"
        />,
      )}
      {row(
        "agent",
        "Agent",
        <Select<string>
          labelledBy="ns-agent"
          value={harness}
          onChange={pickHarness}
          options={agentOptions}
          placeholder={harnesses.length ? "Choose…" : "None reported"}
          disabled={!harnesses.length}
          className="ns-sel"
        />,
        chosen.hint ? (
          <span className={`ns-aside num ${chosen.out ? "ns-aside--out" : ""}`} data-ns-left>
            {chosen.hint}
          </span>
        ) : null,
      )}
      {row(
        "folder",
        "Folder",
        listsFolders || folderOptions.length ? (
          <Select<string>
            labelledBy="ns-folder"
            value={folder || null}
            onChange={setFolder}
            options={folderOptions}
            placeholder="Choose…"
            custom={typed}
            filterPlaceholder="Search, or type a path"
            className="ns-sel mono"
          />
        ) : (
          <input
            className="ns-path mono"
            aria-labelledby="ns-folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder={c?.tilde ? "~/path/on/the/machine" : "/absolute/path/on/the/machine"}
            spellCheck={false}
            autoComplete="off"
          />
        ),
        machine && c && !listsFolders ? (
          <span className="ns-aside">{machine} didn't list its folders; it checks the path itself</span>
        ) : null,
      )}
    </div>
  );

  const message = (
    <div className="ns-text-wrap">
      <textarea
        ref={textRef}
        className="ns-text"
        aria-label="What should it do?"
        placeholder="What should it do?"
        value={text}
        maxLength={TEXT_MAX}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        rows={phone ? 6 : 5}
        data-ns-text
      />
      {text.length >= COUNTER_AT && (
        <span className="ns-count num" aria-live="polite">
          {text.length.toLocaleString()} / {TEXT_MAX.toLocaleString()}
        </span>
      )}
    </div>
  );

  const chips = files.length > 0 && (
    <ul className="ns-files" aria-label="Files">
      {files.map((f) => (
        <li
          key={f.key}
          className={`ns-file ${f.error ? "ns-file--err" : ""}`}
          data-file-state={f.error ? "error" : f.entry ? "held" : "uploading"}
        >
          {!f.entry && !f.error && <span className="spinner" aria-hidden="true" />}
          <span className="ns-file-name ellipsis">{f.name}</span>
          <span className="ns-file-size num">{f.error ?? bytes(f.size)}</span>
          <button
            type="button"
            className="icon-btn ns-file-x"
            aria-label={`Remove ${f.name}`}
            onClick={() => setFiles((prev) => prev.filter((x) => x.key !== f.key))}
          >
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </li>
      ))}
    </ul>
  );

  const fileButton = takesFiles && (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
        data-ns-files
      />
      {phone ? (
        <button type="button" className="ns-cell ns-cell--action" onClick={() => fileInput.current?.click()}>
          Add photos or files
        </button>
      ) : (
        <button
          type="button"
          className="icon-btn ns-attach"
          aria-label="Add files"
          data-tip="Add files"
          onClick={() => fileInput.current?.click()}
        >
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
          >
            <path d="M10.5 4.5 5.7 9.3a1.6 1.6 0 0 0 2.3 2.3l5.2-5.2a3.2 3.2 0 0 0-4.5-4.5L3.3 7.3a4.8 4.8 0 0 0 6.8 6.8l3.6-3.6" />
          </svg>
        </button>
      )}
    </>
  );

  const capped =
    c?.mode === "safe"
      ? `${machine} is in safe mode. Wider levels are set at the machine.`
      : c?.mode === "inherit"
        ? `${machine} runs agents as your own sessions there. A level named here is at most Safe.`
        : undefined;
  const permissionSelect = showPermission && (
    <Select<RunLevel>
      labelledBy="ns-permission"
      value={permission}
      onChange={setPermission}
      options={permissionOptions}
      footer={capped}
      size={phone ? "md" : "sm"}
      align={phone ? "end" : "start"}
      className="ns-sel ns-opt-sel"
    />
  );
  const modelSelect = showModel && (
    <Select<string>
      labelledBy="ns-model"
      value={model}
      onChange={setModel}
      options={modelOptions}
      custom={typedModel}
      searchable={!!typedModel || modelOptions.length > 8}
      filterPlaceholder={typedModel ? "Search, or type a model id" : "Filter"}
      size={phone ? "md" : "sm"}
      align={phone ? "end" : "start"}
      className="ns-sel ns-opt-sel"
    />
  );

  // The Permission row is there on every machine, so the sheet keeps its height: the
  // pop-up where the machine offers a choice, else what it will run as, in words.
  const fixed = m && c && harness && !blocked ? fixedPermission(c, harness, PERMISSION_LABEL) : null;
  const startKeys = hintFor("newSession.start");
  const more = () => [{ label: "Discard draft", disabled: !text && !files.length, run: discard }];
  const statusLine = status && (
    <p className={`ns-status ${status.tone === "err" ? "ns-status--err" : ""}`} role="status" aria-live="polite">
      {status.text}
    </p>
  );

  // No machine paired here yet: nothing to fill in, one way on (Connect pairs one).
  const noMachine = !!snapshotAt && !listed.some((x) => x.control);
  const pairOne = () => {
    close();
    navigate("/connect");
  };
  const empty = (
    <EmptyState
      className="ns-empty"
      title="No machine is paired yet"
      actions={
        <>
          <button type="button" className="btn btn--primary" onClick={pairOne} data-ns-pair>
            Pair a machine…
          </button>
          {!phone && (
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
          )}
        </>
      }
    >
      Pair a machine that runs sessionpipe, and you can start Claude Code, Codex or Gemini on it from here.
    </EmptyState>
  );

  if (phone)
    return (
      <div
        className="ns-sheet ns-sheet--phone"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ns-title"
        ref={ref}
        data-closing={closing ? "" : undefined}
        onKeyDown={onKeyDown}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        data-new-session
      >
        <header className="ns-bar">
          <button type="button" className="ns-bar-btn" onClick={close} data-ns-cancel>
            Cancel
          </button>
          <h2 className="ns-bar-title" id="ns-title">
            New session
          </h2>
          {noMachine ? (
            <span />
          ) : (
            <button
              type="button"
              className="ns-bar-btn ns-bar-btn--start"
              onClick={() => void start()}
              disabled={!canStart}
              aria-busy={busy || undefined}
              aria-describedby={passkeyNote ? "ns-passkey" : undefined}
              data-ns-start
            >
              {busy ? "Starting…" : "Start"}
            </button>
          )}
          <span className="ns-grab" aria-hidden="true" />
        </header>
        <div className="ns-scroll">
          {noMachine ? (
            empty
          ) : (
            <>
              <div className="ns-group">{rows}</div>
              <div className="ns-group ns-group--text">{message}</div>
              {chips}
              {(showPermission || fixed || showModel || takesFiles) && (
                <div className="ns-group">
                  {showPermission && row("permission", "Permission", permissionSelect)}
                  {fixed && row("options", "Permission", <span className="ns-fixed">{fixed}</span>)}
                  {showModel && row("model", "Model", modelSelect)}
                  {takesFiles && <div className="ns-row">{fileButton}</div>}
                </div>
              )}
              <div className="ns-group-foot">
                {statusLine}
                {passkeyNote && (
                  <p className="ns-passkey" id="ns-passkey">
                    {passkeyNote}
                  </p>
                )}
                {(text || files.length > 0) && (
                  <button type="button" className="ns-discard" onClick={discard}>
                    Discard draft
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
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
        className="ns-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ns-title"
        ref={ref}
        data-closing={closing ? "" : undefined}
        onKeyDown={onKeyDown}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        data-new-session
      >
        <h2 className="ns-title" id="ns-title">
          New session
        </h2>
        {noMachine ? (
          empty
        ) : (
          <>
            {rows}
            {message}
            {chips}
            <div className="ns-opts">
              {fileButton}
              {showPermission && (
                <span className="ns-opt" data-ns-row="permission">
                  <span className="ns-opt-label" id="ns-permission">
                    Permission
                  </span>
                  {permissionSelect}
                </span>
              )}
              {fixed && (
                <span className="ns-opt" data-ns-row="options">
                  <span className="ns-opt-label">Permission</span>
                  <span className="ns-fixed">{fixed}</span>
                </span>
              )}
              {showModel && (
                <span className="ns-opt" data-ns-row="model">
                  <span className="ns-opt-label" id="ns-model">
                    Model
                  </span>
                  {modelSelect}
                </span>
              )}
            </div>
            <footer className="ns-foot">
              {statusLine}
              <span className="ns-actions">
                <MoreButton build={more} label="Draft" title={() => "New session"} className="ns-more" />
                <button type="button" className="btn" onClick={close} data-ns-cancel>
                  Cancel
                </button>
                <ActionButton
                  className="btn btn--primary ns-start"
                  onClick={start}
                  disabled={!canStart && !busy}
                  pending={busy}
                  pendingLabel="Starting…"
                  aria-describedby={passkeyNote ? "ns-passkey" : undefined}
                  data-tip={passkeyNote ?? undefined}
                  data-tip-side="top"
                  data-ns-start
                >
                  Start {startKeys && <kbd className="ns-kbd">{startKeys}</kbd>}
                </ActionButton>
              </span>
              {passkeyNote && (
                <span className="sr-only" id="ns-passkey">
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

/** Where an element's first line of text starts, in the viewport (its content box). */
function textOrigin(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    x: r.left + Number.parseFloat(cs.borderLeftWidth) + Number.parseFloat(cs.paddingLeft),
    y: r.top + Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.paddingTop),
  };
}

/** The started session's message glides from where it was typed into its place in the
 *  first turn, fading up as the sheet dissolves over it: one element, transform and
 *  opacity, nothing waits for it. If the page takes longer than a few frames to show the
 *  message, it simply is there. */
function landStart(from: { x: number; y: number }): void {
  if (reducedMotion() || typeof Element.prototype.animate !== "function") return;
  const fly = (el: HTMLElement) => {
    const to = textOrigin(el);
    const dx = Math.round(from.x - to.x);
    const dy = Math.round(from.y - to.y);
    if (Math.abs(dx) + Math.abs(dy) < 4) return;
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 },
        { opacity: 1, offset: 0.35 },
        { transform: "none", opacity: 1 },
      ],
      { duration: tokenMs("--dur-land", 320), easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  };
  const find = () => document.querySelector<HTMLElement>("[data-start-message]");
  const now = find();
  if (now) {
    fly(now);
    return;
  }
  // Caught as it is inserted (a mutation callback runs before that frame paints), so it
  // is never drawn in its place first.
  const watch = new MutationObserver(() => {
    const el = find();
    if (!el) return;
    watch.disconnect();
    fly(el);
  });
  watch.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => watch.disconnect(), 200);
}

function uploadWords(e: unknown): string {
  const s = (e as { status?: number })?.status;
  if (s === 413) return "over 25 MB";
  if (s === 415) return "not a file type the machine can take";
  if (s === 400) return "not a name a machine can save";
  return "didn't upload";
}
