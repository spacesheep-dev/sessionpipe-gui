// SPDX-License-Identifier: Apache-2.0
// The composer's pictures (Attachments.tsx): how they go to a session's machine, the name
// each is signed under, the words a message of pictures alone is signed with, the check
// that an upload arrived whole, and the pin that nothing of the board (its key, an address
// of it, a link to a file it holds) is in what is signed. And a sent message's files: the
// list of them the machine adds to its words read back, each found by its hash, and drawn
// as a thumbnail or a chip; a picture kept elsewhere (an older version's block on an
// account, spacesheep's Talk block) drawn as a chip, never as its path or link.
import "../native/test-env";
import type { Attachment, ControlActivity, MachineControl } from "@shared/api";
import { composePrompt, humanSize, LOCAL_HEADING, promptWords, splitAttachments } from "@shared/attachments";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityRow } from "./Activity";
import {
  composeFiles,
  fileWords,
  fillerText,
  NOT_WHOLE_WORDS,
  type PictureEntry,
  PromptBody,
  pictureMode,
  pictureName,
  picturesOffWords,
  progressWords,
  refuseFile,
  SentFilesRows,
  savedFileSha,
  shownFiles,
  TOGETHER_WORDS,
  type UploadFailed,
  uploadPicture,
  waitingWords,
} from "./Attachments";
import { b64url, sha256 } from "./bytes";
import { commandString } from "./command";

