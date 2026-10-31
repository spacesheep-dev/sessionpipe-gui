// SPDX-License-Identifier: Apache-2.0
import type { SessionFile, StoredEvent } from "@shared/api";
import { describe, expect, it } from "vitest";
import {
  diffRows,
  editorHref,
  editsIn,
  fileText,
  indexFiles,
  mergeFiles,
  parseRead,
  problemsOf,
  reviewPrompt,
  versionsOf,
} from "./model";

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
const bySeq = (events: StoredEvent[]) => new Map(events.map((e) => [e.session.seq, e]));
/** The first file the events name, and its text. */
const textOf = (events: StoredEvent[], cwd?: string, until?: number) =>
  fileText(indexFiles(events, cwd)[0]!, bySeq(events), until);

const numbered = (lines: string[], start = 1) =>
  lines.map((l, i) => `${String(start + i).padStart(6)}→${l}`).join("\n");

describe("indexFiles", () => {
  it("lists each file once with its touches in order, by path, with its counts", () => {
    seq = 0;
    const events = [
      ...tool("Read", { file_path: "/Users/me/code/app/src/a.ts" }, numbered(["a", "b"])),
      ...tool("Edit", { file_path: "/Users/me/code/app/src/a.ts", old_string: "a", new_string: "A" }, "ok"),
      ...tool("Write", { file_path: "/Users/me/code/app/src/new.ts", content: "x\n" }, "ok"),
      ev("files.changed", { paths: ["src/new.ts"] }),
      ...tool(
        "Edit",
        { file_path: "/Users/me/code/app/src/a.ts", old_string: "zz", new_string: "y" },
        "not found",
        false,
      ),
    ];
    const files = indexFiles(events, "~/code/app");
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/new.ts"]);
    const a = files[0]!;
    expect(a.dir).toBe("src");
    expect(a.name).toBe("a.ts");
    expect(a.given).toBe("/Users/me/code/app/src/a.ts");
    expect(a.touches.map((t) => t.kind)).toEqual(["read", "edit", "edit"]);
    // A touch's seq is its end's: the timeline's row carries that one.
    expect(a.touches.map((t) => t.seq)).toEqual([1, 3, 8]);
    expect({ reads: a.reads, edits: a.edits, failed: a.failed, created: a.created }).toEqual({
      reads: 1,
      edits: 1,
      failed: 1,
      created: false,
    });
    const n = files[1]!;
    expect(n.created).toBe(true);
    expect(n.touches.map((t) => t.kind)).toEqual(["write"]);
  });

  it("merges the receiver's index with the live events after it, a path and a seq once", () => {
    const index: SessionFile[] = [
      {
        path: "./src/a.ts",
        given: "src/a.ts",
        touches: [{ seq: 1, at: "2026-10-30T10:00:01Z", tool: "Read", kind: "read" }],
      },
    ];
    const live: SessionFile[] = [
      {
        path: "src/a.ts",
        given: "src/a.ts",
        touches: [
          { seq: 1, at: "2026-10-30T10:00:01Z", tool: "Read", kind: "read" },
          { seq: 5, at: "2026-10-30T10:00:05Z", tool: "Edit", kind: "edit", pending: true },
        ],
      },
      { path: "b.ts", given: "b.ts", touches: [{ seq: 6, at: "2026-10-30T10:00:06Z", tool: "Write", kind: "write" }] },
    ];
    const files = mergeFiles(index, live);
    expect(files.map((f) => f.path)).toEqual(["b.ts", "src/a.ts"]);
    expect(files[1]!.touches.map((t) => t.seq)).toEqual([1, 5]);
    expect(files[1]!.pending).toBe(true);
    expect(files[0]!.created).toBe(true);
  });
});

describe("parseRead", () => {
  it("strips Claude Code's numbering and keeps the first number", () => {
    expect(parseRead(numbered(["const a = 1;", "", "export {};"]))).toEqual({
      lines: ["const a = 1;", "", "export {};"],
      start: 1,
    });
    expect(parseRead(numbered(["x", "y"], 40))).toEqual({ lines: ["x", "y"], start: 40 });
    expect(parseRead("     1\tone\n     2\ttwo\n")).toEqual({ lines: ["one", "two"], start: 1 });
    expect(parseRead("     1→one\r\n     2→two\r\n")).toEqual({ lines: ["one", "two"], start: 1 });
  });
  it("leaves plain text alone and drops the harness's system reminders, never the lines between", () => {
    expect(parseRead("plain\ntext")).toEqual({ lines: ["plain", "text"], start: 1 });
    expect(parseRead(`${numbered(["a"])}\n\n<system-reminder>\nnoise\n</system-reminder>`)).toEqual({
      lines: ["a"],
      start: 1,
    });
    const mid = "<system-reminder>one</system-reminder>\nkeep\n<system-reminder>two</system-reminder>";
    expect(parseRead(mid).lines).toEqual(["keep"]);
  });
});

