// SPDX-License-Identifier: Apache-2.0
// The copies in core-copy.ts are sessionpipe-core's own, for the version this package pins.
import * as core from "sessionpipe-core";
import { expect, test } from "vitest";
import { isUlid, TYPE_TIER } from "./core-copy.js";

test("TYPE_TIER is the core's", () => {
  expect(TYPE_TIER).toEqual(core.TYPE_TIER);
});

test("isUlid answers as the core's", () => {
  const samples = [
    core.ulid(),
    core.ulid(0),
    "01JC0000000000000000000000",
    "01jc0000000000000000000000",
    "01JC000000000000000000000",
    "01JC00000000000000000000000",
    "01JC000000000000000000000I",
    "01JC000000000000000000000L",
    "01JC000000000000000000000O",
    "01JC000000000000000000000U",
    "",
    " 01JC0000000000000000000000",
    "01JC0000000000000000000000\n",
  ];
  for (const s of samples) expect(isUlid(s), s).toBe(core.isUlid(s));
});

test("isUlid takes the same characters as the core's, at the first place, the last and between, and the same lengths", () => {
  const fill = "0".repeat(26);
  // Every character up to U+00FF, and a few past it, in each place that could differ.
  const chars: string[] = [];
  for (let c = 0; c <= 0xff; c++) chars.push(String.fromCharCode(c));
  chars.push("\u0130", "\u212a", "\uff10", "\ud83d", "😀");
  let accepted = 0;
  for (const ch of chars)
    for (const at of [0, 1, 13, 25]) {
      const s = fill.slice(0, at) + ch + fill.slice(at + 1);
      expect(isUlid(s), JSON.stringify(s)).toBe(core.isUlid(s));
      if (core.isUlid(s)) accepted++;
    }
  // Crockford's 32 characters in each of the 4 places, nothing else.
  expect(accepted).toBe(32 * 4);
  for (let n = 0; n <= 30; n++) expect(isUlid("7".repeat(n)), String(n)).toBe(core.isUlid("7".repeat(n)));
  for (const first of ["7", "8", "Z"]) {
    const s = first + "Z".repeat(25);
    expect(isUlid(s), s).toBe(core.isUlid(s));
  }
});
