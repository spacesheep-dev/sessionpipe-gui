// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The same `@shared` the web build has, so a web test may reach a module that uses it.
  resolve: { alias: { "@shared": path.resolve(__dirname, "shared") } },
  test: {
    include: ["test/**/*.test.ts", "server/**/*.test.ts", "shared/**/*.test.ts", "web/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
  },
});
