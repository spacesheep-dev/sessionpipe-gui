// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources.
import { describe, expect, it } from "vitest";
import {
  cleanPromptBlock,
  codexInjected,
  codexPrompt,
  cut,
  finish,
  firstAskTitle,
  ms,
  repoName,
  shellJoin,
  toolLine,
} from "./text.js";

describe("prompt blocks", () => {
  const words = (s: string) => cleanPromptBlock(s).text;
  it("drops harness notices and keeps the person's words after them", () => {
    expect(words("<ide_opened_file>The user opened a.ts</ide_opened_file>\nfix the bug")).toBe("fix the bug");
    expect(words("<system-reminder>be brief</system-reminder>Ship it")).toBe("Ship it");
    expect(words("<local-command-caveat>c</local-command-caveat>")).toBe("");
    expect(words("[Request interrupted by user for tool use]")).toBe("");
    expect(words("<task-notification>\n<task-id>1</task-id>")).toBe("");
  });
  it("keeps the person's own HTML", () => {
    expect(words("<button>Save</button> should be blue")).toBe("<button>Save</button> should be blue");
  });
  it("slash commands and shell input stay as typed", () => {
    expect(
      words(
        "<command-name>/model</command-name><command-message>model</command-message><command-args>opus</command-args>",
      ),
    ).toBe("/model opus");
    expect(words("<bash-input>git status</bash-input>")).toBe("!git status");
  });
  it("paste markers go, the words around them stay; closed selections move out", () => {
    expect(words('<pasted_content id="p1">\nwhy does this fail?')).toBe("why does this fail?");
    const c = cleanPromptBlock("look <ide_selection>const a = 1;</ide_selection> here");
    expect(c.text).toBe("look  here");
    expect(c.attached).toEqual([["Selection", "const a = 1;"]]);
  });
  it("image placeholders go", () => {
    expect(words("[Image #2] what is this")).toBe("what is this");
  });
});

describe("codex prompts", () => {
  it("injections and the attached-files preamble", () => {
    expect(codexInjected("<environment_context>x</environment_context>")).toBe(true);
    expect(codexInjected("# AGENTS.md instructions for /a")).toBe(true);
    expect(codexInjected("make it faster")).toBe(false);
    expect(codexPrompt("# Files mentioned by the user:\n\n## a.ts: /x/a.ts\n\n## My request for Codex:\ndo it")).toBe(
      "do it\n(files: a.ts)",
    );
  });
});

describe("text", () => {
  it("cuts on a word and never splits a surrogate pair", () => {
    expect(cut("hello brave new world", 13)).toBe("hello brave");
    expect(cut(`${"a".repeat(9)}😀`, 10)).toBe("a".repeat(9));
  });
  it("finish redacts before the cut", () => {
    const t = finish(`token: ghp_${"A1b2".repeat(9)} and more`);
    expect(t).toContain("[redacted]");
    expect(t).not.toContain("A1b2A1b2");
  });
  it("tool lines and titles", () => {
    expect(toolLine("Bash", "  npm\n test ")).toBe("Bash npm test");
    expect(toolLine("Read", "")).toBe("Read");
    expect(toolLine("Bash", "x ".repeat(500)).length).toBeLessThanOrEqual(300);
    expect(shellJoin(["zsh", "-lc", "ls"])).toBe("ls");
    expect(firstAskTitle("one two ".repeat(20)).endsWith("…")).toBe(true);
    expect(firstAskTitle("short ask")).toBe("short ask");
  });
  it("times and repos", () => {
    expect(ms("2026-10-01T00:00:00Z")).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(ms("nope")).toBe(0);
    expect(ms(1_700_000_000)).toBe(1_700_000_000_000);
    expect(repoName("https://user:pw@github.com/acme/api.git")).toBe("acme/api");
    expect(repoName("git@github.com:acme/web.git")).toBe("acme/web");
    expect(repoName("not a url")).toBeUndefined();
  });
});
