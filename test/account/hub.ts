// SPDX-License-Identifier: Apache-2.0
// Test helper: the native hub's half of "The phone on an account" (docs/rfcs/08), stood in.
// The real one is Rust (apps/crates/sp-receivers, apps/mobile); this plays the contract the
// page codes against, read from that section: an account as an entry of the receiver list
// with `kind: "spacesheep"`, the `acct_*` commands, the `account` event, the documents, and
// the five doors with the hub's own refusals (their status, their code in
// `x-sessionpipe-hub`, the body `{ hub: true, reason, error }` with the hub's own words).
// It holds the account's key and adds it; the page never sees it. Upstream is whatever
// answers as spacesheep does: the fake one in memory (fake-spacesheep.ts), or a real one
// over http for a run against a local spacesheep.
import { createHash } from "node:crypto";
import type { FakeAnswer, FakeClock, FakeRequest } from "./fake-spacesheep.js";

export const HUB_HEADER = "x-sessionpipe-hub";
const MIB = 1024 * 1024;

/** The hub's own refusals: status and words, as account.rs has them. */
const REFUSALS: Record<string, [number, string]> = {
  not_a_door: [403, "The app does not forward this to a spacesheep account."],
  bad_query: [400, "That request has a parameter the app does not forward."],
  bad_body: [400, "That request's body is not one the app forwards."],
  not_signed: [400, "The app forwards only a signed command to a machine."],
  too_large: [413, "That is too large to send."],
  forbidden_origin: [403, "Only the app's own page may ask."],
  account_off: [403, "A spacesheep account is not available in this build."],
  bad_account: [403, "This account's entry is damaged. Disconnect and connect again."],
  not_connected: [401, "This device holds no key for the account. Connect again."],
  no_device_key: [409, "This device has not asked to be trusted yet."],
  busy: [429, "Too many requests at once."],
  unreachable: [502, "spacesheep could not be reached."],
  timeout: [504, "spacesheep did not answer in time."],
  redirected: [502, "spacesheep answered with a redirect, which the app does not follow."],
  answer_too_large: [502, "spacesheep's answer is too large. Ask for less at once."],
  bad_encoding: [502, "spacesheep's answer could not be read."],
  withheld: [502, "spacesheep's answer was not one the app passes on."],
};

