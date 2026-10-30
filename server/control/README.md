# server/control — the receiver side of CONTROL.md

What a paired machine's daemon talks to (`/api/sessionpipe/v1/control`, HTTP.md §3) and
what the board's browser calls (`/api/ui/control/*`). The machine wire is the spec's;
this file documents the UI routes, which are ours.

Every UI route needs the UI's own auth (`deps.uiAuth`: loopback, or the `spgui` cookie);
otherwise `401 {"reason":"unauthorized"}`. All bodies and answers are JSON. Errors are
`{ reason, error? | detail? }`.

## Pairing

A terminal ran `sessionpipe control pair <this receiver>`. It printed a link
(`/pair?code=…`) and six digits; the page shows the same digits, and the person confirms
with a passkey. Open pairing is on: a daemon with no sink token can pair too (it sent a
`poll_key`; the paired answer then also carries our sink token).

| Route | Body → answer |
|---|---|
| `GET /pairings` | `{ pairings: Pairing[] }` — every pairing still waiting for approval, newest first |
| `GET /pair/:code` | `Pairing` for the approval page; `404` unknown code |
| `POST /pair/:code/approve` | `{ key: {id, alg, spki}, proof: {cred, ad, cd, sig}, name?, by? }` → `200 { ok, machineId, keyId, firstPairing }` |
| `POST /pair/:code/reject` | → `204`; the terminal's next status poll gets 404 and stops |
| `GET /challenge` | `{ challenge, rpId, origin, expiresAt }` — a random challenge for a WebAuthn ceremony that has none of its own (making a passkey with `navigator.credentials.create()`), remembered five minutes |

```ts
interface Pairing {
  code: string;
  check: string;                       // the six digits
  status: "pending" | "approved" | "expired" | "done";
  open: boolean;                       // started with a poll_key, no sink token
  fromIp: string;                      // where the request came from (CONTROL.md §2)
  startedAt: string; expiresAt: string;
  machine: { id: string; name: string; harnesses: string[]; modes: string[]; version: string;
             folders?: string[]; mode?: "safe" | "auto" | "inherit";
             accounts?: { harness: string; id: string; email?: string; name?: string }[];
             firstPairing: boolean;    // no token yet: approving hands the machine its token
             keys: number };           // passkeys already trusted for it
  rpId: string;
  challenge: string;                   // base64url(sha256("sessionpipe.pair:" + machine + ":" + code))
}
```

**Approve.** The page calls `navigator.credentials.get()` with `challenge` (decoded from
base64url) and `rpId`, and posts the key it used (`id` = credential id base64url, `alg`
= `-7` or `-257`, `spki` = the public key's SPKI base64url, as kept from when the passkey
was made) with the assertion's `cred`/`ad` (authenticatorData)/`cd` (clientDataJSON)/`sig`
(signature), all base64url. `name` is what to call the device ("iPhone"); `by` is shown
to the terminal as who approved (open pairing: `account`). The receiver verifies the
proof with the core verifier (`verifyEnrollment`); a proof that does not verify is
`422 {"reason":"bad_proof","detail"}`, an unusable key `422 bad_key`, an expired code
`410`, a code already approved `409`. On success the key is trusted for the machine, and
the daemon's next status poll collects key, proof and (first pairing) its token.

Keys are never removed here, one at a time or otherwise (CONTROL.md §2): that is
`sessionpipe control keys remove` at the machine's own terminal. `forget` below drops the
whole machine row locally.

## Adding a device (a phone's own passkey)

CONTROL.md §2, "a trusted device vouches for a new one". A phone that can open the GUI
(TLS mode, trust steps done) but holds no passkey the machine trusts makes one on
`/add-device` and posts it here; the page shows six digits. A device the machine already
trusts (the Mac that paired) sees the request on `/machines` (and at the top of a session
page), compares the digits, and **Approve** sends a signed `key.add` (session
`sessionpipe:keys`, `key`, `name`) through `POST /send` like any command. The machine
verifies it (§5), adds the key and acks `delivered`; the receiver then marks the request
`added` and mirrors the key into the machine's `keys` so its early check trusts the phone
too. Nothing here hands out trust: these routes only hold the request.

