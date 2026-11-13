// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. A carried message's lifecycle and a refusal's code, in words a
// person reads under the strip (CONTROL.md §5, §10).
import type { ControlActivity, ControlKind, ControlOutcome, RunLevel } from "@shared/api";
import { asSentence } from "@shared/reason";
import { accountMode } from "../lib/net";
import { ControlError, UNHEARD_CODE, wrongOriginHere } from "./api";
import { wrongOriginWords } from "./origin";
import { remoteHostFor } from "./remoteRp";
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
  // Shown where no notice can confirm it (the runner, a view, the inbox, the palette):
  // the session's page can (control/HeldNotice.tsx).
  confirm_required: "held for you to confirm; send it from the session's page to confirm it",
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
  const unheard = unheardWords(a);
  if (unheard) return unheard;
  const who = o.machine ?? "the machine";
  const mode = a.mode ? ` · ${a.mode}` : "";
  const state = shownState(a);
  if (a.unfollowed && (state === "queued" || state === "taken")) return `waiting · ${unfollowedWords(a)}`;
  // A person's own cancel (spacesheep's withdrawn start, a computer's stopped start) is not
  // a refusal.
  if ((a.outcome === "refused" || a.outcome === "failed") && a.code === "cancelled")
    return "cancelled · before the machine started it";
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
      // A send through spacesheep this app can no longer follow (server/control/state.ts).
      if (a.code === "untracked") return "not followed · sent through an account that's no longer connected";
      return `failed · ${a.detail ?? "the path errored"}`;
    case "unconfirmed":
      // spacesheep took the send and named no job (server/control/rows.ts NO_JOB_CODE):
      // that a computer took it is not known here.
      if (a.code === "no_job") return "not followed · spacesheep didn't say which job it is";
      return `no word · ${who} took it and said nothing more`;
    case "refused": {
      // No code (spacesheep before its `code`): the reason alone, never "refused · refused".
      const reason = reasonOf(a);
      if (!a.code) return `refused${reason ? ` · ${reason}` : ""}`;
      return `refused · ${refusalWords(a.code)}${reason && !REFUSAL_WORDS[a.code ?? ""] ? `: ${reason}` : ""}`;
    }
    default:
      return String(a.outcome);
  }
}

export const isFinal = (a: ControlActivity): boolean =>
  a.outcome === "delivered" ||
  a.outcome === "expired" ||
  a.outcome === "unsupported" ||
  a.outcome === "failed" ||
  a.outcome === "refused" ||
  a.outcome === "unconfirmed";

/** A send nobody heard the answer to, in the words a send's own answer would have had
 *  (account/unheard.ts): that it may have been sent, while the app is finding out and when
 *  nobody can say any more; the refusal's own words once it is known that no job was made.
 *  Null for every other row. */
export function unheardWords(a: Pick<ControlActivity, "unheard" | "code" | "detail">): string | null {
  const u = a.unheard;
  if (!u) return null;
  if (u.state === "unsent") return sendErrorWords(new ControlError(u.status ?? 502, u.reason ?? "", a.code, a.detail));
  return sendErrorWords(new ControlError(504, a.detail ?? "", UNHEARD_CODE, a.detail));
}

