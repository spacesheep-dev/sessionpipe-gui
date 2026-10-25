// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. What every source does to a text before the engine sees it
// (SEARCH-SPEC.md D11, §3.1): harness wrappers and notices off, secrets redacted
// (sessionpipe-core's redactSecrets, the same rules sessionpipe sends with), cut to
// DOC_TEXT_MAX on a word. Plus the one-line tool summary every harness shares.
import { RULESET_SECRETS, redactSecrets } from "sessionpipe-core";
import { DOC_TEXT_MAX, TOOL_LINE_MAX } from "../types.js";

/** Cut to `max` UTF-16 units at a word boundary (never inside a surrogate pair). */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const floor = Math.max(0, max - 200);
  for (let i = max; i > floor; i--) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13) {
      end = i;
      break;
    }
  }
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return text.slice(0, end).trimEnd();
}

/**
 * A necessary condition for `redactSecrets` (secrets@1) to change a text: every rule needs a
 * trigger word (`pass…`, `pwd`, `secret`, `…key`, `token`, `cred…`, `Bearer`/`Basic`), a URL
 * (`://`), or one of its token prefixes. A text with none of them comes back unchanged, so
 * it skips the ~35 regex passes (a quarter of the build's CPU on dense history). Bound to the
 * ruleset id: when core ships another ruleset, every text takes the full path again until
 * this list is checked against it (redact.test.ts pins the parity).
 */
const MAYBE_SECRET =
  /pass|pwd|secret|key|token|cred|bearer|basic|:\/\/|AKIA|ASIA|ABIA|ACCA|gh[pousr]_|github_pat_|glpat-|xox[abposre]-|sk-|[sr]k_(?:live|test)_|whsec_|AIza|ya29\.|1\/\/0|GOCSPX-|xai-|gsk_|pplx-|hf_|pcsk_|npm_|pypi-|SG\.|shp(?:at|ss|ca|pa)_|dop_v1_|lin_(?:api|oauth)_|ntn_|sbp_|figd_|dp\.(?:pt|st|sa|ct)\.|grn_|ss_|:AA|eyJ/i;
const FAST = RULESET_SECRETS === "secrets@1";

/** sessionpipe-core's redactSecrets, skipped only when it provably changes nothing. */
export function redact(text: string): string {
  return FAST && !MAYBE_SECRET.test(text) ? text : redactSecrets(text);
}

/** Redacted and cut: the last step for every emitted text. Redaction runs before the cut
 *  so a secret is never left half-visible at the edge. */
export function finish(text: string, max = DOC_TEXT_MAX): string {
  const t = text.trim();
  if (!t) return "";
  // Bound the regex work on a huge paste; the margin keeps the cut edge clear of it.
  const pre = t.length > max * 2 ? cut(t, max * 2) : t;
  return cut(redact(pre), max).trim();
}

/** The argument keys a tool line is made of, first non-empty wins (SEARCH-SPEC.md §3.1). */
export const TOOL_KEYS = [
  "command",
  "cmd",
  "file_path",
  "path",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
  "notebook_path",
  "skill",
  "subject",
] as const;

const argText = (v: unknown): string => {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) return shellJoin(v as string[]);
  return "";
};

/** `["bash", "-lc", "npm test"]` → `npm test`; other argv joined with spaces. */
export function shellJoin(argv: string[]): string {
  if (argv.length === 3 && /^(?:ba|z|)sh$/.test(argv[0] ?? "") && /^-l?c$/.test(argv[1] ?? "")) return argv[2] ?? "";
  return argv.join(" ");
}

/** The interesting argument of a tool call, or "" (`extra` keys are tried after the shared ones). */
export function toolArg(input: unknown, extra: readonly string[] = []): string {
  if (typeof input === "string") return input.trim();
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const o = input as Record<string, unknown>;
  for (const k of TOOL_KEYS) {
    const v = argText(o[k]);
    if (v) return v;
  }
  for (const k of extra) {
    const v = argText(o[k]);
    if (v) return v;
  }
  return "";
}

/** A tool doc's text: `Name arg…`, redacted, cut to TOOL_LINE_MAX. */
export function toolLine(name: string, arg: string): string {
  const a = arg.replace(/\s+/g, " ").trim();
  return finish(
    a ? `${name} ${a.length > TOOL_LINE_MAX * 4 ? a.slice(0, TOOL_LINE_MAX * 4) : a}` : name,
    TOOL_LINE_MAX,
  );
}

/** The first prompt as a title: whitespace folded, cut at 80 on a word, `…` when cut. */
export function firstAskTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= 80) return line;
  return `${cut(line, 80).replace(/[\s,;:.-]+$/, "")}…`;
}

/** Placeholders a harness writes in place of an image or a block it cannot show. */
const PLACEHOLDER = /\[(?:external )?unsupported block[^\]]*\]|\[Image #?\d*\]|\[image\]/gi;
/** Notices the harness writes as the person's turn. */
const NOTICE = /^\[Request interrupted by user(?: for tool use)?\]$|^No response requested\.?$/;

/** Tags whose content is the harness talking, never the person: dropped wherever they are. */
const DROP_ANYWHERE =
  /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|ide_opened_file|user-prompt-submit-hook|task-notification)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
