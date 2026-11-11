// SPDX-License-Identifier: Apache-2.0
// Boots the whole app in-process (createApp) with the test door and runs every delivery
// fixture of the pinned sessionpipe against it: the copy in test/conformance/delivery, or
// `$SESSIONPIPE_REPO/conformance/delivery` when that names a checkout (test/conformance.ts).
// Never skipped: no fixtures is a failure.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ControlActivity, type MachineControl, ROUTES } from "../../shared/api.js";
import { fixtures } from "../../test/conformance.js";
import { type App, type AppOptions, createApp } from "../app.js";
import { type RunReport, runDelivery } from "./runner.js";

const { dir, files } = fixtures("delivery");

describe("conformance/delivery against createApp", () => {
  let app: App;
  let stateDir: string;
  let report: RunReport;

  beforeAll(async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "spgui-conformance-"));
    const opts: AppOptions & { testDoor: boolean } = {
      port: 0,
      host: "127.0.0.1",
      stateDir,
      testDoor: true,
      outbox: false,
      demo: false,
      quiet: true,
    };
    app = await createApp(opts);
    const cfg = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8")) as { sinkToken: string };
    report = await runDelivery(dir, { url: app.url, token: cfg.sinkToken, testDoor: true });
    console.log(`\n${report.table}\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped\n`);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  for (const f of files)
    it(f, () => {
      const r = report.results.find((x) => x.file === f);
      expect(r, "no result").toBeDefined();
      // The one way out is the fixture's own: `skip_when` names the receivers it does not
      // apply to (04-tier asks for a tier above the receiver's highest; this one takes
      // tier 3, the last there is, and receiver.test.ts holds its 403 for a tier above it).
      // A scenario this receiver could not run (no test door, a capability it does not
      // declare) is a failure, not a skip.
      if (r!.skipped) expect(r!.skipped).toMatch(/^skip_when /);
      else expect(r!.ok, r!.why).toBe(true);
    });

  it("runs every fixture", () => {
    expect(report.results.map((r) => r.file)).toEqual(files);
  });

  // A scenario holds the receiver to accepting what the machine said; "what the receiver
  // stored is its own to check" (delivery/24). So, of what sessionpipe 0.13 added: the
  // hello's `signed_in` (24), the `inbox` mode of an ack (25) and a copy's `copy_of` (27)
  // are still there when the UI reads them, where they used to be dropped on the way in.
  it("keeps what the 0.13 scenarios said: signed_in, the inbox mode, copy_of", async () => {
    const ui = async <T>(route: string): Promise<T> => (await fetch(`${app.url}${ROUTES.ui.control}${route}`)).json();
    const { machines } = await ui<{ machines: MachineControl[] }>("/machines");
    expect(machines.flatMap((m) => m.accounts ?? []).some((a) => a.signedIn === true)).toBe(true);
    const { activity } = await ui<{ activity: ControlActivity[] }>("/activity?limit=1000");
    expect(activity.some((a) => a.outcome === "delivered" && a.mode === "inbox")).toBe(true);
    const copy = activity.find((a) => a.copyOf);
    expect(copy).toMatchObject({ outcome: "delivered", mode: "fork", copyOf: copy?.session });
    expect(copy?.ackSession).not.toBe(copy?.session);
    expect(copy?.detail).toMatch(/^ran in a copy, because /);
  });
});
