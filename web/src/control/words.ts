// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. A carried message's lifecycle and a refusal's code, in words a
// person reads under the strip (CONTROL.md §5, §10).
import type { ControlActivity, ControlKind, ControlOutcome, RunLevel } from "@shared/api";
import { ControlError, wrongOriginHere } from "./api";
import { wrongOriginWords } from "./origin";
import { deviceRefusal, nativeErrorWords } from "./signer";
import { webauthnError } from "./webauthn";

export const KIND_LABEL: Record<ControlKind, string> = {
  prompt: "prompt",
  "permission.answer": "answer",
  cancel: "cancel",
  start: "start",
  "key.add": "trust a device",
  pool: "manage its accounts",
};

/** Why the machine (or the receiver's early check) said no. */
export const REFUSAL_WORDS: Record<string, string> = {
  malformed: "the command did not parse",
  not_a_command: "not a sessionpipe command",
  wrong_machine: "the command names another machine",
  unknown_kind: "a kind this machine does not know",
  bad_session: "the session reference is not well formed",
  bad_fields: "a field is missing or does not belong to this kind",
  bad_nonce: "the nonce is not well formed",
  too_old: "signed too long ago; send it again",
  future: "signed in the future: check this device's clock",
  unsigned: "no signature",
  untrusted_key:
    "this browser's passkey is not trusted by the machine: add this device from one that is, or pair it from the machine's terminal",
  bad_assertion: "the passkey signature did not verify",
  bad_grant: "the day grant did not verify; the next send asks for your passkey again",
  outside_grant: "signed outside the grant's window; the next send asks for your passkey again",
  bad_csig: "the day key's signature did not verify",
  replay: "the machine already ran this one",
  nonce_store: "the machine could not record the nonce, so it did not run it",
  folder: "the session's folder is not on the machine's allowlist",
  no_attention: "that permission is no longer open",
  no_session: "the machine has no such session",
  start_limit: "the machine is already starting as many sessions as it allows",
  permission: "the machine won't start at that permission level",
  model: "the agent won't run that model there",
  file: "a file didn't reach the machine",
  handoff: "this machine did not say it takes handoffs; the answer would not come back",
  // A daemon up to 0.9.0 says `mode` where CONTROL.md now says `permission`.
  mode: "the machine won't start at that permission level",
  // The pool (DESIGN §2.3): the receiver's second look, and the daemon's own words.
  pool_unsupported: "this machine's sessionpipe is older than account switching; update it there",
  pool_account: "the machine's pool has no such account, or the sign-in took longer than ten minutes",
  pool_order: "the order must name every account in the pool, each once",
  pool_off: "the pool is off on that machine; turn it on first",
  confirm_required: "this one takes a fresh passkey tap (Touch ID in the app), not the day grant; try again",
  login: "Claude did not take the code; start over",
  pool: "the machine could not reach Claude; try again",
};

/** The wrong-origin guard's line, e.g. "Sending works from https://studio-mac.local:7373;
 *  open it there." A passkey is bound to its origin, so a page elsewhere is never offered
 *  "add this device": that would make a key the right address cannot see. */
export const WRONG_ORIGIN = wrongOriginWords;

export const refusalWords = (code: string | undefined): string => {
  // A refused key on the wrong address is the address, not the key: say so, with the way out.
  const wrong = code === "untrusted_key" ? wrongOriginHere() : null;
  if (wrong) return WRONG_ORIGIN(wrong);
  const app = code ? deviceRefusal(code) : null;
  if (app) return app;
  return (code && REFUSAL_WORDS[code]) ?? (code ? code.replace(/_/g, " ") : "refused");
};

/** The step the message is at. The receiver keeps `taken` as the outcome once a taken ack
 *  landed and lets later progress acks grow `reply` (server/control/state.ts), so a taken
 *  message with a reply is "progress" to the eye. */
export function shownState(a: ControlActivity): ControlOutcome | "queued" {
  if (a.outcome === "taken" && a.reply !== undefined) return "progress";
  return a.outcome ?? "queued";
}

/** One line for where the message stands. `machine` is the machine's name, `online`
 *  whether it is polling right now. */
export function outcomeWords(a: ControlActivity, o: { machine?: string; online?: boolean } = {}): string {
  const who = o.machine ?? "the machine";
  const mode = a.mode ? ` · ${a.mode}` : "";
  const state = shownState(a);
  switch (state === "queued" ? undefined : state) {
    case undefined:
      return o.online === false
        ? `queued · ${who} is offline; it waits until ${who} polls, or expires`
        : `queued · waiting for ${who} to take it`;
    case "taken":
      return `taken · ${who} is delivering it${mode}`;
    case "progress":
      return `working · ${who} is answering${mode}`;
    case "delivered":
      return `delivered${mode}`;
    case "expired":
      return `expired · ${a.detail ?? "nobody took it in time"}`;
    case "unsupported":
      return `unsupported · ${who} has no way to ${KIND_LABEL[a.kind]} on this harness${a.detail ? `: ${a.detail}` : ""}`;
    case "failed":
      return `failed · ${a.detail ?? "the path errored"}`;
    case "refused":
      return `refused · ${refusalWords(a.code)}${a.detail && !REFUSAL_WORDS[a.code ?? ""] ? `: ${a.detail}` : ""}`;
    default:
      return String(a.outcome);
  }
}

