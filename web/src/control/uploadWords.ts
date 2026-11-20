// SPDX-License-Identifier: Apache-2.0
// Why an upload didn't make it, in words, the same for the composer's pictures
// (Attachments.tsx) and New session's files (NewSessionSheet.tsx), and whether trying again
// can help (the tray's Retry is offered only then; after a refusal for too many at once,
// only once its wait is over). `board` is what took the upload: the
// receiver's name, or spacesheep.dev on an account (`boardName`). Never a raw code.
import { ATTACHMENT_TYPES } from "@shared/api";
import {
  UPLOAD_FAILED,
  UPLOAD_NO_DOOR,
  UPLOAD_NOT_WHOLE,
  UPLOAD_REFUSED,
  UPLOAD_UNREACHABLE,
  UPLOAD_WORDS,
  uploadLimitWords,
} from "@shared/attachments";
import { KEY_LOST_SENTENCE } from "../lib/keyWords";
import { accountMode, receiverName, receiverOrigin } from "../lib/net";

export interface UploadFailure {
  /** One sentence that says what happened and what to do next. */
  words: string;
  /** Trying the same bytes again can work: offer Retry. */
  retry: boolean;
  /** Too many at once: Retry can work after this many seconds, and is offered then. */
  waitS?: number;
}

/** How long a refusal for too many at once is waited out when it names no time: the
 *  "few minutes" its words say. */
export const LIMIT_WAIT_S = 180;

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

/** The name of spacesheep, where an upload for a computer reached through it goes on to:
 *  the account's server on an account, else spacesheep.dev (the board's link). */
export const spacesheepName = (): string => (accountMode() ? boardName() : "spacesheep.dev");

/** "picture" for one of the four picture types, else "file" (New session takes any file). */
export const nounFor = (type: string): "picture" | "file" => (type in ATTACHMENT_TYPES ? "picture" : "file");

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
  // What the upload through spacesheep said, before what its status would.
  if (reason === UPLOAD_REFUSED) return { words: UPLOAD_WORDS.refused, retry: false };
  // As UPLOAD_WORDS has them for a picture (uploadWords.test holds them to it).
  if (reason === UPLOAD_NO_DOOR) return { words: `This app can't send ${noun}s yet. Update the app.`, retry: false };
  if (reason === UPLOAD_NOT_WHOLE) return { words: `${The} didn't arrive whole. Try again.`, retry: true };
  if (reason === UPLOAD_UNREACHABLE)
    return { words: `${The} didn't upload: ${board} can't be reached. Try again.`, retry: true };
  if (reason === UPLOAD_FAILED) return { words: `${board} couldn't save the ${noun}. Try again.`, retry: true };
  if (status === 504 || (status === 502 && SLOW_RE.test(detail)))
    return { words: `${The} didn't finish uploading: the connection is slow. Try again, or use Wi-Fi.`, retry: true };
  if (status === 502) return { words: `${The} didn't reach ${board}. Try again.`, retry: true };
  if (status === 413 || reason === "too_large") return { words: `${That} is too big for ${board}.`, retry: false };
  if (status === 415 || reason === "not_an_image" || reason === "unsupported_type")
    return {
      words: noun === "picture" ? UPLOAD_WORDS.notPicture : `${board} can't take that kind of file.`,
      retry: false,
    };
  if (status === 507) return { words: `${board} has no room for more files today.`, retry: false };
  // The page's key is refused: the one sentence every place says for it (lib/keyWords).
  if (status === 401) return { words: KEY_LOST_SENTENCE, retry: false };
  if (status === 429) {
    const s = r.retryAfterS;
    const waitS = typeof s === "number" && Number.isFinite(s) && s >= 0 ? s : LIMIT_WAIT_S;
    return { words: uploadLimitWords(s, noun), retry: false, waitS };
  }
  if (status >= 500 || !status) return { words: `${board} couldn't save the ${noun}. Try again.`, retry: true };
  // Another refusal (a name the machine can't save, an empty file): the receiver's own sentence.
  return { words: detail || `${board} couldn't take the ${noun}.`, retry: false };
}
