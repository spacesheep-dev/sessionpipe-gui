// SPDX-License-Identifier: Apache-2.0
// The breaker's cases for the Files drawer's model: inputs the harnesses can really send,
// at their edges. A case marked `it.fails` is a bug found and not yet fixed; its comment
// says what should happen. Take the marker off when the fix lands.
import type { StoredEvent } from "@shared/api";
import { PROMPT_MAX_CHARS } from "@shared/attachments";
import { pathsIn, relativePath } from "@shared/files";
import { describe, expect, it } from "vitest";
import { relativePath as serverRelativePath } from "../../../server/store/paths";
import { editorHref, fileText, indexFiles, parseRead, reviewPrompt } from "./model";

let seq = 0;
let clock = Date.parse("2026-10-30T10:00:00Z");
const ev = (type: string, data: Record<string, unknown>, extra: Partial<StoredEvent> = {}): StoredEvent => {
  clock += 1000;
  return {
    protocol: 1,
    id: `01${seq}`,
    type,
    time: new Date(clock).toISOString(),
    arrivedAt: new Date(clock).toISOString(),
    source: "http",
    tier: 3,
    harness: { name: "claude-code" },
    session: { id: "s1", seq: seq++, cwd: "~/code/app" },
    privacy: { rulesets: [], pii: false },
    data,
    ...extra,
  };
};
const tool = (name: string, input: Record<string, unknown>, output?: string, ok = true, callId = `c${seq}`) => [
  ev("tool.started", { tool: name, call_id: callId, input }),
  ev("tool.ended", { tool: name, call_id: callId, input, ok, ms: 10, ...(output !== undefined ? { output } : {}) }),
];
const numbered = (lines: string[], start = 1, sep = "→") =>
  lines.map((l, i) => `${String(start + i).padStart(6)}${sep}${l}`).join("\n");
const bySeq = (events: StoredEvent[]) => new Map(events.map((e) => [e.session.seq, e]));
const textOf = (events: StoredEvent[], cwd?: string) => fileText(indexFiles(events, cwd)[0]!, bySeq(events));

describe("changed lines after edits that shift the text", () => {
  // Lines 3–4 were written by the first edit. The second edit replaces lines 3–5 with one
  // line, so the only changed line left is 3; nothing before the edit may be marked.
  it("drops marks inside a range a later edit replaced instead of shifting them above it", () => {
    seq = 0;
    const t = textOf([
      ...tool("Read", { file_path: "a.ts" }, numbered(["a", "b", "c", "d", "e", "f"])),
      ...tool("Edit", { file_path: "a.ts", old_string: "c", new_string: "C1\nC2" }, "ok"), // lines 3–4, 7 lines now
      ...tool("Edit", { file_path: "a.ts", old_string: "C1\nC2\nd", new_string: "X" }, "ok"), // lines 3–5 → line 3
    ]);
    expect(t.lines).toEqual(["a", "b", "X", "e", "f"]);
    expect([...t.changed].sort((x, y) => x - y)).toEqual([3]);
  });

  it("shifts marks past an edit that grew the text", () => {
    seq = 0;
    const t = textOf([
      ...tool("Read", { file_path: "a.ts" }, numbered(["a", "b", "c", "d"])),
      ...tool("Edit", { file_path: "a.ts", old_string: "d", new_string: "D" }, "ok"), // line 4
      ...tool("Edit", { file_path: "a.ts", old_string: "a", new_string: "A1\nA2\nA3" }, "ok"), // lines 1–3, +2
    ]);
    expect(t.lines).toEqual(["A1", "A2", "A3", "b", "c", "D"]);
    expect([...t.changed].sort((x, y) => x - y)).toEqual([1, 2, 3, 6]);
  });

  it("applies a new string that contains the old one once, and replace_all everywhere", () => {
    seq = 0;
    const once = textOf([
      ...tool("Read", { file_path: "a.ts" }, numbered(["x = 1", "x = 1"])),
      ...tool("Edit", { file_path: "a.ts", old_string: "x = 1", new_string: "x = 1 + x = 1" }, "ok"),
    ]);
    expect(once.lines).toEqual(["x = 1 + x = 1", "x = 1"]);
    seq = 0;
    const all = textOf([
      ...tool("Read", { file_path: "a.ts" }, numbered(["aa", "aaa"])),
      ...tool("replace", { file_path: "a.ts", old_string: "aa", new_string: "b", expected_replacements: -1 }, "ok"),
    ]);
    expect(all.lines).toEqual(["b", "ba"]);
  });

  it("never applies an empty old string, and spans the end of the file", () => {
    seq = 0;
    const t = textOf([
      ...tool("Read", { file_path: "a.ts" }, numbered(["a", "b"])),
      ...tool("Edit", { file_path: "a.ts", old_string: "", new_string: "zzz" }, "ok"),
      ...tool("Edit", { file_path: "a.ts", old_string: "a\nb", new_string: "one" }, "ok"),
    ]);
    expect(t.lines).toEqual(["one"]);
    expect(t.hunks.map((h) => h.applied)).toEqual([false, true]);
  });
});

