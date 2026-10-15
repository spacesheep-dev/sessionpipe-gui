// SPDX-License-Identifier: Apache-2.0
import type { ControlActivity } from "@shared/api";
import { describe, expect, it } from "vitest";
import { KEEP_DELIVERED_MS, KEEP_FAILED_MS, visibleActivity } from "./history";

const T0 = Date.parse("2026-01-10T10:00:00Z");
/** A message queued `agoMs` before T0 and settled (when `outcome` is final) at the same time. */
const msg = (
  id: string,
  agoMs: number,
  outcome?: ControlActivity["outcome"],
  extra: Partial<ControlActivity> = {},
): ControlActivity => {
  const at = new Date(T0 - agoMs).toISOString();
  return {
    id,
    machineId: "m_acme",
    kind: "prompt",
    session: "claude-code:s1",
    at,
    expiresAt: new Date(T0 + 600_000).toISOString(),
    ...(outcome ? { outcome, ackedAt: at } : {}),
    ...extra,
  };
};
const ids = (list: ControlActivity[]) => list.map((a) => a.id);

describe("visibleActivity", () => {
  it("keeps a message in flight whatever its age", () => {
    const { shown, hidden } = visibleActivity([msg("q", 3_600_000), msg("t", 3_600_000, "taken")], [], T0);
    expect(ids(shown)).toEqual(["q", "t"]);
    expect(hidden).toBe(0);
  });

  it("keeps a fresh failure and drops it after KEEP_FAILED_MS", () => {
    const fresh = msg("f1", 13_000, "unsupported");
    const stale = msg("f2", KEEP_FAILED_MS + 1, "unsupported");
    const { shown, hidden } = visibleActivity([fresh, stale], [], T0);
    expect(ids(shown)).toEqual(["f1"]);
    expect(hidden).toBe(1);
  });

  it("keeps a delivery only briefly", () => {
    const { shown } = visibleActivity(
      [msg("d1", KEEP_DELIVERED_MS - 1, "delivered"), msg("d2", KEEP_DELIVERED_MS + 1, "delivered")],
      [],
      T0,
    );
    expect(ids(shown)).toEqual(["d1"]);
  });

  it("drops a failure once a later send got through", () => {
    // Newest first: the delivery came after the failure.
    const { shown } = visibleActivity([msg("d", 5_000, "delivered"), msg("f", 20_000, "refused")], [], T0);
    expect(ids(shown)).toEqual(["d"]);
    // A reply growing counts too; a message merely queued or taken does not settle it yet.
    const answering = msg("p", 5_000, "taken", { reply: "Looking…" });
    expect(ids(visibleActivity([answering, msg("f", 20_000, "refused")], [], T0).shown)).toEqual(["p"]);
    expect(ids(visibleActivity([msg("q", 5_000), msg("f", 20_000, "refused")], [], T0).shown)).toEqual(["q", "f"]);
    expect(ids(visibleActivity([msg("t", 5_000, "taken"), msg("f", 20_000, "refused")], [], T0).shown)).toEqual([
      "t",
      "f",
    ]);
  });

  it("keeps the earlier failure when the taken message fails as well", () => {
    const { shown } = visibleActivity([msg("f2", 5_000, "failed"), msg("f1", 20_000, "refused")], [], T0);
    expect(ids(shown)).toEqual(["f2", "f1"]);
  });

  it("hides what this device dismissed, and counts it", () => {
    const { shown, hidden } = visibleActivity([msg("f", 10_000, "failed"), msg("d", 10_000, "delivered")], ["f"], T0);
    expect(ids(shown)).toEqual(["d"]);
    expect(hidden).toBe(1);
  });
});
