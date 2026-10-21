// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. A carried message's lifecycle and a refusal's code, in words a
// person reads under the strip (CONTROL.md §5, §10).
import type { ControlActivity, ControlKind, ControlOutcome } from "@shared/api";
import { ControlError, wrongOriginHere } from "./api";
import { wrongOriginWords } from "./origin";
import { webauthnError } from "./webauthn";

export const KIND_LABEL: Record<ControlKind, string> = {
  prompt: "prompt",
  "permission.answer": "answer",
  cancel: "cancel",
  start: "start",
  "key.add": "trust a device",
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
};

/** The wrong-origin guard's line, e.g. "Sending works from https://studio-mac.local:7373;
 *  open it there." A passkey is bound to its origin, so a page elsewhere is never offered
 *  "add this device": that would make a key the right address cannot see. */
export const WRONG_ORIGIN = wrongOriginWords;

export const refusalWords = (code: string | undefined): string => {
  // A refused key on the wrong address is the address, not the key: say so, with the way out.
  const wrong = code === "untrusted_key" ? wrongOriginHere() : null;
  if (wrong) return WRONG_ORIGIN(wrong);
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
  if (e && typeof e === "object" && "name" in e && typeof (e as { name: unknown }).name === "string") {
    const n = (e as { name: string }).name;
    if (n.endsWith("Error") && n !== "Error" && n !== "TypeError") return `not sent · ${webauthnError(e)}`;
  }
  return `not sent · ${e instanceof Error ? e.message : String(e)}`;
}
