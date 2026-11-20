// SPDX-License-Identifier: Apache-2.0
// Pictures beside a prompt, self-contained so any composer can place it: a hook that holds
// the uploads (paperclip, paste, drop, the phone's picker or camera), the tray of
// thumbnails above the input, the paperclip button, and the thumbnails a sent prompt shows
// wherever its text is drawn. How a picture goes is decided per session, from its machine
// (`pictureMode`):
//  - "files": as CONTROL.md `files` on the prompt, for a daemon that takes them (sessionpipe
//    0.10). The page uploads the bytes to the receiver, holds the receiver's hash against
//    its own, and signs each picture's name, type, size and hash; the machine fetches them
//    with its own token and saves them in the session's folder. Nothing is added to the text.
//  - "path": the text block of absolute paths (shared/attachments.ts), for an older daemon
//    on the machine the GUI runs on.
//  - "off": no way to send one (an older daemon on another machine, or one reached through
//    a spacesheep that refused this app's uploads): no paperclip, and a picture pasted or
//    dropped is answered in words.
// A computer reached through spacesheep takes its pictures as files too: the upload goes to
// spacesheep (the receiver's or the hub's files door), where the computer fetches it.
// No address of this board and no key to it is ever in what is signed.
// A sent message shows what it carried under its words: a thumbnail of each picture the
// receiver still keeps (GET …/control/files/:sha) or, where no receiver keeps it, this page
// does (sentPictures.ts); else a chip with its name, type and size.
// Before the session's record of the turn arrives that is the sent row's `files`; after, the
// list of saved files the machine added to the message, each found again by its nonce.
// A picture held somewhere this page can't show it from is a chip that says where it is
// kept: one an older version of this page named (on a spacesheep account, which holds no
// receiver's pictures), and one spacesheep's Talk pane linked to (the link is never drawn).
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  ATTACHMENTS_PER_MESSAGE,
  type Attachment,
  type AttachmentType,
  type ControlActivity,
  type Info,
  type MachineControl,
  ROUTES,
  START_FILE_MAX_BYTES,
  START_FILES_TOTAL_BYTES,
  type StartFile,
  splitKey,
  type UploadedFile,
} from "@shared/api";
import {
  type AttachmentRef,
  attachmentLines,
  composePrompt,
  humanSize,
  type LinkPictureRef,
  PROMPT_MAX_CHARS,
  type PromptItem,
  type SavedFileRef,
  splitAttachments,
  UPLOAD_REFUSED,
  UPLOAD_WORDS,
} from "@shared/attachments";
import {
  type ChangeEvent,
  type ClipboardEvent,
  createContext,
  type DragEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Redacted } from "../components/bits";
import { useContextMenu } from "../components/ContextMenu";
import { useTouchKeys } from "../lib/device";
import { copyItem } from "../lib/menus";
import { accountMode, apiFetch, apiUpload, apiUrl, uploadProgress } from "../lib/net";
import { ControlError, controlApi, uploadRefusal } from "./api";
import { b64url, sha256 } from "./bytes";
import { Lightbox } from "./Lightbox";
import { heldSentPicture, keepSentPicture, useSentPictureUrls } from "./sentPictures";
import { PICKER_DESK, PICKER_TOUCH, pictureType, refuseInput, shrinkImage, stillOverWords } from "./shrink";
import { boardName, spacesheepName, uploadWords } from "./uploadWords";
import "./attachments.css";

// ---------- how a picture goes ----------

export type PictureMode = "files" | "path" | "off";

/** How the composer sends a picture to a session on this machine's control row, or
 *  undefined while that is not known (no row yet, or `thisMachine` not read yet where it
 *  decides). `thisMachine`: the session runs on the machine the GUI runs on. */
export function pictureMode(
  control: Pick<MachineControl, "promptFiles" | "remote"> | undefined,
  thisMachine: boolean | null,
  spacesheepRefused = false,
): PictureMode | undefined {
  if (!control) return undefined;
  // Through spacesheep, a picture goes as a file uploaded there, or not at all: no path of
  // this disk means anything on that computer. `spacesheepRefused`: spacesheep would not take
  // this app's uploads (`useSpacesheepRefused`).
  if (control.remote) return control.promptFiles && !spacesheepRefused ? "files" : "off";
  if (control.promptFiles) return "files";
  if (thisMachine === null) return undefined;
  return thisMachine ? "path" : "off";
}

/** Why no picture can go to `machine`, as the line under the field says it when one is
 *  pasted or dropped: its sessionpipe is too old for them (`old`, wherever it is reached
 *  from), or spacesheep would not take this app's uploads (`spacesheep`). What is between
 *  backticks is a command to type. */
export function picturesOffWords(machine: string, why: "old" | "spacesheep" = "old"): string {
  return why === "spacesheep"
    ? UPLOAD_WORDS.refused
    : `Pictures can't be sent to ${machine}: its sessionpipe is older than 0.10. Run \`sessionpipe update\` there.`;
}

// spacesheep answered an upload of this app's that it takes none from it (an older
// spacesheep, or no Talk on the account): no paperclip for a computer reached through it,
// for the rest of the page's life.
let spacesheepRefused = false;
const refusedWatchers = new Set<() => void>();
/** spacesheep refused an upload of this page's (UPLOAD_REFUSED). */
export function markSpacesheepRefused(on = true): void {
  if (spacesheepRefused === on) return;
  spacesheepRefused = on;
  for (const w of [...refusedWatchers]) w();
}
/** Whether spacesheep refused this page's uploads. */
export const spacesheepRefusesPictures = (): boolean => spacesheepRefused;
/** The same, kept current. */
export function useSpacesheepRefused(): boolean {
  return useSyncExternalStore(
    (w) => {
      refusedWatchers.add(w);
      return () => void refusedWatchers.delete(w);
    },
    () => spacesheepRefused,
  );
}

/** The pictures of one message are over the protocol's total (CONTROL.md §3.1). */
export const TOGETHER_WORDS = "These pictures are over 50 MB together. Remove one.";
/** The receiver's hash or size of an upload is not the page's own. */
export const NOT_WHOLE_WORDS = UPLOAD_WORDS.notWhole;
/** Send is off while a picture in the tray failed: what to do about it. */
export const FAILED_WORDS = "Remove or retry the picture that didn't upload.";
/** The same, where trying again can't help (Retry isn't offered). */
export const REMOVE_WORDS = "Remove the picture that didn't upload.";
/** A picture uploaded the way this session's machine no longer takes pictures. */
export const ELSEWHERE_WORDS = "This picture can't go to this machine now. Remove it.";
/** A file dropped on the session page that is no picture. */
export const ONLY_PICTURES_WORDS = "Only pictures can be dropped here.";
/** Send was pressed while pictures still upload: nothing goes until they are in. */
export const waitingWords = (n: number): string =>
  n === 1 ? "Waiting for 1 picture to finish uploading." : `Waiting for ${n} pictures to finish uploading.`;
/** This many upload at once; the rest wait their turn (the tray, New session's files). */
export const UPLOADS_AT_ONCE = 2;
/** CONTROL.md §3.1: a file's name is at most this long. */
const NAME_MAX = 200;
const PICTURE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif)$/i;

/** A picture's name as the signed command gives it, which is the name the machine saves it
 *  under: NFC; every kind of space a plain one (a macOS screenshot's name has a narrow
 *  no-break space before "PM"); no control or format character (one that turns the reading
 *  direction, or has no width), slash or backslash; no leading dot;
 *  "image" when nothing is left; the extension the type's own; at most 200 characters (the
 *  name is cut, never the extension); and not a name already `taken` in this message,
 *  whatever its case: image.png, image-2.png, … */
