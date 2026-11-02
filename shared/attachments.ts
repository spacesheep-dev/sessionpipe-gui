// SPDX-License-Identifier: Apache-2.0
// Images beside a control prompt. CONTROL.md §3.1 carries text only (the daemon frames
// `text` into the session as plain text and we cannot change it), so an uploaded image
// is named in the text instead, in one block the agent can act on: by absolute path
// when the session runs on the machine the GUI runs on, by URL (with the UI key) when
// it runs elsewhere. Both sides read the block back with `splitAttachments` to draw
// thumbnails, and the server's retention scan looks for the same reference.
import type { Attachment } from "./api.js";

/** CONTROL.md §3.1: a prompt's `text` is at most this many characters. */
export const PROMPT_MAX_CHARS = 20_000;

export const LOCAL_HEADING = "Attached images (open them with your file-reading tool):";
export const REMOTE_HEADING = "Attached images (fetch them; they are on the board you were messaged from):";

/** One attachment reference as it appears in text: `/attachments/<ulid>.<ext>`, bare or
 *  inside an absolute URL, with an optional `?k=` and an optional ` (W×H)` after it. */
export const ATTACHMENT_REF_RE =
  /(?:https?:\/\/[^\s/]+)?(?:[/\\\\]+)attachments(?:[/\\\\]+)([0-9A-HJKMNP-TV-Z]{26})\.(png|jpe?g|gif|webp)(?:\?k=[A-Za-z0-9_-]+)?(?: \((\d+)×(\d+)\))?/g;

/** The text that goes into the signed command: the message, a blank line, the block. A
 *  message with nothing but images is just the block. */
export function composePrompt(message: string, items: readonly Attachment[], local: boolean): string {
  const m = message.trim();
  if (items.length === 0) return m;
  const lines = items.map((a) => `- ${local ? a.path : a.url} (${a.width}×${a.height})`);
  const block = `${local ? LOCAL_HEADING : REMOTE_HEADING}\n${lines.join("\n")}`;
  return m ? `${m}\n\n${block}` : block;
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
    if (rest.length > 0 && rest.every((l) => /^- .+ \(\d+×\d+\)$/.test(l) || l === "")) body = text.slice(0, from);
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
