// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { validate } from "./validate.js";

const good = () => ({
  protocol: 1,
  id: "01K6ABCXYZ0123456789ABCDEF",
  type: "tool.ended",
  time: "2026-09-28T01:03:11.204Z",
  tier: 3,
  harness: { name: "claude-code", version: "2.1.290", event: "PostToolUse" },
  session: { id: "8c132906-8c3f-4814-870a-afc3d05e1d2e", seq: 412, machine: "studio-mac", cwd: "~/code/billing" },
  privacy: { rulesets: ["secrets@1"], pii: false },
  data: { tool: "Bash", call_id: "toolu_01abc", ms: 1830, ok: true, input: { command: "ls" }, output: "x" },
});

describe("validate", () => {
  it("accepts the spec's own example", () => {
    expect(validate(good())).toEqual([]);
  });

  it("names the broken field", () => {
    expect(validate({ ...good(), protocol: 2 })).toContain("protocol: not 1");
    expect(validate({ ...good(), id: "not-a-ulid" })).toContain("id: not a ULID");
    expect(validate({ ...good(), time: "2026-09-28T01:03:11Z" })).toContain("time: not an RFC 3339 time with ms and Z");
    expect(validate({ ...good(), type: "Tool.Ended" })).toContain("type: not dotted lowercase");
    expect(validate({ ...good(), arrivedAt: "x" })).toContain("arrivedAt: not an envelope member");
    const { data: _d, ...noData } = good();
    expect(validate(noData)).toContain("data: missing");
  });

  it("checks the tier a type needs and what each tier may carry", () => {
    expect(validate({ ...good(), tier: 0 })).toContain("tier: tool.ended needs tier 1");
    expect(validate({ ...good(), tier: 1 })).toContain("data.input: needs tier 3");
    expect(validate({ ...good(), tier: 1, data: { tool: "Bash", ok: true } })).toEqual([]);
    expect(validate({ ...good(), tier: 2, privacy: { rulesets: [], pii: false } })).toContain(
      "privacy.rulesets: secrets@1 missing above tier 0",
    );
  });

  it("checks per-type data", () => {
    expect(validate({ ...good(), data: { tool: "Bash" } })).toContain("data.ok: missing");
    expect(validate({ ...good(), data: { tool: "bad tool!", ok: true } })).toContain(
      `data.tool: does not match ${/^[A-Za-z0-9_.:-]{1,120}$/}`,
    );
    expect(validate({ ...good(), type: "session.started", data: { source: "boot" } })).toContain(
      "data.source: not one of startup,resume,clear,compact,fork,unknown",
    );
    expect(
      validate({
        ...good(),
        type: "attention.needed",
        data: { attention_id: "a", kind: "permission", message: "x".repeat(201) },
      }),
    ).toContain("data.message: longer than 200");
    expect(
      validate({ ...good(), type: "turn.transcript", data: { turn: 1, user: "u", assistant: "a", at: "soon" } }),
    ).toContain("data.at: not an RFC 3339 time with ms and Z");
    expect(validate({ ...good(), type: "files.changed", data: { paths: "src/a.ts" } })).toContain(
      "data.paths: not an array of <= 500 paths",
    );
  });

  it("keeps an unknown type with a sound envelope", () => {
    expect(validate({ ...good(), type: "vendor.thing", data: { anything: 1 } })).toEqual([]);
  });

  it("checks the session block", () => {
    expect(validate({ ...good(), session: { id: "has space", seq: 0 } })).toContain(
      "session.id: not [A-Za-z0-9._:-]{1,128}",
    );
    expect(validate({ ...good(), session: { id: "a", seq: -1 } })).toContain(
      "session.seq: not an integer from 0 to 2^53 - 1",
    );
    expect(validate({ ...good(), session: { id: "a", seq: 2 ** 53 } })).toContain(
      "session.seq: not an integer from 0 to 2^53 - 1",
    );
    expect(validate({ ...good(), session: { id: "a", seq: Number.MAX_SAFE_INTEGER } })).toEqual([]);
    expect(validate({ ...good(), session: { id: "a", seq: 0, title_source: "guess" } })).toContain(
      "session.title_source: not custom|harness|first-ask",
    );
    expect(validate({ ...good(), session: { id: "a", seq: 0, parent_id: null } })).toEqual([]);
  });
});
