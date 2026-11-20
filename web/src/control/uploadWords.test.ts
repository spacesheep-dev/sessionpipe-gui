// SPDX-License-Identifier: Apache-2.0
// Why an upload didn't make it, in words (uploadWords.ts): the one table the composer and
// New session both say, with Retry only where trying again can help.
import "../native/test-env";
import {
  UPLOAD_FAILED,
  UPLOAD_NO_DOOR,
  UPLOAD_NOT_WHOLE,
  UPLOAD_REFUSED,
  UPLOAD_UNREACHABLE,
  UPLOAD_WORDS,
  uploadLimitWords,
} from "@shared/attachments";
import { describe, expect, it } from "vitest";
import { KEY_LOST_SENTENCE } from "../lib/keyWords";
import { ControlError } from "./api";
import { boardName, nounFor, spacesheepName, uploadWords } from "./uploadWords";

const B = "studio-mac";
const refused = (status: number, o: { reason?: string; detail?: string; retryAfterS?: number } = {}) =>
  new ControlError(status, o.reason ?? `http_${status}`, undefined, o.detail, undefined, o.retryAfterS);

describe("uploadWords", () => {
  it("the table", () => {
    const rows: [unknown, string, boolean][] = [
      [new TypeError("Failed to fetch"), "The picture didn't upload: studio-mac can't be reached. Try again.", true],
      [refused(504), "The picture didn't finish uploading: the connection is slow. Try again, or use Wi-Fi.", true],
      [
        refused(504, { detail: "the receiver didn't answer" }),
        "The picture didn't finish uploading: the connection is slow. Try again, or use Wi-Fi.",
        true,
      ],
      [
        refused(502, { detail: "the receiver stopped answering" }),
        "The picture didn't finish uploading: the connection is slow. Try again, or use Wi-Fi.",
        true,
      ],
      [refused(502), "The picture didn't reach studio-mac. Try again.", true],
      [refused(502, { detail: "the receiver didn't answer" }), "The picture didn't reach studio-mac. Try again.", true],
      [refused(413), "That picture is too big for studio-mac.", false],
      [refused(415, { reason: "not_an_image" }), "That file isn't a picture.", false],
      [refused(400, { reason: "not_an_image" }), "That file isn't a picture.", false],
      [refused(507, { reason: "full" }), "studio-mac has no room for more files today.", false],
      [refused(401), KEY_LOST_SENTENCE, false],
      [refused(429, { retryAfterS: 300 }), "That's a lot of pictures in a short time. Try again in 5 minutes.", true],
      [refused(429, { retryAfterS: 20 }), "That's a lot of pictures in a short time. Try again in a minute.", true],
      [refused(429), "That's a lot of pictures in a short time. Try again in a few minutes.", true],
      [refused(429, { retryAfterS: 3600 }), "That's a lot of pictures in a short time. Try again in 60 minutes.", true],
      [refused(429, { retryAfterS: 86_400 }), "That's a lot of pictures in a short time. Try again later.", true],
      [refused(500), "studio-mac couldn't save the picture. Try again.", true],
      [refused(503), "studio-mac couldn't save the picture. Try again.", true],
      [new Error("anything else"), "studio-mac couldn't save the picture. Try again.", true],
      [
        refused(400, { reason: "bad_name", detail: "A file's name can't start with a dot." }),
        "A file's name can't start with a dot.",
        false,
      ],
    ];
    for (const [e, words, retry] of rows) expect(uploadWords(e, B), words).toEqual({ words, retry });
  });

  it("never says a raw code", () => {
    for (const status of [400, 401, 403, 404, 409, 413, 415, 429, 500, 502, 503, 504, 507]) {
      const { words } = uploadWords(refused(status), B);
      expect(words).not.toMatch(/http_|\d{3}/);
      expect(words).toMatch(/\.$/);
    }
  });

  it("a file that is no picture is a file (New session)", () => {
    expect(nounFor("image/png")).toBe("picture");
    expect(nounFor("application/pdf")).toBe("file");
    expect(uploadWords(new TypeError("x"), B, "file").words).toBe(
      "The file didn't upload: studio-mac can't be reached. Try again.",
    );
    expect(uploadWords(refused(413), B, "file").words).toBe("That file is too big for studio-mac.");
    expect(uploadWords(refused(415), B, "file").words).toBe("studio-mac can't take that kind of file.");
  });

  it("an upload through spacesheep is said by its reason before its status, naming spacesheep", () => {
    const S = spacesheepName();
    expect(S).toBe("spacesheep.dev");
    const rows: [unknown, string, boolean][] = [
      // spacesheep takes none from this app: Retry can't help (and the paperclip goes).
      [refused(502, { reason: UPLOAD_REFUSED, detail: "x" }), UPLOAD_WORDS.refused, false],
      // The iPhone app's hub has no files door: only an update helps.
      [refused(501, { reason: UPLOAD_NO_DOOR }), UPLOAD_WORDS.noDoor, false],
      [refused(502, { reason: UPLOAD_NOT_WHOLE }), UPLOAD_WORDS.notWhole, true],
      [refused(502, { reason: UPLOAD_UNREACHABLE }), UPLOAD_WORDS.unreachable, true],
      [refused(502, { reason: UPLOAD_FAILED }), UPLOAD_WORDS.failed, true],
      // Another refusal of spacesheep's (a 502 from the app's hub): it didn't reach spacesheep.
      [refused(502, { reason: "hub_bad_encoding" }), "The picture didn't reach spacesheep.dev. Try again.", true],
      [refused(413, { reason: "too_large" }), "That picture is too big for spacesheep.dev.", false],
      // spacesheep's Retry-After, passed on as `retry_after`, keeps its minutes.
      [refused(429, { reason: "rate_limited", retryAfterS: 125 }), uploadLimitWords(125), true],
    ];
    for (const [e, words, retry] of rows) expect(uploadWords(e, S), words).toEqual({ words, retry });
    expect(uploadLimitWords(125)).toBe("That's a lot of pictures in a short time. Try again in 3 minutes.");
    // For a file on New session, the same states in its noun.
    expect(uploadWords(refused(501, { reason: UPLOAD_NO_DOOR }), S, "file")).toEqual({
      words: "This app can't send files yet. Update the app.",
      retry: false,
    });
    expect(uploadWords(refused(502, { reason: UPLOAD_NOT_WHOLE }), S, "file").words).toBe(
      "The file didn't arrive whole. Try again.",
    );
    // The words the receiver and the app's routes answer with are the ones said here.
    expect(UPLOAD_WORDS.unreachable).toBe(uploadWords(new TypeError("x"), S).words);
    expect(UPLOAD_WORDS.failed).toBe(uploadWords(refused(500), S).words);
    expect(UPLOAD_WORDS.notTaken).toBe(uploadWords(refused(400), S).words);
    expect(UPLOAD_WORDS.notPicture).toBe(uploadWords(refused(415), S).words);
  });

  it("the board is the receiver's machine in a browser, else where the page was opened", () => {
    expect(boardName("studio-mac")).toBe("studio-mac");
    expect(boardName()).toBe("127.0.0.1");
  });
});
