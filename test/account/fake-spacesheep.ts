// SPDX-License-Identifier: Apache-2.0
// Test helper: a spacesheep account as the relay's doors see it (docs/rfcs/08), in memory.
// It answers what the real one answers, read from its source: the relay
// (`{ events, next, oldest, protocol }`, every event after `since` it still holds, a wait
// when there are none), the machine list, the jobs list (100 after `since`, with `now` and
// `code`), a send (202 with a job id, or whatever the test queued for it), a revoked key
// (401 `unauthorized`), and its limit on relay reads (240 in a fixed 600 s window, 429 with
// Retry-After). It also plays the two doors an app uses before and beside the relay: the
// connect (a code and four digits, a poll that hands the key over once approved) and the
// app's own device key (asked to be trusted, and where it stands). Nothing here is Node's:
// a unit test and a browser test's server both run it.

export interface FakeClock {
  now(): number;
  setTimeout(f: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface FakeAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface FakeRequest {
  method: string;
  /** Path and query, as a door is asked: "/api/sessionpipe/v1/relay?since=0&limit=500&wait=25". */
  path: string;
  /** The Authorization header's value, when one was sent. */
  authorization?: string;
  body?: string;
  signal?: AbortSignal;
}

export interface FakeJob {
  id: number;
  machine: string;
  status: "queued" | "taken" | "running" | "done" | "refused" | "failed";
  note: string | null;
  code?: string | null;
  created_at: number;
  done_at: number | null;
  /** The signed body as it was sent. */
  sent: Record<string, unknown>;
}

const RELAY = "/api/sessionpipe/v1/relay";
const WINDOW_MS = 600_000;

const realClock: FakeClock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): FakeAnswer => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

export class FakeSpacesheep {
  readonly key: string;
  rpId = "spacesheep.test";
  /** The relay's rows: every kept event under its own seq. */
  private rows: { seq: number; body: string }[] = [];
  private seq = 0;
  private waiters = new Set<() => void>();
  machines: Record<string, unknown>[] = [];
  jobs: FakeJob[] = [];
  private jobId = 0;
  /** The key was revoked: every door answers 401 `unauthorized`. */
  revoked = false;
  /** Count relay reads against spacesheep's limit and answer 429 past it. */
  limit = 240;
  private window = { start: 0, n: 0 };
  /** Until this time every relay read is answered 429, with the seconds left as Retry-After. */
  limitedUntil = 0;
  /** What the next sends get instead of a 202, first in first out. */
  sendAnswers: Array<(body: Record<string, unknown>) => FakeAnswer | null> = [];
  /** Every request, in order: "GET /api/…". */
  log: string[] = [];
  /** How many relay reads were counted. */
  relayReads = 0;
  /** Whose account a connect is approved as. */
  email = "me@example.com";
  /** Connects under way, by code. */
  private connects = new Map<string, { digits: string; poll: string; approved: boolean; denied: boolean }>();
  /** Device keys that asked to be trusted, by key id, and the number each shows. */
  deviceRequests = new Map<string, { code: string; name: string }>();
  /** The machines that trust each device key. */
  trusting = new Map<string, string[]>();

  constructor(
    private readonly clock: FakeClock = realClock,
    key = "ss_gui_fake_0000000000000000",
  ) {
    this.key = key;
  }

  /** Events the account's machines sent: kept under the next seqs, and a waiting read wakes. */
  push(events: unknown[]): number {
    for (const e of events) this.rows.push({ seq: ++this.seq, body: JSON.stringify(e) });
    for (const wake of [...this.waiters]) wake();
    return this.seq;
  }

  /** The relay dropped everything up to and including `seq` (its 7 days, its 50 000 rows). */
  drop(seq: number): void {
    this.rows = this.rows.filter((r) => r.seq > seq);
  }

  get newest(): number {
    return this.seq;
  }

