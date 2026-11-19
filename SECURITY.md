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
(7373 by default) for these callers. "This computer" is a request from loopback that did
not come through the proxy; only when `--host` binds the receiver to one address that is
not loopback, a request from that same address (not through the proxy) is this computer
instead. One rule decides it everywhere (`server/http/net.ts` `onThisComputer`). As with loopback
in the default mode, a program on the machine, a tunnel or a proxy that connects to that
bound address and names no visitor counts as this computer there. Setup's actions, the
phone page's Tailscale button and the search index's also answer a request from one of
this machine's own addresses (not through the proxy) that brings the UI key: the `.local`
secure page in a browser on the computer itself.

| Caller | Credential | What it may do |
|---|---|---|
| A `sessionpipe` sink on another machine | `Authorization: Bearer <sink token>` | `POST` event batches (`/api/sessionpipe/v1/events`) |
| A browser on another device, or through the proxy | the UI key, carried once in `?k=` and then as the `spgui` cookie | read the board, the UI API and the SSE stream (not the sink token); sign control commands with a passkey |
| A browser on this computer | none, on the receiver's own pages | the above, plus the sink token and the routes for this computer only: rotate the sink token, a new UI key, toggle demo, plugin and skin settings, setup |
| `sessionpipe-gui key renew` on this computer | the run's secret in `<state>/run/` (0600) | a new UI key |
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

**Requests from a browser.** The receiver answers its own pages, and on its own machine
under its own names. Before any route is reached, a request the browser marks as coming
from another origin is refused (another site may link to a page; it can neither read an
answer nor change anything), and a
request made on this machine must name the receiver by a name it hands out itself or was
given (`localhost`, an address, the `.local` name, or one given with `--allow-host`); the
public url's name is answered through the proxy only. Pages are sent with
`frame-ancestors 'self'`, and no route answers a CORS preflight, so no page of another
origin reads an answer. The routes sinks and daemons call answer to their own bearer
tokens. Details: `server/http/guard.ts` and [ARCHITECTURE.md](ARCHITECTURE.md).

**Where secrets live.** `~/.local/state/sessionpipe-gui/config.json` (the sink token,
the UI key), `control/` (hashes of the per-machine tokens), `tls/` (the local CA and
server key when `--tls` is on), `plugins-settings/` (plugin secrets, mode 0600, masked on
the wire and in logs). The sink token is shown only on this computer (`/api/ui/info`
gives it to no one else), and a pairing link carries its code and nothing else. Every
machine that sends holds the sink token; rotating it stops a sender (the Connect page, or
`POST /api/ui/token/rotate`, this computer only), and every machine that should go on
sending is given the new one. Give the board a new UI key with `sessionpipe-gui key renew`,
or *New link…* in a link's menu on the Connect page (`POST /api/ui/key/renew`, this
computer only). After a new key only the new key opens a receiver of this version, and no route answers
anything that leads to it; a phone or browser that came in by the old link is asked for
the new one. A new UI key does not stop a sender; the sink token does that. The receiver
also makes a new UI key when the text it keeps or takes in holds the current one (a key of
at least 16 characters): the first at once, a later one in the same run of finds after 30
seconds, then twice as long each time, up to ten minutes. `config.json` keeps the SHA-256
of every key and token of 16 characters or more this board replaced (the newest 64, never
the secrets), and no
receiver of this version on the folder takes one of them back, also after a restart.

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
- Reaching a route for this computer only, from elsewhere.
- A page of another origin changing anything through the receiver, or reading anything
  from it.
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
