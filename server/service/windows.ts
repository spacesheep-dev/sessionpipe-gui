// SPDX-License-Identifier: Apache-2.0
// Owned by: packaging. The Windows per-user scheduled task for the receiver: started at
// logon for this user, no admin needed. Plain `schtasks /Create /SC ONLOGON` is refused to a
// non-admin; `/Create /XML` with a logon trigger naming this user is not.
//
// node.exe is a console program, so a task that runs it opens a console window at every
// logon. The action runs it under `conhost.exe --headless` (no window), through `cmd /c` so
// its output is appended to the log file, as launchd's StandardOutPath and systemd's
// `append:` do.
//
// conhost splits the rest of its command line into arguments and joins them again for cmd,
// quoting each one that holds a space and escaping any quote inside one as \" (which cmd
// doesn't read). So the line is plain words, each path quoted on its own, and it starts with
// the redirect: cmd /c drops the first and last quote of a line that starts with one.

export interface TaskSpec {
  description: string;
  /** DOMAIN\user: whose logon starts it, and who it runs as. */
  user: string;
  argv: string[];
  logPath: string;
  workingDirectory: string;
}

export const taskName = (label: string): string => `\\sessionpipe\\${label}`;

const xml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unxml = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** A word the task's command line can't carry as it is: a quote (conhost escapes it), a
 *  character cmd reads in an unquoted word (conhost quotes only words with a space), or a %
 *  (Task Scheduler expands %NAME%). */
export function unsafeWord(words: string[]): string | undefined {
  return words.find((w) => w === "" || /["&|<>^%]/.test(w));
}

const word = (s: string): string => (/\s/.test(s) ? `"${s}"` : s);

/** `--headless cmd.exe /d /c >> "<log>" 2>&1 <argv>`: what conhost runs, no window. */
export function taskArguments(s: Pick<TaskSpec, "argv" | "logPath">): string {
  return `--headless cmd.exe /d /c >> ${word(s.logPath)} 2>&1 ${s.argv.map(word).join(" ")}`;
}

/** The task definition `schtasks /Create /XML` takes (written UTF-16 with a byte-order mark). */
export function taskXml(s: TaskSpec): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(s.description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(s.user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(s.user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>${xml(taskArguments(s))}</Arguments>
      <WorkingDirectory>${xml(s.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

const words = (line: string): string[] =>
  [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]!));

/** The receiver's argv read back from `schtasks /Query /XML`: ours unwrapped from conhost,
 *  cmd and the log redirect; any other task's action as its program and words. */
export function taskArgv(text: string): string[] {
  const command = unxml(/<Command>([^<]*)<\/Command>/.exec(text)?.[1] ?? "").trim();
  const args = unxml(/<Arguments>([^<]*)<\/Arguments>/.exec(text)?.[1] ?? "").trim();
  const w = words(args);
  const ours = w[0] === "--headless" && /^cmd(\.exe)?$/i.test(w[1] ?? "") && w[2] === "/d" && w[3] === "/c";
  if (/(^|[\\/])conhost(\.exe)?$/i.test(command) && ours && w[4] === ">>" && w[6] === "2>&1") return w.slice(7);
  return command ? [command.replace(/^"|"$/g, ""), ...words(args)] : [];
}

// Reading the task back goes through PowerShell, not `schtasks /Query`: schtasks answers in
// the console's code page (a state dir under a non-ASCII folder comes back with "?" in it)
// and in the system's language (the status column says "Running" only in English). The
// scripts print a number at most; text goes to a file as UTF-8 (`Out-File`), so no code page
// touches it. Cmdlets only, no .NET method calls: those are refused where PowerShell is
// held to its constrained language mode.

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Task Scheduler's TASK_STATE_RUNNING: a number, the same in every language. */
export const TASK_RUNNING = 4;

/** `powershell -Command <this>` prints "none" when no task has the label; else it writes the
 *  task's definition (what `schtasks /Query /XML` shows) to `file` and prints its state as a
 *  number. The folder is listed and the name compared, so a `*` or `[` in a label is no
 *  pattern; only "no such folder" counts as no task, any other error fails the script. */
export function taskQueryScript(label: string, file: string): string {
  return [
    "$ErrorActionPreference='Stop'",
    `try{$t=Get-ScheduledTask -TaskPath '\\sessionpipe\\'|Where-Object{$_.TaskName -eq ${psQuote(label)}}}catch{if($_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*'){throw};$t=$null}`,
    "if(-not $t){'none';exit 0}",
    `$t|Export-ScheduledTask|Out-File -Encoding utf8 -LiteralPath ${psQuote(file)}`,
    "[int]$t.State",
  ].join(";");
}

/** What taskQueryScript printed: the state, or null when no task has the label. */
export function parseTaskQuery(out: string): number | null {
  const answer = out.trim();
  if (answer === "none") return null;
  if (!/^\d+$/.test(answer)) throw new Error(`unexpected answer: ${answer.slice(0, 80) || "nothing"}`);
  return Number(answer);
}

/** `powershell -Command <this>` writes the command line of the process with that pid to
 *  `file`; nothing when there is no such process, or its command line can't be read. */
export function processQueryScript(pid: number, file: string): string {
  return `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}';if($p -and $p.CommandLine){$p.CommandLine|Out-File -Encoding utf8 -LiteralPath ${psQuote(file)}}`;
}

/** Is this command line the receiver a task of ours started: the same cli, on the same
 *  state dir? Windows reuses pids, so the pid in a run.json left by a killed receiver can be
 *  any program's by now. Paths compare as Windows compares them, whatever the case. */
export function isReceiverCommandLine(line: string, cli: string, state: string): boolean {
  const w = words(line).map((x) => x.toLowerCase());
  const i = w.indexOf("--state");
  return cli !== "" && w.includes(cli.toLowerCase()) && i >= 0 && w[i + 1] === state.toLowerCase();
}
