// SPDX-License-Identifier: Apache-2.0
// The segmented control in Chromium (segmented-tests.ts has the tests); in WebKit, the Mac
// app's engine, segmented.webkit.spec.ts declares them again.
import { test } from "@playwright/test";
import { segmentTests } from "./segmented-tests.js";

test.describe("the segmented control", () => {
  segmentTests();
});
