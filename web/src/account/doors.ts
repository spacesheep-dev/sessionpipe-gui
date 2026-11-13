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

/** The hub's own answers after which nobody knows whether spacesheep took the send: it did
 *  not answer in the hub's time, its answer stopped or could not be passed on. (Every other
 *  answer of the hub's comes before any network, or says spacesheep did not take it.) */
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
/** The code a send carries when it is still not known after every try: it may have been sent. */
export const SEND_UNKNOWN_CODE = hubCode("unknown");
/** How many reads of the jobs door look for the job of a send that was taken unheard. */
const JOBS_PAGES = 10;
const JOBS_PAGE = 100;

export interface AccountDoors {
  /** The three read doors, for the relay's reader (GET, no body). */
  read: Doors;
  /** `POST /api/machines/<id>/jobs`: a signed command for one of the account's machines. */
  send: RemoteSend;
  /** `GET /api/gui/device`: where this phone's own device key stands. */
  device(): Promise<DoorAnswer>;
}

export interface DoorsOptions {
  rxBase: string;
  fetch?: typeof fetch;
  /** A pause (tests move it). */
  sleep?: (ms: number) => Promise<void>;
  /** spacesheep itself refused the key on a send (its own 401, not the grant's `unlock`). */
  onUnauthorized?: () => void;
  /** The highest spacesheep job id this page knows of: the job of a send that was taken
   *  unheard is looked for after it. Absent: from the start of the list. */
  lastJob?: () => number;
}

async function read(res: Response): Promise<DoorAnswer> {
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
  const get = (path: string, signal?: AbortSignal): Promise<Response> =>
    f(`${o.rxBase}${path}`, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
  /** The job spacesheep made of a send it took unheard: the one job after the last this
   *  page knew of that is for this machine and this session. Null when the list does not
   *  say (it cannot be read, it names none, or more than one fits: never a guess). */
  const jobOf = async (machine: string, body: Record<string, unknown>): Promise<number | null> => {
    let session = "";
    try {
      const cmd = JSON.parse(String(body.cmd)) as { session?: unknown } | null;
      if (cmd && typeof cmd.session === "string") session = cmd.session;
    } catch {
      // not a command this page can read: any job for the machine is a candidate
    }
    const fits = (j: Record<string, unknown>): boolean => {
      if (j.machine !== machine) return false;
      // The list names the session bare, the command with its harness before it.
      if (typeof j.session !== "string" || !session) return true;
      return j.session === session || session.endsWith(`:${j.session}`);
    };
    let since = Math.max(0, Math.floor(o.lastJob?.() ?? 0));
    const found: number[] = [];
    try {
      for (let page = 0; page < JOBS_PAGES; page++) {
        const a = await read(await get(`/api/sessionpipe/v1/relay/jobs?since=${since}`));
        if (a.hub || a.status !== 200 || !Array.isArray(a.json.jobs)) return null;
        const jobs = a.json.jobs as Record<string, unknown>[];
        for (const j of jobs) {
          if (!j || typeof j.id !== "number") continue;
          since = Math.max(since, j.id);
          if (fits(j)) found.push(j.id);
        }
        if (jobs.length < JOBS_PAGE) break;
      }
    } catch {
      return null;
    }
    return found.length === 1 ? found[0]! : null;
  };
  return {
    read: (path, init) => get(path, init?.signal),
    async send(m, body) {
      /** One asking, through a full room at the hub: its answer, or null when the request
       *  never came back from the app at all. */
      const ask = async (): Promise<DoorAnswer | null> => {
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
          last = await read(res);
          if (last.hub !== "busy") break;
          const wait = Number(res.headers.get("retry-after"));
          if (i < SEND_BUSY_TRIES - 1) await sleep(Number.isFinite(wait) && wait > 0 ? wait * 1000 : SEND_BUSY_WAIT_MS);
        }
        return last;
      };
      const unknown = (a: DoorAnswer | null): boolean => a === null || (a.hub !== null && SEND_UNKNOWN.has(a.hub));
      let a = await ask();
      /** An asking before this one ended with nobody knowing whether spacesheep took it. */
      let unheard = false;
      for (const wait of SEND_UNKNOWN_WAITS_MS) {
        if (!unknown(a)) break;
        unheard = true;
        await sleep(wait);
        a = await ask();
      }
      if (unknown(a))
        // Still not known: said as that, never as not sent (a person who sends it again,
        // under a new nonce, would send it twice).
        return {
          status: 504,
          json: {
            code: SEND_UNKNOWN_CODE,
            error: cleanReason(a?.json.error) || "spacesheep could not be reached.",
          },
        };
      const said = a!;
      // spacesheep had taken it the first time and says so now: it is sent. Its job is
      // looked for, so the row is followed like any other.
      if (unheard && !said.hub && said.status === 409 && said.json.code === "replay") {
        const job = await jobOf(m.id, body);
        return { status: 202, json: job === null ? {} : { job } };
      }
      // The hub's own refusal: its words, under a code that is never one of spacesheep's,
      // and a status that is never read as spacesheep's 401 or 409.
      if (said.hub)
        return {
          status: said.status === 504 ? 504 : 502,
          json: { code: hubCode(said.hub), error: cleanReason(said.json.error) || said.hub.replace(/_/g, " ") },
        };
      // spacesheep's own 401 that is not the grant's: the key is refused there.
      if (said.status === 401 && said.json.code !== "unlock") o.onUnauthorized?.();
      return { status: said.status, json: said.json };
    },
    device: async () => read(await get("/api/gui/device")),
  };
}
