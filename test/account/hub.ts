// SPDX-License-Identifier: Apache-2.0
// Test helper: the native hub's half of "The phone on an account" (docs/rfcs/08), stood in.
// The real one is Rust (apps/crates/sp-receivers, apps/mobile); this plays the contract the
// page codes against, read from that section: an account as an entry of the receiver list
// with `kind: "spacesheep"`, the `acct_*` commands, the `account` event, the documents, and
// the page's six doors with the hub's own refusals (their status, their code in
// `x-sessionpipe-hub`, the body `{ hub: true, reason, error }` with the hub's own words).
// It holds the account's key and adds it; the page never sees it. Upstream is whatever
// answers as spacesheep does: the fake one in memory (fake-spacesheep.ts), or a real one
// over http for a run against a local spacesheep.
import { createHash } from "node:crypto";
import type { FakeAnswer, FakeClock, FakeRequest } from "./fake-spacesheep.js";

export const HUB_HEADER = "x-sessionpipe-hub";
const MIB = 1024 * 1024;

/** The hub's own refusals: status and words, as account.rs has them (`Refused::status`,
 *  `Refused::words`). `{Here}` is the device as the shell names it, at a sentence's start. */
const REFUSALS: Record<string, [number, string]> = {
  not_a_door: [403, "The app does not forward this to a spacesheep account."],
  bad_query: [400, "That request has a parameter the app does not forward."],
  bad_body: [400, "That request's body is not one the app forwards."],
  bad_header: [400, "That file's type or name is not one the app forwards."],
  not_signed: [400, "The app forwards only a signed command to a machine."],
  too_large: [413, "That is too large to send."],
  forbidden_origin: [403, "Only the app's own page may ask."],
  account_off: [403, "A spacesheep account is not available in this build."],
  bad_account: [403, "This account's entry is damaged. Disconnect and connect again."],
  not_connected: [401, "{Here} holds no key for the account. Connect again."],
  no_device_key: [409, "{Here} has not asked to be trusted yet."],
  busy: [429, "Too many requests at once."],
  not_sent: [502, "spacesheep could not be reached."],
  unreachable: [502, "spacesheep could not be reached."],
  timeout: [504, "spacesheep did not answer in time."],
  redirected: [502, "spacesheep answered with a redirect, which the app does not follow."],
  answer_too_large: [502, "spacesheep's answer is too large. Ask for less at once."],
  bad_encoding: [502, "spacesheep's answer could not be read."],
  withheld: [502, "spacesheep's answer was not one the app passes on."],
};

/** A sentence's first word, as the hub writes the device there ("This iPhone"). */
const sentenceStart = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

/** One of the hub's own answers. `here`: what the shell calls the device in a sentence
 *  ("this iPhone"); the hub's own word, until a shell says, is "this device". */
export const refusal = (code: string, here = "this device"): FakeAnswer => {
  const [status, words] = REFUSALS[code] ?? [502, code];
  const error = words.replace("{Here}", sentenceStart(here));
  return {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      [HUB_HEADER]: code,
      ...(code === "busy" ? { "retry-after": "1" } : {}),
    },
    body: JSON.stringify({ hub: true, reason: code, error }),
  };
};

/** A hub command's error, as the page gets it. */
export class HubRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly more: { retryAfterS?: number; upstream?: string } = {},
  ) {
    super(message);
  }
  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.more };
  }
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** The account's id: the SHA-256 of its origin and lowercase email, in base32 (id.rs). */
export function accountId(origin: string, email: string): string {
  const d = createHash("sha256").update(`spacesheep-account\n${origin}\n${email.trim().toLowerCase()}`).digest();
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of d) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

export interface Upstream {
  /** The account's origin, as the person knows it. */
  origin: string;
  ask(req: FakeRequest): Promise<FakeAnswer>;
}

export interface HubAccount {
  id: string;
  origin: string;
  email: string;
  state: "ok" | "unauthorized" | "no_key";
  connectedAt: string;
  key: string | null;
  deviceKeyId?: string;
  docs: Map<string, string>;
}

interface Connect {
  origin: string;
  digits: string;
  expiresAt: string;
  state: "pending" | "asking" | "approved" | "denied" | "declined" | "expired" | "failed";
  receiver?: string;
  email?: string;
  error?: string;
  /** A key was made on spacesheep and is not kept here: where to revoke it, and the words. */
  revokeUrl?: string;
  note?: string;
  code: string;
  poll: string;
  url: string;
  /** The approval the hub holds until the person answers here. */
  held?: { key: string; email: string; at: number };
}

/** The hub's words where a key was made on spacesheep and is not kept (account.rs). */
export const UNUSED_KEY_NOTE =
  "A key was made for this app on spacesheep and is not kept here. Revoke it there: Settings → API keys.";
