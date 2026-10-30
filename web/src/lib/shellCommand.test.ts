// SPDX-License-Identifier: Apache-2.0
// A chained command one step per line: only the top level splits.
import { describe, expect, it } from "vitest";
import { askedCommand, shellLines, splitShellCommand } from "./shellCommand";

describe("splitShellCommand", () => {
  it("splits on &&, || and ;, each step after the first led by its operator", () => {
    expect(splitShellCommand("a && b || c; d")).toEqual(["a", "&& b", "|| c", "; d"]);
    expect(splitShellCommand("npm run build && npm test -- bm25 && npm run deploy -- --target staging")).toEqual([
      "npm run build",
      "&& npm test -- bm25",
      "&& npm run deploy -- --target staging",
    ]);
  });

  it("keeps quotes, substitutions and groups whole", () => {
    expect(splitShellCommand('echo "x && y" && z')).toEqual(['echo "x && y"', "&& z"]);
    expect(splitShellCommand("echo 'x; y' ; z")).toEqual(["echo 'x; y'", "; z"]);
    expect(splitShellCommand('echo "a \\" && b" && c')).toEqual(['echo "a \\" && b"', "&& c"]);
    expect(splitShellCommand("echo $(a && b) && c")).toEqual(["echo $(a && b)", "&& c"]);
    expect(splitShellCommand("echo `a && b` && c")).toEqual(["echo `a && b`", "&& c"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template
    const param = "echo ${A:-x;y}";
    expect(splitShellCommand(`${param} && (cd b && make) && { c; d; }`)).toEqual([
      param,
      "&& (cd b && make)",
      "&& { c; d; }",
    ]);
    expect(splitShellCommand('echo "$(a && b)" && c')).toEqual(['echo "$(a && b)"', "&& c"]);
  });

  it("never splits a pipeline", () => {
    expect(splitShellCommand("a | b")).toEqual(["a | b"]);
    expect(splitShellCommand("a | b && c |& d")).toEqual(["a | b", "&& c |& d"]);
  });

  it("returns the command as it came when it can't follow it", () => {
    for (const cmd of ['echo "a && b', "echo 'a && b", "echo $(a && b", "a ) && b", "cat <<EOF && x\nhi\nEOF"])
      expect(splitShellCommand(cmd)).toEqual([cmd]);
  });

  it("splits on a line break, which adds no operator", () => {
    expect(splitShellCommand("cd web\nnpm ci\n\nnpm test")).toEqual(["cd web", "npm ci", "npm test"]);
    expect(splitShellCommand("a &&\n  b\nc")).toEqual(["a", "&& b", "c"]);
    expect(splitShellCommand("a \\\n  && b")).toEqual(["a", "&& b"]);
  });

  it("trims each step and drops the empty ones", () => {
    expect(splitShellCommand("  a ;  ; b;  ")).toEqual(["a", "; b"]);
    expect(splitShellCommand("ls -la")).toEqual(["ls -la"]);
  });
});

describe("shellLines", () => {
  it("is a block for a long chain or any line break, and inline otherwise", () => {
    expect(shellLines("npm run build && npm test -- bm25 && npm run deploy -- --target staging")).toHaveLength(3);
    expect(shellLines("ls -la")).toBeNull();
    expect(shellLines("cd web && npm test")).toBeNull();
    expect(shellLines("docker run \\\n  --rm img")).toEqual(["docker run \\\n  --rm img"]);
  });
});

describe("askedCommand", () => {
  it("is the call's command when it is the command the prompt names, whole or cut", () => {
    const input = { command: "npm run build && npm test -- bm25 && npm run deploy -- --target staging" };
    expect(askedCommand(input, input.command)).toBe(input.command);
    expect(askedCommand(input, ` ${input.command}\n`)).toBe(input.command);
    // The message was cut (the server keeps 200 characters): what is left of it is a prefix.
    expect(askedCommand(input, "npm run build && npm test", true)).toBe(input.command);
    expect(askedCommand(input, `${input.command.slice(0, 30)}…`, true)).toBe(input.command);
    expect(askedCommand(input, undefined)).toBe(input.command);
    expect(askedCommand({ file_path: "a.ts" }, undefined)).toBeUndefined();
    expect(askedCommand(undefined, "ls")).toBeUndefined();
  });

  it("leaves a subagent's newer call alone: a whole message is matched whole, not as a prefix", () => {
    // The prompt asks about `npm test`; a subagent's Bash call is the newest unended one.
    const sub = { command: "npm test -- -u && git push --force" };
    expect(askedCommand(sub, "npm test")).toBeUndefined();
    expect(askedCommand(sub, "npm test", true)).toBe(sub.command);
    expect(askedCommand({ command: "ls -la" }, "rm -rf build")).toBeUndefined();
    expect(askedCommand({ command: "ls -la" }, "rm -rf build", true)).toBeUndefined();
  });
});
