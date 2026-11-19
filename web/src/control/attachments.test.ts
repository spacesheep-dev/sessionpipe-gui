// SPDX-License-Identifier: Apache-2.0
// The composer's pictures (Attachments.tsx): how they go to a session's machine, the name
// each is signed under, the words a message of pictures alone is signed with, the check
// that an upload arrived whole, and the pin that nothing of the board (its key, an address
// of it, a link to a file it holds) is in what is signed.
import "../native/test-env";
import type { Attachment, MachineControl } from "@shared/api";
import { composePrompt } from "@shared/attachments";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  composeFiles,
  fillerText,
  NOT_WHOLE_WORDS,
  type PictureEntry,
  pictureMode,
  pictureName,
  picturesOffWords,
  refuseFile,
  TOGETHER_WORDS,
  uploadPicture,
} from "./Attachments";
import { b64url, sha256 } from "./bytes";
import { commandString } from "./command";

const M = "m_testmachine0000000001";
const SID = "claude-code:8c132906-8c3f-4814-870a-afc3d05e1d2e";

describe("pictureName", () => {
  it("makes every kind of space a plain one (a macOS screenshot has U+202F before PM)", () => {
    expect(pictureName("Screenshot 2026-11-17 at 10.41.07 PM.png", "image/png")).toBe(
      "Screenshot 2026-11-17 at 10.41.07 PM.png",
    );
    expect(pictureName("a b　c d.png", "image/png")).toBe("a b c d.png");
  });
  it("takes away what a machine would refuse in a name: control characters, slashes, leading dots", () => {
    expect(pictureName(".hidden.png", "image/png")).toBe("hidden.png");
    expect(pictureName("...env.png", "image/png")).toBe("env.png");
    expect(pictureName("../../etc/passwd.png", "image/png")).toBe("etcpasswd.png");
    expect(pictureName("a\\b/c\u0000d\u001fe\u007ff\tg.png", "image/png")).toBe("abcdefg.png");
    // A mark that turns the reading direction, or joins with no width, never shows in a name.
    expect(pictureName("invoice\u202Egnp.exe.png", "image/png")).toBe("invoicegnp.exe.png");
    expect(pictureName("a\u200Bb\u2066c\uFEFF.png", "image/png")).toBe("abc.png");
    expect(pictureName("", "image/png")).toBe("image.png");
    expect(pictureName(".png", "image/png")).toBe("image.png");
    expect(pictureName(" . ", "image/gif")).toBe("image.gif");
  });
  it("gives it the extension of its type", () => {
    expect(pictureName("photo", "image/jpeg")).toBe("photo.jpg");
    expect(pictureName("photo.jpeg", "image/jpeg")).toBe("photo.jpg");
    expect(pictureName("IMAGE.PNG", "image/png")).toBe("IMAGE.png");
    expect(pictureName("shot.png", "image/webp")).toBe("shot.webp");
    expect(pictureName("v1.2 mockup", "image/gif")).toBe("v1.2 mockup.gif");
  });
  it("is in NFC, as the machine writes it", () => {
    expect(pictureName("café.png", "image/png")).toBe("café.png");
  });
  it("is one of a kind in its message, whatever the case: image.png, image-2.png, …", () => {
    expect(pictureName("image.png", "image/png", ["image.png"])).toBe("image-2.png");
    expect(pictureName("image.png", "image/png", [pictureName("IMAGE.PNG", "image/png")])).toBe("image-2.png");
    expect(pictureName("image.png", "image/png", ["image.png", "Image-2.png"])).toBe("image-3.png");
    // Six pasted screenshots, each named image.png by the browser.
    const taken: string[] = [];
    for (let i = 0; i < 6; i++) taken.push(pictureName("image.png", "image/png", taken));
    expect(taken).toEqual(["image.png", "image-2.png", "image-3.png", "image-4.png", "image-5.png", "image-6.png"]);
    expect(new Set(taken.map((n) => n.toLowerCase())).size).toBe(6);
  });
  it("is at most 200 characters: the name is cut, never the extension or half a character", () => {
    const long = pictureName(`${"a".repeat(300)}.png`, "image/png");
    expect(long).toBe(`${"a".repeat(196)}.png`);
    expect(long).toHaveLength(200);
    const second = pictureName(`${"a".repeat(300)}.png`, "image/png", [long]);
    expect(second).toBe(`${"a".repeat(194)}-2.png`);
    expect(second).toHaveLength(200);
    // A pair is kept whole, so the name may be one short.
    const pairs = pictureName(`${"😀".repeat(150)}.png`, "image/png");
    expect(pairs).toBe(`${"😀".repeat(98)}.png`);
    expect(pairs.length).toBeLessThanOrEqual(200);
  });
});

