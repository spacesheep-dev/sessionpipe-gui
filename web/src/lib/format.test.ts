// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { toolLabel } from "./format";

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
});
