# RFC 07: Receiver-vouched devices

Status: Draft · 2026-11-03 · Owner: the GUI, with a sessionpipe spec change (CONTROL.md §2)

## The problem

Pairing today is three separate approvals, each with its own prompt and its own failure:

1. **The machine pairs with the receiver.** The terminal prints six digits and a link; a
   browser that holds a passkey approves (CONTROL.md §2). One tap, once per machine.
2. **Every device that sends needs trust on every machine.** A new phone or laptop (or the
   desktop app's Secure Enclave key) asks to be added; a device the machine already
   trusts signs a `key.add` for it, per machine, after typing the two digits the new device
   shows. With three machines and a laptop, a phone and the app, that is nine approvals.
3. **The board has its own key** (the UI key in the terminal's link). A browser without
   its cookie meets "This board needs its key".

On 2026-11-03 a person pairing a Mac mini with the GUI on their laptop hit all three in
one evening: the printed link was the tailnet address (no key, no passkey origin), the
stored passkey did nothing when picked, and the app, asked to approve its own key, came
back "the machine doesn't trust this Mac yet". #82 and #84 fix the link and the hand-off.
This RFC is for step 2, the one that multiplies.

## What stays

The protocol's stance is that the machine never trusts the receiver: every command it runs
is signed by a key it enrolled itself, and a receiver only carries bytes. That stays the
default, and nothing here weakens a machine that does not opt in.

## The proposal

A machine MAY, at the person's choice on that machine, enroll **the receiver's own key** at
pairing time and accept a `key.add` signed by it. The receiver signs such a `key.add` only
for a device the person has just approved on the receiver with a passkey the receiver
knows. One approval on the receiver then reaches every machine that opted in.

### Wire

- **Hello / pairing request** (CONTROL.md §2): the machine says `vouch: true` when the
  person turned it on (`sessionpipe control vouch on`). A receiver sees the capability
  before using it, as with `ask`, `handoff` and `pool`.
- **Pairing response**: when the hello said `vouch`, the receiver's reply to the pairing
  request carries `receiver_key: { id, alg, spki }`, the receiver's long-lived signing key
  for this account (one per receiver, rotated like any key). The machine stores it beside
  the passkeys, typed `receiver`.
- **`key.add` signed by the receiver key**: same command, same session `sessionpipe:keys`,
  `csig` by the receiver key, no grant, no confirm. The verifier (sessionpipe-core
  `control/verify.ts`) takes a `receiver` key for `key.add` only; any other kind signed by
  it is `untrusted_key`. The machine logs who vouched (`control keys` shows "added by
  <receiver host>").
- **Revocation**: `sessionpipe control vouch off` drops the receiver key and every key it
  added, unless the person keeps them (`--keep`). The receiver learns on the next hello.

### Receiver side (the GUI and spacesheep alike)

- A device request (the phone, the app) is approved on the receiver as today: a passkey the
  receiver knows signs the approval. With `vouch` machines present, the receiver then signs
  a `key.add` per such machine itself; machines without `vouch` still need a trusted
  device's signature, so the page says which machines took it and which wait.
- The receiver key lives in the receiver's state (`<stateDir>/control/receiver-key`, mode
  0600 on the GUI; a per-account secret in spacesheep's DO). It signs nothing but `key.add`.

### What the person sees

- `sessionpipe control pair https://laptop.local:7373 --vouch` (or `vouch on` later): one
  line in the terminal says "This machine takes devices this board approves."
- Machines shows "Devices you approve here are trusted on 3 of 4 machines; build-box
  needs a device's own tap" with the two routes side by side.
- Adding a phone becomes: scan the QR, tap Approve once in the browser. Done everywhere.

## Risks and the answer to each

- **A compromised receiver can add a key.** True, and that is the trade: a receiver that
  holds the account's sessions (tier 2 transcripts) already holds most of what matters. The
  mode is opt-in per machine, visible in `control keys` and on Machines, and revocable with
  one command. It MUST stay off by default and MUST NOT be turned on by a receiver.
- **The receiver key is a new secret to protect.** It signs `key.add` only, so a stolen key
  lets an attacker enroll a device, not run a command; the next `control keys` shows the
  stranger, and `vouch off` ends it.
- **Old daemons.** They never say `vouch`, never get a receiver key, and refuse a
  receiver-signed `key.add` as `untrusted_key`, so nothing changes for them.

## Plan

1. sessionpipe: CONTROL.md §2 text, `control-hello.json` and `control-pair.json`
   (`vouch`), the pairing response field, `verify.ts` (the `receiver` key type, `key.add`
   only), two conformance vectors (a valid receiver-signed `key.add`; a prompt signed by a
   receiver key refused), `sessionpipe control vouch on|off [--keep]`. One PR, ~2 days.
2. GUI: the receiver key, signing `key.add` after a device approval for `vouch` machines,
   the Machines and Devices copy, the pair page's `--vouch` hint. ~2 days.
3. spacesheep: the same two pieces in `machines.ts` / the DO. ~1 day, after 1 ships.

## Out of scope

Pairing the machine itself still needs one passkey tap per machine: that is the moment the
person says "this computer is mine", and it must stay a person's act.
