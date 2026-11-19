// SPDX-License-Identifier: Apache-2.0
// A picture named in a prompt's text: the composer's way for a daemon that takes no files
// on a prompt (older than sessionpipe 0.10), and only where it runs on the machine the GUI
// runs on, so the block can name each picture by its absolute path. Every other machine
// gets pictures as CONTROL.md `files` (web/src/control/Attachments.tsx) and nothing of them
// is in the text. No URL is ever written: a prompt's text goes to the model and to every
// sink that takes prompts, and an address another machine could fetch from would have to
// carry the board's key. The heading of the URL block older versions wrote stays, so their
// messages still read back as thumbnails (`splitAttachments`); the server's retention scan
// looks for the same reference. The block a machine writes after the words of a message
// with files (sessionpipe's "Attached files", CONTROL.md §6) is read back here too: each
// line a file saved in the session's folder, which the page draws as a thumbnail or a chip.
// So is the block spacesheep's Talk pane wrote before it sent pictures as files: each line a
// signed link, of which only the name is kept, so the link is never drawn.
import type { Attachment } from "./api.js";

/** CONTROL.md §3.1: a prompt's `text` is at most this many characters. */
export const PROMPT_MAX_CHARS = 20_000;

export const LOCAL_HEADING = "Attached images (open them with your file-reading tool):";
/** Read only: the heading of the block of URLs older versions wrote. Nothing writes it now. */
export const REMOTE_HEADING = "Attached images (fetch them; they are on the board you were messaged from):";

/** One attachment reference as it appears in text: `/attachments/<ulid>.<ext>`, bare or
 *  inside an absolute URL, with an optional `?k=` (older messages) and an optional ` (W×H)`
 *  after it. */
export const ATTACHMENT_REF_RE =
  /(?:https?:\/\/[^\s/]+)?[/\\]{1,4}attachments[/\\]{1,4}([0-9A-HJKMNP-TV-Z]{26})\.(png|jpe?g|gif|webp)(?:\?k=[A-Za-z0-9_-]+)?(?: \((\d+)×(\d+)\))?/g;

/** One line of the block: `- <where the picture is> (W×H)`, where the place ends in
 *  `attachments/<ulid>.<ext>` with either slash (a Windows path may hold spaces). A line
 *  that names no picture is a person's own words, and stays in the message. */
const BLOCK_LINE_RE =
  /^- .*[/\\]attachments[/\\][0-9A-HJKMNP-TV-Z]{26}\.(?:png|jpe?g|gif|webp)(?:\?k=[A-Za-z0-9_-]+)? \(\d+×\d+\)$/;

/** The text that goes into the signed command for a session on this machine: the message,
 *  a blank line, the block of paths. A message with nothing but images is just the block. */
export function composePrompt(message: string, items: readonly Attachment[]): string {
  const m = message.trim();
  if (items.length === 0) return m;
  const block = `${LOCAL_HEADING}\n${attachmentLines(items).join("\n")}`;
  return m ? `${m}\n\n${block}` : block;
}

/** The block's lines for `items`, each exactly as composePrompt writes it: the path on this
 *  machine, never `url`. */
export function attachmentLines(items: readonly Attachment[]): string[] {
  return items.map((a) => `- ${a.path} (${a.width}×${a.height})`);
}

export interface AttachmentRef {
  kind?: never;
  id: string;
  ext: "png" | "jpg" | "gif" | "webp";
  /** Same-origin URL the browser can show it from (the cookie or loopback lets it in). */
  src: string;
  width?: number;
  height?: number;
}

/** CONTROL.md §6: the heading of the list of files a machine saved for a message, which it
 *  puts after the message's words (sessionpipe's files.ts `withFiles`). */
export const FILES_HEADING = "Attached files (saved in this folder):";
/** One line of that list: the path relative to the session's folder (a prompt's files in a
 *  folder of their own, named by the command's nonce), the type, and the size the machine
 *  wrote (`humanSize`). */
const FILE_LINE_RE =
  /^- \.sessionpipe\/files\/([^/]+)\/(?:([A-Za-z0-9_-]{16,64})\/)?(.+) \(([^,()]+), (\d+(?:\.\d)? (?:B|KB|MB))\)$/;

/** A file the machine saved for a message, as its list names it. `nonce`: the prompt's
 *  (a start's files have none); `size` as the machine wrote it ("32 KB"). */
export interface SavedFileRef {
  kind: "file";
  session: string;
  nonce?: string;
  name: string;
  type: string;
  size: string;
}

/** Read only: the heading spacesheep's Talk pane writes over the pictures a message carries
 *  in its words, a signed link each (spacesheep's talk-images.ts `TALK_IMAGES_HEAD`). */
export const TALK_HEADING = "Images attached (download each one to look at it):";
/** One line of that block: `- [<name>](<origin>/talk-files/<owner>/<sha>.<ext>?e=…&k=…)`.
 *  spacesheep writes no bracket in a name; one that has them is still read whole. */
const TALK_LINE_RE = /^- \[(.*)\]\(https?:\/\/[^\s()]+\/talk-files\/[^\s()]+\)$/;
/** Such a line where a cut ends the text, before its closing parenthesis: its name, once
 *  that is whole. */
const TALK_CUT_RE = /^- \[(?:(.*)\]\([^\s()]*|[^\]]*)$/;

/** A picture a spacesheep Talk message linked to: its name only. The link carries its own
 *  key and is not this page's to show. */