describe("fileText", () => {
  it("applies the edits after the last read to it and marks the lines they wrote", () => {
    seq = 0;
    const p = "/Users/me/code/app/src/a.ts";
    const events = [
      ...tool(
        "Read",
        { file_path: p },
        numbered(["import x from 'x';", "", "const limit = 1 << 20;", "export { limit };"]),
      ),
      ...tool(
        "Edit",
        { file_path: p, old_string: "const limit = 1 << 20;", new_string: "const limit = MAX;\nconst other = 2;" },
        "ok",
      ),
      ...tool("Edit", { file_path: p, old_string: "export { limit };", new_string: "export { limit, other };" }, "ok"),
      ...tool("Edit", { file_path: p, old_string: "nowhere", new_string: "x" }, "ok"),
    ];
    const t = textOf(events, "~/code/app");
    expect(t.basis?.kind).toBe("read");
    expect(t.lines).toEqual([
      "import x from 'x';",
      "",
      "const limit = MAX;",
      "const other = 2;",
      "export { limit, other };",
    ]);
    expect(t.base).toEqual(["import x from 'x';", "", "const limit = 1 << 20;", "export { limit };"]);
    expect([...t.changed].sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(t.hunks.map((h) => h.applied)).toEqual([true, true, false]);
    expect(t.hunks[0]).toMatchObject({ from: 3, to: 4 });
    expect(t.hunks[1]).toMatchObject({ from: 5, to: 5 });
    expect(t.missing).toBe(0);
  });

  it("drops marks inside a range a later edit replaced", () => {
    seq = 0;
    const p = "a.ts";
    const t = textOf([
      ...tool("Read", { file_path: p }, numbered(["a", "b", "c", "d", "e", "f"])),
      ...tool("Edit", { file_path: p, old_string: "c", new_string: "C1\nC2" }, "ok"),
      ...tool("Edit", { file_path: p, old_string: "C1\nC2\nd", new_string: "X" }, "ok"),
    ]);
    expect(t.lines).toEqual(["a", "b", "X", "e", "f"]);
    expect([...t.changed]).toEqual([3]);
  });

  it("takes a write as the base, a later read as the truth, and ignores a failed edit", () => {
    seq = 0;
    const p = "src/n.ts";
    const events = [
      ...tool("Write", { file_path: p, content: "a\nb\n" }, "ok"),
      ...tool("Edit", { file_path: p, old_string: "b", new_string: "B" }, "no", false),
      ...tool("Edit", { file_path: p, old_string: "a", new_string: "A", replace_all: true }, "ok"),
    ];
    const t = textOf(events);
    expect(t.basis?.kind).toBe("write");
    expect(t.lines).toEqual(["A", "b"]);
    expect(t.base).toEqual([]);
    expect(t.hunks.map((h) => [h.applied, h.failed])).toEqual([
      [false, true],
      [true, false],
    ]);
    const again = textOf([...events, ...tool("Read", { file_path: p }, numbered(["fresh"]))]);
    expect(again.lines).toEqual(["fresh"]);
    expect(again.hunks).toEqual([]);
  });

  it("has no text, only hunks, when nothing was read or written whole", () => {
    seq = 0;
    const t = textOf(tool("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }, "ok"));
    expect(t.lines).toBeNull();
    expect(t.hunks).toHaveLength(1);
    expect(t.hunks[0]).toMatchObject({ old: "x", new: "y", applied: false });
  });

  it("counts a touch whose event is missing or still cut, and waits for it", () => {
    seq = 0;
    const events = tool("Read", { file_path: "a.ts" }, numbered(["a"]));
    const [f] = indexFiles(events);
    expect(fileText(f!, new Map()).missing).toBe(1);
    const cut = { ...events[1]!, preview: { output: 9000 } };
    expect(fileText(f!, bySeq([cut])).missing).toBe(1);
    expect(fileText(f!, bySeq(events)).lines).toEqual(["a"]);
  });

  it("reads MultiEdit's edits in order", () => {
    expect(
      editsIn("MultiEdit", {
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d", replace_all: true },
        ],
      }),
    ).toEqual([
      { old: "a", new: "b", all: false },
      { old: "c", new: "d", all: true },
    ]);
  });

  it("steps through versions: each read or write is one, edits before any base another", () => {
    seq = 0;
    const p = "a.ts";
    const events = [
      ...tool("Edit", { file_path: p, old_string: "x", new_string: "y" }, "ok"),
      ...tool("Read", { file_path: p }, numbered(["y", "z"])),
      ...tool("Edit", { file_path: p, old_string: "z", new_string: "Z" }, "ok"),
      ...tool("Write", { file_path: p, content: "fresh\n" }, "ok"),
    ];
    const f = indexFiles(events)[0]!;
    const evs = bySeq(events);
    const vs = versionsOf(f, evs);
    expect(vs.map((v) => v.kind)).toEqual(["edits", "read", "write"]);
    expect(vs.map((v) => v.until)).toEqual([1, 5, 7]);
    expect(fileText(f, evs, vs[1]!.until).lines).toEqual(["y", "Z"]);
    expect(fileText(f, evs, vs[0]!.until).lines).toBeNull();
    expect(fileText(f, evs).lines).toEqual(["fresh"]);
  });
});

describe("diffRows", () => {
  it("lays the result beside the base, folding unchanged runs past the context", () => {
    const base = Array.from({ length: 12 }, (_, i) => `l${i + 1}`);
    const result = [...base.slice(0, 5), "new", ...base.slice(6)];
    const rows = diffRows(base, result);
    expect(rows.map((r) => r.kind)).toEqual([
      "fold",
      "same",
      "same",
      "same",
      "del",
      "add",
      "same",
      "same",
      "same",
      "fold",
    ]);
    expect(rows[0]).toMatchObject({ kind: "fold", count: 2, oldNo: 1, newNo: 1 });
    expect((rows[0] as { lines: unknown[] }).lines).toHaveLength(2);
    expect(rows[4]).toEqual({ kind: "del", text: "l6", oldNo: 6 });
    expect(rows[5]).toEqual({ kind: "add", text: "new", newNo: 6 });
    expect(rows[9]).toMatchObject({ kind: "fold", count: 3, oldNo: 10, newNo: 10 });
  });
  it("numbers from the base's start and handles an empty side", () => {
    expect(diffRows([], ["a"], 1)).toEqual([{ kind: "add", text: "a", newNo: 1 }]);
    expect(diffRows(["a", "b"], ["a", "c"], 40)).toEqual([
      { kind: "same", text: "a", oldNo: 40, newNo: 40 },
      { kind: "del", text: "b", oldNo: 41 },
      { kind: "add", text: "c", newNo: 41 },
    ]);
  });
});

describe("problemsOf", () => {
  it("lists failed tools with their subject and error attentions", () => {
    seq = 0;
    const events = [
      ...tool("Bash", { command: "npm test" }, "FAIL src/a.test.ts\n  expected 1\n  got 2", false),
      ...tool("Edit", { file_path: "/Users/me/code/app/x.ts", old_string: "a", new_string: "b" }, "no", false),
      ...tool("Read", { file_path: "x.ts" }, "ok"),
      ev("attention.needed", { kind: "error", message: "Rate limited" }),
    ];
    const ps = problemsOf(events, "~/code/app");
    expect(ps).toHaveLength(3);
    expect(ps[0]).toMatchObject({
      kind: "tool",
      tool: "Bash",
      subject: "npm test",
      text: "FAIL src/a.test.ts\n  expected 1…",
    });
    expect(ps[1]).toMatchObject({ tool: "Edit", subject: "x.ts" });
    expect(ps[2]).toMatchObject({ kind: "error", text: "Rate limited" });
  });
});

describe("reviewPrompt", () => {
  it("names each file and its lines, quotes them tagged, and says what to change", () => {
    const one = reviewPrompt([
      {
        id: "1",
        path: "src/a.ts",
        from: 3,
        to: 4,
        excerpt: "const limit = MAX;\nconst other = 2;",
        text: "Name the constant.",
      },
    ]);
    expect(one).toBe(
      [
        "A review comment on your changes. Please address it, then say what you changed.",
        "",
        "`src/a.ts:3-4`",
        "```ts",
        "const limit = MAX;",
        "const other = 2;",
        "```",
        "Name the constant.",
      ].join("\n"),
    );
    const many = reviewPrompt([
      { id: "1", path: "a.py", from: 1, to: 1, excerpt: "x = 1", text: "", suggestion: "x = 2" },
      { id: "2", path: "b.md", excerpt: "", text: "Add a test." },
      { id: "3", path: "c`d.txt", from: 2, to: 2, excerpt: "y```", text: "two" },
    ]);
    expect(many).toBe(
      [
        "Review comments on your changes (3). Please address each, then say what you changed per item.",
        "",
        "1. `a.py:1`",
        "```python",
        "x = 1",
        "```",
        "Replace with:",
        "```python",
        "x = 2",
        "```",
        "",
        "2. `b.md (whole file)`",
        "Add a test.",
        "",
        "3. `` c`d.txt:2 ``",
        "````",
        "y```",
        "````",
        "two",
      ].join("\n"),
    );
    expect(reviewPrompt([])).toBe("");
  });
});

describe("editorHref", () => {
  it("opens an absolute path at a line, and nothing it cannot name", () => {
    expect(editorHref("vscode", "/Users/me/code/app/src/a.ts", undefined, 12)).toBe(
      "vscode://file/Users/me/code/app/src/a.ts:12",
    );
    expect(editorHref("cursor", "./src/a.ts", "/home/me/app")).toBe("cursor://file/home/me/app/src/a.ts");
    expect(editorHref("zed", "src/a.ts", "~/app")).toBeNull();
    expect(editorHref("vscode", "~/x.ts", "/home/me")).toBeNull();
    expect(editorHref("vscode", "C:\\code\\a.ts", undefined, 1)).toBe("vscode://file/C:/code/a.ts:1");
    expect(editorHref("vscode", "/a b/c#1?.ts", undefined, 0)).toBe("vscode://file/a%20b/c%231%3F.ts");
  });
});
