# Screenshots

Every image the README shows, all from **demo data** (`--demo`), never from a real state
dir: no real session, token or address of anyone's lands here. The sessionpipe skin, which
follows the appearance, so the set shows both of its schemes; 1440 × 900 at 2× for the
desktop shots, an iPhone 13 viewport at 3× for the phone shots. `shoot.mjs` in this folder
takes them all in one run (about two minutes).

| File | Scheme | Page | How it is set up |
|---|---|---|---|
| `board.png` | light | `/` | Advanced mode; a card in every group, done collapsed |
| `board.gif` | light | `/` | Six seconds of the board updating live, cut from the moment a needs-you card is on it; 960 px wide, 10 fps; made only when `ffmpeg` is on the PATH |
| `setup.png` | dark | `/setup` | From the receiver machine; the live steps on a fresh state dir |
| `session-simple.png` | light | `/s/…` | Simple mode: the chat, a composer at the bottom, Allow / Deny live |
| `session-advanced.png` | dark | `/s/…` | Advanced mode: the timeline of the same session, the tier lens |
| `inbox.png` | light | `/inbox` | An answerable prompt with live Allow / Deny |
| `canvas.png` | dark | `/t/canvas` | The canvas view with the Map on, after Tidy and Fit |
| `office.png` | dark | `/t/office` | The office view, iso style |
| `review.png` | light | `/review` | A search for "webhook" with hits, the Files tab below |
| `connect.png` | light | `/connect` | The QR code loaded; the sink token in its **masked** state |
| `appearance.png` | light | any | The appearance popover open: Light, sessionpipe selected, the installed skins listed |
| `keyboard.png` | dark | any | The `?` help open |
| `phone-board.png` | dark | `/` | The phone viewport, Simple mode |
| `phone-session.png` | light | `/s/…` | The phone viewport, Simple mode |
| `phone-trust.png` | dark | `/trust` | The TLS instance's trust page on the phone viewport |
| `phone-tailscale-desktop.png` | dark | `/phone` | The laptop side with Tailscale running here: the one button, the chip |
| `phone-wifi-desktop.png` | light | `/phone` | The laptop side, no Tailscale: the trust QR and both phones' steps |
| `phone-waiting-desktop.png` | dark | `/phone` | A phone asking to be trusted: its six digits and Approve at step 3 |
| `phone-trusted-desktop.png` | dark | `/phone` | The phone trusted: step 3 green, the trusted list |
| `phone-wrong-origin-desktop.png` | dark | `/s/…` | The composer on the wrong address: the one line naming where sending works |
| `phone-tailscale-phone.png` | dark | `/phone` | The phone side with Tailscale serving: the address and the app line |
| `phone-wifi-phone.png` | dark | `/phone` | The phone side on iPhone: its own steps and Check |
| `phone-waiting-phone.png` | light | `/phone` | The phone waiting for the laptop, its six digits |
| `phone-trusted-phone.png` | dark | `/phone` | The phone trusted: "Open the board" |
| `phone-wrong-origin-phone.png` | dark | `/s/…` | The composer at phone width on the wrong address |

The scheme column is the script's default split: `--scheme dark|light` sets the appearance
every shot gets (dark), and `--light a.png,b.png` names the shots taken in light instead
(`--light` with no list takes none in light). The themes repo's shots are always dark.

The themes repo's shots (`sessionpipe-gui-themes/docs/screenshots/`: `canvas.png`,
`office-iso.png`, `office-figures.png`, `ping-a-human.png`) are taken in the same run from
the same servers.

## What the script adds to the demo

So that the prompt-related shots show the real thing and not the "pair this machine"
placeholder, the script enrols a demo machine named `studio-mac` through the receiver's
**test door** (so the demo server must run with `--test-door`), sends it a hello and a
poll so it reads as paired and online, and then posts one extra Claude Code session on
that machine through the ordinary events route: a prompt, two tools, a transcript and an
open `Bash` permission. That session is forgotten and re-posted on every run so the prompt
is always newer than the machine's hello. Everything else on the board is the demo
generator's.

The `/phone` shots answer the phone routes (`/api/ui/phone*`, the info's `control` block, the
device list) in the page with fixed demo scenes, since a lane state depends on Tailscale and
on a real phone: no real address, name or key reaches them. The phone-side waits are seeded
through the tab's remembered device request, which a reload mid-wait also uses.

The trust page names the machine the GUI runs on (its mDNS name). Before that one capture
the script replaces that name in the page's text nodes with `studio-mac`, so the shot
shows a demo machine; nothing else about the page is changed.

## Regenerating

1. Build both repos from a clean tree (the GUI build bundles Canvas and Office from the
   themes repo beside it):

   ```sh
   node scripts/build.mjs && npx vite build --config web/vite.config.ts
   ```

2. Start two throwaway servers on free ports (never a port someone is running the GUI on;
   the e2e suite owns 7311 and 7312) against a scratch state dir. The skins and the
   ping-a-human plugin are bundled, and a bundled plugin stays off until enabled, so the
   demo never messages anyone; leave it off for the run.

   ```sh
   S=$(mktemp -d)
   node dist/cli.js --port 7391 --state "$S" --no-outbox --demo --speed 10 --test-door --quiet &
   node dist/cli.js --port 7392 --state "$S-tls" --no-outbox --tls --rp-id localhost --quiet &
   ```

   Wait half a minute for the demo's opening scenes. The demo is deterministic (the same
   seed gives the same team) and `--speed 10` gets every state onto the board quickly. The
   second instance exists only for the trust page; `--rp-id localhost` because the headless
   browser cannot resolve this machine's `.local` name.

3. Shoot. The base URL must be `localhost`, not `127.0.0.1`: the page treats only
   `localhost` as a secure context, and the control buttons are off elsewhere.

   ```sh
   node docs/screenshots/shoot.mjs --base http://localhost:7391 --tls https://localhost:7392 \
     --themes ../sessionpipe-gui-themes/docs/screenshots      # --no-gif skips the video
                                                              # --scheme, --light: see the table
   ```

   It drives Chromium through the repo's `@playwright/test` dependency, sets Advanced or
   Simple mode and the appearance through `localStorage` before each page, waits for
   the stream to read `live` and for the elements each shot needs, dismisses the toasts the
   live demo raises, and disables CSS animations for the capture. The canvas Map toggle is
   read from the button's state, since the view keeps it in its server-side storage. The
   GIF is cut from a Playwright recording with `ffmpeg` (palette pass, then `paletteuse`).

4. Look at every image before committing it. Keep each PNG under 600 KB, the GIF under
   2 MB and the folder under 8 MB; `pngquant --ext .png --force --quality 70-90` on the
   folder if it is installed. Delete a shot the README no longer shows rather than leave it
   in the folder.

5. Stop the throwaway servers and remove the scratch state dir.

This folder's script is the only screenshot generator; the README embeds these files by name.