/** `acct_disconnect`'s note, in the hub's own words (hub/acct.rs), which name the device as
 *  the app's platform has it: "this iPhone", or "this phone". */
export const disconnectNote = (thisPhone: string): string =>
  `The key is forgotten on ${thisPhone}. It keeps working until you revoke it on spacesheep: Settings → API keys.`;
/** Three connects an hour, five device asks an hour, the same device answer for ten minutes,
 *  a held approval for a quarter of an hour (account.rs). */
const STARTS_AN_HOUR = 3;
const ASKS_AN_HOUR = 5;
const SAME_ASK_MS = 600_000;
const HELD_MS = 900_000;
const HOUR = 3_600_000;
/** How far the hub's clock and spacesheep's may disagree (hub/acct.rs CLOCK_SLACK_MS). */
const CLOCK_SLACK_MS = 30_000;

const realClock: FakeClock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

const DOC_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const DIGITS = /^\d+$/;
const MACHINE_JOBS = /^\/api\/machines\/(m_[A-Za-z0-9_-]{16,40})\/jobs$/;
const BOX = /^m_box[0-9a-f]{16}$/;
const RELAY = "/api/sessionpipe/v1/relay";
const MACHINE_FILES = "/api/machines/files";
/** The largest file the files door carries (CONTROL.md's limit for one, 25 MiB). */
export const FILE_MAX = 26_214_400;
/** A file's type as CONTROL.md has it, at most 100 characters (account.rs is_media_type). */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
/** A file's name as the page percent-encodes it: 1 to 1024 visible ASCII characters. */
const FILE_NAME = /^[\x21-\x7e]{1,1024}$/;

/** How long the hub gives a request of `bytes` bytes (proxy.rs send_timeout): fifteen
 *  seconds and one more for each 32 KiB, at most ten minutes. */
export const sendTimeoutS = (bytes: number): number => Math.min(600, 15 + Math.ceil(bytes / 32_768));

/** One request of the page's to a door. A file's bytes come as `bytes`, its type and name as
 *  `headers` (every other header of the page's stays in the hub). */
export interface DoorRequest {
  method: string;
  path: string;
  body?: string;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  origin?: string;
  signal?: AbortSignal;
}

export interface HubOptions {
  upstream: Upstream;
  clock?: FakeClock;
  platform?: string;
  appVersion?: string;
  features?: string[];
  /** The origin the bundled page asks from; a door asked from another is refused. */
  appOrigin?: string;
}

export class HubStandIn {
  readonly accounts = new Map<string, HubAccount>();
  active: string | null = null;
  private readonly clock: FakeClock;
  private readonly listeners = new Set<(event: string, payload: unknown) => void>();
  private connecting: Connect | null = null;
  private connectTimer: unknown;
  private inFlight = 0;
  private relayReads = 0;
  /** The next this-many door requests find the account's room full (`busy`). */
  busy = 0;
  /** spacesheep cannot be reached: no connection can be made. A read is `unreachable`; a
   *  send is `not_sent`, the hub's word for a command of which nothing left the phone. */
  down = false;
  /** A connection is made and the answer stops on its way (`unreachable`, on a read and on
   *  a send): of a send nobody then knows whether a job was made. Here spacesheep did not
   *  get the command; `unheard` is the case where it did. */
  stopped = false;
  /** The system browser does not take the hub's link (`acct_connect_open` is `not_opened`). */
  openFails = false;
  /** The next this-many sends reach spacesheep and its answer does not come back in the
   *  hub's time: the page gets the hub's `timeout`, and spacesheep holds the job. */
  unheard = 0;
  /** Each door request takes this much longer, as a phone's network would make it. */
  latencyMs = 0;
  /** The phone's uplink for a file, in bytes a second (0: at once). The files door's time
   *  limit is `sendTimeoutS` of its bytes. */
  uplinkBytesPerS = 0;
  /** The most a relay answer may hold, unpacked (8 MiB in the hub; a test lowers it). */
  relayMax = 8 * MIB;
  /** The native alerts: what the person answers ("use this account?", "disconnect?"). `null`:
   *  the alert could not be shown (another is up, the app is in the background), which is
   *  no answer: an approval stays held and is asked about again (`nudge`), a disconnect is
   *  refused `not_asked`. */
  alert: (question: "use_account" | "disconnect", about: { email: string; host: string }) => boolean | null = () =>
    true;
  /** What keeping an approved account does: `ok`, or the failure the connect ends with. */
  keep: "ok" | "keystore" | "io" | "conflict" = "ok";
  /** The next `acct_connect_start` is refused with this, once. */
  startRefusal: HubRefused | null = null;
  /** A start waits for this before it asks spacesheep (a test holds the "connecting" moment). */
  holdStart: Promise<void> | null = null;
  /** A start takes this long to answer (the hub is asking spacesheep for a number). */
  startMs = 0;
  private startWait: ((cancelled: boolean) => void) | null = null;
  /** The hub's `account` events do not reach the page (the app is behind the browser, its
   *  page asleep): what changed is learned only by asking (`acct_status`). */
  mute = false;
  /** The documents the hub cannot read (`io`), by name: "labels", "marks", "limits", "sends". */
  unreadDocs = new Set<string>();
  /** `acct_disconnect` cannot remove the key (`io`: nothing was changed). */
  disconnectFails = false;
  /** When each connect was started and each device ask was made, for the hub's own limits. */
  private starts: number[] = [];
  private asks: number[] = [];
  private lastAsk: { id: string; at: number; answer: Record<string, unknown> } | null = null;
  /** This phone's own device key, as the signer holds it (`acct_device_ask` reads it natively). */
  deviceKey: Record<string, unknown> | null = null;
  /** What `acct_connect_open` opened in the system browser. */
  opened: string[] = [];
  /** What the page handed over with `acct_needs`, newest last. */
  needs: { id: string; sessions: unknown[] }[] = [];
  /** Every door request the page made: "GET /api/…" and the hub's own code, or the status. */
  log: string[] = [];

