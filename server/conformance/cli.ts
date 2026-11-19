// SPDX-License-Identifier: Apache-2.0
// Owned by: control. `sessionpipe-gui-conformance <receiver url> --fixtures <dir> [--token T]
// [--no-test-door] [--only <substring>]` runs the delivery scenarios of spec/HTTP.md §7
// against a receiver. The fixtures are sessionpipe's (conformance/delivery); without
// --fixtures they are $SESSIONPIPE_REPO/conformance/delivery, else this checkout's copy at
// the pinned version (test/conformance/delivery), else ../sessionpipe's.
import { existsSync } from "node:fs";
import path from "node:path";
import { runDelivery } from "./runner.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const url = args.find((a) => /^https?:\/\//.test(a));
if (!url || args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "usage: sessionpipe-gui-conformance <receiver url> [--fixtures <dir>] [--token <sink token>] [--no-test-door] [--only <text>]\n",
  );
  process.exit(2);
}
const vendored = path.resolve("test/conformance/delivery");
const fixtures =
  flag("--fixtures") ??
  (process.env.SESSIONPIPE_REPO
    ? path.join(process.env.SESSIONPIPE_REPO, "conformance/delivery")
    : existsSync(vendored)
      ? vendored
      : path.resolve("../sessionpipe/conformance/delivery"));
if (!existsSync(fixtures)) {
  process.stderr.write(`no fixtures at ${fixtures}: pass --fixtures <sessionpipe>/conformance/delivery\n`);
  process.exit(2);
}
const host = new URL(url).hostname;
const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
const only = flag("--only");
const report = await runDelivery(fixtures, {
  url,
  token: flag("--token") ?? process.env.SESSIONPIPE_SINK_TOKEN,
  testDoor: !args.includes("--no-test-door") && loopback,
  only: only ? (f) => f.includes(only) : undefined,
});
process.stdout.write(`${report.table}\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped\n`);
process.exit(report.failed ? 1 : 0);
