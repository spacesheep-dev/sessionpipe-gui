// SPDX-License-Identifier: Apache-2.0
// Select option filtering: matches label, hint, and detail (e.g. parent folder paths).
import "../native/test-env";
import { describe, expect, it } from "vitest";
import { filterOptions, type SelectOption } from "./Select";

describe("filterOptions", () => {
  const options: SelectOption<string>[] = [
    {
      value: "/Users/alice/.bb-machines/startrise.example/checkouts/sessionpipe",
      label: "sessionpipe",
      hint: "acme/sessionpipe",
      detail: "~/.bb-machines/startrise.example/checkouts",
      detailMono: true,
    },
    {
      value: "/Users/alice/code/billing",
      label: "billing",
      hint: "acme/billing",
      detail: "~/code",
      detailMono: true,
    },
    {
      value: "/srv/infra",
      label: "infra",
      detail: "/srv",
      detailMono: true,
    },
  ];

  it("returns all options when query is empty or whitespace", () => {
    expect(filterOptions(options, "")).toEqual(options);
    expect(filterOptions(options, "   ")).toEqual(options);
  });

  it("matches by label, hint, or detail case-insensitively", () => {
    expect(filterOptions(options, "SESSION").map((o) => o.label)).toEqual(["sessionpipe"]);
    expect(filterOptions(options, "acme/bill").map((o) => o.label)).toEqual(["billing"]);
    expect(filterOptions(options, "checkouts").map((o) => o.label)).toEqual(["sessionpipe"]);
    expect(filterOptions(options, "STARTRISE").map((o) => o.label)).toEqual(["sessionpipe"]);
    expect(filterOptions(options, "/srv").map((o) => o.label)).toEqual(["infra"]);
  });

  it("returns empty list when nothing matches", () => {
    expect(filterOptions(options, "nonexistent")).toEqual([]);
  });
});
