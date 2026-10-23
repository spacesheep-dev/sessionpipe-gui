// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Signed control from a test browser, against the second e2e instance (playwright.config.ts:
// `--test-door`, rp id localhost) over plain http on localhost, where passkeys work: a CDP
// virtual authenticator makes the browser's passkey, the test door trusts it for a machine
// and mints that machine's token, and a fake daemon (this process) says hello, long-polls
// and acks the way sessionpipe's does. Nothing here runs an agent; a "start" is answered
// with acks and a few hook events, which is all the receiver ever sees of one.
import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { ulid } from "./helpers.js";

export const CONTROL_PORT = Number(process.env.SPGUI_E2E_TLS_PORT ?? 7312);
/** Plain http on localhost: a secure context, and under the rp id. */
export const CONTROL_BASE = `http://localhost:${CONTROL_PORT}`;
const CONTROL = `${CONTROL_BASE}/api/sessionpipe/v1/control`;

export interface PageKey {
  id: string;
  alg: number;
  spki: string;
}

/** A virtual authenticator on the page and one passkey it made, remembered the way the
 *  pairing page remembers it (`sessionpipe.passkeys:<rp>`). */
export async function passkeyPage(context: BrowserContext, page: Page): Promise<PageKey> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(`${CONTROL_BASE}/settings`);
  return page.evaluate(async () => {
    const b64u = (buf: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: "localhost", name: "sessionpipe" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "e2e", displayName: "E2E" },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      },
    })) as PublicKeyCredential;
    const res = cred.response as AuthenticatorAttestationResponse;
    const key = {
      id: cred.id,
      alg: -7,
      spki: b64u(res.getPublicKey()!),
      name: "E2E",
      createdAt: new Date().toISOString(),
    };
    localStorage.setItem("sessionpipe.passkeys:localhost", JSON.stringify([key]));
    return { id: key.id, alg: key.alg, spki: key.spki };
  });
}

export interface Hello {
  name: string;
  harnesses: string[];
  folders?: string[];
  mode?: "safe" | "auto";
  home?: string;
  files?: boolean;
  start?: Record<string, { permissions: string[]; permission: string; models?: string[]; any_model?: boolean }>;
  version?: string;
}

type Ack = Record<string, unknown> & { outcome: string };
/** What the daemon answers a start with: a list of acks (and a pause before each), and
 *  whether the session's first hook events go to the receiver before the final ack. */
export type StartScript = (cmd: Record<string, unknown>) => { acks: Ack[]; pauseMs?: number; events?: boolean };

export interface FakeDaemon {
  id: string;
  name: string;
  token: string;
  /** Long-poll and answer until stopped; `false` leaves it paired but never polling (offline). */
  stop(): Promise<void>;
  /** Every command it took, parsed. */
  seen: Record<string, unknown>[];
}

/** The page's passkey trusted for a fresh machine, its hello sent, and (unless `offline`)
 *  a poll loop answering each start with `script`. */
export async function fakeDaemon(
  key: PageKey,
  hello: Hello,
  o: { offline?: boolean; script?: StartScript; sinkToken?: string } = {},
): Promise<FakeDaemon> {
  const id = `m_e2e${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const enr = (await (
    await fetch(`${CONTROL}/_test/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machine: id, key, name: "E2E" }),
    })
  ).json()) as { token: string };
  const token = enr.token;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${CONTROL}/hello`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      modes: ["sdk", "waiter", "turn", "resume", "fork"],
      version: "0.10.0",
      keys: [],
      waiting: [],
      ...hello,
    }),
  });
  const seen: Record<string, unknown>[] = [];
  let stopped = false;
  const ack = (acks: Ack[]) =>
    fetch(`${CONTROL}/ack`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ acks: acks.map((a) => ({ at: new Date().toISOString(), ...a })) }),
    });
  const script: StartScript =
    o.script ??
    ((c) => ({
      pauseMs: 400,
      events: true,
      acks: [
        { outcome: "taken", mode: "sdk" },
        { outcome: "delivered", mode: "sdk", session: c.session },
      ],
    }));
  const loop = o.offline
    ? Promise.resolve()
    : (async () => {
        while (!stopped) {
          const r = await fetch(`${CONTROL}?machine=${id}&wait=1`, { headers: auth }).catch(() => null);
          if (r?.status !== 200) continue;
          const { messages } = (await r.json()) as { messages: { id: string; cmd: string }[] };
          for (const m of messages) {
            const c = JSON.parse(m.cmd) as Record<string, unknown>;
            seen.push(c);
            const s = script(c);
            for (const [i, a] of s.acks.entries()) {
              await new Promise((res) => setTimeout(res, s.pauseMs ?? 300));
              const final = i === s.acks.length - 1;
              if (final && s.events && o.sinkToken) await startEvents(hello.name, c, o.sinkToken);
              await ack([{ id: m.id, ...a }]);
            }
          }
        }
      })();
  return {
    id,
    name: hello.name,
    token,
    seen,
    stop: async () => {
      stopped = true;
      await Promise.race([loop, new Promise((r) => setTimeout(r, 3000))]);
    },
  };
}

/** The first hook events of a started session, as its harness's hooks would send them. */
async function startEvents(machine: string, c: Record<string, unknown>, sinkToken: string): Promise<void> {
  const session = String(c.session);
  const harness = session.slice(0, session.indexOf(":"));
  const sid = session.slice(session.indexOf(":") + 1);
  let seq = 0;
  let clock = Date.now() - 2000;
  const turn = randomUUID();
  const ev = (type: string, data: Record<string, unknown>, hook: string) => {
    clock += 200;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 2,
      harness: { name: harness, version: "2.1.296", event: hook },
      session: { id: sid, seq: seq++, machine, cwd: String(c.cwd) },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  await fetch(`${CONTROL_BASE}/api/sessionpipe/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sinkToken}`, "sessionpipe-protocol": "1" },
    body: JSON.stringify({
      events: [
        ev("session.started", { source: "startup" }, "SessionStart"),
        ev("turn.started", { turn_id: turn, prompt_chars: String(c.text).length, prompt: c.text }, "UserPromptSubmit"),
      ],
    }),
  });
}

export async function sinkToken(): Promise<string> {
  const info = (await (await fetch(`${CONTROL_BASE}/api/ui/info`)).json()) as { sinkToken: string };
  return info.sinkToken;
}

/** A session on `machine` the board can show (and right-click), at tier 1. */
export async function postSession(
  token: string,
  o: { machine: string; harness?: string; cwd: string; title: string },
): Promise<{ harness: string; id: string }> {
  const harness = o.harness ?? "claude-code";
  const id = randomUUID();
  let seq = 0;
  let clock = Date.now() - 30_000;
  const ev = (type: string, data: Record<string, unknown>, hook: string) => {
    clock += 500;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: 1,
      harness: { name: harness, version: "2.1.296", event: hook },
      session: { id, seq: seq++, machine: o.machine, cwd: o.cwd, title: o.title, title_source: "custom" },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  await fetch(`${CONTROL_BASE}/api/sessionpipe/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "sessionpipe-protocol": "1" },
    body: JSON.stringify({ events: [ev("session.started", { source: "startup" }, "SessionStart")] }),
  });
  return { harness, id };
}

/** The setup page's first-run redirect and Simple mode stay out of these pages. */
export async function seenSetupHere(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    localStorage.setItem("sessionpipe-gui.setup.seen", "1");
    localStorage.setItem("sessionpipe-gui.settings", JSON.stringify({ mode: "advanced" }));
  });
}
