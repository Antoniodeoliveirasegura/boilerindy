# Brand posture

BoilerIndy is a student-built project that is not affiliated with Purdue
University. Purdue actively protects the "Purdue" and "Boilermaker" marks and
its gold-and-black trade dress, so the app leans on nominative fair use: it
names Purdue only to describe who the app is for, and it uses none of the
university's own identity assets. This page records what the code does about
that (issue #112) so the posture does not drift.

## What the app uses

| Asset | Value | Notes |
| --- | --- | --- |
| Name | BoilerIndy | Own wordmark, plain text, no logo lockup with Purdue's. |
| Gold (light theme) | `#D4A84B` | `--color-gold` in `boilerindy-react/src/index.css`. |
| Gold (dark theme) | `#E8C878` | `--color-gold` under `[data-theme="dark"]`. |
| Icons | `boilerindy-react/public/favicon.svg` and the PNGs rendered from it | Self-drawn. |

The gold is deliberately not Purdue's official `#CFB991` (Boilerexams, a peer
student project, made the same call with `#D0BA92`). `test/brandGold.test.mjs`
fails the backend suite if that literal appears in `server.mjs`, `src/`, the
React source or `public/`. The last three places it survived (the dev-only mock
Purdue link page, the crash fallback button and the advertiser reset email)
were switched to `#D4A84B` on 2026-09-14.

## What the app does not use

- No Purdue logos, seals, the Motion P, or Purdue Pete. Assets are the
  self-drawn favicon only. Do not add mascot art, even as a joke.
- No Purdue fonts or official templates.
- No claim of endorsement in copy. "For Purdue University Indianapolis
  students" is fine; "Purdue's campus app" is not.

## The disclaimer

`boilerindy-react/src/components/SiteDisclaimer.tsx` is the single source of
the wording:

> BoilerIndy is an independent, student-built project. It is not affiliated
> with, endorsed by, sponsored by, or officially connected to Purdue University.
> "Purdue", "Boilermaker" and related marks are trademarks of Purdue University.

It renders on every route:

- authenticated pages through `AppLayout`;
- `/reset-password`, `/auth/callback`, `/advertise/reset-password` and
  `/advertise/dashboard` through `PublicLayout`;
- Landing, Login, the advertiser login, Privacy, Terms and Install place it
  themselves because they add a page-specific note or sit inside a document
  column.

`PublicLayout.test.tsx` pins both the coverage and the wording. Terms and
Privacy repeat the disclaimer in their own text.

## Open decision (owner)

Purdue Trademarks and Licensing has not been asked whether "BoilerIndy" and the
gold accent need permission or a rename before public marketing. Record the
answer, or the conscious decision to proceed without asking, here and in
issue #112.
