// SPDX-License-Identifier: Apache-2.0
// The device-key e2e (test/e2e/device-*.spec.ts) on its own: against a demo receiver
// already running with the test door, on the identity role's port (never :7373):
//   node dist/cli.js --demo --test-door --no-outbox --host 127.0.0.1 --quiet --port 7819 --state <scratch>
//   SPGUI_E2E_TLS_PORT=7819 npx playwright test --config test/e2e/control-device.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /device-.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "../../test-results/device",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 860 },
    locale: "en-US",
    timezoneId: "UTC",
    screenshot: "only-on-failure",
  },
});
