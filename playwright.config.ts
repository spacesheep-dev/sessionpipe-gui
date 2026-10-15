// SPDX-License-Identifier: Apache-2.0
// End-to-end suite: a built server (node scripts/build.mjs + vite build) started with
// demo mode on a fresh state dir, driven through Chromium on a desktop and a phone.
// Port 7311 is ours alone; 7373 may be a person's running instance and is never used.
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// SPGUI_E2E_PORT / SPGUI_E2E_TLS_PORT move both when another run holds the defaults.
export const E2E_PORT = Number(process.env.SPGUI_E2E_PORT ?? 7311);
export const E2E_BASE = `http://127.0.0.1:${E2E_PORT}`;
/** A second instance in TLS mode (dual-protocol port, rp id localhost) for tls.spec.ts. */
export const E2E_TLS_PORT = Number(process.env.SPGUI_E2E_TLS_PORT ?? 7312);
export const E2E_TLS_BASE = `https://localhost:${E2E_TLS_PORT}`;

/** Every spec but setup.spec.ts starts as a device that has seen the setup page, so the
 *  first-run redirect to /setup never meets a board test. */
export const SETUP_SEEN_KEY = "sessionpipe-gui.setup.seen";
/** The suite describes the full interface; Simple mode (the default for a device that has not
 *  chosen) is exercised by settings.spec.ts on purpose. */
export const SETTINGS_KEY = "sessionpipe-gui.settings";
const seenSetup = (origin: string) => ({
  origin,
  localStorage: [
    { name: SETUP_SEEN_KEY, value: "1" },
    { name: SETTINGS_KEY, value: JSON.stringify({ mode: "advanced" }) },
  ],
});

const stateDir = path.join(os.tmpdir(), `spgui-e2e-${Date.now()}-${process.pid}`);
process.env.SPGUI_E2E_STATE = stateDir;
const tlsStateDir = `${stateDir}-tls`;
process.env.SPGUI_E2E_TLS_STATE = tlsStateDir;

export default defineConfig({
  testDir: "test/e2e",
  globalTeardown: "./test/e2e/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: process.env.CI ? 2 : 4,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  outputDir: "test-results",
  use: {
    baseURL: E2E_BASE,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    locale: "en-US",
    timezoneId: "UTC",
    storageState: {
      cookies: [],
      origins: [
        seenSetup(E2E_BASE),
        seenSetup(`http://localhost:${E2E_PORT}`),
        seenSetup(E2E_TLS_BASE),
        seenSetup(`http://127.0.0.1:${E2E_TLS_PORT}`),
      ],
    },
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "phone",
      testMatch: /(mobile|screenshots|split|select)\.spec\.ts/,
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        defaultBrowserType: "chromium",
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: [
    {
      // serve.mjs installs the fixture themes with the CLI, then runs dist/cli.js with these args.
      // --test-door (loopback only) lets mobile.spec.ts pair a machine and ack a send.
      command: `node test/e2e/serve.mjs --port ${E2E_PORT} --state "${stateDir}" --no-outbox --demo --speed 20 --test-door --quiet`,
      url: `${E2E_BASE}/api/ui/info`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      // TLS mode on its own port and state dir; the readiness check goes over plain http,
      // which the same port also answers. --rp-id localhost because the test browser
      // cannot resolve this machine's .local name. Needs openssl (tls.spec.ts skips if not).
      command: `node dist/cli.js --port ${E2E_TLS_PORT} --state "${tlsStateDir}" --no-outbox --tls --rp-id localhost --test-door --quiet`,
      url: `http://127.0.0.1:${E2E_TLS_PORT}/api/ui/info`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
