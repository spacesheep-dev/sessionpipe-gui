// SPDX-License-Identifier: Apache-2.0
// A picture named in a prompt's text: the composer's way for a daemon that takes no files
// on a prompt (older than sessionpipe 0.10), and only where it runs on the machine the GUI
// runs on, so the block can name each picture by its absolute path. Every other machine
// gets pictures as CONTROL.md `files` (web/src/control/Attachments.tsx) and nothing of them
// is in the text. No URL is ever written: a prompt's text goes to the model and to every
// sink that takes prompts, and an address another machine could fetch from would have to
// carry the board's key. The heading of the URL block older versions wrote stays, so their
// messages still read back as thumbnails (`splitAttachments`); the server's retention scan
// looks for the same reference.
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
  /(?:https?:\/\/[^\s/]+)?\/attachments\/([0-9A-HJKMNP-TV-Z]{26})\.(png|jpe?g|gif|webp)(?:\?k=[A-Za-z0-9_-]+)?(?: \((\d+)×(\d+)\))?/g;

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
  id: string;
  ext: "png" | "jpg" | "gif" | "webp";
  /** Same-origin URL the browser can show it from (the cookie or loopback lets it in). */
  src: string;
  width?: number;
  height?: number;
}

/** A prompt text taken apart: `body` is the message without the attachments block (and
 *  without bare references), `items` the images it named, in order, each once. */
export function splitAttachments(text: string): { body: string; items: AttachmentRef[] } {
  const items: AttachmentRef[] = [];
  const seen = new Set<string>();
  let body = text;
  const headingAt = Math.max(text.lastIndexOf(`\n${LOCAL_HEADING}\n`), text.lastIndexOf(`\n${REMOTE_HEADING}\n`));
  const startsWithHeading = text.startsWith(`${LOCAL_HEADING}\n`) || text.startsWith(`${REMOTE_HEADING}\n`);
  if (startsWithHeading || headingAt >= 0) {
    const from = startsWithHeading ? 0 : headingAt;
    const block = text.slice(from);
    // Only a block made of our lines counts; anything else after the heading stays text.
    const rest = block.split("\n").slice(startsWithHeading ? 1 : 2);
    if (rest.length > 0 && rest.every((l) => /^- \S+ \(\d+×\d+\)$/.test(l) || l === "")) body = text.slice(0, from);
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
  return { body: body.replace(/\s+$/, ""), items };
}

/** Every attachment id a text refers to (the server's retention scan). */
export function attachmentIdsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ATTACHMENT_REF_RE)) out.push(m[1]!);
  return out;
}