export const refusal = (code: string): FakeAnswer => {
  const [status, error] = REFUSALS[code] ?? [502, code];
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
  code: string;
  poll: string;
  url: string;
}

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
  /** spacesheep cannot be reached (`unreachable`). */
  down = false;
  /** Each door request takes this much longer, as a phone's network would make it. */
  latencyMs = 0;
  /** The most a relay answer may hold, unpacked (8 MiB in the hub; a test lowers it). */
  relayMax = 8 * MIB;
  /** The native alerts: what the person answers ("use this account?", "disconnect?"). */
  alert: (question: "use_account" | "disconnect", about: { email: string; host: string }) => boolean = () => true;
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
      features: this.o.features ?? ["notifications", "signer", "haptics", "scanner", "account"],
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
            ...(c.error ? { error: c.error } : {}),
          }
        : null,
    };
  }

  private say(): void {
    const status = this.status();
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
      case "acct_connect_start":
        return this.connectStart();
      case "acct_connect_open": {
        const c = this.connecting;
        if (c?.state !== "pending") throw new HubRefused("no_connect", "No connect is under way.");
        this.opened.push(c.url);
        return null;
      }
      case "acct_connect_cancel": {
        const was = this.connecting;
        this.connecting = null;
        if (this.connectTimer) this.clock.clearTimeout(this.connectTimer);
        this.say();
        return was?.state === "pending";
      }
      case "acct_disconnect":
        return this.disconnect(this.account(args.id));
      case "acct_device_ask":
        return this.deviceAsk(this.account(args.id));
      case "acct_doc_get": {
        const a = this.account(args.id);
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
        if (!Array.isArray(args.sessions)) throw new HubRefused("bad_request", "sessions is a list.");
        this.needs.push({ id: a.id, sessions: args.sessions });
        return true;
      }
      case "rx_list":
        return this.status().accounts;
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
    if (!a) throw new HubRefused("unknown_account", "No such account on this phone.");
    return a;
  }
  private docName(name: unknown): string {
    if (typeof name !== "string" || !DOC_NAME.test(name)) throw new HubRefused("bad_name", "Not a document's name.");
    return name;
  }

  private async connectStart(): Promise<unknown> {
    const origin = this.o.upstream.origin;
    if ([...this.accounts.values()].some((a) => a.origin === origin && a.state === "ok"))
      throw new HubRefused("already_connected", "An account at that origin is connected. Disconnect it first.");
    if (this.connecting?.state === "pending") return this.status().connect;
    const r = await this.o.upstream.ask({
      method: "POST",
      path: "/api/gui/connect",
      body: JSON.stringify({ device: "iPhone", version: this.o.appVersion ?? "0.9.0" }),
    });
    if (r.status !== 201) throw new HubRefused("refused", `${origin} answered ${r.status}.`);
    const j = JSON.parse(r.body) as {
      code: string;
      digits: string;
      url: string;
      poll_token: string;
      expires_at: string;
    };
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
      this.say();
      const host = new URL(c.origin).host;
      if (!this.alert("use_account", { email: j.email, host })) {
        c.state = "declined";
        return this.say();
      }
      const a = this.add(j.email, j.key);
      c.state = "approved";
      c.receiver = a.id;
      c.email = a.email;
      return this.say();
    }
    if (j?.state === "denied") c.state = "denied";
    else if (r && r.status === 410) c.state = "expired";
    else return this.schedulePoll(2000);
    this.say();
  }

  private disconnect(a: HubAccount): unknown {
    if (!this.alert("disconnect", { email: a.email, host: new URL(a.origin).host }))
      throw new HubRefused("cancelled", "Not disconnected.");
    this.accounts.delete(a.id);
    if (this.active === a.id) this.active = null;
    this.say();
    return {
      id: a.id,
      origin: a.origin,
      email: a.email,
      forgotten: true,
      revoked: false,
      revokeUrl: `${a.origin}/settings`,
      note: "The key is forgotten on this phone. To end it for good, revoke it on spacesheep: Settings → API keys.",
    };
  }

  private async deviceAsk(a: HubAccount): Promise<unknown> {
    if (!this.deviceKey) throw new HubRefused("unsupported", "This device has no signer.");
    if (!a.key) throw new HubRefused("unauthorized", "This device holds no key for the account.");
    const r = await this.o.upstream.ask({
      method: "POST",
      path: "/api/gui/device",
      authorization: `Bearer ${a.key}`,
      body: JSON.stringify({ key: this.deviceKey, name: "iPhone" }),
    });
    const j = JSON.parse(r.body || "{}") as Record<string, unknown>;
    if (r.status === 401) throw new HubRefused("unauthorized", String(j.error ?? "The key is refused."));
    if (r.status < 200 || r.status >= 300)
      throw new HubRefused("refused", String(j.error ?? `spacesheep answered ${r.status}.`), {
        upstream: String(j.code ?? ""),
      });
    a.deviceKeyId = String(j.key_id);
    this.say();
    return { code: String(j.code), keyId: a.deviceKeyId, trustedOn: j.trusted_on ?? [], devicesUrl: j.devices_url };
  }

  // ---------- the doors ----------

  /** One request of the page's to `${rxBase(id)}<path>`. `origin`: who asks. */
  async door(
    id: string,
    req: { method: string; path: string; body?: string; origin?: string; signal?: AbortSignal },
  ): Promise<FakeAnswer> {
    const answer = await this.doorAnswer(id, req);
    this.log.push(`${req.method} ${req.path.split("?")[0]} ${answer.headers[HUB_HEADER] ?? answer.status}`);
    return answer;
  }

  private async doorAnswer(
    id: string,
    req: { method: string; path: string; body?: string; origin?: string; signal?: AbortSignal },
  ): Promise<FakeAnswer> {
    if (this.o.appOrigin && req.origin !== this.o.appOrigin) return refusal("forbidden_origin");
    const a = this.accounts.get(id);
    if (!a) return refusal("not_a_door");
    const q = req.path.indexOf("?");
    const path = q < 0 ? req.path : req.path.slice(0, q);
    const query = q < 0 ? "" : req.path.slice(q + 1);
    // A path is a door only when it is written exactly so.
    if (path.includes("..") || path.includes("//") || path.includes("%") || path.endsWith("/"))
      return refusal("not_a_door");
    const jobs = MACHINE_JOBS.exec(path);
    let door: "relay" | "machines" | "jobs" | "send" | "device";
    if (req.method === "GET" && path === RELAY) door = "relay";
    else if (req.method === "GET" && path === `${RELAY}/machines`) door = "machines";
    else if (req.method === "GET" && path === `${RELAY}/jobs`) door = "jobs";
    else if (req.method === "POST" && jobs && !BOX.test(jobs[1]!)) door = "send";
    else if (req.method === "GET" && path === "/api/gui/device") door = "device";
    else return refusal("not_a_door");

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
        return refusal("bad_query");
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n < range[0] || n > range[1]) return refusal("bad_query");
      params.push([k, v]);
    }

    // The body: none on a GET; on a send, a signed command within the limit.
    if (door !== "send") {
      if (req.body) return refusal("bad_body");
    } else {
      const raw = req.body ?? "";
      if (Buffer.byteLength(raw) > 256 * 1024) return refusal("too_large");
      let o: unknown;
      try {
        o = JSON.parse(raw);
      } catch {
        return refusal("bad_body");
      }
      if (!o || typeof o !== "object" || Array.isArray(o)) return refusal("bad_body");
      if (!isSignedCommand(o as Record<string, unknown>)) return refusal("not_signed");
    }
    if (!a.key) return refusal("not_connected");
    if (door === "device" && !a.deviceKeyId) return refusal("no_device_key");

    // The account's room: six of the page's requests in flight, of which two relay reads.
    if (this.busy > 0) {
      this.busy--;
      return refusal("busy");
    }
    if (this.inFlight >= 6 || (door === "relay" && this.relayReads >= 2)) return refusal("busy");
    if (this.down) return refusal("unreachable");
    this.inFlight++;
    if (door === "relay") this.relayReads++;
    let res: FakeAnswer;
    try {
      if (this.latencyMs > 0) await new Promise<void>((r) => this.clock.setTimeout(r, this.latencyMs));
      const rebuilt = door === "device" ? `id=${a.deviceKeyId}` : params.map(([k, v]) => `${k}=${v}`).join("&");
      res = await this.o.upstream.ask({
        method: req.method,
        path: rebuilt ? `${path}?${rebuilt}` : path,
        authorization: `Bearer ${a.key}`,
        ...(door === "send" ? { body: req.body } : {}),
        signal: req.signal,
      });
    } catch {
      return refusal("unreachable");
    } finally {
      this.inFlight--;
      if (door === "relay") this.relayReads--;
    }
    if (res.status >= 300 && res.status < 400) return refusal("redirected");
    if (Buffer.byteLength(res.body) > (door === "relay" ? this.relayMax : MIB)) return refusal("answer_too_large");
    if (res.body.includes(a.key)) return refusal("withheld");
    // spacesheep's own 401 marks the account (on a send only its `unauthorized`); a 2xx clears it.
    if (res.status === 401) {
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
