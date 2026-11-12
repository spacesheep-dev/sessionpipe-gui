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
