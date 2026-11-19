// SPDX-License-Identifier: Apache-2.0
// Why an upload didn't make it, in words, the same for the composer's pictures
// (Attachments.tsx) and New session's files (NewSessionSheet.tsx), and whether trying again
// can help (the tray's Retry is offered only then). `board` is what took the upload: the
// receiver's name, or spacesheep.dev on an account (`boardName`). Never a raw code.
import { ATTACHMENT_TYPES } from "@shared/api";
import { KEY_LOST_SENTENCE } from "../lib/keyWords";
import { accountMode, receiverName, receiverOrigin } from "../lib/net";

export interface UploadFailure {
  /** One sentence that says what happened and what to do next. */
  words: string;
  /** Trying the same bytes again can work: offer Retry. */
  retry: boolean;
}

/** The name of what an upload goes to: spacesheep.dev (the account's server) on an account,
 *  the receiver's name in the app, else the receiver's machine as its Info names it
 *  (`hostname`), else the address the page was opened at. */
export function boardName(hostname?: string): string {
  if (accountMode()) {
    try {
      return new URL(receiverOrigin()).host;
    } catch {
      return "spacesheep.dev";
    }
  }
  const named = receiverName() || hostname;
  if (named) return named;
  return typeof location !== "undefined" && location.hostname ? location.hostname : "the board";
}

/** "picture" for one of the four picture types, else "file" (New session takes any file). */
export const nounFor = (type: string): "picture" | "file" => (type in ATTACHMENT_TYPES ? "picture" : "file");

/** The minutes a Retry-After of `s` seconds says, as words: "a minute", "5 minutes". */
const minutes = (s: number | undefined): string => {
  if (s === undefined || !Number.isFinite(s)) return "a few minutes";
  const n = Math.max(1, Math.ceil(s / 60));
  return n === 1 ? "a minute" : `${n} minutes`;
};

/** The app's hub gave up on the receiver's answer: its plain-text sentence (sp-receivers
 *  proxy.rs), which a 504 says too. */
const SLOW_RE = /timed out|stopped answering/i;

/** What went wrong with an upload to `board`: `e` is what the upload threw (a TypeError
 *  where the network failed, else the refusal: `status`, `reason`, `detail`, `retryAfterS`,
 *  as control/api.ts ControlError carries them). */
export function uploadWords(e: unknown, board: string, noun: "picture" | "file" = "picture"): UploadFailure {
  const The = noun === "picture" ? "The picture" : "The file";
  const That = noun === "picture" ? "That picture" : "That file";
  if (e instanceof TypeError)
    return { words: `${The} didn't upload: ${board} can't be reached. Try again.`, retry: true };
  const r = (e ?? {}) as { status?: unknown; reason?: unknown; detail?: unknown; retryAfterS?: unknown };
  const status = typeof r.status === "number" ? r.status : 0;
  const reason = typeof r.reason === "string" ? r.reason : "";
  const detail = typeof r.detail === "string" ? r.detail : "";
  if (status === 504 || (status === 502 && SLOW_RE.test(detail)))
    return { words: `${The} didn't finish uploading: the connection is slow. Try again, or use Wi-Fi.`, retry: true };
  if (status === 502) return { words: `${The} didn't reach ${board}. Try again.`, retry: true };
  if (status === 413 || reason === "too_large") return { words: `${That} is too big for ${board}.`, retry: false };
  if (status === 415 || reason === "not_an_image" || reason === "unsupported_type")
    return {
      words: noun === "picture" ? "That file isn't a picture." : `${board} can't take that kind of file.`,
      retry: false,
    };
  if (status === 507) return { words: `${board} has no room for more files today.`, retry: false };
  // The page's key is refused: the one sentence every place says for it (lib/keyWords).
  if (status === 401) return { words: KEY_LOST_SENTENCE, retry: false };
  if (status === 429)
    return {
      words: `That's a lot of ${noun}s in a short time. Try again in ${minutes(typeof r.retryAfterS === "number" ? r.retryAfterS : undefined)}.`,
      retry: true,
    };
  if (status >= 500 || !status) return { words: `${board} couldn't save the ${noun}. Try again.`, retry: true };
  // Another refusal (a name the machine can't save, an empty file): the receiver's own sentence.
  return { words: detail || `${board} couldn't take the ${noun}.`, retry: false };
}
