// SPDX-License-Identifier: Apache-2.0
/// <reference lib="dom" />
// Signed control from a test browser, against the second e2e instance (playwright.config.ts:
// `--test-door`, rp id localhost) over plain http on localhost, where passkeys work: a CDP
// virtual authenticator makes the browser's passkey, the test door trusts it for a machine
// and mints that machine's token, and a fake daemon (this process) says hello, long-polls
// and acks the way sessionpipe's does. Nothing here runs an agent; a "start" is answered
// with acks and a few hook events, which is all the receiver ever sees of one. A command
// that names files has each fetched first, with the machine's own token, and held to the
// size and hash that were signed, as a daemon does before it delivers anything.
import { createHash, randomUUID } from "node:crypto";
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
  mode?: "safe" | "auto" | "inherit";
  files?: boolean;
  /** CONTROL.md §2: it takes `files` on a `prompt` too (sessionpipe 0.10). */
  prompt_files?: boolean;
  start?: Record<string, { permissions: string[]; permission: string; models?: string[]; any_model?: boolean }>;
  version?: string;
  /** CONTROL.md §2: the kinds of key the machine takes (`["passkey","device"]` from 0.10). */
  key_types?: string[];
  /** The machine's account pool (sessionpipe 0.11), as the hello carries it. */
  pool?: Record<string, unknown>;
  /** CONTROL.md §13: its agents may ask each other; it takes `reply_to` (a handoff). */
  ask?: boolean;
  handoff?: boolean;
}

type Ack = Record<string, unknown> & { outcome: string };
/** What the daemon answers a start with: a list of acks (and a pause before each), and
 *  whether the session's first hook events go to the receiver before the final ack. */
export type StartScript = (cmd: Record<string, unknown>) => { acks: Ack[]; pauseMs?: number; events?: boolean };

/** One file a command named, as the daemon got it from GET {control}/files/{sha256}. */
export interface FetchedFile {
  /** The entry as signed. */
  name: string;
  type: string;
  size: number;
  sha256: string;
  /** What the receiver answered: its status and content-type, and the bytes' own length
   *  and SHA-256 (base64url), computed here. */
  status: number;
  contentType: string;
  bytes: number;
  hash: string;
  /** 200, and the bytes are the size and the hash that were signed. */
  ok: boolean;
}

export interface FakeDaemon {
  id: string;
  name: string;
  token: string;
  /** Long-poll and answer until stopped; `false` leaves it paired but never polling (offline). */
  stop(): Promise<void>;
  /** Every command it took, parsed. */
  seen: Record<string, unknown>[];
  /** The same commands as the exact strings that were signed. */
  cmds: string[];
  /** Every file those commands named, fetched and checked, in order. */
  fetched: FetchedFile[];
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
  const cmds: string[] = [];
  const fetched: FetchedFile[] = [];
  /** CONTROL.md §6, Files, step 1: each file by its hash, with the machine's token, held
   *  to the signed size and hash. False when one is not what was signed. */
  const fetchFiles = async (files: unknown): Promise<boolean> => {
    let whole = true;
    for (const f of (Array.isArray(files) ? files : []) as Pick<FetchedFile, "name" | "type" | "size" | "sha256">[]) {
      const r = await fetch(`${CONTROL}/files/${f.sha256}`, { headers: { authorization: `Bearer ${token}` } });
      const body = Buffer.from(await r.arrayBuffer());
      const hash = createHash("sha256").update(body).digest("base64url");
      const ok = r.status === 200 && body.length === f.size && hash === f.sha256;
      fetched.push({
        name: f.name,
        type: f.type,
        size: f.size,
        sha256: f.sha256,
        status: r.status,
        contentType: r.headers.get("content-type") ?? "",
        bytes: body.length,
        hash,
        ok,
      });
      whole &&= ok;
    }
    return whole;
  };
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
            cmds.push(m.cmd);
            // A file that fails is acked `failed` with code `file`, and nothing is delivered.
            if (c.files !== undefined && !(await fetchFiles(c.files))) {
              await ack([{ id: m.id, outcome: "failed", code: "file", detail: "a file did not arrive whole" }]);
              continue;
            }
            const s = script(c);
            for (const [i, a] of s.acks.entries()) {
              await new Promise((res) => setTimeout(res, s.pauseMs ?? 300));
              const final = i === s.acks.length - 1;
              // Only a start brings a session's first hook events (a key.add or a prompt has none).
              if (final && s.events && o.sinkToken && c.kind === "start") await startEvents(hello.name, c, o.sinkToken);
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
    cmds,
    fetched,
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

/** A Claude Code session on `machine` whose permission prompt was raised `agoMs` ago, as
 *  its hooks send one (`npm run deploy` for Bash, unless `tool` and `message` say
 *  otherwise); with `input`, at tier 3, the call's `tool.started` carries it. `clear()`
 *  closes the prompt again. */
export async function postPrompt(
  token: string,
  o: {
    machine: string;
    title: string;
    agoMs: number;
    harness?: string;
    tool?: string;
    message?: string;
    input?: Record<string, unknown>;
  },
): Promise<{ key: string; id: string; attention: string; clear: () => Promise<void> }> {
  const harness = o.harness ?? "claude-code";
  const tool = o.tool ?? "Bash";
  const id = randomUUID();
  const attention = `perm-${id.slice(0, 8)}`;
  let seq = 0;
  // The events half a second apart, the prompt last.
  let clock = Date.now() - o.agoMs - 1_500 - (o.input ? 500 : 0);
  const ev = (type: string, data: Record<string, unknown>, hook: string) => {
    clock = type === "attention.cleared" ? Date.now() : clock + 500;
    return {
      protocol: 1,
      id: ulid(clock),
      type,
      time: new Date(clock).toISOString(),
      tier: o.input ? 3 : 1,
      harness: { name: harness, version: "2.1.296", event: hook },
      session: { id, seq: seq++, machine: o.machine, cwd: "/Users/e2e/code", title: o.title, title_source: "custom" },
      privacy: { rulesets: ["secrets@1"], pii: false },
      data,
    };
  };
  const post = (events: unknown[]) =>
    fetch(`${CONTROL_BASE}/api/sessionpipe/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "sessionpipe-protocol": "1" },
      body: JSON.stringify({ events }),
    });
  await post([
    ev("session.started", { source: "startup" }, "SessionStart"),
    ev("turn.started", { turn_id: "t1", prompt_chars: 20 }, "UserPromptSubmit"),
    ...(o.input ? [ev("tool.started", { tool, call_id: "toolu_1", turn_id: "t1", input: o.input }, "PreToolUse")] : []),
    ev(
      "attention.needed",
      { attention_id: attention, kind: "permission", tool, message: o.message ?? "npm run deploy" },
      "PermissionRequest",
    ),
  ]);
  return {
    key: `${harness}:${id}`,
    id,
    attention,
    clear: async () => {
      await post([ev("attention.cleared", { attention_id: attention, how: "answered" }, "PreToolUse")]);
    },
  };
}

/** The setup page's first-run redirect and Simple mode stay out of these pages. */
export async function seenSetupHere(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    localStorage.setItem("sessionpipe-gui.setup.seen", "1");
    localStorage.setItem("sessionpipe-gui.settings", JSON.stringify({ mode: "advanced" }));
  });
}
