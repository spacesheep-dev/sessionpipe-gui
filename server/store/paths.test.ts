// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionKey } from "../../shared/api.js";
import { Session, SID, tempDir } from "../../test/events.js";
import { changedPaths, pathsInInput, relativePath } from "./paths.js";
import { PREVIEW_CHARS, slimEvent } from "./slim.js";
import { Store } from "./store.js";

const CWD = "~/Desktop/Projects/sessionpipe";
const HOME = "/Users/alex";

describe("pathsInInput", () => {
  it("reads the file a Claude Code Edit / Write / NotebookEdit names, and nothing from Read or Bash", () => {
    const edit = {
      file_path: `${HOME}/Desktop/Projects/sessionpipe/web/src/app.tsx`,
      old_string: "a",
      new_string: "b",
      replace_all: false,
    };
    expect(pathsInInput("Edit", edit)).toEqual([edit.file_path]);
    expect(pathsInInput("Write", { file_path: "/tmp/x.md", content: "hi" })).toEqual(["/tmp/x.md"]);
    expect(pathsInInput("NotebookEdit", { notebook_path: "/n/b.ipynb", cell_id: "1", new_source: "x" })).toEqual([
      "/n/b.ipynb",
    ]);
    expect(pathsInInput("Read", { file_path: "/tmp/x.md" })).toEqual([]);
    expect(pathsInInput("Bash", { command: "printf hi > out.txt" })).toEqual([]);
    expect(pathsInInput("Edit", undefined)).toEqual([]);
    expect(pathsInInput(undefined, { file_path: "/x" })).toEqual([]);
  });

  it("reads Gemini / Codex shapes, and the files of an apply_patch", () => {
    expect(pathsInInput("write_file", { file_path: "CHANGELOG.md", content: "# Changelog" })).toEqual(["CHANGELOG.md"]);
    expect(pathsInInput("replace", { file_path: "src/a.ts", old_string: "x", new_string: "y" })).toEqual(["src/a.ts"]);
    expect(pathsInInput("edit_file", { path: "src/b.ts", edits: [] })).toEqual(["src/b.ts"]);
    const patch =
      "*** Begin Patch\n*** Update File: .github/workflows/deploy.yml\n@@\n+ x\n*** Add File: docs/new.md\n+ hi\n*** End Patch";
    expect(pathsInInput("apply_patch", { input: patch })).toEqual([".github/workflows/deploy.yml", "docs/new.md"]);
  });

  it("still finds the path in the index's slim copy: the input's JSON cut to a preview", () => {
    const big = { file_path: `${HOME}/Desktop/Projects/sessionpipe/README.md`, content: "x".repeat(5000) };
    const s = new Session();
    const slim = slimEvent({
      ...s.ev("tool.ended", { tool: "Write", input: big, ok: true }),
      arrivedAt: new Date().toISOString(),
      source: "http",
    });
    expect(typeof slim.data.input).toBe("string");
    expect((slim.data.input as string).length).toBe(PREVIEW_CHARS);
    expect(() => JSON.parse(slim.data.input as string)).toThrow();
    expect(pathsInInput("Write", slim.data.input)).toEqual([big.file_path]);
    // A path with an escaped quote survives the cut too.
    expect(pathsInInput("Edit", '{"file_path":"/a/b \\"c\\".ts","old_string":"xxxxxxxxxxxxxxxxxxxxxxxx')).toEqual([
      '/a/b "c".ts',
    ]);
  });
});