  constructor(private readonly o: HubOptions) {
    this.clock = o.clock ?? realClock;
  }

  /** The device in the hub's sentences, as the real hub words it on each platform. */
  private get thisPhone(): string {
    return (this.o.platform ?? "ios") === "android" ? "this phone" : "this iPhone";
  }

  get upstream(): Upstream {
    return this.o.upstream;
  }

  /** An account as a connect leaves it, without the connect: its key is kept and it is active. */
  add(email: string, key: string, at = this.clock.now()): HubAccount {
    const origin = this.o.upstream.origin;
    const id = accountId(origin, email);
    const a: HubAccount = {
      id,
      origin,
      email,
      state: "ok",
      connectedAt: new Date(at).toISOString(),
      key,
      docs: this.accounts.get(id)?.docs ?? new Map(),
    };
    this.accounts.set(id, a);
    this.active = id;
    this.say();
    return a;
  }

  /** `window.sessionpipeShell`, as the window opens. */
  contract(): Record<string, unknown> {
    const a = this.active ? this.accounts.get(this.active) : undefined;
    return {
      v: 1,
      platform: this.o.platform ?? "ios",
      appVersion: this.o.appVersion ?? "0.9.0",
      // As the iPhone's shell lists them: "account", and always with it "account-needs".
      features: this.o.features ?? ["notifications", "signer", "haptics", "scanner", "account", "account-needs"],
      receiver: a
        ? {
            id: a.id,
            name: a.email,
            origin: a.origin,
            local: false,
            kind: "spacesheep",
            email: a.email,
            state: a.state,
          }
        : null,
      rxBase: a ? this.rxBase(a.id) : null,
    };
  }

  /** Where the page asks the doors of account `id`; the server in front of this decides. */
  rxBase: (id: string) => string = (id) => `rx://localhost/${id}`;

  on(l: (event: string, payload: unknown) => void): () => void {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }

  status(): Record<string, unknown> {
    const c = this.connecting;
    return {
      enabled: true,
      accounts: [...this.accounts.values()].map((a) => ({
        id: a.id,
        origin: a.origin,
        email: a.email,
        state: a.state,
        connectedAt: a.connectedAt,
        active: a.id === this.active,
        ...(a.deviceKeyId ? { deviceKeyId: a.deviceKeyId } : {}),
      })),
      connect: c
        ? {
            origin: c.origin,
            digits: c.digits,
            expiresAt: c.expiresAt,
            state: c.state,
            ...(c.receiver ? { receiver: c.receiver, email: c.email } : {}),
            ...(c.error ? { error: c.error, errorMessage: this.failedWords(c.error) } : {}),
            ...(c.note ? { revokeUrl: c.revokeUrl, note: c.note } : {}),
          }
        : null,
    };
  }

  /** The hub's sentence for a connect that failed, beside its word (`errorMessage`). */
  private failedWords(error: string): string {
    const revoke = "Connect again, and revoke the unused key on spacesheep (Settings → API keys).";
    if (error === "conflict") return "That account can't be kept beside the ones already here.";
    if (error === "keystore") return `The key could not be kept on ${this.thisPhone}. ${revoke}`;
    if (error === "io") return `The account could not be saved on ${this.thisPhone}. ${revoke}`;
    return "spacesheep's answer can't be used by this version.";
  }

