// SPDX-License-Identifier: Apache-2.0
// The page on an account against a real spacesheep running on this machine (real.spec.ts):
// not part of the suite. It needs a local spacesheep, an app key of its account, a computer
// paired there and a device key that computer trusts, all named in the environment:
//   ACCOUNT_REAL_ORIGIN=http://localhost:8881 ACCOUNT_REAL_KEY=<json {key,email}> \
//   ACCOUNT_REAL_DEVICE=<json {key,jwk}> ACCOUNT_REAL_SHOTS=<folder> \
//   npx playwright test -c test/account/real.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /real\.spec\.ts/,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: { locale: "en-US", timezoneId: "UTC" },
});