describe("relativePath / changedPaths", () => {
  it("strips the session's cwd, tildes the home elsewhere, and leaves relative paths alone", () => {
    expect(relativePath(`${HOME}/Desktop/Projects/sessionpipe/web/src/app.tsx`, CWD)).toBe("web/src/app.tsx");
    expect(
      relativePath(`${HOME}/Desktop/Projects/sessionpipe/web/src/app.tsx`, `${HOME}/Desktop/Projects/sessionpipe/`),
    ).toBe("web/src/app.tsx");
    expect(relativePath(`${HOME}/.claude/projects/x/MEMORY.md`, CWD)).toBe("~/.claude/projects/x/MEMORY.md");
    expect(relativePath("/home/dev/code/billing/src/a.ts", "~/code/billing")).toBe("src/a.ts");
    expect(relativePath("/private/tmp/scratch/out.txt", CWD)).toBe("/private/tmp/scratch/out.txt");
    expect(relativePath("src/webhooks/handler.ts", CWD)).toBe("src/webhooks/handler.ts");
    expect(relativePath("~/code/billing/src/webhooks/retry.ts", "~/code/billing")).toBe("src/webhooks/retry.ts");
    expect(relativePath(`${HOME}/Desktop/Projects/sessionpipe`, CWD)).toBe(".");
  });

  it("strips a Windows cwd the way Windows matches it, either slash and any case, and writes the rest with /", () => {
    const cwd = "C:\\Users\\dev\\code\\acme";
    expect(relativePath("C:\\Users\\dev\\code\\acme\\src\\index.ts", cwd)).toBe("src/index.ts");
    expect(relativePath("c:\\users\\dev\\code\\acme\\src\\index.ts", cwd)).toBe("src/index.ts");
    expect(relativePath("C:/Users/dev/code/acme/src/index.ts", cwd)).toBe("src/index.ts");
    expect(relativePath("C:\\Users\\dev\\code\\acme\\src\\index.ts", "C:/Users/dev/code/acme/")).toBe("src/index.ts");
    expect(relativePath("C:\\Users\\dev\\code\\acme", cwd)).toBe(".");
    expect(relativePath("C:\\Users\\dev\\code\\acme\\", cwd)).toBe(".");
    expect(relativePath("D:\\a.ts", "D:\\")).toBe("a.ts");
    expect(relativePath("C:\\Users\\dev\\code\\acme\\\\src\\a.ts", cwd)).toBe("src/a.ts");
    // Not under the cwd: a sibling sharing its prefix, another drive, a POSIX cwd, a bare
    // drive (C: alone is a drive's current folder, not its root), none.
    expect(relativePath("C:\\Users\\dev\\code\\acme2\\a.ts", cwd)).toBe("C:\\Users\\dev\\code\\acme2\\a.ts");
    expect(relativePath("D:\\Users\\dev\\code\\acme\\a.ts", cwd)).toBe("D:\\Users\\dev\\code\\acme\\a.ts");
    expect(relativePath("C:\\Users\\dev\\code\\acme\\a.ts", "/home/dev/code/acme")).toBe(
      "C:\\Users\\dev\\code\\acme\\a.ts",
    );
    expect(relativePath("C:\\Users\\dev\\code\\acme\\a.ts", "C:")).toBe("C:\\Users\\dev\\code\\acme\\a.ts");
    expect(relativePath("C:\\Users\\dev\\code\\acme\\a.ts")).toBe("C:\\Users\\dev\\code\\acme\\a.ts");
    // A relative path, and a POSIX one, are read as before.
    expect(relativePath("src\\index.ts", cwd)).toBe("src\\index.ts");
    expect(relativePath("/home/dev/code/acme/src/a.ts", cwd)).toBe("~/code/acme/src/a.ts");
  });

  it("strips a Windows cwd the client wrote with ~, which is how a session under the home folder arrives", () => {
    // sessionpipe-core's tilde(): C:\\Users\\dev\\code\\acme is sent as ~\\code\\acme.
    const cwd = "~\\code\\acme";
    expect(relativePath("C:\\Users\\dev\\code\\acme\\src\\index.ts", cwd)).toBe("src/index.ts");
    expect(relativePath("c:/users/dev/code/acme/src/index.ts", cwd)).toBe("src/index.ts");
    expect(relativePath("C:\\Users\\dev\\code\\acme\\src\\index.ts", "~/code/acme/")).toBe("src/index.ts");
    expect(relativePath("C:\\Users\\dev\\code\\acme", cwd)).toBe(".");
    expect(relativePath("C:\\Users\\dev\\notes.txt", "~")).toBe("notes.txt");
    // Not under it: a sibling, a folder outside the home, a name that only starts like Users.
    expect(relativePath("C:\\Users\\dev\\code\\acme2\\a.ts", cwd)).toBe("C:\\Users\\dev\\code\\acme2\\a.ts");
    expect(relativePath("C:\\code\\acme\\a.ts", cwd)).toBe("C:\\code\\acme\\a.ts");
    expect(relativePath("C:\\Users2\\dev\\code\\acme\\a.ts", cwd)).toBe("C:\\Users2\\dev\\code\\acme\\a.ts");
    const edit = (file_path: string) => ({
      type: "tool.ended",
      data: { tool: "Edit", ok: true, input: { file_path } },
    });
    const paths = new Set([
      ...changedPaths(edit("C:\\Users\\dev\\code\\acme\\src\\index.ts"), cwd),
      ...changedPaths(edit("c:\\users\\dev\\code\\acme\\src\\index.ts"), cwd),
      ...changedPaths({ type: "files.changed", data: { paths: ["src/index.ts"] } }, cwd),
    ]);
    expect([...paths]).toEqual(["src/index.ts"]);
  });

  it("gives one changed file for a Windows path however it is spelled, and for the files.changed after it", () => {
    const cwd = "C:\\Users\\dev\\code\\acme";
    const edit = (file_path: string) => ({
      type: "tool.ended",
      data: { tool: "Edit", ok: true, input: { file_path } },
    });
    const paths = new Set([
      ...[
        "C:\\Users\\dev\\code\\acme\\src\\index.ts",
        "C:/Users/dev/code/acme/src/index.ts",
        "c:\\users\\dev\\code\\acme\\src\\index.ts",
      ].flatMap((p) => changedPaths(edit(p), cwd)),
      ...changedPaths({ type: "files.changed", data: { paths: ["src/index.ts"] } }, cwd),
    ]);
    expect([...paths]).toEqual(["src/index.ts"]);
  });

  it("gives the same repo-relative paths for a files.changed and for the write tool it followed", () => {
    const write = {
      type: "tool.ended",
      data: {
        tool: "Edit",
        ok: true,
        input: { file_path: "~/code/billing/src/webhooks/handler.ts", old_string: "a", new_string: "b" },
      },
    };
    const fc = { type: "files.changed", data: { paths: ["src/webhooks/handler.ts", "src/webhooks/handler.ts", ""] } };
    expect(changedPaths(write, "~/code/billing")).toEqual(["src/webhooks/handler.ts"]);
    expect(changedPaths(fc, "~/code/billing")).toEqual(["src/webhooks/handler.ts"]);
    expect(changedPaths({ type: "tool.ended", data: { tool: "Edit", ok: false, input: { file_path: "/x" } } })).toEqual(
      [],
    );
    expect(changedPaths({ type: "tool.started", data: { tool: "Edit", input: { file_path: "/x" } } })).toEqual([]);
  });
});