  private say(): void {
    const status = this.status();
    if (this.mute) return;
    for (const l of [...this.listeners]) l("account", status);
  }

  private mark(a: HubAccount, state: HubAccount["state"]): void {
    if (a.state === state) return;
    a.state = state;
    this.say();
  }

  // ---------- the commands ----------

  async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    switch (cmd) {
      case "acct_status":
        return this.status();
      case "acct_connect_start": {
        if (this.startMs > 0) {
          // Asking spacesheep for a number takes a while; a cancel meanwhile ends the start.
          const cancelled = await new Promise<boolean>((r) => {
            this.startWait = r;
            this.clock.setTimeout(() => r(false), this.startMs);
          });
          this.startWait = null;
          if (cancelled) throw new HubRefused("cancelled", "Cancelled.");
        }
        return this.connectStart();
      }
      case "acct_connect_open": {
        const c = this.connecting;
        if (c?.state !== "pending") throw new HubRefused("no_connect", "No connect is waiting.");
        if (this.openFails) throw new HubRefused("not_opened", "The browser could not be opened.");
        this.opened.push(c.url);
        return null;
      }
      case "acct_connect_cancel": {
        this.startWait?.(true);
        const was = this.connecting;
        if (this.connectTimer) this.clock.clearTimeout(this.connectTimer);
        // Cancelled while the person was being asked here: the key was made and is not kept.
        if (was?.state === "asking") {
          this.unkept(was, "declined");
          return true;
        }
        this.connecting = null;
        this.say();
        return was?.state === "pending";
      }
      case "acct_disconnect":
        return this.disconnect(this.account(args.id));
      case "acct_device_ask":
        return this.deviceAsk(this.account(args.id));
      case "acct_doc_get": {
        const a = this.account(args.id);
        if (this.unreadDocs.has(String(args.name))) throw new HubRefused("io", "The document could not be read.");
        const text = a.docs.get(this.docName(args.name));
        return text === undefined ? null : (JSON.parse(text) as unknown);
      }
      case "acct_doc_set": {
        const a = this.account(args.id);
        const name = this.docName(args.name);
        const text = JSON.stringify(args.value);
        if (text === undefined || Buffer.byteLength(text) > MIB)
          throw new HubRefused("too_large", "A document is at most 1 MiB.");
        if (!a.docs.has(name) && a.docs.size >= 8)
          throw new HubRefused("too_many", "An account keeps at most eight documents.");
        a.docs.set(name, text);
        return Buffer.byteLength(text);
      }
      case "acct_doc_delete":
        return this.account(args.id).docs.delete(this.docName(args.name));
      case "acct_needs": {
        const a = this.account(args.id);
        // As the hub: a list, of at most 200 sessions, 16 attentions a session, 200 in all.
        const all = Array.isArray(args.sessions) ? (args.sessions as { openAttentions?: unknown[] }[]) : null;
        const counts = all?.map((x) => (Array.isArray(x?.openAttentions) ? x.openAttentions.length : 0)) ?? [];
        if (!all || all.length > 200 || counts.some((n) => n > 16) || counts.reduce((a, n) => a + n, 0) > 200)
          throw new HubRefused("bad_request", "That is not a list of sessions.");
        this.needs.push({ id: a.id, sessions: all });
        // How many of the account's sessions need the person now.
        return all.length;
      }
      case "rx_list":
        // A receiver's row, with the three an account adds (kind, email, state now).
        return [...this.accounts.values()].map((a) => ({
          id: a.id,
          name: a.email,
          origin: a.origin,
          local: false,
          connected: a.state === "ok",
          kind: "spacesheep",
          email: a.email,
          state: a.state,
        }));
      case "rx_select": {
        this.active = this.account(args.id).id;
        this.say();
        return null;
      }
      case "rx_stream":
        throw "account_no_stream";
      case "rx_remove":
        throw new HubRefused("forbidden", "An account is removed by disconnecting it.");
      default:
        throw new HubRefused("unknown_command", cmd);
    }
  }

  private account(id: unknown): HubAccount {
    const a = typeof id === "string" ? this.accounts.get(id) : undefined;
    if (!a) throw new HubRefused("unknown_account", "No such account.");
    return a;
  }
  private docName(name: unknown): string {
    if (typeof name !== "string" || !DOC_NAME.test(name)) throw new HubRefused("bad_name", "Not a document's name.");
    return name;
  }

  /** A connect that ends with a key made on spacesheep and not kept here. */
  private unkept(c: Connect, state: Connect["state"], error?: string): void {
    c.state = state;
    if (error) c.error = error;
    c.revokeUrl = `${c.origin}/settings/api-keys`;
    c.note = UNUSED_KEY_NOTE;
    delete c.held;
    this.say();
  }

  /** The hub's own counts (three starts an hour, five asks) start over: a test that walks
   *  every way a connect can end makes more of them than a person may. */
  resetLimits(): void {
    this.starts = [];
    this.asks = [];
    this.lastAsk = null;
  }

  private async connectStart(): Promise<unknown> {
    const origin = this.o.upstream.origin;
    const host = new URL(origin).host;
    if (this.holdStart) await this.holdStart;
    if (!(this.o.features ?? ["account"]).includes("account"))
      throw new HubRefused("unsupported", "A spacesheep account is not available in this build.");
    if (this.startRefusal) {
      const e = this.startRefusal;
      this.startRefusal = null;
      throw e;
    }
    if (this.connecting?.state === "asking")
      throw new HubRefused("busy", `An account was approved and waits for your answer on ${this.thisPhone}.`);
    if ([...this.accounts.values()].some((a) => a.origin === origin && a.state === "ok"))
      throw new HubRefused("already_connected", "Already connected. Disconnect first.");
    if (this.connecting?.state === "pending") return this.status().connect;
    const now = this.clock.now();
    this.starts = this.starts.filter((t) => now - t < HOUR);
    if (this.starts.length >= STARTS_AN_HOUR)
      throw new HubRefused("too_many_starts", "Too many tries. Wait a while, then connect again.", {
        retryAfterS: Math.ceil((this.starts[0]! + HOUR - now) / 1000),
      });
    if (this.down) throw new HubRefused("unreachable", `Couldn't reach ${host}: timed out`);
    const r = await this.o.upstream.ask({
      method: "POST",
      path: "/api/gui/connect",
      body: JSON.stringify({ device: "iPhone", version: this.o.appVersion ?? "0.9.0" }),
    });
    if (r.status === 429)
      throw new HubRefused("rate_limited", "spacesheep asked to wait a bit. Try again in a minute.", {
        retryAfterS: Number(r.headers["retry-after"] ?? 60) || 60,
      });
    if (r.status !== 201)
      throw new HubRefused("refused", `${host} answered ${r.status}. Is it a spacesheep this version knows?`);
    let j: { code: string; digits: string; url: string; poll_token: string; expires_at: string };
    try {
      j = JSON.parse(r.body) as typeof j;
      if (!j.code || !j.digits || !j.poll_token) throw new Error("no code");
    } catch {
      throw new HubRefused("bad_answer", `${host}'s answer can't be used: not JSON.`);
    }
    this.starts.push(now);
    this.connecting = {
      origin,
      digits: j.digits,
      expiresAt: j.expires_at,
      state: "pending",
      code: j.code,
      poll: j.poll_token,
      url: j.url,
    };
    this.schedulePoll(800);
    this.say();
    return this.status().connect;
  }

  private schedulePoll(ms: number): void {
    if (this.connectTimer) this.clock.clearTimeout(this.connectTimer);
    this.connectTimer = this.clock.setTimeout(() => void this.pollConnect(), ms);
  }

  /** One poll of the connect now (the hub polls by itself; a test need not wait for it). */
  async pollConnect(): Promise<void> {
    const c = this.connecting;
    if (c?.state !== "pending") return;
    const r = await this.o.upstream
      .ask({
        method: "GET",
        path: `/api/gui/connect/poll?code=${encodeURIComponent(c.code)}`,
        authorization: `Bearer ${c.poll}`,
      })
      .catch(() => null);
    if (this.connecting !== c) return;
    const j = r && r.status === 200 ? (JSON.parse(r.body) as { state?: string; key?: string; email?: string }) : null;
    if (j?.state === "approved" && j.key && j.email) {
      // The key is held, not kept: the person is asked whose account this phone will show.
      c.state = "asking";
      c.held = { key: j.key, email: j.email, at: this.clock.now() };
      this.say();
      return this.nudge();
    }
    if (r && r.status === 200 && !j?.state) {
      c.state = "failed";
      c.error = "bad_answer";
    } else if (j?.state === "denied") c.state = "denied";
    else if (r && r.status === 410) {
      // spacesheep keeps a code nobody answered until its end: one it no longer knows before
      // then was answered, and the answer not collected in time. For a yes, a key was made.
      if (this.clock.now() + CLOCK_SLACK_MS < Date.parse(c.expiresAt)) return this.unkept(c, "expired");
      c.state = "expired";
    } else return this.schedulePoll(2000);
    this.say();
  }

  /** The held approval's question, asked (again): when the hub got the key, when the app
   *  comes to the front, every fifteen seconds meanwhile. Only an answer ends it; held for a
   *  quarter of an hour at most. */
  nudge(): void {
    const c = this.connecting;
    if (c?.state !== "asking" || !c.held) return;
    if (this.clock.now() - c.held.at >= HELD_MS) {
      this.unkept(c, "expired");
      return;
    }
    const answer = this.alert("use_account", { email: c.held.email, host: new URL(c.origin).host });
    if (answer === null) return;
    if (!answer) {
      this.unkept(c, "declined");
      return;
    }
    if (this.keep !== "ok") {
      this.unkept(c, "failed", this.keep);
      return;
    }
    const a = this.add(c.held.email, c.held.key);
    delete c.held;
    c.state = "approved";
    c.receiver = a.id;
    c.email = a.email;
    this.say();
  }

  private disconnect(a: HubAccount): unknown {
    const answer = this.alert("disconnect", { email: a.email, host: new URL(a.origin).host });
    if (answer === null) throw new HubRefused("not_asked", "The question could not be shown. Try again.");
    if (!answer) throw new HubRefused("cancelled", "Cancelled.");
    if (this.disconnectFails)
      throw new HubRefused("io", `The key could not be removed from ${this.thisPhone}. Nothing was changed.`);
    this.accounts.delete(a.id);
    if (this.active === a.id) this.active = null;
    this.say();
    return {
      id: a.id,
      origin: a.origin,
      email: a.email,
      forgotten: true,
      revoked: false,
      revokeUrl: `${a.origin}/settings/api-keys`,
      note: disconnectNote(this.thisPhone),
    };
  }

  private async deviceAsk(a: HubAccount): Promise<unknown> {
    if (!this.deviceKey) throw new HubRefused("unsupported", "Sending from this phone comes in a later version.");
    if (!a.key) throw this.problem("not_connected");
    const now = this.clock.now();
    // Asked again within ten minutes for the same key: the answer it got then, no request.
    if (this.lastAsk && this.lastAsk.id === a.id && now - this.lastAsk.at < SAME_ASK_MS) return this.lastAsk.answer;
    this.asks = this.asks.filter((t) => now - t < HOUR);
    if (this.asks.length >= ASKS_AN_HOUR)
      throw new HubRefused("too_many_asks", "Too many tries. Wait a while, then ask again.", {
        retryAfterS: Math.ceil((this.asks[0]! + HOUR - now) / 1000),
      });
    if (this.down || this.stopped) throw this.problem("unreachable");
    this.asks.push(now);
    const r = await this.o.upstream.ask({
      method: "POST",
      path: "/api/gui/device",
      authorization: `Bearer ${a.key}`,
      body: JSON.stringify({ key: this.deviceKey, name: "iPhone" }),
    });
    const j = JSON.parse(r.body || "{}") as Record<string, unknown>;
    // spacesheep's own code beside the hub's, where it gave one.
    const upstream = typeof j.code === "string" && j.code ? { upstream: j.code } : {};
    if (r.status === 401) {
      this.mark(a, "unauthorized");
      throw new HubRefused("unauthorized", String(j.error ?? "spacesheep answered 401."), upstream);
    }
    if (r.status < 200 || r.status >= 300)
      throw new HubRefused(
        r.status === 429 ? "rate_limited" : "refused",
        String(j.error ?? `spacesheep answered ${r.status}.`),
        upstream,
      );
    if (typeof j.code !== "string" || typeof j.key_id !== "string")
      throw new HubRefused("bad_answer", "spacesheep's answer can't be used by this version.");
    a.deviceKeyId = String(j.key_id);
    this.say();
    const answer = {
      code: String(j.code),
      keyId: a.deviceKeyId,
      trustedOn: (j.trusted_on as string[] | undefined) ?? [],
      devicesUrl: j.devices_url,
    };
    this.lastAsk = { id: a.id, at: now, answer };
    return answer;
  }

  /** One of the hub's own refusals as a command's error: its code, its words for this device. */
  private problem(code: string): HubRefused {
    return new HubRefused(code, (JSON.parse(this.refuse(code).body) as { error: string }).error);
  }
  private refuse(code: string): FakeAnswer {
    return refusal(code, this.thisPhone);
  }

  /** The person asked again after the request was dropped: the hub's ten minutes are over. */
  forgetAsk(): void {
    this.lastAsk = null;
  }

  // ---------- the doors ----------

  /** `ask`'s answer when it comes within the hub's limit for `bytes`; null when it does not
   *  (the request is then given up). */
  private async inTime(
    bytes: number,
    outer: AbortSignal | undefined,
    ask: (signal: AbortSignal) => Promise<FakeAnswer>,
  ): Promise<FakeAnswer | null> {
    const ac = new AbortController();
    const stop = () => ac.abort();
    outer?.addEventListener("abort", stop);
    let timer: unknown;
    const late = new Promise<null>((r) => {
      timer = this.clock.setTimeout(() => {
        ac.abort();
        r(null);
      }, sendTimeoutS(bytes) * 1000);
    });
    const answer = ask(ac.signal);
    // Given up on, it may still fail: that is no one's to hear.
    answer.catch(() => {});
    try {
      return await Promise.race([answer, late]);
    } finally {
      this.clock.clearTimeout(timer);
      outer?.removeEventListener("abort", stop);
    }
  }

  /** One request of the page's to `${rxBase(id)}<path>`. `origin`: who asks. */
  async door(id: string, req: DoorRequest): Promise<FakeAnswer> {
    const answer = await this.doorAnswer(id, req);
    this.log.push(`${req.method} ${req.path.split("?")[0]} ${answer.headers[HUB_HEADER] ?? answer.status}`);
    return answer;
  }

  private async doorAnswer(id: string, req: DoorRequest): Promise<FakeAnswer> {
    if (this.o.appOrigin && req.origin !== this.o.appOrigin) return this.refuse("forbidden_origin");
    const a = this.accounts.get(id);
    if (!a) return this.refuse("not_a_door");
    const q = req.path.indexOf("?");
    const path = q < 0 ? req.path : req.path.slice(0, q);
    const query = q < 0 ? "" : req.path.slice(q + 1);
    // A path is a door only when it is written exactly so.
    if (path.includes("..") || path.includes("//") || path.includes("%") || path.endsWith("/"))
      return this.refuse("not_a_door");
    const jobs = MACHINE_JOBS.exec(path);
    let door: "relay" | "machines" | "jobs" | "send" | "files" | "device";
    if (req.method === "GET" && path === RELAY) door = "relay";
    else if (req.method === "GET" && path === `${RELAY}/machines`) door = "machines";
    else if (req.method === "GET" && path === `${RELAY}/jobs`) door = "jobs";
    else if (req.method === "POST" && jobs && !BOX.test(jobs[1]!)) door = "send";
    else if (req.method === "POST" && path === MACHINE_FILES) door = "files";
    else if (req.method === "GET" && path === "/api/gui/device") door = "device";
    else return this.refuse("not_a_door");

    // The query: plain digits, each parameter once, only those the door takes.
    const allowed: Record<string, [number, number]> =
      door === "relay"
        ? { since: [0, Number.MAX_SAFE_INTEGER], limit: [1, 500], wait: [0, 25] }
        : door === "jobs"
          ? { since: [0, Number.MAX_SAFE_INTEGER] }
          : {};
    const params: [string, string][] = [];
    for (const part of query ? query.split("&") : []) {
      const [k, v, ...rest] = part.split("=");
      const range = k ? allowed[k] : undefined;
      if (!k || v === undefined || rest.length || !range || !DIGITS.test(v) || params.some(([n]) => n === k))
        return this.refuse("bad_query");
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n < range[0] || n > range[1]) return this.refuse("bad_query");
      params.push([k, v]);
    }

    // A file's type and name: the only headers of the page's that go on, and only from here.
    const fileHeaders: Record<string, string> = {};
    if (door === "files") {
      const type = req.headers?.["content-type"];
      const name = req.headers?.["x-file-name"];
      if (!type || type.length > 100 || !MEDIA_TYPE.test(type)) return this.refuse("bad_header");
      if (name !== undefined && !FILE_NAME.test(name)) return this.refuse("bad_header");
      fileHeaders["content-type"] = type;
      if (name !== undefined) fileHeaders["x-file-name"] = name;
    }

    // The body: none on a GET; on a send, a signed command within the limit; a file's bytes.
    const bytes = req.bytes ?? new TextEncoder().encode(req.body ?? "");
    if (door === "files") {
      if (bytes.length > FILE_MAX) return this.refuse("too_large");
      if (!bytes.length) return this.refuse("bad_body");
    } else if (door !== "send") {
      if (req.body) return this.refuse("bad_body");
    } else {
      const raw = req.body ?? "";
      if (Buffer.byteLength(raw) > 256 * 1024) return this.refuse("too_large");
      let o: unknown;
      try {
        o = JSON.parse(raw);
      } catch {
        return this.refuse("bad_body");
      }
      if (!o || typeof o !== "object" || Array.isArray(o)) return this.refuse("bad_body");
      if (!isSignedCommand(o as Record<string, unknown>)) return this.refuse("not_signed");
    }
    if (!a.key) return this.refuse("not_connected");
    if (door === "device" && !a.deviceKeyId) return this.refuse("no_device_key");

    // The account's room: six of the page's requests in flight, of which two relay reads.
    if (this.busy > 0) {
      this.busy--;
      return this.refuse("busy");
    }
    if (this.inFlight >= 6 || (door === "relay" && this.relayReads >= 2)) return this.refuse("busy");
    // No connection: of a send nothing left the phone (`not_sent`); a read is `unreachable`.
    if (this.down) return this.refuse(door === "send" ? "not_sent" : "unreachable");
    if (this.stopped) return this.refuse("unreachable");
    this.inFlight++;
    if (door === "relay") this.relayReads++;
    let res: FakeAnswer;
    try {
      if (this.latencyMs > 0) await new Promise<void>((r) => this.clock.setTimeout(r, this.latencyMs));
      const rebuilt = door === "device" ? `id=${a.deviceKeyId}` : params.map(([k, v]) => `${k}=${v}`).join("&");
      const asked = (signal?: AbortSignal) =>
        this.o.upstream.ask({
          method: req.method,
          path: rebuilt ? `${path}?${rebuilt}` : path,
          authorization: `Bearer ${a.key}`,
          ...(door === "send" ? { body: req.body } : {}),
          ...(door === "files" ? { bytes, headers: fileHeaders } : {}),
          signal,
        });
      if (door === "files") {
        const answered = await this.inTime(bytes.length, req.signal, async (signal) => {
          if (this.uplinkBytesPerS > 0)
            await new Promise<void>((r) => this.clock.setTimeout(r, (bytes.length / this.uplinkBytesPerS) * 1000));
          return asked(signal);
        });
        if (!answered) return this.refuse("timeout");
        res = answered;
      } else res = await asked(req.signal);
    } catch {
      return this.refuse("unreachable");
    } finally {
      this.inFlight--;
      if (door === "relay") this.relayReads--;
    }
    if (door === "send" && this.unheard > 0) {
      this.unheard--;
      return this.refuse("timeout");
    }
    // A redirect is not followed. Whoever redirected a send had the command: `unreachable`,
    // which the page reads as unknown; `redirected` is said of a read only.
    if (res.status >= 300 && res.status < 400) return this.refuse(door === "send" ? "unreachable" : "redirected");
    if (Buffer.byteLength(res.body) > (door === "relay" ? this.relayMax : MIB)) return this.refuse("answer_too_large");
    if (res.body.includes(a.key)) return this.refuse("withheld");
    // spacesheep's own 401 marks the account (on a send only its `unauthorized`; on the files
    // door never, as an older spacesheep says `unauthorized` there to a live key); a 2xx clears it.
    if (res.status === 401 && door !== "files") {
      let code = "";
      try {
        code = String((JSON.parse(res.body) as { code?: unknown }).code ?? "");
      } catch {
        /* no code */
      }
      if (door !== "send" || code === "unauthorized") this.mark(a, "unauthorized");
    } else if (res.status >= 200 && res.status < 300) this.mark(a, "ok");
    const headers: Record<string, string> = { "cache-control": "no-store" };
    for (const h of ["content-type", "retry-after"]) if (res.headers[h]) headers[h] = res.headers[h]!;
    return { status: res.status, headers, body: res.body };
  }
}

