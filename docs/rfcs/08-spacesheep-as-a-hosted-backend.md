# RFC 08: spacesheep as a hosted backend (the relay option)

Status: Draft, being built · 2026-11-03 · Owner: the GUI and spacesheep together

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
