// SPDX-License-Identifier: Apache-2.0
// Antigravity local usage poller: parses `agy -p "/usage" --output-format json` and feeds LimitsCore.
import { describe, expect, it, vi } from "vitest";
import type { StreamMessage } from "../../shared/api.js";
import { LimitsCore } from "../ui/limitsCore.js";
import { parseAgyUsage, startAntigravityUsageSource } from "./antigravity.js";

const SAMPLE_OUTPUT = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t99%\t2026-12-02T16:19:53Z\n",
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.9944779872894287,
              reset_time: "2026-12-02T16:19:53Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.85,
              reset_time: "2026-11-25T21:19:53Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0,
              reset_time: "2026-11-25T21:00:00Z",
            },
          ],
        },
      ],
    },
  },
});

const memoryKeep = () => ({
  load: () => undefined,
  save: () => {},
});

describe("parseAgyUsage", () => {
  it("parses groups and buckets, drops 1970 epoch sentinels, and orders 5h before weekly", () => {
    const parsed = parseAgyUsage(SAMPLE_OUTPUT);
    expect(parsed).toEqual({
      windows: [
        { id: "gemini_5h", usedPercent: 15, windowMinutes: 300, resetsAt: "2026-11-25T21:19:53.000Z" },
        { id: "gemini_weekly", usedPercent: 0.6, windowMinutes: 10_080, resetsAt: "2026-12-02T16:19:53.000Z" },
        { id: "3p_5h", usedPercent: 100, windowMinutes: 300, resetsAt: "2026-11-25T21:00:00.000Z" },
        { id: "3p_weekly", usedPercent: 0, windowMinutes: 10_080 },
      ],
    });
  });

  it("extracts optional email/plan when provided", () => {
    const out = JSON.stringify({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          email: "dev@example.com",
          tier: "ultra",
          groups: [
            {
              name: "Argon",
              buckets: [{ id: "argon-7d", window: "7d", remaining_fraction: 0.42, reset_time: "2026-12-01T00:00:00Z" }],
            },
          ],
        },
      },
    });
    expect(parseAgyUsage(out)).toEqual({
      account: "dev@example.com",
      plan: "ultra",
      windows: [{ id: "argon_7d", usedPercent: 58, windowMinutes: 10_080, resetsAt: "2026-12-01T00:00:00.000Z" }],
    });
  });

  it("returns null for malformed JSON, failed status, or empty groups", () => {
    expect(parseAgyUsage("not json")).toBeNull();
    expect(parseAgyUsage(JSON.stringify({ status: "ERROR", command: { data: { groups: [] } } }))).toBeNull();
    expect(parseAgyUsage(JSON.stringify({ status: "SUCCESS", command: { data: { groups: [] } } }))).toBeNull();
  });
});

describe("startAntigravityUsageSource", () => {
  it("feeds LimitsCore on boot, broadcasts frames, and deduplicates concurrent refreshes", async () => {
    const limits = new LimitsCore(memoryKeep());
    const frames: StreamMessage[] = [];
    limits.subscribe((m) => frames.push(m));

    let resolveRun: ((v: string) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolveRun = r;
        }),
    );
    const src = startAntigravityUsageSource(limits, {
      machine: "lab-mac",
      bin: "/fake/agy",
      intervalMs: 60_000,
      run,
      now: () => Date.UTC(2026, 10, 25, 17, 0, 0),
      quiet: true,
    });

    // Boot triggered one poll; a concurrent refresh shares the same in-flight promise.
    const p1 = src.refresh();
    const p2 = src.refresh();
    expect(run).toHaveBeenCalledTimes(1);
    resolveRun?.(SAMPLE_OUTPUT);
    expect(await Promise.all([p1, p2])).toEqual([true, true]);

    const list = limits.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      key: "antigravity m:lab-mac",
      harness: "antigravity",
      machine: "lab-mac",
      machines: ["lab-mac"],
    });
    expect(list[0]!.windows.map((w) => w.id)).toEqual(["gemini_5h", "gemini_weekly", "3p_5h", "3p_weekly"]);
    expect(frames.some((f) => f.kind === "limits")).toBe(true);
    src.stop();
  });

  it("fails quietly when agy exits with an error", async () => {
    const limits = new LimitsCore(memoryKeep());
    const src = startAntigravityUsageSource(limits, {
      machine: "lab-mac",
      bin: "/fake/agy",
      intervalMs: 60_000,
      run: async () => {
        throw new Error("not signed in");
      },
      quiet: true,
    });
    expect(await src.refresh()).toBe(false);
    expect(limits.list()).toEqual([]);
    src.stop();
  });
});
