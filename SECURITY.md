# Security

## Reporting

Report a vulnerability privately through GitHub's **Report a vulnerability** button on
the Security tab of this repository (private vulnerability reporting). Do not open a
public issue for anything that could let someone read sessions, forge a command or reach
a machine. You should hear back within a week; a fix for a confirmed report ships as a
patch release with a security advisory that credits you, unless you ask otherwise.

Versions: only the latest `0.x` release receives fixes.

## What this software does, in security terms

`sessionpipe-gui` is one Node process on a machine you own. It listens on one port
(7373 by default) for three kinds of callers:

| Caller | Credential | What it may do |
|---|---|---|
| A `sessionpipe` sink on another machine | `Authorization: Bearer <sink token>` | `POST` event batches (`/api/sessionpipe/v1/events`) |
| A browser on the LAN | the UI key, carried once in `?k=` and then as the `spgui` cookie | read the board, the UI API and the SSE stream; sign control commands with a passkey |
| A browser on `localhost` | none (loopback is trusted) | the above, plus the loopback-only routes: rotate the sink token, toggle demo, plugin and skin settings, setup |
| A paired machine's daemon | that machine's own bearer token | poll and ack its control queue |

**The control channel.** Every command a page sends to a machine (a message, a
permission answer, a stop, a new session) is signed on the person's device by a WebAuthn
passkey, or by a day key that passkey vouched for once that day. The receiver carries
commands and holds a bearer token per machine; it holds no key that can sign, so a
compromised receiver cannot forge one. The machine's daemon verifies the signature against
the keys enrolled at its own terminal before anything reaches the harness. A plugin may
*suggest* an answer; nothing reaches a machine until a person confirms with a passkey.
The sink token authenticates event batches and the UI key signs a browser into the page;
neither authorizes a command. Details: the sessionpipe `CONTROL.md` spec and
[ARCHITECTURE.md](ARCHITECTURE.md).

**Where secrets live.** `~/.local/state/sessionpipe-gui/config.json` (the sink token,
the UI key), `control/` (hashes of the per-machine tokens), `tls/` (the local CA and
server key when `--tls` is on), `plugins-settings/` (plugin secrets, mode 0600, masked on
the wire and in logs). Rotate the sink token from the Connect page or
`POST /api/ui/token/rotate` (loopback only); a new UI key is made by deleting `uiKey`
from `config.json` and restarting.

**Network exposure.** The GUI is meant for a trusted LAN. The web bundle calls only its
own origin, and there is no telemetry. The server makes outbound requests only for what
you turn on: a plugin, which runs in the server process once installed or enabled
(ping-a-human calls Telegram's API); and a spacesheep account you connect (Settings →
Data). Connecting sends this machine's name and the GUI's version to the spacesheep
account's origin (spacesheep.dev) to get the four-digit code. Once connected, every
request there carries the account's key: the server polls the relay, lists its machines
and jobs, forwards the messages you send and, when you approve the app on spacesheep
(Machines), sends the app's public device key with this machine's name. Installing an
extension from a URL, npm or git is the `view add` CLI command's request, in the CLI
process, not the running server. Putting the port on the public internet is not a
supported configuration.

## In scope

- Reading events, sessions or the stream without the UI key or the sink token.
- Reaching a loopback-only route from a non-loopback address.
- Forging, replaying or redirecting a control command; getting a suggestion delivered
  without a passkey confirmation.
- Path traversal or injection through the static server, attachments, installed views,
  skins or plugins, or the setup routes.
- Leaking a secret into a log, an error page, an API response or a screenshot.
- Weaknesses in the TLS mode: certificate issuance, the trust page, the dual-protocol listener.

## Out of scope

- A view, skin or plugin you chose to install. A view runs in the page with everything
  the page has; a plugin runs in the receiver with everything the machine has. The GUI
  says so at install time; install only what you trust.
- Anything that needs the attacker to already be on `localhost` of the receiver machine.
- Exposure caused by publishing the port to the internet, or by sharing the QR code or
  the `?k=` address.
- The sessionpipe CLI, daemon and hooks themselves: report those to the
  [sessionpipe project](https://github.com/spacesheep-dev/sessionpipe).