describe("a message of pictures alone", () => {
  const entry = (name: string): PictureEntry => ({
    name,
    type: "image/png",
    size: 33_112,
    sha256: name[0]!.repeat(43),
    width: 640,
    height: 400,
  });
  it("is signed with words: every daemon refuses an empty text", () => {
    expect(fillerText(1)).toBe("Look at the attached picture.");
    expect(fillerText(3)).toBe("Look at the 3 attached pictures.");
    expect(composeFiles("", [entry("kiwi.png")]).text).toBe("Look at the attached picture.");
    expect(composeFiles("  \n ", [entry("kiwi.png"), entry("birch.png"), entry("onyx.png")]).text).toBe(
      "Look at the 3 attached pictures.",
    );
  });
  it("words that were typed go as they are, with nothing added, and the pictures in the tray's order", () => {
    const c = composeFiles("  What colour is the square? ", [entry("kiwi.png"), entry("birch.png")]);
    expect(c.text).toBe("What colour is the square?");
    expect(c.names).toEqual(["kiwi.png", "birch.png"]);
    // Only what a command's file is made of: no pixels.
    expect(c.files).toEqual([
      { name: "kiwi.png", type: "image/png", size: 33_112, sha256: "k".repeat(43) },
      { name: "birch.png", type: "image/png", size: 33_112, sha256: "b".repeat(43) },
    ]);
    expect(composeFiles("Just words", [])).toEqual({ text: "Just words", files: [], names: [] });
    expect(composeFiles("", []).text).toBe("");
  });
});

describe("how a picture goes to a session's machine", () => {
  const remote: MachineControl["remote"] = {
    via: "spacesheep",
    origin: "https://spacesheep.dev",
    rpId: "spacesheep.dev",
  };
  it("the table: prompt files × reached through spacesheep × this machine", () => {
    const rows: [promptFiles: boolean, relayed: boolean, thisMachine: boolean, mode: string][] = [
      [true, false, true, "files"],
      [true, false, false, "files"],
      [false, false, true, "path"],
      [false, false, false, "off"],
      // Through spacesheep there is no way to carry a file yet, whatever the computer takes.
      [true, true, true, "off"],
      [true, true, false, "off"],
      [false, true, true, "off"],
      [false, true, false, "off"],
    ];
    for (const [promptFiles, relayed, thisMachine, mode] of rows)
      expect(
        pictureMode({ promptFiles, ...(relayed ? { remote } : {}) }, thisMachine),
        JSON.stringify({ promptFiles, relayed, thisMachine }),
      ).toBe(mode);
  });
  it("is not known before the machine's row is, or (where it decides) which machine this is", () => {
    expect(pictureMode(undefined, true)).toBeUndefined();
    expect(pictureMode({}, null)).toBeUndefined();
    // Where the daemon takes files, or the computer is reached through spacesheep, it is not asked.
    expect(pictureMode({ promptFiles: true }, null)).toBe("files");
    expect(pictureMode({ remote }, null)).toBe("off");
  });
  it("says why none can be sent, and what to do about it where there is something", () => {
    expect(picturesOffWords("studio-mac", false)).toBe(
      "Pictures can't be sent to studio-mac: its sessionpipe is older than 0.10. Run `sessionpipe update` there.",
    );
    expect(picturesOffWords("studio-mac", true)).toBe(
      "Pictures can't be sent to studio-mac through spacesheep from here yet.",
    );
  });
  it("one picture is at most a command's file (25 MiB) as a file, and 8 MiB where the prompt names its path", () => {
    const sized = (size: number, type = "image/png") => ({ size, type }) as Blob;
    expect(refuseFile(sized(26_214_400), "files")).toBeNull();
    expect(refuseFile(sized(26_214_401), "files")).not.toBeNull();
    expect(refuseFile(sized(30 * 1024 * 1024), "files")).toBe("too large: 30 MB, limit 25 MB");
    expect(refuseFile(sized(9 * 1024 * 1024), "files")).toBeNull();
    expect(refuseFile(sized(9 * 1024 * 1024), "path")).toBe("too large: 9 MB, limit 8 MB");
    expect(refuseFile(sized(9 * 1024 * 1024))).toBe("too large: 9 MB, limit 8 MB");
    expect(refuseFile(sized(10, "image/heic"), "files")).toBe(
      "not an image we can send (image/heic); PNG, JPEG, GIF or WebP",
    );
    expect(TOGETHER_WORDS).toBe("These pictures are over 50 MB together. Remove one.");
  });
});