describe("reads", () => {
  // Claude Code on Windows, or a file with CRLF endings: every numbered line ends in \r,
  // which `.` does not match, so no line parses and the numbers stay in the text.
  it("parses numbered output whose lines end in CRLF", () => {
    expect(parseRead("     1→a\r\n     2→b\r\n")).toEqual({ lines: ["a", "b"], start: 1 });
  });

  it("takes mixed tab and arrow separators and wide numbers", () => {
    expect(parseRead(`${numbered(["a"], 99998, "\t")}\n${numbered(["b"], 99999)}`)).toEqual({
      lines: ["a", "b"],
      start: 99998,
    });
  });

  // A reminder in the middle, then one at the end: the end anchor is greedy from the first,
  // so the real lines between them are lost too.
  it("drops only a trailing system reminder, never lines between two of them", () => {
    const out = `${numbered(["a"])}\n<system-reminder>x</system-reminder>\n${numbered(["b"], 2)}\n<system-reminder>y</system-reminder>`;
    expect(parseRead(out).lines).toEqual(["a", "b"]);
  });

  it("a read with an offset is a page; an edit outside it stays a hunk, one inside applies", () => {
    seq = 0;
    const t = textOf([
      ...tool("Read", { file_path: "a.ts", offset: 40, limit: 2 }, numbered(["x", "y"], 40)),
      ...tool("Edit", { file_path: "a.ts", old_string: "elsewhere", new_string: "!" }, "ok"),
      ...tool("Edit", { file_path: "a.ts", old_string: "y", new_string: "Y" }, "ok"),
    ]);
    expect(t.start).toBe(40);
    expect(t.lines).toEqual(["x", "Y"]);
    expect(t.hunks.map((h) => [h.applied, h.from])).toEqual([
      [false, undefined],
      [true, 41],
    ]);
  });

  it("a failed read or an empty output changes nothing", () => {
    seq = 0;
    const t = textOf([
      ...tool("Write", { file_path: "a.ts", content: "w" }, "ok"),
      ...tool("Read", { file_path: "a.ts" }, "ENOENT", false),
      ...tool("Read", { file_path: "a.ts" }, ""),
    ]);
    expect(t.basis?.kind).toBe("write");
    expect(t.lines).toEqual(["w"]);
  });
});

describe("writes", () => {
  it("keeps CRLF and an empty file as one empty line, and counts a write-first file as created", () => {
    seq = 0;
    const crlf = tool("Write", { file_path: "a.ts", content: "a\r\nb\r\n" }, "ok");
    expect(textOf(crlf).lines).toEqual(["a\r", "b\r"]);
    seq = 0;
    const empty = tool("Write", { file_path: "e.ts", content: "" }, "ok");
    expect(textOf(empty).lines).toEqual([""]);
    expect(indexFiles(empty)[0]!.created).toBe(true);
  });
});

