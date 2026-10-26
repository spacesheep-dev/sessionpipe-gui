# Screenshots

Every image the README shows, all from **demo data** (`--demo`), never from a real state
dir: no real session, token or address of anyone's lands here. The sessionpipe skin, which
follows the appearance, so the set shows both of its schemes; 1440 × 900 at 2× for the
desktop shots, an iPhone 13 viewport at 3× for the phone shots. `shoot.mjs` in this folder
takes them all in one run (about two minutes).

| File | Scheme | Page | How it is set up |
|---|---|---|---|
| `board.gif` | light | `/` | Six seconds of the board updating live, Simple mode, cut from the moment a needs-you row is on it; 800 px wide, 8 fps, 48 colours; made only when `ffmpeg` is on the PATH |
| `board.png` | light | `/` | Simple mode; a row in every group, four of them labelled, done collapsed |
| `search.png` | light | `/search?q=webhook` | Best match: sessions from this machine's (generated) history and from the receiver, the hits marked |
| `search-palette.png` | dark | `/` | `⌘K` with "webhook" typed, the first *In transcripts* row selected and previewed |
| `session-simple.png` | light | `/s/…` | Simple mode: the chat, the open prompt with Allow / Deny live, the composer |
| `new-session.png` | dark | `/` | `c`: studio-mac, Claude Code, a folder it allows, a message; a sessionpipe 0.9 machine, so the one Permission line |
| `inbox.png` | light | `/inbox` | The top 420 px: an answerable prompt |
| `labels.png` | light | `/` | Four labelled rows (two named) and a row's *Label ▸* menu open |
| `subagents.png` | dark | `/s/…` | The newest run of the demo's subagent scene: three agents under their turn |
| `review.png` | light | `/review` | Advanced mode, Files, 7 days |
| `canvas.png` | dark | `/t/canvas` | Advanced mode, the *Machine* preset |
| `phone-board.png` | dark | `/` | The phone viewport, Simple mode |
| `phone-session.png` | light | `/s/…` | The phone viewport, Simple mode, the open prompt |
| `phone-wifi-phone.png` | dark | `/phone` | The phone side, no Tailscale: its own Wi-Fi steps |

The scheme column is the script's default split: `--scheme dark|light` sets the appearance
every shot gets (dark), `--light a.png,b.png` names the shots taken in light instead
(`--light` with no list takes none in light), and `--only a.png,b.png` takes just those.

With `--themes DIR`, the themes repo's shots (`sessionpipe-gui-themes/docs/screenshots/`:
`canvas.png`, `office-iso.png`, `office-figures.png`, `ping-a-human.png`) are taken in the
same run from the same server, always dark. Without it the run leaves that repo alone.

## What the script adds to the demo

So that the prompt-related shots show the real thing and not the "pair this machine"
placeholder, the script enrols a demo machine named `studio-mac` through the receiver's
**test door** (so the demo server must run with `--test-door`), sends it a hello and a
poll so it reads as paired and online, and then posts one extra Claude Code session on
that machine through the ordinary events route: a prompt, two tools, a transcript and an
open `Bash` permission. That session is forgotten and re-posted on every run so the prompt
is always newer than the machine's hello. The hello is a sessionpipe 0.9 daemon's (no start
options), and the door enrols one demo passkey id that every page also holds in its
`localStorage`, so New session and the composer read as on a paired device; nothing is ever
signed. Four stale rows get colour labels through `PATCH /api/ui/labels`. Everything else on
the board is the demo generator's.

Search reads a **generated** history home, never a real one: `bench/search/gen.mjs --profile
demo` writes invented Claude Code, Codex, Antigravity and Gemini CLI logs, and the server
reads them through `--search-home`. `SPGUI_HOSTNAME=studio-mac` names this machine in the
results, so no real hostname shows.

The `/phone` shot answers the phone routes (`/api/ui/phone`, the info's `control` block, the
device list) in the page with a fixed demo scene, since a lane state depends on Tailscale and
on a real phone: no real address, name or key reaches it.

## Regenerating

1. Build both repos from a clean tree (the GUI build bundles Canvas and Office from the
   themes repo beside it):

   ```sh
   node scripts/build.mjs && npx vite build --config web/vite.config.ts
   ```

2. Generate a history home and start a throwaway server on a free port (never a port
   someone is running the GUI on; the e2e suite owns 7311 and 7312) against a fresh scratch
   state dir. The skins and the ping-a-human plugin are bundled, and a bundled plugin stays
   off until enabled, so the demo never messages anyone; leave it off for the run.

   ```sh
   S=$(mktemp -d)
   node bench/search/gen.mjs --out "$S/gen" --profile demo
   cp -R "$S/gen/state" "$S/state"      # the generated sessions from other machines
   SPGUI_HOSTNAME=studio-mac node dist/cli.js --port 7391 --state "$S/state" --no-outbox \
     --demo --speed 10 --test-door --search-home "$S/gen/home" --quiet &
   ```

   Wait half a minute for the demo's opening scenes. The demo is deterministic (the same
   seed gives the same team) and `--speed 10` gets every state onto the board quickly. Shoot
   within a few minutes of the start: the demo replays its scenes as new sessions, so a long
   run fills Search and Canvas with repeats.

3. Shoot. The base URL must be `localhost`, not `127.0.0.1`: the page treats only
   `localhost` as a secure context, and the control buttons are off elsewhere.

   ```sh
   node docs/screenshots/shoot.mjs --base http://localhost:7391   # --no-gif skips the video
                                       # --scheme, --light, --only, --themes: see above
   ```

   It drives Chromium through the repo's `@playwright/test` dependency, sets Advanced or
   Simple mode and the appearance through `localStorage` before each page, waits for
   the stream to read `live` and for the elements each shot needs, dismisses the toasts the
   live demo raises, and disables CSS animations for the capture. The GIF is cut from a
   Playwright recording with `ffmpeg` (palette pass, then `paletteuse`).

4. Look at every image before committing it. Keep each PNG under 600 KB, the GIF under
   2 MB and the folder under 8 MB. Then bring each PNG to 256 colours, which about halves
   it: `pngquant --ext .png --force --quality 70-90 *.png` if it is installed, or `ffmpeg`:

   ```sh
   for f in *.png; do ffmpeg -loglevel error -y -i "$f" -vf "split[a][b];[a]palettegen=reserve_transparent=0:stats_mode=full[p];[b][p]paletteuse=dither=none" "q-$f" && mv "q-$f" "$f"; done
   ```

   Delete a shot the README no longer shows rather than leave it in the folder.

5. Stop the throwaway server and remove the scratch dir.

This folder's script is the only screenshot generator; the README embeds these files by name.
