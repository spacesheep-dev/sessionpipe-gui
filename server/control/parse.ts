// SPDX-License-Identifier: Apache-2.0
// The control bodies, cleaned (control-pair.json, control-hello.json, control-ack.json).
// A field that breaks its schema is dropped, never guessed at; a body that breaks the
// required shape is null, which the route answers 400.
import {
  type ControlOutcome,
  type HarnessStartOptions,
  type KeyType,
  START_PERMISSIONS,
  type StartPermission,
  validModel,
} from "../../shared/api.js";

export const MACHINE_RE = /^m_[A-Za-z0-9_-]{16,40}$/;
export const CODE_RE = /^[A-Za-z0-9_-]{6,32}$/;
export const POLL_KEY_RE = /^[A-Za-z0-9_-]{22,128}$/;
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const SESSION_REF = /^[a-z][a-z0-9-]{0,39}:[A-Za-z0-9._:-]{1,128}$/;
const HARNESS_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MODES = new Set(["sdk", "waiter", "turn", "api", "resume", "fork"]);
const OUTCOMES = new Set<string>(["progress", "taken", "delivered", "expired", "unsupported", "failed", "refused"]);
const ACCOUNT_EMAIL = /^[^@\s]{1,64}@[^@\s]{1,189}$/;

export interface HarnessAccount {
  harness: string;
  id: string;
  email: string;
}

export interface Hello {
  name: string;
  harnesses: string[];
  modes: string[];
  keys: string[];
  version: string;
  waiting: string[];
  folders: string[] | null;
  mode: "safe" | "auto" | null;
  accounts: HarnessAccount[];
  /** `files: true`: the machine takes `files` on a `start`. */
  files: boolean;
  /** `prompt_files: true`: and on a `prompt` (sessionpipe 0.10). */
  promptFiles: boolean;
  /** The daemon user's home folder, absolute (sessionpipe 0.10); null when not sent. */
  home: string | null;
  /** What a `start` may ask for, per harness (sessionpipe 0.10); null when not sent. */
  start: Record<string, HarnessStartOptions> | null;
  /** `key_types` (CONTROL.md §2): the kinds of key it takes; null when not sent (passkeys only). */
  keyTypes: KeyType[] | null;
}

/** `key_types`: known kinds only, each once; null when absent or empty. */
export function parseKeyTypes(v: unknown): KeyType[] | null {
  if (!Array.isArray(v)) return null;
  const out = (["passkey", "device"] as const).filter((t) => v.includes(t));
  return out.length ? out : null;
}

/** A machine name is printed in a terminal and on a page: control characters are dropped. */
const stripControl = (s: string): string => [...s].filter((c) => c.charCodeAt(0) >= 0x20).join("");

const strs = (v: unknown, re: RegExp, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && re.test(x)).slice(0, max) : [];

/** control-hello.json and the pairing request's facts (the same fields). */
export function parseHello(body: unknown): Hello | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || typeof b.name !== "string" || !b.name.trim()) return null;
  if (!Array.isArray(b.harnesses) || !Array.isArray(b.modes) || typeof b.version !== "string") return null;
  return {
    name: stripControl(b.name).trim().slice(0, 80),
    harnesses: strs(b.harnesses, HARNESS_RE, 20),
    modes: strs(b.modes, /^(sdk|waiter|turn|api|resume|fork)$/, 6),
    keys: strs(b.keys, /^[A-Za-z0-9_-]{16,1400}$/, 50),
    version: b.version.slice(0, 40),
    waiting: strs(b.waiting, SESSION_REF, 500),
    folders: Array.isArray(b.folders) ? strs(b.folders, /^(\/|[A-Za-z]:[\\/])/, 50).map((f) => f.slice(0, 1024)) : null,
    mode: b.mode === "auto" ? "auto" : b.mode === "safe" ? "safe" : null,
    accounts: parseAccounts(b.accounts),
    files: b.files === true,
    promptFiles: b.prompt_files === true,
    home: parseHome(b.home),
    start: parseStart(b.start, strs(b.harnesses, HARNESS_RE, 20)),
    keyTypes: parseKeyTypes(b.key_types),
  };
}

/** `home`: an absolute folder (a POSIX path, or a Windows drive), at most 1024 characters. */
export function parseHome(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 1024 || !/^(\/|[A-Za-z]:[\\/])/.test(v)) return null;
  if ([...v].some((c) => c.charCodeAt(0) < 0x20)) return null;
  return v;
}

const isLevel = (v: unknown): v is StartPermission =>
  typeof v === "string" && (START_PERMISSIONS as readonly string[]).includes(v);

