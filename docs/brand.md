# The brand

![sessionpipe](../web/public/brand/wordmark.svg)

The GUI wears the sessionpipe identity: the same mark, wordmark, palette and type as the
protocol's site and the native apps. Three inlets merge into one stream, and the stream
sends one event: graphite carries the noise, and one bright dot carries what matters. In
the app that dot is the needs-you signal, so the logo spends the orange where the app does.

## The mark

A 64-unit square (u = 1/64 of it): inlets at y 17 / 32 / 47 from x 9, merging at x 29 with
horizontal tangents (`M9 47C20 47 19 32 29 32`), the stream from x 29, a 3.25 u gap, a dot
of Ø 14 u at x 51. Thin strokes vanish small, so the drawing gets heavier as it shrinks; pick
the cut by the size the 64-unit box renders at:

| Box | Stroke | Stream ends | Dot | Where in the GUI |
|---|---|---|---|---|
| ≥ 128 px | 5.5 | 38 | Ø 14 | `mark.svg`, `wordmark*.svg`, `og.png` |
| 48–127 px | 6 | 38 | Ø 14 | |
| 20–47 px | 7 | 36 | Ø 15 | the sidebar (26 px), the rail (28 px), the favicon, the server pages |
| ≤ 19 px | 7.5 | 36 | Ø 15 | the 16 px favicon |

`web/src/components/Brand.tsx` draws it live with the cut for its size, in the
`--brand-inlet`, `--brand-stream` and `--brand-dot` tokens (tokens.css): on a light ground
#C4C4C0 inlets and an ink stream, on a dark one #454545 and #DADADA; the dot is always
#FF5A1F. No skin sets them: a skin never recolours the logo.

## The lockup