export function pictureName(name: string, type: string, taken: Iterable<string> = []): string {
  const own = ATTACHMENT_TYPES[type as AttachmentType];
  const ext = own ? `.${own}` : "";
  let base = name
    .normalize("NFC")
    .replace(/[\p{Zs}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[\p{Cc}\p{Cf}/\\]/gu, "");
  if (ext) base = base.replace(PICTURE_EXT_RE, "");
  base = base.replace(/^[. ]+/, "").replace(/[. ]+$/, "") || "image";
  const used = new Set(Array.from(taken, (n) => n.normalize("NFC").toLowerCase()));
  for (let n = 1; ; n++) {
    const end = (n === 1 ? "" : `-${n}`) + ext;
    const candidate = cutTo(base, NAME_MAX - end.length) + end;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** The first characters of `s` that fit `max` UTF-16 units, never half of a pair. */
function cutTo(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** The words a message of pictures alone is signed with: CONTROL.md wants 1 to 20 000
 *  characters that are not all whitespace, and every daemon refuses an empty text. */
export const fillerText = (pictures: number): string =>
  pictures === 1 ? "Look at the attached picture." : `Look at the ${pictures} attached pictures.`;

// ---------- the upload itself ----------

const ACCEPT = Object.keys(ATTACHMENT_TYPES);

/** "640 KB", "1.2 MB", "12 MB". */
const mb = (n: number): string => {
  const m = n / (1024 * 1024);
  if (m < 1) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10} MB`;
};

/** How far the uploads are, as the tray's line says it: "Uploading 1.2 of 2.1 MB…" where
 *  the bytes sent are counted (`sent`, a browser), else "Uploading 2.1 MB…" (the apps).
 *  Both numbers in the unit of the whole. */
export function progressWords(total: number, sent?: number): string {
  const whole = mb(total);
  if (sent === undefined) return `Uploading ${whole}…`;
  const mega = whole.endsWith("MB");
  const part = Math.min(sent, total) / (mega ? 1024 * 1024 : 1024);
  const tenths = mega && total < 10 * 1024 * 1024;
  return `Uploading ${tenths ? (Math.floor(part * 10) / 10).toFixed(1) : Math.floor(part)} of ${whole}…`;
}

/** Why a file cannot be attached, in words; null when it can. Checked before any upload.
 *  One picture is at most what a command's file may be (25 MiB) where it goes as one, and
 *  ATTACHMENT_MAX_BYTES where the prompt names it by path. `board`: what takes it. */
export function refuseFile(file: Blob, mode: "files" | "path" = "path", board = boardName(hostSeen)): string | null {
  if (!ACCEPT.includes(file.type))
    return file.type.startsWith("image/")
      ? "That kind of picture can't be sent. Use PNG, JPEG, GIF or WebP."
      : "That file isn't a picture.";
  const limit = mode === "files" ? START_FILE_MAX_BYTES : ATTACHMENT_MAX_BYTES;
  if (file.size > limit) return `That picture is too big for ${board}.`;
  return null;
}

/** An upload that didn't make it: its words, and whether Retry can help. */
export class UploadFailed extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
    this.name = "UploadFailed";
  }
}

/** What an upload threw, as the tray says it; a stop (the picture was removed) as it is.
 *  The board is named as its Info says, once that is in; `remote`: the upload went on to
 *  spacesheep (a computer reached through it), which is named instead. */
async function failed(e: unknown, remote?: boolean): Promise<Error> {
  if (e instanceof UploadFailed || (e instanceof DOMException && e.name === "AbortError")) return e;
  // spacesheep takes none from this app: no paperclip for its computers from now on.
  if (e instanceof ControlError && e.reason === UPLOAD_REFUSED) markSpacesheepRefused();
  const f = uploadWords(e, remote ? spacesheepName() : await boardNow());
  return new UploadFailed(f.words, f.retry);
}

/** The board an upload's words name, once its Info is in (or as well as it is known). */
export async function boardNow(): Promise<string> {
  await hostInfo().catch(() => undefined);
  return boardName(hostSeen);
}

/** How one upload is stopped, and hears how far it got. */
export interface UploadOpts {
  signal?: AbortSignal;
  onProgress?: (sent: number, total: number) => void;
}

/** A picture as a signed command's file names it, with its pixels where the receiver read them. */
export type PictureEntry = UploadedFile;

/** Upload one picture as a file a prompt will carry, under `name`, and check it arrived
 *  whole: the page hashes the very bytes it sent, and an answer with another hash or size
 *  is refused, so what is signed is the page's own word on the bytes. Throws the words.
 *  `remote`: the machine is reached through spacesheep, so no receiver keeps the picture to
 *  show: the page keeps it (sentPictures.ts), as it does for every one on an account. */
export async function uploadPicture(
  file: Blob,
  name: string,
  machineId?: string,
  opts: UploadOpts & { remote?: boolean } = {},
): Promise<PictureEntry> {
  const { remote, ...up } = opts;
  const why = refuseFile(file, "files", remote ? spacesheepName() : undefined);
  if (why) throw new UploadFailed(why, false);
  const buf = await file.arrayBuffer();
  let held: UploadedFile;
  let hash: string;
  try {
    [hash, held] = await Promise.all([
      sha256(new Uint8Array(buf)).then(b64url),
      controlApi.uploadFile(new File([buf], name, { type: file.type }), machineId, up),
    ]);
  } catch (e) {
    throw await failed(e, remote);
  }
  if (held.sha256 !== hash || held.size !== buf.byteLength) throw new UploadFailed(NOT_WHOLE_WORDS, true);
  if (remote || accountMode()) void keepSentPicture(hash, buf, file.type).catch(() => {});
  const entry: PictureEntry = { name, type: file.type, size: buf.byteLength, sha256: hash };
  if (typeof held.width === "number" && typeof held.height === "number") {
    entry.width = held.width;
    entry.height = held.height;
  }
  return entry;
}

/** What a message with these pictures signs where they go as files: its words as written,
 *  or the filler when there are none; the pictures in the tray's order, each by its four
 *  signed fields. Nothing about a picture is in the text. */
export function composeFiles(
  message: string,
  entries: readonly PictureEntry[],
): { text: string; files: StartFile[]; names: string[] } {
  const files = entries.map((e) => ({ name: e.name, type: e.type, size: e.size, sha256: e.sha256 }));
  return {
    text: message.trim() || (files.length > 0 ? fillerText(files.length) : ""),
    files,
    names: files.map((f) => f.name),
  };
}

/** POST the image as the raw body, for a prompt that names it by path (also the theme
 *  api's control.attach); the server validates the bytes and reads the size. */
export async function uploadAttachment(file: Blob, opts: UploadOpts = {}): Promise<Attachment> {
  const why = refuseFile(file);
  if (why) throw new UploadFailed(why, false);
  let res: Response;
  try {
    res = await apiUpload(ROUTES.ui.attachments, {
      headers: { "content-type": file.type, accept: "application/json" },
      body: await file.arrayBuffer(),
      ...opts,
    });
    if (!res.ok) throw await uploadRefusal(res);
  } catch (e) {
    throw await failed(e);
  }
  return (await res.json().catch(() => ({}))) as Attachment;
}

/** Take back an upload that was not sent. Best effort: the daily prune catches strays. */
export function deleteAttachment(a: Pick<Attachment, "id" | "ext">): Promise<void> {
  return apiFetch(`${ROUTES.attachments}/${a.id}.${a.ext}`, { method: "DELETE" })
    .then(() => undefined)
    .catch(() => undefined);
}

let infoPromise: Promise<Info> | null = null;
/** The receiver's machine, once its Info came: the name an upload's words give the board. */
let hostSeen: string | undefined;
/** Info, read once per page: `hostname` says which machine the paths mean something on. */
function hostInfo(): Promise<Info> {
  if (!infoPromise)
    infoPromise = apiFetch(ROUTES.ui.info, { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<Info>)
      .then((i) => {
        hostSeen = i.hostname || undefined;
        return i;
      })
      .catch((e) => {
        infoPromise = null;
        throw e;
      });
  return infoPromise;
}

/** Whether a session's `machine` is the one the GUI runs on (sessionpipe's rule for
 *  the name: the hostname without `.local`; compared case-insensitively). */
export function isThisMachine(machine: string | undefined, hostname: string | undefined): boolean {
  if (!machine || !hostname) return false;
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/\.(local|lan|home)\.?$/, "");
  return norm(machine) === norm(hostname);
}

/** `isThisMachine` for a session's machine, from the page's Info: null until it arrived. */
export function useThisMachine(machine: string | undefined): boolean | null {
  const [hostname, setHostname] = useState<string | undefined | null>(null);
  useEffect(() => {
    let on = true;
    hostInfo()
      .then((i) => on && setHostname(i.hostname))
      .catch(() => on && setHostname(undefined));
    return () => {
      on = false;
    };
  }, []);
  return hostname === null ? null : isThisMachine(machine, hostname);
}

/** A file of an image type, or a HEIC that came with no type (from Files or Finder). */
const isImage = (f: File): boolean => f.type.startsWith("image/") || (!f.type && !!pictureType("", f.name));

/** Image files out of a paste or a drop (a pasted screenshot comes as one file item). */
export function imageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items?.length) {
    for (const it of Array.from(dt.items)) {
      if (it.kind !== "file") continue;
      const f = it.getAsFile();
      if (f && isImage(f)) out.push(f);
    }
  }
  if (out.length === 0 && dt.files?.length) {
    for (const f of Array.from(dt.files)) if (isImage(f)) out.push(f);
  }
  return out;
}

/** A drag or a drop carries files (of any kind): the browser would open one the page lets fall. */
const carriesFiles = (dt: DataTransfer | null): boolean => Array.from(dt?.types ?? []).includes("Files");

// ---------- the composer's state ----------

export interface PendingItem {
  /** Local key, for as long as it is in the tray. */
  key: string;
  /** What goes: the shrunk picture once it is made (shrink.ts), else the original; kept
   *  for Retry. Empty for a picture brought back from a draft. */
  file: Blob;
  /** For the thumbnail: an object URL (revoked on remove), or the receiver's copy of a
   *  picture brought back from a draft. */
  preview: string;
  bytes: number;
  /** The original's size, where what goes is a smaller redraw of it. */
  was?: number;
  /** It is being made smaller (one at a time on the page); its upload waits for that. */
  shrinking?: boolean;
  /** The way it goes, as the session's machine took pictures when it was added. */
  via: "files" | "path";
  /** The machine it was added for, which fetches it. */
  machine?: string;
  /** That machine is reached through spacesheep: the upload goes on to spacesheep. */
  remote?: boolean;
  /** The name it goes under: a file's signed name (`pictureName`), else the file's own. */
  name: string;
  /** Its upload has not begun: two run at a time. */
  waiting?: boolean;
  /** Bytes of it sent so far, where that is counted (a browser). */
  sent?: number;
  /** Uploaded, where the prompt names it by path. */
  attachment?: Attachment;
  /** Uploaded and checked, where it goes as a file: what the command signs of it. */
  entry?: PictureEntry;
  /** When its upload was checked (ms): the receiver holds it a day from then. */
  at?: number;
  /** Brought back from the session's draft: `preview` is no object URL. */
  restored?: boolean;
  error?: string;
  /** Its upload failed in a way trying again can mend: Retry is offered. */
  retry?: boolean;
}

/** A picture kept with a session's draft: what the command signs of it, and when it was
 *  uploaded. */
export interface KeptPicture extends PictureEntry {
  at: number;
}

/** CONTROL.md §3.1: a command's files are at most 50 MiB together. A refused one is not
 *  sent, and one still being made smaller is counted once it is. */
const overTogether = (list: readonly PendingItem[]): boolean =>
  list.reduce((n, it) => n + (it.error || it.shrinking ? 0 : it.bytes), 0) > START_FILES_TOTAL_BYTES;

/** Where an item is on its way into the message. */
export const itemState = (it: PendingItem): "error" | "ready" | "shrinking" | "waiting" | "uploading" =>
  it.error
    ? "error"
    : it.attachment || it.entry
      ? "ready"
      : it.shrinking
        ? "shrinking"
        : it.waiting
          ? "waiting"
          : "uploading";

/** The receiver's copy of a picture it holds (the thumbnail of one brought back from a
 *  draft). None on an account: the hub serves no file the receiver holds, so the tray
 *  draws the frame alone. */
export const heldPictureUrl = (sha: string): string =>
  accountMode() ? "" : apiUrl(`${ROUTES.ui.control}/files/${sha}`);

/** The tray's pictures a draft keeps: each one uploaded as a file and checked. */
export const keptPictures = (items: readonly PendingItem[]): KeptPicture[] =>
  items.flatMap((it) =>
    it.via === "files" && it.entry && !it.error ? [{ ...it.entry, at: it.at ?? Date.now() }] : [],
  );

export interface ComposeResult {
  /** The text to sign. */
  text: string;
  /** The pictures as the command's `files`, in the tray's order; absent where none goes so. */
  files?: StartFile[];
  /** The pictures' names, in the tray's order. */
  names: string[];
  /** The block's lines as written into `text` (attachmentLines), where the prompt names its
   *  pictures by path: what this page attached. Empty otherwise. */
  lines: string[];
}

export interface AttachmentsHandle {
  items: readonly PendingItem[];
  /** A picture is being made smaller, or its upload is in flight or waits its turn: the
   *  composer should hold Send. */
  uploading: boolean;
  /** A picture in the tray failed, or can't go to this machine now: Send is off until it
   *  is removed or retried, and says so in these words (`FAILED_WORDS`, `REMOVE_WORDS`
   *  where none can be retried, `ELSEWHERE_WORDS`). */
  failed: string | null;
  /** A file was refused or an upload failed, the pictures are too much together, or the
   *  text would be over the cap. */
  error: string | null;
  /** The tray's one line: `error`, else what an upload is doing (how far it is, or that a
   *  send waits for it). */
  note: { text: string; tone: "err" | "info" } | null;
  /** A file is being dragged over the drop zone, and would be taken. */
  dragging: boolean;
  /** How pictures go to this session's machine; undefined while not known. */
  mode: PictureMode | undefined;
  /** The paperclip has a place here: every mode but "off". */
  offered: boolean;
  add(files: Iterable<Blob>): void;
  remove(key: string): void;
  /** Upload a failed one again, from the bytes it kept. */
  retry(key: string): void;
  clear(): void;
  /** Put these pictures in the tray in place of what is there (a session's draft).
   *  `land`: where a picture still uploading as a file goes once it is in (the draft it
   *  was added to); without it, its upload stops. */
  restore(kept: readonly KeptPicture[], land?: (p: KeptPicture) => void): void;
  /** Add one picture already uploaded (one of this draft's that finished elsewhere). */
  adopt(p: KeptPicture): void;
  /** What to sign: `message` and the pictures, the way this machine takes them. Null (and
   *  the line set) when nothing can go: an upload is still running (the line says Send
   *  waits for it) or failed, the pictures are too much together, or the text is over the cap. */
  compose(message: string): ComposeResult | null;
  /** Spread onto the drop zone element (the form) and the textarea. */
  handlers: {
    onPaste(e: ClipboardEvent): void;
    onDragOver(e: DragEvent): void;
    onDragLeave(e: DragEvent): void;
    onDrop(e: DragEvent): void;
  };
  /** The same for a drag or a drop anywhere on the page (`usePageDrop`). */
  page: {
    over(e: globalThis.DragEvent): void;
    drop(e: globalThis.DragEvent): void;
    leave(): void;
  };
}

/** `mode`: how this session's machine takes pictures (`pictureMode`); `machineId`: the
 *  machine an upload is for; `remote`: it is reached through spacesheep. `onRefused`: a
 *  picture was pasted or dropped where none can be sent ("off"), so the composer says why
 *  (`picturesOffWords`); nothing is swallowed. `initial`: the pictures the tray opens with
 *  (a session's draft); `land`: where a picture still uploading as a file when the
 *  composer closes goes once it is in (that draft). */
export function useAttachments(o: {
  machineId?: string;
  remote?: boolean;
  enabled?: boolean;
  mode?: PictureMode;
  onRefused?: () => void;
  initial?: () => readonly KeptPicture[];
  land?: (p: KeptPicture) => void;
}): AttachmentsHandle {
  const seq = useRef(0);
  const fromKept = useCallback(
    (kept: readonly KeptPicture[]): PendingItem[] =>
      kept.map((k) => {
        const { at, ...entry } = k;
        return {
          key: `p${++seq.current}`,
          file: new Blob([], { type: entry.type }),
          preview: heldPictureUrl(entry.sha256),
          bytes: entry.size,
          via: "files",
          name: entry.name,
          entry,
          at,
          restored: true,
        };
      }),
    [],
  );
  const [items, setItems] = useState<PendingItem[]>(() => fromKept(o.initial?.() ?? []));
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** Send was pressed while pictures upload: the line says so until they are in. */
  const [held, setHeld] = useState(false);
  /** The uploads have run a moment: their progress is worth a line. */
  const [slow, setSlow] = useState(false);
  /** The items whose upload began (its key), so none begins twice. */
  const started = useRef(new Set<string>());
  /** How each running upload is stopped, by item key. */
  const stops = useRef(new Map<string, AbortController>());
  const { mode, machineId } = o;
  const remote = !!o.remote;
  const takes = mode === "files" || mode === "path" ? mode : null;
  /** The composer is on; `enabled`: and its machine takes pictures. */
  const active = o.enabled !== false;
  const enabled = active && !!takes;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onRefused = useRef(o.onRefused);
  onRefused.current = o.onRefused;
  const landing = useRef(o.land);
  landing.current = o.land;

  const set = useCallback((key: string, patch: Partial<PendingItem>) => {
    setItems((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }, []);

  /** Pictures let go of while they uploaded (another draft restored, or the composer
   *  closed), by item key: where each goes once it is in. */
  const away = useRef(new Map<string, (p: KeptPicture) => void>());
  /** Of those, the ones let go of while they were being made smaller, by item key. */
  const parked = useRef(new Map<string, PendingItem>());

  const begin = useCallback(
    (it: PendingItem) => {
      started.current.add(it.key);
      set(it.key, { waiting: false, sent: 0 });
      const stop = new AbortController();
      stops.current.set(it.key, stop);
      const opts: UploadOpts = {
        signal: stop.signal,
        ...(uploadProgress() ? { onProgress: (sent: number) => set(it.key, { sent }) } : {}),
      };
      const going: Promise<Partial<PendingItem>> =
        it.via === "files"
          ? uploadPicture(it.file, it.name, it.machine, { ...opts, remote: it.remote }).then((entry) => ({
              entry,
              at: Date.now(),
            }))
          : uploadAttachment(it.file, opts).then((attachment) => ({ attachment }));
      going.then(
        (done) => {
          const land = away.current.get(it.key);
          away.current.delete(it.key);
          if (!land) set(it.key, done);
          else if (done.entry) land({ ...done.entry, at: done.at ?? Date.now() });
        },
        (e: Error) => {
          // Removed while it went, or gone with another draft: nothing is left to say it to.
          if (away.current.delete(it.key) || stop.signal.aborted) return;
          set(it.key, { error: e.message, retry: e instanceof UploadFailed && e.retry });
        },
      );
      void going.finally(() => {
        if (stops.current.get(it.key) === stop) stops.current.delete(it.key);
      });
    },
    [set],
  );

  /** Lets the tray's items go, but a picture still on its way as a file finishes, into
   *  `land` (the draft it was added to); without `land` its upload stops too. */
  const leave = useCallback(
    (land: ((p: KeptPicture) => void) | undefined, letGo: (it: PendingItem) => void) => {
      for (const it of itemsRef.current) {
        if (!land || it.via !== "files" || it.error || it.entry) {
          letGo(it);
          continue;
        }
        away.current.set(it.key, land);
        URL.revokeObjectURL(it.preview);
        // One still being made smaller uploads once it is (`shrunk`).
        if (it.shrinking) parked.current.set(it.key, it);
        else if (!started.current.has(it.key)) begin(it);
      }
    },
    [begin],
  );

  // Object URLs of what was never sent are let go with the composer, and its uploads stop
  // (but a picture's, which lands in its draft).
  useEffect(
    () => () =>
      leave(landing.current, (it) => {
        stops.current.get(it.key)?.abort();
        if (!it.restored) URL.revokeObjectURL(it.preview);
      }),
    [leave],
  );

  // Two uploads at a time, in the tray's order; the rest wait.
  useEffect(() => {
    let busy = items.filter((it) => started.current.has(it.key) && itemState(it) === "uploading").length;
    for (const it of items) {
      if (busy >= UPLOADS_AT_ONCE) break;
      if (!it.waiting || it.error || started.current.has(it.key)) continue;
      busy++;
      begin(it);
    }
  }, [items, begin]);

  /** `patch` the item now (so the next one shrunk sees its name) and at the next render. */
  const patchNow = useCallback(
    (key: string, patch: Partial<PendingItem>) => {
      itemsRef.current = itemsRef.current.map((p) => (p.key === key ? { ...p, ...patch } : p));
      set(key, patch);
    },
    [set],
  );

  /** An item made smaller (`small`), or left as it was (null): held to its machine's cap
   *  for one picture, named, and queued for its upload. */
  const shrunk = useCallback(
    (key: string, small: { blob: Blob } | null) => {
      const gone = parked.current.get(key);
      parked.current.delete(key);
      const it = gone ?? itemsRef.current.find((p) => p.key === key);
      // Taken back while it was being made smaller.
      if (!it) return;
      const file = small?.blob ?? it.file;
      const limit = it.via === "files" ? START_FILE_MAX_BYTES : ATTACHMENT_MAX_BYTES;
      if (gone) {
        // Its composer closed meanwhile: it uploads into its draft, or, too big, is dropped.
        if (file.size > limit) away.current.delete(key);
        else begin({ ...it, shrinking: false, file, bytes: file.size, name: pictureName(it.name, file.type, []) });
        return;
      }
      const patch: Partial<PendingItem> = { shrinking: false, file, bytes: file.size };
      if (small) {
        patch.was = it.file.size;
        patch.preview = URL.createObjectURL(file);
        URL.revokeObjectURL(it.preview);
      }
      if (file.size > limit) {
        patchNow(key, { ...patch, error: stillOverWords(limit, !!small) });
        return;
      }
      if (it.via === "files") {
        // The names this message's files already have: a file's name is its own in the message.
        const taken = itemsRef.current
          .filter((p) => p.key !== key && p.via === "files" && !p.error && !p.shrinking)
          .map((p) => p.name);
        patch.name = pictureName(it.name, file.type, taken);
      }
      patchNow(key, { ...patch, waiting: true });
    },
    [patchNow, begin],
  );

  const add = useCallback(
    (files: Iterable<Blob>) => {
      if (!enabled || !takes) return;
      setError(null);
      const list = Array.from(files);
      const room = ATTACHMENTS_PER_MESSAGE - itemsRef.current.length;
      if (list.length > room) {
        setError(`${ATTACHMENTS_PER_MESSAGE} pictures per message at most.`);
        list.length = Math.max(0, room);
      }
      const added = list.map((file): PendingItem => {
        const why = refuseInput(file);
        const own = file instanceof File ? file.name : "";
        const item = {
          key: `p${++seq.current}`,
          file,
          preview: URL.createObjectURL(file),
          bytes: file.size,
          name: own,
          ...(machineId ? { machine: machineId } : {}),
          ...(remote ? { remote } : {}),
        };
        return why ? { ...item, via: takes, error: why } : { ...item, via: takes, shrinking: true };
      });
      // Now, not at the next render: a second add in the same tick sees this count.
      itemsRef.current = [...itemsRef.current, ...added];
      setItems((prev) => [...prev, ...added]);
      // Each made smaller in the tray's order (one at a time, shrink.ts), then named, then
      // uploaded: the size a picture goes at is what its caps are held to.
      for (const it of added) {
        if (it.error) continue;
        const own = it.file instanceof File ? it.file.name : "";
        shrinkImage(it.file, { name: own }).then(
          (small) => shrunk(it.key, small),
          (e: Error) => {
            // Let go of meanwhile: nothing is left to say it to.
            if (parked.current.delete(it.key)) away.current.delete(it.key);
            else patchNow(it.key, { shrinking: false, error: e.message });
          },
        );
      }
    },
    [enabled, takes, machineId, remote, shrunk, patchNow],
  );

  /** Lets an item go: its upload stops, its thumbnail's URL is revoked, a path upload is taken back. */
  const letGo = useCallback((it: PendingItem) => {
    stops.current.get(it.key)?.abort();
    stops.current.delete(it.key);
    started.current.delete(it.key);
    if (!it.restored) URL.revokeObjectURL(it.preview);
    if (it.attachment) void deleteAttachment(it.attachment);
  }, []);

  const remove = useCallback(
    (key: string) => {
      const it = itemsRef.current.find((p) => p.key === key);
      if (it) letGo(it);
      itemsRef.current = itemsRef.current.filter((p) => p.key !== key);
      setItems((prev) => prev.filter((p) => p.key !== key));
      setError(null);
    },
    [letGo],
  );

  const retry = useCallback(
    (key: string) => {
      const it = itemsRef.current.find((p) => p.key === key);
      if (!it?.error || !it.retry) return;
      started.current.delete(key);
      setError(null);
      set(key, { error: undefined, retry: undefined, waiting: true, sent: undefined });
    },
    [set],
  );

  const clear = useCallback(() => {
    for (const it of itemsRef.current) {
      stops.current.get(it.key)?.abort();
      if (!it.restored) URL.revokeObjectURL(it.preview);
    }
    stops.current.clear();
    started.current.clear();
    itemsRef.current = [];
    setItems([]);
    setError(null);
  }, []);

  const restore = useCallback(
    (kept: readonly KeptPicture[], land?: (p: KeptPicture) => void) => {
      leave(land, letGo);
      const next = fromKept(kept);
      itemsRef.current = next;
      setItems(next);
      setError(null);
    },
    [fromKept, leave, letGo],
  );

  const adopt = useCallback(
    (p: KeptPicture) => {
      const cur = itemsRef.current;
      if (cur.length >= ATTACHMENTS_PER_MESSAGE || cur.some((it) => it.entry?.sha256 === p.sha256)) return;
      const next = [...cur, ...fromKept([p])];
      itemsRef.current = next;
      setItems(next);
    },
    [fromKept],
  );

  const uploading = items.some((it) => {
    const s = itemState(it);
    return s === "shrinking" || s === "waiting" || s === "uploading";
  });
  const failedOne = items.find((it) => it.error);
  // Uploaded the way this machine no longer takes pictures (a draft's, brought back).
  const misfit = mode !== undefined && items.some((it) => !it.error && it.via !== takes);
  // Too much together: said as soon as it is so, and until one is removed.
  const over = takes === "files" && overTogether(items);

  // The line that Send waits goes once the last upload settled; progress is said once the
  // uploads have run a moment (a quick one is never more than its spinner).
  // A drop's "only pictures" goes too, once the pictures it brought are in.
  useEffect(() => {
    if (!uploading) {
      setHeld(false);
      setSlow(false);
      setError((e) => (e === ONLY_PICTURES_WORDS ? null : e));
      return;
    }
    const t = window.setTimeout(() => setSlow(true), 400);
    return () => window.clearTimeout(t);
  }, [uploading]);

  const compose = useCallback(
    (message: string): ComposeResult | null => {
      const cur = itemsRef.current;
      if (cur.some((it) => it.error)) {
        setError(cur.some((it) => it.error && it.retry) ? FAILED_WORDS : REMOVE_WORDS);
        return null;
      }
      // One uploaded the way this machine no longer takes pictures (or not known yet).
      if (cur.some((it) => it.via !== takes)) {
        setError(mode === undefined ? null : ELSEWHERE_WORDS);
        return null;
      }
      if (cur.some((it) => itemState(it) !== "ready")) {
        setError(null);
        setHeld(true);
        return null;
      }
      if (takes === "files" && overTogether(cur)) return null;
      let out: ComposeResult;
      if (takes === "files" && cur.length > 0) {
        const entries = cur.map((it) => it.entry!);
        out = { ...composeFiles(message, entries), lines: [] };
      } else {
        const sent = cur.map((it) => it.attachment!);
        out = {
          text: composePrompt(message, sent),
          names: sent.map((a) => `${a.id}.${a.ext}`),
          lines: attachmentLines(sent),
        };
      }
      if (out.text.length > PROMPT_MAX_CHARS) {
        setError(
          `too long: ${out.text.length.toLocaleString()} chars${out.lines.length ? " with the picture lines" : ""}, the limit is ${PROMPT_MAX_CHARS.toLocaleString()}`,
        );
        return null;
      }
      if (!out.text) return null;
      setError(null);
      return out;
    },
    [mode, takes],
  );

  /** A drop of files, wherever it lands: pictures go to the tray (or are answered where none
   *  can go); anything else is said to be no picture. Never left to the browser, which
   *  would open the file in the page's place. */
  const dropped = useCallback(
    (dt: DataTransfer | null) => {
      if (!active) return;
      const files = imageFiles(dt);
      const others = (dt?.files?.length ?? 0) > files.length;
      if (files.length > 0) {
        if (mode === "off") onRefused.current?.();
        else add(files);
      }
      if (others && (files.length === 0 || mode !== "off")) setError(ONLY_PICTURES_WORDS);
    },
    [active, add, mode],
  );

  const handlers = useMemo<AttachmentsHandle["handlers"]>(
    () => ({
      onPaste(e) {
        const files = imageFiles(e.clipboardData);
        // A paste of text is the field's own, untouched.
        if (files.length === 0 || !active) return;
        if (mode === "off") {
          // Nothing is taken, so nothing is prevented (words copied beside a picture still
          // land in the field), and the composer says why the picture did not.
          onRefused.current?.();
          return;
        }
        if (!takes) return;
        e.preventDefault();
        add(files);
      },
      onDragOver(e) {
        if (!carriesFiles(e.dataTransfer)) return;
        // Always: a file the page lets fall is opened by the browser in the page's place.
        e.preventDefault();
        // Where no picture can go the drop is still taken, to say why; a composer that is
        // off takes none.
        e.dataTransfer.dropEffect = active && (takes || mode === "off") ? "copy" : "none";
        if (enabled) setDragging(true);
      },
      onDragLeave(e) {
        // Leaving for a child element still counts as inside.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      },
      onDrop(e) {
        setDragging(false);
        if (!carriesFiles(e.dataTransfer)) return;
        e.preventDefault();
        dropped(e.dataTransfer);
      },
    }),
    [add, dropped, enabled, active, mode, takes],
  );

  const page = useMemo<AttachmentsHandle["page"]>(
    () => ({
      over(e) {
        if (!carriesFiles(e.dataTransfer)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = active && (takes || mode === "off") ? "copy" : "none";
        if (enabled) setDragging(true);
      },
      drop(e) {
        setDragging(false);
        if (!carriesFiles(e.dataTransfer)) return;
        e.preventDefault();
        dropped(e.dataTransfer);
      },
      leave() {
        setDragging(false);
      },
    }),
    [dropped, enabled, active, mode, takes],
  );

  // The tray's one line: what is wrong first, then what the uploads are doing.
  // One still being made smaller is waited for too, and counted in the uploads' size once it is.
  const busyOnes = items.filter((it) => itemState(it) === "waiting" || itemState(it) === "uploading");
  const wrong = error ?? failedOne?.error ?? (misfit ? ELSEWHERE_WORDS : over ? TOGETHER_WORDS : null);
  const doing = !uploading
    ? null
    : held
      ? waitingWords(busyOnes.length + items.filter((it) => itemState(it) === "shrinking").length)
      : slow && busyOnes.length > 0
        ? progressWords(
            busyOnes.reduce((n, it) => n + it.bytes, 0),
            uploadProgress() ? busyOnes.reduce((n, it) => n + (it.sent ?? 0), 0) : undefined,
          )
        : null;
  const note = wrong ? { text: wrong, tone: "err" as const } : doing ? { text: doing, tone: "info" as const } : null;

  return {
    items,
    uploading,
    failed: failedOne
      ? items.some((it) => it.error && it.retry)
        ? FAILED_WORDS
        : REMOVE_WORDS
      : misfit
        ? ELSEWHERE_WORDS
        : null,
    error: over ? TOGETHER_WORDS : error,
    note,
    dragging,
    mode,
    offered: mode !== "off",
    add,
    remove,
    retry,
    clear,
    restore,
    adopt,
    compose,
    handlers,
    page,
  };
}

/** The session page takes a file dragged or dropped anywhere on it, as its composer
 *  would (`att.page`), with the composer's drop highlight: no file dropped there is ever
 *  opened by the browser in the page's place. `form`: the composer. Where two sessions
 *  are side by side each takes what lands on its own view; what lands outside every
 *  session's view (the sidebar, the title bar) is the first composer's. A drop already
 *  taken (the composer's own field, a sheet open over the page) is left alone. */
export function usePageDrop(att: AttachmentsHandle, form: RefObject<HTMLElement | null>): void {
  const page = att.page;
  useEffect(() => {
    if (typeof document === "undefined") return;
    const mine = (e: globalThis.DragEvent): boolean => {
      const el = form.current;
      if (!el || e.defaultPrevented) return false;
      const at = e.target instanceof Element ? e.target : null;
      // A sheet or a dialog over the page has its own way with a drop.
      if (at?.closest("[role=dialog]")) return false;
      const view = at?.closest(".page.session");
      if (view) return view.contains(el);
      return document.querySelector("form.ctl") === el;
    };
    let leave: number | undefined;
    const over = (e: globalThis.DragEvent) => {
      if (!mine(e)) return;
      page.over(e);
      // A drag that leaves the window says nothing on the way out: the highlight goes
      // once the drag stops passing over.
      window.clearTimeout(leave);
      leave = window.setTimeout(page.leave, 200);
    };
    const drop = (e: globalThis.DragEvent) => {
      window.clearTimeout(leave);
      if (mine(e)) page.drop(e);
    };
    document.addEventListener("dragover", over);
    document.addEventListener("drop", drop);
    return () => {
      window.clearTimeout(leave);
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", drop);
    };
  }, [page, form]);
}

// ---------- the pieces a composer places ----------

/** The paperclip: a file picker (several at once; on a phone the native sheet, which
 *  offers the camera). Hidden input, visible button. `why`: where it is greyed for a reason
 *  of its own, that sentence is its tooltip. */
export function AttachButton({
  att,
  disabled,
  title = "Attach pictures",
  why,
}: {
  att: AttachmentsHandle;
  disabled?: boolean;
  title?: string;
  why?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) att.add(Array.from(e.target.files));
    e.target.value = "";
  };
  const full = att.items.length >= ATTACHMENTS_PER_MESSAGE;
  // Under a finger the four an agent reads, so the iPhone's sheet hands over a HEIC as JPEG.
  const touch = useTouchKeys();
  // Until it is known how this machine takes pictures, none is picked.
  const off = disabled || full || (att.mode !== "files" && att.mode !== "path");
  return (
    <label
      className="att-btn"
      title={off && why ? why : title}
      data-tip={off && why ? why : title}
      aria-disabled={off ? "true" : undefined}
    >
      <input
        ref={input}
        type="file"
        accept={touch ? PICKER_TOUCH : PICKER_DESK}
        multiple
        disabled={off}
        onChange={onChange}
        aria-label={title}
        data-attach-input
      />
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
    </label>
  );
}

/** The thumbnails at the top of the field: each with a spinner while uploading (two at a
 *  time; the rest wait, dimmed), ↻ beside × on one whose upload failed in a way trying
 *  again can mend, and × to take it back. Under them one line: what is wrong (a refusal, a
 *  failed upload's words), else how far the uploads are or that a send waits for them.
 *  Nothing when there is none. */
export function AttachmentTray({ att }: { att: AttachmentsHandle }) {
  if (att.items.length === 0 && !att.note) return null;
  return (
    <div className="att" data-attachments={att.items.length}>
      {att.items.length > 0 && (
        <ul className="att-tray" aria-label="Pictures to send">
          {att.items.map((it) => (
            <TrayItem key={it.key} it={it} onRemove={() => att.remove(it.key)} onRetry={() => att.retry(it.key)} />
          ))}
        </ul>
      )}
      {att.note &&
        (att.note.tone === "err" ? (
          <p className="att-note" role="alert">
            {att.note.text}
          </p>
        ) : (
          <p className="att-note att-note--info" role="status" data-upload-line>
            {att.note.text}
          </p>
        ))}
    </div>
  );
}

/** One picture waiting to go: the thumbnail, its name and size the tooltip (its refusal's
 *  words where it was refused, said once under the tray); its menu copies its name, tries
 *  it again or takes it back. Dimmed until it is uploaded, with the spinner while its own
 *  upload runs. */
function TrayItem({ it, onRemove, onRetry }: { it: PendingItem; onRemove: () => void; onRetry: () => void }) {
  const state = itemState(it);
  const name = it.name || (it.attachment ? `${it.attachment.id}.${it.attachment.ext}` : "");
  const px = it.attachment ?? it.entry;
  const size = state !== "ready" ? state : px?.width && px.height ? `${px.width}×${px.height}` : "";
  const bytes = it.was ? `${mb(it.bytes)} (was ${mb(it.was)})` : mb(it.bytes);
  const tip = state === "shrinking" ? "Making it smaller…" : [name, size, bytes].filter(Boolean).join(" · ");
  const again = state === "error" && !!it.retry;
  const menu = useContextMenu(() => [
    copyItem("Copy name", name),
    ...(again ? [{ label: "Try again", run: onRetry }] : []),
    { sep: true },
    { label: "Remove", danger: true, run: onRemove },
  ]);
  const busy = state === "shrinking" || state === "waiting" || state === "uploading";
  // One that can't be drawn (no picture, or a held copy this page can't load) keeps its
  // frame; a picture made smaller is drawn again from its new preview.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const broken = !it.preview || brokenSrc === it.preview;
  return (
    <li
      className={`att-item ${state === "error" ? "att-item--err" : ""} ${busy ? "att-item--busy" : ""}`}
      data-attachment={it.attachment?.id ?? it.entry?.sha256 ?? ""}
      data-state={state}
      data-name={name}
      data-restored={it.restored ? "" : undefined}
      title={it.error ? [name, it.error].filter(Boolean).join(" · ") : tip}
      {...menu}
    >
      <span className="att-frame">
        {it.preview && (
          <img
            className="att-thumb"
            src={it.preview}
            alt=""
            data-broken={broken ? "" : undefined}
            onError={() => setBrokenSrc(it.preview)}
          />
        )}
        {broken && (
          <span className="att-thumb att-thumb--none" aria-hidden="true">
            <PictureGlyph />
          </span>
        )}
        {(state === "shrinking" || state === "uploading") && <span className="spinner att-busy" aria-hidden="true" />}
      </span>
      {again && (
        <button type="button" className="icon-btn att-x att-retry" onClick={onRetry} aria-label="Try again">
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" fill="none">
            <path
              d="M9.6 6.6A3.7 3.7 0 1 1 8.4 3.2M9.4 1.6v2.3H7.1"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      <button type="button" className="icon-btn att-x" onClick={onRemove} aria-label="Remove picture">
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </li>
  );
}

/** A picture's outline: what the tray draws where the picture itself can't be. */
function PictureGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="6" cy="6.5" r="1.2" />
      <path d="m2.5 12 3.8-3.8 2.7 2.7 1.8-1.8 2.7 2.7" strokeLinejoin="round" />
    </svg>
  );
}

// ---------- a sent prompt's thumbnails ----------

/** A file a sent message carried, as it is drawn: `sha256` when the page knows its bytes
 *  (a picture with one is a thumbnail), `size` in the machine's words ("32 KB"). */
export interface ShownFile {
  name: string;
  type: string;
  size: string;
  sha256?: string;
}

/** The sent rows that carried files (ControlActivity `files`, `nonce`), where the machine's
 *  list in a turn's words is found again. A page that provides none draws chips. */
export const SentFilesRows = createContext<readonly ControlActivity[]>([]);

/** The hash of a file the machine's list names: a prompt's by its nonce and name, a
 *  start's (no nonce) by the start of that session and the name. */
export function savedFileSha(f: SavedFileRef, rows: readonly ControlActivity[]): string | undefined {
  for (const a of rows) {
    if (!a.files) continue;
    const mine = f.nonce
      ? a.nonce === f.nonce
      : a.kind === "start" && !!a.session && splitKey(a.session).id === f.session;
    const hit = mine ? a.files.find((x) => x.name === f.name && x.type === f.type) : undefined;
    if (hit) return hit.sha256;
  }
  return undefined;
}

/** What a sent message shows it carried: the files the machine's list in its words names,
 *  else the files the row signed (`signed`, before the session's record has the list). */
export function shownFiles(
  items: readonly PromptItem[],
  signed: readonly StartFile[] | undefined,
  rows: readonly ControlActivity[],
): ShownFile[] {
  const saved = items.filter((it): it is SavedFileRef => it.kind === "file");
  if (saved.length)
    return saved.map((f) => {
      const sha256 = savedFileSha(f, rows);
      return { name: f.name, type: f.type, size: f.size, ...(sha256 ? { sha256 } : {}) };
    });
  return (signed ?? []).map((f) => ({ name: f.name, type: f.type, size: humanSize(f.size), sha256: f.sha256 }));
}

const TYPE_WORD: Record<AttachmentType, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WebP",
};

/** What a chip says after the name: "PNG · 32 KB" for a picture, "1.2 MB" for any other file. */
const fileFacts = (f: Pick<ShownFile, "type" | "size">): string =>
  [TYPE_WORD[f.type as AttachmentType], f.size].filter(Boolean).join(" · ");

/** A chip's words: "kiwi.png · PNG · 32 KB" for a picture, "notes.pdf · 1.2 MB" for any other file. */
export const fileWords = (f: Pick<ShownFile, "name" | "type" | "size">): string => `${f.name} · ${fileFacts(f)}`;

/** One thing a sent message shows it carried: a picture this page can draw (`src`), else a
 *  chip of `file`'s words. `name`: what it is known by; `caption`: what the lightbox says. */
interface SentThing {
  key: string;
  name: string;
  caption: string;
  file: ShownFile;
  src?: string;
  /** A picture this page kept, being read: its frame holds the place. */
  wait?: boolean;
}

/** Where the receiver shows a file it holds, by its hash. */
const receiverCopy = (sha: string): string => apiUrl(`${ROUTES.ui.control}/files/${sha}`);

/** What a picture the prompt's text names (the composer's older block) says of itself, as
 *  a chip says a file: "Picture · PNG · 4032×3024". */
const legacyFile = (it: AttachmentRef): ShownFile => ({
  name: "Picture",
  type: it.ext === "jpg" ? "image/jpeg" : `image/${it.ext}`,
  size: it.width && it.height ? `${it.width}×${it.height}` : "",
});

/** The files a sent message carried, under its words: a thumbnail for each picture this
 *  receiver keeps, whole in a frame of its own shape, which opens it in the lightbox
 *  (every shell; a click with a modifier still opens a new tab in a browser), the arrows
 *  moving through this message's pictures; else one this page kept of what it sent
 *  (sentPictures.ts: on a spacesheep account, where the receiver holds none, and for a
 *  computer reached through spacesheep); a chip for the rest, and for one that does not
 *  load (kept no more). `legacy`: the pictures the prompt's text names in the composer's
 *  older block, drawn first. On a spacesheep account the older block's pictures are a chip
 *  each that says where they are kept. Nothing when there is none. */
export function SentPictures({
  files,
  legacy = [],
  small,
}: {
  files: readonly ShownFile[];
  legacy?: readonly AttachmentRef[];
  small?: boolean;
}) {
  const draw = !accountMode();
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState<number | null>(null);
  // The copies this page kept that are read: every picture on an account, where no receiver
  // holds one; on a board, one whose receiver's copy does not load.
  const ask = useMemo(
    () =>
      files.flatMap((f) =>
        f.type in ATTACHMENT_TYPES && f.sha256 && (!draw || broken.has(receiverCopy(f.sha256))) ? [f.sha256] : [],
      ),
    [files, draw, broken],
  );
  const kept = useSentPictureUrls(ask);
  const things = useMemo((): SentThing[] => {
    const out: SentThing[] = [];
    if (draw)
      for (const it of legacy) {
        const file = legacyFile(it);
        out.push({
          key: `a:${it.id}`,
          name: `${it.id}.${it.ext}`,
          caption: fileWords(file),
          file,
          src: apiUrl(it.src),
        });
      }
    files.forEach((f, i) => {
      const thing: SentThing = { key: `f:${i}:${f.name}`, name: f.name, caption: f.name, file: f };
      out.push(thing);
      if (!(f.type in ATTACHMENT_TYPES) || !f.sha256) return;
      // One this page sent to a computer reached through spacesheep: drawn from here, as no
      // receiver holds it; else the receiver's; else (and on an account) the copy kept here.
      const held = draw ? heldSentPicture(f.sha256) : undefined;
      const theirs = draw ? receiverCopy(f.sha256) : undefined;
      const own = kept.get(f.sha256);
      if (held && !broken.has(held)) thing.src = held;
      else if (theirs && !broken.has(theirs)) thing.src = theirs;
      else if (own) thing.src = own;
      else if (own === undefined) thing.wait = true;
    });
    return out;
  }, [files, legacy, draw, broken, kept]);
  const pictures = useMemo(() => things.filter((t) => t.src && !broken.has(t.src)), [things, broken]);
  // On a spacesheep account, whose relay holds none of a receiver's pictures, nothing is
  // asked for that would come back broken.
  const elsewhere = draw ? [] : legacy;
  if (things.length === 0 && elsewhere.length === 0) return null;
  return (
    <span
      className={`att-thumbs ${small ? "att-thumbs--sm" : ""}`}
      data-sent-files={files.length}
      data-attachment-thumbs={draw && legacy.length ? legacy.length : undefined}
    >
      {elsewhere.map((it) => (
        <ElsewhereChip
          key={`a:${it.id}`}
          name="picture"
          facts={[it.width && it.height ? `${it.width}×${it.height}` : "", KEPT_ON_BOARD].filter(Boolean).join(" · ")}
        />
      ))}
      {things.map((t) => {
        const at = pictures.indexOf(t);
        if (t.wait) return <span key={t.key} className="att-thumb-wait" title={fileWords(t.file)} aria-hidden="true" />;
        if (at < 0) return <FileChip key={t.key} f={t.file} />;
        const words = fileWords(t.file);
        return (
          <a
            key={t.key}
            href={t.src}
            target="_blank"
            rel="noreferrer noopener"
            title={words}
            aria-label={words}
            data-sent-picture={t.name}
            onClick={(e) => {
              // A new tab where the person asked for one; the lightbox everywhere else.
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              setOpen(at);
            }}
          >
            <img src={t.src} alt="" loading="lazy" onError={() => setBroken((b) => new Set(b).add(t.src!))} />
          </a>
        );
      })}
      {open !== null && pictures[open] && (
        <Lightbox
          pictures={pictures.map((p) => ({ src: p.src!, name: p.caption }))}
          at={open}
          onMove={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </span>
  );
}

/** A file drawn as words: a file's glyph when it is no picture, its name (cut to fit), then
 *  its type and size in the meta tier. */
function FileChip({ f }: { f: ShownFile }) {
  const picture = f.type in ATTACHMENT_TYPES;
  return (
    <span className="att-chip" title={fileWords(f)} data-sent-file={f.name}>
      {!picture && (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor">
          <path d="M4 1.5h5.5L12.5 4.5v10h-8.5zM9.5 1.5v3h3" strokeWidth="1.25" strokeLinejoin="round" />
        </svg>
      )}
      <span className="att-chip-name">{f.name}</span>
      <span className="att-chip-meta num">{fileFacts(f)}</span>
    </span>
  );
}

/** Where a picture this page can't show is kept, as its chip says it. */
export const KEPT_ON_BOARD = "kept on the board it was sent from";
export const KEPT_ON_SPACESHEEP = "kept on spacesheep";

/** A picture as words, where this page has no way to show it: its name, then what it is and
 *  where it is kept ("picture · 1200×900 · kept on the board it was sent from"). */
function ElsewhereChip({ name, facts }: { name: string; facts: string }) {
  return (
    <span className="att-chip att-chip--elsewhere" title={`${name} · ${facts}`} data-picture-elsewhere={name}>
      <span className="att-chip-name">{name}</span>
      <span className="att-chip-meta num">{facts}</span>
    </span>
  );
}

/** The pictures a spacesheep Talk message linked to, a chip each with its name. */
export function LinkPictures({ items, small }: { items: readonly LinkPictureRef[]; small?: boolean }) {
  if (items.length === 0) return null;
  return (
    <span className={`att-thumbs ${small ? "att-thumbs--sm" : ""}`}>
      {items.map((it, i) => (
        <ElsewhereChip key={`${i}:${it.name}`} name={it.name || "picture"} facts={`picture · ${KEPT_ON_SPACESHEEP}`} />
      ))}
    </span>
  );
}

/** A prompt's text with its block of pictures (this page's, an older one's or spacesheep's
 *  Talk pane's), or the machine's list of saved files, turned into thumbnails and chips;
 *  `files`: what the message signed, drawn when its words have no list (they are the
 *  message as sent). `render` draws the remaining text (Redacted by default), so a composer
 *  with markdown can pass its own. A message of pictures alone is its pictures. */
export function PromptBody({
  text,
  small,
  files,
  render = (body) => <Redacted text={body} />,
}: {
  text: string;
  small?: boolean;
  files?: readonly StartFile[];
  render?: (body: string) => ReactNode;
}) {
  const rows = useContext(SentFilesRows);
  const { body, items } = useMemo(() => splitAttachments(text), [text]);
  const shown = useMemo(() => shownFiles(items, files, rows), [items, files, rows]);
  const legacy = attachmentRefs(items);
  const links = linkPictures(items);
  if (legacy.length === 0 && links.length === 0 && shown.length === 0) return <>{render(text)}</>;
  return (
    <>
      {body ? render(body) : null}
      <LinkPictures items={links} small={small} />
      <SentPictures legacy={legacy} files={shown} small={small} />
    </>
  );
}

/** The pictures a prompt's text names in the composer's own block (shared/attachments.ts). */
export const attachmentRefs = (items: readonly PromptItem[]): AttachmentRef[] =>
  items.filter((it): it is AttachmentRef => it.kind === undefined);

/** The pictures a prompt's text links to in spacesheep's Talk block. */
export const linkPictures = (items: readonly PromptItem[]): LinkPictureRef[] =>
  items.filter((it): it is LinkPictureRef => it.kind === "link-picture");

/** For list rows: the prompt's first line without the block, and what it carried. */
export function promptParts(text: string): { body: string; items: PromptItem[] } {
  return splitAttachments(text);
}
