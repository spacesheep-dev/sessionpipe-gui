// SPDX-License-Identifier: Apache-2.0
// After the run: remove the fresh state dir the demo server wrote to (playwright.config.ts
// names it and hands it over in SPGUI_E2E_STATE).
import { rmSync } from "node:fs";

export default function globalTeardown(): void {
  for (const dir of [process.env.SPGUI_E2E_STATE, process.env.SPGUI_E2E_TLS_STATE]) {
    if (!dir?.includes("spgui-e2e-")) continue;
    // The search indexer is a child of the test server and may still be writing here as the
    // run ends (ENOTEMPTY): retry, and never fail the run over a temp folder.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`e2e teardown: left ${dir} (${(err as Error).message})`);
    }
  }
}
