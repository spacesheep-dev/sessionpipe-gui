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
// can be pulled down by its top to dismiss. With no machine paired, or on a phone that isn't
// approved, it is an empty state with the one way on, not a form nothing on could start; in
// the hour a newly approved phone waits the form stays and Start waits (startGate.ts). On a
// phone the foot says something only when something is to be said. Loaded once the page is
// idle (NewSession.tsx mounts it).
import type { ControlActivity, MachineSummary, RunLevel, StartFile } from "@shared/api";
import {
  ATTACHMENT_TYPES,
  PICTURE_INPUT_MAX_BYTES,
  START_FILE_MAX_BYTES,
  START_FILES_MAX,
  START_FILES_TOTAL_BYTES,
  sessionKey,
  splitKey,
  validModel,
} from "@shared/api";
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
import { useSendStates } from "../account/sendable";
import { ActionButton, EmptyState, HarnessGlyph, withFormScrim } from "../components/bits";
import { CloseIcon, FolderIcon, PaperclipIcon, RefreshIcon, StarIcon } from "../components/Icons";
import { filterOptions, Select, type SelectOption } from "../components/Select";
import { useAppState, useLimits, useListedSessions, useMachines } from "../data/hooks";
import { usePhoneLayout } from "../lib/device";
import { useFocusTrap } from "../lib/focus";
import "../lib/acp";
import { UPLOAD_REFUSED, UPLOAD_WORDS } from "@shared/attachments";
import { bytes, harnessMark } from "../lib/format";
import { useFieldAboveKeys } from "../lib/keyboardInset";
import { reducedMotion, tokenMs, useSheetDrag } from "../lib/motion";
import { accountMode, uploadProgress } from "../lib/net";
import { navigate, sessionPath } from "../lib/router";
import { hintFor, matches, useShortcut } from "../lib/shortcuts";
import { useNow } from "../lib/time";
import { START, ThisPhone } from "../native/accountWords";
import {
  boardNow,
  markSpacesheepRefused,
  pictureName,
  progressWords,
  UPLOADS_AT_ONCE,
  useSpacesheepRefused,
} from "./Attachments";
import { ControlError, controlApi, wrongOriginHere } from "./api";
import { uuid } from "./bytes";
import { type CommandFields, sendCommand } from "./command";
import {
  folderChoices,
  formatFolder,
  isFavoriteFolder,
  machineHome,
  readFavoriteFolders,
  tildify,
  toggleFavoriteFolder,
  typedFolder,
  unnamedHere,
} from "./folders";
import { HeldNotice, useHeld } from "./HeldNotice";
import type { HeldMeta } from "./held";
import { HELD_WORDS } from "./heldWords";
import { useGrant, useRpId } from "./hooks";
import {
  agentLeft,
  closeNewSession,
  type Draft,
  fixedLine,
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
  uploadsAgain,
} from "./newSessionState";
import { keepSentPicture } from "./sentPictures";
import { HEIC_FILE_NOTE, pictureType, SHRINKING_WORDS, ShrinkRefused, type Shrunk, shrinkImage } from "./shrink";
import { canSign, isCancel, setupLabel, signerKind, signHint, tapWords } from "./signer";
import { machineBlocked, startGate } from "./startGate";
import { nounFor, spacesheepName, uploadWords } from "./uploadWords";
import { notSentWords, PERMISSION_LABEL } from "./words";
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

const TEXT_MAX = 20_000;
const COUNTER_AT = 18_000;

/** A file on its way into the start: uploading, held (its entry), or refused in place. */
/** What a start was made of when it was pressed: all its "started" needs, so nothing after
 *  a confirm reads the sheet as it is now. */
interface Sent extends HeldMeta {
  machine: string;
  machineId: string;
  permission?: RunLevel;
  model?: string;
}

interface FileItem {
  key: string;
  name: string;
  size: number;
  /** The original's size, where a picture goes as a smaller redraw of it. */
  was?: number;
  /** A picture being made smaller (shrink.ts); its upload waits for that. */
  shrinking?: boolean;
  /** Its upload waits its turn: two run at a time, as the composer's do. */
  waiting?: boolean;
  /** Goes as a file, but not as a picture the agent can look at (a HEIC this engine can't draw). */
  note?: string;
  /** The bytes that go, for Retry; absent on one brought back from the draft (held already). */
  file?: File;
  entry?: StartFile;
  /** When it was held (ms): the receiver keeps it a day from then. */
  at?: number;
  /** Bytes of it sent so far, where that is counted (a browser). */
  sent?: number;
  /** In the chip: what is wrong with it, in a few words. */
  error?: string;
  /** Why its upload failed, as a sentence (the status line says it), and whether Retry can mend it. */
  failed?: { words: string; retry: boolean };
  /** The machine its upload went for, and whether that one is reached through spacesheep. */
  to?: { machine?: string; remote: boolean };
}