/** Material the person attached (not their words): indexed at the tool tier, clipped. */
const ATTACHED = /<(ide_selection|pasted_content)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
/** A harness wrapper's name has a `_` or `-` (`ide_opened_file`, `cross-session-message`);
 *  a plain word (`<div>`, `<button>`) is the person's own HTML and stays. */
const LEADING_TAG = /^\s*<([A-Za-z][A-Za-z0-9]*[_-][\w-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>\s*/;

export interface Cleaned {
  /** The person's own words ("" when none). */
  text: string;
  /** Attached material found in the block: [label, text]. */
  attached: [string, string][];
}

/**
 * One block of a Claude-shaped prompt, wrappers off (sources.md §2 "Wrappers"):
 * reminders and command output dropped; `/<command> <args>` kept as typed; IDE selections
 * and pasted content moved out as attached material; leading tags stripped so the real
 * ask after a VS Code `ide_*` block is kept.
 */
export function cleanPromptBlock(raw: string): Cleaned {
  const attached: [string, string][] = [];
  // Most prompts carry no markup at all: nothing to take off.
  if (!raw.includes("<") && !raw.includes("[") && !raw.startsWith("No response")) return { text: raw.trim(), attached };
  let t = raw.replace(DROP_ANYWHERE, "");
  t = t.replace(ATTACHED, (_m, tag: string, inner: string) => {
    const s = inner.trim();
    if (s) attached.push([tag === "ide_selection" ? "Selection" : "Pasted", s]);
    return "";
  });
  // Claude Code's paste marker `<pasted_content id="…">` (no closing tag) stands where the
  // paste was: the marker goes, the person's words around it stay.
  t = t.replace(/<\/?pasted_content\b[^>]*>/g, "");
  // Slash commands: <command-name>/x</command-name><command-message>…</command-message><command-args>a</command-args>
  if (t.includes("<command-name>")) {
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(t)?.[1]?.trim() ?? "";
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? "";
    t = t.replace(/<command-(?:name|message|args|contents)>[\s\S]*?<\/command-(?:name|message|args|contents)>/g, "");
    const rest = t.trim();
    const cmd = name ? `${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}` : args;
    t = rest ? `${cmd}\n${rest}` : cmd;
  }
  // `!cmd` shell input keeps what was typed.
  t = t.replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, (_m, c: string) => `!${c.trim()}`);
  for (let m = LEADING_TAG.exec(t); m; m = LEADING_TAG.exec(t)) t = t.slice(m[0].length);
  t = t.replace(PLACEHOLDER, "").trim();
  if (NOTICE.test(t)) t = "";
  // A block opened by a harness tag that never closes (a notice cut by the harness) is the
  // harness talking, whatever follows it.
  const open = /^<([A-Za-z][A-Za-z0-9]*[_-][\w-]*)(?:\s[^>]*)?>/.exec(t);
  if (open && !t.includes(`</${open[1]}>`)) t = "";
  return { text: t, attached };
}

/** Codex's own injections as a user message (sessionpipe's `codexInjected`). */
export const codexInjected = (text: string): boolean =>
  /^<[a-z_-]+(?:\s[^>]*)?>/i.test(text) || /^# AGENTS\.md instructions\b/i.test(text);

const REQUEST_MARK = /^##\s*My request(?: for Codex)?:\s*$/m;

/** Codex's attached-files preamble → the request plus the file names (the reference
 *  tool's `clean_prompt`). */
export function codexPrompt(text: string): string {
  let t = text.replace(PLACEHOLDER, "");
  if (t.trimStart().startsWith("# Files mentioned by the user")) {
    const m = REQUEST_MARK.exec(t);
    if (m) {
      const head = t.slice(0, m.index);
      const names: string[] = [];
      for (const n of head.matchAll(/^##\s*(.+?):\s*\//gm)) if (n[1]) names.push(n[1]);
      const request = t.slice(m.index + m[0].length).trim();
      t = request + (names.length ? `\n(files: ${names.join(", ")})` : "");
    }
  }
  return t.trim();
}

/** Epoch ms of an ISO time (or a number), 0 when absent or unreadable. */
export function ms(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : 0;
  if (typeof v !== "string" || !v) return 0;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

/** `https://user:pw@github.com/acme/api.git` → `acme/api`; anything else → undefined. */
export function repoName(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  const s = url.trim().replace(/\.git$/, "");
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?[^/]+\/|[^@\s]+@[^:\s]+:)([^\s?#]+?)\/?$/i.exec(s);
  const p = m?.[1]?.split("/").filter(Boolean);
  if (!p || p.length < 2) return undefined;
  return `${p[p.length - 2]}/${p[p.length - 1]}`;
}
