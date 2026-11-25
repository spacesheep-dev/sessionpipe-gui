// SPDX-License-Identifier: Apache-2.0
import type { Attention, SessionSummary } from "@shared/api";
import { describe, expect, it } from "vitest";
import {
  askCut,
  askedQuestion,
  askFitsRow,
  attentionMessage,
  CC_COMMAND_MAX,
  endCuts,
  isPlanReview,
  isQuestion,
  midCut,
  plainTitle,
  ROW_ASK_MAX,
  rowTime,
  saidCommand,
  sessionTitle,
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
  it("names the files a write changed Changed, never by the event's own name", () => {
    expect(toolLabel("files.changed")).toBe("Changed");
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

describe("rowTime", () => {
  // Noon on a fixed day, so "today" and "before today" are the same whatever the clock.
  const now = new Date(2026, 10, 18, 12, 0, 0).getTime();
  const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
  const hm = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const row = (o: Partial<SessionSummary>): SessionSummary =>
    ({ state: "idle", stateSince: iso(5), lastAt: iso(5), openAttentions: [], ...o }) as SessionSummary;

  it("needs you: since the prompt", () => {
    const at = iso(2);
    const s = row({
      state: "needs_you",
      stateSince: iso(1),
      openAttentions: [{ attentionId: "a1", kind: "permission", at } as Attention],
    });
    expect(rowTime(s, now)).toEqual({ iso: at, tip: `Needs you since ${hm(at)}` });
    expect(rowTime(row({ state: "needs_you", stateSince: iso(3) }), now).iso).toBe(iso(3));
  });

  it("working: the server's since, with or without a tool, never the tool's or the turn's", () => {
    const since = iso(40);
    const s = row({
      state: "working",
      stateSince: since,
      lastAt: iso(0),
      currentTurn: { turnId: "t1", since: iso(30) } as SessionSummary["currentTurn"],
    });
    expect(rowTime(s, now)).toEqual({ iso: since, tip: `Working since ${hm(since)}` });
    const withTool = { ...s, currentTool: { tool: "Bash", callId: "c1", since: iso(0) } } as SessionSummary;
    expect(rowTime(withTool, now).iso).toBe(since);
  });

  it("stale: since the last word, not ten minutes after it", () => {
    const last = iso(49);
    const s = row({ state: "stale", lastAt: last, stateSince: iso(39) });
    expect(rowTime(s, now)).toEqual({ iso: last, tip: `No word since ${hm(last)}` });
  });

  it("idle: since the last word", () => {
    const last = iso(20);
    expect(rowTime(row({ state: "idle", lastAt: last, stateSince: iso(20) }), now)).toEqual({
      iso: last,
      tip: `Idle since ${hm(last)}`,
    });
  });

  it("done: when it ended, else the last word, not a day after it", () => {
    const ended = iso(90);
    expect(rowTime(row({ state: "done", endedAt: ended, lastAt: iso(95) }), now)).toEqual({
      iso: ended,
      tip: `Ended ${hm(ended)}`,
    });
    const last = iso(30 * 60);
    const silent = row({ state: "done", lastAt: last, stateSince: iso(6 * 60) });
    expect(rowTime(silent, now).iso).toBe(last);
    // Thirty hours back is yesterday: the day goes before the clock.
    const day = new Date(last).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    expect(rowTime(silent, now).tip).toBe(`Last heard ${day} ${hm(last)}`);
  });
});

describe("plainTitle", () => {
  it("keeps a code span's text and drops its ticks", () => {
    expect(plainTitle("the old `--sink` flag?")).toBe("the old --sink flag?");
    expect(plainTitle("`__init__` cleanup")).toBe("__init__ cleanup");
  });
  it("drops the tick a cut left open", () => {
    expect(plainTitle("Rename `formatMo…")).toBe("Rename formatMo…");
  });
  it("keeps a mark mid-title: only a leading one goes", () => {
    expect(plainTitle("Fix `a` - then `b`")).toBe("Fix a - then b");
    expect(plainTitle("- refactor the store")).toBe("refactor the store");
    expect(plainTitle("> why is it slow")).toBe("why is it slow");
  });
  it("reads inline Markdown as its words", () => {
    expect(plainTitle("# Plan the **release**")).toBe("Plan the release");
    expect(plainTitle("See [the guide](https://x.test) and ~~old~~ *new* notes")).toBe(
      "See the guide and old new notes",
    );
  });
  it("leaves code written without ticks as it is", () => {
    for (const t of ["Fix __init__.py imports", "Why is __main__ slow", "Parse a[0](x) call", "rename snake_case_name"])
      expect(plainTitle(t)).toBe(t);
  });
  it("drops marks around or across a code span, never inside one", () => {
    expect(plainTitle("Use **`npm ci`** now")).toBe("Use npm ci now");
    expect(plainTitle("**Run `npm ci` first**")).toBe("Run npm ci first");
    expect(plainTitle("Why does `a*b*c` fail")).toBe("Why does a*b*c fail");
    expect(plainTitle("`*a b*` stays")).toBe("*a b* stays");
  });
  it("keeps text that is nothing but marks", () => {
    expect(plainTitle("``")).toBe("``");
  });
});

describe("sessionTitle", () => {
  const base = { cwd: "/w/app", id: "abcdef123456" };
  it("is plain words", () => {
    expect(sessionTitle({ ...base, title: "Which docs pages still mention the old `--sink` flag?" })).toBe(
      "Which docs pages still mention the old --sink flag?",
    );
  });
  it("matches the uncut ask on the raw strings, then reads it as words", () => {
    const s = {
      ...base,
      title: "Rename `formatMo...",
      lastUser: "Rename `formatMoney` to `formatAmount` everywhere",
    };
    expect(sessionTitle(s)).toBe("Rename formatMoney to formatAmount everywhere");
    expect(sessionTitle({ ...s, lastUser: "something else" })).toBe("Rename formatMo…");
  });
});

describe("endCuts", () => {
  it("cuts after each whole word, shortest first, dropping what ends a clause", () => {
    expect(endCuts("Find why the export, again")).toEqual([
      "F…",
      "Fi…",
      "Fin…",
      "Find…",
      "Find why…",
      "Find why the…",
      "Find why the export…",
    ]);
  });
  it("cuts a text of one word after each of its characters, CJK and paths too", () => {
    const cjk = "夜間の請求書エクスポートが遅い";
    const cuts = endCuts(cjk);
    expect(cuts).toHaveLength([...cjk].length - 1);
    expect(cuts[0]).toBe("夜…");
    expect(cuts.at(-1)).toBe(`${[...cjk].slice(0, -1).join("")}…`);
    expect(endCuts("~/code/billing/export.ts")[0]).toBe("~…");
    expect(endCuts("😀😀😀")).toEqual(["😀…", "😀😀…"]);
  });
  it("has nothing to offer for one character", () => {
    expect(endCuts("a")).toEqual([]);
  });
});

describe("midCut", () => {
  it("keeps a name that fits whole", () => {
    expect(midCut("studio-mac", 10)).toBe("studio-mac");
    expect(midCut("studio-mac", 40)).toBe("studio-mac");
  });
  it("cuts a longer one in its middle, keeping its start and its end, in max characters", () => {
    const name = "build-runner-eu-west-1-c5-xlarge-0042-ab";
    expect(midCut(name, 21)).toBe("build-runn…ge-0042-ab");
    expect([...midCut(name, 21)]).toHaveLength(21);
    expect(midCut(name, 4)).toBe("bu…b");
  });
  it("leaves no space beside the cut, and counts a character outside the BMP as one", () => {
    expect(midCut("for Plan the big billing migration", 13)).toBe("for Pl…ration");
    expect(midCut("for a b c d e f", 6)).toBe("for…f");
    expect(midCut("😀😀😀😀😀😀", 5)).toBe("😀😀…😀😀");
  });
  it("is the ellipsis alone under three", () => {
    expect(midCut("studio-mac", 2)).toBe("…");
  });
});
