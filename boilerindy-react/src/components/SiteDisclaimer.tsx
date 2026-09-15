import { Link } from 'react-router-dom'

// Single source of truth for the "not affiliated with Purdue" disclaimer
// (issue #112). Replaces the wording that used to be duplicated inline across
// Landing, Login, AdvertiserLogin, and Privacy. `note` carries any
// page-specific line (a tagline or hint) shown above the disclaimer;
// `className` lets a layout add spacing (e.g. clearing the fixed mobile nav).
// The Support link (issue #193) keeps the contact the app stores ask for one
// tap away from every route.
export default function SiteDisclaimer({
  note,
  className = '',
}: {
  note?: string
  className?: string
}) {
  return (
    <div
      className={`px-6 py-6 text-center text-[11px] leading-relaxed text-[var(--color-txt-3)] ${className}`}
    >
      {note ? <p className="mb-1">{note}</p> : null}
      <p>
        BoilerIndy is an independent, student-built project. It is not affiliated with, endorsed
        by, sponsored by, or officially connected to Purdue University. &ldquo;Purdue&rdquo;,
        &ldquo;Boilermaker&rdquo; and related marks are trademarks of Purdue University.{' '}
        <Link to="/terms" className="text-[var(--color-txt-2)] hover:underline">
          Terms
        </Link>
        {' · '}
        <Link to="/privacy" className="text-[var(--color-txt-2)] hover:underline">
          Privacy
        </Link>
        {' · '}
        <Link to="/support" className="text-[var(--color-txt-2)] hover:underline">
          Support
        </Link>
      </p>
    </div>
  )
}