/** `start` (control-hello.json): one entry per harness the hello also lists. An entry for
 *  another harness is dropped, and so is one whose default is not among its levels; unknown
 *  levels and malformed models are filtered out. Null when there is nothing left. */
export function parseStart(v: unknown, harnesses: readonly string[]): Record<string, HarnessStartOptions> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, HarnessStartOptions> = {};
  for (const [h, raw] of Object.entries(v as Record<string, unknown>).slice(0, 50)) {
    if (!HARNESS_RE.test(h) || !harnesses.includes(h) || !raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const permissions = Array.isArray(e.permissions)
      ? START_PERMISSIONS.filter((l) => (e.permissions as unknown[]).includes(l))
      : [];
    if (!permissions.length || !isLevel(e.permission) || !permissions.includes(e.permission)) continue;
    const entry: HarnessStartOptions = { permissions, permission: e.permission };
    if (Array.isArray(e.models)) {
      const models = [...new Set(e.models.filter(validModel))].slice(0, 50);
      if (models.length) entry.models = models;
    }
    if (e.any_model === true) entry.anyModel = true;
    out[h] = entry;
  }
  return Object.keys(out).length ? out : null;
}

/** `accounts`: a label the board shows for an account id, never checked against anything. */
export function parseAccounts(v: unknown): HarnessAccount[] {
  if (!Array.isArray(v)) return [];
  const out: HarnessAccount[] = [];
  for (const a of v.slice(0, 20) as Record<string, unknown>[]) {
    if (!a || typeof a !== "object" || typeof a.harness !== "string" || !HARNESS_RE.test(a.harness)) continue;
    if (typeof a.id !== "string" || !a.id || a.id.length > 128) continue;
    const email = typeof a.email === "string" ? a.email.trim() : "";
    if (!ACCOUNT_EMAIL.test(email)) continue;
    if (!out.some((x) => x.harness === a.harness && x.id === a.id)) out.push({ harness: a.harness, id: a.id, email });
  }
  return out;
}

export interface AckIn {
  id: string;
  outcome: ControlOutcome;
  at: string;
  mode?: string;
  session?: string;
  code?: string;
  detail?: string;
  reply?: string;
  seq?: number;
  /** What a start ran with (`taken`, `delivered`; sessionpipe 0.10). */
  applied?: { permission?: StartPermission; model?: string };
}

/** control-ack.json: an ack that breaks the schema is dropped, not guessed at. */
export function parseAcks(body: unknown, now: () => string): AckIn[] | null {
  const list = (body as { acks?: unknown })?.acks;
  if (!Array.isArray(list) || !list.length || list.length > 100) return null;
  const out: AckIn[] = [];
  for (const a of list as Record<string, unknown>[]) {
    if (!a || typeof a !== "object" || typeof a.id !== "string" || !ULID_RE.test(a.id)) continue;
    if (typeof a.outcome !== "string" || !OUTCOMES.has(a.outcome)) continue;
    const at = typeof a.at === "string" && Number.isFinite(Date.parse(a.at)) ? new Date(a.at).toISOString() : now();
    const ack: AckIn = { id: a.id, outcome: a.outcome as ControlOutcome, at };
    if (typeof a.mode === "string" && MODES.has(a.mode)) ack.mode = a.mode;
    if (typeof a.session === "string" && SESSION_REF.test(a.session)) ack.session = a.session;
    if (typeof a.code === "string" && /^[a-z_]{1,40}$/.test(a.code)) ack.code = a.code;
    if (typeof a.detail === "string") ack.detail = a.detail.slice(0, 500);
    if (typeof a.reply === "string") ack.reply = a.reply.slice(0, 20_000);
    if (typeof a.seq === "number" && Number.isInteger(a.seq) && a.seq >= 0) ack.seq = a.seq;
    const applied = parseApplied(a.applied);
    if (applied) ack.applied = applied;
    out.push(ack);
  }
  return out;
}

/** An ack's `applied` (control-ack.json): a level and a model, each dropped when malformed;
 *  undefined when neither is left. */
export function parseApplied(v: unknown): { permission?: StartPermission; model?: string } | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const a = v as Record<string, unknown>;
  const out: { permission?: StartPermission; model?: string } = {};
  if (isLevel(a.permission)) out.permission = a.permission;
  if (validModel(a.model)) out.model = a.model;
  return out.permission || out.model ? out : undefined;
}

export const FINAL_OUTCOMES = new Set<ControlOutcome>(["delivered", "expired", "unsupported", "failed", "refused"]);
export const isFinal = (o: ControlOutcome | undefined): boolean => !!o && FINAL_OUTCOMES.has(o);
