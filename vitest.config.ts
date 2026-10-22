// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web app's alias, so a web unit test can import what the page imports.
  resolve: { alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) } },
  test: {
    include: ["test/**/*.test.ts", "server/**/*.test.ts", "shared/**/*.test.ts", "web/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
  },
});