| Route | Body → answer |
|---|---|
| `POST /devices` | `{ key: {id, alg, spki}, name? }` → `201 DeviceRequest`; `400` on a bad key (`id`/`spki` base64url, `alg` -7 or -257) or a name over 40 characters; `422 bad_key` for a key no machine could verify with |
| `GET /devices` | `{ devices: DeviceRequest[] }` — requests still `pending` or `sent`, newest first |
| `GET /devices/:requestId` | `DeviceRequest`; `404` unknown or rejected |
| `POST /devices/:requestId/reject` | → `204`; the phone's next poll gets 404 |

```ts
interface DeviceRequest {
  requestId: string;
  check: string;                       // the six digits, shown on both ends
  key: { id: string; alg: -7 | -257; spki: string };
  name: string;                        // what the phone typed ("Misha's iPhone"), else `device`
  device: string;                      // from the user agent: "iPhone", "Mac", …
  fromIp: string;
  createdAt: string; expiresAt: string; // ten minutes
  status: "pending" | "sent" | "added" | "failed" | "expired";
  machineId?: string; activityId?: string;   // once a trusted device's key.add was queued
  outcome?: ControlOutcome; code?: string; detail?: string;  // `failed`: the machine's word
}
```

Requests live in memory only (a restart forgets them) and are kept an hour past their
end so the phone reads `expired` or `failed` rather than 404. A `key.add` queued through
`/send` whose `key.id` matches a pending request moves it to `sent`; the machine's final
ack settles it.

## Sending a command

The browser writes the command string (`cmd`, CONTROL.md §3.1, `machine` = the machine's
id) and signs it: with a day key under a passkey grant (`csig` + `grant`), or with one
passkey confirm over `sha256(cmd)` (`confirm`). The receiver runs the core verifier as
its early word (§5: against the machine's enrolled keys, the exact bytes, a ten-minute
age window, no nonce store) and only then queues it.

| Route | Body → answer |
|---|---|
| `POST /send` | `{ machineId, cmd, csig?, grant?, confirm?, expires_in_s?, from? }` (`SendBody`) → `201 ControlActivity`; `422 { reason, code }` with the verifier's code (`unsigned`, `untrusted_key`, `bad_csig`, `too_old`, …) or the second look's (below) when it refuses; `404` unknown machine; `400` a `from` that is not a session ref |
| `POST /files?name=<name>` | One file a `start` will carry: the raw bytes, its media type as `content-type` → `201 StartFile { name, type, size, sha256 }` (sha256 base64url, CONTROL.md §3.1). Held a day under `<stateDir>/control/files/<sha256>`, longer when a queued start needs it; `413` over 25 MiB, `415` no media type, `400` empty or a name a machine would refuse |
| `GET /activity?limit=` | `{ activity: ControlActivity[] }`, newest first (default 100, at most 1000) |
| `GET /machines` | `{ machines: (MachineControl & { name, createdAt, pairedAt? })[] }` — paired machines |
| `POST /machines/:id/forget` | → `204`; the row, its token and its queue are gone here; its next poll is 401 and the daemon says so |

`expires_in_s` defaults to one hour and is capped at 24 h (§3.3). `ControlActivity`
(`shared/api.ts`) is the receiver's reading of a carried message — never the signature:
`outcome` moves through `taken` / `progress` (with `reply` and `replySeq`, the highest
kept) to a final `delivered` / `expired` / `unsupported` / `failed` / `refused` (with
`code`), `mode` says how it was delivered. The same objects arrive on the SSE stream as
`{ kind: "control", message }` whenever one is queued, acked or expires.

For a `permission.answer`, `text` is `"<decision>"` or `"<decision>: <note>"`; for a
`key.add`, `"trust <name>"`. A `start`'s activity also carries what was signed (`cwd`,
`permission`, `model`, `files`) and, from its `taken` / `delivered` ack, `applied`: what
the machine ran it with. `from` is the page's own unsigned note of which session's page
sent it (`SendBody.from`, a `<harness>:<id>`): kept on the activity for the lineage the
UI shows at once, never carried to the machine.

