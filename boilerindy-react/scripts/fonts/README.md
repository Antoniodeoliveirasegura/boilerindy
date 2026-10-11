# Fonts for scripts/render-icons.mjs

Plus Jakarta Sans, the BoilerIndy wordmark's face, for the link preview card
(`public/og-image.png`, issue #434). The render script reads these files and
embeds them in the page it screenshots; the site never serves them.

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
