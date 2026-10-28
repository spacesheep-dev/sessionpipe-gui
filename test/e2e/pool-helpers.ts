// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// A fake daemon that pools (pool.spec.ts, pool.shots.spec.ts): its hello carries a pool
// of three accounts, it answers each signed `pool` command the way sessionpipe's daemon
// does (the hello that reflects it first, then the ack), and a `refuse` hook or a slower
// `pauseMs` lets a spec see a refusal or a command still on its way.
import { CONTROL_BASE, type FakeDaemon, fakeDaemon, type PageKey } from "./control-helpers.js";

const CONTROL = `${CONTROL_BASE}/api/sessionpipe/v1/control`;

export type Acct = {
  id: string;
  email: string;
  label: string;
  enabled: boolean;
  status: string;
  current: boolean;
  until?: string;
};
export const accts = (): Acct[] => [
  { id: "a1", email: "misha@example.com", label: "Misha", enabled: true, status: "ready", current: true },
  { id: "a2", email: "fiction@example.com", label: "Fiction", enabled: true, status: "ready", current: false },
  { id: "a3", email: "spacesheep@example.com", label: "Spacesheep", enabled: true, status: "ready", current: false },
];

export type PoolDaemon = FakeDaemon & { state: { on: boolean; accounts: Acct[] }; sayHello: () => Promise<unknown> };

export async function poolDaemon(
  key: PageKey,
  name: string,
  o: {
    refuse?: (action: string) => { code: string; detail?: string } | null;
    accounts?: Acct[];
    on?: boolean;
    offline?: boolean;
    pauseMs?: number;
    /** A hello account list for the machine's own logins (`accounts`), when wanted. */
    logins?: { harness: string; id: string; email: string }[];
  } = {},
): Promise<PoolDaemon> {
  const state = { on: o.on ?? true, accounts: o.accounts ?? accts() };
  const hello = () => ({
    name,
    harnesses: ["claude-code"],
    folders: ["/Users/e2e/code"],
    mode: "safe" as const,
    key_types: ["passkey", "device"],
    ...(o.logins ? { accounts: o.logins } : {}),
    pool: { on: state.on, harness: "claude-code", accounts: state.accounts },
  });
  let token = "";
  const post = (body: Record<string, unknown>) =>
    fetch(`${CONTROL}/hello`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ modes: ["sdk"], version: "0.11.0", keys: [], waiting: [], ...body }),
    });
  const sayHello = () => post(hello());
  const m = await fakeDaemon(key, hello(), {
    offline: o.offline,
    script: (c) => {
      const action = String(c.pool_action);
      const refusal = o.refuse?.(action);
      if (refusal) return { pauseMs: o.pauseMs ?? 200, acks: [{ outcome: "refused", ...refusal }] };
      if (action === "on" || action === "off") state.on = action === "on";
      if (action === "order") {
        const order = c.pool_order as string[];
        state.accounts = order.map((id) => state.accounts.find((a) => a.id === id)!);
      }
      if (action === "remove") state.accounts = state.accounts.filter((a) => a.id !== c.pool_account);
      if (action === "login.begin")
        return {
          pauseMs: o.pauseMs ?? 200,
          acks: [{ outcome: "delivered", detail: "pl_e2e1 https://claude.ai/oauth/authorize?e2e=1" }],
        };
      if (action === "login.complete") {
        if (String(c.pool_code).startsWith("expired#"))
          return {
            pauseMs: o.pauseMs ?? 200,
            acks: [{ outcome: "refused", code: "pool_account", detail: "the login expired" }],
          };
        state.accounts.push({
          id: "a4",
          email: "new@example.com",
          label: "New",
          enabled: true,
          status: "ready",
          current: false,
        });
      }
      // The hello first (the receiver redraws from it), then the ack after the pause.
      if (!o.pauseMs) void sayHello();
      else setTimeout(() => void sayHello(), o.pauseMs - 100);
      return {
        pauseMs: o.pauseMs ?? 300,
        acks: [{ outcome: "delivered", detail: `${state.on ? "on" : "off"} · ${state.accounts.length} accounts` }],
      };
    },
  });
  token = m.token;
  // Stopped, it says one last hello without a pool, so the instance's Usage page is
  // today's again for the specs that expect it empty (limits.spec.ts).
  const stop = m.stop;
  m.stop = async () => {
    await stop();
    await post({ name, harnesses: ["claude-code"] });
  };
  return Object.assign(m, { state, sayHello });
}