// A spacesheep account's window, when a test asks for one: its relay holds no receiver's pictures.
const shell = vi.hoisted(() => ({ account: false }));
vi.mock("../lib/net", async (actual) => ({
  ...(await actual<typeof import("../lib/net")>()),
  accountMode: () => shell.account,
}));

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
    expect(refuseFile(sized(30 * 1024 * 1024), "files", "studio-mac")).toBe("That picture is too big for studio-mac.");
    expect(refuseFile(sized(9 * 1024 * 1024), "files")).toBeNull();
    expect(refuseFile(sized(9 * 1024 * 1024), "path", "studio-mac")).toBe("That picture is too big for studio-mac.");
    expect(refuseFile(sized(10, "image/heic"), "files")).toBe(
      "That kind of picture can't be sent. Use PNG, JPEG, GIF or WebP.",
    );
    expect(refuseFile(sized(10, "text/plain"), "files")).toBe("That file isn't a picture.");
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

  it("says why in words (uploadWords), with Retry only where trying again can help", async () => {
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: UploadFailed) => ({ words: e.message, retry: e.retry }),
      );
    receiver(() => ({
      status: 415,
      body: { reason: "not_an_image", error: "This file isn't the picture its type says." },
    }));
    expect(await failure(uploadPicture(file(), "kiwi.png", M))).toEqual({
      words: "That file isn't a picture.",
      retry: false,
    });
    receiver(() => ({
      status: 507,
      body: { reason: "full", error: "Too many files are held here; try again tomorrow." },
    }));
    expect(await failure(uploadPicture(file(), "kiwi.png", M))).toEqual({
      words: "127.0.0.1 has no room for more files today.",
      retry: false,
    });
    receiver(() => ({ status: 502, body: {} }));
    expect(await failure(uploadPicture(file(), "kiwi.png", M))).toEqual({
      words: "The picture didn't reach 127.0.0.1. Try again.",
      retry: true,
    });
    // The app's hub gives up on a slow receiver in plain text.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("the receiver didn't answer", { status: 504, headers: { "content-type": "text/plain" } }),
    );
    expect(await failure(uploadPicture(file(), "kiwi.png", M))).toEqual({
      words: "The picture didn't finish uploading: the connection is slow. Try again, or use Wi-Fi.",
      retry: true,
    });
    // A busy receiver's Retry-After is the minutes said.
    vi.stubGlobal("fetch", async () =>
      Response.json({ reason: "rate_limited" }, { status: 429, headers: { "retry-after": "120" } }),
    );
    expect(await failure(uploadPicture(file(), "kiwi.png", M))).toEqual({
      words: "That's a lot of pictures in a short time. Try again in 2 minutes.",
      retry: true,
    });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await failure(uploadPicture(file(), "kiwi.png", M))).toEqual({
      words: "The picture didn't upload: 127.0.0.1 can't be reached. Try again.",
      retry: true,
    });
  });

  it("a stop is no failure: an upload whose picture was removed ends as it was stopped", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("stopped", "AbortError");
    });
    const stop = new AbortController();
    await expect(uploadPicture(file(), "kiwi.png", M, { signal: stop.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
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

// ---------- a sent message's files ----------

const HEADING = "Attached files (saved in this folder):";
const START_SID = "8c132906-8c3f-4814-870a-afc3d05e1d2e";
const NONCE = "Qk1dXyT0aZ3mR8vL2pN6sWc4";

describe("the machine's list of saved files, read back", () => {
  it("a start's list: the words, and each file by its session, name, type and size", () => {
    const text = `Fix the invoice rounding.\n\n${HEADING}\n- .sessionpipe/files/${START_SID}/kiwi.png (image/png, 32 KB)\n- .sessionpipe/files/${START_SID}/notes.pdf (application/pdf, 1.2 MB)`;
    expect(splitAttachments(text)).toEqual({
      body: "Fix the invoice rounding.",
      items: [
        { kind: "file", session: START_SID, name: "kiwi.png", type: "image/png", size: "32 KB" },
        { kind: "file", session: START_SID, name: "notes.pdf", type: "application/pdf", size: "1.2 MB" },
      ],
    });
  });

  it("a prompt's list: each file in the folder named by the command's nonce", () => {
    const text = `Message via studio-mac.local:7373 (sessionpipe control, signed on the sender's device):\n\nLook at the attached picture.\n\n${HEADING}\n- .sessionpipe/files/${START_SID}/${NONCE}/image.png (image/png, 512 B)`;
    const { body, items } = splitAttachments(text);
    expect(body).toBe(
      "Message via studio-mac.local:7373 (sessionpipe control, signed on the sender's device):\n\nLook at the attached picture.",
    );
    expect(items).toEqual([
      { kind: "file", session: START_SID, nonce: NONCE, name: "image.png", type: "image/png", size: "512 B" },
    ]);
  });

  it("a name with spaces and brackets is the name", () => {
    const text = `Two of them\n\n${HEADING}\n- .sessionpipe/files/s1/${NONCE}/a (1).png (image/png, 3 KB)\n- .sessionpipe/files/s1/${NONCE}/Screenshot 2026-11-17 at 10.41.07 PM.png (image/png, 1.5 MB)`;
    expect(splitAttachments(text).items.map((it) => (it.kind === "file" ? [it.name, it.size] : null))).toEqual([
      ["a (1).png", "3 KB"],
      ["Screenshot 2026-11-17 at 10.41.07 PM.png", "1.5 MB"],
    ]);
  });

  it("ends at the blank line: what follows it (a start's source note) stays", () => {
    const note = "(Sent via localhost:7461 with sessionpipe control, signed on the sender's device.)";
    const text = `What is in this picture?\n\n${HEADING}\n- .sessionpipe/files/${START_SID}/kiwi.png (image/png, 32 KB)\n\n${note}`;
    const { body, items } = splitAttachments(text);
    expect(body).toBe(`What is in this picture?\n\n${note}`);
    expect(items).toHaveLength(1);
  });

  it("a stray line keeps the whole of it as words, and so does a heading the person wrote mid-paragraph", () => {
    const stray = `Look\n\n${HEADING}\n- .sessionpipe/files/s1/kiwi.png (image/png, 32 KB)\nand this one too`;
    expect(splitAttachments(stray)).toEqual({ body: stray, items: [] });
    const notOurs = `Look\n\n${HEADING}\n- kiwi.png (image/png, 32 KB)`;
    expect(splitAttachments(notOurs)).toEqual({ body: notOurs, items: [] });
    const inline = `I wrote:\n${HEADING}\n- .sessionpipe/files/s1/kiwi.png (image/png, 32 KB)`;
    expect(splitAttachments(inline)).toEqual({ body: inline, items: [] });
    // No list at all: the words as they are.
    expect(splitAttachments(HEADING)).toEqual({ body: HEADING, items: [] });
  });

  it("says a size as the machine does", () => {
    expect([512, 1024, 32_768, 183_402, 1_258_291].map(humanSize)).toEqual([
      "512 B",
      "1 KB",
      "32 KB",
      "179 KB",
      "1.2 MB",
    ]);
  });
});

describe("a sent message's files, found and drawn", () => {
  const SHA = { kiwi: "k".repeat(43), notes: "n".repeat(43), birch: "b".repeat(43) };
  const rows = [
    {
      id: "01PROMPT",
      machineId: M,
      kind: "prompt",
      session: `claude-code:${START_SID}`,
      at: "2026-11-18T10:00:00Z",
      expiresAt: "2026-11-18T11:00:00Z",
      nonce: NONCE,
      files: [{ name: "image.png", type: "image/png", size: 512, sha256: SHA.kiwi }],
    },
    {
      id: "01START",
      machineId: M,
      kind: "start",
      session: `claude-code:${START_SID}`,
      at: "2026-11-18T09:00:00Z",
      expiresAt: "2026-11-18T10:00:00Z",
      nonce: "another-nonce-0000000",
      files: [
        { name: "birch.png", type: "image/png", size: 2048, sha256: SHA.birch },
        { name: "notes.pdf", type: "application/pdf", size: 1_258_291, sha256: SHA.notes },
      ],
    },
  ] as ControlActivity[];
  const list = (lines: string[]) => `Look\n\n${HEADING}\n${lines.join("\n")}`;

  it("a prompt's file by its nonce and name; a start's by its session; one not sent from here has none", () => {
    const items = splitAttachments(
      list([
        `- .sessionpipe/files/${START_SID}/${NONCE}/image.png (image/png, 512 B)`,
        `- .sessionpipe/files/${START_SID}/birch.png (image/png, 2 KB)`,
        `- .sessionpipe/files/${START_SID}/notes.pdf (application/pdf, 1.2 MB)`,
        `- .sessionpipe/files/${START_SID}/${NONCE}/other.png (image/png, 1 KB)`,
        `- .sessionpipe/files/another-session/birch.png (image/png, 2 KB)`,
      ]),
    ).items;
    expect(items.map((it) => (it.kind === "file" ? savedFileSha(it, rows) : "legacy"))).toEqual([
      SHA.kiwi,
      SHA.birch,
      SHA.notes,
      undefined,
      undefined,
    ]);
  });

  it("the row's own files while the words have no list, the list's once they do", () => {
    expect(shownFiles([], rows[1]!.files, [])).toEqual([
      { name: "birch.png", type: "image/png", size: "2 KB", sha256: SHA.birch },
      { name: "notes.pdf", type: "application/pdf", size: "1.2 MB", sha256: SHA.notes },
    ]);
    const items = splitAttachments(list([`- .sessionpipe/files/s/${NONCE}/image.png (image/png, 512 B)`])).items;
    expect(shownFiles(items, rows[1]!.files, rows)).toEqual([
      { name: "image.png", type: "image/png", size: "512 B", sha256: SHA.kiwi },
    ]);
    expect(fileWords({ name: "kiwi.png", type: "image/png", size: "32 KB" })).toBe("kiwi.png · PNG · 32 KB");
    expect(fileWords({ name: "notes.pdf", type: "application/pdf", size: "1.2 MB" })).toBe("notes.pdf · 1.2 MB");
  });

  it("draws a thumbnail for a picture it has the bytes of, a chip for the rest, and never the path", () => {
    const text = list([
      `- .sessionpipe/files/${START_SID}/${NONCE}/image.png (image/png, 512 B)`,
      `- .sessionpipe/files/${START_SID}/notes.pdf (application/pdf, 1.2 MB)`,
      `- .sessionpipe/files/${START_SID}/${NONCE}/gone.png (image/png, 1 KB)`,
    ]);
    const html = renderToStaticMarkup(
      createElement(SentFilesRows.Provider, { value: rows }, createElement(PromptBody, { text })),
    );
    expect(html).not.toContain(".sessionpipe");
    expect(html).not.toContain(HEADING);
    expect(html).toContain("Look");
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain(`src="/api/ui/control/files/${SHA.kiwi}"`);
    expect(html).toContain('title="notes.pdf · 1.2 MB"');
    expect(html).toContain('title="gone.png · PNG · 1 KB"');
    // Before the session's record: the words as sent, the files the row signed.
    const before = renderToStaticMarkup(createElement(PromptBody, { text: "Look", files: rows[1]!.files }));
    expect(before).toContain(`src="/api/ui/control/files/${SHA.birch}"`);
    expect(before).toContain('data-sent-file="notes.pdf"');
  });
});

// ---------- pictures kept elsewhere ----------

const TALK = "Images attached (download each one to look at it):";
const talkLink = (name: string, sha = "TKk3".padEnd(43, "x")) =>
  `- [${name}](https://spacesheep.dev/talk-files/${"0".repeat(32)}/${sha}.png?e=1795139368424&k=c838${"0".repeat(28)})`;

describe("spacesheep's Talk block, read back", () => {
  it("one link: the words, and the picture by its name, with nothing of the link", () => {
    const text = `What colour is the square?\n\n${TALK}\n${talkLink("kiwi.png")}`;
    expect(splitAttachments(text)).toEqual({
      body: "What colour is the square?",
      items: [{ kind: "link-picture", name: "kiwi.png" }],
    });
  });

  it("several links, and a message of pictures alone, which is its pictures", () => {
    const text = `${TALK}\n${talkLink("kiwi.png")}\n${talkLink("birch.jpg", "b".repeat(43))}\n${talkLink("Screenshot 2026-11-17 at 10.41.07 PM.png")}`;
    expect(splitAttachments(text)).toEqual({
      body: "",
      items: [
        { kind: "link-picture", name: "kiwi.png" },
        { kind: "link-picture", name: "birch.jpg" },
        { kind: "link-picture", name: "Screenshot 2026-11-17 at 10.41.07 PM.png" },
      ],
    });
  });

  it("a name with brackets: spacesheep writes them as spaces, and one written whole is read whole", () => {
    // talk-images.ts talkImagesBlock: "[shot] 1].png" is written "shot  1 .png".
    expect(splitAttachments(`${TALK}\n${talkLink("shot  1 .png")}`).items).toEqual([
      { kind: "link-picture", name: "shot  1 .png" },
    ]);
    expect(splitAttachments(`Look\n\n${TALK}\n${talkLink("[draft] kiwi (2).png")}`)).toEqual({
      body: "Look",
      items: [{ kind: "link-picture", name: "[draft] kiwi (2).png" }],
    });
  });

  it("a text cut inside the block (a record's preview): the pictures whose names are whole, and no link", () => {
    const whole = `${TALK}\n${talkLink("kiwi.png")}\n${talkLink("birch.png")}`;
    const cutInLink = whole.slice(0, whole.length - 40);
    expect(splitAttachments(`Look\n\n${cutInLink}`)).toEqual({
      body: "Look",
      items: [
        { kind: "link-picture", name: "kiwi.png" },
        { kind: "link-picture", name: "birch.png" },
      ],
    });
    const cutInName = `${TALK}\n${talkLink("kiwi.png")}\n- [bir`;
    expect(splitAttachments(cutInName)).toEqual({ body: "", items: [{ kind: "link-picture", name: "kiwi.png" }] });
  });

  it("anything else after the heading keeps the whole of it as words", () => {
    const stray = `Look\n\n${TALK}\n${talkLink("kiwi.png")}\nand tell me what you see`;
    expect(splitAttachments(stray)).toEqual({ body: stray, items: [] });
    const elsewhere = `Look\n\n${TALK}\n- [kiwi.png](https://example.com/kiwi.png)`;
    expect(splitAttachments(elsewhere)).toEqual({ body: elsewhere, items: [] });
    const inline = `I wrote:\n${TALK}\n${talkLink("kiwi.png")}`;
    expect(splitAttachments(inline)).toEqual({ body: inline, items: [] });
    expect(splitAttachments(TALK)).toEqual({ body: TALK, items: [] });
  });

  it("with the machine's list after it, both are read", () => {
    const text = `Look\n\n${TALK}\n${talkLink("kiwi.png")}\n\n${HEADING}\n- .sessionpipe/files/s1/${NONCE}/notes.pdf (application/pdf, 3 KB)`;
    const { body, items } = splitAttachments(text);
    expect(body).toBe("Look");
    expect(items.map((it) => [it.kind, "name" in it ? it.name : ""])).toEqual([
      ["link-picture", "kiwi.png"],
      ["file", "notes.pdf"],
    ]);
  });

  it("draws a chip with the name, says where it is kept, and never draws the link", () => {
    const text = `What colour is the square?\n\n${TALK}\n${talkLink("kiwi.png")}\n${talkLink("birch.png")}`;
    const html = renderToStaticMarkup(createElement(PromptBody, { text }));
    expect(html).toContain("What colour is the square?");
    expect(html).toContain('data-picture-elsewhere="kiwi.png"');
    expect(html).toContain('title="birch.png · picture · kept on spacesheep"');
    for (const no of ["talk-files", "?e=", "&k=", "https:", TALK, "<img", "<a "]) expect(html).not.toContain(no);
  });
});

describe("an older version's block of pictures on a spacesheep account", () => {
  afterEach(() => {
    shell.account = false;
  });
  const STATE = "/Users/you/.local/state/sessionpipe-gui/attachments";
  const local = (id: string, w: number, h: number) => `- ${STATE}/${id}.png (${w}×${h})`;
  const A = "01K00000000000000000000001";
  const B = "01K00000000000000000000002";

  it("a chip each, by its size and where it is kept; no path, no thumbnail, nothing asked for", () => {
    shell.account = true;
    const text = `Fix this\n\n${LOCAL_HEADING}\n${local(A, 1200, 900)}\n${local(B, 10, 10)}`;
    const html = renderToStaticMarkup(createElement(PromptBody, { text }));
    expect(html).toContain("Fix this");
    expect(html).toContain('title="picture · 1200×900 · kept on the board it was sent from"');
    expect(html).toContain('title="picture · 10×10 · kept on the board it was sent from"');
    expect(html.match(/data-picture-elsewhere/g)).toHaveLength(2);
    for (const no of [STATE, "/attachments/", "<img", "<a ", LOCAL_HEADING]) expect(html).not.toContain(no);
  });

  it("a message of pictures alone is its chips, never an empty bubble", () => {
    shell.account = true;
    const html = renderToStaticMarkup(createElement(PromptBody, { text: `${LOCAL_HEADING}\n${local(A, 1200, 900)}` }));
    expect(html).toContain("picture");
    expect(html).toContain("1200×900 · kept on the board it was sent from");
    // A picture named in the words, with no size: its chip says only where it is kept.
    const bare = renderToStaticMarkup(createElement(PromptBody, { text: `Tidy the notes. /attachments/${A}.png` }));
    expect(bare).toContain('title="picture · kept on the board it was sent from"');
  });

  it("on the board itself the same block is thumbnails, as before", () => {
    const html = renderToStaticMarkup(createElement(PromptBody, { text: `${LOCAL_HEADING}\n${local(A, 1200, 900)}` }));
    expect(html).toContain(`src="/attachments/${A}.png"`);
    expect(html).not.toContain("data-picture-elsewhere");
  });

  it("an Activity row of pictures alone shows its chips, and a Talk message's row its names", () => {
    shell.account = true;
    const row = (text: string) =>
      renderToStaticMarkup(
        createElement(ActivityRow, {
          a: {
            id: "01ROW",
            machineId: M,
            kind: "prompt",
            session: SID,
            at: "2026-11-18T10:00:00Z",
            expiresAt: "2026-11-18T11:00:00Z",
            text,
          } as ControlActivity,
        }),
      );
    const legacy = row(`${LOCAL_HEADING}\n${local(A, 1200, 900)}`);
    expect(legacy).toContain("1200×900 · kept on the board it was sent from");
    expect(legacy).not.toContain(STATE);
    const talk = row(`Look\n\n${TALK}\n${talkLink("kiwi.png")}`);
    expect(talk).toContain('data-picture-elsewhere="kiwi.png"');
    expect(talk).not.toContain("talk-files");
  });
});

describe("a prompt's words for a one-line preview", () => {
  it("leaves out every kind of block from its heading on, cut anywhere", () => {
    expect(promptWords(`What colour is it?\n\n${TALK}\n${talkLink("kiwi.png")}`)).toBe("What colour is it?");
    expect(promptWords(`${TALK}\n- [kiwi.png](https://spacesheep.dev/talk-fi`)).toBe("");
    expect(promptWords(`Fix this\n\n${LOCAL_HEADING}\n- /Users/you/x/attachments/01K0.png (1×1)`)).toBe("Fix this");
    expect(promptWords(`Look\n\n${HEADING}\n- .sessionpipe/files/s1/kiwi.png (image/png, 32 KB)`)).toBe("Look");
    expect(promptWords("  Just words, with an Images attached mention.  ")).toBe(
      "Just words, with an Images attached mention.",
    );
  });
});

describe("what the tray's line says while pictures upload", () => {
  it("how far they are where the bytes are counted (a browser), else their size (the apps)", () => {
    const MB = 1024 * 1024;
    expect(progressWords(2.1 * MB, 1.25 * MB)).toBe("Uploading 1.2 of 2.1 MB…");
    expect(progressWords(2.1 * MB, 0)).toBe("Uploading 0.0 of 2.1 MB…");
    expect(progressWords(2.1 * MB, 3 * MB)).toBe("Uploading 2.1 of 2.1 MB…");
    expect(progressWords(12.4 * MB, 5.6 * MB)).toBe("Uploading 5 of 12 MB…");
    expect(progressWords(640 * 1024, 300 * 1024)).toBe("Uploading 300 of 640 KB…");
    expect(progressWords(2.1 * MB)).toBe("Uploading 2.1 MB…");
  });
  it("that a send waits for them, counted", () => {
    expect(waitingWords(1)).toBe("Waiting for 1 picture to finish uploading.");
    expect(waitingWords(3)).toBe("Waiting for 3 pictures to finish uploading.");
  });
});

describe("heldPictureUrl", () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    delete g.sessionpipeShell;
    vi.resetModules();
  });
  const SHA = "A".repeat(43);

  it("is the receiver's copy of a draft's picture", async () => {
    vi.resetModules();
    const { heldPictureUrl } = await import("./Attachments");
    expect(heldPictureUrl(SHA)).toBe(`/api/ui/control/files/${SHA}`);
  });

  it("on an account is nothing to load: the tray draws the frame alone", async () => {
    g.sessionpipeShell = {
      v: 1,
      platform: "ios",
      rxBase: "rx://localhost/acct",
      receiver: { id: "acct", origin: "https://spacesheep.dev", kind: "spacesheep", email: "you@example.com" },
    };
    vi.resetModules();
    const { heldPictureUrl } = await import("./Attachments");
    expect(heldPictureUrl(SHA)).toBe("");
  });
});
