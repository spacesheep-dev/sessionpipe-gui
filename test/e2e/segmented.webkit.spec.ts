// SPDX-License-Identifier: Apache-2.0
// The segmented control once more, in WebKit: the engine of the Mac app's web view, where a
// grid on a fieldset is laid out by other code than Chromium's. The file runs in the desktop
// project; a machine without the browser skips it (npx playwright install webkit).
import { existsSync } from "node:fs";
import { test, webkit } from "@playwright/test";
import { segmentTests } from "./segmented-tests.js";

test.use({ browserName: "webkit" });
test.skip(!existsSync(webkit.executablePath()), "WebKit is not installed");

test.describe("the segmented control in WebKit", () => {
  segmentTests();
});
