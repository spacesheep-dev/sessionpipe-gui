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
//  - "off": no way to send one (an older daemon on another machine, a computer reached
//    through spacesheep): no paperclip, and a picture pasted or dropped is answered in words.
// No address of this board and no key to it is ever in what is signed.
// A sent message shows what it carried under its words: a thumbnail of each picture the
// receiver still keeps (GET …/control/files/:sha), else a chip with its name, type and size.
// Before the session's record of the turn arrives that is the sent row's `files`; after, the
// list of saved files the machine added to the message, each found again by its nonce.
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
  PROMPT_MAX_CHARS,
  type PromptItem,
  type SavedFileRef,
  splitAttachments,
} from "@shared/attachments";
import {
  type ChangeEvent,
  type ClipboardEvent,
  createContext,
  type DragEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Redacted } from "../components/bits";
import { useContextMenu } from "../components/ContextMenu";
import { useTouchKeys } from "../lib/device";
import { copyItem } from "../lib/menus";
import { accountMode, apiFetch, apiUrl } from "../lib/net";
import { ControlError, controlApi } from "./api";
import { b64url, sha256 } from "./bytes";
import { PICKER_DESK, PICKER_TOUCH, pictureType, refuseInput, shrinkImage, stillOverWords } from "./shrink";
import "./attachments.css";
import { KEY_LOST } from "../lib/keyWords";

// ---------- how a picture goes ----------

export type PictureMode = "files" | "path" | "off";

/** How the composer sends a picture to a session on this machine's control row, or
 *  undefined while that is not known (no row yet, or `thisMachine` not read yet where it
 *  decides). `thisMachine`: the session runs on the machine the GUI runs on. */
export function pictureMode(
  control: Pick<MachineControl, "promptFiles" | "remote"> | undefined,
  thisMachine: boolean | null,
): PictureMode | undefined {
  if (!control) return undefined;
  // A file a send names would have to be held by spacesheep: there is no way to carry one yet.
  if (control.remote) return "off";
  if (control.promptFiles) return "files";
  if (thisMachine === null) return undefined;
  return thisMachine ? "path" : "off";
}

/** Why no picture can go to `machine`, as the line under the field says it when one is
 *  pasted or dropped. What is between backticks is a command to type. */
export function picturesOffWords(machine: string, relayed: boolean): string {
  return relayed
    ? `Pictures can't be sent to ${machine} through spacesheep from here yet.`
    : `Pictures can't be sent to ${machine}: its sessionpipe is older than 0.10. Run \`sessionpipe update\` there.`;
}

/** The pictures of one message are over the protocol's total (CONTROL.md §3.1). */
export const TOGETHER_WORDS = "These pictures are over 50 MB together. Remove one.";
/** The receiver's hash or size of an upload is not the page's own. */
export const NOT_WHOLE_WORDS = "The picture didn't arrive whole. Try again.";
/** This many upload at once; the rest wait their turn in the tray. */
const UPLOADS_AT_ONCE = 2;
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

/** Why a file cannot be attached, in words; null when it can. Checked before any upload.
 *  One picture is at most what a command's file may be (25 MiB) where it goes as one, and
 *  ATTACHMENT_MAX_BYTES where the prompt names it by path. */
export function refuseFile(file: Blob, mode: "files" | "path" = "path"): string | null {
  if (!ACCEPT.includes(file.type))
    return `not an image we can send (${file.type || "unknown type"}); PNG, JPEG, GIF or WebP`;
  const limit = mode === "files" ? START_FILE_MAX_BYTES : ATTACHMENT_MAX_BYTES;
  if (file.size > limit) return `too large: ${mb(file.size)}, limit ${mb(limit)}`;
  return null;
}

/** A picture as a signed command's file names it, with its pixels where the receiver read them. */
export type PictureEntry = UploadedFile;

/** Upload one picture as a file a prompt will carry, under `name`, and check it arrived
 *  whole: the page hashes the very bytes it sent, and an answer with another hash or size
 *  is refused, so what is signed is the page's own word on the bytes. Throws the words. */
