// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The account's five doors (docs/rfcs/08, "The doors"): the page asks
// `${rxBase}<path>`, the native hub adds the account's key and forwards these and nothing
// else. An answer with the header `x-sessionpipe-hub` is the hub's own (`{ hub: true,
// reason, error }`), one without it is spacesheep's; the two are told apart here, once,
// so nothing reads a hub refusal as spacesheep's word (its 401 is not a revoked key, its
// `busy` 429 not spacesheep's limit).
import { cleanReason } from "@shared/reason";
import type { RemoteSend } from "../../../server/control/remote";
import { type Doors, HUB_HEADER } from "../../../server/sources/relay";

/** A door's answer, read: whose it is, and its JSON body (an empty object when none). */
export interface DoorAnswer {
  status: number;
  /** The hub's own code when the answer is the hub's; null when it is spacesheep's. */
  hub: string | null;
  json: Record<string, unknown>;
}

/** The code a send's refusal carries when the hub itself refused or failed: `hub_<code>`. */
export const hubCode = (code: string): string => `hub_${code}`;

/** How often a send the hub's room was too full for (`busy`) is tried again, and how long
 *  it waits between tries when the hub names no time. */
export const SEND_BUSY_TRIES = 3;
export const SEND_BUSY_WAIT_MS = 1000;

/** The hub's own answers to a send that come BEFORE any network, by the contract's list
 *  (docs/rfcs/08, "The doors": the refusals of a request as it stands, the account's full
 *  room, and `not_sent`, which says no connection to spacesheep could be made). After one of
 *  these nothing of the command left the phone: the send is not sent. The list is the whole
 *  of what is read so. Any other code of the hub's, one named below or one this page has
 *  never heard of, may have come after spacesheep had the command, and is read as unknown. */
export const SEND_NOT_SENT: ReadonlySet<string> = new Set([
  "not_a_door",
  "bad_query",
  "bad_body",
  "not_signed",
  "too_large",
  "forbidden_origin",
  "account_off",
  "bad_account",
  "not_connected",
  "no_device_key",
  "busy",
  "not_sent",
]);
/** The hub's own answers the contract names for a send that went out and whose answer did
 *  not come back whole. Named for the reader: every code not in SEND_NOT_SENT is read the
 *  same way (`redirected`, a code a later hub adds). */
export const SEND_UNKNOWN: ReadonlySet<string> = new Set([
  "timeout",
  "unreachable",
  "bad_encoding",
  "withheld",
  "answer_too_large",
]);
/** A send whose outcome is not known is asked again, the same signed bytes: spacesheep
 *  takes a command once (its nonce), so asking again cannot send it twice, and its answer
 *  says which it was: taken now (202), or taken the first time (409 `replay`). These are
 *  the waits before each further try. */
export const SEND_UNKNOWN_WAITS_MS: readonly number[] = [2000, 4000];
/** The code a send carries while nobody knows whether spacesheep took it: it may have been sent. */
export const SEND_UNKNOWN_CODE = hubCode("unknown");
/** The refusals spacesheep gives only after it has looked the command's nonce up, so one of
 *  them says no job was made of these bytes, on this asking or on any before it
 *  (spacesheep `POST /api/machines/:id/jobs`, which answers 409 `replay` before any of
 *  these). A refusal that can come before that look (the signature's age, a 5xx, a limit at
 *  the gate, `not_found`, `other_machine`) says nothing of an asking nobody heard the
 *  answer to. */
export const AFTER_NONCE: ReadonlySet<string> = new Set([
  "confirm",
  "never_started",
  "folder",
  "files_unsupported",
  "file_missing",
  "start_limited",
  "pool_unsupported",
]);
/** How many pages of the jobs door a look reads to reach the list's end; short of it the
 *  look says nothing. */
export const LOOK_PAGES = 30;
const JOBS_PAGE = 100;
/** A job made of a send was made no earlier than the send began: this much is allowed for
 *  the two clocks ticking apart and for the request's way there. */
export const LOOK_SLACK_MS = 5000;
/** Two of the refusals in AFTER_NONCE can differ between two askings of the same bytes that
 *  overlap: spacesheep's second look may say `confirm` to one and let the other through,
 *  and the first asking may be the start that fills the limit the second is refused for
 *  (`start_limited`). Its nonce look and the making of the job are not one step, so such an
 *  answer says nothing of an asking that may still be running. */
