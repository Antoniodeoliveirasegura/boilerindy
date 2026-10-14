import { Link } from 'react-router-dom'
import { withFrom } from '../lib/privacyNav'

// Single source of truth for the "not affiliated with Purdue" disclaimer
// (issue #112). Replaces the wording that used to be duplicated inline across
// Landing, Login, AdvertiserLogin, and Privacy. `note` carries any
// page-specific line (a tagline or hint) shown above the disclaimer;
// `className` lets a layout add spacing (e.g. clearing the fixed mobile nav).
// `rule` draws a 1px top rule; the app and public layouts set it, while a page
// that places the disclaimer inside its own footer (Landing) already has one.
// The Support link (issue #193) keeps the contact the app stores ask for one
// tap away from every route. `from` is the legal pages' incoming ?from=,
// passed on so a hop through these links keeps their back target (see
// lib/privacyNav.ts); every other caller leaves it unset.
export default function SiteDisclaimer({
  note,
  className = '',
  rule = false,
  from,
}: {
  note?: string
  className?: string
  rule?: boolean
  from?: string | null
}) {
  return (
    <div
      className={`${rule ? 'border-t border-[var(--color-border-2)] ' : ''}px-6 py-6 text-center text-[12px] leading-relaxed text-[var(--color-txt-3)] ${className}`}
    >
      {note ? <p className="mx-auto mb-1.5 max-w-[880px] text-[12.5px] text-[var(--color-txt-2)]">{note}</p> : null}
      <p className="mx-auto max-w-[880px]">
        BoilerIndy is an independent, student-built project. It is not affiliated with, endorsed
        by, sponsored by, or officially connected to Purdue University. &ldquo;Purdue&rdquo;,
        &ldquo;Boilermaker&rdquo; and related marks are trademarks of Purdue University.{' '}
        <Link to={withFrom('/terms', from)} className="font-semibold text-[var(--color-txt-2)] no-underline hover:underline underline-offset-2">
          Terms
        </Link>
        {' · '}
        <Link to={withFrom('/privacy', from)} className="font-semibold text-[var(--color-txt-2)] no-underline hover:underline underline-offset-2">
          Privacy
        </Link>
        {' · '}
        <Link to={withFrom('/support', from)} className="font-semibold text-[var(--color-txt-2)] no-underline hover:underline underline-offset-2">
          Support
        </Link>
      </p>
    </div>
  )
}