The mark, then **sessionpipe** in Geist Mono 500 at −0.045 em, outlined
(`web/public/brand/name.svg`), so it never depends on a font. It is placed exactly as the
design draws its lockups: the name is set at 46/88 of the mark's box, its ink is 28.905 u
tall, starts 9.048 u past the box (about one dot's width from the dot) and shares the mark's
x-height centre line. The sidebar sets it from a 29 px box (122 px wide, just over the
120 px the brand allows); the name is
a CSS mask in the text colour (`.brand-name`, brand.css), so it follows the scheme. The
server-rendered pages (`/trust`, the 401 page) inline the same lockup as one SVG
(`server/ui/brand.ts`; a unit test keeps its path equal to `name.svg`).

Don't recolour parts (the dot is the only accent), set the name in live text, re-space or
stack the two, or add a shadow, an outline or a gradient. The app icon's tile is the one
plate the mark sits on.

## Files

All in `web/public/brand/`, served by the GUI under `/brand/`, generated from the brand kit
(the design's construction, not redrawn by hand):

| File | What it is for |
|---|---|
| `favicon.svg`, `favicon.ico`, `favicon-32.png` | The browser tab: the small cut on an ink tile (radius 15/64), a hairline edge in dark mode |
| `apple-touch-icon.png` | 180 × 180, full bleed, no alpha |
| `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | The installed app (manifest.webmanifest); the maskable one keeps the mark inside the safe circle |
| `mark.svg`, `mark-mono.svg` | The mark alone for light grounds, and in `currentColor` |
| `wordmark.svg`, `wordmark-dark.svg` | The lockup for light and dark grounds (the README) |
| `name.svg` | The outlined name alone (the app's lockup mask) |
| `og.png` | 1200 × 630, the link preview |

## Colour

Mostly graphite, one accent. These are the `sessionpipe` skin (`shared/skins-builtin.ts`),
word for word the stock values of `web/src/styles/tokens.css` (a unit test holds them
equal), so the first frame is already on brand.

| Token | Light | Dark | |
|---|---|---|---|
| `--bg` / `--bg-2` | #FFFFFF / #FFFFFF | #141414 / #1C1C1B | the page, a card or a sheet |
| `--bg-3` / `--bg-4` | #F5F5F3 / #EBEBE7 | #222222 / #2A2A2A | wells, fields; raised in dark |
| `--line` / `--line-2` | #E4E4E1 / #DCDCD8 | #2A2A2A / #3A3A39 | hairlines |
| `--fg` | #141414 (18.4:1) | #F5F5F3 (16.9:1) | text |
| `--fg-2` | #454545 (9.6:1) | #C4C4C0 (10.5:1) | secondary text |
| `--fg-3` | #5C5C5A (6.7:1) | #9A9A96 (6.5:1) | meta |
| `--fg-4` | #858581 (3.7:1) | #6E6E6A (3.6:1) | marks only |
| `--needs` | #FF5A1F (3.1:1) | #FF5A1F (5.9:1) | needs you: dots, glyphs, the badge |
| `--needs-fg` | #C13B01 (5.4:1) | #FF5A1F | needs you as text |
| `--needs-ink` | #141414 (5.9:1 on the orange) | #141414 | text on an orange fill |
| `--err` | #CB234D (5.4:1) | #EF4C73 (5.2:1) | errors only |
| `--focus` | #F24D06 (3.6:1) | #FF5A1F | the focus ring |
| `--mark` / `--mark-fg` | #FFE1D7 / #141414 | #512617 / #F5F5F3 | a search hit |

The orange is never small text on a light ground (#FF5A1F is 3.1:1 on white): there it is a
dot, a glyph or a fill under ink, and `--needs-fg` when it must be words. Red is for errors
only: a crimson at OKLCH hue 10–14° against the orange's 38°, at least 0.10 apart in OKLab
in every shipped skin and scheme (`shared/skins-builtin.test.ts`). Working, stale, idle and
done are neutral tiers. The colour labels stay muted dots at half the accent's chroma, the
orange one leaning to ochre so it never reads as needs you.

**Paper**, the other shipped skin, is the brand's warm paper (#F5F4EF ground, #FAF9F5 cards,
#1F1E1D ink), light only. Its needs-you dot is the orange's 3:1 cut (#F24D06), since
#FF5A1F on warm paper is 2.8:1.

A device that had chosen **Spacesheep** (the default before the brand) moves to sessionpipe
once, silently (lib/theme.ts, and the boot script in index.html for the first frame).

## Type

**Geist** for text and **Geist Mono** for literal code, commands and paths, both v1.8.2,
SIL OFL 1.1 (`web/public/fonts/OFL.txt`). Self-hosted in `web/public/fonts/` and nothing
else is fetched: the variable weight axis cut to 400–600 (the app's three weights), subset to
Latin (Geist 20 KB, Geist Mono 16 KB) with Latin Extended in files that load only for a page
that uses those letters. `index.html` preloads the Latin Geist only. `styles/fonts.css`
also defines metric-matched stand-ins (Helvetica Neue on Apple, Segoe UI on Windows, Arial
or Liberation Sans elsewhere, Menlo and Consolas for mono) with `size-adjust` and the
ascent/descent overrides, so the swap moves no line. The server-rendered pages keep the
system face: they are shown before the key that serves the font files.

## Trademark

"sessionpipe" and the sessionpipe logo are marks of Michael Makarov
([TRADEMARKS.md](https://github.com/spacesheep-dev/sessionpipe/blob/main/TRADEMARKS.md)).
Use the files as they are.

## Third-party marks

Where the board names the harness a session runs in, it shows that product's mark in
one colour beside the text (`web/src/lib/harnessIcons.ts`): the Anthropic mark for
Claude Code, the OpenAI mark for Codex, the Gemini mark for Gemini CLI, the Antigravity
arch for Antigravity, the Cursor mark for Cursor. The path data for all but Antigravity
comes from [simple-icons](https://simple-icons.org) (CC0); Antigravity's is redrawn in one
colour from the app's own monochrome asset. The marks themselves are trademarks of
Anthropic, OpenAI, Google and Anysphere, used here only to identify the software a
session runs in. This project is not affiliated with, sponsored by or endorsed by any of
them. Harnesses without a mark (the rest of the registry in sessionpipe's
`spec/ADAPTERS.md`) keep their two-letter monogram. The marks stay monochrome and never
take a brand colour; the orange is still the only accent.