export const NOT_YET_FINAL: ReadonlySet<string> = new Set(["confirm", "start_limited"]);
/** An asking nobody heard the answer to cannot still be running this long after it began.
 *  By spacesheep's source the latest its job can be made is about 27 s in (the hub's 15 s
 *  to arrive, a second look of up to 12 s), plus whatever its database stalls: a minute
 *  leaves that stall room. */
export const FIRST_ASKING_OVER_MS = 60_000;

/** What became of a send, as far as anyone can say. */
export type Sent =
  /** spacesheep holds it. `job` is its id, or null when spacesheep took it on an asking
   *  nobody heard the answer to and the list does not single its job out. */
  | { kind: "sent"; job: number | null }
  /** No job was made: a refusal from before the request left, or one that proves it. */
  | { kind: "refused"; status: number; json: Record<string, unknown> }
  /** Nobody knows. `dead`: these bytes are too old to make a job any more, so what the
   *  jobs door lists is all there will ever be. `why` is empty on an asking again that had
   *  nothing new to say (what was said before stands). */
  | { kind: "unknown"; why: string; dead: boolean };

/** What the jobs door lists that a send could have become. */
export interface Looked {
  /** The list was read to its end: what follows is all of it. */
  read: boolean;
  /** It was not, because it is longer than a look reads (LOOK_PAGES pages): reading it again
   *  will say no more. False where it could not be read at all (a failure, to try again). */
  more: boolean;
  /** The list tells this send's job apart from another's (a prompt, a start). */
  told: boolean;
  /** Jobs after the last this page knew of, for the send's machine, session and action. */
  fits: number[];
  /** Those among them made no earlier than the send began. */
  recent: number[];
}

export interface AccountDoors {
  /** The three read doors, for the relay's reader (GET, no body). */
  read: Doors;
  /** `POST /api/machines/<id>/jobs`: a signed command for one of the account's machines. */
  send: RemoteSend;
  /** The same send, with what became of it said three ways (`Sent`). `again`: these bytes
   *  were asked before and nobody heard the answer, so only an answer that speaks for that
   *  asking too is taken as the end; `askedAt` is when the first asking began. */
  ask(
    m: { id: string },
    body: Record<string, unknown>,
    o?: { again?: boolean; askedAt?: number; floor?: number },
  ): Promise<Sent>;
  /** The jobs a send could have become (`Looked`). */
  look(m: { id: string }, body: Record<string, unknown>, askedAt: number, floor: number): Promise<Looked>;
  /** `GET /api/gui/device`: where this phone's own device key stands. */
  device(): Promise<DoorAnswer>;
}

export interface DoorsOptions {
  rxBase: string;
  fetch?: typeof fetch;
  /** A pause (tests move it). */
  sleep?: (ms: number) => Promise<void>;
  /** The page's clock (tests move it). */
  now?: () => number;
  /** spacesheep itself refused the key on a send (its own 401, not the grant's `unlock`). */
  onUnauthorized?: () => void;
  /** The highest spacesheep job id this page knows of: the job of a send that was taken
   *  unheard is looked for after it. Absent: from the start of the list. */
  lastJob?: () => number;
}

async function read1(res: Response): Promise<DoorAnswer> {
  let json: Record<string, unknown> = {};
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) json = body as Record<string, unknown>;
  } catch {
    // no body, or not JSON
  }
  return { status: res.status, hub: res.headers.get(HUB_HEADER), json };
}

