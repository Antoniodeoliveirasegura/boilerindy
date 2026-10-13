# Fonts for scripts/render-icons.mjs

Plus Jakarta Sans, the BoilerIndy wordmark's face, for the link preview card
(`public/og-image.png`, issue #434). The render script reads these files and
embeds them in the page it screenshots.

The site ships the same three files from `public/fonts/` (with `OFL.txt`):
the app's headings, buttons and labels are set in them, and `index.html`
preloads the 800 weight. Keep the two copies identical. `vercel.json` caches
`/fonts/*` for a year as immutable, so a changed font needs a new file name.

| File | Weight | On the card |
| --- | --- | --- |
| `PlusJakartaSans-ExtraBold.woff2` | 800 | the wordmark |
| `PlusJakartaSans-Bold.woff2` | 700 | the domain line |
| `PlusJakartaSans-SemiBold.woff2` | 600 | the tagline |

Source: release 2.7.1 of https://github.com/tokotype/PlusJakartaSans
(`PlusJakartaSans-2.7.1.zip`, SHA-256
`4bfc5cdf97d750423bb3d1d40ed8e529bc92288924d9c65e18ff486acefac66c`). The
release ships TTF only, so its static TTFs were converted with fontTools
4.51.0, for example:

    python3 -m fontTools.ttLib.woff2 compress -o PlusJakartaSans-ExtraBold.woff2 ttf/PlusJakartaSans-ExtraBold.ttf

The conversion is lossless: decompressed again, every table matches the TTF
except `head`, where WOFF2 sets flag bit 11 and the checksum changes with it.

License: the SIL Open Font License 1.1, in `OFL.txt`, copied unchanged from
the release. The OFL, not the repository's Apache License, covers these files.

## Trimmed display punctuation

`public/fonts/JakartaDisplayPunct-ExtraBold.woff2` (under 1 KB) is generated,
not copied: `display-punct.py` cuts the period, comma, colon, semicolon and
exclamation mark out of `public/fonts/PlusJakartaSans-ExtraBold.woff2`, trims
their sidebearings and renames the family to "Jakarta Display Punct". The 800
headings put it in front of Plus Jakarta Sans with `unicode-range`
(`--font-headline` in `src/index.css`), so a trailing mark no longer reads as a
stray space at display sizes. Rebuild it from `boilerindy-react/` with

    python3 -I scripts/fonts/display-punct.py

and give the output a new file name whenever the trims change (the `/fonts`
cache is immutable). It is a Modified Version under the same OFL.
