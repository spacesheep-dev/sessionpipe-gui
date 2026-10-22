// SPDX-License-Identifier: Apache-2.0
// Images beside a prompt, self-contained so any composer can place it: a hook that
// holds the uploads (paperclip, paste, drop, the phone's picker or camera), the tray
// of thumbnails above the input, the paperclip button, and the thumbnails a sent
// prompt shows wherever its text is drawn. The control protocol carries text only, so
// `compose()` appends the one block the agent can act on (shared/attachments.ts):
// absolute paths when the session runs on the machine the GUI runs on, URLs with the
// UI key otherwise.
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  ATTACHMENTS_PER_MESSAGE,
  type Attachment,
  type Info,
  ROUTES,
} from "@shared/api";
import { type AttachmentRef, composePrompt, PROMPT_MAX_CHARS, splitAttachments } from "@shared/attachments";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Redacted } from "../components/bits";
import { useContextMenu } from "../components/ContextMenu";
import { copyItem } from "../lib/menus";
import "./attachments.css";

// ---------- the upload itself (also the theme api's control.attach) ----------

const ACCEPT = Object.keys(ATTACHMENT_TYPES);

/** "640 KB", "1.2 MB", "12 MB". */
const mb = (n: number): string => {
  const m = n / (1024 * 1024);
  if (m < 1) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10} MB`;
};

/** Why a file cannot be attached, in words; null when it can. Checked before any upload. */
export function refuseFile(file: Blob): string | null {
  if (!ACCEPT.includes(file.type))
    return `not an image we can send (${file.type || "unknown type"}); PNG, JPEG, GIF or WebP`;
  if (file.size > ATTACHMENT_MAX_BYTES) return `too large: ${mb(file.size)}, limit ${mb(ATTACHMENT_MAX_BYTES)}`;
  return null;
}

/** POST the image as the raw body; the server validates the bytes and reads the size. */
export async function uploadAttachment(file: Blob): Promise<Attachment> {
  const why = refuseFile(file);
  if (why) throw new Error(why);
  const res = await fetch(ROUTES.ui.attachments, {
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
    if (res.status === 401) throw new Error("this board needs its key before it takes uploads");
    throw new Error(`upload failed (${reason})`);
  }
  return json as unknown as Attachment;
}

/** Take back an upload that was not sent. Best effort: the daily prune catches strays. */
export function deleteAttachment(a: Pick<Attachment, "id" | "ext">): Promise<void> {
  return fetch(`${ROUTES.attachments}/${a.id}.${a.ext}`, { method: "DELETE" })
    .then(() => undefined)
    .catch(() => undefined);
}

let infoPromise: Promise<Info> | null = null;
/** Info, read once per page: `hostname` says which machine the paths mean something on. */
function hostInfo(): Promise<Info> {
  if (!infoPromise)
    infoPromise = fetch(ROUTES.ui.info, { headers: { accept: "application/json" } })
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

/** Image files out of a paste or a drop (a pasted screenshot comes as one file item). */
export function imageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items?.length) {
    for (const it of Array.from(dt.items)) {
      if (it.kind !== "file") continue;
      const f = it.getAsFile();
      if (f?.type.startsWith("image/")) out.push(f);
    }
  }
  if (out.length === 0 && dt.files?.length) {
    for (const f of Array.from(dt.files)) if (f.type.startsWith("image/")) out.push(f);
  }
  return out;
}

// ---------- the composer's state ----------

export interface PendingItem {
  /** Local key while uploading; the attachment id once uploaded. */
  key: string;
  file: Blob;
  /** For the thumbnail (an object URL, revoked on remove). */
  preview: string;
  bytes: number;
  attachment?: Attachment;
  error?: string;
}

export interface ComposeResult {
  text: string;
  /** Which form the block took, for a note. */
  local: boolean;
}

export interface AttachmentsHandle {
  items: readonly PendingItem[];
  /** An upload is in flight: the composer should hold Send. */
  uploading: boolean;
  /** A file was refused or an upload failed, or the text would be over the cap. */
  error: string | null;
  /** A file is being dragged over the drop zone. */
  dragging: boolean;
  /** The session runs on this machine (null until Info arrived). */
  local: boolean | null;
  add(files: Iterable<Blob>): void;
  remove(key: string): void;
  clear(): void;
  /** The text to sign: `message` plus the block. Null (and `error` set) when nothing
   *  can go: an upload is still running or failed, or the text is over the cap. */
  compose(message: string): ComposeResult | null;
  /** Spread onto the drop zone element (the form) and the textarea. */
  handlers: {
    onPaste(e: ClipboardEvent): void;
    onDragOver(e: DragEvent): void;
    onDragLeave(e: DragEvent): void;
    onDrop(e: DragEvent): void;
  };
}

export function useAttachments(o: { machine?: string; enabled?: boolean }): AttachmentsHandle {
  const [items, setItems] = useState<PendingItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hostname, setHostname] = useState<string | undefined | null>(null);
  const seq = useRef(0);
  const enabled = o.enabled !== false;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    let on = true;
    hostInfo()
      .then((i) => on && setHostname(i.hostname))
      .catch(() => on && setHostname(undefined));
    return () => {
      on = false;
    };
  }, []);
  // Object URLs of what was never sent are let go with the composer.
  useEffect(
    () => () => {
      for (const it of itemsRef.current) URL.revokeObjectURL(it.preview);
    },
    [],
  );

  const add = useCallback(
    (files: Iterable<Blob>) => {
      if (!enabled) return;
      setError(null);
      const list = Array.from(files);
      const room = ATTACHMENTS_PER_MESSAGE - itemsRef.current.length;
      if (list.length > room) {
        setError(`${ATTACHMENTS_PER_MESSAGE} images per message at most`);
        list.length = Math.max(0, room);
      }
      for (const file of list) {
        const why = refuseFile(file);
        const key = `p${++seq.current}`;
        const item: PendingItem = { key, file, preview: URL.createObjectURL(file), bytes: file.size };
        if (why) {
          item.error = why;
          setItems((prev) => [...prev, item]);
          continue;
        }
        setItems((prev) => [...prev, item]);
        uploadAttachment(file).then(
          (a) => setItems((prev) => prev.map((p) => (p.key === key ? { ...p, attachment: a } : p))),
          (e: Error) => setItems((prev) => prev.map((p) => (p.key === key ? { ...p, error: e.message } : p))),
        );
      }
    },
    [enabled],
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

  const uploading = items.some((it) => !it.attachment && !it.error);
  const local = hostname === null ? null : isThisMachine(o.machine, hostname);

  const compose = useCallback(
    (message: string): ComposeResult | null => {
      const cur = itemsRef.current;
      if (cur.some((it) => it.error)) {
        setError("remove the image that could not be attached, or try it again");
        return null;
      }
      if (cur.some((it) => !it.attachment)) {
        setError("still uploading…");
        return null;
      }
      const isLocal = local === true;
      const text = composePrompt(
        message,
        cur.map((it) => it.attachment!),
        isLocal,
      );
      if (text.length > PROMPT_MAX_CHARS) {
        setError(
          `too long: ${text.length.toLocaleString()} chars with the image lines, the limit is ${PROMPT_MAX_CHARS.toLocaleString()}`,
        );
        return null;
      }
      if (!text) return null;
      setError(null);
      return { text, local: isLocal };
    },
    [local],
  );

  const handlers = useMemo<AttachmentsHandle["handlers"]>(
    () => ({
      onPaste(e) {
        const files = imageFiles(e.clipboardData);
        if (files.length === 0) return;
        e.preventDefault();
        add(files);
      },
      onDragOver(e) {
        if (!enabled || !Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDragging(true);
      },
      onDragLeave(e) {
        // Leaving for a child element still counts as inside.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      },
      onDrop(e) {
        setDragging(false);
        const files = imageFiles(e.dataTransfer);
        if (files.length === 0) return;
        e.preventDefault();
        add(files);
      },
    }),
    [add, enabled],
  );

  return { items, uploading, error, dragging, local, add, remove, clear, compose, handlers };
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
  return (
    <label className="att-btn" title={title} aria-disabled={disabled || full ? "true" : undefined}>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        disabled={disabled || full}
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

/** The thumbnails above the input: each with its size, a spinner while uploading, the
 *  error under it when refused, and × to take it back. Nothing when there is none. */
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

/** One image waiting to go; its menu copies its name or takes it back. */
function TrayItem({ it, onRemove }: { it: PendingItem; onRemove: () => void }) {
  const name =
    it.file instanceof File && it.file.name
      ? it.file.name
      : it.attachment
        ? `${it.attachment.id}.${it.attachment.ext}`
        : "";
  const menu = useContextMenu(() => [
    copyItem("Copy name", name),
    { sep: true },
    { label: "Remove", danger: true, run: onRemove },
  ]);
  return (
    <li
      className={`att-item ${it.error ? "att-item--err" : ""} ${!it.attachment && !it.error ? "att-item--busy" : ""}`}
      data-attachment={it.attachment?.id ?? ""}
      data-state={it.error ? "error" : it.attachment ? "ready" : "uploading"}
      {...menu}
    >
      <span className="att-frame">
        <img className="att-thumb" src={it.preview} alt="" />
        {!it.attachment && !it.error && <span className="spinner att-busy" aria-hidden="true" />}
      </span>
      {it.error ? (
        <span className="att-meta" title={it.error}>
          {it.error}
        </span>
      ) : (
        <span className="att-meta num">
          <span>{it.attachment ? `${it.attachment.width}×${it.attachment.height}` : "uploading"}</span>
          <span>{mb(it.bytes)}</span>
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

/** Thumbnails for the images a prompt text names; each opens the full image in a new tab. */
export function AttachmentThumbs({ items, small }: { items: readonly AttachmentRef[]; small?: boolean }) {
  if (items.length === 0) return null;
  return (
    <span className={`att-thumbs ${small ? "att-thumbs--sm" : ""}`} data-attachment-thumbs={items.length}>
      {items.map((it) => (
        <a
          key={it.id}
          href={it.src}
          target="_blank"
          rel="noreferrer noopener"
          title={it.width && it.height ? `${it.width}×${it.height} · open` : "open"}
        >
          <img
            src={it.src}
            alt={`attachment${it.width && it.height ? ` ${it.width}×${it.height}` : ""}`}
            loading="lazy"
          />
        </a>
      ))}
    </span>
  );
}

/** A prompt's text with the attachments block turned into thumbnails. `render` draws the
 *  remaining text (Redacted by default), so a composer with markdown can pass its own. */
export function PromptBody({
  text,
  small,
  render = (body) => <Redacted text={body} />,
}: {
  text: string;
  small?: boolean;
  render?: (body: string) => ReactNode;
}) {
  const { body, items } = useMemo(() => splitAttachments(text), [text]);
  if (items.length === 0) return <>{render(text)}</>;
  return (
    <>
      {body ? render(body) : null}
      <AttachmentThumbs items={items} small={small} />
    </>
  );
}

/** For list rows: the prompt's first line without the block, and its images. */
export function promptParts(text: string): { body: string; items: AttachmentRef[] } {
  return splitAttachments(text);
}