**A handoff** (sessionpipe CONTROL.md §3.1 `reply_to`). A `prompt` or a `start` may name
another session on the same machine as `reply_to`, inside the signed bytes: after the
command's final `delivered` ack the daemon delivers the answer into that session and says
how it went in that session's events (`delegation.ended.relayed`); the command's own ack
is unchanged. The receiver's second look (`replyToProblem`, before the one below) holds it
to a prompt or a start (`bad_fields` on anything else, or a malformed ref, or the
command's own session), and to a machine whose last hello said `handoff` (`handoff`: an
older daemon would refuse the whole command, or ignore the relay). The activity carries it
as `replyTo`. This receiver's own sessionpipe-core verifies every command first, and a
core from before `ask` (0.10.0) refuses the field `bad_fields` there, whatever the hello
says (`coreTakesReplyTo`): a handoff goes through once the core is bumped.

**The second look** (`precheck.ts`). After the verifier, the receiver holds a command to
what the machine's last hello advertised (CONTROL.md §2), because a daemon that predates
a field ignores it: `permission` and `model` belong to a `start` only, `files` to a
`start` or a `prompt` (`bad_fields`); `files` must follow §3.1 and the machine must have
said `files: true` (a start) or `prompt_files: true` (a prompt) (`bad_fields`), and every
file must be held here (`file`); `permission` must be one of the levels its `start` entry
lists for that harness (`permission`), never `inherit` (`bad_fields`), and at most `safe`
on an `inherit` machine (`permission`); `model` needs
`models` or `any_model` there, and a closed list must hold it (`model`). The test door
skips this look so a delivery scenario can reach the machine's own refusal.

**Hello facts** kept per machine and shown on `MachineControl`: `mode` (`safe`, `auto`, or
`inherit` from sessionpipe 0.10: no permission flag), `files`, `prompt_files`
(`promptFiles`), `ask` (a boolean: whether `sessionpipe ask` is on there, so its agents can
ask each other) and `handoff` (`true`: it takes `reply_to`; the Handoff sheet offers "bring
the answer back" only then), both absent from a hello that predates them, and `start` (per harness `{ permissions, permission, models?, any_model? }`;
an entry for a harness the hello does not list, a default outside its levels (or
`inherit`), unknown levels and malformed models are dropped; on an `inherit` machine, or
for a default of `inherit`, the levels are capped at read and safe). `accounts` keep one
named by `email`, else by `name` (an API home, `api.z.ai`). No home folder: sessionpipe
0.10's hello has none. `MachineControl.tilde` says a start may name a `~/…` folder, which
the machine expands: set when this receiver's sessionpipe-core takes one and the hello has
`start` (CONTROL.md §3.1: "a machine that sends `start` also takes a `~` folder"; `tilde.ts`). Each hello says them again: one without them takes them
away. The well-known's `control.inherit: true` tells a daemon this receiver shows an
inherit machine as that, so it may pair or switch to inherit with it (CONTROL.md §2).
Demo mode puts its machines here through `demo` (ids `m_demo-…`, server/demo/machine.ts).

## The pool (DESIGN §2.3: hello `pool`, the `pool` command)

A machine whose sessionpipe (0.11) pools Claude accounts sends `pool` in every hello
(`{on, harness, accounts[]}`, `{on: false, accounts: []}` when nothing is set up), and a
hello at once when the pool changes. `parse.ts` reads it strictly: the object needs `on`,
a harness and an `accounts` list, or there is no pool (the rest of the hello stands); an
account that breaks its shape (no id, an unknown `status`, `enabled` not a boolean) is
dropped, never the pool; a malformed `email`, `label`, `until`, `limited_by` or window is
dropped from its account; ids once each, at most 20, in the machine's order. It lands on
`MachineControl.pool` (`shared/api.ts` `MachinePool`, `MachinePoolAccount`: `id`, `email?`,
`label?`, `enabled`, `status` ready · limited · error · disabled, `current`, `until?`,
`windows?`, `limitedBy?`) and, like every hello fact, a hello without it takes it away. An
account's `windows` (its freshest numbers, idle or not) feed the limits store
(`server/ui/limits.ts` `followControl`), dated by the hello, newest wins against the
events'; a `limits.observed` with `data.account_id` is keyed by that account, the one that
served the request.

