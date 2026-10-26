# Your phone, other machines, and from anywhere

Two things need two different things:

| To | A device needs |
|---|---|
| **See** the board | the UI key, which the QR code carries (`?k=…`, then a cookie). `localhost` needs none |
| **Act** (send, allow, deny, stop, start) | a passkey, which a browser makes only on https or `localhost`, under one DNS name |

So a phone on plain Wi-Fi sees everything at once, and sends once it reaches the board over
https. The `/phone` page (also step 4 of Setup) recommends one way for this machine and keeps
the others under *Other ways*.

## Seeing: the QR code

`sessionpipe-gui` prints a QR code in the terminal; the Connect and phone pages show the
same one. Scan it on the same Wi-Fi and the board opens. Without the key, the network
answers 401. Anyone with the link can read the board, so treat it like a password; delete
`uiKey` from `config.json` and restart to make a new one.

## Sending, way 1: Tailscale (works away from home too)

No port forwarding, no certificate to install, and the board stays off the public internet.
On the machine that runs the board:

```sh
tailscale serve --bg 7373                                          # https://<machine>.<tailnet>.ts.net → this port
sessionpipe-gui --public-url https://<machine>.<tailnet>.ts.net    # remembered; --no-public-url forgets it
```

The phone page and Setup's optional sixth step do both with one click once they see
Tailscale running. The url's host becomes the passkeys' rp id, so use that one address on
the Wi-Fi too; passkeys made for another name are made again on first use.

Behind the proxy the server trusts `X-Forwarded-For`, `-Proto` and `-Host` only on
connections from loopback. A phone coming through it still needs the UI key, and Setup's
actions still answer only on this machine.

## Sending, way 2: the same Wi-Fi, with the GUI's own certificate

```sh
sessionpipe-gui --tls      # remembered until --no-tls; needs the openssl command
```

The same port then also speaks https, with a certificate from the GUI's own local CA for
`<machine>.local`, `localhost` and every LAN address. The QR code opens a plain-http **trust
page** that walks the phone through installing that one certificate (compare the SHA-256
fingerprint it shows with the one in the profile) and then forwards it to
`https://<machine>.local:7373`. Sinks and the daemon keep using plain http.

On this machine, `sessionpipe-gui tls trust` adds the CA to the macOS login keychain and
prints the steps elsewhere: on Linux, `~/.local/state/sessionpipe-gui/tls/ca.crt` goes in by
hand (`update-ca-certificates` on Debian and Ubuntu, `trust anchor` on Fedora), and Firefox
and Chrome keep their own stores. `tls status` shows the names, expiry and fingerprint;
`tls reset` starts over (phones then trust again). `<machine>.local` is mDNS: macOS
advertises it, Linux needs `avahi-daemon`, Windows 10 and later resolve it.

## A passkey for the phone

On the phone, *Send from this phone* (or `/add-device`) makes its passkey and shows six
digits. A device this machine already trusts compares them and approves; nothing reloads.
After that, the first send of a day asks for the passkey once and signs a day key that
signs the rest of that day's commands.

A page opened on an address where its passkeys cannot work (say `http://localhost` while
they live at the `.local` name) says "Sending works from https://…; open it there." instead
of offering to add a device.

## Other machines

Each machine runs sessionpipe and sends to this board with a sink. The line, filled in, is
on the Connect page and in the banner:

```sh
sessionpipe sink add http://<this-machine>:7373 --tier 3 --token <sink token>
```

`--tier` is how much that machine sends
([tiers](https://github.com/spacesheep-dev/sessionpipe#privacy-tiers)). To answer its agents
from here too, pair it at its own terminal:

```sh
sessionpipe control pair http://<this-machine>:7373
```

It prints a link and six digits; the page shows the same six; you approve with your
passkey. Over Tailscale, `sessionpipe connect https://<machine>.<tailnet>.ts.net` does the
hooks, the sink and the pairing in one approval.

## Other proxies and tunnels

Any https reverse proxy on this machine that sets `X-Forwarded-For`, `-Proto` and `-Host`
works the way Tailscale does. A public tunnel (Cloudflare, ngrok) works too, but then the UI
key and the sink token are all that stand between the internet and your sessions: put an
access layer in front. Publishing the port itself to the internet is not supported.
