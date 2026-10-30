// SPDX-License-Identifier: Apache-2.0
// A shell command as the approval strip reads it: a chain (`a && b || c; d`) one step per
// line, so a long command is read before Allow instead of wrapping mid-token. Only the top
// level splits; anything quoted, substituted or grouped stays whole, and a command this
// reading cannot follow (an open quote, a heredoc) comes back as it came.

/** The steps of a chained command: split at the top level on `&&`, `||`, `;` and a
 *  newline, each step after the first led by its operator ("&& npm test"); a pipeline is
 *  one step. `[cmd]` when the quotes or brackets don't balance or there is a heredoc. */
export function splitShellCommand(cmd: string): string[] {
  if (cmd.includes("<<")) return [cmd];
  const out: string[] = [];
  // What is open: ' and " quotes, ` backticks, ( for $( … ) and ( … ), { for ${ … } and { … }.
  const open: string[] = [];
  let seg = "";
  let op = "";
  const cut = (next: string) => {
    // A line continuation before the operator is the line break it was, not text.
    const text = seg.replace(/\\\s*$/, "").trim();
    if (text) out.push(op ? `${op} ${text}` : text);
    // An operator at the end of a line leads the next line's step.
    if (text || next) op = next;
    seg = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const top = open[open.length - 1];
    if (top === "'") {
      if (c === "'") open.pop();
      seg += c;
      continue;
    }
    if (c === "\\") {
      seg += c + (cmd[i + 1] ?? "");
      i++;
      continue;
    }
    if (top === '"') {
      if (c === '"') open.pop();
      else if (c === "`") open.push("`");
      else if (c === "$" && (cmd[i + 1] === "(" || cmd[i + 1] === "{")) {
        open.push(cmd[i + 1]!);
        seg += c + cmd[i + 1];
        i++;
        continue;
      }
      seg += c;
      continue;
    }
    if (c === "'" || c === '"') open.push(c);
    else if (c === "`") top === "`" ? open.pop() : open.push("`");
    else if (c === "(" || c === "{") open.push(c);
    else if (c === ")" || c === "}") {
      if (top !== (c === ")" ? "(" : "{")) return [cmd];
      open.pop();
    } else if (!top) {
      const two = cmd.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        cut(two);
        i++;
        continue;
      }
      if (c === ";" || c === "\n") {
        cut(c === ";" ? ";" : "");
        continue;
      }
    }
    seg += c;
  }
  if (open.length) return [cmd];
  cut("");
  return out.length ? out : [cmd];
}

/** The lines of the strip's command block, or null where the command reads best inline
 *  as today ("Allow Bash to run `ls -la`?"): a block for a chain of two or more steps
 *  longer than 60 characters, or for any command with a line break. */
export function shellLines(cmd: string): string[] | null {
  const lines = splitShellCommand(cmd);
  return (lines.length >= 2 && cmd.length > 60) || cmd.includes("\n") ? lines : null;
}

/** The call's own command, when it is the command the prompt names. A Claude Code prompt
 *  carries no call id, so the call read for it is the newest of its tool, and a subagent's
 *  can be newer: where the message (`said`) is a command, the call's must be that command,
 *  or, when the message was cut (`cut`: the server keeps 200 characters), start with what
 *  is left of it; otherwise the strip stays on the message. A prefix alone would take a
 *  subagent's `npm test -- -u && git push` for a prompt that asked about `npm test`. */
export function askedCommand(
  input: Record<string, unknown> | undefined,
  said: string | undefined,
  cut = false,
): string | undefined {
  const cmd = input?.command;
  if (typeof cmd !== "string" || !cmd) return undefined;
  if (!said) return cmd;
  const asked = said.replace(/…$/, "").trim();
  const own = cmd.trim();
  return (cut ? own.startsWith(asked) : own === asked) ? cmd : undefined;
}
