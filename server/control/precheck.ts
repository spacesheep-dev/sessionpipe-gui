// SPDX-License-Identifier: Apache-2.0
// The receiver's second look at a verified command, against what the machine's last hello
// said (CONTROL.md §2, §3.1; STEER-SPEC B.4). The verifier (sessionpipe-core) checks the
// signature and the shape it knows; this checks the fields a `start` may carry beyond it:
// `files` (held here, and only for a machine that said `files: true`), `permission` (one
// of the levels the hello advertises for that harness) and `model` (only where the harness
// takes one). A sender MUST NOT send what a machine did not advertise, because a daemon
// that predates a field ignores it; this is the receiver keeping that rule for everyone.
// The machine checks it all again: it stays the gate.
import {
  type HarnessStartOptions,
  INHERIT_LEVELS,
  type MachineMode,
  START_FILE_MAX_BYTES,
  START_FILES_MAX,
  START_FILES_TOTAL_BYTES,
  START_PERMISSIONS,
  validModel,
} from "../../shared/api.js";
import { type FileStore, MEDIA_TYPE_RE, SHA256_RE } from "./files.js";

export interface PrecheckFacts {
  files?: boolean;
  /** Hello `prompt_files: true` (sessionpipe 0.10): it takes `files` on a `prompt` too. */
  promptFiles?: boolean;
  start?: Record<string, HarnessStartOptions>;
  mode?: MachineMode;
}

export interface Refusal {
  code: string;
  why: string;
}

const LEVEL_LABEL: Record<string, string> = { read: "read only", safe: "safe", edits: "accept edits", auto: "auto" };

/** CONTROL.md §3.1's rules for `files`, or why they are broken. */
export function filesProblem(v: unknown): string | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > START_FILES_MAX)
    return `files is a list of 1 to ${START_FILES_MAX} files`;
  let total = 0;
  const names = new Set<string>();
  for (const f of v as Record<string, unknown>[]) {
    if (!f || typeof f !== "object") return "a file is {name, type, size, sha256}";
    const keys = Object.keys(f);
    if (keys.length !== 4 || !["name", "type", "size", "sha256"].every((k) => keys.includes(k)))
      return "a file is {name, type, size, sha256}";
    if (typeof f.name !== "string") return "a file's name is text";
    const name = f.name.normalize("NFC");
    if (
      name.length < 1 ||
      name.length > 200 ||
      name === "." ||
      name === ".." ||
      name.startsWith(".") ||
      [...name].some((c) => c === "/" || c === "\\" || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
    )
      return "a file's name is 1 to 200 characters, no slash, no control character, no leading dot";
    if (typeof f.type !== "string" || f.type.length > 100 || !MEDIA_TYPE_RE.test(f.type))
      return "a file's type is a media type";
    if (typeof f.size !== "number" || !Number.isInteger(f.size) || f.size < 1 || f.size > START_FILE_MAX_BYTES)
      return "a file is 1 byte to 25 MiB";
    if (typeof f.sha256 !== "string" || !SHA256_RE.test(f.sha256)) return "a file's sha256 is 43 base64url characters";
    const key = name.toLowerCase();
    if (names.has(key)) return "two files have the same name";
    names.add(key);
    total += f.size;
  }
  if (total > START_FILES_TOTAL_BYTES) return "the files are over 50 MiB together";
  return null;
}

/** The closed field set (sessionpipe 0.10, CONTROL.md §3.1): what each kind carries besides
 *  these. A field a kind does not own is refused here as a 0.10 machine refuses it, whatever
 *  this receiver's own core still lets through. */
const COMMON_FIELDS = new Set(["v", "t", "machine", "kind", "session", "nonce", "iat", "note"]);
const FIELDS: Record<string, readonly string[]> = {
  prompt: ["text", "files"],
  "permission.answer": ["for", "decision"],
  cancel: [],
  start: ["text", "cwd", "files", "permission", "model"],
  "key.add": ["key", "name"],
};

/** A file the receiver no longer holds, which the machine could not fetch. */
function heldProblem(list: { sha256: string; name: string }[], files: FileStore): Refusal | null {
  for (const f of list)
    if (!files.has(f.sha256)) return { code: "file", why: `${f.name} is not held here any more; add it again` };
  return null;
}

/** Why the receiver will not queue this verified command for a machine with these facts,
 *  or null when it may. `cmd` is the parsed command string. */
export function precheck(cmd: Record<string, unknown>, facts: PrecheckFacts, files: FileStore): Refusal | null {
  const has = (k: string) => Object.hasOwn(cmd, k);
  const own = FIELDS[String(cmd.kind)];
  const stray = own && Object.keys(cmd).find((k) => !COMMON_FIELDS.has(k) && !own.includes(k));
  if (stray) return { code: "bad_fields", why: `a ${cmd.kind} carries no ${stray}` };
  if (cmd.kind !== "start") {
    if (has("permission") || has("model"))
      return { code: "bad_fields", why: "only a start carries a model or a permission" };
    if (!has("files")) return null;
    // A prompt's files (CONTROL.md §2): only to a machine whose hello says `prompt_files`;
    // an older one refuses the prompt `bad_fields`.
    if (cmd.kind !== "prompt") return { code: "bad_fields", why: "only a start or a prompt carries files" };
    const bad = filesProblem(cmd.files);
    if (bad) return { code: "bad_fields", why: bad };
    if (!facts.promptFiles) return { code: "bad_fields", why: "this machine did not say it takes files on a prompt" };
    return heldProblem(cmd.files as { sha256: string; name: string }[], files);
  }
  const session = typeof cmd.session === "string" ? cmd.session : "";
  const harness = session.slice(0, Math.max(0, session.indexOf(":")));
  const opts = facts.start?.[harness];

  if (has("files")) {
    const bad = filesProblem(cmd.files);
    if (bad) return { code: "bad_fields", why: bad };
    if (!facts.files) return { code: "bad_fields", why: "this machine did not say it takes files on a start" };
    const gone = heldProblem(cmd.files as { sha256: string; name: string }[], files);
    if (gone) return gone;
  }

  if (has("permission")) {
    const p = cmd.permission;
    if (typeof p !== "string" || !(START_PERMISSIONS as readonly string[]).includes(p))
      return { code: "bad_fields", why: "permission is read, safe, edits or auto" };
    if (!opts) return { code: "permission", why: "this machine takes no permission on a start for this agent" };
    // Inherit (CONTROL.md §3.1): the harness's own default can't be ranked, so a start there
    // names read or safe at most, whatever the hello lists.
    if (facts.mode === "inherit" && !(INHERIT_LEVELS as readonly string[]).includes(p))
      return {
        code: "permission",
        why: `this machine runs its agents as your own sessions there, so a start may name read only or safe, not ${LEVEL_LABEL[p]}`,
      };
    if (!(opts.permissions as readonly string[]).includes(p))
      return {
        code: "permission",
        why: facts.mode
          ? `this machine runs in ${facts.mode} mode, so it won't start with ${LEVEL_LABEL[p]}`
          : `this machine won't start this agent with ${LEVEL_LABEL[p]}`,
      };
  }

  if (has("model")) {
    if (!validModel(cmd.model)) return { code: "bad_fields", why: "a model is 1 to 100 characters, no leading dash" };
    if (!opts || (!opts.anyModel && !opts.models?.length))
      return { code: "model", why: "this agent takes no model on a start here" };
    if (!opts.anyModel && !opts.models?.includes(cmd.model))
      return { code: "model", why: `${cmd.model} is not one of the models this machine offers` };
  }
  return null;
}