/** What went wrong before anything was queued, in words. */
export function sendErrorWords(e: unknown): string {
  if (e instanceof ControlError) {
    // A send naming files for a computer reached through spacesheep (forwardSend): its reason.
    if (e.code === "relay_files") return `Not sent. ${e.detail ?? e.reason}`;
    if (e.status === 422 && e.code) return `not sent · ${refusalWords(e.code)}`;
    // spacesheep refused this app's key (server/control/ui.ts forwardSend), not the page's.
    // On an account (the phone) nothing connects in Settings: the sentence stops at what is so.
    if (e.code === "spacesheep_unauthorized")
      return accountMode()
        ? "Not sent. spacesheep no longer takes this app's key."
        : "Not sent. spacesheep no longer takes this app's key: disconnect and connect again in Settings → Data.";
    // The app could get no answer for it (account/doors.ts): nobody knows whether spacesheep
    // took it, so it is never said to be not sent. The app's own words for what happened,
    // and the one thing to do before sending it again.
    if (e.code === UNHEARD_CODE)
      return `It may have been sent: ${asSentence(e.detail ?? e.reason)} Look at the session before you send it again.`;
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

/** A receiver's reason worth quoting: not the bare outcome an older spacesheep notes when the
 *  computer gave none ("refused"), which would read "refused it: refused". */
export const reasonOf = (a: Pick<ControlActivity, "detail" | "outcome">): string | undefined => {
  const d = a.detail?.trim();
  return d && d.toLowerCase() !== a.outcome ? d : undefined;
};

/** The words for a send spacesheep carried that this app can't say the end of. */
export const UNTRACKED_WORDS =
  "Sent through a spacesheep account that's no longer connected here. Check spacesheep.dev to see if it started.";
/** A send spacesheep took without naming its job: sent, and nothing more is known here.
 *  `host`: where the account that carried it lives, as the machine's row says (an account
 *  need not be on spacesheep.dev); absent, spacesheep.dev. */
export const noJobWords = (host?: string): string =>
  `Sent, but this app can't follow it. Check ${host || "spacesheep.dev"} to see how it went.`;
/** A send that ended `unconfirmed`: a computer took it and said nothing more, or (the
 *  code `no_job`) spacesheep took it and named no job, and then no computer is known to
 *  have taken it. */
export const unconfirmedWords = (machine: string, a?: Pick<ControlActivity, "code" | "machineId">): string =>
  a?.code === "no_job"
    ? noJobWords(a.machineId ? remoteHostFor(a.machineId) : undefined)
    : `No word from ${machine} since it took this. Check spacesheep.dev to see how it went.`;

/** A handoff that ended any way but delivered, in the one phrase its card shows. "not sent"
 *  only where that is so: a send whose end is not known here was sent, and says what is
 *  known instead (outcomeWords). */
export function handoffEndWords(a: ControlActivity, machine: string): string {
  if (a.outcome === "unconfirmed" || (a.outcome === "failed" && a.code === "untracked"))
    return outcomeWords(a, { machine });
  return `not sent · ${a.outcome === "refused" ? refusalWords(a.code) : (a.detail ?? a.outcome)}`;
}
/** A waiting row nothing reads right now: disconnected, or the key refused. */
export const unfollowedWords = (a: Pick<ControlActivity, "unfollowed">): string =>
  a.unfollowed === "revoked"
    ? "Not being followed: spacesheep no longer takes this app's key."
    : "Not being followed while spacesheep is disconnected.";

/** A machine's detail ends the sentence it is quoted in; most arrive without a full stop. */
const ended = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** A prompt that did not reach its session, in the words the timeline shows under it. */
export function promptFailureWords(a: ControlActivity, machine: string): string | null {
  const detail = a.detail?.trim();
  if ((a.outcome === "refused" || a.outcome === "failed") && a.code === "cancelled")
    return `Cancelled with its session, before ${machine} got it.`;
  if (a.unheard) return a.unheard.state === "asking" ? null : unheardWords(a);
  if (a.outcome === "failed" && a.code === "untracked") return UNTRACKED_WORDS;
  if (a.outcome === "unconfirmed") return unconfirmedWords(machine, a);
  switch (a.outcome) {
    case "refused": {
      // No code (spacesheep before its `code`): the reason when there is one, never twice.
      const reason = reasonOf(a);
      if (!a.code)
        return `${machine} refused it.${reason ? ` ${(reason.charAt(0).toUpperCase() + reason.slice(1)).replace(/[.!?…]?$/, ".")}` : ""}`;
      return `${machine} refused it: ${refusalWords(a.code)}.`;
    }
    case "failed":
      return `It didn't reach the session${detail ? `: ${detail.replace(/[.!?…]?$/, ".")}` : "."}`;
    case "expired":
      return `${machine} didn't take it in time.`;
    case "unsupported":
      return `${machine} can't hand messages to this session's agent.`;
    default:
      return null;
  }
}

/** A start that did not start, in the words the session page shows under it (STEER-SPEC
 *  B.5), or null when it is still on its way or started. `agent` is the harness's name. */
export function startFailureWords(a: ControlActivity, machine: string, agent: string): string | null {
  const detail = reasonOf(a);
  const level = a.permission ? PERMISSION_LABEL[a.permission] : null;
  // Called off before it began: by its owner on spacesheep, or by a cancel on the computer.
  if ((a.outcome === "refused" || a.outcome === "failed") && a.code === "cancelled")
    return `Cancelled before ${machine} started it.`;
  if (a.unheard) return a.unheard.state === "asking" ? null : unheardWords(a);
  if (a.outcome === "failed" && a.code === "untracked") return UNTRACKED_WORDS;
  if (a.outcome === "unconfirmed") return unconfirmedWords(machine, a);
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
      case undefined:
        // No code (spacesheep before its `code`): the reason when there is one, never twice.
        return `${machine} refused it.${detail ? ` ${ended(detail.charAt(0).toUpperCase() + detail.slice(1))}` : ""}`;
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
  const unheard = unheardWords(a);
  if (unheard) return { text: unheard, running: false };
  if (a.unfollowed && (state === "queued" || state === "taken")) return { text: unfollowedWords(a), running: false };
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
