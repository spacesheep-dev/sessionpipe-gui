// SPDX-License-Identifier: Apache-2.0
// The call an open permission is about: the newest started call of its tool not yet ended.
import type { StoredEvent } from "@shared/api";
import { describe, expect, it, vi } from "vitest";

// The hook's page-side imports (the store, the strip) need a window; the picker needs neither.
vi.mock("../data/hooks", () => ({ useStore: () => null }));
vi.mock("../components/ControlStrip", () => ({ answerable: () => true }));

import { pickAskedInput } from "./askedInput";

let seq = 0;
const ev = (type: string, data: Record<string, unknown>): StoredEvent => ({
  protocol: 1,
  id: `e${seq}`,
  type,
  time: "2026-10-28T10:00:00.000Z",
  tier: 3,
  harness: { name: "claude-code" },
  session: { id: "s1", seq: seq++ },
  privacy: { rulesets: [], pii: false },
  data,
  arrivedAt: "2026-10-28T10:00:00.000Z",
  source: "http",
});

describe("pickAskedInput", () => {
  it("returns the newest call of the tool that hasn't ended", () => {
    const events = [
      ev("tool.started", { tool: "Bash", call_id: "c1", input: { command: "npm test" } }),
      ev("tool.started", { tool: "Bash", call_id: "c2", input: { command: "npm run build && npm run deploy" } }),
      ev("attention.needed", { kind: "permission", tool: "Bash", attention_id: "a1" }),
    ];
    expect(pickAskedInput(events, "Bash")).toEqual({ command: "npm run build && npm run deploy" });
  });

  it("skips calls that ended and calls of other tools", () => {
    const events = [
      ev("tool.started", { tool: "Bash", call_id: "c1", input: { command: "ls" } }),
      ev("tool.started", { tool: "Bash", call_id: "c2", input: { command: "npm test" } }),
      ev("tool.ended", { tool: "Bash", call_id: "c2", ok: true }),
      ev("tool.started", { tool: "Read", call_id: "c3", input: { file_path: "a.ts" } }),
    ];
    expect(pickAskedInput(events, "Bash")).toEqual({ command: "ls" });
    expect(pickAskedInput(events, "Write")).toBeUndefined();
    expect(pickAskedInput(events.slice(1, 3), "Bash")).toBeUndefined();
  });

  it("takes the prompt's own call when its id is the call's, not a newer one of the tool", () => {
    const events = [
      ev("tool.started", { tool: "shell", call_id: "c1", input: { command: "rm -rf build" } }),
      ev("tool.started", { tool: "shell", call_id: "c2", agent_id: "sub", input: { command: "ls" } }),
    ];
    expect(pickAskedInput(events, "shell", "c1")).toEqual({ command: "rm -rf build" });
    expect(pickAskedInput(events, "shell", "perm-0a1b")).toEqual({ command: "ls" });
  });

  it("matches by name when the calls carry no id, and gives nothing for a slim or missing input", () => {
    expect(
      pickAskedInput(
        [ev("tool.started", { tool: "Bash", input: { command: "a" } }), ev("tool.ended", { tool: "Bash", ok: true })],
        "Bash",
      ),
    ).toBeUndefined();
    expect(pickAskedInput([ev("tool.started", { tool: "Bash", call_id: "c1" })], "Bash")).toBeUndefined();
  });
});