describe("uploading a picture as a prompt's file", () => {
  afterEach(() => vi.unstubAllGlobals());
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
  const file = () => new File([bytes], "Screenshot 2026-11-17 at 10.41.07 PM.png", { type: "image/png" });
  /** The receiver, answering every upload with `answer(own)`, `own` being the true hash. */
  const receiver = (answer: (own: string) => { status: number; body: unknown }) => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      const a = answer(b64url(await sha256(new Uint8Array(init.body as ArrayBuffer))));
      return Response.json(a.body, { status: a.status });
    });
    return seen;
  };

  it("sends the bytes as an ArrayBuffer under the picture's name, for its machine, and signs its own hash", async () => {
    const own = b64url(await sha256(bytes));
    const seen = receiver((sha256) => ({
      status: 201,
      body: { name: "kiwi.png", type: "image/png", size: bytes.length, sha256, width: 640, height: 400 },
    }));
    const entry = await uploadPicture(file(), "kiwi.png", M);
    expect(entry).toEqual({
      name: "kiwi.png",
      type: "image/png",
      size: bytes.length,
      sha256: own,
      width: 640,
      height: 400,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`/api/ui/control/files?name=kiwi.png&machine=${M}`);
    expect(seen[0]!.init.method).toBe("POST");
    expect((seen[0]!.init.headers as Record<string, string>)["content-type"]).toBe("image/png");
    // Never the Blob: the app's webview can hand one to the shell as an empty stream.
    expect(seen[0]!.init.body).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(seen[0]!.init.body as ArrayBuffer)).toEqual(bytes);
  });

  it("an older receiver's answer has no pixels: the entry is the four fields", async () => {
    receiver((sha256) => ({ status: 201, body: { name: "kiwi.png", type: "image/png", size: bytes.length, sha256 } }));
    expect(Object.keys(await uploadPicture(file(), "kiwi.png"))).toEqual(["name", "type", "size", "sha256"]);
  });

  it("refuses an answer whose hash or size is not the page's own: the picture didn't arrive whole", async () => {
    receiver(() => ({
      status: 201,
      body: { name: "kiwi.png", type: "image/png", size: bytes.length, sha256: "A".repeat(43) },
    }));
    await expect(uploadPicture(file(), "kiwi.png", M)).rejects.toThrow(NOT_WHOLE_WORDS);
    receiver((sha256) => ({
      status: 201,
      body: { name: "kiwi.png", type: "image/png", size: bytes.length - 1, sha256 },
    }));
    await expect(uploadPicture(file(), "kiwi.png", M)).rejects.toThrow(NOT_WHOLE_WORDS);
    receiver(() => ({ status: 201, body: {} }));
    await expect(uploadPicture(file(), "kiwi.png", M)).rejects.toThrow(NOT_WHOLE_WORDS);
    expect(NOT_WHOLE_WORDS).toBe("The picture didn't arrive whole. Try again.");
  });

  it("says the receiver's own sentence for a file that is not the picture its type says", async () => {
    receiver(() => ({
      status: 415,
      body: { reason: "not_an_image", error: "This file isn't the picture its type says." },
    }));
    await expect(uploadPicture(file(), "kiwi.png", M)).rejects.toThrow("This file isn't the picture its type says.");
    receiver(() => ({
      status: 507,
      body: { reason: "full", error: "Too many files are held here; try again tomorrow." },
    }));
    await expect(uploadPicture(file(), "kiwi.png", M)).rejects.toThrow("Too many files are held here");
    receiver(() => ({ status: 502, body: {} }));
    await expect(uploadPicture(file(), "kiwi.png", M)).rejects.toThrow("upload failed (http_502)");
  });
});

