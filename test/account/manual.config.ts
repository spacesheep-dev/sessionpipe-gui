// SPDX-License-Identifier: Apache-2.0
// The two runs of the page on an account that are not part of the suite: each needs
// something of this machine named in the environment, and is skipped without it.
//
// real.spec.ts: against a real spacesheep running on this machine (loopback only), with an
// app key of its account, a computer paired there and a device key that computer trusts:
//   ACCOUNT_REAL_ORIGIN=http://localhost:8881 ACCOUNT_REAL_KEY=<json {key,email}> \
//   ACCOUNT_REAL_DEVICE=<json {key,jwk}> ACCOUNT_REAL_SHOTS=<folder> \
//   npx playwright test -c test/account/manual.config.ts real
//
// bench.spec.ts: a first connect and a restart against a relay that holds a file of
// events, on a slowed CPU; it prints its numbers:
//   ACCOUNT_BENCH_EVENTS=<json array of wire events> [ACCOUNT_BENCH_THROTTLE=4] \
//   [ACCOUNT_BENCH_LATENCY_MS=150] npx playwright test -c test/account/manual.config.ts bench
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /(real|bench)\.spec\.ts/,
  workers: 1,
  retries: 0,
  timeout: 900_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: { locale: "en-US", timezoneId: "UTC" },
});
