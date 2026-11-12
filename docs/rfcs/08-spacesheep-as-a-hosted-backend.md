# RFC 08: spacesheep as a hosted backend (the relay option)

Status: Shipped in 0.7.5 (2026-11-06): phase A in #88, phase B in #89 · Drafted 2026-11-03 ·
Owner: the GUI and spacesheep together. The text below is the design as it was written;
[As built](#as-built-075) says where the GUI's build went another way and what is not
built.

## Why

Running the GUI means running a receiver: a port, https for passkeys, a key in a link,
and a machine that is on when the phone looks. spacesheep already is a sessionpipe
receiver with an account, pairing, passkeys, device keys and the control queue, on the
same vendored verifier the daemon runs. This RFC makes "sign in with spacesheep" an
**option** in the GUI's settings — never the default, never recommended over self-hosting
— after which a person installs the app, signs in, pairs each machine with one line, and
hosts nothing.

The trade, said plainly in the setting: spacesheep then holds the account's events at
whatever tier the machines send (its privacy policy applies), where a self-hosted GUI holds
them on the person's own disk.

## Shape: spacesheep relays, the GUI keeps its board

The GUI's board, store, search and timeline stay as they are. spacesheep becomes a
*source* that feeds the GUI's existing ingest, and a *carrier* for the commands the GUI
signs, exactly as a machine's daemon is a carrier.

```
machine daemon ──events──▶ spacesheep ──relay──▶ GUI (desktop app or self-hosted)
                ◀──poll───            ◀─signed──
```

### spacesheep: three pieces

1. **Raw event retention.** Today spacesheep keeps rows and turns, not the wire events.
   The ingest route keeps every accepted event (already redacted at the source, tier ≤ 2)
   in the account's memory DO, `mem_sp_events(seq, received_at, body)`, for 7 days and at
   most 50 000 rows, oldest first out. Nothing is kept that the rows did not already imply.
2. **The relay.** `GET /api/sessionpipe/v1/relay?since=<seq>&wait=25` answers the events
   after `since` as a batch (`{events, next}`), long-polling up to 25 s when there are none,
   and pages through the retained backlog from `since=0` at 500 a page. The GUI feeds them
   through its own receiver ingest (`/api/sessionpipe/v1/events` locally), so the board,
   the files drawer, the asks and the limits all work unchanged. The relay also says which
   machines are paired on spacesheep and what their hellos say (`GET /api/machines`), so the
   GUI knows where a session can be reached.
3. **Connecting the GUI.** A device-code style sign-in, no key to copy: the GUI asks
   `POST /api/gui/connect` and shows "Open spacesheep.dev/connect/gui and confirm **48 21**".
   The person, signed in on spacesheep, confirms; spacesheep mints a `sessions`-scoped API
   key for that GUI and hands it to the GUI's poll once. The key opens the relay,
   `/api/machines` and (phase B) the jobs route; it never opens the account's spaces.

### GUI: one setting and one source

- **Settings → Receivers → "Also a spacesheep account"**: Connect, the device code, the
  account's email once connected, Disconnect. Off by default; the copy names the trade.
- **The source** (`server/relay/spacesheep.ts`): a loop that polls the relay with the last
  cursor (kept in state), posts each batch into the local ingest, and marks the sessions
  `via: spacesheep` so the page says where they come from. A machine the relay lists shows
  on Machines as "paired on spacesheep.dev".

### Control (phase B)

A command still has to be signed by a key the machine trusts. A browser on the GUI's origin
cannot use a spacesheep passkey (the rp id differs), so:

- **The desktop app signs with its Secure Enclave key**, as it does for a local receiver.
  spacesheep's devices page learns to approve a device key (the shared verifier already
  checks them), once per machine, the same `key.add` it does for a passkey. The app's
  connect flow raises that device request itself.
- **The GUI in a browser** shows "Answer on spacesheep.dev →" for a session reached through
  the relay, until RFC 07 (receiver-vouched devices) lets spacesheep vouch for a browser's
  key too.
- The jobs route (`POST /api/machines/:id/jobs`) accepts the GUI's key as the account and
  verifies the signature as today; acks flow back through the relay as control activity.

## The newcomer's path, end to end

