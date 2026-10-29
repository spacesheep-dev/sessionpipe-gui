// SPDX-License-Identifier: Apache-2.0
// What an open permission asks to run, in full: the input of the tool call the prompt
// is about. The attention's own message is the redacted first 200 characters (PRIVACY.md
// tier 1); a tier-3 session also sent the call's `input` on its `tool.started`. One read
// of the session's newest events per prompt, kept for the page's life; a failed read
// leaves the strip on the message, as before.
import type { Attention, SessionSummary, StoredEvent } from "@shared/api";
import { useEffect, useState } from "react";
import { answerable } from "../components/ControlStrip";
import { useStore } from "../data/hooks";

type Input = Record<string, unknown>;

/** Per attention id: the call's input, or null when the read found none or failed. */
const asked = new Map<string, Input | null>();
const reading = new Map<string, Promise<void>>();

const isInput = (v: unknown): v is Input => !!v && typeof v === "object" && !Array.isArray(v);

/** The input of the newest `tool.started` of `tool` that no later `tool.ended` closed
 *  (by `call_id`; by name when the call has none). Undefined when there is none. When
 *  the prompt's id is its call's id (Codex, Devin), that call is the one, even with a
 *  subagent's call of the same tool started after it. */
export function pickAskedInput(events: readonly StoredEvent[], tool: string, callId?: string): Input | undefined {
  const ended = new Set<string>();
  let newest: StoredEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.data.tool !== tool) continue;
    const call = typeof e.data.call_id === "string" ? e.data.call_id : "";
    if (e.type === "tool.ended") ended.add(call);
    else if (e.type === "tool.started") {
      if (callId && call === callId) return isInput(e.data.input) ? e.data.input : undefined;
      if (!ended.has(call)) newest ??= e;
    }
  }
  return newest && isInput(newest.data.input) ? newest.data.input : undefined;
}

/** The input an open, answerable permission asks about, once read. */
export function useAskedInput(session: SessionSummary, attention: Attention | undefined): { input?: Input } {
  const store = useStore();
  const id =
    attention?.kind === "permission" && attention.tool && answerable(attention) ? attention.attentionId : undefined;
  const tool = attention?.tool;
  const [, setRead] = useState(0);
  useEffect(() => {
    if (!id || !tool || asked.has(id)) return;
    let live = true;
    let p = reading.get(id);
    if (!p) {
      p = store.transport
        .session(session.harness, session.id, { tail: true, limit: 50 })
        .then(
          (d) => void asked.set(id, pickAskedInput(d.events, tool, id) ?? null),
          () => void asked.set(id, null),
        )
        .finally(() => reading.delete(id));
      reading.set(id, p);
    }
    void p.then(() => live && setRead((n) => n + 1));
    return () => {
      live = false;
    };
  }, [store, session.harness, session.id, id, tool]);
  const input = id ? asked.get(id) : undefined;
  return input ? { input } : {};
}
