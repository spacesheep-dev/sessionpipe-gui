// SPDX-License-Identifier: Apache-2.0
// Why an upload didn't make it, in words (uploadWords.ts): the one table the composer and
// New session both say, with Retry only where trying again can help.
import "../native/test-env";
import { describe, expect, it } from "vitest";
import { KEY_LOST_SENTENCE } from "../lib/keyWords";
import { ControlError } from "./api";
import { boardName, nounFor, uploadWords } from "./uploadWords";

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

  it("the board is the receiver's machine in a browser, else where the page was opened", () => {
    expect(boardName("studio-mac")).toBe("studio-mac");
    expect(boardName()).toBe("127.0.0.1");
  });
});