export async function uploadPicture(file: Blob, name: string, machineId?: string): Promise<PictureEntry> {
  const why = refuseFile(file, "files");
  if (why) throw new Error(why);
  const buf = await file.arrayBuffer();
  let held: UploadedFile;
  let hash: string;
  try {
    [hash, held] = await Promise.all([
      sha256(new Uint8Array(buf)).then(b64url),
      controlApi.uploadFile(new File([buf], name, { type: file.type }), machineId),
    ]);
  } catch (e) {
    if (!(e instanceof ControlError)) throw new Error("upload failed");
    if (e.status === 413) throw new Error(`too large: ${mb(file.size)}, limit ${mb(START_FILE_MAX_BYTES)}`);
    if (e.status === 401) throw new Error(KEY_LOST);
    // The receiver's own sentence where it has one ("This file isn't the picture its type says.").
    throw new Error(e.detail ?? `upload failed (${e.reason})`);
  }
  if (held.sha256 !== hash || held.size !== buf.byteLength) throw new Error(NOT_WHOLE_WORDS);
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
export async function uploadAttachment(file: Blob): Promise<Attachment> {
  const why = refuseFile(file);
  if (why) throw new Error(why);
  const res = await apiFetch(ROUTES.ui.attachments, {
    method: "POST",
    headers: { "content-type": file.type, accept: "application/json" },
    body: file,
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // no body
  }
  if (!res.ok) {
    const reason = typeof json.reason === "string" ? json.reason : `http_${res.status}`;
    if (reason === "too_large") throw new Error(`too large: ${mb(file.size)}, limit ${mb(ATTACHMENT_MAX_BYTES)}`);
    if (reason === "not_an_image" || reason === "unsupported_type") throw new Error("not an image we can send");
    if (res.status === 401) throw new Error(KEY_LOST);
    throw new Error(`upload failed (${reason})`);
  }
  return json as unknown as Attachment;
}

/** Take back an upload that was not sent. Best effort: the daily prune catches strays. */
export function deleteAttachment(a: Pick<Attachment, "id" | "ext">): Promise<void> {
  return apiFetch(`${ROUTES.attachments}/${a.id}.${a.ext}`, { method: "DELETE" })
    .then(() => undefined)
    .catch(() => undefined);
}

let infoPromise: Promise<Info> | null = null;
/** Info, read once per page: `hostname` says which machine the paths mean something on. */
function hostInfo(): Promise<Info> {
  if (!infoPromise)
    infoPromise = apiFetch(ROUTES.ui.info, { headers: { accept: "application/json" } })
      .then((r) => r.json() as Promise<Info>)
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
  /** What goes: the shrunk picture once it is made (shrink.ts), else the original. */
  file: Blob;
  /** For the thumbnail (an object URL, revoked on remove). */
  preview: string;
  bytes: number;
  /** The original's size, where what goes is a smaller redraw of it. */
  was?: number;
  /** It is being made smaller (one at a time on the page); its upload waits for that. */
  shrinking?: boolean;
  /** The way it goes, as the session's machine took pictures when it was added. */
  via: "files" | "path";
  /** The name it goes under: a file's signed name (`pictureName`), else the file's own. */
  name: string;
  /** Its upload has not begun: two run at a time. */
  waiting?: boolean;
  /** Uploaded, where the prompt names it by path. */
  attachment?: Attachment;
  /** Uploaded and checked, where it goes as a file: what the command signs of it. */
  entry?: PictureEntry;
  error?: string;
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
  /** A file was refused or an upload failed, the pictures are too much together, or the
   *  text would be over the cap. */
  error: string | null;
  /** A file is being dragged over the drop zone, and would be taken. */
  dragging: boolean;
  /** How pictures go to this session's machine; undefined while not known. */
  mode: PictureMode | undefined;
  /** The paperclip has a place here: every mode but "off". */
  offered: boolean;
  add(files: Iterable<Blob>): void;
  remove(key: string): void;
  clear(): void;
  /** What to sign: `message` and the pictures, the way this machine takes them. Null (and
   *  `error` set) when nothing can go: an upload is still running or failed, the pictures
   *  are too much together, or the text is over the cap. */
  compose(message: string): ComposeResult | null;
  /** Spread onto the drop zone element (the form) and the textarea. */
  handlers: {
    onPaste(e: ClipboardEvent): void;
    onDragOver(e: DragEvent): void;
    onDragLeave(e: DragEvent): void;
    onDrop(e: DragEvent): void;
  };
}

/** `mode`: how this session's machine takes pictures (`pictureMode`); `machineId`: the
 *  machine an upload is for. `onRefused`: a picture was pasted or dropped where none can be
 *  sent ("off"), so the composer says why (`picturesOffWords`); nothing is swallowed. */
export function useAttachments(o: {
  machineId?: string;
  enabled?: boolean;
  mode?: PictureMode;
  onRefused?: () => void;
}): AttachmentsHandle {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const seq = useRef(0);
  /** The items whose upload began (its key), so none begins twice. */
  const started = useRef(new Set<string>());
  const { mode, machineId } = o;
  const takes = mode === "files" || mode === "path" ? mode : null;
  /** The composer is on; `enabled`: and its machine takes pictures. */
  const active = o.enabled !== false;
  const enabled = active && !!takes;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onRefused = useRef(o.onRefused);
  onRefused.current = o.onRefused;

  // Object URLs of what was never sent are let go with the composer.
  useEffect(
    () => () => {
      for (const it of itemsRef.current) URL.revokeObjectURL(it.preview);
    },
    [],
  );

  const set = useCallback((key: string, patch: Partial<PendingItem>) => {
    setItems((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }, []);

  // Two uploads at a time, in the tray's order; the rest wait.
  useEffect(() => {
    let busy = items.filter((it) => started.current.has(it.key) && itemState(it) !== "ready" && !it.error).length;
    for (const it of items) {
      if (busy >= UPLOADS_AT_ONCE) break;
      if (!it.waiting || it.error || started.current.has(it.key)) continue;
      started.current.add(it.key);
      busy++;
      set(it.key, { waiting: false });
      const going: Promise<Partial<PendingItem>> =
        it.via === "files"
          ? uploadPicture(it.file, it.name, machineId).then((entry) => ({ entry }))
          : uploadAttachment(it.file).then((attachment) => ({ attachment }));
      going.then(
        (done) => set(it.key, done),
        (e: Error) => set(it.key, { error: e.message }),
      );
    }
  }, [items, machineId, set]);

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
      const it = itemsRef.current.find((p) => p.key === key);
      // Taken back while it was being made smaller.
      if (!it) return;
      const file = small?.blob ?? it.file;
      const limit = it.via === "files" ? START_FILE_MAX_BYTES : ATTACHMENT_MAX_BYTES;
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
    [patchNow],
  );

  const add = useCallback(
    (files: Iterable<Blob>) => {
      if (!enabled || !takes) return;
      setError(null);
      const list = Array.from(files);
      const room = ATTACHMENTS_PER_MESSAGE - itemsRef.current.length;
      if (list.length > room) {
        setError(`${ATTACHMENTS_PER_MESSAGE} images per message at most`);
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
          (e: Error) => patchNow(it.key, { shrinking: false, error: e.message }),
        );
      }
    },
    [enabled, takes, shrunk, patchNow],
  );

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const it = prev.find((p) => p.key === key);
      if (it) {
        URL.revokeObjectURL(it.preview);
        if (it.attachment) void deleteAttachment(it.attachment);
      }
      return prev.filter((p) => p.key !== key);
    });
    setError(null);
  }, []);

  const clear = useCallback(() => {
    setItems((prev) => {
      for (const it of prev) URL.revokeObjectURL(it.preview);
      return [];
    });
    setError(null);
  }, []);

  const uploading = items.some((it) => {
    const s = itemState(it);
    return s === "shrinking" || s === "waiting" || s === "uploading";
  });
  // Too much together: said as soon as it is so, and until one is removed.
  const over = takes === "files" && overTogether(items);

  const compose = useCallback(
    (message: string): ComposeResult | null => {
      const cur = itemsRef.current;
      // One that failed, or one uploaded the way this machine no longer takes pictures.
      if (cur.some((it) => it.error || it.via !== takes)) {
        setError("remove the image that could not be attached, or try it again");
        return null;
      }
      if (cur.some((it) => itemState(it) !== "ready")) {
        setError("still uploading…");
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
          `too long: ${out.text.length.toLocaleString()} chars${out.lines.length ? " with the image lines" : ""}, the limit is ${PROMPT_MAX_CHARS.toLocaleString()}`,
        );
        return null;
      }
      if (!out.text) return null;
      setError(null);
      return out;
    },
    [takes],
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
        if (!active) return;
        const files = imageFiles(e.dataTransfer);
        if (files.length === 0) return;
        if (mode === "off") onRefused.current?.();
        else add(files);
      },
    }),
    [add, enabled, active, mode, takes],
  );

  return {
    items,
    uploading,
    error: over ? TOGETHER_WORDS : error,
    dragging,
    mode,
    offered: mode !== "off",
    add,
    remove,
    clear,
    compose,
    handlers,
  };
}