/** A send as the signer writes one: `{ cmd, csig, grant }` or `{ cmd, confirm }`, with
 *  `match` beside a confirm only, and no other field (account.rs is_signed_command). */
export function isSignedCommand(o: Record<string, unknown>): boolean {
  for (const k of Object.keys(o)) if (!["cmd", "csig", "grant", "confirm", "match"].includes(k)) return false;
  let cmd = false;
  if (typeof o.cmd === "string") {
    try {
      const c = JSON.parse(o.cmd) as unknown;
      cmd = !!c && typeof c === "object" && !Array.isArray(c);
    } catch {
      /* not JSON */
    }
  }
  const given = (k: string): unknown => (o[k] === null || o[k] === undefined ? undefined : o[k]);
  const text = (k: string) => given(k) === undefined || (typeof given(k) === "string" && given(k) !== "");
  const object = (k: string) => given(k) === undefined || (typeof given(k) === "object" && !Array.isArray(given(k)));
  const byGrant = given("csig") !== undefined && given("grant") !== undefined;
  const byConfirm = given("confirm") !== undefined;
  const m = given("match");
  const matched =
    m === undefined ||
    (byConfirm &&
      ((typeof m === "string" && /^\d{1,8}$/.test(m)) ||
        (typeof m === "number" && Number.isInteger(m) && m >= 0 && m < 100_000_000)));
  return cmd && text("csig") && object("grant") && object("confirm") && matched && (byGrant || byConfirm);
}