// The board's UI key opens the whole board, and a prompt's text goes to the model and to
// every sink that takes prompts: no key, no address of the board and no link to a file it
// holds is ever in a composed text or in a signed command string.
describe("nothing of the board in what is signed", () => {
  const KEY = "uik_test_0123456789abcdef";
  const ORIGIN = "https://studio-mac.local:7373";
  const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const STATE = "/Users/demo/.local/state/sessionpipe-gui";
  /** What a receiver older than this page answers an upload with: an absolute URL. */
  const old: Attachment = {
    id: A,
    type: "image/png",
    ext: "png",
    path: `${STATE}/attachments/${A}.png`,
    url: `${ORIGIN}/attachments/${A}.png?k=${KEY}`,
    width: 640,
    height: 400,
    bytes: 33_112,
  };

  it("no composed text and no signed command string holds the UI key or '/attachments/'", () => {
    // Where the prompt names its pictures (an older daemon on this machine): the path on
    // this disk and nothing else of the answer, whatever a caller asks for. The older
    // signature took `false` for a session on another machine, and wrote the URL.
    const compose = composePrompt as (message: string, items: Attachment[], local?: boolean) => string;
    for (const local of [undefined, true, false])
      for (const message of ["Make the header look like this", ""]) {
        const text = compose(message, [old], local);
        const cmd = commandString(M, { kind: "prompt", session: SID, text });
        for (const signed of [text, cmd]) {
          expect(signed).not.toContain(KEY);
          expect(signed).not.toContain("k=");
          expect(signed).not.toContain(ORIGIN);
          expect(signed).not.toContain("://");
        }
        expect(text.endsWith(`- ${old.path} (640×400)`)).toBe(true);
      }

    // Where they go as the command's files (every sessionpipe from 0.10): nothing about a
    // picture is in the text at all, and of an upload's answer only the four fields are signed.
    const answered = [
      { name: "kiwi.png", type: "image/png", size: 33_112, sha256: "k".repeat(43), width: 640, height: 400 },
      { name: "birch.jpg", type: "image/jpeg", size: 7_402_118, sha256: "b".repeat(43), url: old.url, path: old.path },
    ] as PictureEntry[];
    for (const message of ["What colour is the square in the attached image?", "", "  "]) {
      const c = composeFiles(message, answered);
      const cmd = commandString(M, { kind: "prompt", session: SID, text: c.text, files: c.files });
      // And the files as an upload answered them, should a caller pass those on unread.
      const raw = commandString(M, { kind: "prompt", session: SID, text: c.text, files: answered });
      for (const signed of [c.text, cmd, raw, JSON.stringify(c)]) {
        expect(signed).not.toContain(KEY);
        expect(signed).not.toContain("k=");
        expect(signed).not.toContain("/attachments/");
        expect(signed).not.toContain(STATE);
        expect(signed).not.toContain(ORIGIN);
        expect(signed).not.toContain("://");
      }
      const files = [
        { name: "kiwi.png", type: "image/png", size: 33_112, sha256: "k".repeat(43) },
        { name: "birch.jpg", type: "image/jpeg", size: 7_402_118, sha256: "b".repeat(43) },
      ];
      expect(JSON.parse(cmd).files).toEqual(files);
      expect(JSON.parse(raw).files).toEqual(files);
      expect(JSON.parse(cmd).text).toBe(message.trim() || "Look at the 2 attached pictures.");
    }
  });
});