export function Sheet({ target, closing }: { target: NewSessionTarget; closing: boolean }) {
  const phone = usePhoneLayout();
  const machines = useMachines();
  const { snapshotAt } = useAppState();
  // Recent folders come from the sessions the board lists, not from a harness a program
  // only started (isEmptySession).
  const sessions = useListedSessions();
  const rp = useRpId();
  const grant = useGrant(rp);
  const secure = canSign(rp);
  const wrong = wrongOriginHere();
  const sendTo = useSendStates(rp);
  const ref = useRef<HTMLDivElement>(null);
  // The keyboard up: the field being typed in stays above it, its status line too.
  useFieldAboveKeys(ref);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Paired machines first (each list in name order), then the ones a start cannot reach.
  const listed = useMemo(
    () => [...machines.filter((m) => m.control), ...machines.filter((m) => !m.control)],
    [machines],
  );
  const why = useCallback(
    (m: MachineSummary) => startGate(m.name, m.control, { wrong, secure, hint: signHint(), send: sendTo(m.control) }),
    [wrong, secure, sendTo],
  );
  // The paired machines a start can go to from here: the sheet picks one of these itself.
  const ready = useCallback(
    (names: string[]) =>
      names.filter((n) => {
        const x = listed.find((y) => y.name === n);
        return !!x && !machineBlocked(why(x));
      }),
    [listed, why],
  );

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
      ready: ready(listed.filter((m) => m.control).map((m) => m.name)),
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
        favorites: readFavoriteFolders(mm.name),
      });
      // A session's `~/…` folder this page can't name ("New session here" on a computer
      // reached through spacesheep) is not kept: the machine's own folders are offered.
      let folder = "";
      if (prefer.cwd && !unnamedHere(prefer.cwd, machineHome(cc))) {
        const t = typedFolder(prefer.cwd, { folders: cc.folders, home: machineHome(cc), machine: mm.name });
        folder = t.ok ? t.path : prefer.cwd;
      } else folder = r.cwd ?? choices.pinned[0]?.path ?? choices.recent[0]?.path ?? choices.allowed[0]?.path ?? "";
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
    const sameMachine = !target.machine || target.machine === initial.ctx.machine;
    const targetClean = Object.fromEntries(
      Object.entries(target).filter(([k, v]) => v !== undefined && (k !== "cwd" || sameMachine)),
    );
    const prefer: NewSessionTarget = {
      ...(fromDraft ? { harness: d.harness, cwd: d.folder, permission: d.permission, model: d.model } : {}),
      ...targetClean,
      ...(initial.ctx.harness && !target.harness && !fromDraft ? { harness: initial.ctx.harness } : {}),
    };
    return valuesFor(initial.ctx.machine, prefer);
    // Once, at open.
  }, []);
  const [harness, setHarness] = useState<string | undefined>(first.harness);
  const [folder, setFolder] = useState(first.folder);
  const [favorites, setFavorites] = useState<string[]>(() =>
    initial.ctx.machine ? readFavoriteFolders(initial.ctx.machine) : [],
  );
  useEffect(() => {
    setFavorites(machine ? readFavoriteFolders(machine) : []);
  }, [machine]);
  const [permission, setPermission] = useState<RunLevel | undefined>(first.permission);
  const [model, setModel] = useState(first.model ?? "");
  const [text, setText] = useState(target.text ?? initial.draft?.text ?? "");
  const [files, setFiles] = useState<FileItem[]>(() =>
    (target.files ?? initial.draft?.files ?? []).map((f) => ({
      key: f.sha256,
      name: f.name,
      size: f.size,
      entry: f,
      at: (target.files ? target.filesAt : initial.draft?.filesAt) || Date.now(),
    })),
  );
  /** How each running upload is stopped, by file key. */
  const stops = useRef(new Map<string, AbortController>());
  /** A file refused for too many at once: the timer that offers its Try again once the wait is over. */
  const waits = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const unwait = (key?: string) => {
    for (const [k, t] of waits.current)
      if (key === undefined || k === key) {
        clearTimeout(t);
        waits.current.delete(k);
      }
  };
  useEffect(
    () => () => {
      for (const stop of stops.current.values()) stop.abort();
      for (const t of waits.current.values()) clearTimeout(t);
    },
    [],
  );
  const [busy, setBusy] = useState(false);
  const [tap, setTap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** `files` now, for a picture that finishes shrinking between renders. */
  const filesNow = useRef(files);
  filesNow.current = files;

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
      ready: ready(names),
    });
    if (!ctx.machine) return;
    const sameMachine = !target.machine || target.machine === ctx.machine;
    const prefer: NewSessionTarget = {
      ...Object.fromEntries(Object.entries(target).filter(([k, v]) => v !== undefined && (k !== "cwd" || sameMachine))),
      ...(ctx.harness && !target.harness ? { harness: ctx.harness } : {}),
    };
    const v = valuesFor(ctx.machine, prefer);
    setMachineRaw(ctx.machine);
    setFavorites(readFavoriteFolders(ctx.machine));
    setHarness(v.harness);
    setFolder(v.folder);
    setPermission(v.permission);
    setModel(v.model ?? "");
  }, [listed, sessions, target, valuesFor, ready]);

  const setMachine = (name: string) => {
    if (name === machine) return;
    setMachineRaw(name);
    setFavorites(readFavoriteFolders(name));
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

  // ----- what the machine advertises, and whether a start can go there -----
  const gate = m ? why(m) : null;
  // The hour's line stands in for an error while it lasts (the status line below); what was
  // refused in it is old news once it is over.
  const cooling = gate?.kind === "cooling";
  useEffect(() => {
    if (!cooling) setError(null);
  }, [cooling]);
  // This device isn't approved: nothing on the form could start anywhere, so the sheet is
  // the way to approve it (the draft is kept as it is, for when it can).
  const unapproved = listed.some((x) => why(x)?.kind === "approve");
  const harnesses = c?.harnesses ?? [];
  const opts = harness ? c?.start?.[harness] : undefined;
  // On an inherit machine the default ("As your own sessions") is one of the choices.
  const levels = permissionChoices(opts);
  const showPermission = levels.length >= 2;
  const showModel = !!opts && (!!opts.anyModel || !!opts.models?.length);
  const takesFiles = c?.files === true;
  // Reached through spacesheep: its files are uploaded there (server/control/remote.ts),
  // unless spacesheep refused this app's uploads, which holds for the page's life.
  const relayed = !!c?.remote;
  const ssRefused = useSpacesheepRefused();
  const filesRefused = relayed && ssRefused;
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
      ...(files.some((f) => f.entry)
        ? {
            files: files.flatMap((f) => (f.entry ? [f.entry] : [])),
            filesAt: Math.min(...files.flatMap((f) => (f.entry ? [f.at ?? Date.now()] : []))),
          }
        : {}),
    };
    saveDraft(d);
  }, [machine, harness, folder, text, permission, model, files]);

  const close = useCallback(() => closeNewSession(), []);
  const initialFocus = unapproved
    ? "[data-ns-approve]"
    : !machine
      ? "[data-ns-row=machine] button"
      : !harness
        ? "[data-ns-row=agent] button"
        : !folderCheck.ok
          ? "[data-ns-row=folder] button.sel, [data-ns-row=folder] input"
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
    if (filesRefused) {
      setNote(UPLOAD_WORDS.refused);
      return;
    }
    if (!takesFiles) {
      setNote(`${machine ?? "This machine"} can't take files on a new session. Update sessionpipe there.`);
      return;
    }
    setNote(null);
    let count = files.length;
    let total = files.reduce((n, f) => n + (f.error || f.shrinking ? 0 : f.size), 0);
    const add: FileItem[] = [];
    for (const f of list) {
      const key = `${f.name}:${f.size}:${Math.random().toString(36).slice(2)}`;
      if (count >= START_FILES_MAX) {
        setNote(`Up to ${START_FILES_MAX} files on a new session.`);
        break;
      }
      if (f.size === 0) {
        add.push({ key, name: f.name, size: f.size, error: "empty" });
        continue;
      }
      // A picture is made smaller first, and held to the caps at the size it goes at.
      if (pictureType(f.type, f.name)) {
        if (f.size > PICTURE_INPUT_MAX_BYTES) {
          add.push({ key, name: f.name, size: f.size, error: "over 50 MB" });
          continue;
        }
        count++;
        add.push({ key, name: f.name, size: f.size, shrinking: true });
        shrinkImage(f, { name: f.name }).then(
          (small) => shrunkFile(key, f, small),
          (e) => shrunkFile(key, f, e instanceof ShrinkRefused ? "heic" : null),
        );
        continue;
      }
      if (f.size > START_FILE_MAX_BYTES) {
        add.push({ key, name: f.name, size: f.size, error: "over 25 MB" });
        continue;
      }
      if (total + f.size > START_FILES_TOTAL_BYTES) {
        add.push({ key, name: f.name, size: f.size, error: "over 50 MB in all" });
        continue;
      }
      count++;
      total += f.size;
      add.push({ key, name: f.name, size: f.size, file: f, waiting: true });
    }
    filesNow.current = [...filesNow.current, ...add];
    setFiles((prev) => [...prev, ...add]);
  };
  const patchFile = (key: string, p: Partial<FileItem>) => {
    filesNow.current = filesNow.current.map((x) => (x.key === key ? { ...x, ...p } : x));
    setFiles((prev) => prev.map((x) => (x.key === key ? { ...x, ...p } : x)));
  };
  /** Where an upload goes now: the selected machine, and whether it is reached through
   *  spacesheep (the bytes go on to spacesheep for it). Read when the upload begins, which
   *  can be after a picture is made smaller. */
  const goesTo = useRef({ machine: c?.machineId, remote: relayed });
  goesTo.current = { machine: c?.machineId, remote: relayed };
  /** One file's upload, for the machine selected now: its progress where it is counted,
   *  stopped when it is removed. */
  const upload = (key: string, f: File) => {
    const stop = new AbortController();
    stops.current.set(key, stop);
    const to = goesTo.current;
    patchFile(key, { to, waiting: false });
    controlApi
      .uploadFile(f, to.machine, {
        signal: stop.signal,
        ...(uploadProgress() ? { onProgress: (sent: number) => patchFile(key, { sent }) } : {}),
      })
      .then(
        (entry) => {
          if (stop.signal.aborted) return;
          patchFile(key, { entry, at: Date.now() });
          // No receiver keeps a picture sent through spacesheep to show: this page does.
          if ((to.remote || accountMode()) && f.type in ATTACHMENT_TYPES)
            void f
              .arrayBuffer()
              .then((b) => keepSentPicture(entry.sha256, b, f.type))
              .catch(() => {});
        },
        async (e) => {
          // spacesheep takes none from this app: no files for its computers from now on.
          if (e instanceof ControlError && e.reason === UPLOAD_REFUSED) markSpacesheepRefused();
          // The board is named as its Info says, which a page opened on ?new=1 may not have
          // read yet; spacesheep, where the upload went on to it.
          const board = to.remote ? spacesheepName() : await boardNow();
          if (stop.signal.aborted) return;
          const failed = uploadWords(e, board, nounFor(f.type));
          patchFile(key, { error: "didn't upload", failed });
          // Too many at once: Try again is offered once the wait its words say is over.
          if (failed.waitS !== undefined) {
            unwait(key);
            waits.current.set(
              key,
              setTimeout(
                () => {
                  waits.current.delete(key);
                  const x = filesNow.current.find((y) => y.key === key);
                  if (x?.failed) patchFile(key, { failed: { ...x.failed, retry: true } });
                },
                Math.min(failed.waitS * 1000, 2 ** 31 - 1),
              ),
            );
          }
        },
      )
      .finally(() => {
        if (stops.current.get(key) === stop) stops.current.delete(key);
      });
  };
  /** A picture made smaller (`small`), left as it was (null), or a HEIC this engine can't
   *  draw ("heic", which goes as a file with a note): held to the caps, named, uploaded. */
  const shrunkFile = (key: string, f: File, small: Shrunk | null | "heic") => {
    // Taken back while it was being made smaller.
    if (!filesNow.current.some((x) => x.key === key)) return;
    const others = filesNow.current.filter((x) => x.key !== key && !x.error && !x.shrinking);
    const shrunk = small && small !== "heic" ? small : null;
    const size = shrunk ? shrunk.blob.size : f.size;
    const done: Partial<FileItem> = { shrinking: false, size, ...(shrunk ? { was: f.size } : {}) };
    if (size > START_FILE_MAX_BYTES) {
      patchFile(key, { ...done, error: shrunk ? "over 25 MB after shrinking" : "over 25 MB" });
      return;
    }
    if (others.reduce((n, x) => n + x.size, 0) + size > START_FILES_TOTAL_BYTES) {
      patchFile(key, { ...done, error: "over 50 MB in all" });
      return;
    }
    if (small === "heic") {
      patchFile(key, { ...done, note: HEIC_FILE_NOTE, file: f, waiting: true });
      return;
    }
    const type = shrunk?.type ?? f.type;
    const name = pictureName(
      f.name,
      type,
      others.map((x) => x.name),
    );
    const goes = new File([shrunk?.blob ?? f], name, { type });
    patchFile(key, { ...done, name, file: goes, waiting: true });
  };
  const retry = (x: FileItem) => {
    if (!x.file || !x.failed?.retry) return;
    stops.current.delete(x.key);
    patchFile(x.key, { error: undefined, failed: undefined, sent: undefined, waiting: true });
  };
  const removeFile = (key: string) => {
    stops.current.get(key)?.abort();
    stops.current.delete(key);
    unwait(key);
    filesNow.current = filesNow.current.filter((x) => x.key !== key);
    setFiles((prev) => prev.filter((x) => x.key !== key));
  };
  // Another machine chosen, reached another way: its files go again, for it (`uploadsAgain`).
  useEffect(() => {
    for (const x of filesNow.current) {
      if (!x.file || !uploadsAgain(x, relayed)) continue;
      stops.current.get(x.key)?.abort();
      stops.current.delete(x.key);
      unwait(x.key);
      patchFile(x.key, { entry: undefined, error: undefined, failed: undefined, sent: undefined, waiting: true });
    }
  }, [relayed]);
  // Two uploads at a time, in the chips' order; the rest wait. The next goes when one is
  // in, fails or is removed: the app's hub answers only a few requests at once, and the
  // account's own reads need theirs.
  useEffect(() => {
    let busy = files.filter((x) => x.file && !x.waiting && !x.entry && !x.error && !x.shrinking).length;
    for (const x of files) {
      if (busy >= UPLOADS_AT_ONCE) break;
      if (!x.waiting || !x.file || x.error || stops.current.has(x.key)) continue;
      busy++;
      upload(x.key, x.file);
    }
  }, [files]);
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
    !gate &&
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

  // Started: remember the choices it was made with, and go to the session it started.
  const started = (fields: CommandFields, s: Sent) => {
    if (fields.kind !== "start") return;
    const { harness: h, id: sid } = splitKey(fields.session);
    rememberStart(s.machine, s.machineId, {
      harness: h,
      cwd: fields.cwd,
      ...(s.permission ? { permission: s.permission } : {}),
      ...(s.model ? { model: s.model } : {}),
    });
    saveDraft(null);
    // The started moment: the sheet dissolves where it is (no lift) and the message
    // carries on from where it was typed into the new session's first turn.
    const typed = ref.current?.querySelector<HTMLElement>("[data-ns-text]");
    const from = typed ? textOrigin(typed) : null;
    ref.current?.setAttribute("data-started", "");
    closeNewSession();
    navigate(sessionPath(h, sid));
    if (from) landStart(from);
  };
  // Everything a start is made of, as one string: a held start goes the moment any of it
  // changes (machine, agent, folder, permission, model, text, files).
  const sheetKey = JSON.stringify([machine, harness, folder, permission, model, text, files.map((f) => f.key)]);
  // A start the receiver held for a confirm: the notice above the foot, and its button.
  const held = useHeld<ControlActivity, Sent>(
    (_r, h, s) => {
      started(h.fields, s);
      grant.refresh();
    },
    (e) => setError(notSentWords(e)),
    sheetKey,
  );
  const startButton = useCallback(() => ref.current?.querySelector<HTMLElement>("[data-ns-start]") ?? null, []);

  const start = async () => {
    if (!canStart || !m || !c || !rp || !harness || !folderCheck.ok) return;
    // A held start's confirm is on its way: a second press would be a second session.
    if (held.confirming()) return;
    setBusy(true);
    setError(null);
    held.drop();
    const sid = uuid();
    const kept = files.flatMap((f) => (f.entry ? [f.entry] : []));
    const keyAtSend = sheetKey;
    const sent: Sent = {
      machine: m.name,
      machineId: c.machineId,
      ...(showPermission && permission ? { permission } : {}),
      ...(showModel && model ? { model } : {}),
      where: `${m.name} · ${tildify(folderCheck.path, machineHome(c))}`,
    };
    const fields: CommandFields = {
      kind: "start",
      session: sessionKey(harness, sid),
      text: text.trim(),
      cwd: folderCheck.path,
      // Only what this machine's hello advertised (CONTROL.md §2): an older daemon
      // ignores a field it does not know and would run at its own mode.
      ...(takesFiles && kept.length ? { files: kept } : {}),
      // On an inherit machine its default is chosen by naming no level at all.
      ...(showPermission && permissionToSend(opts, permission)
        ? { permission: permissionToSend(opts, permission) }
        : {}),
      ...(showModel && model ? { model } : {}),
    };
    try {
      await sendCommand(rp, c.machineId, fields, { onTap: () => setTap(true) });
      started(fields, sent);
    } catch (e) {
      const caught = held.catchHeld(e, sent, keyAtSend);
      if (caught === "changed") setError(HELD_WORDS.changed);
      // A prompt the person closed is no refusal: the sheet stays as it was.
      else if (!caught) setError(isCancel(e) ? null : notSentWords(e));
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
      const folderEl = ref.current?.querySelector<HTMLElement>(
        "[data-ns-row=folder] button.sel, [data-ns-row=folder] input",
      );
      if (folderEl) {
        folderEl.focus();
        if (folderEl.tagName === "BUTTON" && folderEl.getAttribute("aria-expanded") !== "true") folderEl.click();
      }
    }
    // The page's own keys stay out while the sheet has focus (Esc and Tab are the trap's).
    if (e.key !== "Tab" && e.key !== "Escape") e.stopPropagation();
  };

  const discard = () => {
    saveDraft(null);
    setText("");
    for (const stop of stops.current.values()) stop.abort();
    stops.current.clear();
    unwait();
    setFiles([]);
    setNote(null);
    setError(null);
  };

  // ----- the one-fact status line -----
  // `ready`: nothing is wrong and nothing under way; a phone's foot then says nothing.
  const status = ((): { text: string; tone?: "err"; approve?: boolean; ready?: boolean } | null => {
    // Inside the hour, one sentence says from when: also in place of a refusal for it.
    if (gate?.kind === "cooling") return { text: gate.long };
    if (error) return { text: error, tone: "err" };
    if (tap) return { text: tapWords() };
    if (busy) return { text: `Sending to ${machine}…` };
    if (!m) return { text: listed.length ? "Choose a machine" : "Pair a machine to start sessions on it." };
    if (gate?.kind === "machine") return { text: gate.long, approve: gate.approve };
    if (!harness) return { text: harnesses.length ? "Choose an agent" : `${m.name} hasn't said which agents it runs.` };
    if (!folderCheck.ok) return { text: folderCheck.reason };
    if (note) return { text: note };
    const failedFile = files.find((f) => f.failed);
    if (failedFile?.failed) return { text: failedFile.failed.words, tone: "err" };
    if (files.length && !takesFiles)
      return { text: `${m.name} can't take files on a new session. Update sessionpipe there.` };
    if (model && !modelOk)
      return { text: `${model} isn't a model ${m.name} offers for ${harnessMark(harness).label}.` };
    // A picture still being made smaller is counted once it is (its size is not known yet).
    const going = files.filter((f) => !f.entry && !f.error && !f.shrinking);
    if (going.length > 0) {
      const whole = going.reduce((n, f) => n + f.size, 0);
      return {
        text: progressWords(whole, uploadProgress() ? going.reduce((n, f) => n + (f.sent ?? 0), 0) : undefined),
      };
    }
    // spacesheep holds a start a day (server/control/state.ts), this receiver an hour.
    if (c && !c.online)
      return {
        text: `${m.name} is offline. It starts when the machine is back, within ${relayed ? "a day" : "an hour"}.`,
      };
    return { text: `${m.name} is listening.`, ready: true };
  })();
  // The passkey is a note on Start (its tooltip, and what a screen reader hears with it),
  // not the status line: that line is for what is happening. A browser's only: the app's
  // Start brings up its own prompt, which says what it is.
  const passkeyNote =
    signerKind() === "passkey" && grant.exp === null && !gate ? "Start asks for your passkey, once today." : null;

  // ----- the rows -----
  const agentLabel = (h: string) => harnessMark(h).label;
  // A machine that can't take a start from here is listed, off, with its few words; the
  // hour a new phone waits is the phone's, said once in the foot, not on every row.
  const machineOptions: SelectOption<string>[] = listed.map((x) => {
    const b = why(x);
    const f = machineFacts(x.control, agentLabel);
    return {
      value: x.name,
      label: x.name,
      ...(b?.kind === "machine" ? { hint: b.short } : f),
      disabled: machineBlocked(b),
    };
  });
  // What each agent's account has left here: its tightest window, or each account's by
  // name; on a machine that pools the agent's accounts, the pool's current one and the count.
  const limits = useLimits();
  const now = useNow("coarse");
  const left = (h: string) => (machine ? agentLeft(h, machine, c, limits, now, harnessMark(h).label) : {});
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
        ? folderChoices({
            sessions: [...sessions.values()],
            machine,
            folders: c.folders,
            home: machineHome(c),
            favorites,
          })
        : { pinned: [], recent: [], allowed: [] },
    [machine, c, sessions, favorites],
  );
  const toFolderOption = (
    f: { path: string; display: string; repo?: string },
    o: { divider?: boolean; pinned?: boolean } = {},
  ): SelectOption<string> => {
    const fmt = formatFolder(f.display, f.repo);
    const hint = f.repo && f.repo !== fmt.name ? f.repo : o.pinned ? "Pinned" : undefined;
    return {
      value: f.path,
      label: fmt.name || f.display,
      ...(hint ? { hint } : {}),
      ...(fmt.parent ? { detail: fmt.parent, detailMono: true } : {}),
      ...(o.divider ? { divider: true } : {}),
    };
  };
  const folderOptions: SelectOption<string>[] = [
    ...choices.pinned.map((f) => toFolderOption(f, { pinned: true })),
    ...choices.recent.map((f, i) => toFolderOption(f, { divider: i === 0 && choices.pinned.length > 0 })),
    ...choices.allowed.map((f, i) =>
      toFolderOption(f, { divider: i === 0 && (choices.pinned.length > 0 || choices.recent.length > 0) }),
    ),
  ];
  const typed = (t: string): SelectOption<string> | null => {
    if (!machine) return null;
    const pathLike = t.startsWith("/") || t.startsWith("~") || /^[A-Za-z]:[\\/]/.test(t);
    if (!pathLike && filterOptions(folderOptions, t).length > 0) return null;
    const r = typedFolder(t, { folders: c?.folders, home: machineHome(c), machine });
    if (!r.ok) {
      const disabled = !pathLike || r.reason.includes("without . or ..");
      return { value: t, label: t, hint: r.reason, ...(disabled ? { disabled: true } : {}) };
    }
    const display = tildify(r.path, machineHome(c));
    const fmt = formatFolder(display);
    return {
      value: r.path,
      label: fmt.name || display,
      ...(fmt.parent ? { detail: fmt.parent, detailMono: true } : {}),
    };
  };
  const renderFolderValue = (chosenList: SelectOption<string>[]): ReactNode => {
    if (!folder) return <span className="sel-placeholder">Choose…</span>;
    if (!folderCheck.ok && chosenList.length > 0) {
      return (
        <span className="ns-folder-val" title={folder}>
          <FolderGlyph />
          <span className="ns-folder-name mono">{folder}</span>
        </span>
      );
    }
    const display = tildify(folder, machineHome(c));
    const fmt = formatFolder(display);
    return (
      <span className="ns-folder-val" title={fmt.full}>
        <FolderGlyph />
        <span className="ns-folder-name">{fmt.name || display}</span>
        {fmt.compactParent && <span className="ns-folder-parent mono">{fmt.compactParent}</span>}
      </span>
    );
  };
  const folderPinned = machine && folderCheck.ok ? isFavoriteFolder(favorites, folderCheck.path) : false;
  const togglePinFolder = () => {
    if (!machine || !folderCheck.ok) return;
    setFavorites(toggleFavoriteFolder(machine, folderCheck.path));
  };
  const folderPin =
    machine && folderCheck.ok ? (
      <button
        type="button"
        className={`icon-btn ns-pin ${folderPinned ? "ns-pin--on" : ""}`}
        aria-label={folderPinned ? "Unpin folder" : "Pin folder"}
        aria-pressed={folderPinned}
        data-tip={phone ? undefined : folderPinned ? "Unpin folder" : "Pin folder"}
        data-ns-pin
        onClick={togglePinFolder}
      >
        <StarGlyph filled={folderPinned} />
      </button>
    ) : null;
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
        chosen.aside ? (
          <span
            className={`ns-aside num ns-quota ${
              chosen.tone === "out" || chosen.out
                ? "ns-aside--out ns-quota--out"
                : chosen.tone === "low"
                  ? "ns-quota--low"
                  : "ns-quota--neutral"
            }`}
            data-ns-left
            data-tone={chosen.tone ?? (chosen.out ? "out" : "neutral")}
            title={chosen.asideTip}
          >
            {chosen.aside}
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
            renderValue={renderFolderValue}
            custom={typed}
            filterPlaceholder="Search, or type a path"
            className="ns-sel ns-sel--folder"
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
          <span className="ns-row-end">
            {folderPin}
            <span className="ns-aside">{machine} didn't list its folders; it checks the path itself</span>
          </span>
        ) : (
          folderPin
        ),
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

  // A file that goes but is no picture the agent can look at is said once, under them all.
  const fileNote = files.find((f) => f.note && !f.error)?.note;
  const chips = files.length > 0 && (
    <>
      <ul className="ns-files" aria-label="Files">
        {files.map((f) => (
          <li
            key={f.key}
            className={`ns-file ${f.error ? "ns-file--err" : ""}`}
            data-file-state={
              f.error ? "error" : f.entry ? "held" : f.shrinking ? "shrinking" : f.waiting ? "waiting" : "uploading"
            }
            title={
              f.shrinking
                ? SHRINKING_WORDS
                : f.was && !f.error
                  ? `${f.name} · ${bytes(f.size)} (was ${bytes(f.was)})`
                  : (f.note ?? undefined)
            }
          >
            {!f.entry && !f.error && <span className="spinner" aria-hidden="true" />}
            <span className="ns-file-name ellipsis">{f.name}</span>
            <span className="ns-file-size num">{f.error ?? (f.shrinking ? SHRINKING_WORDS : bytes(f.size))}</span>
            {f.failed?.retry && f.file && (
              <button
                type="button"
                className="icon-btn ns-file-x"
                aria-label={`Try ${f.name} again`}
                data-tip="Try again"
                onClick={() => retry(f)}
              >
                <RefreshIcon size={10} />
              </button>
            )}
            <button
              type="button"
              className="icon-btn ns-file-x"
              aria-label={`Remove ${f.name}`}
              onClick={() => removeFile(f.key)}
            >
              <CloseIcon size={10} />
            </button>
          </li>
        ))}
      </ul>
      {fileNote && (
        <p className="ns-files-note" data-ns-files-note>
          {fileNote}
        </p>
      )}
    </>
  );

  const fileButton = takesFiles && !filesRefused && (
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
          className={`icon-btn ns-attach ${files.length > 0 ? "ns-attach--has" : ""}`}
          aria-label={files.length > 0 ? `Add files (${files.length} attached)` : "Add files"}
          data-tip="Add files"
          onClick={() => fileInput.current?.click()}
        >
          <PaperclipIcon size={16} />
          {files.length > 0 && (
            <span className="ns-attach-count num" aria-hidden="true">
              {files.length}
            </span>
          )}
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
  const fixed = m && c && harness ? fixedPermission(c, harness, PERMISSION_LABEL) : null;
  // A phone has its note under the row; a desktop's options line has it in one run.
  const fixedValue = fixed && (
    <span className="ns-fixed" title={machine ? START.setOn(machine) : undefined}>
      {phone ? fixed.value : fixedLine(fixed)}
    </span>
  );
  const fixedNote = fixed?.note ? <span className="ns-aside">{fixed.note}</span> : null;
  const startKeys = hintFor("newSession.start");
  const hasDraft = Boolean(text.trim() || files.length > 0);
  // Not approved yet: the way on is Approve this iPhone; the draft stays for when it can.
  const approveHere = () => {
    close();
    navigate("/add-device");
  };
  // On a phone the foot says one thing, and nothing when all is well: a problem, what is
  // under way, else a browser's passkey note. A desktop keeps its line and the note on Start.
  const line: typeof status = !phone
    ? status
    : status && !status.ready
      ? status
      : passkeyNote
        ? { text: passkeyNote, ready: true }
        : null;
  // A Start that is off is described by the line that says why, and by the passkey note
  // (on a phone that note is the line).
  const startWhy =
    [line && (!canStart || (phone && line.ready)) ? "ns-status" : null, passkeyNote && !phone ? "ns-passkey" : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const statusDotClass = !line?.text
    ? null
    : line.tone === "err"
      ? "ns-status-dot ns-status-dot--err"
      : line.ready
        ? "ns-status-dot ns-status-dot--ok"
        : "ns-status-dot ns-status-dot--ring";
  // Kept in place while empty, so what it says later is read out where it was.
  const statusLine = (line || phone) && (
    <p
      id="ns-status"
      className={`ns-status ${line?.tone === "err" ? "ns-status--err" : ""}`}
      role="status"
      aria-live="polite"
    >
      {statusDotClass && <span className={statusDotClass} aria-hidden="true" />}
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

  // No machine paired here yet: nothing to fill in, one way on (Connect pairs one).
  const noMachine = !!snapshotAt && !listed.some((x) => x.control);
  const pairOne = () => {
    close();
    // A computer joins a spacesheep account on spacesheep; Machines says where.
    navigate(accountMode() ? "/machines" : "/connect");
  };
  const empty = unapproved ? (
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
  ) : (
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
  // Nothing to fill in: no machine, or nothing on the form could start (not approved).
  const form = !noMachine && !unapproved;

  if (phone)
    return withFormScrim(
      close,
      closing,
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
          {!form ? (
            <span />
          ) : (
            <button
              type="button"
              className="ns-bar-btn ns-bar-btn--start"
              onClick={() => void start()}
              disabled={!canStart}
              aria-busy={busy || undefined}
              aria-describedby={startWhy}
              data-ns-start
            >
              {busy ? "Starting…" : "Start"}
            </button>
          )}
          <span className="ns-grab" aria-hidden="true" />
        </header>
        <div className="ns-scroll">
          {!form ? (
            empty
          ) : (
            <>
              <div className="ns-group">{rows}</div>
              <div className="ns-group ns-group--text">{message}</div>
              {chips}
              {(showPermission || fixed || showModel || takesFiles) && (
                <div className="ns-group">
                  {showPermission && row("permission", "Permission", permissionSelect)}
                  {fixed && row("options", "Permission", fixedValue, fixedNote)}
                  {showModel && row("model", "Model", modelSelect)}
                  {takesFiles && <div className="ns-row">{fileButton}</div>}
                </div>
              )}
              <div className="ns-group-foot">
                <HeldNotice h={held} focusBack={startButton} />
                {statusLine}
                {(text || files.length > 0) && (
                  <button type="button" className="ns-discard" onClick={discard}>
                    Discard draft
                  </button>
                )}
              </div>
            </>
          )}
        </div>
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
        <header className="ns-head">
          <h2 className="ns-title" id="ns-title">
            New session
          </h2>
          {form && hasDraft && (
            <button
              type="button"
              className="btn btn--sm btn--ghost ns-head-discard"
              onClick={discard}
              title="Discard draft"
              data-ns-discard
            >
              Discard
            </button>
          )}
        </header>
        {!form ? (
          empty
        ) : (
          <>
            {rows}
            {message}
            {chips}
            <div className="ns-opts">
              {fileButton}
              {fileButton && (showPermission || fixed || showModel) && (
                <span className="ns-opts-sep" aria-hidden="true" />
              )}
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
                  {fixedValue}
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
            <HeldNotice h={held} focusBack={startButton} />
            <footer className="ns-foot">
              {statusLine}
              <span className="ns-actions">
                <button type="button" className="btn" onClick={close} data-ns-cancel>
                  Cancel
                </button>
                <ActionButton
                  className="btn btn--primary ns-start"
                  onClick={start}
                  disabled={!canStart && !busy}
                  pending={busy}
                  pendingLabel="Starting…"
                  aria-describedby={startWhy}
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

/** Crisp 14 px monochrome folder glyph for the Folder trigger. */
function FolderGlyph() {
  return <FolderIcon size={14} className="ns-folder-icon" />;
}

/** Crisp 14 px star glyph for pinning/unpinning the chosen folder. */
function StarGlyph({ filled }: { filled: boolean }) {
  return <StarIcon size={14} filled={filled} />;
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
