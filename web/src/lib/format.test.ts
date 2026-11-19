// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  askCut,
  askedQuestion,
  askFitsRow,
  attentionMessage,
  CC_COMMAND_MAX,
  isPlanReview,
  isQuestion,
  ROW_ASK_MAX,
  saidCommand,
  toolLabel,
} from "./format";

describe("toolLabel", () => {
  it("reads an MCP tool as server · tool", () => {
    expect(toolLabel("mcp__github__search_issues")).toBe("github · search_issues");
    expect(toolLabel("mcp__claude_ai_Linear__list_issues")).toBe("Linear · list_issues");
    expect(toolLabel("mcp__plugin_figma_figma__get_design_context")).toBe("figma · get_design_context");
    expect(toolLabel("mcp__my_server__do__thing")).toBe("my_server · do__thing");
  });
  it("leaves every other name as it came", () => {
    expect(toolLabel("Bash")).toBe("Bash");
    expect(toolLabel("some_other_tool")).toBe("some_other_tool");
    expect(toolLabel("mcp__")).toBe("mcp__");
  });
  it("names Gemini's and Codex's built-in tools the way Claude Code names its own", () => {
    expect(toolLabel("run_shell_command")).toBe("Shell");
    expect(toolLabel("read_file")).toBe("Read");
    expect(toolLabel("replace")).toBe("Edit");
    expect(toolLabel("apply_patch")).toBe("Edit");
  });
  it("names Claude Code's plan review Plan", () => {
    expect(toolLabel("ExitPlanMode")).toBe("Plan");
  });
  it("names Claude Code's question to the person Question", () => {
    expect(toolLabel("AskUserQuestion")).toBe("Question");
  });
});

describe("isQuestion", () => {
  it("is Claude Code's AskUserQuestion, asked as a permission", () => {
    expect(isQuestion({ kind: "permission", tool: "AskUserQuestion" })).toBe(true);
  });
  it("is nothing else", () => {
    expect(isQuestion({ kind: "permission", tool: "Bash" })).toBe(false);
    expect(isQuestion({ kind: "permission", tool: "ExitPlanMode" })).toBe(false);
    expect(isQuestion({ kind: "question", tool: "AskUserQuestion" })).toBe(false);
    expect(isQuestion({ kind: "permission" })).toBe(false);
  });
});

describe("askedQuestion", () => {
  const option = (label: string) => ({ label, description: `${label}, said longer` });
  it("is the first question's words, up to four option labels, and how many questions follow", () => {
    const input = {
      questions: [
        {
          question: " Which voice should the explainer use? ",
          header: "Voice",
          options: ["Warm narrator", "Neutral", "ElevenLabs default", "Mine", "Another"].map(option),
          multiSelect: false,
        },
        { question: "How long should it be?", header: "Length", options: [option("30 s"), option("60 s")] },
      ],
    };
    expect(askedQuestion(input)).toEqual({
      text: "Which voice should the explainer use?",
      options: ["Warm narrator", "Neutral", "ElevenLabs default", "Mine"],
      more: 1,
    });
    expect(askedQuestion({ questions: [{ question: "Go on?", options: ["Yes", " ", { label: "No" }, 3] }] })).toEqual({
      text: "Go on?",
      options: ["Yes", "No"],
      more: 0,
    });
  });
  it("is nothing where the input holds no question", () => {
    expect(askedQuestion(undefined)).toBeUndefined();
    expect(askedQuestion({ command: "ls" })).toBeUndefined();
    expect(askedQuestion({ questions: [] })).toBeUndefined();
    expect(askedQuestion({ questions: [{ question: " ", options: [option("A")] }] })).toBeUndefined();
    expect(askedQuestion({ questions: "Which?" })).toBeUndefined();
  });
});

describe("saidCommand", () => {
  it("is the message where it is the command, not a sentence about the request", () => {
    expect(saidCommand("npm test")).toBe("npm test");
    expect(saidCommand("Claude needs your permission to use Bash")).toBeUndefined();
    expect(saidCommand(undefined)).toBeUndefined();
  });
});

