// SPDX-License-Identifier: Apache-2.0
// Owned by: control-web. The `control` member of the ThemeApi (shared/theme-api.ts): a
// theme sends the same signed commands the Session and Machines pages do, through the
// same path (command.ts → the day grant or a passkey confirm → POST /api/ui/control/send).
// Nothing is signed here; this file only resolves the target machine, says in advance
// whether a send can work, and turns a failure into the words the host would show.
import type { ControlActivity, MachineSummary, SessionKey, SessionSummary } from "@shared/api";
import { sessionKey } from "@shared/api";
import type { ControlAvailability, ThemeApi } from "@shared/theme-api";
import { uploadAttachment } from "./Attachments";
import { rpId as fetchRpId } from "./api";
import { uuid } from "./bytes";
import { type CommandFields, sendCommand } from "./command";
import { openNewSession } from "./newSessionState";
import { insecureHint, passkeysAvailable } from "./webauthn";
import { sendErrorWords } from "./words";

export type ThemeControl = NonNullable<ThemeApi["control"]>;

export interface ControlApiDeps {
  machines(): ReadonlyMap<string, MachineSummary>;
  sessions(): ReadonlyMap<SessionKey, SessionSummary>;
  /** The rp id passkeys are made for; the host's cached Info read by default. */
  rpId?(): Promise<string>;
}

type Target = { session?: SessionKey; machineId?: string };

/** The paired machine a target names, or the reason there is none / it cannot be sent to. */
function resolve(deps: ControlApiDeps, target: Target): { machine: MachineSummary } | { reason: string } {
  if (!passkeysAvailable()) return { reason: insecureHint() };
  let machine: MachineSummary | undefined;
  let name: string | undefined;
  if (target.machineId) {
    for (const m of deps.machines().values()) {
      if (m.control?.machineId === target.machineId) machine = m;
    }
    if (!machine) return { reason: "this machine is not paired here" };
  } else if (target.session) {
    const s = deps.sessions().get(target.session);
    if (!s) return { reason: "no such session is known here" };
    name = s.machine;
    machine = name ? deps.machines().get(name) : undefined;
  } else return { reason: "name a session or a machine id" };
  if (!machine?.control) return { reason: `pair ${name ?? machine?.name ?? "this machine"} to send messages` };
  if (!machine.control.online)
    return { reason: `${machine.name} is offline; nothing reaches it until its daemon polls` };
  return { machine };
}

const must = (r: { machine: MachineSummary } | { reason: string }): MachineSummary => {
  if ("reason" in r) throw new Error(`not sent · ${r.reason}`);
  return r.machine;
};

export function createControlApi(deps: ControlApiDeps): ThemeControl {
  const rp = deps.rpId ?? fetchRpId;
  const send = async (machine: MachineSummary, fields: CommandFields): Promise<ControlActivity> => {
    try {
      return await sendCommand(await rp(), machine.control!.machineId, fields);
    } catch (e) {
      throw new Error(sendErrorWords(e));
    }
  };
  return {
    availability(target): ControlAvailability {
      const r = resolve(deps, target);
      return "reason" in r ? { ok: false, reason: r.reason } : { ok: true };
    },
    send(session, text) {
      const t = text.trim();
      if (!t) return Promise.reject(new Error("not sent · the message is empty"));
      return send(must(resolve(deps, { session })), { kind: "prompt", session, text: t });
    },
    answer(session, attentionId, decision, note) {
      return send(must(resolve(deps, { session })), {
        kind: "permission.answer",
        session,
        for: attentionId,
        decision,
        ...(note ? { note } : {}),
      });
    },
    cancel(session) {
      return send(must(resolve(deps, { session })), { kind: "cancel", session });
    },
    attach(file) {
      return uploadAttachment(file);
    },
    compose(prefill) {
      openNewSession(prefill ?? {});
    },
    async start(machineId, opts) {
      const machine = must(resolve(deps, { machineId }));
      const cwd = opts.cwd.trim();
      const text = opts.text.trim();
      if (!cwd.startsWith("/")) throw new Error("not sent · the folder must be an absolute path on the machine");
      if (!text) throw new Error("not sent · the first message is empty");
      // The id is ours (NewSession.tsx: a UUID, claude-code's rule, kept by codex and gemini).
      const session = sessionKey(opts.harness, uuid());
      const activity = await send(machine, { kind: "start", session, text, cwd });
      return { ...activity, session };
    },
  };
}