// ---------- the pieces a composer places ----------

/** The paperclip: a file picker (several at once; on a phone the native sheet, which
 *  offers the camera). Hidden input, visible button. */
export function AttachButton({
  att,
  disabled,
  title = "Attach images",
}: {
  att: AttachmentsHandle;
  disabled?: boolean;
  title?: string;
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
    <label className="att-btn" title={title} data-tip={title} aria-disabled={off ? "true" : undefined}>
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
 *  time; the rest wait, dimmed), the error under it when refused, and × to take it back.
 *  Nothing when there is none. */
export function AttachmentTray({ att }: { att: AttachmentsHandle }) {
  if (att.items.length === 0 && !att.error) return null;
  return (
    <div className="att" data-attachments={att.items.length}>
      {att.items.length > 0 && (
        <ul className="att-tray" aria-label="Images to send">
          {att.items.map((it) => (
            <TrayItem key={it.key} it={it} onRemove={() => att.remove(it.key)} />
          ))}
        </ul>
      )}
      {att.error && (
        <p className="att-note" role="alert">
          {att.error}
        </p>
      )}
    </div>
  );
}

/** One image waiting to go: the thumbnail, its name and size the tooltip (a refusal is
 *  written under it); its menu copies its name or takes it back. Dimmed until it is
 *  uploaded, with the spinner while its own upload runs. */
function TrayItem({ it, onRemove }: { it: PendingItem; onRemove: () => void }) {
  const state = itemState(it);
  const name = it.name || (it.attachment ? `${it.attachment.id}.${it.attachment.ext}` : "");
  const px = it.attachment ?? it.entry;
  const size = state !== "ready" ? state : px?.width && px.height ? `${px.width}×${px.height}` : "";
  const bytes = it.was ? `${mb(it.bytes)} (was ${mb(it.was)})` : mb(it.bytes);
  const tip = state === "shrinking" ? "Making it smaller…" : [name, size, bytes].filter(Boolean).join(" · ");
  const menu = useContextMenu(() => [
    copyItem("Copy name", name),
    { sep: true },
    { label: "Remove", danger: true, run: onRemove },
  ]);
  const busy = state === "shrinking" || state === "waiting" || state === "uploading";
  return (
    <li
      className={`att-item ${state === "error" ? "att-item--err" : ""} ${busy ? "att-item--busy" : ""}`}
      data-attachment={it.attachment?.id ?? it.entry?.sha256 ?? ""}
      data-state={state}
      data-name={name}
      title={it.error ? undefined : tip}
      {...menu}
    >
      <span className="att-frame">
        <img className="att-thumb" src={it.preview} alt="" />
        {(state === "shrinking" || state === "uploading") && <span className="spinner att-busy" aria-hidden="true" />}
      </span>
      {it.error && (
        <span className="att-meta" title={it.error}>
          {it.error}
        </span>
      )}
      <button type="button" className="icon-btn att-x" onClick={onRemove} aria-label="Remove image">
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M3 3l6 6M9 3 3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </li>
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

/** The files a sent message carried, under its words: a thumbnail for each picture this
 *  receiver keeps, which opens it whole in a new tab; a chip for the rest, and for one
 *  that does not load (kept no more). On a spacesheep account the receiver holds none of
 *  them: chips only. Nothing when there is none. */
export function SentPictures({ files, small }: { files: readonly ShownFile[]; small?: boolean }) {
  if (files.length === 0) return null;
  const draw = !accountMode();
  return (
    <span className={`att-thumbs ${small ? "att-thumbs--sm" : ""}`} data-sent-files={files.length}>
      {files.map((f, i) => (
        <SentFile key={`${i}:${f.name}`} f={f} draw={draw} />
      ))}
    </span>
  );
}

function SentFile({ f, draw }: { f: ShownFile; draw: boolean }) {
  const [broken, setBroken] = useState(false);
  const words = fileWords(f);
  const picture = f.type in ATTACHMENT_TYPES;
  if (picture && f.sha256 && draw && !broken) {
    const src = apiUrl(`${ROUTES.ui.control}/files/${f.sha256}`);
    return (
      <a href={src} target="_blank" rel="noreferrer noopener" title={words} data-sent-picture={f.name}>
        <img src={src} alt={f.name} loading="lazy" onError={() => setBroken(true)} />
      </a>
    );
  }
  return (
    <span className="att-chip" title={words} data-sent-file={f.name}>
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

/** Thumbnails for the images a prompt text names; each opens the full image in a new tab. */
export function AttachmentThumbs({ items, small }: { items: readonly AttachmentRef[]; small?: boolean }) {
  // The images a receiver holds are not on a spacesheep account's relay: nothing to show,
  // and nothing to ask for that would come back broken.
  if (items.length === 0 || accountMode()) return null;
  return (
    <span className={`att-thumbs ${small ? "att-thumbs--sm" : ""}`} data-attachment-thumbs={items.length}>
      {items.map((it) => (
        <a
          key={it.id}
          href={apiUrl(it.src)}
          target="_blank"
          rel="noreferrer noopener"
          title={it.width && it.height ? `${it.width}×${it.height} · open` : "open"}
        >
          <img
            src={apiUrl(it.src)}
            alt={`attachment${it.width && it.height ? ` ${it.width}×${it.height}` : ""}`}
            loading="lazy"
          />
        </a>
      ))}
    </span>
  );
}

/** A prompt's text with the attachments block, or the machine's list of saved files,
 *  turned into thumbnails; `files`: what the message signed, drawn when its words have no
 *  list (they are the message as sent). `render` draws the remaining text (Redacted by
 *  default), so a composer with markdown can pass its own. A message of pictures alone is
 *  its pictures. */
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
  if (legacy.length === 0 && shown.length === 0) return <>{render(text)}</>;
  return (
    <>
      {body ? render(body) : null}
      <AttachmentThumbs items={legacy} small={small} />
      <SentPictures files={shown} small={small} />
    </>
  );
}

/** The pictures a prompt's text names in the composer's own block (shared/attachments.ts). */
export const attachmentRefs = (items: readonly PromptItem[]): AttachmentRef[] =>
  items.filter((it): it is AttachmentRef => it.kind !== "file");

/** For list rows: the prompt's first line without the block, and what it carried. */
export function promptParts(text: string): { body: string; items: PromptItem[] } {
  return splitAttachments(text);
}