describe("touches", () => {
  it("files an end without its start, keeps a start without its end pending, and counts a cut preview", () => {
    seq = 0;
    const ended = ev("tool.ended", {
      tool: "Edit",
      call_id: "c0",
      ok: true,
      input: { file_path: "a.ts", old_string: "a", new_string: "b" },
    });
    const pending = ev("tool.started", { tool: "Write", call_id: "c1", input: { file_path: "b.ts", content: "x" } });
    const cut = ev(
      "tool.ended",
      { tool: "Edit", call_id: "c2", ok: true, input: '{"file_path":"c.ts","old_string":"aaaaaaaaaaaaaaaaaaaaaaaaa' },
      { preview: { input: 9000 } },
    );
    const all = [ended, pending, cut, ev("session.ended", {})];
    const files = indexFiles(all);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by["a.ts"]!.touches[0]).toMatchObject({ kind: "edit" });
    expect(by["a.ts"]!.touches[0]!.pending).toBeUndefined();
    expect(by["a.ts"]!.touches[0]!.failed).toBeUndefined();
    expect(by["b.ts"]!.touches[0]).toMatchObject({ pending: true });
    expect(fileText(by["b.ts"]!, bySeq(all)).lines).toBeNull();
    expect(by["c.ts"]!.touches[0]).toMatchObject({ cut: true });
    // A cut event is a missing one until the fill brings the whole event.
    expect(fileText(by["c.ts"]!, bySeq(all)).missing).toBe(1);
    // Cut JSON that no longer parses still names its file, and its edit waits for the fill.
    expect(pathsIn("Edit", cut.data.input)).toEqual(["c.ts"]);
    expect(fileText(by["c.ts"]!, bySeq(all)).hunks).toEqual([]);
  });

  // The same call_id ending twice (a retried hook, a replayed batch the store did not dedup
  // because the seq differs) is one tool; its edit must not apply twice.
  it("one call_id is one touch, however many ends arrive", () => {
    seq = 0;
    const input = { file_path: "a.ts", old_string: "x", new_string: "xx" };
    const t = textOf([
      ...tool("Read", { file_path: "a.ts" }, numbered(["x"])),
      ...tool("Edit", input, "ok", true, "same"),
      ev("tool.ended", { tool: "Edit", call_id: "same", ok: true, input }),
    ]);
    expect(t.lines).toEqual(["xx"]);
  });

  it("a files.changed well after the edit is its own touch; one within seconds is not", () => {
    seq = 0;
    const events = [...tool("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }, "ok")];
    events.push(ev("files.changed", { paths: ["a.ts"] }));
    clock += 60_000;
    events.push(ev("files.changed", { paths: ["a.ts"] }));
    const [f] = indexFiles(events);
    expect(f!.touches.map((t) => t.kind)).toEqual(["edit", "changed"]);
  });

  it("a patch names each file it adds, updates or deletes, and reads as a hunk under each", () => {
    seq = 0;
    const patch =
      "*** Begin Patch\n*** Add File: src/new.ts\n+export {};\n*** Delete File: src/old.ts\n*** Update File: src/db.ts\n@@\n-a\n+b\n*** End Patch";
    const events = tool("apply_patch", { patch }, "Done!");
    const files = indexFiles(events);
    expect(files.map((f) => f.path).sort()).toEqual(["src/db.ts", "src/new.ts", "src/old.ts"]);
    expect(fileText(files[0]!, bySeq(events)).hunks[0]).toMatchObject({ patch, applied: false });
  });

  it("a notebook edit is a touch with a hunk and no text", () => {
    seq = 0;
    const events = tool("NotebookEdit", { notebook_path: "n.ipynb", new_source: "x" }, "ok");
    const [f] = indexFiles(events);
    expect(f!.edits).toBe(1);
    expect(fileText(f!, bySeq(events)).hunks).toHaveLength(1);
  });
});

describe("paths", () => {
  const table: [string, string | undefined][] = [
    ["/Users/me/code/app/src/a b.ts", "~/code/app"],
    ["/Users/me/code/app/src/ünï.ts", "~/code/app"],
    ["./src/a.ts", "~/code/app"],
    ["C:\\code\\a.ts", "C:\\code"],
    ["~/code/app/x.ts", "/Users/me/code/app"],
    ["/home/me/code/app/x.ts", "~/code/app/"],
    ["/etc/hosts", undefined],
    ["/Users/me/code/app", "~/code/app"],
  ];
  it("reads every path exactly as the server does", () => {
    for (const [p, cwd] of table) expect(relativePath(p, cwd)).toBe(serverRelativePath(p, cwd));
  });

  // `./src/a.ts` and `src/a.ts` are one file; today they are two rows.
  it("a ./ prefix names the same file as none", () => {
    seq = 0;
    const files = indexFiles([
      ...tool("Read", { file_path: "./src/a.ts" }, numbered(["a"])),
      ...tool("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }, "ok"),
    ]);
    expect(files).toHaveLength(1);
  });

  // A Windows path has no "/" to split on: the whole path becomes the name, the folder "".
  it("a Windows path splits on its own separator", () => {
    seq = 0;
    const [f] = indexFiles(tool("Read", { file_path: "C:\\code\\a.ts" }, "x"));
    expect(f!.name).toBe("a.ts");
  });
});

describe("review prompt", () => {
  it("stays under the command's cap with sixty comments", () => {
    const comments = Array.from({ length: 60 }, (_, i) => ({
      id: String(i),
      path: `src/f${i}.ts`,
      from: i + 1,
      to: i + 3,
      excerpt: "x".repeat(2000),
      text: "Change this.",
    }));
    const p = reviewPrompt(comments);
    expect(p.length).toBeLessThanOrEqual(PROMPT_MAX_CHARS);
    expect(p).toContain("Review comments on your changes (60)");
  });

  it("a comment with no excerpt (a hunk-only file) quotes nothing", () => {
    expect(reviewPrompt([{ id: "1", path: "a.ts", from: 1, to: 1, excerpt: "", text: "Why?" }])).toBe(
      "A review comment on your changes. Please address it, then say what you changed.\n\n`a.ts:1`\nWhy?",
    );
  });

  // Four backticks inside the excerpt need a five-backtick fence; three are handled, four not.
  it("fences an excerpt that itself holds a four-backtick fence", () => {
    const p = reviewPrompt([{ id: "1", path: "a.md", from: 1, to: 1, excerpt: "````\ncode\n````", text: "Fix." }]);
    expect(p).toContain("`````md\n````\ncode\n````\n`````");
  });

  // A path with a backtick breaks the inline code span around it.
  it("escapes a backtick in a path", () => {
    const p = reviewPrompt([{ id: "1", path: "we`ird.ts", from: 1, to: 1, excerpt: "", text: "Fix." }]);
    expect(p).not.toContain("`we`ird.ts`");
  });
});

describe("editor links", () => {
  // encodeURI leaves # and ? alone, so a file named with either opens the wrong file.
  it("escapes # and ? in a path", () => {
    expect(editorHref("vscode", "/tmp/a#1.ts", undefined, 2)).toBe("vscode://file/tmp/a%231.ts:2");
    expect(editorHref("vscode", "/tmp/a?b.ts", undefined)).toBe("vscode://file/tmp/a%3Fb.ts");
  });
  it("escapes spaces and unicode, keeps +, and drops line 0", () => {
    expect(editorHref("zed", "/tmp/a b+c.ts", undefined, 0)).toBe("zed://file/tmp/a%20b+c.ts");
    expect(editorHref("cursor", "/tmp/ü.ts", undefined, 1)).toBe("cursor://file/tmp/%C3%BC.ts:1");
  });
});

describe("performance", () => {
  it("rebuilds a 20k-line file with 50 edits well under a second", () => {
    seq = 0;
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i} of the file;`);
    const events = [...tool("Read", { file_path: "big.ts" }, numbered(lines))];
    for (let i = 0; i < 50; i++)
      events.push(
        ...tool(
          "Edit",
          { file_path: "big.ts", old_string: `line ${i * 300} of`, new_string: `LINE ${i * 300} OF` },
          "ok",
        ),
      );
    const t0 = performance.now();
    const t = textOf(events);
    const ms = performance.now() - t0;
    expect(t.hunks.every((h) => h.applied)).toBe(true);
    expect(t.changed.size).toBe(50);
    expect(ms).toBeLessThan(1000);
  });
});
