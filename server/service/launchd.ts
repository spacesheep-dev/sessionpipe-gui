// SPDX-License-Identifier: Apache-2.0
// Owned by: packaging. The macOS LaunchAgent for the receiver: the plist, and what
// `launchctl print` says about it.
import path from "node:path";

export interface LaunchAgentSpec {
  label: string;
  /** Absolute: node, then the CLI, then the receiver's options. */
  argv: string[];
  env: Record<string, string>;
  /** stdout and stderr both go here. */
  logPath: string;
  workingDirectory: string;
}

export const launchAgentPath = (home: string, label: string): string =>
  path.join(home, "Library", "LaunchAgents", `${label}.plist`);

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The plist. KeepAlive restarts a crashed receiver; ThrottleInterval keeps a receiver
 *  that can't start (a taken port) from restarting more than once every 10 s. */
export function launchAgentPlist(s: LaunchAgentSpec): string {
  const str = (v: string) => `<string>${esc(v)}</string>`;
  const env = Object.entries(s.env)
    .map(([k, v]) => `\t\t<key>${esc(k)}</key>\n\t\t${str(v)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t${str(s.label)}
\t<key>ProgramArguments</key>
\t<array>
${s.argv.map((a) => `\t\t${str(a)}`).join("\n")}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>WorkingDirectory</key>
\t${str(s.workingDirectory)}
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t${str(s.logPath)}
\t<key>StandardErrorPath</key>
\t${str(s.logPath)}
</dict>
</plist>
`;
}

/** ProgramArguments read back from a plist this module wrote. */
export function plistArgv(text: string): string[] {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (!m) return [];
  return [...m[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((x) =>
    x[1]!
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"),
  );
}

/** `launchctl print gui/<uid>/<label>`: running or not, and the pid. */
export function parseLaunchctlPrint(out: string): { running: boolean; pid?: number; lastExit?: number } {
  const pid = /^\s*pid = (\d+)/m.exec(out)?.[1];
  const lastExit = /^\s*last exit code = (-?\d+)/m.exec(out)?.[1];
  return {
    running: /^\s*state = running/m.test(out),
    ...(pid ? { pid: Number(pid) } : {}),
    ...(lastExit !== undefined ? { lastExit: Number(lastExit) } : {}),
  };
}
