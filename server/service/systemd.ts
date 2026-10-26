// SPDX-License-Identifier: Apache-2.0
// Owned by: packaging. The Linux `systemd --user` unit for the receiver.
import path from "node:path";

export interface UnitSpec {
  description: string;
  argv: string[];
  env: Record<string, string>;
  logPath: string;
  workingDirectory: string;
}

export const unitName = (label: string): string => `${label}.service`;
export const unitPath = (home: string, label: string): string =>
  path.join(home, ".config", "systemd", "user", unitName(label));

/** systemd's quoting: one double-quoted word, with \ and " escaped and % doubled. */
const q = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnit(s: UnitSpec): string {
  const env = Object.entries(s.env)
    .map(([k, v]) => `Environment=${q(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=${s.description}
After=network.target

[Service]
ExecStart=${s.argv.map(q).join(" ")}
WorkingDirectory=${q(s.workingDirectory)}
${env}
Restart=always
RestartSec=10
StandardOutput=append:${s.logPath}
StandardError=append:${s.logPath}

[Install]
WantedBy=default.target
`;
}

/** ExecStart's words read back from a unit this module wrote. */
export function unitArgv(text: string): string[] {
  const line = /^ExecStart=(.*)$/m.exec(text)?.[1] ?? "";
  return (line.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map((w) =>
    w.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1").replace(/%%/g, "%"),
  );
}

/** `systemctl --user show <unit> --property=ActiveState,MainPID`. */
export function parseSystemctlShow(out: string): { running: boolean; pid?: number } {
  const pid = Number(/^MainPID=(\d+)/m.exec(out)?.[1] ?? 0);
  return { running: /^ActiveState=active/m.test(out), ...(pid ? { pid } : {}) };
}
