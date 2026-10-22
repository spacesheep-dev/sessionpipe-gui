# The mark

![sessionpipe gui](../web/public/brand/wordmark.svg)

A rounded tile, two short bars and one amber dot. The bars are the desk: the last thing
a session said, the shape of a card on the board. The dot is the one who needs you, in
the corner where the rail puts its badge. That is the whole product in one glance: the
sessions, and the one to look at first.

The amber is the app's only accent (`--needs`), so the mark spends it where the app
does. Everything else is the neutral pair the interface is drawn in: the tile is the
foreground colour, the bars the background, so in the app the mark inverts with the
theme, like the rest of the page.

It is a sibling of the sessionpipe logo, not a variant of it: the same rounded-square
family, a different motif and a different colour. It never carries the pulse line.

## Files

All in `web/public/brand/`, served by the GUI under `/brand/`.

| File | What it is for |
|---|---|
| `mark.svg` | The mark alone: dark tile, paper bars, amber dot. For light surfaces, or anywhere a fixed colour is wanted. |
| `mark-mono.svg` | One ink, `currentColor`, the bars and the dot cut out. For inline SVG or a CSS mask; inside an `<img>` it renders black. |
| `favicon.svg` | The mark, following the browser's colour scheme like the rail does. Linked from `index.html`. |
| `wordmark.svg`, `wordmark-dark.svg` | Mark and name, for light and dark surfaces. The name is Inter Medium (OFL) as paths, so it needs no font; "gui" is a tier down. |
| `apple-touch-icon.png` | 180 × 180, full bleed; iOS rounds the corners. |
| `og.png` | 1200 × 630, the link preview. |

In the app and on the server-rendered pages the mark is drawn inline from the tokens
(`web/src/components/Brand.tsx`, `server/ui/brand.ts`), and the name is set live in the
UI face at weight 500. The SVG files are for the places that cannot do that: the README,
a link preview, a slide.

## Geometry

A 16-unit grid; every edge on a whole unit, so 16, 32, 64, 128 and 512 px all land on
pixels.

```
tile   0,0  16 × 16   corner radius 4
bar    3,8   5 × 2    corner radius 1
bar    3,11 10 × 2    corner radius 1
dot    centre 11,5    radius 2
```

Colours, as the app's tokens and their sRGB values in the files:

| | Light | Dark |
|---|---|---|
| Tile | `--fg` `oklch(0.22 0.014 265)` `#171b21` | `--fg` `oklch(0.92 0.006 85)` `#e6e4e0` |
| Bars | `--bg` `oklch(0.985 0.004 85)` `#fbfaf7` | `--bg` `oklch(0.165 0.008 255)` `#0c0f12` |
| Dot | `--needs` `oklch(0.72 0.15 65)` `#e48e26` | `--needs` `oklch(0.78 0.13 70)` `#eca851` |
| "gui" | `--fg-3` `#656971` | `--fg-3` `#94928d` |

The wordmark: the name at 15 units on the 16-unit mark, baseline at 12, an 8-unit gap
after the mark (half the mark). Total 137 × 16.

## Clear space and size

Keep clear space of a quarter of the mark on every side (4 px at 16, 8 px at 32), and
half the mark's height around the wordmark. Nothing sits inside that space, including a
rule.

Smallest sizes: the mark 16 px, the wordmark 20 px tall. The rail shows the mark at 20
px; the empty board, the trust page and the 401 page show the wordmark at 20 px.

## Do and don't

- Do use the mark on the app's own neutrals, light or dark. On a dark surface prefer the
  inverted tile (`wordmark-dark.svg`, or the live mark in the app).
- Do use `mark-mono.svg` where only one colour is available.
- Don't recolour it. Amber is the only accent; the tile and bars are the neutral pair.
- Don't add a shadow, a gradient, an outline, or a second dot.
- Don't stretch it, rotate it, or set it smaller than 16 px.
- Don't put the pulse line in it, and don't present it as the sessionpipe logo. It is
  the mark of this GUI, a receiver that speaks the sessionpipe protocol.
- Don't set the name in another face, another case or another weight. It is
  "sessionpipe gui", lowercase, with "gui" one tier lighter.

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
take a brand colour; the amber is still the only accent of the stock scheme.

The default skin, **Spacesheep**, carries the colours of [spacesheep](https://spacesheep.dev)
as a whisper: cool neutrals of the brand's indigo hue at low chroma, and the sheep's flame
for *needs you*, the one accent; working, stale, idle and done are neutral tiers, red is
for errors only (`shared/skins-builtin.ts`). It uses no logo or wordmark of spacesheep's:
it is a colour palette, not a rebrand. The other shipped skin, **Paper**, is warm paper and
ink, light only. The server-rendered pages (`/trust`, the 401 page) and the OG image keep the
neutral stock palette for now.

## Trademark

"sessionpipe" and the sessionpipe logo are marks of Michael Makarov
([TRADEMARKS.md](https://github.com/spacesheep-dev/sessionpipe/blob/main/TRADEMARKS.md)).
This mark is distinct from that logo on purpose, is not a modification of it, and does
not imply that the sessionpipe project endorses or is affiliated with this GUI. The
name follows the allowance for `sessionpipe-*` adapters and plugins that work with
sessionpipe. Inter is used under the SIL Open Font License.
