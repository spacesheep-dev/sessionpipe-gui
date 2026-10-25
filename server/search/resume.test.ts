// SPDX-License-Identifier: Apache-2.0
// Owned by: search-service.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { homePath, resumeLine, shQuote } from "./resume.js";

describe("resumeLine", () => {
  it("writes Claude's line with the folder single-quoted", () => {
    expect(
      resumeLine({
        argv: ["claude", "--resume", "0b6a7f3e-1111-2222-3333-444455556666"],
        cwd: "/Users/demo/code/billing",
      }),
    ).toBe("cd '/Users/demo/code/billing' && claude --resume 0b6a7f3e-1111-2222-3333-444455556666");
  });

  it("names a non-default Claude home under ~ so the shell expands it", () => {
    expect(
      resumeLine(
        {
          argv: ["claude", "--resume", "abc"],
          cwd: "/Users/demo/x",
          env: { CLAUDE_CONFIG_DIR: "/Users/demo/.claude-work" },
        },
        "/Users/demo",
      ),
    ).toBe("cd '/Users/demo/x' && CLAUDE_CONFIG_DIR=~/.claude-work claude --resume abc");
    expect(
      resumeLine({ argv: ["claude", "--resume", "abc"], env: { CLAUDE_CONFIG_DIR: "/opt/my claude" } }, "/Users/demo"),
    ).toBe("CLAUDE_CONFIG_DIR='/opt/my claude' claude --resume abc");
  });

  it("writes Codex's line with no folder", () => {
    expect(resumeLine({ argv: ["codex", "resume", "7c1e2d3f"] })).toBe("codex resume 7c1e2d3f");
  });

  it("escapes a quote, a dollar and a space so the folder survives a real shell", () => {
    const cwd = "/tmp/it's $HOME a `dir`";
    const line = resumeLine({ argv: ["echo", "ok"], cwd });
    expect(line).toBe(`cd '/tmp/it'\\''s $HOME a \`dir\`' && echo ok`);
    // Run the quoting through sh: the cd argument must arrive byte for byte.
    const got = execFileSync("sh", ["-c", `printf '%s' ${line!.slice(3, line!.indexOf(" && "))}`], {
      encoding: "utf8",
    });
    expect(got).toBe(cwd);
  });

  it("offers nothing without a verified command, or with a line break anywhere", () => {
    expect(resumeLine(undefined)).toBeUndefined();
    expect(resumeLine({ argv: [] })).toBeUndefined();
    expect(resumeLine({ argv: ["claude", "--resume", "a\nrm -rf ~"] })).toBeUndefined();
    expect(resumeLine({ argv: ["codex", "resume", "x"], env: { "BAD NAME": "1", OK: "a\nb" } })).toBe("codex resume x");
  });
});

describe("quoting helpers", () => {
  it("leaves safe words alone and quotes the rest", () => {
    expect(shQuote("abc-1.2/x")).toBe("abc-1.2/x");
    expect(shQuote("")).toBe("''");
    expect(shQuote("a b")).toBe("'a b'");
    expect(homePath("/Users/demo", "/Users/demo")).toBe("~");
    expect(homePath("/Users/demo/a b", "/Users/demo")).toBe("~/'a b'");
    expect(homePath("/elsewhere", "/Users/demo")).toBe("/elsewhere");
  });
});