describe("askFitsRow", () => {
  const bash = (message?: string) => ({ kind: "permission", tool: "Bash", message });
  it("holds for a short request of its own, on one line, that the machine did not cut", () => {
    expect(askFitsRow(bash("npm run deploy -- --target staging"))).toBe(true);
    expect(askFitsRow(bash("Bash: npm run deploy -- --target staging"))).toBe(true);
    expect(askFitsRow(bash(`ls ${"a".repeat(ROW_ASK_MAX - 3)}`))).toBe(true);
    expect(askFitsRow({ kind: "permission", tool: "Write", message: "Write src/webhooks/invoice.ts" })).toBe(true);
    expect(
      askFitsRow({
        kind: "permission",
        tool: "mcp__github__create_pr",
        message: "Open a pull request on acme/billing",
      }),
    ).toBe(true);
    expect(askFitsRow({ kind: "permission", message: "Allow this?" })).toBe(true);
  });
  it("fails for one longer than a row holds, cut by the machine, or on more than one line", () => {
    expect(askFitsRow(bash(`ls ${"a".repeat(ROW_ASK_MAX - 2)}`))).toBe(false);
    // The machine keeps 200 characters and marks nothing; its tool's name taken off, what
    // is left is under 200 too.
    expect(askFitsRow(bash(`Bash: ${"a".repeat(194)}`))).toBe(false);
    expect(askFitsRow(bash("npm run deploy -- --target prod…"))).toBe(false);
    expect(askFitsRow(bash("cat <<EOF > notes.md\nhello\nEOF"))).toBe(false);
  });
  it("fails for a Claude Code command of 120 characters or more, which its machine cut with no mark", () => {
    const cmd = `npm run deploy -- ${"x".repeat(CC_COMMAND_MAX - 18)}`;
    expect(cmd).toHaveLength(CC_COMMAND_MAX);
    expect(askCut(bash(`Bash ${cmd}`), "claude-code")).toBe(true);
    expect(askCut(bash(`Bash ${cmd.slice(1)}`), "claude-code")).toBe(false);
    expect(askCut(bash(`Bash ${cmd}`), "codex")).toBe(false);
    // A row asks the same of it, whatever its own measure is.
    expect(askFitsRow(bash(`Bash ${cmd.slice(0, 90)}`), "claude-code")).toBe(true);
    expect(askFitsRow(bash(`Bash ${cmd}`), "claude-code")).toBe(false);
  });
  it("fails for a plan, a question, a tool with no request of its own, and a sentence about a shell's", () => {
    expect(askFitsRow({ kind: "permission", tool: "ExitPlanMode", message: "ExitPlanMode" })).toBe(false);
    expect(askFitsRow({ kind: "permission", tool: "ExitPlanMode", message: "ExitPlanMode: a short plan" })).toBe(false);
    expect(askFitsRow({ kind: "permission", tool: "AskUserQuestion", message: "AskUserQuestion" })).toBe(false);
    expect(askFitsRow(bash())).toBe(false);
    expect(askFitsRow(bash("Bash"))).toBe(false);
    expect(askFitsRow(bash("Claude needs your permission to use Bash"))).toBe(false);
  });
});

describe("isPlanReview", () => {
  it("is a permission to leave plan mode, by either spelling", () => {
    expect(isPlanReview({ kind: "permission", tool: "ExitPlanMode" })).toBe(true);
    expect(isPlanReview({ kind: "permission", tool: "exit_plan_mode" })).toBe(true);
  });
  it("is nothing else", () => {
    expect(isPlanReview({ kind: "permission", tool: "Bash" })).toBe(false);
    expect(isPlanReview({ kind: "permission", tool: "update_plan" })).toBe(false);
    expect(isPlanReview({ kind: "question", tool: "ExitPlanMode" })).toBe(false);
    expect(isPlanReview({ kind: "permission" })).toBe(false);
  });
});

describe("attentionMessage", () => {
  it("drops the tool name the message starts with", () => {
    expect(attentionMessage({ tool: "Bash", message: "Bash: rm -rf dist" })).toBe("rm -rf dist");
    expect(attentionMessage({ tool: "Bash", message: "Bash rm -rf dist" })).toBe("rm -rf dist");
    expect(attentionMessage({ message: "Allow this?" })).toBe("Allow this?");
  });
  it("says nothing when the message is only the tool's name", () => {
    expect(attentionMessage({ tool: "ExitPlanMode", message: "ExitPlanMode" })).toBeUndefined();
    expect(attentionMessage({ tool: "Bash", message: "Bash " })).toBeUndefined();
  });
});

describe("harnessMark", () => {
  it("names the ACP registry's agents once lib/acp.ts is loaded, with a monogram from the name", async () => {
    const { harnessMark } = await import("./format");
    expect(harnessMark("qwen-code")).toMatchObject({ glyph: "Qc", label: "qwen-code" });
    // A hook adapter since sessionpipe 0.16: named on the board too, in the colour it had.
    expect(harnessMark("grok-build")).toMatchObject({ glyph: "Gb", label: "Grok Build", hue: 168 });
    await import("./acp");
    expect(harnessMark("qwen-code")).toMatchObject({ glyph: "Qc", label: "Qwen Code" });
    expect(harnessMark("goose")).toMatchObject({ glyph: "Go", label: "goose" });
    expect(harnessMark("vtcode").label).toBe("VT Code");
    expect(harnessMark("devin").label).toBe("Devin");
    expect(harnessMark("claude-code").glyph).toBe("Cl");
    expect(harnessMark("brand-new").label).toBe("brand-new");
  });
});