  /** A job as a computer's ack leaves it. */
  settle(id: number, status: FakeJob["status"], o: { note?: string; code?: string } = {}): void {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new Error(`no job ${id}`);
    j.status = status;
    if (o.note !== undefined) j.note = o.note;
    if (o.code !== undefined) j.code = o.code;
    j.done_at = status === "done" || status === "refused" || status === "failed" ? this.clock.now() : null;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const done = (woken: boolean) => {
        this.clock.clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(woken);
      };
      const wake = () => done(true);
      const timer = this.clock.setTimeout(() => done(false), ms);
      this.waiters.add(wake);
      signal?.addEventListener("abort", () => done(false), { once: true });
    });
  }

  /** The person confirmed (or refused) a connect on spacesheep. */
  approve(digits: string, yes = true): void {
    for (const c of this.connects.values())
      if (c.digits === digits) {
        if (yes) c.approved = true;
        else c.denied = true;
      }
  }

  /** The connect's two requests: asked with no key at all. */
  private connect(req: FakeRequest, url: URL): FakeAnswer | null {
    if (req.method === "POST" && url.pathname === "/api/gui/connect") {
      const code = `c${String(this.connects.size + 1).padStart(23, "0")}`;
      const digits = String(4821 + this.connects.size);
      const poll = `poll_${code}`;
      this.connects.set(code, { digits, poll, approved: false, denied: false });
      return json(
        {
          code,
          digits,
          url: `https://${this.rpId}/connect/gui?code=${code}`,
          poll_token: poll,
          expires_at: new Date(this.clock.now() + 600_000).toISOString(),
        },
        201,
      );
    }
    if (req.method === "GET" && url.pathname === "/api/gui/connect/poll") {
      const c = this.connects.get(url.searchParams.get("code") ?? "");
      if (!c) return json({ state: "expired" }, 410);
      if (req.authorization !== `Bearer ${c.poll}`) return json({ error: "forbidden" }, 403);
      if (c.denied) return json({ state: "denied" });
      if (!c.approved) return { status: 204, headers: {}, body: "" };
      this.connects.delete(url.searchParams.get("code")!);
      return json({ state: "approved", key: this.key, email: this.email });
    }
    return null;
  }

  async handle(req: FakeRequest): Promise<FakeAnswer> {
    const url = new URL(req.path, "https://spacesheep.test");
    this.log.push(`${req.method} ${url.pathname}${url.search}`);
    const connecting = this.connect(req, url);
    if (connecting) return connecting;
    if (req.authorization !== `Bearer ${this.key}` || this.revoked)
      return json({ error: "Unknown or revoked API key.", code: "unauthorized" }, 401);
    const p = url.pathname;
    if (req.method === "GET" && p === RELAY) return this.relay(url, req.signal);
    if (req.method === "GET" && p === `${RELAY}/machines`)
      return json({ machines: this.machines, rp_id: this.rpId, origin: `https://${this.rpId}` });
    if (req.method === "GET" && p === `${RELAY}/jobs`) {
      const since = Math.max(0, Math.floor(Number(url.searchParams.get("since")) || 0));
      const jobs = this.jobs
        .filter((j) => j.id > since)
        .slice(0, 100)
        .map(({ sent: _sent, ...j }) => j);
      return json({ now: this.clock.now(), jobs });
    }
    const send = /^\/api\/machines\/([^/]+)\/jobs$/.exec(p);
    if (req.method === "POST" && send) return this.send(decodeURIComponent(send[1]!), req.body);
    if (p === "/api/gui/device") return this.device(req, url);
    return json({ error: "This key doesn't open that.", code: "scope" }, 403);
  }

  private async relay(url: URL, signal?: AbortSignal): Promise<FakeAnswer> {
    const now = this.clock.now();
    if (now - this.window.start >= WINDOW_MS) this.window = { start: now, n: 0 };
    this.window.n++;
    this.relayReads++;
    if (now < this.limitedUntil) {
      const wait = Math.max(1, Math.ceil((this.limitedUntil - now) / 1000));
      return json({ error: "Too many requests.", code: "rate_limited" }, 429, { "retry-after": String(wait) });
    }
    if (this.window.n > this.limit) {
      const wait = Math.ceil((this.window.start + WINDOW_MS - now) / 1000);
      return json({ error: "Too many requests.", code: "rate_limited" }, 429, { "retry-after": String(wait) });
    }
    const num = (name: string, d: number, max: number): number => {
      const x = Number(url.searchParams.get(name) ?? Number.NaN);
      return Number.isFinite(x) && x >= 0 ? Math.min(Math.floor(x), max) : d;
    };
    const since = num("since", 0, Number.MAX_SAFE_INTEGER);
    const limit = num("limit", 500, 500) || 500;
    const waitMs = num("wait", 0, 25) * 1000;
    const read = () => this.rows.filter((r) => r.seq > since).slice(0, limit);
    let rows = read();
    if (!rows.length && waitMs > 0) {
      await this.sleep(waitMs, signal);
      rows = read();
    }
    const oldest = this.rows.length ? this.rows[0]!.seq : null;
    const next = rows.length ? rows[rows.length - 1]!.seq : since;
    return {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: `{"events":[${rows.map((r) => r.body).join(",")}],"next":${next},"oldest":${oldest ?? "null"},"protocol":1}`,
    };
  }

  /** The app's own device key: asked to be trusted (POST), and where it stands (GET). */
  private device(req: FakeRequest, url: URL): FakeAnswer {
    if (req.method === "POST") {
      let body: { key?: { id?: unknown }; name?: unknown } = {};
      try {
        body = JSON.parse(req.body ?? "") as typeof body;
      } catch {
        /* empty */
      }
      const id = typeof body.key?.id === "string" ? body.key.id : "";
      if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return json({ error: "Send the device key.", code: "bad_key" }, 400);
      const code = this.deviceRequests.get(id)?.code ?? String(71 + this.deviceRequests.size);
      this.deviceRequests.set(id, { code, name: `${String(body.name ?? "sessionpipe-gui")} · app` });
      return json({
        id: `d_${id.slice(0, 8)}`,
        key_id: id,
        code,
        trusted_on: this.trusting.get(id) ?? [],
        devices_url: `https://${this.rpId}/devices`,
      });
    }
    if (req.method !== "GET") return json({ error: "This key doesn't open that.", code: "scope" }, 403);
    const id = url.searchParams.get("id") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return json({ error: "Which key?", code: "bad_request" }, 400);
    const trusted = this.trusting.get(id) ?? [];
    return json({
      trusted_on: trusted,
      machines: this.machines.map((m) => ({
        id: m.id,
        name: m.name,
        trusts: trusted.includes(String(m.id)),
        takes_device: Array.isArray(m.key_types) && m.key_types.includes("device"),
      })),
      pending: this.deviceRequests.has(id) && !trusted.length,
    });
  }

  private send(machine: string, raw: string | undefined): FakeAnswer {
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(raw ?? "") as Record<string, unknown>;
    } catch {
      /* null */
    }
    if (!body || typeof body.cmd !== "string") return json({ error: "Nothing to send." }, 400);
    if (!this.machines.some((m) => m.id === machine))
      return json({ error: "That computer isn't set up any more.", code: "not_found" }, 404);
    const scripted = this.sendAnswers.shift()?.(body);
    if (scripted) return scripted;
    const job: FakeJob = {
      id: ++this.jobId,
      machine,
      status: "queued",
      note: null,
      created_at: this.clock.now(),
      done_at: null,
      sent: body,
    };
    this.jobs.push(job);
    return json({ job: job.id, online: !!this.machines.find((m) => m.id === machine)?.online }, 202);
  }
}

/** The answer as the little of a `Response` the relay's reader and a send read. */
export function asResponse(a: FakeAnswer): Response {
  const headers = new Map(Object.entries(a.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status: a.status,
    ok: a.status >= 200 && a.status < 300,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: async () => JSON.parse(a.body) as unknown,
    text: async () => a.body,
  } as unknown as Response;
}

/** A clock a test moves by hand: timers run in order as time is advanced. */
export class ManualClock implements FakeClock {
  private timers = new Map<number, { at: number; f: () => void }>();
  private id = 0;
  constructor(public t = 1_800_000_000_000) {}
  now(): number {
    return this.t;
  }
  setTimeout(f: () => void, ms: number): unknown {
    const id = ++this.id;
    this.timers.set(id, { at: this.t + Math.max(0, ms), f });
    return id;
  }
  clearTimeout(timer: unknown): void {
    this.timers.delete(timer as number);
  }
  /** Let what is already due, and every promise behind it, run. */
  async settle(): Promise<void> {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  }
  /** Move time on by `ms`, running each timer as its moment comes. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await this.settle();
      let next: [number, { at: number; f: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].f();
    }
    this.t = end;
    await this.settle();
  }
}