export const isFinal = (a: ControlActivity): boolean =>
  a.outcome === "delivered" ||
  a.outcome === "expired" ||
  a.outcome === "unsupported" ||
  a.outcome === "failed" ||
  a.outcome === "refused";

/** What went wrong before anything was queued, in words. */
export function sendErrorWords(e: unknown): string {
  if (e instanceof ControlError) {
    if (e.status === 422 && e.code) return `not sent · ${refusalWords(e.code)}`;
    if (e.status === 404) return "not sent · this machine is no longer paired here";
    if (e.status === 401) return "not sent · this page lost its key; reload it from the terminal's link";
    return `not sent · ${e.detail ?? e.reason}`;
  }
  const native = nativeErrorWords(e);
  if (native) return `not sent · ${native}`;
  if (e && typeof e === "object" && "name" in e && typeof (e as { name: unknown }).name === "string") {
    const n = (e as { name: string }).name;
    if (n.endsWith("Error") && n !== "Error" && n !== "TypeError") return `not sent · ${webauthnError(e)}`;
  }
  return `not sent · ${e instanceof Error ? e.message : String(e)}`;
}

/** A machine's detail ends the sentence it is quoted in; most arrive without a full stop. */
const ended = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** A start that did not start, in the words the session page shows under it (STEER-SPEC
 *  B.5), or null when it is still on its way or started. `agent` is the harness's name. */
export function startFailureWords(a: ControlActivity, machine: string, agent: string): string | null {
  const detail = a.detail?.trim();
  const level = a.permission ? PERMISSION_LABEL[a.permission] : null;
  if (a.outcome === "refused")
    switch (a.code) {
      case "folder":
        return `${machine} doesn't allow that folder.`;
      case "permission":
      case "mode":
        return detail
          ? `${machine} won't start this: ${ended(detail)}`
          : `${machine} runs in safe mode, so it won't start with ${level ?? "that level"}.`;
      case "model":
        return `${machine}'s ${agent} won't run ${a.model ?? "that model"}${detail ? `: ${ended(detail)}` : "."}`;
      case "start_limit":
        return `${machine} is already running as many new sessions as it allows. Try again in a few minutes.`;
      default:
        return `${machine} refused it: ${refusalWords(a.code)}${detail && !REFUSAL_WORDS[a.code ?? ""] ? `: ${ended(detail)}` : "."}`;
    }
  if (a.outcome === "failed") {
    if (a.code === "model")
      return `${machine}'s ${agent} won't run ${a.model ?? "that model"}${detail ? `: ${ended(detail)}` : "."}`;
    if (a.code === "file") return `A file didn't reach ${machine}${detail ? `: ${ended(detail)}` : "."}`;
    return `It didn't start on ${machine}${detail ? `: ${ended(detail)}` : "."}`;
  }
  if (a.outcome === "unsupported") return `${machine} can't start ${agent} sessions.`;
  if (a.outcome === "expired") return `${machine} didn't come online in time.`;
  return null;
}

/** The level's name in the sheet and on the session page (STEER-SPEC B.3). `inherit` is
 *  only ever the machine's word (a default, an ack's `applied`), never one to send. */
export const PERMISSION_LABEL: Record<RunLevel, string> = {
  read: "Read only",
  safe: "Safe",
  edits: "Accept edits",
  auto: "Auto",
  inherit: "As your own sessions",
};

/** The command a harness runs as on its machine, for "Starting claude on studio-mac…":
 *  the agent the person already runs in their terminal, not a product name. A harness
 *  with no command of its own keeps its label. */
const COMMAND: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  "gemini-cli": "gemini",
  cursor: "cursor-agent",
  "copilot-cli": "copilot",
  droid: "droid",
  kiro: "kiro",
  opencode: "opencode",
};
export const harnessCommand = (harness: string, label: string): string => COMMAND[harness] ?? label;

/** The one status row under a message sent from here, in the timeline where its turn
 *  will be (STEER-SPEC B.5): where it is, in a person's words, as the machine's acks
 *  move it. `running` once the agent is at it: the row then reads "Running" with a live
 *  timer beside it. Null once there is nothing to say (it failed: the failure says it). */
export function sentLine(
  a: ControlActivity,
  o: { machine: string; online: boolean; command: string },
): { text: string; running: boolean } | null {
  const state = shownState(a);
  switch (state) {
    case "queued":
      return {
        text: o.online ? `Sent to ${o.machine}` : `Waiting for ${o.machine}. It starts when the machine is back.`,
        running: false,
      };
    case "taken":
      return a.kind === "start"
        ? { text: `Starting ${o.command} on ${o.machine}…`, running: false }
        : { text: `${o.machine} is handing it over…`, running: false };
    case "progress":
      return { text: "Running", running: true };
    case "delivered":
      return a.kind === "start"
        ? // An ACP agent (`api`) answers in the ack and may send no hook events at all.
          a.mode === "api"
          ? { text: `Ran on ${o.machine}.`, running: false }
          : { text: `Started on ${o.machine}. Its first events are on their way.`, running: false }
        : { text: "Delivered. Its turn shows here when it begins.", running: false };
    default:
      return null;
  }
}