describe("Store counts.filesChanged", () => {
  let tmp: { dir: string; cleanup: () => void };
  let store: Store;
  beforeEach(() => {
    tmp = tempDir();
    store = new Store(tmp.dir, { tickMs: 1_000, statsMs: 1_000 });
  });
  afterEach(async () => {
    await store.close();
    tmp.cleanup();
  });

  it("counts the files written by Edit / Write at tier 3 with no files.changed in sight, deduped and repo-relative, across a reboot", async () => {
    const s = new Session();
    const block = { session: { cwd: CWD, repo: "github.com/spacesheep-dev/sessionpipe" } };
    const edit = (file: string, ok = true) =>
      s.ev(
        "tool.ended",
        {
          tool: "Edit",
          call_id: `c${s.seq}`,
          ms: 20,
          ok,
          input: { file_path: file, old_string: "a", new_string: "b", replace_all: false },
        },
        block,
      );
    const content = "export const x = 1;\n".repeat(200); // 4 000 chars: the index keeps a cut preview of this input
    store.ingest(
      [
        s.ev("session.started", { source: "startup" }, block),
        s.ev("turn.started", { turn_id: "t1" }, block),
        edit(`${HOME}/Desktop/Projects/sessionpipe/web/src/app.tsx`),
        s.ev(
          "tool.ended",
          {
            tool: "Write",
            call_id: "w1",
            ms: 4,
            ok: true,
            input: { file_path: `${HOME}/Desktop/Projects/sessionpipe/server/store/paths.ts`, content },
          },
          block,
        ),
        edit(`${HOME}/Desktop/Projects/sessionpipe/web/src/app.tsx`), // same file again
        edit(`${HOME}/Desktop/Projects/sessionpipe/server/cli.ts`, false), // failed: not a change
        s.ev(
          "tool.ended",
          {
            tool: "Read",
            call_id: "r1",
            ms: 2,
            ok: true,
            input: { file_path: `${HOME}/Desktop/Projects/sessionpipe/README.md` },
          },
          block,
        ),
        s.ev(
          "tool.ended",
          { tool: "Bash", call_id: "b1", ms: 50, ok: true, input: { command: "printf hi > out.txt" } },
          block,
        ),
        // The adapter may one day send the event too; the same path is one change.
        s.ev("files.changed", { paths: ["server/store/paths.ts"] }, block),
      ],
      "http",
    );
    const key = sessionKey("claude-code", SID);
    expect(store.session(key)!.counts.filesChanged).toBe(2);
    expect(store.session(key)!.counts.tools).toBe(6);
    // A reboot reads the slim lines back and lands on the same number.
    await store.close();
    store = new Store(tmp.dir, { tickMs: 1_000, statsMs: 1_000 });
    expect(store.session(key)!.counts.filesChanged).toBe(2);
    // And the Review readings agree with the summary.
    const files = store.filesChanged({ since: new Date(Date.now() - 3_600_000).toISOString() });
    expect(files.repos.map((r) => r.repo)).toEqual(["github.com/spacesheep-dev/sessionpipe"]);
    // app.tsx was written last (event 5); the files.changed 5 s after the Write of paths.ts
    // names the same change and neither counts again nor moves its lastAt.
    expect(files.repos[0]!.paths.map((p) => [p.path, p.count])).toEqual([
      ["web/src/app.tsx", 2],
      ["server/store/paths.ts", 1],
    ]);
    const digest = store.digest({ tz: 0 });
    expect(digest.sessions[0]).toMatchObject({ key, filesTouched: 2 });
    expect(digest.totals.filesTouched).toBe(2);
    const hits = store.search({ q: "app.tsx" });
    expect(hits.hits.map((h) => [h.field, h.snippet])).toEqual([
      ["path", "web/src/app.tsx"],
      ["path", "web/src/app.tsx"],
    ]);
  });
});