export function openDoors(o: DoorsOptions): AccountDoors {
  const f = o.fetch ?? ((url: RequestInfo | URL, init?: RequestInit) => fetch(url, init));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  const get = (path: string, signal?: AbortSignal): Promise<Response> =>
    f(`${o.rxBase}${path}`, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });

  /** What a job of this send would be listed as: the action spacesheep files a prompt or a
   *  start under, and the session without its harness. Null for a command whose job the
   *  list does not tell apart from another's (an answer, a stop, the pool, a key). */
  const listedAs = (body: Record<string, unknown>): { action: string; session: string } | null => {
    try {
      const cmd = JSON.parse(String(body.cmd)) as { kind?: unknown; session?: unknown } | null;
      if (!cmd || typeof cmd.session !== "string") return null;
      const action = cmd.kind === "prompt" ? "message" : cmd.kind === "start" ? "start" : null;
      const i = cmd.session.indexOf(":");
      return action && i > 0 && i < cmd.session.length - 1 ? { action, session: cmd.session.slice(i + 1) } : null;
    } catch {
      return null;
    }
  };

  /** The jobs door, read from the last job this page knew of to the end of the list. A
   *  job fits when it is for this machine, this session and this action. It is `recent`
   *  when it was made no earlier than the send began, told with no clock but spacesheep's:
   *  the newest job listed was made before this read, so a job made since the send began is
   *  no older than the newest one by more than the time that has passed here. */
  const look = async (
    m: { id: string },
    body: Record<string, unknown>,
    askedAt: number,
    floor: number,
  ): Promise<Looked> => {
    const none: Looked = { read: false, more: false, told: false, fits: [], recent: [] };
    const as = listedAs(body);
    // From the last job the page knew of when the send BEGAN: a job heard of since (another
    // session's send) is after this send's own, and must not hide it.
    let since = Math.max(0, Math.floor(floor));
    const fits: { id: number; at: number }[] = [];
    let newest = Number.NEGATIVE_INFINITY;
    let read = false;
    try {
      for (let page = 0; page < LOOK_PAGES && !read; page++) {
        const a = await read1(await get(`/api/sessionpipe/v1/relay/jobs?since=${since}`));
        if (a.hub || a.status !== 200 || !Array.isArray(a.json.jobs)) return none;
        const jobs = a.json.jobs as (Record<string, unknown> | null)[];
        let moved = false;
        for (const j of jobs) {
          if (!j || typeof j.id !== "number" || !Number.isSafeInteger(j.id) || j.id <= since) continue;
          since = j.id;
          moved = true;
          const at = typeof j.created_at === "number" && Number.isFinite(j.created_at) ? j.created_at : Number.NaN;
          if (at > newest) newest = at;
          if (as && j.machine === m.id && j.action === as.action && j.session === as.session)
            fits.push({ id: j.id, at });
        }
        // The end: a page that is not full, or one that brought nothing new.
        if (jobs.length < JOBS_PAGE || !moved) read = true;
      }
    } catch {
      return none;
    }
    // Longer than a look reads: said as that, so nobody reads it again for the same send.
    if (!read) return { ...none, more: true };
    const from = newest - Math.max(0, now() - askedAt) - LOOK_SLACK_MS;
    return {
      read,
      more: false,
      told: !!as,
      fits: fits.map((x) => x.id),
      recent: fits.filter((x) => x.at >= from).map((x) => x.id),
    };
  };

  /** One asking, through a full room at the hub: its answer, or null when the request
   *  never came back from the app at all. */
  const post = async (m: { id: string }, body: Record<string, unknown>): Promise<DoorAnswer | null> => {
    let last: DoorAnswer | null = null;
    for (let i = 0; i < SEND_BUSY_TRIES; i++) {
      let res: Response;
      try {
        res = await f(`${o.rxBase}/api/machines/${encodeURIComponent(m.id)}/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        // The app's protocol failed it: whether it reached spacesheep is not known.
        return null;
      }
      last = await read1(res);
      if (last.hub !== "busy") break;
      const wait = Number(res.headers.get("retry-after"));
      if (i < SEND_BUSY_TRIES - 1) await sleep(Number.isFinite(wait) && wait > 0 ? wait * 1000 : SEND_BUSY_WAIT_MS);
    }
    return last;
  };

  const UNREACHED = "spacesheep could not be reached.";
  /** spacesheep's words for what went wrong: its sentence, never its code. Its own error
   *  answers carry the sentence as `message` and a code as `error`; its refusals carry the
   *  sentence as `error`. Outside text either way. */
  const wordsOf = (json: Record<string, unknown>): string => {
    for (const v of [json.message, json.error]) {
      const t = cleanReason(v);
      if (t && !/^[a-z][a-z0-9_]*$/.test(t)) return t;
    }
    return "";
  };
  /** What an answer says of the send. `unheard`: an asking before this one ended with
   *  nobody knowing whether spacesheep took it, so this answer must speak for that one too. */
  const heard = async (
    a: DoorAnswer | null,
    unheard: boolean,
    m: { id: string },
    body: Record<string, unknown>,
    askedAt: number,
    floor: number,
  ): Promise<Sent> => {
    const unknown = (why: string, dead = false): Sent => ({ kind: "unknown", why: why || UNREACHED, dead });
    // The app got no answer for it, or the answer stopped on its way.
    if (a === null) return unknown("");
    if (a.hub !== null) {
      // Only a code the contract lists as given before any network says this asking made
      // no job; any other, known or not, may have come after spacesheep had the command.
      if (!SEND_NOT_SENT.has(a.hub)) return unknown(wordsOf(a.json));
      // Of an asking before this one, it says nothing.
      if (unheard) return unknown(wordsOf(a.json));
      return {
        kind: "refused",
        status: a.status === 504 ? 504 : 502,
        json: { code: hubCode(a.hub), error: cleanReason(a.json.error) || a.hub.replace(/_/g, " ") },
      };
    }
    if (a.status === 202) {
      const job = a.json.job;
      return { kind: "sent", job: typeof job === "number" && Number.isSafeInteger(job) && job > 0 ? job : null };
    }
    // An error of spacesheep's own is no refusal: the job may have been made before it.
    if (a.status >= 500) return unknown(wordsOf(a.json));
    const code = typeof a.json.code === "string" ? a.json.code : "";
    if (unheard) {
      // spacesheep had taken it on an asking before this one: it is sent. Its job is the
      // one fit made since the send began, when the list singles one out.
      if (a.status === 409 && code === "replay") {
        const l = await look(m, body, askedAt, floor);
        return { kind: "sent", job: l.read && l.told && l.recent.length === 1 ? l.recent[0]! : null };
      }
      // Signed too long ago: these bytes make no job any more, and whether they did is
      // what the jobs door lists.
      if (code === "too_old" || a.json.refusal === "too_old") return unknown(wordsOf(a.json), true);
      if (!AFTER_NONCE.has(code)) return unknown(wordsOf(a.json));
      // The first asking may still be running, and may yet make the job: not the end, and
      // nothing new to say of it (the hold's own words would read as an offer).
      if (NOT_YET_FINAL.has(code) && now() - askedAt < FIRST_ASKING_OVER_MS)
        return { kind: "unknown", why: "", dead: false };
      // Past that, this refusal is the proof: spacesheep looks the nonce up before it gives
      // it, and the first asking is over, so a job of these bytes would have been answered
      // `replay`. No job in the list is taken for this send's on a hold: another device's
      // message to the same session looks the same there.
    }
    // spacesheep's own 401 that is not the grant's: the key is refused there.
    if (a.status === 401 && code !== "unlock") o.onUnauthorized?.();
    return { kind: "refused", status: a.status, json: a.json };
  };

  const ask: AccountDoors["ask"] = async (m, body, opts = {}) => {
    const askedAt = opts.askedAt ?? now();
    const floor = opts.floor ?? o.lastJob?.() ?? 0;
    let unheard = !!opts.again;
    let said = await heard(await post(m, body), unheard, m, body, askedAt, floor);
    // Asked for the first time and not heard: asked again, the same bytes, a few seconds on.
    if (!opts.again) {
      /** What was last said of why nobody knows: an answer with nothing new to say keeps it. */
      let why = said.kind === "unknown" ? said.why : "";
      for (const wait of SEND_UNKNOWN_WAITS_MS) {
        if (said.kind !== "unknown" || said.dead) break;
        unheard = true;
        await sleep(wait);
        said = await heard(await post(m, body), unheard, m, body, askedAt, floor);
        if (said.kind === "unknown") why = said.why || why;
      }
      if (said.kind === "unknown") said = { ...said, why: why || UNREACHED };
    }
    return said;
  };

  return {
    read: (path, init) => get(path, init?.signal),
    ask,
    look,
    async send(m, body) {
      const said = await ask(m, body);
      if (said.kind === "sent") return { status: 202, json: said.job === null ? {} : { job: said.job } };
      if (said.kind === "refused") return { status: said.status, json: said.json };
      // Still not known: said as that, never as not sent (a person who sends it again,
      // under a new nonce, would send it twice).
      return { status: 504, json: { code: SEND_UNKNOWN_CODE, error: said.why } };
    },
    device: async () => read1(await get("/api/gui/device")),
  };
}
