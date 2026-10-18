# sid media kit

Ready-to-use identity assets for sid. The untouched supplied SVG is kept at
`source/sid-mark-original.svg`. The exported mark keeps its original shapes and
fills (`#F15A29`, `#F89B6C`, `#3B3B3C`, and `#C1481F`) with a tight, transparent
viewBox; neither SVG contains a white background object. Its PNG and the
wordmark and lockup PNGs also have transparent backgrounds. No alternate-color
versions of the mark are included. Lettering uses the frontend's Syne, TASA
Explorer, and Commit Mono fonts.

## Preview

Open [contact-sheet.png](contact-sheet.png) for the image set and
[images/sid-brand-sheet.png](images/sid-brand-sheet.png) for the color specimen.

## Assets

| File | Size | Use |
| --- | ---: | --- |
| `images/sid-3x2.png` / `.svg` | 1800 × 1200 | 3:2 media image |
| `images/sid-open-graph.png` / `.svg` | 1200 × 630 | Link previews |
| `images/sid-thumbnail.png` / `.svg` | 1280 × 720 | Video thumbnail |
| `images/sid-social-header.png` / `.svg` | 1500 × 500 | Social profile header |
| `images/sid-social-avatar.png` / `.svg` | 800 × 800 | Profile image |
| `images/sid-brand-sheet.png` / `.svg` | 1600 × 1080 | Palette specimen |
| `icons/app-icon.png` / `.svg` | 1024 × 1024 | App icon master |
| `icons/app-icon-512.png` | 512 × 512 | Web app manifest |
| `icons/apple-touch-icon.png` | 180 × 180 | iOS home screen |
| `icons/favicon.svg` | 64 × 64 | SVG favicon |
| `icons/favicon.ico` | 16, 32, 48 px | Browser favicon |
| `logos/sid-mark-color.svg` | Scalable | Supplied color mark, tight transparent viewBox |
| `logos/sid-mark-color.png` | 512 × 512 | Transparent color mark |
| `logos/sid-wordmark.svg` | 640 × 250 | Syne wordmark |
| `logos/sid-lockup.svg` | 1040 × 400 | Original mark and wordmark |

Every large image uses one title and one subtext directly beneath it. The social
avatar, app icon, and favicon use only the supplied mark.

## Color values

The site colors below are copied from `frontend/design/tokens.css` and
`frontend/src/status.css`.

| Role | Night | Paper |
| --- | --- | --- |
| Ground | `#111315` | `#F2F0EA` |
| Surface | `#1B1E21` | `#FFFFFF` |
| Raised surface | `#272B30` | `#E7E4DC` |
| Primary ink | `#E6E3DC` | `#141414` |
| Muted ink | `#AAA79F` | `#5A5751` |
| Rose | `#E0457B` | `#B8285A` |
| Teal | `#3FBFAE` | `#17736A` |
| Allow | `#3FC27C` | `#1A7A45` |
| Hold | `#F2B134` | `#E9A21A` |
| Block / deny | `#E5484D` | `#B8283A` |

The dark artwork uses the night-mode status colors from `--st-allow`,
`--st-hold`, and `--st-block`. The table also records the paper-mode values for
light backgrounds. The logo colors remain the four original values listed
above.

## Typography

| Typeface | Use |
| --- | --- |
| Syne 600 | Wordmark and large title |
| TASA Explorer 400 / 700 | Supporting copy |
| Commit Mono 500 | Source UI technical labels |

The wide crops use a dark site-ground, light text, and one large paper panel for
the mark. That keeps the charcoal logo facets distinct while keeping the single
subtitle legible. The status swatches use the website's exact allow, hold, and
block colors.

## Regenerate

From `frontend/`, run:

```sh
python3 brand/media-kit/source/generate.py
```

The script reads the fonts from the frontend's installed `@fontsource` packages.
It needs Pillow and fontTools in Python, plus a system Brotli decoder to open the
WOFF2 files. It only writes inside this media-kit folder.