1. Install the desktop app. First run offers two routes side by side: **Run it here**
   (today's setup) and **Use a spacesheep account**. The second shows the trade in one
   sentence and a Connect button.
2. Connect: the browser opens spacesheep.dev, the person signs in (or signs up), confirms
   the two digits, and the app is connected. If the app can sign (phase B), the same page
   approves its key with the passkey, once.
3. Add a machine: the app shows one line to paste on any computer, local or remote,
   `npx -y sessionpipe@latest control pair spacesheep.dev`, and the link that command
   prints is approved in the browser already signed in. Each further machine is the same
   line; the app lists them as they come online, with their sessions.
4. From then on: every session from every machine, on the laptop and the phone, with
   nothing to host, no port, no https, no key in a link.

## What ships first (phase A, read)

spacesheep: retention, the relay route, the connect flow, key scope. GUI: the setting, the
connect flow, the source loop, the "via spacesheep" marks, "Answer on spacesheep.dev" links.
A person sees every session from every machine paired on spacesheep in the desktop app
with nothing hosted; answering still happens on spacesheep.dev. Then phase B.

## Not changing

- Self-hosting stays the default and the documented path. The option is one switch,
  and turning it off drops the key and keeps the local store.
- Tier caps: the GUI shows what spacesheep has, which is at most tier 2; tier 3 (inputs,
  outputs, the files drawer's text) only ever exists on a self-hosted receiver.

## As built (0.7.5)

The GUI's side, read from the code at 0.7.5. spacesheep's side (retention, the key's scope)
is in its own repository.

- **The setting** is Settings → Data → "A spacesheep account", one row, "Use a spacesheep
  account". There is no Receivers section.
- **The source** is `server/sources/spacesheep.ts` (the connect flow is
  `server/ui/spacesheep.ts`), not `server/relay/`. It hands each page to the store's ingest
  in process, `store.ingest(events, "spacesheep")`, not through the local
  `/api/sessionpipe/v1/events` route. A session read this way has `source: "spacesheep"`
  (beside `http`, `outbox` and `demo`); there is no `via` on a session. A machine has it
  (`control.remote.via`), and Machines says "paired on spacesheep.dev".
- **The relay's doors.** Events: `GET /api/sessionpipe/v1/relay?since=<seq>&limit=500&wait=25`.
  The machines paired there: `GET /api/sessionpipe/v1/relay/machines`, read once a
  minute, not `/api/machines`. How a send went: `GET /api/sessionpipe/v1/relay/jobs?since=<id>`,
  read every three seconds while a send is unsettled, rather than acks relayed as events. A
  send goes to `POST /api/machines/:id/jobs` with the GUI's key, as designed.
- **Connecting** shows four digits ("48 21"), where the newcomer's path says two. Two digits
  is the number a device approval shows.
- **The app's device key** is not raised by the connect flow. Machines offers "Approve this
  app on spacesheep.dev…" on each machine paired there that does not trust it yet; that
  posts the key's public half (`POST /api/gui/device`) and shows the number to match on
  spacesheep's Devices page.
- **Not built:** the "Answer on spacesheep.dev →" link for a browser; the first run's second
  route ("Use a spacesheep account": the welcome still offers this computer, another
  computer and the demo); the one line to paste, `npx -y sessionpipe@latest control pair
  spacesheep.dev`, shown by the app.

## The phone on an account

Not shipped: the native half is built (`apps/crates/sp-receivers`: `account.rs`,
`hub/acct.rs`, `docs.rs`, `keychain.rs`; `apps/mobile/src-tauri/src/acct.rs`), the page's
half is not. Until a page uses it, nothing a person sees changes.

Everything above needs a GUI server. A phone has none: the app is the bundled page and a
Rust hub. In this mode the page carries its own board, fed by the account's relay, and
the hub is the only thing between the page and spacesheep. It holds the account's API key
and does four things with it: connects, forwards five doors, asks spacesheep to trust
this phone's own device key, and keeps a few documents. This section is the contract
between the two halves.

The page is not trusted by the hub. It is the app's own bundle, and it also draws what
machines and sessions say; whatever it asks is checked as if anyone had asked, and what
would add, replace or empty an account is the person's to confirm in a native alert the
page cannot draw or click.

### An account in the receiver list

A spacesheep account is an entry of the hub's receiver list with `kind: "spacesheep"`. It
sits beside receivers, can be the active one (`rx_select`), survives restarts, and is
removed by `acct_disconnect` (not by `rx_remove`, which refuses an account). Its id is
the whole SHA-256 of its origin and lowercase email, in base32: 52 characters, where a
receiver's is ten. Another person's account at the same origin is another id, so whatever
the page keeps by receiver id is never shown to the wrong person. There is one account
per origin.

A receiver's row and a receiver's shell contract are what they were, field for field. An
account's add three, flat:

| where | an account also says |
|---|---|
| `window.sessionpipeShell.receiver` | `kind: "spacesheep"`, `email`, `state` (as the window opened) |
| a row of `rx_list` | `kind: "spacesheep"`, `email`, `state` (now), `rpId` once known |
| `window.sessionpipeShell.features` | `"account"` when this build has the mode (the iPhone) |

`rxBase` is made the same way (`rx://localhost/<id>`). `state` is `"ok"`,
`"unauthorized"` (spacesheep answered 401 to the key and nothing has succeeded since) or
`"no_key"` (the entry is here and its key is not: a backup restored on another phone).
`email` is printable ASCII, as spacesheep gave it; an address with anything else in it is
not connected at all.

Nothing that speaks to a receiver speaks to an account: no `/api/ui/*` request, no
stream (`rx_stream` answers `Err("account_no_stream")`), no `spgui` cookie, no view
window. The signer (`plugin:identity|*` with the account's id as `receiver`) works: the
hub answers its two questions, the rp id and the machines' names, from the machines door.

The list keeps what it does not read. An entry of a kind a newer version wrote, or one
whose fields have another shape, stays in `receivers.json` as the JSON it was through
every save; it is never listed to the page, never selectable, never spoken to. A file
that is no list at all is copied to `receivers.json.bad` before anything is saved, and
the list starts empty in memory.

### Commands

Tauri commands, for the bundled page in the main window only. An error is
`{ code, message, retryAfterS?, upstream? }`. None takes or returns the key, the connect's
link, or a device key.

| command | answer |
|---|---|
| `acct_status()` | `{ enabled, accounts: [{ id, origin, email, state, connectedAt, active, deviceKeyId? }], connect }` |
| `acct_connect_start({ origin? })` | a connect: `{ origin, digits, expiresAt, state: "pending" }` |
| `acct_connect_open()` | nothing: the hub's link for the pending connect is opened in the system browser |
| `acct_connect_cancel()` | `true` when a pending connect was stopped; `false` when it only cleared an outcome |
| `acct_disconnect({ id })` | `{ id, origin, email, forgotten: true, revoked: false, revokeUrl, note }` |
| `acct_device_ask({ id })` | `{ code, keyId, trustedOn, devicesUrl? }` |
| `acct_doc_get({ id, name })` | the document, or `null` |
| `acct_doc_set({ id, name, value })` | its size in bytes |
| `acct_doc_delete({ id, name })` | `true` when there was one |

The event `account` carries `acct_status`'s value whenever it changes.

**Connecting.** `origin` is https and nothing but an origin; absent, it is
`https://spacesheep.dev`. (`http://localhost` and `http://127.0.0.1` are origins in a
debug build only.) The hub asks `POST <origin>/api/gui/connect` as
`{ device: "iPhone", version }` (the page does not choose the name) and hands back the
digits to show and when they expire. The link stays in the hub: it holds the code, and
whoever has the code can have any account approve it. The page calls `acct_connect_open`
and the hub hands the link to the system browser itself; the link is on the account's own
origin, in its own scheme, or the connect fails. The poll token never leaves the hub
either.

The hub polls by itself: 0.8 s after the start, then every 2 s, backing off to a minute
when spacesheep cannot be reached or asks to wait, until approved, denied or expired, and
never past the code's end plus the two minutes spacesheep keeps an approved key for
collection. The pending connect is kept beside the keys, so it goes on when the app was
closed while the person confirmed in the browser; coming back to the front polls at once.

When spacesheep says the code was approved, nothing is kept yet. The hub first checks that
this connect is still the one, and that the account's id is free or is this same
account's (otherwise `failed` with `conflict`). Then it asks the person, natively, whose
account this phone is about to show (below). On yes: the key is kept, then the entry;
and only then does another account at the same origin go, with its key and documents.
On no: `declined`, and nothing was written or removed. `connect.state` goes `pending` →
`approved` (with `receiver`, the account's id, and `email`), `denied` (on spacesheep),
`declined` (here), `expired` or `failed` (with `error`: `bad_answer`, `conflict`,
`keystore`, `io`, `busy`). On `approved` the page calls `rx_select(receiver)`, as after
`rx_add`. A second start while one is live for the same origin returns the same connect.

Start's errors: `unsupported` (no account mode in this build), `bad_origin`, `busy` (a
start is already under way, or another question is open), `already_connected` (an
account at that origin is `ok`: disconnect first; one that is `unauthorized` or `no_key`
may connect again, and the same person keeps their id, documents and device key id),
`too_many_starts` (five in ten minutes from this app, with `retryAfterS`), `cancelled`
(the person said no to another origin), `unreachable`, `rate_limited` (with
`retryAfterS`), `refused` (not a 201), `bad_answer`.

**Disconnecting** forgets the key, the documents and the entry on this phone; when
documents are kept for the account, the person is asked first (`cancelled` on no). It
does not revoke the key: `revoked` is always `false`, `revokeUrl` is spacesheep's
Settings → API keys, and the page says so. What the page itself cached for that id
(IndexedDB) is the page's to clear.

**This phone's device key.** `acct_device_ask` asks spacesheep to trust the key that is
in this phone's Secure Enclave for the account's rp id. The shell reads the key from the
signer natively and the hub writes the whole request (`POST /api/gui/device` with
`{ key, name }`: the signer's key as it is, the hub's own name for the device). The page
supplies nothing, so no key but this phone's own can be enrolled through the app. The
answer has the number spacesheep's Devices page shows beside the request (`code`), the
key's id, the machines that trust it already, and the Devices link when it is on the
account's origin. The hub remembers the key's id (`deviceKeyId`), and the status door
below is about that key only. Errors: `unknown_account`, `unsupported` (no signer:
Android), `signer` (with the signer's own code in `upstream`), `bad_key`,
`unauthorized`, `rate_limited`, `refused` (with spacesheep's words in `message` and its
code in `upstream`, e.g. `pro_required`, `talk_off`), `bad_answer`, and the hub's own
codes below.

### What the person is asked

Native alerts, one at a time; a second question while one is open is refused (`busy`),
never queued. Cancel is the preferred action of each. With nobody to ask, the answer is
no. On Android "This iPhone" reads "This phone".

| when | title | message | buttons |
|---|---|---|---|
| before a connect to any origin but `https://spacesheep.dev` | Use an account on this server? | This iPhone will ask {host} for an account and show its sessions. It is not spacesheep.dev: continue only if you know this server. | Cancel / Continue |
| before an approved account is kept | Use this spacesheep account? | {email} on {host}. This iPhone will show its sessions. | Cancel / Use it |
| before an account with documents is disconnected | Disconnect {email}? | Labels and read marks kept on this iPhone for it are removed. | Cancel / Disconnect |

### The doors

The page asks `${rxBase}<path>`; the hub adds `Authorization: Bearer <key>` and forwards
these five and nothing else:

| method | path | query | body | answer up to |
|---|---|---|---|---|
| GET | `/api/sessionpipe/v1/relay` | `since` 0…2^53−1, `limit` 1…500, `wait` 0…25, each optional | none | 8 MiB |
| GET | `/api/sessionpipe/v1/relay/machines` | none | none | 1 MiB |
| GET | `/api/sessionpipe/v1/relay/jobs` | `since`, optional | none | 1 MiB |
| POST | `/api/machines/<id>/jobs`, id `m_` + 16…40 of `A-Za-z0-9_-`, never `m_box…` | none | a signed command, 256 KB | 1 MiB |
| GET | `/api/gui/device` | none: the hub adds `id=<this phone's key>` | none | 1 MiB |

A path is a door only when it is written exactly so: no `..`, no `//`, no encoded
character, no trailing slash. A parameter is plain digits, given once; the hub rebuilds
the query from the values it read. The request must come from the bundled origin.

A send is a signed command as the signer writes one, and nothing else:
`{ cmd, csig, grant }` or `{ cmd, confirm }`, where `cmd` is the JSON text that was
signed, `csig` a string, `grant` and `confirm` objects (the unused ones may be `null`).
A body with any other field, or with nothing signing the command, is `not_signed`. A
cloud box (`m_box…`) is not a door at all: spacesheep runs a message for one with no
signature, so the account's key alone would be enough to make it work.

`POST /api/gui/device` is not a door for the page (`not_a_door`); `acct_device_ask` is
how a key is enrolled.

The hub's time limit is the relay's `wait` plus 20 s, and 15 s for the rest. Each
account has its own room: six of the page's requests in flight, of which two relay reads;
the hub's own requests (the signer's questions, the device key) are counted apart and
wait their turn.

Upstream gets the hub's headers only (`Authorization`, `Accept: application/json`,
`Accept-Encoding: gzip`, `Content-Type: application/json` on a POST, the hub's
`User-Agent`): nothing the page sends as a header, `Authorization`, `Host` and `Cookie`
included, reaches spacesheep. The page gets spacesheep's status and its body unpacked,
and of its headers `Content-Type` and `Retry-After` (both readable across origins);
`Cache-Control: no-store` is the hub's. An answer's limit is on its size unpacked: a
relay page is at most 500 events of at most 262,144 bytes each on the wire, a kilobyte
or so in practice, so 8 MiB holds a full page of events averaging 16 KB; a page over it
is `answer_too_large`, the reader asks for a smaller `limit`, and at `limit=1` the
largest event there can be fits thirty times over. No cookie is sent, kept or set. A
redirect is neither followed nor passed on.

A 401 from spacesheep marks the account `unauthorized` (on the jobs door only its
`code: "unauthorized"` does: a 401 `unlock` there is the signer's grant). The key is kept;
the next 2xx on any door clears the mark. A 429 passes with its `Retry-After`.

**The hub's own answers** carry the header `x-sessionpipe-hub: <code>` and the body
`{ hub: true, reason: <code>, error }`. Response headers from spacesheep are never passed
on by name, so an answer with the header is the hub's and one without is spacesheep's:

| status | code | when |
|---|---|---|
| 403 | `not_a_door` | another path or method, a path not written as a door is, a cloud box, the device door's POST |
| 400 | `bad_query` | a parameter the door does not take, out of range, or twice |
| 400 | `bad_body` | a body on a GET, or one that is not a JSON object |
| 400 | `not_signed` | a send that is not a signed command |
| 413 | `too_large` | a body over the door's limit |
| 403 | `forbidden_origin` | not the bundled page asking |
| 403 | `account_off` | no account mode in this build |
| 403 | `bad_account` | the entry's id is not its origin's and email's |
| 401 | `not_connected` | no key here for this account at this origin |
| 409 | `no_device_key` | the device door, before `acct_device_ask` ever succeeded |
| 429 | `busy` | the account's room is full (`Retry-After: 1`) |
| 502 | `unreachable` | spacesheep could not be reached, or its answer stopped |
| 504 | `timeout` | no answer in the hub's time |
| 502 | `redirected` | spacesheep answered 3xx |
| 502 | `answer_too_large` | the answer, unpacked, is over the door's limit |
| 502 | `bad_encoding` | the answer is packed some other way than gzip, or is not what it says |
| 502 | `withheld` | the answer held the key |

Every refusal in the upper eleven rows comes before any network.

### The documents

For what nothing upstream holds in this mode: the person's labels and read marks, the
sends not yet settled. Whole JSON values in `<home>/accounts/<id>/<name>.json`, owner-only.
A name is a lowercase letter, then up to 31 letters, digits or dashes. A document is at
most 1 MiB as written; an account has at most eight. The last write wins. They are the
account's (another id reads none of them), they outlive a refused key, and they go with
`acct_disconnect`. Errors: `unknown_account`, `bad_name`, `too_large`, `too_many`, `io`.
The events are not kept here: the page caches them, and losing that cache costs one read
of the relay.

### Where the key is

Always in a store of its own, never the one receiver keys are in: a receiver is sent its
key as a cookie, to an origin the list names, and an API key must not be findable that
way. Given the same place for both, the hub turns the account mode off. A receiver's key
is looked up only by an id a receiver can have (ten base32 characters).

- **iPhone:** the keychain, service `<bundle id>.account`, this device only, readable
  after the first unlock. Never in a backup, never in iCloud Keychain. An iPhone keeps
  keychain items when an app is deleted, so on the first start with no receiver list the
  hub empties that service: what is there belongs to an install that is gone.
- **Android:** the account mode is off (below). When it is on, the key is in
  `account-keys.json` in the app's private storage, owner-only. That is weaker: a rooted
  phone or a full-device backup reads it, and nothing ties it to the hardware. The
  follow-up is the Android Keystore.
- **Desktop:** the hub's account mode is off; the server connects an account there
  (above).

The key is kept with the origin it is for, and is given to a request for no other
origin, whatever the list says and whatever id the entry has. It is in no log line,
error, URL, status file or returned value, and an answer that echoes it is withheld.

### What does not work yet

- **Android.** An account is reached over https, and the hub's https client verifies
  through the platform's verifier, which on Android must be handed the app's Java context
  at start (with its Kotlin half in the build). Nothing does that today, so the first
  https request there would end the app; this is true of an https receiver on Android
  too. The hub refuses to connect an account there and the contract does not list
  `"account"`. Android also has no signer, so `acct_device_ask` is `unsupported` there.
- **Notifications and needs-you.** The hub reads needs-you from a receiver's stream; an
  account has none, so no notification is posted for an account's session, and the status
  file's `needsYou` counts receivers only. Its `receivers[]` row for an account says
  `connected` (spacesheep answered the last door and took the key) and `lastFrameAt` (the
  relay's last good answer). The hook is one command by which the page hands the hub its
  needs-you list, emitted as the hub's own `NeedsYou` event; nothing arrives while iOS
  has the app suspended without a push from spacesheep.
- **A file with a start, images beside a prompt, search, forget:** as the spike found,
  these need doors spacesheep does not have for this key.