The command is kind `pool` on session `sessionpipe:pool` with `pool_action` (`on`, `off`,
`enable`, `disable`, `remove`, `order`, `refresh`, `login.begin`, `login.complete`),
`pool_account` (`^[A-Za-z0-9._:-]{1,128}$`: the account for enable / disable / remove,
optionally for refresh, the pending login id for login.complete), `pool_order` (order:
every account id once, at most 20) and `pool_code` (login.complete: the pasted
`code#state`, at most 512 characters, one line); on, off and login.begin take nothing
else. It goes through `POST /send` like any command; the page signs on, off, remove, order,
disable and login.complete with a fresh confirm (`POOL_CONFIRM_ACTIONS`), never the day
grant, and the early verify refuses one of those signed with a grant alone with
`confirm_required`, as the daemon does. This receiver's sessionpipe-core (0.10.0) closes
its kind set in `parseCommand`, which its verifier runs first, so `pool.ts` verifies the
kind itself: its own strict parser for the fields, then the core's exported primitives
(`parseGrant`, `verifyAssertion`, `sha256`) in the core's order with the core's refusal
codes, and the day key's P-256 signature over the exact bytes checked here; once a core
that lists `pool` is installed (`coreTakesPool()`), the core's `verifyCommand` decides.
The second look (`precheck.ts`) refuses `pool_unsupported` for a machine whose hello has
no `pool`, `pool_account` for an id the pool does not list (login.complete's pending id
excepted), `pool_order` for an order that does not name every account once. The activity
carries `poolAction` and `poolAccount`, its `text` the command in words ("Turn the pool
on", "Move Fiction first", "Refresh fiction@example.com"), and the machine's ack `detail`
as it came: the pool's summary line ("on · 3 accounts · 2 with room · serving Fiction"),
or for `login.begin` "<pending login id> <URL>" (`web/src/lib/pool.ts` reads it). The
machine's own codes (`shared/api.ts` `POOL_CODES`): refused `pool_account` (unknown, or a
sign-in older than ten minutes), `pool_order`, `pool_off` (refresh and the sign-ins need
the pool on); failed `login` (the vendor rejected the code), `pool` (the vendor call did
not go through); `unsupported` when the daemon knows the kind but the machine cannot pool.

## The machine wire (for reference)

`POST {control}/pair` (sink token, or none + `poll_key`) → 201 `control-pair-started`;
`GET {control}/pair?code=` (sink token or the poll key) → `pending` / `paired` (key,
proof, `token` on the first pairing; open pairing adds `sink_token` and `account`) /
`expired`; 404 once the paired answer was handed over, or for a code never seen. A new
`POST pair` naming an existing `machine` renews the code on the same row; the old code
answers `expired`. `POST hello` 204, `GET ?machine=&wait=` 200/204 (wait ≤ 25 s),
`POST ack` 202 `{ applied, unknown }`, `POST off` 204, `GET {control}/files/<sha256>`
(HTTP.md §3: the bytes with their `content-type`, 404 when not held) — each with the
machine's own token and nothing else. A `taken` ack pauses redelivery 35 minutes; a final ack ends it;
duplicates are tolerated. State lives under `<stateDir>/control/` (`machines.json` with
hashed tokens and `queue/<machine id>.json`).

## Test door

With `testDoor: true` and only from loopback: `POST {control}/_test/enroll`,
`_test/enqueue`, `_test/approve` — what the conformance runner (`server/conformance/`)
uses for the control scenarios. See `testdoor.ts`.