export interface LinkPictureRef {
  kind: "link-picture";
  name: string;
}

export type PromptItem = AttachmentRef | SavedFileRef | LinkPictureRef;

/** 183402 → "179 KB", 1258291 → "1.2 MB": units of 1024, the way the machine's list says a
 *  size (sessionpipe's files.ts `humanSize`), so a file reads the same before and after. */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1_048_576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

/** The machine's list of saved files taken out of `text`: the last heading, at the start or
 *  after a blank line, whose lines up to the next blank line (or the end) are all file
 *  lines. Anything else after the heading keeps the whole of it as words. */
function splitSavedFiles(text: string): { body: string; files: SavedFileRef[] } {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] !== FILES_HEADING || (i > 0 && lines[i - 1] !== "")) continue;
    let end = i + 1;
    while (end < lines.length && lines[end] !== "") end++;
    const listed = lines.slice(i + 1, end).map((l) => FILE_LINE_RE.exec(l));
    if (listed.length === 0 || listed.some((m) => !m)) continue;
    const files = listed.map((m): SavedFileRef => {
      const [, session, nonce, name, type, size] = m!;
      return { kind: "file", session: session!, ...(nonce ? { nonce } : {}), name: name!, type: type!, size: size! };
    });
    const before = lines.slice(0, i).join("\n").replace(/\s+$/, "");
    const after = lines.slice(end).join("\n").replace(/^\s+/, "");
    return { body: before && after ? `${before}\n\n${after}` : before || after, files };
  }
  return { body: text, files: [] };
}

/** spacesheep's Talk block taken out of `text`: the last heading, at the start or after a
 *  blank line, whose lines up to the next blank line (or the end) are all its links. The
 *  last line of a text that ends inside the block may be cut short (a record's preview): it
 *  is a picture when its name is whole, else nothing. Anything else after the heading keeps
 *  the whole of it as words. */
function splitTalkPictures(text: string): { body: string; pictures: LinkPictureRef[] } {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] !== TALK_HEADING || (i > 0 && lines[i - 1] !== "")) continue;
    let end = i + 1;
    while (end < lines.length && lines[end] !== "") end++;
    const pictures: LinkPictureRef[] = [];
    let read = end > i + 1;
    for (let n = i + 1; n < end && read; n++) {
      const m = TALK_LINE_RE.exec(lines[n]!);
      const cut = m || n < lines.length - 1 ? null : TALK_CUT_RE.exec(lines[n]!);
      const name = m?.[1] ?? cut?.[1];
      if (name !== undefined) pictures.push({ kind: "link-picture", name });
      read = !!(m || cut);
    }
    if (!read) continue;
    const before = lines.slice(0, i).join("\n").replace(/\s+$/, "");
    const after = lines.slice(end).join("\n").replace(/^\s+/, "");
    return { body: before && after ? `${before}\n\n${after}` : before || after, pictures };
  }
  return { body: text, pictures: [] };
}

/** A prompt text taken apart: `body` is the message without the attachments block (and
 *  without bare references), without spacesheep's Talk block and without the machine's
 *  list of saved files; `items` the images it named, in order, each once, then the
 *  pictures the Talk block names, then the files the list names. */
export function splitAttachments(prompt: string): { body: string; items: PromptItem[] } {
  const saved = splitSavedFiles(prompt);
  const talk = splitTalkPictures(saved.body);
  const text = talk.body;
  const items: PromptItem[] = [];
  const seen = new Set<string>();
  let body = text;
  const headingAt = Math.max(text.lastIndexOf(`\n${LOCAL_HEADING}\n`), text.lastIndexOf(`\n${REMOTE_HEADING}\n`));
  const startsWithHeading = text.startsWith(`${LOCAL_HEADING}\n`) || text.startsWith(`${REMOTE_HEADING}\n`);
  if (startsWithHeading || headingAt >= 0) {
    const from = startsWithHeading ? 0 : headingAt;
    const block = text.slice(from);
    // Only a block made of our lines counts; anything else after the heading stays text.
    const rest = block.split("\n").slice(startsWithHeading ? 1 : 2);
    if (rest.length > 0 && rest.every((l) => BLOCK_LINE_RE.test(l) || l === "")) body = text.slice(0, from);
  }
  for (const m of text.matchAll(ATTACHMENT_REF_RE)) {
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    const ext = (m[2] === "jpeg" ? "jpg" : m[2]) as AttachmentRef["ext"];
    const ref: AttachmentRef = { id, ext, src: `/attachments/${id}.${m[2]}` };
    if (m[3] && m[4]) {
      ref.width = Number(m[3]);
      ref.height = Number(m[4]);
    }
    items.push(ref);
  }
  items.push(...talk.pictures, ...saved.files);
  return { body: body.trimEnd(), items };
}

/** A prompt's words for a preview of one line (a board's row, the palette's peek), which
 *  may be cut anywhere: everything from the first heading of a block of pictures or files
 *  on is left out, so no path and no link of one is shown. */
export function promptWords(text: string): string {
  let at = text.length;
  for (const h of [LOCAL_HEADING, REMOTE_HEADING, FILES_HEADING, TALK_HEADING]) {
    const i = text.startsWith(h) ? 0 : text.indexOf(`\n${h}`);
    if (i >= 0 && i < at) at = i;
  }
  return text.slice(0, at).trim();
}

/** Every attachment id a text refers to (the server's retention scan). */
export function attachmentIdsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ATTACHMENT_REF_RE)) out.push(m[1]!);
  return out;
}
